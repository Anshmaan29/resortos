import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../config';
import { OutboxDispatcher } from './outbox.dispatcher';

export const OUTBOX_QUEUE = 'outbox.drain';
/** A heartbeat every minute, plus an immediate nudge whenever a batch comes back full. */
const HEARTBEAT_CRON = '* * * * *';

/**
 * The job runtime (spec §7): pg-boss, so jobs live in the same PostgreSQL database, are covered by
 * the same backups, and need no second system that can lose them.
 *
 * **pg-boss does not own the outbox.** The event row in `outbox_events` is the durable job, written
 * in the business transaction; pg-boss only decides *when* a drain runs and makes sure something
 * runs it. That keeps one answer to "was this delivered" instead of two that can disagree.
 *
 * The schema belongs to the migration role: `pnpm db:migrate` applies pg-boss's own construction
 * plans, and this process starts with `migrate: false` because `resortos_app` has no DDL rights.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private boss: PgBoss | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly outbox: OutboxDispatcher,
  ) {}

  async onModuleInit() {
    if (!this.config.JOBS_ENABLED) {
      this.logger.log('Background jobs are switched off for this process');
      return;
    }
    const boss = new PgBoss({
      connectionString: this.config.DATABASE_URL,
      schema: 'pgboss',
      migrate: false, // installed by pnpm db:migrate, as the migration role
      application_name: 'resortos-jobs',
    });
    boss.on('error', (err: Error) => this.logger.error(`Job queue error: ${err.message}`));
    await boss.start();
    await boss.createQueue(OUTBOX_QUEUE);

    await boss.work(OUTBOX_QUEUE, { batchSize: 1 }, async () => {
      let guard = 0;
      // Keep going while batches come back full, so a burst clears in seconds rather than minutes.
      for (;;) {
        const result = await this.outbox.drainOnce();
        if (!result.more || (guard += 1) >= 50) break;
      }
    });

    // Something must run even when nothing nudges it.
    await boss.schedule(OUTBOX_QUEUE, HEARTBEAT_CRON);
    this.boss = boss;
    this.logger.log('Job queue started');
  }

  /** Runs the drain now instead of waiting for the heartbeat. */
  async nudge(): Promise<void> {
    await this.boss?.send(OUTBOX_QUEUE, {}, { singletonKey: OUTBOX_QUEUE, singletonSeconds: 1 });
  }

  async onApplicationShutdown() {
    const boss = this.boss;
    this.boss = null;
    // Let a running drain finish: an interrupted handler would only be retried, but finishing is tidier.
    await boss?.stop({ graceful: true, close: true }).catch((err: Error) => this.logger.warn(`Job queue stop: ${err.message}`));
  }
}
