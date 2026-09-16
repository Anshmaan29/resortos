import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { APP_CONFIG, loadConfig } from './config';
import { DbModule } from './db/db.module';
import { GuestsModule } from './guests/guests.module';
import { HealthController } from './health/health.controller';
import { PropertyModule } from './property/property.module';
import { RatesModule } from './rates/rates.module';
import { ReservationsModule } from './reservations/reservations.module';
import { Global } from '@nestjs/common';

@Global()
@Module({ providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }], exports: [APP_CONFIG] })
class ConfigModule {}

@Module({
  imports: [ConfigModule, DbModule, AuthModule, PropertyModule, RatesModule, GuestsModule, ReservationsModule],
  controllers: [HealthController],
})
export class AppModule {}
