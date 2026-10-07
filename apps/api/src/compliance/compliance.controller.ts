import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { formCDetailsSchema, formCSubmitSchema, zId, zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { PropertyService } from '../property/property.service';
import { FormCService } from './form-c.service';
import { PoliceRegisterService } from './police-register.service';

const versioned = z.object({ version: z.coerce.number().int().min(1) });

/** Form C (spec §58.1) and the police register (§58.2). */
@Controller()
export class ComplianceController {
  constructor(
    private readonly formC: FormCService,
    private readonly police: PoliceRegisterService,
    private readonly property: PropertyService,
    private readonly db: DbService,
  ) {}

  @Get('form-c')
  list(@CurrentActor() actor: Actor, @Query('status') status?: string) {
    const filter = parse(z.enum(['pending', 'submitted', 'departure_updated']).optional(), status || undefined);
    return this.formC.list(actor.user.propertyId, filter);
  }

  @Get('form-c/pending-summary')
  pending(@CurrentActor() actor: Actor) {
    return this.formC.pendingSummary(actor.user.propertyId);
  }

  @Get('form-c/:id')
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.formC.get(actor.user.propertyId, parse(zId, id));
  }

  @Get('form-c/:id/portal-summary')
  summary(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.formC.portalSummary(actor.user.propertyId, parse(zId, id));
  }

  @Put('form-c/:id')
  save(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const recordId = parse(zId, id);
    const input = parse(formCDetailsSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.formC.saveDetails(q, actor, recordId, input));
  }

  @Post('form-c/:id/submit')
  @HttpCode(200)
  submit(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const recordId = parse(zId, id);
    const { reference, version } = parse(formCSubmitSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.formC.submit(q, actor, recordId, reference, version));
  }

  @Post('form-c/:id/departure-updated')
  @HttpCode(200)
  departure(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const recordId = parse(zId, id);
    const { version } = parse(versioned, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.formC.markDepartureUpdated(q, actor, recordId, version));
  }

  /** The register on screen; the file versions live in the exports endpoints (§46). */
  @Get('police-register')
  @Roles('owner')
  async register(@CurrentActor() actor: Actor, @Query('from') from?: string, @Query('to') to?: string) {
    const businessDate = (await this.property.getProperty(actor.user.propertyId)).businessDate;
    return this.police.rows(actor.user.propertyId, from ? parse(zIsoDate, from) : businessDate, to ? parse(zIsoDate, to) : businessDate);
  }
}
