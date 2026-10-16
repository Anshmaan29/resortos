import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { PropertyModule } from '../property/property.module';
import { FoliosModule } from '../folios/folios.module';
import { VillaController } from './villa.controller';
import { VillaService } from './villa.service';
@Module({
  imports: [GuestsModule, ReservationsModule, PropertyModule, FoliosModule],
  controllers: [VillaController],
  providers: [VillaService],
  exports: [VillaService],
})
export class VillaModule {}
