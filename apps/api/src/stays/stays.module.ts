import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { RatesModule } from '../rates/rates.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { CaptureService } from './capture.service';
import { CheckInService } from './check-in.service';
import { CHECKOUT_STEPS, type CheckoutStep } from './checkout-pipeline';
import { GrcService } from './grc.service';
import { StaysController } from './stays.controller';
import { StaysService } from './stays.service';

@Module({
  imports: [PropertyModule, RatesModule, ReservationsModule],
  controllers: [StaysController],
  providers: [
    CaptureService,
    CheckInService,
    GrcService,
    StaysService,
    // Phase 2 (billing) contributes bill-review, settlement, deposit and invoice steps here.
    { provide: CHECKOUT_STEPS, useFactory: (): CheckoutStep[] => [] },
  ],
})
export class StaysModule {}
