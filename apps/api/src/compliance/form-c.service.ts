import { Injectable } from '@nestjs/common';
import { ERROR_CODES, FORM_C_REQUIRED, formatDate, type FormCDetailsInput } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';

interface FormCRow {
  id: string; status: 'pending' | 'submitted' | 'departure_updated'; stay_id: string; occupant_id: string;
  full_name: string; nationality: string; room_number: string; arrived_at: Date; expected_departure: string;
  departed_on: string | null; version: number;
  passport_number: string | null; passport_place_of_issue: string | null; passport_issue_date: string | null; passport_expiry_date: string | null;
  visa_number: string | null; visa_type: string | null; visa_place_of_issue: string | null; visa_issue_date: string | null; visa_expiry_date: string | null;
  arrival_in_india_date: string | null; arrival_port: string | null; next_destination: string | null;
  address_in_india: string | null; contact_in_india: string | null; home_address: string | null; home_contact: string | null;
  submitted_reference: string | null; submitted_at: Date | null; submitted_by_name: string | null;
}

const DETAILS: Record<keyof FormCDetailsInput & string, string> = {
  passportNumber: 'passport_number', passportPlaceOfIssue: 'passport_place_of_issue', passportIssueDate: 'passport_issue_date',
  passportExpiryDate: 'passport_expiry_date', visaNumber: 'visa_number', visaType: 'visa_type',
  visaPlaceOfIssue: 'visa_place_of_issue', visaIssueDate: 'visa_issue_date', visaExpiryDate: 'visa_expiry_date',
  arrivalInIndiaDate: 'arrival_in_india_date', arrivalPort: 'arrival_port', nextDestination: 'next_destination',
  addressInIndia: 'address_in_india', contactInIndia: 'contact_in_india', homeAddress: 'home_address', homeContact: 'home_contact',
  version: 'version',
};

/** 24 hours from arrival (spec §58.1), in whole hours, negative once it is late. */
const hoursLeft = (arrivedAt: Date) => Math.round((arrivedAt.getTime() + 24 * 3600_000 - Date.now()) / 3600_000);

const map = (r: FormCRow) => ({
  id: r.id, status: r.status, stayId: r.stay_id, guestName: r.full_name, nationality: r.nationality,
  roomNumber: r.room_number, arrivedAt: r.arrived_at, expectedDeparture: r.expected_departure, departedOn: r.departed_on,
  hoursLeft: r.status === 'pending' ? hoursLeft(r.arrived_at) : null, version: r.version,
  details: {
    passportNumber: r.passport_number, passportPlaceOfIssue: r.passport_place_of_issue, passportIssueDate: r.passport_issue_date,
    passportExpiryDate: r.passport_expiry_date, visaNumber: r.visa_number, visaType: r.visa_type,
    visaPlaceOfIssue: r.visa_place_of_issue, visaIssueDate: r.visa_issue_date, visaExpiryDate: r.visa_expiry_date,
    arrivalInIndiaDate: r.arrival_in_india_date, arrivalPort: r.arrival_port, nextDestination: r.next_destination,
    addressInIndia: r.address_in_india, contactInIndia: r.contact_in_india, homeAddress: r.home_address, homeContact: r.home_contact,
  },
  submittedReference: r.submitted_reference, submittedAt: r.submitted_at, submittedBy: r.submitted_by_name,
  missing: FORM_C_REQUIRED.filter((field) => r[DETAILS[field] as keyof FormCRow] === null),
});

/**
 * Form C for foreign nationals (spec §58.1).
 *
 * The record is opened by the database the moment such a guest is checked in (trigger
 * `stay_occupants_form_c`), so no check-in path can forget one, and the desk sees a countdown until
 * it is submitted. ResortOS does not talk to the Bureau of Immigration — no official API is assumed:
 * it prepares the details to copy into the portal and keeps the reference number that comes back.
 *
 * The passport and visa numbers here are the only full identity numbers ResortOS stores, because the
 * official form requires them. They never go to Google, messages, logs or the AI provider, and the
 * audit entries below record *that* details changed, never what they are (CLAUDE.md rule 12).
 */
@Injectable()
export class FormCService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async list(propertyId: string, status?: 'pending' | 'submitted' | 'departure_updated') {
    const { rows } = await this.db.query<FormCRow>(
      `SELECT f.*, o.full_name, o.nationality, rm.number AS room_number, s.expected_departure, s.business_date_out AS departed_on,
              u.full_name AS submitted_by_name
         FROM form_c_records f
         JOIN stay_occupants o ON o.id = f.occupant_id
         JOIN stays s ON s.id = f.stay_id
         JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN users u ON u.id = f.submitted_by
        WHERE f.property_id = $1 AND ($2::text IS NULL OR f.status = $2)
        ORDER BY f.status = 'pending' DESC, f.arrived_at`,
      [propertyId, status ?? null],
    );
    return rows.map(map);
  }

  /** What the dashboard shows: how many are waiting, and whether any is already late (§58.1). */
  async pendingSummary(propertyId: string) {
    const { rows } = await this.db.query<{ n: string; earliest: Date | null }>(
      `SELECT count(*) AS n, min(arrived_at) AS earliest FROM form_c_records WHERE property_id = $1 AND status = 'pending'`,
      [propertyId],
    );
    const pending = Number(rows[0]!.n);
    return { pending, hoursLeft: rows[0]!.earliest ? hoursLeft(rows[0]!.earliest) : null };
  }

  async get(propertyId: string, id: string) {
    const { rows } = await this.db.query<FormCRow>(
      `SELECT f.*, o.full_name, o.nationality, rm.number AS room_number, s.expected_departure, s.business_date_out AS departed_on,
              u.full_name AS submitted_by_name
         FROM form_c_records f
         JOIN stay_occupants o ON o.id = f.occupant_id
         JOIN stays s ON s.id = f.stay_id
         JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN users u ON u.id = f.submitted_by
        WHERE f.id = $1 AND f.property_id = $2`,
      [id, propertyId],
    );
    if (!rows[0]) throw notFound('Form C record');
    const record = map(rows[0]);
    // The passport and visa pages the phone scanner captured, so the desk can read the numbers off
    // them. Only the ids: every view goes through the signed-URL endpoint and is logged (§19.7).
    const { rows: documents } = await this.db.query<{ id: string; doc_type: string }>(
      `SELECT d.id, d.doc_type FROM guest_documents d
         JOIN stay_occupants o ON o.stay_id = d.stay_id AND o.occupant_key = d.occupant_key
        WHERE o.id = $1 AND d.status = 'verified' ORDER BY d.created_at`,
      [rows[0].occupant_id],
    );
    return { ...record, documents: documents.map((d) => ({ id: d.id, docType: d.doc_type })) };
  }

  /**
   * The same read on the caller's connection: a mutation returns the row as its own transaction sees
   * it. Reading through `get()` here would open a second pool connection inside the still-open
   * transaction and answer with the pre-save row.
   */
  private async read(q: Queryable, propertyId: string, id: string) {
    const { rows } = await q.query<FormCRow>(
      `SELECT f.*, o.full_name, o.nationality, rm.number AS room_number, s.expected_departure, s.business_date_out AS departed_on,
              u.full_name AS submitted_by_name
         FROM form_c_records f
         JOIN stay_occupants o ON o.id = f.occupant_id
         JOIN stays s ON s.id = f.stay_id
         JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN users u ON u.id = f.submitted_by
        WHERE f.id = $1 AND f.property_id = $2`,
      [id, propertyId],
    );
    if (!rows[0]) throw notFound('Form C record');
    return map(rows[0]);
  }

  async saveDetails(q: Queryable, actor: Actor, id: string, input: FormCDetailsInput) {
    const { version, ...details } = input;
    const { rows: before } = await q.query<{ status: string }>(
      `SELECT status FROM form_c_records WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId],
    );
    if (!before[0]) throw notFound('Form C record');
    if (before[0].status !== 'pending') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This Form C has been submitted; its details are what was submitted.');
    const { rows } = await q.query<{ id: string }>(
      `UPDATE form_c_records
          SET passport_number=$4, passport_place_of_issue=$5, passport_issue_date=$6::date, passport_expiry_date=$7::date,
              visa_number=$8, visa_type=$9, visa_place_of_issue=$10, visa_issue_date=$11::date, visa_expiry_date=$12::date,
              arrival_in_india_date=$13::date, arrival_port=$14, next_destination=$15, address_in_india=$16,
              contact_in_india=$17, home_address=$18, home_contact=$19, updated_by=$20
        WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING id`,
      [id, actor.user.propertyId, version, details.passportNumber ?? null, details.passportPlaceOfIssue ?? null,
        details.passportIssueDate ?? null, details.passportExpiryDate ?? null, details.visaNumber ?? null, details.visaType ?? null,
        details.visaPlaceOfIssue ?? null, details.visaIssueDate ?? null, details.visaExpiryDate ?? null,
        details.arrivalInIndiaDate ?? null, details.arrivalPort ?? null, details.nextDestination ?? null,
        details.addressInIndia ?? null, details.contactInIndia ?? null, details.homeAddress ?? null, details.homeContact ?? null,
        actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    // Which fields were filled in, never their values (rule 12).
    await this.audit.record(q, actor, {
      action: 'form_c.details_saved', entityType: 'form_c_record', entityId: id,
      after: { filled: Object.entries(details).filter(([, v]) => v != null).map(([k]) => k) },
    });
    return this.read(q, actor.user.propertyId, id);
  }

  /**
   * Marked submitted once the desk has filed it on the official portal and has the reference number.
   * The database refuses this while anything the form asks for is missing (`form_c_submitted_complete`).
   */
  async submit(q: Queryable, actor: Actor, id: string, reference: string, version: number) {
    const { rows: current } = await q.query<FormCRow>(
      `SELECT f.*, o.full_name, o.nationality, rm.number AS room_number, s.expected_departure, s.business_date_out AS departed_on,
              u.full_name AS submitted_by_name
         FROM form_c_records f
         JOIN stay_occupants o ON o.id = f.occupant_id
         JOIN stays s ON s.id = f.stay_id
         JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN users u ON u.id = f.submitted_by
        WHERE f.id = $1 AND f.property_id = $2 FOR UPDATE OF f`,
      [id, actor.user.propertyId],
    );
    if (!current[0]) throw notFound('Form C record');
    if (current[0].status !== 'pending') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This Form C is already submitted.');
    const missing = map(current[0]).missing;
    if (missing.length) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Fill in everything the official form asks for before marking it submitted.', { missing });
    }
    const { rows } = await q.query<{ id: string }>(
      `UPDATE form_c_records SET status='submitted', submitted_reference=$4, submitted_at=now(), submitted_by=$5, updated_by=$5
        WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING id`,
      [id, actor.user.propertyId, version, reference, actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    await this.audit.record(q, actor, {
      action: 'form_c.submitted', entityType: 'form_c_record', entityId: id, after: { reference, occupantId: current[0].occupant_id },
    });
    return this.read(q, actor.user.propertyId, id);
  }

  /** The last step (§58.1): the guest has left and the portal has been told. */
  async markDepartureUpdated(q: Queryable, actor: Actor, id: string, version: number) {
    const { rows: current } = await q.query<{ status: string; stay_status: string }>(
      `SELECT f.status, s.status AS stay_status FROM form_c_records f JOIN stays s ON s.id = f.stay_id
        WHERE f.id = $1 AND f.property_id = $2 FOR UPDATE OF f`,
      [id, actor.user.propertyId],
    );
    if (!current[0]) throw notFound('Form C record');
    if (current[0].status !== 'submitted') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Submit the Form C before recording the departure.');
    if (current[0].stay_status !== 'checked_out') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This guest has not checked out yet.');
    const { rows } = await q.query<{ id: string }>(
      `UPDATE form_c_records SET status='departure_updated', departure_updated_at=now(), departure_updated_by=$4, updated_by=$4
        WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING id`,
      [id, actor.user.propertyId, version, actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    await this.audit.record(q, actor, { action: 'form_c.departure_updated', entityType: 'form_c_record', entityId: id });
    return this.read(q, actor.user.propertyId, id);
  }

  /**
   * The details laid out for the official portal, to copy field by field (§58.1: "no assumption of
   * an official API"). Plain text so it can be copied into a browser form or read over the phone.
   */
  async portalSummary(propertyId: string, id: string) {
    const record = await this.get(propertyId, id);
    const d = record.details;
    const lines = [
      ['Name', record.guestName], ['Nationality', record.nationality],
      ['Passport number', d.passportNumber], ['Passport place of issue', d.passportPlaceOfIssue],
      ['Passport issued', d.passportIssueDate && formatDate(d.passportIssueDate)],
      ['Passport expires', d.passportExpiryDate && formatDate(d.passportExpiryDate)],
      ['Visa number', d.visaNumber], ['Visa type', d.visaType], ['Visa place of issue', d.visaPlaceOfIssue],
      ['Visa issued', d.visaIssueDate && formatDate(d.visaIssueDate)],
      ['Visa expires', d.visaExpiryDate && formatDate(d.visaExpiryDate)],
      ['Arrived in India', d.arrivalInIndiaDate && formatDate(d.arrivalInIndiaDate)], ['Port of arrival', d.arrivalPort],
      ['Arrived at resort', formatDate(new Date(record.arrivedAt).toISOString().slice(0, 10))],
      ['Room', record.roomNumber], ['Expected departure', formatDate(record.expectedDeparture)],
      ['Next destination', d.nextDestination],
      ['Address in India', d.addressInIndia], ['Contact in India', d.contactInIndia],
      ['Address at home', d.homeAddress], ['Contact at home', d.homeContact],
    ] as const;
    return {
      id: record.id,
      missing: record.missing,
      text: lines.map(([label, value]) => `${label}: ${value ?? '—'}`).join('\n'),
    };
  }
}
