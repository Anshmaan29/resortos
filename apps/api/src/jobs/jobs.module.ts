import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { OUTBOX_HANDLERS, type OutboxHandler } from './outbox-handlers';
import { OutboxDispatcher } from './outbox.dispatcher';

/**
 * Work that runs after commit (spec §8.2, §13).
 *
 * Handlers are contributed here, the same extension-point pattern checkout steps use. Phase 3
 * registers WhatsApp, email, the Google Sheets mirror and the Drive archive; until then events are
 * recorded faithfully and dispatched with nothing to do, which job status reports honestly.
 */
@Global()
@Module({
  providers: [
    { provide: OUTBOX_HANDLERS, useFactory: (): OutboxHandler[] => [] },
    OutboxDispatcher,
    JobsService,
  ],
  exports: [OUTBOX_HANDLERS, OutboxDispatcher, JobsService],
})
export class JobsModule {}
