import { Injectable } from '@nestjs/common';
import { ERROR_CODES, money, type MaintenanceTicketInput, type MaintenanceTicketPatch, type MaintenanceScheduleInput, type MaintenanceSchedulePatch } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { OutboxService } from '../common/outbox.service';

interface TicketRow {
  id: string; property_id: string; room_id: string | null; room_number: string | null; area: string | null;
  title: string; description: string | null; priority: 'low' | 'normal' | 'high';
  status: 'open' | 'in_progress' | 'resolved' | 'closed'; assigned_to: string | null; assigned_name: string | null;
  cost: string | null; resolution_note: string | null;
  created_at: Date; created_by_name: string | null; resolved_at: Date | null; closed_at: Date | null;
  service_status: string | null; version: number;
}

interface ScheduleRow {
  id: string; name: string; area: string | null; room_id: string | null; room_number: string | null;
  every_days: number; next_due: string; last_ticket_id: string | null; is_active: boolean; version: number;
}

const mapTicket = (r: TicketRow) => ({
  id: r.id, roomId: r.room_id, roomNumber: r.room_number, area: r.area, title: r.title, description: r.description,
  priority: r.priority, status: r.status, assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name! } : null,
  cost: r.cost, resolutionNote: r.resolution_note, createdAt: r.created_at, createdBy: r.created_by_name,
  resolvedAt: r.resolved_at, closedAt: r.closed_at, roomServiceStatus: r.service_status, version: r.version,
});

/**
 * Maintenance (spec §38). A ticket walks open → in progress → resolved (with what it cost and what
 * was done) → closed, and the database refuses every other move. Marking a room Maintenance or Out
 * of order from the ticket is the room's own service status (0002) — out-of-order takes a date range
 * and leaves sellable inventory, which the ticket only points at.
 */
@Injectable()
export class MaintenanceService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly outbox: OutboxService) {}

  private async validateReferences(q: Queryable, propertyId: string, roomId?: string | null, assignedTo?: string | null) {
    if (roomId) {
      const result = await q.query<{ id: string }>('SELECT id FROM rooms WHERE id = $1 AND property_id = $2 AND is_active FOR SHARE', [roomId, propertyId]);
      if (!result.rows[0]) throw notFound('Active room');
    }
    if (assignedTo) {
      const result = await q.query<{ id: string }>('SELECT id FROM users WHERE id = $1 AND property_id = $2 AND is_active FOR SHARE', [assignedTo, propertyId]);
      if (!result.rows[0]) throw notFound('Active staff member');
    }
  }

  async listTickets(propertyId: string, status?: 'open' | 'in_progress' | 'resolved' | 'closed') {
    const { rows } = await this.db.query<TicketRow>(
      `SELECT t.*, rm.number AS room_number, u.full_name AS assigned_name, cu.full_name AS created_by_name, rm.service_status
         FROM maintenance_tickets t
         LEFT JOIN rooms rm ON rm.id = t.room_id
         LEFT JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users cu ON cu.id = t.created_by
        WHERE t.property_id = $1 AND ($2::text IS NULL OR t.status = $2)
        ORDER BY t.status = 'open' DESC, t.status = 'in_progress' DESC,
                 t.priority = 'high' DESC, t.created_at DESC`,
      [propertyId, status ?? null],
    );
    return rows.map(mapTicket);
  }

  async createTicket(q: Queryable, actor: Actor, input: MaintenanceTicketInput) {
    await this.validateReferences(q, actor.user.propertyId, input.roomId, input.assignedTo);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO maintenance_tickets (property_id, room_id, area, title, description, priority, assigned_to, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [actor.user.propertyId, input.roomId ?? null, input.area ?? null, input.title, input.description ?? null,
       input.priority ?? 'normal', input.assignedTo ?? null, actor.user.id],
    );
    await this.audit.record(q, actor, {
      action: 'maintenance.ticket_opened', entityType: 'maintenance_ticket', entityId: rows[0]!.id,
      after: { title: input.title, roomId: input.roomId ?? null, area: input.area ?? null, priority: input.priority ?? 'normal' },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'maintenance.ticket_opened', { type: 'maintenance_ticket', id: rows[0]!.id }, {});
    return { id: rows[0]!.id };
  }

  async patchTicket(q: Queryable, actor: Actor, id: string, patch: MaintenanceTicketPatch) {
    const { rows: current } = await q.query<TicketRow>(
      `SELECT t.*, rm.number AS room_number FROM maintenance_tickets t LEFT JOIN rooms rm ON rm.id = t.room_id
        WHERE t.id = $1 AND t.property_id = $2 FOR UPDATE OF t`,
      [id, actor.user.propertyId],
    );
    if (!current[0]) throw notFound('Ticket');
    const t = current[0];
    await this.validateReferences(q, actor.user.propertyId, null, patch.assignedTo);

    if (patch.status === 'resolved' && !patch.resolutionNote && !t.resolution_note) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Say what was done before the ticket can be resolved.');
    }
    if (patch.cost !== undefined && patch.cost !== null && money(patch.cost).lt(0)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'The cost cannot be negative.');
    }

    const { rows } = await q.query<{ id: string }>(
      `UPDATE maintenance_tickets SET
         assigned_to = $4, priority = $5, description = COALESCE($6, description),
         cost = COALESCE($7, cost), resolution_note = COALESCE($8, resolution_note),
         status = COALESCE($9, status),
         resolved_at = CASE WHEN $9 = 'resolved' AND resolved_at IS NULL THEN now() ELSE resolved_at END,
         resolved_by = CASE WHEN $9 = 'resolved' AND resolved_by IS NULL THEN $10 ELSE resolved_by END,
         closed_at = CASE WHEN $9 = 'closed' AND closed_at IS NULL THEN now() ELSE closed_at END,
         closed_by = CASE WHEN $9 = 'closed' AND closed_by IS NULL THEN $10 ELSE closed_by END,
         updated_by = $10, version = version + 1
       WHERE id = $1 AND property_id = $2 AND version = $3 RETURNING id`,
      [id, actor.user.propertyId, patch.version,
       patch.assignedTo !== undefined ? patch.assignedTo : t.assigned_to,
       patch.priority ?? t.priority,
       patch.description ?? null,
       patch.cost !== undefined ? patch.cost : t.cost,
       patch.resolutionNote ?? null,
       patch.status ?? null,
       actor.user.id],
    );
    if (!rows[0]) throw staleVersion();

    const after: Record<string, unknown> = { status: patch.status ?? t.status };
    if (patch.cost !== undefined) after.cost = patch.cost;
    await this.audit.record(q, actor, {
      action: patch.status === 'resolved' ? 'maintenance.ticket_resolved' : patch.status === 'closed' ? 'maintenance.ticket_closed' : 'maintenance.ticket_updated',
      entityType: 'maintenance_ticket', entityId: id, after,
    });
    await this.outbox.emit(q, actor.user.propertyId, 'maintenance.ticket_updated', { type: 'maintenance_ticket', id }, { status: patch.status ?? t.status });
    return this.readTicket(q, actor.user.propertyId, id);
  }

  /** Reads on the caller's connection: a mutation returns the row as its own transaction sees it. */
  private async readTicket(q: Queryable, propertyId: string, id: string) {
    const { rows } = await q.query<TicketRow>(
      `SELECT t.*, rm.number AS room_number, u.full_name AS assigned_name, cu.full_name AS created_by_name, rm.service_status
         FROM maintenance_tickets t
         LEFT JOIN rooms rm ON rm.id = t.room_id
         LEFT JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users cu ON cu.id = t.created_by
        WHERE t.id = $1 AND t.property_id = $2`,
      [id, propertyId],
    );
    return mapTicket(rows[0]!);
  }

  // ---------------- preventive schedules ----------------

  async listSchedules(propertyId: string) {
    const { rows } = await this.db.query<ScheduleRow>(
      `SELECT s.*, rm.number AS room_number
         FROM maintenance_schedules s
         LEFT JOIN rooms rm ON rm.id = s.room_id
        WHERE s.property_id = $1
        ORDER BY s.next_due, s.name`,
      [propertyId],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, area: r.area, roomId: r.room_id, roomNumber: r.room_number,
      everyDays: r.every_days, nextDue: r.next_due, lastTicketId: r.last_ticket_id, isActive: r.is_active, version: r.version,
    }));
  }

  async createSchedule(q: Queryable, actor: Actor, input: MaintenanceScheduleInput, businessDate: string) {
    if (input.roomId && input.area) throw new AppError(ERROR_CODES.VALIDATION, 'Choose a room or an area.');
    await this.validateReferences(q, actor.user.propertyId, input.roomId);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO maintenance_schedules (property_id, name, area, room_id, every_days, next_due, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7) RETURNING id`,
      [actor.user.propertyId, input.name, input.area ?? null, input.roomId ?? null, input.everyDays, input.nextDue ?? businessDate, actor.user.id],
    );
    await this.audit.record(q, actor, {
      action: 'maintenance.schedule_created', entityType: 'maintenance_schedule', entityId: rows[0]!.id,
      after: { name: input.name, everyDays: input.everyDays, nextDue: input.nextDue ?? businessDate },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'maintenance.schedule_created', { type: 'maintenance_schedule', id: rows[0]!.id }, {});
    return { id: rows[0]!.id };
  }

  async patchSchedule(q: Queryable, actor: Actor, id: string, patch: MaintenanceSchedulePatch, businessDate: string) {
    const { rows: current } = await q.query<ScheduleRow>(
      `SELECT * FROM maintenance_schedules WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId],
    );
    if (!current[0]) throw notFound('Schedule');
    const roomId = patch.roomId !== undefined ? patch.roomId : patch.area != null ? null : current[0].room_id;
    const area = patch.area !== undefined ? patch.area : patch.roomId != null ? null : current[0].area;
    if (roomId && area) throw new AppError(ERROR_CODES.VALIDATION, 'Choose a room or an area.');
    await this.validateReferences(q, actor.user.propertyId, roomId);
    const { rows } = await q.query<{ id: string }>(
      `UPDATE maintenance_schedules SET
         name = $4, area = $5, every_days = $6, next_due = COALESCE($7::date, next_due), is_active = $8, updated_by = $9, room_id = $10, version = version + 1
       WHERE id = $1 AND property_id = $2 AND version = $3 RETURNING id`,
      [id, actor.user.propertyId, patch.version,
       patch.name ?? current[0].name, area,
       patch.everyDays ?? current[0].every_days, patch.nextDue ?? null, patch.isActive ?? current[0].is_active, actor.user.id, roomId],
    );
    if (!rows[0]) throw staleVersion();
    await this.audit.record(q, actor, {
      action: 'maintenance.schedule_updated', entityType: 'maintenance_schedule', entityId: id,
      after: { nextDue: patch.nextDue ?? current[0].next_due, isActive: patch.isActive ?? current[0].is_active },
    });
    void businessDate;
    await this.outbox.emit(q, actor.user.propertyId, 'maintenance.schedule_updated', { type: 'maintenance_schedule', id }, {});
    return { id };
  }

  /**
   * The night-audit step's work: one ticket per schedule that has come due, and the schedule moved
   * forward so replaying the audit cannot open it twice (idempotency comes from the audit itself
   * running once per date — this runs inside that same transaction).
   */
  async openDueSchedules(q: Queryable, actor: Actor | null, propertyId: string, businessDate: string): Promise<{ opened: number; skipped: number }> {
    const { rows: due } = await q.query<ScheduleRow & { room_number: string | null }>(
      `SELECT s.*, rm.number AS room_number FROM maintenance_schedules s
         LEFT JOIN rooms rm ON rm.id = s.room_id
        WHERE s.property_id = $1 AND s.is_active AND s.next_due <= $2::date
        ORDER BY s.next_due
        FOR UPDATE OF s SKIP LOCKED`,
      [propertyId, businessDate],
    );
    let opened = 0;
    for (const s of due) {
      // A schedule is about a room or a system; a nameless-area schedule ("AC service") records the
      // schedule's own name as the area, so the ticket always has a target.
      const { rows: ticket } = await q.query<{ id: string }>(
        `INSERT INTO maintenance_tickets (property_id, room_id, area, title, priority, created_by, updated_by)
         VALUES ($1,$2,$3,$4,'normal',$5,$5) RETURNING id`,
        [propertyId, s.room_id, s.room_id ? null : s.area ?? s.name, `${s.name} is due for service`, actor?.user.id ?? null],
      );
      await q.query(
        `UPDATE maintenance_schedules SET next_due = $3::date + every_days, last_ticket_id = $4, updated_at = now(), updated_by = $5
          WHERE id = $1 AND property_id = $2`,
        [s.id, propertyId, businessDate, ticket[0]!.id, actor?.user.id ?? null],
      );
      opened += 1;
    }
    return { opened, skipped: due.length - opened };
  }

  /** What the ticket page and the audit summary show. */
  async openCount(propertyId: string) {
    const { rows } = await this.db.query<{ open: string; in_progress: string }>(
      `SELECT count(*) FILTER (WHERE status = 'open') AS open, count(*) FILTER (WHERE status = 'in_progress') AS in_progress
         FROM maintenance_tickets WHERE property_id = $1`, [propertyId],
    );
    return { open: Number(rows[0]!.open), inProgress: Number(rows[0]!.in_progress) };
  }
}
