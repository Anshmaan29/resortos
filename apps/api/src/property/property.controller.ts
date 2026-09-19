import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { propertyPoliciesSchema, propertySettingsSchema, roomSchema, roomStatusChangeSchema, roomTypeSchema, zId, zIsoDate } from '@resortos/shared';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { parse } from '../common/zod';
import { PropertyService } from './property.service';

const versioned = z.object({ version: z.number().int().min(1) });

@Controller()
export class PropertyController {
  constructor(private readonly property: PropertyService) {}

  @Get('property')
  get(@CurrentActor() actor: Actor) {
    return this.property.getProperty(actor.user.propertyId);
  }

  @Patch('property/policies')
  @Roles('owner')
  updatePolicies(@CurrentActor() actor: Actor, @Body() body: unknown) {
    // What GET returns can be sent straight back: an unset text setting comes out as null and goes
    // back in as "not set".
    const cleaned = body && typeof body === 'object' ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) : body;
    return this.property.updatePolicies(actor, parse(propertyPoliciesSchema, cleaned));
  }

  @Patch('property')
  @Roles('owner')
  update(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const { version } = parse(versioned, body);
    return this.property.updateProperty(actor, parse(propertySettingsSchema, body), version);
  }

  @Get('room-types')
  roomTypes(@CurrentActor() actor: Actor, @Query('includeInactive') includeInactive?: string) {
    return this.property.listRoomTypes(actor.user.propertyId, includeInactive === 'true' && actor.user.role === 'owner');
  }

  @Post('room-types')
  @Roles('owner')
  createRoomType(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.property.createRoomType(actor, parse(roomTypeSchema, body));
  }

  @Patch('room-types/:id')
  @Roles('owner')
  updateRoomType(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { version, isActive } = parse(versioned.extend({ isActive: z.boolean().optional() }), body);
    return this.property.updateRoomType(actor, parse(zId, id), { ...parse(roomTypeSchema, body), isActive }, version);
  }

  @Get('rooms/setup')
  @Roles('owner')
  roomsForSetup(@CurrentActor() actor: Actor) {
    return this.property.listRoomsForSetup(actor.user.propertyId);
  }

  @Get('rooms')
  rooms(@CurrentActor() actor: Actor, @Query('date') date?: string) {
    return this.property.listRooms(actor.user.propertyId, date ? parse(zIsoDate, date) : undefined);
  }

  @Post('rooms')
  @Roles('owner')
  createRoom(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.property.createRoom(actor, parse(roomSchema, body));
  }

  @Patch('rooms/:id')
  @Roles('owner')
  updateRoom(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { version, isActive } = parse(versioned.extend({ isActive: z.boolean().optional() }), body);
    return this.property.updateRoom(actor, parse(zId, id), { ...parse(roomSchema, body), isActive }, version);
  }

  @Post('rooms/:id/status')
  @Roles('owner', 'receptionist', 'cleaner')
  changeStatus(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(roomStatusChangeSchema, body);
    // Cleaners may only move housekeeping status (spec §4.3).
    if (actor.user.role === 'cleaner' && input.service) {
      return this.property.changeRoomStatus(actor, parse(zId, id), { housekeeping: input.housekeeping, reason: input.reason });
    }
    return this.property.changeRoomStatus(actor, parse(zId, id), input);
  }

  @Get('rooms/:id/status-history')
  history(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.property.roomStatusHistory(actor.user.propertyId, parse(zId, id));
  }

  @Post('rooms/:id/out-of-order')
  outOfOrder(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(
      z.object({ startDate: zIsoDate, endDate: zIsoDate, reason: z.string().trim().min(3).max(200) })
        .refine((v) => v.endDate > v.startDate, { message: 'End date must be after start date', path: ['endDate'] }),
      body,
    );
    return this.property.markOutOfOrder(actor, parse(zId, id), input);
  }
}
