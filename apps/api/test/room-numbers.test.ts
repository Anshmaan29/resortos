import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, bootAppOnOwnDatabase, fixtures, login, post, type Agent } from './helpers';

let app: INestApplication;
let desk: Agent;
let sql: Awaited<ReturnType<typeof bootAppOnOwnDatabase>>['sql'];
let f: Awaited<ReturnType<typeof fixtures>>;

beforeAll(async () => {
  ({ app, sql } = await bootAppOnOwnDatabase('room_numbers', '2026-09-16'));
  desk = await login(app);
  f = await fixtures(sql);
  await sql("UPDATE rooms SET housekeeping_status='clean',service_status='in_service'");
}, 60_000);
afterAll(async () => { await app?.close(); });

const available = async (arrival = '2037-01-01', departure = '2037-01-03', reservationId?: string) =>
  (await desk.get('/api/v1/availability').query({ arrival, departure, reservationId }).expect(200)).body;

describe('one room-number inventory', () => {
  it('lists every ready room in one pool even when a legacy category filter is supplied', async () => {
    const result = await desk.get('/api/v1/availability').query({ arrival: '2037-01-01', departure: '2037-01-03', roomTypeId: f.type('EXE') }).expect(200);
    expect(result.body.rooms.map((r: { number: string }) => r.number)).toEqual([
      '101','102','103','104','105','106','107','108','201','202','203','204','205','206','207','208','209','210',
    ]);
    expect(result.body.available).toBe(18);
  });

  it('assigns across old categories without changing the agreed room price, extras, meal plan or GST', async () => {
    const body = booking({ roomTypeId: f.type('DLX'), roomId: f.room('106'), arrival: '2037-01-01', departure: '2037-01-03' });
    const created = (await post(desk, '/reservations', { ...body, rooms: [{ ...body.rooms[0], nightlyRate: '6500', includesMealPlan: true, mealPlan: 'MAP', extraPersonRate: '350', gstRate: '7.5' }] }).expect(201)).body;
    expect(created.rooms[0]).toMatchObject({ roomNumber: '106', nightlyRate: '6500.00', extrasTotal: '700.00', mealPlan: 'MAP', mealTotal: '0.00', gstRate: '7.50' });
    expect((await available()).rooms.some((r: {number:string}) => r.number === '106')).toBe(false);
    expect((await available(undefined, undefined, created.id)).rooms.some((r: {number:string}) => r.number === '106')).toBe(true);
    const assigned = (await post(desk, `/reservation-rooms/${created.rooms[0].id}/assign`, { roomId: f.room('101') }).expect(200)).body;
    expect(assigned.rooms[0]).toMatchObject({ roomNumber: '101', nightlyRate: '6500.00', extrasTotal: '700.00', mealPlan: 'MAP', gstRate: '7.50' });
    expect(assigned.estimate).toEqual(created.estimate);
    const clash = await post(desk, '/reservations', booking({ roomTypeId: f.type('PRE'), roomId: f.room('101'), arrival: '2037-01-02', departure: '2037-01-04' }));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('ROOM_UNAVAILABLE');
  });

  it('excludes dirty, cleaning, maintenance, inactive and dated blocked rooms and refuses stale choices', async () => {
    await sql("UPDATE rooms SET housekeeping_status='dirty' WHERE number='102'");
    await sql("UPDATE rooms SET housekeeping_status='cleaning' WHERE number='103'");
    await sql("UPDATE rooms SET service_status='maintenance' WHERE number='107'");
    await sql("UPDATE rooms SET is_active=false WHERE number='108'");
    await sql(`INSERT INTO room_out_of_order(property_id,room_id,start_date,end_date,reason,created_by)
      SELECT property_id,id,'2037-02-02','2037-02-03','QA repair',$1 FROM rooms WHERE number='104'`, [f.ownerId]);
    const free = (await available('2037-02-01','2037-02-04')).rooms.map((r:{number:string}) => r.number);
    for (const number of ['102','103','104','107','108']) {
      expect(free).not.toContain(number);
      const refused = await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), roomId: f.room(number), arrival:'2037-02-01',departure:'2037-02-04',nightlyRate:'6500' }));
      expect(refused.status).toBe(number === '108' ? 404 : 409);
    }
    await sql("UPDATE rooms SET housekeeping_status='clean',service_status='in_service',is_active=true");
    expect((await available('2037-02-01','2037-02-04')).rooms.map((r:{number:string}) => r.number)).toEqual(expect.arrayContaining(['102','103','107','108']));
  });

  it('never labels a still-reserved room ready on the second day of its pending arrival', async () => {
    const a=(await post(desk,'/reservations',booking({roomTypeId:f.type('DLX'),roomId:f.room('106'),arrival:'2037-04-01',departure:'2037-04-04'})).expect(201)).body;
    const board=(await desk.get('/api/v1/rooms').query({date:'2037-04-02'}).expect(200)).body;
    const room=board.find((r:{number:string})=>r.number==='106');
    expect(room.currentReservation.id).toBe(a.id);
    expect(room.sellable).toBe(false);
    expect(room.displayState).toBe('arriving');
  });
  it('does not offer or assign an overdue room until its guest has actually checked out', async () => {
    // The seed has a departure due today in 105. Materialise its in-house stay as in production.
    const [draft] = await sql<{id:string}>(`INSERT INTO check_in_drafts(property_id,reservation_id,reservation_room_ids,status,confirmed_at,created_by)
      SELECT rr.property_id,rr.reservation_id,ARRAY[rr.id],'confirmed',now(),rr.created_by FROM reservation_rooms rr
      JOIN rooms r ON r.id=rr.room_id WHERE r.number='105' RETURNING id`);
    await sql(`INSERT INTO stays(property_id,reservation_id,reservation_room_id,room_id,primary_guest_id,check_in_draft_id,business_date_in,expected_departure,checked_in_by)
      SELECT rr.property_id,rr.reservation_id,rr.id,rr.room_id,r.primary_guest_id,$1,rr.arrival,rr.departure,rr.created_by
      FROM reservation_rooms rr JOIN rooms rm ON rm.id=rr.room_id JOIN reservations r ON r.id=rr.reservation_id WHERE rm.number='105'`, [draft!.id]);
    expect((await available('2026-09-16','2026-09-17')).rooms.map((r:{number:string}) => r.number)).not.toContain('105');
    const refused = await post(desk, '/reservations', booking({ roomTypeId:f.type('DLX'),roomId:f.room('105'),arrival:'2026-09-16',departure:'2026-09-17' }));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ROOM_UNAVAILABLE');
  });
});
