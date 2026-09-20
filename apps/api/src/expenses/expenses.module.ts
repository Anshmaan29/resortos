import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

/** Expenses (spec §39): money out, recorded the way money in is. */
@Module({
  imports: [PropertyModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
