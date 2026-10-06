import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CashierModule } from './cashier/cashier.module';
import { APP_CONFIG, loadConfig } from './config';
import { ComplianceModule } from './compliance/compliance.module';
import { DbModule } from './db/db.module';
import { FoliosModule } from './folios/folios.module';
import { ExportsModule } from './exports/exports.module';
import { ExpensesModule } from './expenses/expenses.module';
import { GuestsModule } from './guests/guests.module';
import { HousekeepingModule } from './housekeeping/housekeeping.module';
import { JobsModule } from './jobs/jobs.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MessagingModule } from './messaging/messaging.module';
import { NightAuditModule } from './night-audit/night-audit.module';
import { HealthController } from './health/health.controller';
import { PrintingModule } from './printing/printing.module';
import { PropertyModule } from './property/property.module';
import { ReceivablesModule } from './receivables/receivables.module';
import { ReviewModule } from './review/review.module';
import { RatesModule } from './rates/rates.module';
import { ReservationsModule } from './reservations/reservations.module';
import { StaysModule } from './stays/stays.module';
import { StorageModule } from './storage/storage.module';
import { Global } from '@nestjs/common';

@Global()
@Module({ providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }], exports: [APP_CONFIG] })
class ConfigModule {}

@Module({
  imports: [ConfigModule, DbModule, StorageModule, JobsModule, AuthModule, PropertyModule, RatesModule, GuestsModule, ReservationsModule, StaysModule, FoliosModule, CashierModule, ReceivablesModule, PrintingModule, ReviewModule, MessagingModule, HousekeepingModule, ExpensesModule, ComplianceModule, ExportsModule, MaintenanceModule, NightAuditModule],
  controllers: [HealthController],
})
export class AppModule {}
