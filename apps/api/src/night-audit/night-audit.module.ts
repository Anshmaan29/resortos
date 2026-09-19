import { Module } from '@nestjs/common';
import { CashierModule } from '../cashier/cashier.module';
import { OpenShiftsStep } from '../cashier/open-shifts.step';
import { FoliosModule } from '../folios/folios.module';
import { BalanceIntegrityStep } from '../folios/integrity.step';
import { RoomNightPostingStep } from '../folios/room-night.step';
import { PropertyModule } from '../property/property.module';
import { NIGHT_AUDIT_STEPS, type NightAuditStep } from './night-audit-pipeline';
import { NightAuditController } from './night-audit.controller';
import { NightAuditService } from './night-audit.service';
import { BUILT_IN_NIGHT_AUDIT_STEPS } from './steps';

/**
 * Night audit and the business date (spec §35).
 *
 * Steps are contributed through `NIGHT_AUDIT_STEPS`: 2.2 adds room-night posting and 2.4 adds the
 * open-shift check by appending to this array, with no change to the service or the screen.
 */
@Module({
  imports: [PropertyModule, FoliosModule, CashierModule],
  controllers: [NightAuditController],
  providers: [
    NightAuditService,
    {
      provide: NIGHT_AUDIT_STEPS,
      // Each step's own module owns it; this is only where the audit is told it exists: room-night
      // posting (2.2), the open-shift check (2.4) and the nightly integrity check (2.4b).
      useFactory: (roomNights: RoomNightPostingStep, integrity: BalanceIntegrityStep, shifts: OpenShiftsStep): NightAuditStep[] =>
        [...BUILT_IN_NIGHT_AUDIT_STEPS, shifts, roomNights, integrity],
      inject: [RoomNightPostingStep, BalanceIntegrityStep, OpenShiftsStep],
    },
  ],
  exports: [NightAuditService, NIGHT_AUDIT_STEPS],
})
export class NightAuditModule {}
