import { Injectable } from '@nestjs/common';
import { formatDate, formatINR, money, toMoneyString } from '@resortos/shared';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport, type StepResult } from '../night-audit/night-audit-pipeline';
import { FolioService } from './folio.service';

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

  constructor(private readonly folios: FolioService) {}

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
           VALUES ($1,$2,$3::date,$4,$5,1,$6,$6,$7,'night_audit',$8,$9)
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
