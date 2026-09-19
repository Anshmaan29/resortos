import { Module } from '@nestjs/common';
import { FoliosModule } from '../folios/folios.module';
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
  imports: [PropertyModule, FoliosModule],
  controllers: [NightAuditController],
  providers: [
    NightAuditService,
    {
      provide: NIGHT_AUDIT_STEPS,
      // 2.2 contributes room-night posting here. The step's own module owns it; this is only where
      // the audit is told it exists. 2.4 adds the open-shift check the same way.
      useFactory: (roomNights: RoomNightPostingStep): NightAuditStep[] => [...BUILT_IN_NIGHT_AUDIT_STEPS, roomNights],
      inject: [RoomNightPostingStep],
    },
  ],
  exports: [NightAuditService, NIGHT_AUDIT_STEPS],
})
export class NightAuditModule {}
