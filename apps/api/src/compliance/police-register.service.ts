import { Injectable } from '@nestjs/common';
import { formatDate, formatMobile, POLICE_REGISTER_LABELS, type PoliceRegisterColumn } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import type { Actor } from '../common/request-context';
import { DbService } from '../db/db.service';

interface RegisterRow {
  occupant_id: string; full_name: string; age: number | null; nationality: string; id_type: string; id_last4: string | null;
  room_number: string; arrived_at: Date; expected_departure: string; departed_on: string | null; persons: string;
  purpose: string | null; vehicle: string | null; address: string | null; mobile: string | null; is_primary: boolean;
}

/**
 * The police / guest register (spec §58.2): one row per occupant for a date range, in whatever
 * columns the local police station wants (`properties.police_register_columns`).
 *
 * Nothing is stored for this: every column is read from the stay records, so the register can never
 * disagree with the check-ins it is made of. Every export is audit-logged, here and in the exports
 * service that turns these rows into a file.
 */
@Injectable()
export class PoliceRegisterService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async rows(propertyId: string, from: string, to: string) {
    const { rows: settings } = await this.db.query<{ police_register_columns: string[]; name: string }>(
      `SELECT police_register_columns, name FROM properties WHERE id = $1`, [propertyId],
    );
    const columns = (settings[0]?.police_register_columns ?? []) as PoliceRegisterColumn[];
    const { rows } = await this.db.query<RegisterRow>(
      `SELECT o.id AS occupant_id, o.full_name, o.age, o.nationality, o.id_type, o.id_last4, o.is_primary,
              rm.number AS room_number, s.checked_in_at AS arrived_at, s.expected_departure, s.business_date_out AS departed_on,
              (SELECT count(*) FROM stay_occupants x WHERE x.stay_id = s.id) AS persons,
              res.purpose,
              (SELECT string_agg(v.registration, ', ') FROM stay_vehicles v WHERE v.stay_id = s.id) AS vehicle,
              nullif(concat_ws(', ', g.address_line, g.city, g.state), '') AS address,
              g.mobile
         FROM stay_occupants o
         JOIN stays s ON s.id = o.stay_id
         JOIN rooms rm ON rm.id = s.room_id
         JOIN reservations res ON res.id = s.reservation_id
         JOIN guests g ON g.id = res.primary_guest_id
        WHERE o.property_id = $1 AND s.business_date_in BETWEEN $2::date AND $3::date
        ORDER BY s.checked_in_at, rm.number, o.is_primary DESC, o.full_name`,
      [propertyId, from, to],
    );

    const cell = (r: RegisterRow, column: PoliceRegisterColumn, index: number): string => {
      switch (column) {
        case 'serial': return String(index + 1);
        case 'arrival': return formatDate(r.arrived_at.toISOString().slice(0, 10));
        case 'name': return r.full_name;
        case 'age': return r.age === null ? '' : String(r.age);
        case 'nationality': return r.nationality;
        // The guest profile's address, which is the booking's address; occupants share it.
        case 'address': return r.is_primary ? r.address ?? '' : '';
        case 'mobile': return r.is_primary && r.mobile ? formatMobile(r.mobile) : '';
        case 'id_type': return r.id_type === 'none' ? '' : r.id_type.replace(/_/g, ' ');
        case 'id_last4': return r.id_last4 ?? '';
        case 'room': return r.room_number;
        case 'persons': return r.is_primary ? String(r.persons) : '';
        case 'purpose': return r.purpose ?? '';
        case 'vehicle': return r.is_primary ? r.vehicle ?? '' : '';
        case 'departure': return formatDate(r.departed_on ?? r.expected_departure);
        // Left blank on purpose: the station's book is signed on paper.
        case 'signature': return '';
      }
    };

    return {
      propertyName: settings[0]?.name ?? '',
      from,
      to,
      columns: columns.map((c) => ({ key: c, label: POLICE_REGISTER_LABELS[c] })),
      rows: rows.map((r, i) => columns.map((c) => cell(r, c, i))),
    };
  }

  /** Every export of the register is recorded: who, when, which dates, how many rows (§58.2, §46). */
  async recordExport(actor: Actor, from: string, to: string, rowCount: number, format: string) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      await this.audit.record(q, actor, {
        action: 'police_register.exported', entityType: 'property', entityId: actor.user.propertyId,
        after: { from, to, rowCount, format },
      });
    });
  }
}
