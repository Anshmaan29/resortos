import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PropertyModule } from '../property/property.module';
import { RatesModule } from '../rates/rates.module';
import { FolioService } from './folio.service';
import { FoliosController } from './folios.controller';
import { RoomNightPostingStep } from './room-night.step';

/**
 * The bill (spec §23, §24).
 *
 * `RoomNightPostingStep` is exported so that the night audit module can register it — the step
 * lives here, with the folio code it writes to, rather than inside night audit.
 */
@Module({
  imports: [PropertyModule, RatesModule, AuthModule],
  controllers: [FoliosController],
  providers: [FolioService, RoomNightPostingStep],
  exports: [FolioService, RoomNightPostingStep],
})
export class FoliosModule {}
