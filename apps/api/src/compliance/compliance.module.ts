import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { ComplianceController } from './compliance.controller';
import { FormCService } from './form-c.service';
import { PoliceRegisterService } from './police-register.service';

/** India compliance (spec §58): Form C for foreign nationals and the police / guest register. */
@Module({
  imports: [PropertyModule],
  controllers: [ComplianceController],
  providers: [FormCService, PoliceRegisterService],
  exports: [FormCService, PoliceRegisterService],
})
export class ComplianceModule {}
