import { Module } from '@nestjs/common';
import { CashierModule } from '../cashier/cashier.module';
import { FoliosModule } from '../folios/folios.module';
import { PrintingController } from './printing.controller';
import { PrintingService } from './printing.service';

/** A4 invoice, receipt, shift report and the 80 mm thermal option (spec §36). */
@Module({
  imports: [FoliosModule, CashierModule],
  controllers: [PrintingController],
  providers: [PrintingService],
  exports: [PrintingService],
})
export class PrintingModule {}
