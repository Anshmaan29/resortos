import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceDueStep } from './maintenance.step';
import { MaintenanceService } from './maintenance.service';

/** Maintenance tickets and preventive schedules (spec §38). */
@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceService, MaintenanceDueStep],
  exports: [MaintenanceService, MaintenanceDueStep],
})
export class MaintenanceModule {}
