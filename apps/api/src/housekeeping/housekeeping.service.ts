import { Injectable } from '@nestjs/common';
import { ERROR_CODES, type HousekeepingTaskUpdate } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, gather, type Queryable } from '../db/db.service';

interface BoardRow {
  room_id: string; number: string; room_type_name: string; building: string | null; floor: string | null;
  housekeeping_status: 'dirty' | 'cleaning' | 'clean' | 'inspected'; service_status: string;
  occupied: boolean; departs_today: boolean; arrives_today: boolean;
  task_id: string | null; task_kind: string | null; task_status: string | null; task_priority: string | null;
  task_note: string | null; task_version: number | null; task_started_at: Date | null; task_created_at: Date | null;
  assigned_to: string | null; assigned_name: string | null;
}

interface TaskRow {
  id: string; room_id: string; room_number: string; kind: string; status: string; priority: string; note: string | null;
  assigned_to: string | null; business_date: string; version: number; started_at: Date | null;
  housekeeping_status: string;
}

const mapBoard = (r: BoardRow) => ({
  roomId: r.room_id, number: r.number, roomTypeName: r.room_type_name, building: r.building, floor: r.floor,
  housekeeping: r.housekeeping_status, service: r.service_status,
  occupied: r.occupied, departsToday: r.departs_today, arrivesToday: r.arrives_today,
  task: r.task_id ? {
    id: r.task_id, kind: r.task_kind!, status: r.task_status!, priority: r.task_priority!, note: r.task_note,
    version: r.task_version!, startedAt: r.task_started_at, createdAt: r.task_created_at,
    assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name! } : null,
  } : null,
});

/**
 * Housekeeping (spec §37, cleaner mode §4.3).
 *
 * The room's housekeeping status is the truth the board shows; a task is the work behind it. The
 * database keeps the two in step (trigger `rooms_housekeeping_task`, migration 0021), so every action
 * here is a room status change — the same one the room board makes — and the task follows. That is
 * what lets a receptionist and a cleaner act on the same room without either record going stale.
 */
@Injectable()
export class HousekeepingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Every active room with its open task, for owner and reception. */
  async board(propertyId: string) {
    return this.db.tx({}, async (q) => {
      const [rooms, staff, done, settings] = await gather(q, [
        () => q.query<BoardRow>(
          `SELECT rm.id AS room_id, rm.number, rt.name AS room_type_name, rm.building, rm.floor,
                  rm.housekeeping_status, rm.service_status,
                  EXISTS (SELECT 1 FROM stays s WHERE s.room_id = rm.id AND s.status = 'in_house') AS occupied,
                  EXISTS (SELECT 1 FROM stays s WHERE s.room_id = rm.id AND s.status = 'in_house' AND s.expected_departure <= p.current_business_date) AS departs_today,
                  EXISTS (SELECT 1 FROM reservation_rooms rr WHERE rr.room_id = rm.id AND rr.status = 'reserved' AND rr.arrival = p.current_business_date) AS arrives_today,
                  t.id AS task_id, t.kind AS task_kind, t.status AS task_status, t.priority AS task_priority, t.note AS task_note,
                  t.version AS task_version, t.started_at AS task_started_at, t.created_at AS task_created_at,
                  t.assigned_to, u.full_name AS assigned_name
             FROM rooms rm
             JOIN properties p ON p.id = rm.property_id
             JOIN room_types rt ON rt.id = rm.room_type_id
             LEFT JOIN housekeeping_tasks t ON t.room_id = rm.id AND t.status IN ('open', 'in_progress')
             LEFT JOIN users u ON u.id = t.assigned_to
            WHERE rm.property_id = $1 AND rm.is_active
            ORDER BY rm.sort_order, rm.number`,
          [propertyId],
        ),
        () => q.query<{ id: string; full_name: string; role: string }>(
          `SELECT id, full_name, role FROM users WHERE property_id = $1 AND is_active AND role IN ('cleaner', 'receptionist', 'owner') ORDER BY role = 'cleaner' DESC, full_name`,
          [propertyId],
        ),
        () => q.query<{ n: string }>(
          `SELECT count(*) AS n FROM housekeeping_tasks t JOIN properties p ON p.id = t.property_id
            WHERE t.property_id = $1 AND t.status = 'done' AND t.completed_at >= (p.current_business_date::timestamp AT TIME ZONE p.timezone)`,
          [propertyId],
        ),
        () => q.query<{ housekeeping_stayovers: boolean; housekeeping_inspection: boolean; current_business_date: string }>(
          `SELECT housekeeping_stayovers, housekeeping_inspection, current_business_date FROM properties WHERE id = $1`, [propertyId],
        ),
      ]);
      return {
        businessDate: settings.rows[0]!.current_business_date,
        inspection: settings.rows[0]!.housekeeping_inspection,
        stayovers: settings.rows[0]!.housekeeping_stayovers,
        rooms: rooms.rows.map(mapBoard),
        staff: staff.rows.map((s) => ({ id: s.id, name: s.full_name, role: s.role })),
        doneToday: Number(done.rows[0]!.n),
      };
    });
  }

  /**
   * A cleaner's list (§4.3): only the rooms assigned to them, room number and what to do — no guest
   * names, no money, nothing else about the stay.
   */
  async myTasks(actor: Actor) {
    const { rows } = await this.db.query<{ id: string; room_id: string; number: string; room_type_name: string; kind: string; status: string; priority: string; note: string | null; version: number; started_at: Date | null; arrives_today: boolean }>(
      `SELECT t.id, t.room_id, rm.number, rt.name AS room_type_name, t.kind, t.status, t.priority, t.note, t.version, t.started_at,
              EXISTS (SELECT 1 FROM reservation_rooms rr JOIN properties p ON p.id = rr.property_id
                       WHERE rr.room_id = rm.id AND rr.status = 'reserved' AND rr.arrival = p.current_business_date) AS arrives_today
         FROM housekeeping_tasks t
         JOIN rooms rm ON rm.id = t.room_id
         JOIN room_types rt ON rt.id = rm.room_type_id
        WHERE t.property_id = $1 AND t.assigned_to = $2 AND t.status IN ('open', 'in_progress')
        ORDER BY t.priority = 'high' DESC, arrives_today DESC, rm.sort_order, rm.number`,
      [actor.user.propertyId, actor.user.id],
    );
    return rows.map((r) => ({
      id: r.id, roomId: r.room_id, roomNumber: r.number, roomTypeName: r.room_type_name, kind: r.kind, status: r.status,
      priority: r.priority, note: r.note, version: r.version, startedAt: r.started_at, arrivesToday: r.arrives_today,
    }));
  }

  private async lockTask(q: Queryable, propertyId: string, taskId: string) {
    const { rows } = await q.query<TaskRow>(
      `SELECT t.id, t.room_id, rm.number AS room_number, t.kind, t.status, t.priority, t.note, t.assigned_to, t.business_date,
              t.version, t.started_at, rm.housekeeping_status
         FROM housekeeping_tasks t JOIN rooms rm ON rm.id = t.room_id
        WHERE t.id = $1 AND t.property_id = $2
        FOR NO KEY UPDATE OF rm, t`,
      [taskId, propertyId],
    );
    if (!rows[0]) throw notFound('Cleaning task');
    return rows[0];
  }

  /** A cleaner may act only on work given to them; owner and reception on any room. */
  private assertMayWork(actor: Actor, task: TaskRow) {
    if (actor.user.role === 'cleaner' && task.assigned_to !== actor.user.id) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'This room is not assigned to you. Ask the desk.');
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, `Room ${task.room_number} is already done.`);
    }
  }

  /** The one place a housekeeping action moves the room; the trigger moves the task with it. */
  private async moveRoom(q: Queryable, actor: Actor, task: TaskRow, to: 'dirty' | 'cleaning' | 'clean' | 'inspected', action: string, reason: string) {
    await q.query(`SELECT set_config('resortos.reason', $1, true)`, [reason]);
    await q.query(`UPDATE rooms SET housekeeping_status = $2, updated_by = $3 WHERE id = $1`, [task.room_id, to, actor.user.id]);
    await this.audit.record(q, actor, {
      action, entityType: 'housekeeping_task', entityId: task.id,
      before: { room: task.room_number, housekeeping: task.housekeeping_status, task: task.status },
      after: { room: task.room_number, housekeeping: to },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'room.status_changed', { type: 'room', id: task.room_id }, { housekeeping: to });
  }

  async start(q: Queryable, actor: Actor, taskId: string) {
    const task = await this.lockTask(q, actor.user.propertyId, taskId);
    this.assertMayWork(actor, task);
    if (task.status === 'in_progress') return { ok: true };
    await this.moveRoom(q, actor, task, 'cleaning', 'housekeeping.started', 'Cleaning started');
    return { ok: true };
  }

  /**
   * "Room cleaned ✓". The room becomes Clean; with inspection switched on it waits there until the
   * desk inspects it, and only an owner or receptionist can mark it Inspected (§4.3).
   */
  async complete(q: Queryable, actor: Actor, taskId: string) {
    const task = await this.lockTask(q, actor.user.propertyId, taskId);
    this.assertMayWork(actor, task);
    await this.moveRoom(q, actor, task, 'clean', 'housekeeping.completed', 'Room cleaned');
    return { ok: true };
  }

  /** Stops half way: the room is dirty again and the same task waits for someone. */
  async stop(q: Queryable, actor: Actor, taskId: string) {
    const task = await this.lockTask(q, actor.user.propertyId, taskId);
    this.assertMayWork(actor, task);
    if (task.status !== 'in_progress') return { ok: true };
    await this.moveRoom(q, actor, task, 'dirty', 'housekeeping.stopped', 'Cleaning stopped before it was finished');
    return { ok: true };
  }

  async update(q: Queryable, actor: Actor, taskId: string, input: HousekeepingTaskUpdate) {
    const task = await this.lockTask(q, actor.user.propertyId, taskId);
    if (task.status === 'done' || task.status === 'cancelled') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This task is finished.');
    if (input.assignedTo) {
      const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND property_id = $2 AND is_active`, [input.assignedTo, actor.user.propertyId],
      );
      if (!rows[0]) throw notFound('Staff member');
    }
    const { rows } = await q.query<{ id: string; version: number }>(
      `UPDATE housekeeping_tasks
          SET assigned_to = CASE WHEN $4 THEN $5::uuid ELSE assigned_to END,
              priority = COALESCE($6, priority),
              note = CASE WHEN $7 THEN $8 ELSE note END
        WHERE id = $1 AND property_id = $2 AND version = $3 RETURNING id, version`,
      [taskId, actor.user.propertyId, input.version, input.assignedTo !== undefined, input.assignedTo ?? null,
        input.priority ?? null, input.note !== undefined, input.note ?? null],
    );
    if (!rows[0]) throw staleVersion();
    await this.audit.record(q, actor, {
      action: 'housekeeping.updated', entityType: 'housekeeping_task', entityId: taskId,
      before: { assignedTo: task.assigned_to, priority: task.priority, note: task.note },
      after: { assignedTo: input.assignedTo, priority: input.priority, note: input.note },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'housekeeping.task_updated', { type: 'housekeeping_task', id: taskId });
    return { id: taskId, version: rows[0].version };
  }

  /**
   * Only the daily clean of an occupied room can be skipped — a guest who declined service. The room
   * goes back to Clean; a checkout clean can never be skipped, because the next guest sleeps there.
   */
  async skipStayover(q: Queryable, actor: Actor, taskId: string, reason: string) {
    const task = await this.lockTask(q, actor.user.propertyId, taskId);
    if (task.kind !== 'stayover') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Only the daily clean of an occupied room can be skipped.');
    if (task.status !== 'open') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Cleaning has already started or finished.');
    await q.query(`UPDATE housekeeping_tasks SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`, [taskId, reason]);
    await this.moveRoom(q, actor, task, 'clean', 'housekeeping.skipped', `Daily clean skipped: ${reason}`);
    return { ok: true };
  }

  /** Recent finished work, newest first: who cleaned which room and how long it took. */
  async history(propertyId: string, from: string, to: string) {
    const { rows } = await this.db.query<{ id: string; number: string; kind: string; status: string; business_date: string; started_at: Date | null; completed_at: Date | null; completed_by: string | null; cancelled_reason: string | null }>(
      `SELECT t.id, rm.number, t.kind, t.status, t.business_date, t.started_at, t.completed_at, u.full_name AS completed_by, t.cancelled_reason
         FROM housekeeping_tasks t JOIN rooms rm ON rm.id = t.room_id LEFT JOIN users u ON u.id = t.completed_by
        WHERE t.property_id = $1 AND t.status IN ('done', 'cancelled') AND t.business_date BETWEEN $2::date AND $3::date
        ORDER BY COALESCE(t.completed_at, t.updated_at) DESC LIMIT 500`,
      [propertyId, from, to],
    );
    return rows.map((r) => ({
      id: r.id, roomNumber: r.number, kind: r.kind, status: r.status, businessDate: r.business_date,
      startedAt: r.started_at, completedAt: r.completed_at, completedBy: r.completed_by, skippedReason: r.cancelled_reason,
      minutes: r.started_at && r.completed_at ? Math.max(0, Math.round((r.completed_at.getTime() - r.started_at.getTime()) / 60000)) : null,
    }));
  }
}
