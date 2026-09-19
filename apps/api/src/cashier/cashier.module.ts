import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { OpenShiftsStep } from './open-shifts.step';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

/** Cashier shifts and the account-wise ledger (spec §34). The open-shift check is a night audit step. */
@Module({
  imports: [PropertyModule],
  controllers: [ShiftsController],
  providers: [ShiftsService, OpenShiftsStep],
  exports: [ShiftsService, OpenShiftsStep],
})
export class CashierModule {}
