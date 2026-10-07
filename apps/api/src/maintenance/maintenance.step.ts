import { Injectable } from '@nestjs/common';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport, type StepResult } from '../night-audit/night-audit-pipeline';
import { MaintenanceService } from './maintenance.service';

/**
 * Night audit step: preventive maintenance that has come due (spec §38 "preventive schedules create
 * tickets on due dates").
 *
 * One ticket per due schedule, and the schedule's next_due moves to businessDate + every_days inside
 * the same transaction — so a schedule is due again exactly when its interval says, and replaying a
 * night audit cannot open a second ticket (the audit itself runs once per date, and the FOR UPDATE
 * here locks the schedules it is working on).
 */
@Injectable()
export class MaintenanceDueStep implements NightAuditStep {
  readonly name = 'maintenance_due';
  readonly title = 'Preventive maintenance due';
  readonly order = 75;
  readonly blocking = false;

  constructor(private readonly maintenance: MaintenanceService) {}

  private async due(ctx: NightAuditContext) {
    const { rows } = await ctx.q.query<{ name: string; next_due: string }>(
      `SELECT name, to_char(next_due, 'YYYY-MM-DD') AS next_due FROM maintenance_schedules
        WHERE property_id = $1 AND is_active AND next_due <= $2::date
        ORDER BY next_due`,
      [ctx.propertyId, ctx.businessDate],
    );
    return rows;
  }

  async inspect(ctx: NightAuditContext): Promise<StepReport> {
    const rows = await this.due(ctx);
    return {
      ...emptyReport(),
      willDo: rows.length
        ? `Open service tickets for: ${rows.map((r) => r.name).join(', ')}`
        : 'No preventive maintenance is due',
      facts: { maintenanceDue: rows.length },
    };
  }

  async run(ctx: NightAuditContext): Promise<StepResult> {
    const result = await this.maintenance.openDueSchedules(ctx.q, ctx.actor, ctx.propertyId, ctx.businessDate);
    return { posted: result.opened, skipped: result.skipped };
  }
}
