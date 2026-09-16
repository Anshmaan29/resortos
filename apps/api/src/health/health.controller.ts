import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators';
import { DbService } from '../db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

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
}
