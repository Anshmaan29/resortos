import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { HousekeepingController } from './housekeeping.controller';
import { HousekeepingService } from './housekeeping.service';
import { StayoverCleaningStep } from './stayover.step';

/** Housekeeping (spec §37). The daily clean of occupied rooms is a night audit step. */
@Module({
  imports: [PropertyModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService, StayoverCleaningStep],
  exports: [HousekeepingService, StayoverCleaningStep],
})
export class HousekeepingModule {}
