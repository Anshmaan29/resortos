import { Injectable } from '@nestjs/common';
import { normalizeIndianMobile, normalizeVehicleNumber } from '@resortos/shared';
import { DbService } from '../db/db.service';

export interface SearchHit {
  kind: 'guest' | 'booking' | 'room' | 'vehicle';
  id: string;
  href: string;
  title: string;
  subtitle: string;
  /** Lower sorts first: an exact match on what was typed beats a partial one. */
  rank: number;
}

/**
 * Global search behind Ctrl+K (spec §71): guest, mobile, room, booking, vehicle, in one box.
 *
 * The desk types whatever it has — half a phone number, a room number, a car. Each kind is asked
 * separately and cheaply rather than through one clever union, because the queries want different
 * indexes and a slow global search is a search nobody uses.
 */
@Injectable()
export class SearchService {
  constructor(private readonly db: DbService) {}

  async search(propertyId: string, term: string): Promise<SearchHit[]> {
    const t = term.trim();
    if (t.length < 2) return [];
    const mobile = normalizeIndianMobile(t);
    const digits = t.replace(/\D/g, '');
    const vehicle = normalizeVehicleNumber(t);
    const pattern = t.replace(/[\\%_]/g, (c) => `\\${c}`);

    const [guests, bookings, rooms, vehicles] = await Promise.all([
      this.db.query<{ id: string; name: string; mobile: string; city: string | null; is_vip: boolean; exact: boolean }>(
        `SELECT g.id, trim(g.first_name || ' ' || g.last_name) AS name, g.mobile, g.city, g.is_vip,
                ($2::text IS NOT NULL AND g.mobile = $2) AS exact
           FROM guests g
          WHERE g.property_id = $1 AND g.merged_into_id IS NULL
            AND (($2::text IS NOT NULL AND g.mobile = $2)
              OR (length($3::text) >= 4 AND g.mobile LIKE '%' || $3)
              OR lower(g.first_name || ' ' || g.last_name) LIKE '%' || lower($4) || '%')
          ORDER BY exact DESC, name LIMIT 6`,
        [propertyId, mobile, digits, pattern],
      ),
      this.db.query<{ id: string; number: string; name: string; arrival: string; departure: string; status: string; exact: boolean }>(
        `SELECT r.id, r.number, trim(g.first_name || ' ' || g.last_name) AS name, r.arrival, r.departure, r.status,
                upper(r.number) = upper($2) AS exact
           FROM reservations r JOIN guests g ON g.id = r.primary_guest_id
          WHERE r.property_id = $1
            AND (upper(r.number) LIKE '%' || upper($3) || '%' OR r.ota_reference = $2)
          ORDER BY exact DESC, r.arrival DESC LIMIT 6`,
        [propertyId, t, pattern],
      ),
      this.db.query<{ id: string; number: string; type_name: string; guest_name: string | null; stay_id: string | null }>(
        `SELECT rm.id, rm.number, rt.name AS type_name,
                trim(g.first_name || ' ' || g.last_name) AS guest_name, s.id AS stay_id
           FROM rooms rm
           JOIN room_types rt ON rt.id = rm.room_type_id
           LEFT JOIN stays s ON s.room_id = rm.id AND s.status = 'in_house'
           LEFT JOIN guests g ON g.id = s.primary_guest_id
          WHERE rm.property_id = $1 AND rm.is_active AND upper(rm.number) = upper($2)
          LIMIT 4`,
        [propertyId, t],
      ),
      this.db.query<{ stay_id: string; registration: string; room_number: string; guest_name: string; status: string }>(
        `SELECT s.id AS stay_id, v.registration, rm.number AS room_number,
                trim(g.first_name || ' ' || g.last_name) AS guest_name, s.status
           FROM stay_vehicles v
           JOIN stays s ON s.id = v.stay_id
           JOIN rooms rm ON rm.id = s.room_id
           JOIN guests g ON g.id = s.primary_guest_id
          WHERE v.property_id = $1 AND v.registration LIKE '%' || $2 || '%'
          ORDER BY s.status = 'in_house' DESC, s.checked_in_at DESC LIMIT 6`,
        [propertyId, vehicle],
      ),
    ]);

    return [
      ...guests.rows.map((g): SearchHit => ({
        kind: 'guest', id: g.id, href: `/guests/${g.id}`,
        title: g.name + (g.is_vip ? ' · VIP' : ''),
        subtitle: [g.mobile, g.city].filter(Boolean).join(' · '),
        rank: g.exact ? 0 : 2,
      })),
      ...bookings.rows.map((b): SearchHit => ({
        kind: 'booking', id: b.id, href: `/reservations/${b.id}`,
        title: b.number, subtitle: `${b.name} · ${b.arrival} → ${b.departure} · ${b.status.replace('_', ' ')}`,
        rank: b.exact ? 0 : 2,
      })),
      ...rooms.rows.map((r): SearchHit => ({
        kind: 'room', id: r.id, href: r.stay_id ? `/stays/${r.stay_id}` : '/rooms',
        title: `Room ${r.number}`,
        subtitle: r.guest_name ? `${r.type_name} · ${r.guest_name} in house` : `${r.type_name} · vacant`,
        rank: 1,
      })),
      ...vehicles.rows.map((v): SearchHit => ({
        kind: 'vehicle', id: v.stay_id, href: `/stays/${v.stay_id}`,
        title: v.registration,
        subtitle: `${v.guest_name} · room ${v.room_number}${v.status === 'in_house' ? ' · in house' : ''}`,
        rank: v.registration === vehicle ? 0 : 2,
      })),
    ].sort((a, b) => a.rank - b.rank).slice(0, 15);
  }
}
