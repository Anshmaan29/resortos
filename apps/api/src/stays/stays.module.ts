import { Module } from '@nestjs/common';
import { DepositCheckoutStep, InvoiceCheckoutStep, SettlementCheckoutStep } from '../folios/checkout.steps';
import { FoliosModule } from '../folios/folios.module';
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
  imports: [PropertyModule, RatesModule, ReservationsModule, FoliosModule],
  controllers: [StaysController],
  providers: [
    CaptureService,
    CheckInService,
    GrcService,
    StaysService,
    // Billing's steps (2.3–2.6): the deposit decided, the balance settled, the invoice issued.
    // The steps live with the bill they read; this is only where checkout is told they exist.
    {
      provide: CHECKOUT_STEPS,
      useFactory: (deposit: DepositCheckoutStep, settlement: SettlementCheckoutStep, invoice: InvoiceCheckoutStep): CheckoutStep[] =>
        [deposit, settlement, invoice],
      inject: [DepositCheckoutStep, SettlementCheckoutStep, InvoiceCheckoutStep],
    },
  ],
})
export class StaysModule {}
