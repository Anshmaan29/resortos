import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { guestSchema, zId } from '@resortos/shared';
import { CurrentActor } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { parse } from '../common/zod';
import { GuestsService } from './guests.service';
import { SearchService } from './search.service';

@Controller('guests')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Get()
  search(@CurrentActor() actor: Actor, @Query('q') q = '') {
    return this.guests.search(actor.user.propertyId, String(q).slice(0, 60));
  }

  @Post('duplicates')
  duplicates(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(guestSchema.pick({ mobile: true, firstName: true, lastName: true, city: true }), body);
    return this.guests.findPossibleDuplicates(actor.user.propertyId, input);
  }

  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.guests.get(actor.user.propertyId, parse(zId, id), actor.user.role);
  }

  @Post()
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.guests.create(actor, parse(guestSchema, body));
  }

  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { version } = parse(z.object({ version: z.number().int().min(1) }), body);
    return this.guests.update(actor, parse(zId, id), parse(guestSchema, body), version);
  }
}

/** Ctrl+K (spec §71). Root-level, because it is not only about guests. */
@Controller()
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('search')
  find(@CurrentActor() actor: Actor, @Query('q') q = '') {
    return this.search.search(actor.user.propertyId, String(q).slice(0, 60));
  }
}
