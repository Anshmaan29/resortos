import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { CompaniesService } from './companies.service';
import { OtaService } from './ota.service';
import { ReceivablesController } from './receivables.controller';

/** Money owed to the resort by companies and OTAs (spec §32, §33). */
@Module({
  imports: [PropertyModule],
  controllers: [ReceivablesController],
  providers: [CompaniesService, OtaService],
  exports: [CompaniesService, OtaService],
})
export class ReceivablesModule {}
