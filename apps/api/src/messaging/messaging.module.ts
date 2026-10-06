import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { OUTBOX_HANDLERS, type OutboxHandler } from '../jobs/outbox-handlers';
import { JobsService, SCHEDULED_JOBS, type ScheduledJob } from '../jobs/jobs.service';
import { PrintingModule } from '../printing/printing.module';
import { DailySummaryHandler } from './daily-summary.handler';
import { GuestMessagesHandler } from './guest-messages.handler';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MESSAGE_PROVIDERS, providersFor } from './providers';

export const MESSAGES_SEND_QUEUE = 'messages.send';
export const MESSAGES_REMINDERS_QUEUE = 'messages.reminders';

/**
 * Guest messages (spec §40, §41): templates, the per-message record, the providers, and the two
 * recurring jobs — the sender every minute, the checkout reminders every ten.
 */
@Module({
  imports: [PrintingModule],
  controllers: [MessagingController],
  providers: [
    MessagingService,
    GuestMessagesHandler,
    DailySummaryHandler,
    { provide: MESSAGE_PROVIDERS, useFactory: (config: AppConfig) => providersFor(config), inject: [APP_CONFIG] },
  ],
  exports: [MessagingService, MESSAGE_PROVIDERS],
})
export class MessagingModule implements OnModuleInit {
  constructor(
    private readonly messaging: MessagingService,
    private readonly handler: GuestMessagesHandler,
    private readonly dailySummary: DailySummaryHandler,
    private readonly jobs: JobsService,
    @Inject(OUTBOX_HANDLERS) private readonly handlers: OutboxHandler[],
    @Inject(SCHEDULED_JOBS) private readonly scheduled: ScheduledJob[],
  ) {}

  onModuleInit() {
    // After a handler queues a message, wake the sender rather than waiting for the minute.
    for (const h of [this.handler, this.dailySummary]) {
      this.handlers.push({
        name: h.name, topics: h.topics,
        handle: async (event) => { await h.handle(event); await this.jobs.nudge(MESSAGES_SEND_QUEUE); },
      });
    }
    this.scheduled.push(
      { queue: MESSAGES_SEND_QUEUE, cron: '* * * * *', run: async () => {
        // Keep going while batches come back full, as the outbox drain does.
        for (let i = 0; i < 20; i += 1) if ((await this.messaging.sendDue()).claimed < 10) break;
      } },
      { queue: MESSAGES_REMINDERS_QUEUE, cron: '*/10 * * * *', run: async () => { await this.messaging.queueCheckoutReminders(); } },
    );
  }
}
