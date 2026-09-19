import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { parse } from '../common/zod';
import { ReviewService } from './review.service';

const querySchema = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  includeSeen: z.enum(['true', 'false']).optional(),
});
const seenSchema = z.object({ keys: z.array(z.string().regex(/^[a-z_]+:[0-9a-f-]{36}$/)).min(1).max(500) });

/** The owner review list (spec §34.4). Owner only. */
@Controller('owner-review')
@Roles('owner')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const q = parse(querySchema, query);
    return this.review.list(actor, { from: q.from, to: q.to }, q.includeSeen === 'true');
  }

  @Post('seen')
  @HttpCode(200)
  seen(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.review.markSeen(actor, parse(seenSchema, body).keys);
  }
}
