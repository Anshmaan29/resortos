import { ERROR_CODES, formatDate } from '@resortos/shared';
import { AppError, notFound } from '../common/errors';
import { propertyToday } from '../property/property.service';
import type { PropertyRow } from '../db/rows';
import type { Queryable } from '../db/db.service';

/** Tariff profiles are retained for agreed prices, but inventory is one hotel-wide room pool. */
export async function lockRoomInventory(q: Queryable, propertyId: string) {
  return (await q.query<{ id: string; name: string }>(
    'SELECT id, name FROM room_types WHERE property_id=$1 ORDER BY id FOR UPDATE', [propertyId],
  )).rows;
}

export async function roomNights(q: Queryable, propertyId: string, arrival: string, departure: string, excludeReservationId?: string, excludeRoomLineId?: string) {
  const { rows: properties } = await q.query<Pick<PropertyRow,'data_origin'|'timezone'|'current_business_date'>>('SELECT data_origin,timezone,current_business_date FROM properties WHERE id=$1',[propertyId]);
  if (!properties[0]) throw notFound('Property');
  const today = propertyToday(properties[0]);
  const { rows } = await q.query<{ date: string; capacity: string; booked: string }>(
    `WITH nights AS (SELECT d::date AS night FROM generate_series($2::date,$3::date-1,interval '1 day') d)
     SELECT to_char(n.night,'YYYY-MM-DD') AS date,
       (SELECT count(*) FROM rooms r WHERE r.property_id=$1 AND r.is_active AND r.service_status='in_service'
         AND NOT EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id=r.id AND o.status='active'
                          AND o.start_date<=n.night AND o.end_date>n.night)) AS capacity,
       (SELECT count(*) FROM reservation_rooms rr WHERE rr.property_id=$1 AND rr.status IN ('reserved','checked_in')
         AND ($4::uuid IS NULL OR rr.reservation_id<>$4) AND ($5::uuid IS NULL OR rr.id<>$5)
         AND rr.arrival<=n.night AND (rr.departure>n.night OR (n.night=$6::date AND rr.departure<=n.night
           AND EXISTS (SELECT 1 FROM stays s WHERE s.reservation_room_id=rr.id AND s.status='in_house')))) AS booked
     FROM nights n ORDER BY n.night`, [propertyId, arrival, departure, excludeReservationId ?? null, excludeRoomLineId ?? null, today],
  );
  return rows.map((r) => ({ date: r.date, capacity: Number(r.capacity), booked: Number(r.booked), available: Math.max(0, Number(r.capacity) - Number(r.booked)) }));
}

export async function assertRoomCapacity(q: Queryable, propertyId: string, arrival: string, departure: string, requested: number, excludeRoomLineId?: string) {
  const short = (await roomNights(q, propertyId, arrival, departure, undefined, excludeRoomLineId)).filter((n) => n.booked + requested > n.capacity);
  if (short.length) throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE,
    `Not enough rooms free on ${short.map((n) => formatDate(n.date, { year: false })).join(', ')}.`, { dates: short.map((n) => n.date) });
}

/** Recheck under a room lock: a cached picker must never admit an occupied or unready room. */
export async function assertRoomReady(q: Queryable, propertyId: string, roomId: string, arrival: string, departure: string, today: string, guests: number) {
  const { rows } = await q.query<{ number: string; is_active: boolean; housekeeping_status: string; service_status: string; max_occupancy: number }>(
    `SELECT r.number,r.is_active,r.housekeeping_status,r.service_status,t.max_occupancy FROM rooms r
       JOIN room_types t ON t.id=r.room_type_id WHERE r.id=$1 AND r.property_id=$2 FOR UPDATE OF r`, [roomId, propertyId],
  );
  const room = rows[0];
  if (!room?.is_active) throw notFound('Room');
  if (room.service_status !== 'in_service' || !['clean','inspected'].includes(room.housekeeping_status)) {
    throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE, `Room ${room.number} is not ready. Choose a clean room in service.`);
  }
  if (guests > room.max_occupancy) throw new AppError(ERROR_CODES.VALIDATION, `Room ${room.number} allows at most ${room.max_occupancy} guests.`);
  const { rows: blocked } = await q.query<{ one: number }>(
    `SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id=$1 AND o.status='active'
        AND daterange(o.start_date,o.end_date,'[)') && daterange($2::date,$3::date,'[)'))
       OR ($2::date<=$4::date AND EXISTS (SELECT 1 FROM stays s WHERE s.room_id=$1 AND s.status='in_house'))`,
    [roomId, arrival, departure, today],
  );
  if (blocked.length) throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE, `Room ${room.number} is occupied or blocked for these dates. Choose another room.`);
}
