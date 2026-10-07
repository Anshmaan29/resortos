import { Injectable } from '@nestjs/common';
import { formatDate, formatINR, money, toMoneyString } from '@resortos/shared';
import { AppError } from '../common/errors';
import { ERROR_CODES } from '@resortos/shared';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport, type StepResult } from '../night-audit/night-audit-pipeline';
import { FolioService } from './folio.service';
import type { Queryable } from '../db/db.service';
import type { Actor } from '../common/request-context';
import { AuditService } from '../common/audit.service';
import { OutboxService } from '../common/outbox.service';

interface PostableRow {
  stay_id: string;
  room_id: string;
  room_number: string;
  guest_name: string;
  room_rate: string;
  extra_person_amount: string;
  meal_amount: string;
  room_type_name: string;
  meal_plan: string;
}

/** The three parts of a room night, and the tax category each falls into (docs/folio.md). */
const PARTS = [
  { column: 'room_rate', lineType: 'room_night', taxCategory: 'accommodation' },
  { column: 'extra_person_amount', lineType: 'extra_person', taxCategory: 'accommodation' },
  { column: 'meal_amount', lineType: 'meal', taxCategory: 'food' },
] as const;

/**
 * Night audit step 4 (spec §35.1): post tonight's room charges for every occupied room.
 *
 * Registered through `NIGHT_AUDIT_STEPS`, which is why 2.1 needed no change to accept it.
 *
 * **Idempotent by constraint, not by checking.** The insert is `ON CONFLICT DO NOTHING` against
 * `folio_lines_one_posting_per_room_night`, so re-running posts nothing and two audits racing
 * cannot both post. Reading first and then inserting would be a race; a unique index is not one.
 *
 * Rates come from `reservation_room_nights`, the per-night rates agreed when the booking was made —
 * including one an owner authorised below the floor. Re-deriving them here would quietly overwrite
 * that agreement with today's rate calendar.
 */
@Injectable()
export class RoomNightPostingStep implements NightAuditStep {
  readonly name = 'room_charges';
  readonly title = 'Room charges';
  readonly order = 40;
  readonly blocking = false;

  constructor(private readonly folios: FolioService, private readonly audit: AuditService, private readonly outbox: OutboxService) {}

  /** Complete elapsed agreed nights before settlement. Same-day use has a minimum of one night;
   * future reserved nights are released by checkout, not silently billed. Existing posted or
   * explicitly voided nights are retained, so retries do not resurrect an owner's correction. */
  async prepareCheckout(q: Queryable, actor: Actor, stayId: string, businessDate: string) {
    const folio = await this.folios.ensureForStay(q, actor, stayId);
    const { rows } = await q.query<PostableRow & { night_date: string }>(
      `SELECT s.id AS stay_id, rm.id AS room_id, rm.number AS room_number, '' AS guest_name,
              n.night_date, n.room_rate, n.extra_person_amount, n.meal_amount, rt.name AS room_type_name, rr.meal_plan
         FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id
         JOIN reservation_room_nights n ON n.reservation_room_id = rr.id
         JOIN rooms rm ON rm.id = COALESCE((SELECT sh.from_room_id FROM room_shifts sh WHERE sh.stay_id=s.id AND sh.business_date>n.night_date ORDER BY sh.business_date,sh.created_at LIMIT 1),s.room_id) JOIN room_types rt ON rt.id = rm.room_type_id
        WHERE s.id = $1 AND s.property_id = $2 AND s.status = 'in_house'
          AND n.night_date >= s.business_date_in
          AND (n.night_date < $3::date OR (s.business_date_in = $3::date AND n.night_date = $3::date))
        ORDER BY n.night_date FOR NO KEY UPDATE OF s`,
      [stayId, actor.user.propertyId, businessDate],
    );
    let posted = 0;
    for (const row of rows) {
      for (const part of PARTS) {
        const amount = row[part.column];
        if (!money(amount).gt(0)) continue;
        const { rows: closedMissing } = await q.query<{ one: number }>(
          `SELECT 1 AS one FROM night_audits WHERE property_id=$1 AND business_date=$2::date
            AND NOT EXISTS (SELECT 1 FROM folio_lines WHERE folio_id=$3 AND business_date=$2::date AND line_type=$4 AND source='night_audit')`,
          [actor.user.propertyId,row.night_date,folio.id,part.lineType],
        );
        if (closedMissing.length) throw new AppError(ERROR_CODES.CONFLICT, 'An agreed room charge is missing from a closed business date. Ask the owner to reconcile the day’s records before checkout.');
        const inserted = await q.query<{ id: string }>(
          `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount,
                                    tax_category, source, room_id, created_by)
           SELECT $1,$2,$3::date,$4,$5,1,$6,$6,$7,'night_audit',$8,$9
            WHERE NOT EXISTS (SELECT 1 FROM folio_lines WHERE folio_id = $2 AND business_date = $3::date AND line_type = $4 AND source = 'night_audit')
           ON CONFLICT DO NOTHING RETURNING id`,
          [actor.user.propertyId, folio.id, row.night_date, part.lineType,
           part.lineType === 'room_night' ? `Room — ${row.room_type_name}` : part.lineType === 'meal' ? `Meal plan (${row.meal_plan})` : 'Extra person',
           amount, part.taxCategory, row.room_id, actor.user.id],
        );
        posted += inserted.rowCount ?? 0;
      }
    }
    if (posted) {
      await this.audit.record(q, actor, { action: 'bill.room_charges_completed', entityType: 'folio', entityId: folio.id, after: { posted, throughBusinessDate: businessDate } });
      await this.outbox.emit(q, actor.user.propertyId, 'folio.charges_posted', { type: 'folio', id: folio.id }, { posted });
    }
    return { id: folio.id };
  }

  private async postable(ctx: NightAuditContext): Promise<PostableRow[]> {
    const { rows } = await ctx.q.query<PostableRow>(
      `SELECT s.id AS stay_id, s.room_id, rm.number AS room_number,
              trim(g.first_name || ' ' || g.last_name) AS guest_name,
              n.room_rate, n.extra_person_amount, n.meal_amount,
              rt.name AS room_type_name, rr.meal_plan
         FROM stays s
         JOIN reservation_rooms rr ON rr.id = s.reservation_room_id
         JOIN reservation_room_nights n ON n.reservation_room_id = rr.id AND n.night_date = $2::date
         JOIN rooms rm ON rm.id = s.room_id
         JOIN room_types rt ON rt.id = rr.room_type_id
         JOIN reservations res ON res.id = s.reservation_id
         JOIN guests g ON g.id = res.primary_guest_id
        WHERE s.property_id = $1 AND s.status = 'in_house'
          AND n.night_date >= s.business_date_in
        ORDER BY rm.number`,
      [ctx.propertyId, ctx.businessDate],
    );
    return rows;
  }

  async inspect(ctx: NightAuditContext): Promise<StepReport> {
    const rows = await this.postable(ctx);
    const total = rows.reduce(
      (sum, r) => sum.plus(r.room_rate).plus(r.extra_person_amount).plus(r.meal_amount),
      money(0),
    );
    // Rooms whose night is already on the bill — a re-run, or an audit that failed partway.
    const { rows: already } = await ctx.q.query<{ n: string }>(
      `SELECT count(*) AS n FROM folio_lines
        WHERE property_id = $1 AND business_date = $2::date AND source = 'night_audit' AND voided_at IS NULL`,
      [ctx.propertyId, ctx.businessDate],
    );
    const posted = Number(already[0]!.n);

    return {
      ...emptyReport(),
      willDo: rows.length
        ? `Post ${formatINR(toMoneyString(total))} of room charges to ${rows.length} bill${rows.length === 1 ? '' : 's'} for ${formatDate(ctx.businessDate)}`
        : 'No occupied rooms to charge',
      warnings: posted > 0 ? [`${posted} room charge line${posted === 1 ? '' : 's'} for this date ${posted === 1 ? 'is' : 'are'} already on a bill and will not be posted twice.`] : [],
      facts: { roomsToCharge: rows.length, roomChargeTotal: toMoneyString(total) },
    };
  }

  async run(ctx: NightAuditContext): Promise<StepResult> {
    const rows = await this.postable(ctx);
    let posted = 0;
    let skipped = 0;
    let total = money(0);

    for (const row of rows) {
      const folio = await this.folios.ensureForStay(ctx.q, ctx.actor, row.stay_id);
      for (const part of PARTS) {
        const amount = row[part.column];
        if (!money(amount).gt(0)) continue;
        const name = part.lineType === 'room_night'
          ? `Room — ${row.room_type_name}`
          : part.lineType === 'meal'
            ? `Meal plan (${row.meal_plan})`
            : 'Extra person';

        const { rowCount } = await ctx.q.query(
          `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount,
                                    tax_category, source, room_id, created_by)
           SELECT $1,$2,$3::date,$4,$5,1,$6,$6,$7,'night_audit',$8,$9
            WHERE NOT EXISTS (SELECT 1 FROM folio_lines WHERE folio_id=$2 AND business_date=$3::date AND line_type=$4 AND source='night_audit')
           ON CONFLICT DO NOTHING`,
          [ctx.propertyId, folio.id, ctx.businessDate, part.lineType, name, amount, part.taxCategory, row.room_id, ctx.actor.user.id],
        );
        if (rowCount) {
          posted += 1;
          total = total.plus(amount);
        } else {
          skipped += 1;
        }
      }
    }

    return { posted, skipped, details: { rooms: rows.length, total: toMoneyString(total), businessDate: ctx.businessDate } };
  }
}
