import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { AuditService } from '../common/audit.service';
import { OutboxService } from '../common/outbox.service';
import { IdempotencyService } from '../common/idempotency.service';

@Global()
@Module({
  providers: [DbService, AuditService, OutboxService, IdempotencyService],
  exports: [DbService, AuditService, OutboxService, IdempotencyService],
})
export class DbModule {}
