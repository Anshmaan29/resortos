import { Controller, Global, Module, Post } from '@nestjs/common';
import { ERROR_CODES } from '@resortos/shared';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { AuditService } from '../common/audit.service';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import { StorageService } from './storage.service';

@Controller('storage')
@Roles('owner')
class StorageSetupController {
  constructor(private readonly storage: StorageService, private readonly db: DbService, private readonly audit: AuditService) {}
  @Post('phone-access')
  async setup(@CurrentActor() actor: Actor) {
    let result;
    try { result = await this.storage.configurePhoneAccess(); }
    catch { throw new AppError(ERROR_CODES.SERVICE_BUSY, 'Phone storage access could not be configured. Check the bucket permissions with the operator.'); }
    await this.db.tx({ userId: actor.user.id }, q => this.audit.record(q, actor, { action: 'storage.phone_access_configured', entityType: 'property', entityId: actor.user.propertyId, after: result }));
    return { ok: true, ...result };
  }
}

@Global()
@Module({ controllers: [StorageSetupController], providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
