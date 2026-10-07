import { Controller, Get, Inject, Module, Post, type OnModuleInit } from '@nestjs/common';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { ExportsModule } from '../exports/exports.module';
import { SCHEDULED_JOBS, type ScheduledJob } from '../jobs/jobs.service';
import { SheetsService } from './sheets.service';

@Controller('sheets')
@Roles('owner')
class SheetsController {
  constructor(private readonly sheets: SheetsService) {}
  @Get('status') status(@CurrentActor() actor: Actor) { return this.sheets.status(actor.user.propertyId); }
  @Post('sync') sync(@CurrentActor() actor: Actor) { return this.sheets.sync(actor.user.propertyId); }
}
@Module({ imports: [ExportsModule], controllers: [SheetsController], providers: [SheetsService] })
export class SheetsModule implements OnModuleInit {
  constructor(private readonly sheets: SheetsService, @Inject(SCHEDULED_JOBS) private readonly scheduled: ScheduledJob[]) {}
  onModuleInit() { this.scheduled.push({ queue: 'sheets.sync', cron: '*/5 * * * *', run: () => this.sheets.scheduled() }); }
}
