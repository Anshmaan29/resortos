import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService, private readonly storage: StorageService) {}

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

  @Public()
  @Get('storage')
  async storageHealth() {
    const started = Date.now();
    await this.storage.ping();
    return { status: 'ok', latencyMs: Date.now() - started };
  }
}
