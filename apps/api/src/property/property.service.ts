import { Injectable } from '@nestjs/common';
import {
  addDays, ERROR_CODES, roomDisplayState, isSellable, type HousekeepingStatus, type OccupancyStatus, type PropertySettingsInput, type PropertyPoliciesInput,
  type RoomInput, type RoomTypeInput, type ServiceStatus,
} from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { IdRow, PropertyRow, RoomRow, RoomTypeRow } from '../db/rows';

const mapRoomType = (r: RoomTypeRow) => ({
  id: r.id, code: r.code, name: r.name, description: r.description, baseOccupancy: r.base_occupancy,
  maxOccupancy: r.max_occupancy, baseRate: r.base_rate, minRate: r.min_rate, extraAdultRate: r.extra_adult_rate,
  extraChildRate: r.extra_child_rate, isActive: r.is_active, version: r.version,
});

@Injectable()
export class PropertyService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly outbox: OutboxService) {}

  async businessDate(q: Queryable, propertyId: string): Promise<string> {
    const { rows } = await q.query<{ current_business_date: string }>(`SELECT current_business_date FROM properties WHERE id = $1`, [propertyId]);
    if (!rows[0]) throw notFound('Property');
    return rows[0].current_business_date;
  }

  async getProperty(propertyId: string) {
    const { rows } = await this.db.query<PropertyRow>(`SELECT * FROM properties WHERE id = $1`, [propertyId]);
    const p = rows[0];
    if (!p) throw notFound('Property');
    return {
      id: p.id, name: p.name, legalName: p.legal_name, addressLine1: p.address_line1, addressLine2: p.address_line2,
      city: p.city, stateCode: p.state_code, pinCode: p.pin_code, gstin: p.gstin, phone: p.phone, email: p.email,
      checkInTime: String(p.check_in_time).slice(0, 5), checkOutTime: String(p.check_out_time).slice(0, 5),
      timezone: p.timezone, businessDate: p.current_business_date, isPractice: p.is_practice, version: p.version,
      policies: {
        receptionistCanRunNightAudit: p.receptionist_can_run_night_audit, cashDifferenceThreshold: p.cash_difference_threshold,
        reviewDiscountPercent: p.review_discount_percent, invoiceTerms: p.invoice_terms, invoiceBankDetails: p.invoice_bank_details,
        printMaskMobile: p.print_mask_mobile, receiptPaper: p.receipt_paper, emailEnabled: p.email_enabled,
        emailFromName: p.email_from_name, emailFromAddress: p.email_from_address, emailReplyTo: p.email_reply_to,
        quietHoursStart: String(p.quiet_hours_start).slice(0, 5), quietHoursEnd: String(p.quiet_hours_end).slice(0, 5),
        checkoutReminderTime: String(p.checkout_reminder_time).slice(0, 5), reminderSkipSameDay: p.reminder_skip_same_day,
        receptionPhone: p.reception_phone, wifiDetails: p.wifi_details, locationLink: p.location_link, deskLockMinutes: p.desk_lock_minutes,
      },
    };
  }

  /**
   * Owner policies (night audit permission, review thresholds, printing, guest email, desk lock).
   * Separate from the property's identity so a change to one never needs the other's form.
   */
  async updatePolicies(actor: Actor, input: PropertyPoliciesInput) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const before = (await this.getProperty(actor.user.propertyId)).policies;
      const { rowCount } = await q.query(
        `UPDATE properties SET receptionist_can_run_night_audit=$3, cash_difference_threshold=$4, review_discount_percent=$5,
                invoice_terms=$6, invoice_bank_details=$7, print_mask_mobile=$8, receipt_paper=$9, email_enabled=$10,
                email_from_name=$11, email_from_address=$12, email_reply_to=$13, quiet_hours_start=$14, quiet_hours_end=$15,
                checkout_reminder_time=$16, reminder_skip_same_day=$17, reception_phone=$18, wifi_details=$19, location_link=$20,
                desk_lock_minutes=$21
          WHERE id = $1 AND version = $2`,
        [actor.user.propertyId, input.version, input.receptionistCanRunNightAudit, input.cashDifferenceThreshold, input.reviewDiscountPercent,
          input.invoiceTerms ?? null, input.invoiceBankDetails ?? null, input.printMaskMobile, input.receiptPaper, input.emailEnabled,
          input.emailFromName ?? null, input.emailFromAddress ?? null, input.emailReplyTo ?? null, input.quietHoursStart, input.quietHoursEnd,
          input.checkoutReminderTime, input.reminderSkipSameDay, input.receptionPhone ?? null, input.wifiDetails ?? null,
          input.locationLink ?? null, input.deskLockMinutes],
      );
      if (!rowCount) throw staleVersion();
      const { version: _v, ...after } = input;
      await this.audit.record(q, actor, { action: 'property.policies_updated', entityType: 'property', entityId: actor.user.propertyId, before, after });
    });
    // Read after commit: getProperty uses its own connection.
    return this.getProperty(actor.user.propertyId);
  }

  async updateProperty(actor: Actor, input: PropertySettingsInput, expectedVersion: number) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const before = await this.getProperty(actor.user.propertyId);
      const { rowCount } = await q.query(
        `UPDATE properties SET name=$3, legal_name=$4, address_line1=$5, address_line2=$6, city=$7, state_code=$8, pin_code=$9,
                gstin=$10, phone=$11, email=$12, check_in_time=$13, check_out_time=$14
          WHERE id = $1 AND version = $2`,
        [actor.user.propertyId, expectedVersion, input.name, input.legalName, input.addressLine1, input.addressLine2 ?? null,
          input.city, input.stateCode, input.pinCode, input.gstin ?? null, input.phone, input.email ?? null, input.checkInTime, input.checkOutTime],
      );
      if (!rowCount) throw staleVersion();
      await this.audit.record(q, actor, { action: 'property.updated', entityType: 'property', entityId: actor.user.propertyId, before, after: input });
      return { ok: true };
    });
  }

  // ---------------- room types ----------------

  async listRoomTypes(propertyId: string, includeInactive = false) {
    const { rows } = await this.db.query<RoomTypeRow>(
      `SELECT * FROM room_types WHERE property_id = $1 AND ($2 OR is_active) ORDER BY sort_order, name`,
      [propertyId, includeInactive],
    );
    return rows.map(mapRoomType);
  }

  async createRoomType(actor: Actor, input: RoomTypeInput) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<RoomTypeRow>(
        `INSERT INTO room_types (property_id, code, name, description, base_occupancy, max_occupancy, base_rate, min_rate,
                                 extra_adult_rate, extra_child_rate, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [actor.user.propertyId, input.code, input.name, input.description ?? null, input.baseOccupancy, input.maxOccupancy,
          input.baseRate, input.minRate, input.extraAdultRate, input.extraChildRate, actor.user.id],
      );
      const created = mapRoomType(rows[0]!);
      await this.audit.record(q, actor, { action: 'room_type.created', entityType: 'room_type', entityId: created.id, after: created });
      return created;
    });
  }

  async updateRoomType(actor: Actor, id: string, input: RoomTypeInput & { isActive?: boolean }, expectedVersion: number) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows: beforeRows } = await q.query<RoomTypeRow>(`SELECT * FROM room_types WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId]);
      if (!beforeRows[0]) throw notFound('Room type');
      const { rows } = await q.query<RoomTypeRow>(
        `UPDATE room_types SET code=$4, name=$5, description=$6, base_occupancy=$7, max_occupancy=$8, base_rate=$9, min_rate=$10,
                extra_adult_rate=$11, extra_child_rate=$12, is_active=COALESCE($13, is_active), updated_by=$14
          WHERE id = $1 AND property_id = $2 AND version = $3 RETURNING *`,
        [id, actor.user.propertyId, expectedVersion, input.code, input.name, input.description ?? null, input.baseOccupancy,
          input.maxOccupancy, input.baseRate, input.minRate, input.extraAdultRate, input.extraChildRate, input.isActive ?? null, actor.user.id],
      );
      if (!rows[0]) throw staleVersion();
      const after = mapRoomType(rows[0]);
      await this.audit.record(q, actor, { action: 'room_type.updated', entityType: 'room_type', entityId: id, before: mapRoomType(beforeRows[0]), after });
      return after;
    });
  }

  // ---------------- rooms ----------------

  /**
   * Room board for a date (default: business date). Occupancy is derived from allocations,
   * never stored, so it cannot drift from bookings (spec §10).
   */
  async listRooms(propertyId: string, date?: string) {
    const day = date ?? (await this.businessDate(this.db, propertyId));
    const { rows } = await this.db.query<RoomRow & {
      room_type_name: string; room_type_code: string; alloc_status: 'reserved' | 'checked_in' | null; start_date: string | null; end_date: string | null;
      reservation_id: string | null; reservation_number: string | null; guest_name: string | null; is_vip: boolean | null; out_of_order_today: boolean;
    }>(
      `SELECT r.*, rt.name AS room_type_name, rt.code AS room_type_code,
              occ.status AS alloc_status, occ.start_date, occ.end_date, occ.reservation_id, occ.reservation_number,
              occ.guest_name, occ.is_vip,
              EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id = r.id AND o.status = 'active'
                        AND o.start_date <= $2::date AND o.end_date > $2::date) AS out_of_order_today
         FROM rooms r
         JOIN room_types rt ON rt.id = r.room_type_id
         LEFT JOIN LATERAL (
           SELECT a.status, a.start_date, a.end_date, res.id AS reservation_id, res.number AS reservation_number,
                  trim(g.first_name || ' ' || g.last_name) AS guest_name, g.is_vip
             FROM room_allocations a
             JOIN reservation_rooms rr ON rr.id = a.reservation_room_id
             JOIN reservations res ON res.id = rr.reservation_id
             JOIN guests g ON g.id = res.primary_guest_id
            WHERE a.room_id = r.id
              AND ( (a.status = 'checked_in' AND a.start_date <= $2::date)
                 OR (a.status = 'reserved' AND a.start_date <= $2::date AND a.end_date > $2::date) )
            ORDER BY (a.status = 'checked_in') DESC, a.start_date
            LIMIT 1
         ) occ ON true
        WHERE r.property_id = $1 AND r.is_active
        ORDER BY rt.sort_order, rt.name, r.sort_order, r.number`,
      [propertyId, day],
    );
    return rows.map((r) => {
      let occupancy: OccupancyStatus = 'vacant';
      if (r.alloc_status === 'checked_in') occupancy = r.end_date! <= day ? 'due_out' : 'occupied';
      else if (r.alloc_status === 'reserved' && r.start_date === day) occupancy = 'arriving';
      const service: ServiceStatus = r.out_of_order_today && r.service_status === 'in_service' ? 'out_of_order' : r.service_status;
      const hk = r.housekeeping_status as HousekeepingStatus;
      return {
        id: r.id, number: r.number, roomTypeId: r.room_type_id, roomTypeName: r.room_type_name, roomTypeCode: r.room_type_code,
        unitType: r.unit_type, view: r.view, building: r.building, floor: r.floor, notes: r.notes,
        housekeeping: hk, service, occupancy,
        displayState: roomDisplayState(occupancy, hk, service),
        sellable: isSellable(occupancy, hk, service),
        currentReservation: r.reservation_id ? {
          id: r.reservation_id, number: r.reservation_number!, guestName: r.guest_name!, isVip: !!r.is_vip,
          arrival: r.start_date!, departure: r.end_date!,
        } : null,
        version: r.version,
      };
    });
  }

  /** Every room, including those switched off, for the owner's settings screen. */
  async listRoomsForSetup(propertyId: string) {
    const { rows } = await this.db.query<{ id: string; number: string; room_type_id: string; unit_type: string; view: string | null; building: string | null; floor: string | null; notes: string | null; is_active: boolean; version: number }>(
      `SELECT id, number, room_type_id, unit_type, view, building, floor, notes, is_active, version
         FROM rooms WHERE property_id = $1 ORDER BY is_active DESC, sort_order, number`,
      [propertyId],
    );
    return rows.map((r) => ({
      id: r.id, number: r.number, roomTypeId: r.room_type_id, unitType: r.unit_type, view: r.view, building: r.building,
      floor: r.floor, notes: r.notes, isActive: r.is_active, version: r.version,
    }));
  }

  async createRoom(actor: Actor, input: RoomInput) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<{ id: string; number: string }>(
        `INSERT INTO rooms (property_id, room_type_id, number, unit_type, view, building, floor, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, number`,
        [actor.user.propertyId, input.roomTypeId, input.number, input.unitType, input.view ?? null, input.building ?? null,
          input.floor ?? null, input.notes ?? null, actor.user.id],
      );
      await this.audit.record(q, actor, { action: 'room.created', entityType: 'room', entityId: rows[0]!.id, after: input });
      await this.outbox.emit(q, actor.user.propertyId, 'inventory.changed', { type: 'room', id: rows[0]!.id });
      return rows[0];
    });
  }

  async updateRoom(actor: Actor, id: string, input: RoomInput & { isActive?: boolean }, expectedVersion: number) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows: before } = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId]);
      if (!before[0]) throw notFound('Room');
      if (input.isActive === false) {
        const { rows: future } = await q.query<{ one: number }>(
          `SELECT 1 AS one FROM room_allocations WHERE room_id = $1 AND status IN ('reserved','checked_in') LIMIT 1`, [id],
        );
        if (future[0]) {
          throw new AppError(ERROR_CODES.CONFLICT, 'This room has current or future bookings. Move them before deactivating the room.');
        }
      }
      const { rows } = await q.query<IdRow>(
        `UPDATE rooms SET room_type_id=$4, number=$5, unit_type=$6, view=$7, building=$8, floor=$9, notes=$10,
                is_active = COALESCE($11, is_active), updated_by=$12
          WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING id`,
        [id, actor.user.propertyId, expectedVersion, input.roomTypeId, input.number, input.unitType, input.view ?? null,
          input.building ?? null, input.floor ?? null, input.notes ?? null, input.isActive ?? null, actor.user.id],
      );
      if (!rows[0]) throw staleVersion();
      await this.audit.record(q, actor, { action: 'room.updated', entityType: 'room', entityId: id, before: before[0], after: input });
      return { ok: true };
    });
  }

  /** Housekeeping / service status change. History is written by a DB trigger. */
  async changeRoomStatus(actor: Actor, id: string, change: { housekeeping?: HousekeepingStatus; service?: ServiceStatus; reason?: string }) {
    return this.db.tx({ userId: actor.user.id, reason: change.reason }, async (q) => {
      const { rows } = await q.query<Pick<RoomRow, 'housekeeping_status' | 'service_status'>>(
        `SELECT housekeeping_status, service_status FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [id, actor.user.propertyId],
      );
      const before = rows[0];
      if (!before) throw notFound('Room');
      await q.query(
        `UPDATE rooms SET housekeeping_status = COALESCE($2, housekeeping_status), service_status = COALESCE($3, service_status), updated_by = $4
          WHERE id = $1`,
        [id, change.housekeeping ?? null, change.service ?? null, actor.user.id],
      );
      await this.audit.record(q, actor, {
        action: 'room.status_changed', entityType: 'room', entityId: id, reason: change.reason,
        before: { housekeeping: before.housekeeping_status, service: before.service_status },
        after: { housekeeping: change.housekeeping ?? before.housekeeping_status, service: change.service ?? before.service_status },
      });
      await this.outbox.emit(q, actor.user.propertyId, 'room.status_changed', { type: 'room', id });
      return { ok: true };
    });
  }

  async roomStatusHistory(propertyId: string, roomId: string) {
    const { rows } = await this.db.query<{ dimension: string; from_status: string; to_status: string; reason: string | null; changed_at: Date; changed_by: string | null }>(
      `SELECT h.dimension, h.from_status, h.to_status, h.reason, h.changed_at, u.full_name AS changed_by
         FROM room_status_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.property_id = $1 AND h.room_id = $2 ORDER BY h.changed_at DESC LIMIT 100`,
      [propertyId, roomId],
    );
    return rows.map((r) => ({ dimension: r.dimension, from: r.from_status, to: r.to_status, reason: r.reason, changedAt: r.changed_at, changedBy: r.changed_by }));
  }

  async markOutOfOrder(actor: Actor, roomId: string, input: { startDate: string; endDate: string; reason: string }) {
    return this.db.tx({ userId: actor.user.id, reason: input.reason }, async (q) => {
      const { rows: clash } = await q.query<{ one: number }>(
        `SELECT 1 AS one FROM room_allocations WHERE room_id = $1 AND status IN ('reserved','checked_in')
            AND daterange(start_date, end_date, '[)') && daterange($2::date, $3::date, '[)') LIMIT 1`,
        [roomId, input.startDate, input.endDate],
      );
      if (clash[0]) {
        throw new AppError(ERROR_CODES.CONFLICT, 'This room has bookings in these dates. Move them to another room first.');
      }
      const { rows } = await q.query<IdRow>(
        `INSERT INTO room_out_of_order (property_id, room_id, start_date, end_date, reason, created_by)
         SELECT $1, id, $3, $4, $5, $6 FROM rooms WHERE id = $2 AND property_id = $1 RETURNING id`,
        [actor.user.propertyId, roomId, input.startDate, input.endDate, input.reason, actor.user.id],
      );
      if (!rows[0]) throw notFound('Room');
      await this.audit.record(q, actor, { action: 'room.out_of_order', entityType: 'room', entityId: roomId, after: input, reason: input.reason });
      await this.outbox.emit(q, actor.user.propertyId, 'inventory.changed', { type: 'room', id: roomId }, { from: input.startDate, to: input.endDate });
      return { id: rows[0].id };
    });
  }

  /** Helper for callers that need next N dates. */
  static dateWindow(start: string, days: number): string[] {
    return Array.from({ length: days }, (_, i) => addDays(start, i));
  }
}
