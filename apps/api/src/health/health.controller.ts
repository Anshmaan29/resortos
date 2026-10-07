import { Controller, Get } from '@nestjs/common';
import { Public, Roles } from '../common/decorators';
import { DbService } from '../db/db.service';
import { OutboxDispatcher } from '../jobs/outbox.dispatcher';
import { StorageService } from '../storage/storage.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  @Public()
  @Get()
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Public()
  @Get('db')
  async database() {
    const started = Date.now();
    await this.db.query('SELECT 1');
    return { status: 'ok', latencyMs: Date.now() - started };
  }

  @Roles('owner')
  @Get('storage')
  async storageHealth() {
    const started = Date.now();
    await this.storage.ping();
    return { status: 'ok', latencyMs: Date.now() - started };
  }

  /**
   * Job queue depth (spec §75, §78). Owner-only, and never public: the counts say how much
   * after-commit work is waiting, which is operational detail, not a liveness probe.
   * This is what the owner's Data Safety panel reads in 3.6.
   */
  @Roles('owner')
  @Get('jobs')
  async jobs() {
    const status = await this.outbox.status();
    return {
      status: status.deadLettered > 0 ? 'attention' : 'ok',
      ...status,
    };
  }
}
