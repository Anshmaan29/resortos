import { Injectable } from '@nestjs/common';
import { addDays } from '@resortos/shared';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport, type StepResult } from '../night-audit/night-audit-pipeline';

/**
 * Night audit step: tomorrow's daily clean for every occupied room (spec §37 "stayover cleaning tasks
 * daily (setting)").
 *
 * A guest leaving tomorrow gets the checkout clean when they leave, so only stays continuing past
 * tomorrow count. A room that already has open work (still dirty from today) is left alone — one
 * task per room.
 *
 * **Idempotent by constraint:** the insert is `ON CONFLICT DO NOTHING` against
 * `housekeeping_tasks_one_stayover` (one per room per date) and `housekeeping_tasks_one_open`, and
 * only rooms whose task was actually created are marked dirty. Replaying the audit creates nothing.
 */
@Injectable()
export class StayoverCleaningStep implements NightAuditStep {
  readonly name = 'stayover_cleaning';
  readonly title = 'Daily cleaning for tomorrow';
  readonly order = 70;
  readonly blocking = false;

  private async candidates(ctx: NightAuditContext) {
    const { rows } = await ctx.q.query<{ room_id: string; number: string; enabled: boolean }>(
      `SELECT rm.id AS room_id, rm.number, p.housekeeping_stayovers AS enabled
         FROM stays s
         JOIN rooms rm ON rm.id = s.room_id
         JOIN properties p ON p.id = s.property_id
        WHERE s.property_id = $1 AND s.status = 'in_house' AND s.expected_departure > $2::date
          AND rm.housekeeping_status IN ('clean', 'inspected')
          AND NOT EXISTS (SELECT 1 FROM housekeeping_tasks t WHERE t.room_id = rm.id AND t.status IN ('open', 'in_progress'))
        ORDER BY rm.sort_order, rm.number`,
      [ctx.propertyId, addDays(ctx.businessDate, 1)],
    );
    return rows;
  }

  async inspect(ctx: NightAuditContext): Promise<StepReport> {
    const rows = await this.candidates(ctx);
    const { rows: setting } = await ctx.q.query<{ housekeeping_stayovers: boolean }>(
      `SELECT housekeeping_stayovers FROM properties WHERE id = $1`, [ctx.propertyId],
    );
    if (!setting[0]?.housekeeping_stayovers) return { ...emptyReport(), willDo: 'Daily cleaning of occupied rooms is switched off in settings' };
    return {
      ...emptyReport(),
      willDo: rows.length
        ? `Add tomorrow's cleaning for ${rows.length} occupied room${rows.length === 1 ? '' : 's'}: ${rows.map((r) => r.number).join(', ')}`
        : 'No occupied rooms need a daily clean tomorrow',
      facts: { stayoverCleans: rows.length },
    };
  }

  async run(ctx: NightAuditContext): Promise<StepResult> {
    const rows = await this.candidates(ctx);
    if (!rows.length || !rows[0]!.enabled) return { posted: 0, skipped: 0 };
    const tomorrow = addDays(ctx.businessDate, 1);
    const { rows: created } = await ctx.q.query<{ room_id: string }>(
      `INSERT INTO housekeeping_tasks (property_id, room_id, kind, business_date, created_by)
       SELECT $1, unnest($2::uuid[]), 'stayover', $3::date, $4
       ON CONFLICT DO NOTHING
       RETURNING room_id`,
      [ctx.propertyId, rows.map((r) => r.room_id), tomorrow, ctx.actor.user.id],
    );
    if (created.length) {
      await ctx.q.query(`SELECT set_config('resortos.reason', 'Daily cleaning (night audit)', true)`);
      // The task exists already, so the trigger leaves it as it is and only the room changes.
      await ctx.q.query(
        `UPDATE rooms SET housekeeping_status = 'dirty', updated_by = $2 WHERE id = ANY($1::uuid[])`,
        [created.map((c) => c.room_id), ctx.actor.user.id],
      );
    }
    return { posted: created.length, skipped: rows.length - created.length, details: { businessDate: tomorrow } };
  }
}
