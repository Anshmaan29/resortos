import { formatDate } from '@resortos/shared';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport } from './night-audit-pipeline';

/**
 * Step 1 (spec §35.1): arrivals nobody checked in. Each one must be resolved as a no-show, extended
 * to tomorrow, or cancelled (§15.2) — the audit will not close a date with a booking left hanging,
 * because the next morning nobody would know whether the guest turned up.
 *
 * `arrival <= businessDate`, not `=`: a booking stranded by an earlier problem still shows up here
 * rather than being silently skipped for ever.
 */
export const arrivalsNotCheckedInStep: NightAuditStep = {
  name: 'arrivals_not_checked_in',
  title: 'Arrivals not checked in',
  order: 10,
  blocking: true,
  async inspect({ q, propertyId, businessDate }: NightAuditContext): Promise<StepReport> {
    const { rows } = await q.query<{ id: string; number: string; status: string; guest_name: string; arrival: string; room_number: string | null; room_type_name: string }>(
      `SELECT res.id, res.number, res.status, trim(g.first_name || ' ' || g.last_name) AS guest_name,
              rr.arrival, rm.number AS room_number, rt.name AS room_type_name
         FROM reservation_rooms rr
         JOIN reservations res ON res.id = rr.reservation_id
         JOIN guests g ON g.id = res.primary_guest_id
         JOIN room_types rt ON rt.id = rr.room_type_id
         LEFT JOIN rooms rm ON rm.id = rr.room_id
        WHERE rr.property_id = $1 AND rr.arrival <= $2::date AND rr.status = 'reserved'
          AND res.status IN ('tentative', 'confirmed')
        ORDER BY rr.arrival, res.number`,
      [propertyId, businessDate],
    );
    return {
      ...emptyReport(),
      items: rows.map((r) => ({
        id: r.id,
        label: `${r.number} · ${r.guest_name} · ${r.room_number ?? r.room_type_name}${r.arrival < businessDate ? ` · due ${formatDate(r.arrival)}` : ''}`,
        href: `/reservations/${r.id}`,
        // A tentative booking was never confirmed, so it cannot become a no-show (§12.3's state
        // machine): there is nothing to hold the guest to. It is cancelled or moved to tomorrow.
        actions: r.status === 'tentative' ? ['extend_arrival', 'cancel'] : ['no_show', 'extend_arrival', 'cancel'],
      })),
      facts: { arrivalsUnresolved: rows.length },
    };
  },
};

/**
 * Step 2 (spec §35.1): guests whose departure date has arrived but who are still in house. Either
 * they left and nobody checked them out, or they are staying longer and the stay must say so —
 * otherwise tonight's room night is posted to a room the system thinks is empty.
 */
export const departuresNotCheckedOutStep: NightAuditStep = {
  name: 'departures_not_checked_out',
  title: 'Departures not checked out',
  order: 20,
  blocking: true,
  async inspect({ q, propertyId, businessDate }: NightAuditContext): Promise<StepReport> {
    const { rows } = await q.query<{ id: string; room_number: string; guest_name: string; expected_departure: string; reservation_number: string }>(
      `SELECT s.id, rm.number AS room_number, trim(g.first_name || ' ' || g.last_name) AS guest_name,
              s.expected_departure, res.number AS reservation_number
         FROM stays s
         JOIN rooms rm ON rm.id = s.room_id
         JOIN reservations res ON res.id = s.reservation_id
         JOIN guests g ON g.id = res.primary_guest_id
        WHERE s.property_id = $1 AND s.status = 'in_house' AND s.expected_departure <= $2::date
        ORDER BY s.expected_departure, rm.number`,
      [propertyId, businessDate],
    );
    return {
      ...emptyReport(),
      items: rows.map((r) => ({
        id: r.id,
        label: `Room ${r.room_number} · ${r.guest_name} · ${r.reservation_number} · due ${formatDate(r.expected_departure)}`,
        href: `/stays/${r.id}`,
        actions: ['check_out', 'extend_stay'],
      })),
      facts: { departuresUnresolved: rows.length },
    };
  },
};

/**
 * Step 5 (spec §35.1): room status sanity. These are warnings, never blockers — a wrong
 * housekeeping flag is worth telling the desk about, but holding the business date hostage to it
 * would teach staff to click past the audit.
 */
export const roomStatusCheckStep: NightAuditStep = {
  name: 'room_status_check',
  title: 'Room status check',
  order: 50,
  blocking: false,
  async inspect({ q, propertyId, businessDate }: NightAuditContext): Promise<StepReport> {
    const { rows } = await q.query<{ kind: string; room_number: string; detail: string | null }>(
      `-- An occupied room that is marked out of service: one of the two is wrong.
       SELECT 'occupied_out_of_service' AS kind, rm.number AS room_number, rm.service_status AS detail
         FROM stays s JOIN rooms rm ON rm.id = s.room_id
        WHERE s.property_id = $1 AND s.status = 'in_house' AND rm.service_status <> 'in_service'
       UNION ALL
       -- A room nobody is in, still marked dirty at the end of the day: housekeeping missed it.
       SELECT 'vacant_still_dirty', rm.number, NULL
         FROM rooms rm
        WHERE rm.property_id = $1 AND rm.is_active AND rm.housekeeping_status = 'dirty'
          AND NOT EXISTS (SELECT 1 FROM room_allocations a
                           WHERE a.room_id = rm.id AND a.status = 'checked_in'
                             AND a.start_date <= $2::date AND a.end_date > $2::date)
       ORDER BY 1, 2`,
      [propertyId, businessDate],
    );
    const occupied = rows.filter((r) => r.kind === 'occupied_out_of_service');
    const dirty = rows.filter((r) => r.kind === 'vacant_still_dirty');
    const warnings: string[] = [];
    for (const r of occupied) warnings.push(`Room ${r.room_number} has a guest in it but is marked ${String(r.detail).replace(/_/g, ' ')}.`);
    if (dirty.length) {
      warnings.push(`${dirty.length} empty room${dirty.length === 1 ? '' : 's'} still marked dirty: ${dirty.map((r) => r.room_number).join(', ')}.`);
    }
    return { ...emptyReport(), warnings, facts: { roomsOccupiedOutOfService: occupied.length, vacantRoomsStillDirty: dirty.length } };
  },
};

/**
 * Step 6 (spec §35.1): the closing summary. Revenue, collections by method and dues join these
 * facts when folios and payments land in 2.2 and 2.3 — as their own steps, so this one does not
 * have to grow.
 */
export const summaryStep: NightAuditStep = {
  name: 'summary',
  title: 'Summary',
  order: 90,
  blocking: false,
  async inspect({ q, propertyId, businessDate }: NightAuditContext): Promise<StepReport> {
    const { rows } = await q.query<{
      rooms_active: number; rooms_occupied: number; arrivals_checked_in: number;
      departures_completed: number; in_house_at_close: number; no_shows: number; cancellations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM rooms WHERE property_id = $1 AND is_active) AS rooms_active,
         (SELECT count(DISTINCT a.room_id)::int FROM room_allocations a
           WHERE a.property_id = $1 AND a.status = 'checked_in' AND a.start_date <= $2::date AND a.end_date > $2::date) AS rooms_occupied,
         (SELECT count(*)::int FROM stays WHERE property_id = $1 AND business_date_in = $2::date) AS arrivals_checked_in,
         (SELECT count(*)::int FROM stays WHERE property_id = $1 AND business_date_out = $2::date) AS departures_completed,
         (SELECT count(*)::int FROM stays WHERE property_id = $1 AND status = 'in_house') AS in_house_at_close,
         (SELECT count(*)::int FROM reservation_rooms WHERE property_id = $1 AND status = 'no_show' AND arrival = $2::date) AS no_shows,
         (SELECT count(*)::int FROM reservation_rooms WHERE property_id = $1 AND status = 'cancelled' AND arrival = $2::date) AS cancellations`,
      [propertyId, businessDate],
    );
    const s = rows[0]!;
    const occupancyPercent = s.rooms_active ? Math.round((s.rooms_occupied / s.rooms_active) * 1000) / 10 : 0;
    return {
      ...emptyReport(),
      willDo: `Record the summary for ${formatDate(businessDate)} and move the business date forward`,
      facts: {
        roomsActive: s.rooms_active,
        roomsOccupied: s.rooms_occupied,
        occupancyPercent,
        arrivalsCheckedIn: s.arrivals_checked_in,
        departuresCompleted: s.departures_completed,
        inHouseAtClose: s.in_house_at_close,
        noShows: s.no_shows,
        cancellations: s.cancellations,
      },
    };
  },
};

export const BUILT_IN_NIGHT_AUDIT_STEPS = [
  arrivalsNotCheckedInStep,
  departuresNotCheckedOutStep,
  roomStatusCheckStep,
  summaryStep,
];
