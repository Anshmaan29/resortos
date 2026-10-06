import { Injectable } from '@nestjs/common';
import { normalizeIndianMobile, type GuestInput, type Role } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { notFound, staleVersion } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { GuestRow } from '../db/rows';

export const mapGuest = (r: GuestRow) => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, fullName: `${r.first_name} ${r.last_name}`.trim(),
  mobile: r.mobile, email: r.email, addressLine: r.address_line, city: r.city, state: r.state, pinCode: r.pin_code,
  country: r.country, nationality: r.nationality, companyName: r.company_name, companyGstin: r.company_gstin,
  preferredLanguage: r.preferred_language,
  preferences: r.preferences, isVip: r.is_vip, specialNote: r.special_note, version: r.version,
});

@Injectable()
export class GuestsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Search by mobile, name, booking number, OTA reference and vehicle number (spec §16). */
  async search(propertyId: string, term: string) {
    const t = term.trim();
    if (t && t.length < 2) return [];
    const mobile = normalizeIndianMobile(t);
    const digits = t.replace(/\D/g, '');
    // LIKE treats these as syntax unless escaped; a person's typed name is literal.
    const pattern = t.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { rows } = await this.db.query<GuestRow & { stays: string; last_stay: string | null }>(
      `SELECT g.*,
              (SELECT count(*) FROM reservations r WHERE r.primary_guest_id = g.id AND r.status = 'checked_out') AS stays,
              (SELECT max(r.departure) FROM reservations r WHERE r.primary_guest_id = g.id AND r.status = 'checked_out') AS last_stay
         FROM guests g
        WHERE g.property_id = $1 AND g.merged_into_id IS NULL AND (
                $4::text = ''
             OR ($2::text IS NOT NULL AND g.mobile = $2)
             OR (length($3::text) >= 4 AND g.mobile LIKE '%' || $3)
             OR lower(g.first_name || ' ' || g.last_name) LIKE '%' || lower($5::text) || '%'
             OR EXISTS (SELECT 1 FROM reservations r WHERE r.primary_guest_id=g.id AND (upper(r.number)=upper($4) OR r.ota_reference=$4))
             OR EXISTS (
                  SELECT 1 FROM stay_vehicles v JOIN stays st ON st.id = v.stay_id
                   WHERE st.primary_guest_id = g.id AND v.registration = upper(regexp_replace($4, '[^A-Za-z0-9]', '', 'g'))
                )
        )
        ORDER BY CASE WHEN g.mobile=$2 THEN 0 WHEN lower(trim(g.first_name || ' ' || g.last_name))=lower($4) THEN 1 ELSE 2 END,
                 last_stay DESC NULLS LAST, g.created_at DESC, g.id
        LIMIT 20`,
      [propertyId, mobile, digits, t, pattern],
    );
    return rows.map((r) => ({ ...mapGuest(r), stays: Number(r.stays), lastStay: r.last_stay }));
  }

  /** Warn before creating: same mobile, or same name + city (spec §16). */
  async findPossibleDuplicates(propertyId: string, input: { mobile: string; firstName: string; lastName?: string; city?: string }) {
    const { rows } = await this.db.query<GuestRow>(
      `SELECT * FROM guests WHERE property_id = $1 AND merged_into_id IS NULL AND (
          mobile = $2
          OR (lower(first_name) = lower($3) AND lower(last_name) = lower($4) AND $5::text IS NOT NULL AND lower(city) = lower($5))
        ) LIMIT 5`,
      [propertyId, input.mobile, input.firstName, input.lastName ?? '', input.city ?? null],
    );
    return rows.map((r) => ({ ...mapGuest(r), matchedOn: r.mobile === input.mobile ? 'mobile' : 'name_city' }));
  }

  /**
   * Guest profile (spec §16): who they are, every visit, what is still to come, their vehicles and
   * their documents.
   *
   * Documents are permission-controlled the same way the image itself is: a receptionist sees the
   * documents of a stay that is in house now, and the owner sees everything. The list never carries
   * the image — only a signed 60-second URL from `GET /documents/:id/view-url` does, and that logs
   * the view.
   */
  async get(propertyId: string, id: string, role: Role = 'owner') {
    const { rows } = await this.db.query<GuestRow>(`SELECT * FROM guests WHERE id = $1 AND property_id = $2`, [id, propertyId]);
    if (!rows[0]) throw notFound('Guest');

    const [history, stays, vehicles, documents] = await Promise.all([
      this.db.query<{ id: string; number: string; arrival: string; departure: string; status: string; source: string; purpose: string | null; rooms: string | null }>(
        `SELECT r.id, r.number, r.arrival, r.departure, r.status, r.source, r.purpose,
                (SELECT string_agg(DISTINCT rm.number, ', ') FROM reservation_rooms rr LEFT JOIN rooms rm ON rm.id = rr.room_id WHERE rr.reservation_id = r.id AND rr.status <> 'replaced') AS rooms
           FROM reservations r WHERE r.primary_guest_id = $1 ORDER BY r.arrival DESC LIMIT 50`,
        [id],
      ),
      this.db.query<{ id: string; room_number: string; status: string; business_date_in: string; expected_departure: string; business_date_out: string | null }>(
        `SELECT s.id, rm.number AS room_number, s.status, s.business_date_in, s.expected_departure, s.business_date_out
           FROM stays s JOIN rooms rm ON rm.id = s.room_id
          WHERE s.primary_guest_id = $1 ORDER BY s.checked_in_at DESC LIMIT 50`,
        [id],
      ),
      this.db.query<{ registration: string; vehicle_type: string; parking_slot: string | null; last_seen: Date }>(
        `SELECT v.registration, v.vehicle_type, v.parking_slot, max(v.created_at) AS last_seen
           FROM stay_vehicles v JOIN stays s ON s.id = v.stay_id
          WHERE s.primary_guest_id = $1
          GROUP BY v.registration, v.vehicle_type, v.parking_slot
          ORDER BY last_seen DESC LIMIT 20`,
        [id],
      ),
      this.db.query<{ id: string; doc_type: string; id_type: string | null; created_at: Date; stay_status: string; room_number: string }>(
        `SELECT d.id, d.doc_type, d.id_type, d.created_at, s.status AS stay_status, rm.number AS room_number
           FROM guest_documents d JOIN stays s ON s.id = d.stay_id JOIN rooms rm ON rm.id = s.room_id
          WHERE s.primary_guest_id = $1 AND d.status = 'verified'
            AND ($2::text = 'owner' OR s.status = 'in_house')
          ORDER BY d.created_at DESC LIMIT 60`,
        [id, role],
      ),
    ]);

    const businessDate = await this.db.query<{ d: string }>(
      `SELECT current_business_date AS d FROM properties WHERE id = $1`, [propertyId],
    ).then((r) => r.rows[0]!.d);

    const upcoming = history.rows.filter((h) => ['tentative', 'confirmed'].includes(h.status) && h.departure > businessDate);

    return {
      ...mapGuest(rows[0]!),
      mergedIntoId: rows[0]!.merged_into_id,
      history: history.rows.map((h) => ({ id: h.id, number: h.number, arrival: h.arrival, departure: h.departure, status: h.status, source: h.source, purpose: h.purpose, rooms: h.rooms })),
      upcoming: upcoming.map((h) => ({ id: h.id, number: h.number, arrival: h.arrival, departure: h.departure, status: h.status, rooms: h.rooms })),
      stays: stays.rows.map((v) => ({ id: v.id, roomNumber: v.room_number, status: v.status, checkedIn: v.business_date_in, dueOut: v.expected_departure, checkedOut: v.business_date_out })),
      vehicles: vehicles.rows.map((v) => ({ registration: v.registration, vehicleType: v.vehicle_type, parkingSlot: v.parking_slot })),
      documents: documents.rows.map((d) => ({ id: d.id, docType: d.doc_type, idType: d.id_type, roomNumber: d.room_number, at: d.created_at, current: d.stay_status === 'in_house' })),
      /** Older documents are owner-only (spec §19.7); the screen says so instead of showing an empty list. */
      documentsRestricted: role !== 'owner',
    };
  }


  /** Creates a guest inside an existing transaction (used by bookings and check-in). */
  async createInTx(q: Queryable, actor: Actor, input: GuestInput) {
    const { rows } = await q.query<GuestRow>(
      `INSERT INTO guests (property_id, first_name, last_name, mobile, email, address_line, city, state, pin_code, country,
                           nationality, company_name, company_gstin, preferences, created_by, preferred_language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [actor.user.propertyId, input.firstName, input.lastName, input.mobile, input.email ?? null, input.addressLine ?? null,
        input.city ?? null, input.state ?? null, input.pinCode ?? null, input.country, input.nationality, input.companyName ?? null,
        input.companyGstin ?? null, input.preferences ?? null, actor.user.id, input.preferredLanguage],
    );
    const guest = mapGuest(rows[0]!);
    // Audit stores identifiers only — not the guest's personal details.
    await this.audit.record(q, actor, { action: 'guest.created', entityType: 'guest', entityId: guest.id });
    return guest;
  }

  create(actor: Actor, input: GuestInput) {
    return this.db.tx({ userId: actor.user.id }, (q) => this.createInTx(q, actor, input));
  }

  async update(actor: Actor, id: string, input: GuestInput, expectedVersion: number) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows: before } = await q.query<GuestRow>(`SELECT * FROM guests WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId]);
      if (!before[0]) throw notFound('Guest');
      const { rows } = await q.query<GuestRow>(
        `UPDATE guests SET first_name=$4, last_name=$5, mobile=$6, email=$7, address_line=$8, city=$9, state=$10, pin_code=$11,
                country=$12, nationality=$13, company_name=$14, company_gstin=$15, preferences=$16, updated_by=$17, preferred_language=$18
          WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING *`,
        [id, actor.user.propertyId, expectedVersion, input.firstName, input.lastName, input.mobile, input.email ?? null,
          input.addressLine ?? null, input.city ?? null, input.state ?? null, input.pinCode ?? null, input.country, input.nationality,
          input.companyName ?? null, input.companyGstin ?? null, input.preferences ?? null, actor.user.id, input.preferredLanguage],
      );
      if (!rows[0]) throw staleVersion();
      const changed = Object.keys(input).filter((k) => {
        const col = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        return String((before[0] as unknown as Record<string, unknown>)[col] ?? '') !== String((input as Record<string, unknown>)[k] ?? '');
      });
      await this.audit.record(q, actor, { action: 'guest.updated', entityType: 'guest', entityId: id, after: { changedFields: changed } });
      return mapGuest(rows[0]);
    });
  }
}
