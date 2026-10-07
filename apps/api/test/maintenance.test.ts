import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, login, post, type Agent } from './helpers';

/**
 * Maintenance (spec §38): tickets that walk one path only, rooms marked out of service from the
 * ticket, and preventive schedules the night audit opens tickets for.
 */
const TEST_BUSINESS_DATE = '2026-09-16';

let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: { type: (code: string) => string; room: (number: string) => string; ownerId: string };
const patch = (agent: Agent, path: string, body: unknown, key = `mt-${Math.random().toString(36).slice(2)}`) =>
  agent.patch(`/api/v1${path}`).set('x-resortos', '1').set('idempotency-key', key).send(body as object);

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('maintenance', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  const types = await sql<{ id: string; code: string }>(`SELECT id, code FROM room_types`);
  const rooms = await sql<{ id: string; number: string }>(`SELECT id, number FROM rooms`);
  const owners = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
  f = {
    type: (code) => types.find((t) => t.code === code)!.id,
    room: (number) => rooms.find((r) => r.number === number)!.id,
    ownerId: owners[0]!.id,
  };
}, 120_000);
afterAll(async () => { await app.close(); });

describe('tickets', () => {
  it('opens a ticket about a room or an area — never both, never neither', async () => {
    const room = await post(desk, '/maintenance/tickets', { roomId: f.room('206'), title: 'AC not cooling', priority: 'high' }).expect(201);
    expect(room.body.id).toBeTruthy();
    await post(desk, '/maintenance/tickets', { area: 'Generator', title: 'Servicing overdue' }).expect(201);
    await post(desk, '/maintenance/tickets', { roomId: f.room('206'), area: 'Lobby', title: 'Both targets' }).expect(400);
    await post(desk, '/maintenance/tickets', { title: 'No target at all' }).expect(400);
  });

  it('walks open → in progress → resolved (with what was done and what it cost) → closed', async () => {
    const { body: ticket } = await post(desk, '/maintenance/tickets', { roomId: f.room('208'), title: 'Geyser leaking' }).expect(201);

    const started = await patch(desk, `/maintenance/tickets/${ticket.id}`, { version: 1, status: 'in_progress' }).expect(200);
    expect(started.body.status).toBe('in_progress');

    const noNote = await patch(desk, `/maintenance/tickets/${ticket.id}`, { version: started.body.version, status: 'resolved' }).expect(400);
    expect(noNote.body.message).toMatch(/what was done/);

    const resolved = await patch(desk, `/maintenance/tickets/${ticket.id}`, { version: started.body.version, status: 'resolved', resolutionNote: 'Replaced the heating element', cost: '1850' }).expect(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', resolutionNote: 'Replaced the heating element', cost: '1850.00' });

    const closed = await patch(owner, `/maintenance/tickets/${ticket.id}`, { version: resolved.body.version, status: 'closed' }).expect(200);
    expect(closed.body.status).toBe('closed');

    const afterClose = await patch(owner, `/maintenance/tickets/${ticket.id}`, { version: closed.body.version, priority: 'low' });
    expect(afterClose.status).toBe(400);
    await expect(sql(`UPDATE maintenance_tickets SET status = 'open' WHERE id = $1`, [ticket.id])).rejects.toThrow(/closed maintenance ticket/);
    await expect(sql(`DELETE FROM maintenance_tickets WHERE id = $1`, [ticket.id])).rejects.toThrow(/close one instead/);
  });

  it('refuses the skips: open → resolved is allowed by the path, closed → anything is not, and the target never changes', async () => {
    const { body: ticket } = await post(desk, '/maintenance/tickets', { area: 'Water pump', title: 'Pressure low' }).expect(201);
    await patch(desk, `/maintenance/tickets/${ticket.id}`, { version: 1, status: 'resolved', resolutionNote: 'Cleaned the filter' }).expect(200);
    await expect(sql(`UPDATE maintenance_tickets SET title = 'Different problem' WHERE id = $1`, [ticket.id])).rejects.toThrow(/raised for cannot change/);
    await expect(sql(`UPDATE maintenance_tickets SET status = 'open' WHERE id = $1`, [ticket.id])).rejects.toThrow(/cannot go from resolved to open/);
  });

  it('assigns staff and sets priority without touching the rest', async () => {
    const { body: ticket } = await post(desk, '/maintenance/tickets', { roomId: f.room('209'), title: 'Fan making noise' }).expect(201);
    const patched = await patch(desk, `/maintenance/tickets/${ticket.id}`, { version: 1, assignedTo: f.ownerId, priority: 'low' }).expect(200);
    expect(patched.body).toMatchObject({ assignedTo: { id: f.ownerId }, priority: 'low', status: 'open' });
    const stale = await patch(desk, `/maintenance/tickets/${ticket.id}`, { version: 1, priority: 'high' });
    expect(stale.body.code).toBe('STALE_VERSION');
  });

  it('marks the room under maintenance and back from the ticket (room service status, spec §38)', async () => {
    const { body: ticket } = await post(desk, '/maintenance/tickets', { roomId: f.room('210'), title: 'TV not working' }).expect(201);
    await post(desk, `/rooms/${f.room('210')}/status`, { service: 'maintenance' }).expect(201);
    const listed = (await desk.get('/api/v1/maintenance/tickets').expect(200)).body;
    const mine = listed.find((t: any) => t.id === ticket.id);
    expect(mine.roomServiceStatus).toBe('maintenance');
    expect(mine.roomNumber).toBe('210');
    await post(desk, `/rooms/${f.room('210')}/status`, { service: 'in_service' }).expect(201);
  });
});

describe('preventive schedules (spec §38)', () => {
  it('are the owner\'s to manage', async () => {
    await desk.get('/api/v1/maintenance/schedules').expect(403);
    await post(desk, '/maintenance/schedules', { name: 'Generator service', everyDays: 90 }).expect(403);
  });

  it('the night audit opens a ticket for every schedule that is due and moves it forward', async () => {
    await post(owner, '/maintenance/schedules', { name: 'AC service', everyDays: 30, nextDue: TEST_BUSINESS_DATE }).expect(201);
    await post(owner, '/maintenance/schedules', { name: 'Fire extinguishers', everyDays: 180, nextDue: '2026-10-20' }).expect(201);

    // The demo booking arriving today blocks the audit; mark it a no-show first.
    const arrivals = await sql<{ id: string }>(`SELECT id FROM reservations WHERE arrival = $1 AND status = 'confirmed'`, [TEST_BUSINESS_DATE]);
    for (const a of arrivals) await post(desk, `/reservations/${a.id}/no-show`, { reason: 'did_not_arrive' }).expect(200);
    await post(desk, '/night-audit/complete', { businessDate: TEST_BUSINESS_DATE }).expect(200);

    const tickets = (await desk.get('/api/v1/maintenance/tickets').expect(200)).body;
    const due = tickets.find((t: any) => t.title === 'AC service is due for service');
    expect(due).toBeTruthy();
    expect(due.status).toBe('open');

    const schedules = (await owner.get('/api/v1/maintenance/schedules').expect(200)).body;
    const ac = schedules.find((s: any) => s.name === 'AC service');
    expect(ac.nextDue).toBe('2026-10-16'); // business date + 30 days
    expect(ac.lastTicketId).toBe(due.id);
    const fire = schedules.find((s: any) => s.name === 'Fire extinguishers');
    expect(fire.nextDue).toBe('2026-10-20'); // not due, not touched

    // One ticket, not one per replay: completing again answers alreadyCompleted and opens nothing.
    const again = await post(desk, '/night-audit/complete', { businessDate: TEST_BUSINESS_DATE }).expect(200);
    expect(again.body.alreadyCompleted).toBe(true);
    const afterReplay = (await desk.get('/api/v1/maintenance/tickets').expect(200)).body.filter((t: any) => t.title === 'AC service is due for service');
    expect(afterReplay).toHaveLength(1);
  });

  it('a schedule can be deactivated so the audit leaves it alone', async () => {
    const { body: created } = await post(owner, '/maintenance/schedules', { name: 'Pump check', everyDays: 7, nextDue: TEST_BUSINESS_DATE }).expect(201);
    const current = (await owner.get('/api/v1/maintenance/schedules').expect(200)).body.find((s: any) => s.id === created.id);
    await patch(owner, `/maintenance/schedules/${created.id}`, { version: current.version, isActive: false }).expect(200);
    const after = (await owner.get('/api/v1/maintenance/schedules').expect(200)).body.find((s: any) => s.id === created.id);
    expect(after.isActive).toBe(false);
  });
});
