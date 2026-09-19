import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CashierModule } from './cashier/cashier.module';
import { APP_CONFIG, loadConfig } from './config';
import { DbModule } from './db/db.module';
import { FoliosModule } from './folios/folios.module';
import { GuestsModule } from './guests/guests.module';
import { JobsModule } from './jobs/jobs.module';
import { NightAuditModule } from './night-audit/night-audit.module';
import { HealthController } from './health/health.controller';
import { PropertyModule } from './property/property.module';
import { ReceivablesModule } from './receivables/receivables.module';
import { RatesModule } from './rates/rates.module';
import { ReservationsModule } from './reservations/reservations.module';
import { StaysModule } from './stays/stays.module';
import { StorageModule } from './storage/storage.module';
import { Global } from '@nestjs/common';

@Global()
@Module({ providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }], exports: [APP_CONFIG] })
class ConfigModule {}

@Module({
  imports: [ConfigModule, DbModule, StorageModule, JobsModule, AuthModule, PropertyModule, RatesModule, GuestsModule, ReservationsModule, StaysModule, FoliosModule, CashierModule, ReceivablesModule, NightAuditModule],
  controllers: [HealthController],
})
export class AppModule {}
