import { Module } from '@nestjs/common';
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
  imports: [PropertyModule],
  controllers: [NightAuditController],
  providers: [
    NightAuditService,
    { provide: NIGHT_AUDIT_STEPS, useFactory: (): NightAuditStep[] => [...BUILT_IN_NIGHT_AUDIT_STEPS] },
  ],
  exports: [NightAuditService, NIGHT_AUDIT_STEPS],
})
export class NightAuditModule {}
