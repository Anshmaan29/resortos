import { assertVillaArrival } from '../villa/villa.service';
import { createHash, randomUUID } from 'node:crypto';
import { StorageService } from '../storage/storage.service';
import { assertRoomReady } from '../reservations/room-inventory';
import { Injectable } from '@nestjs/common';
import {
  checkInDraftDataSchema, ERROR_CODES, formatDate, ID_TYPES_WITH_BACK, normalizeVehicleNumber, type CheckInDraftData,
} from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { CheckInDraftRow, GuestDocumentRow, IdRow, ReservationRoomRow, ReservationRow } from '../db/rows';
import { PropertyService } from '../property/property.service';
import { ReservationsService } from '../reservations/reservations.service';
import { documentView } from './capture.service';
import { latestDocuments } from './document-slots';

export interface CheckInPolicy {
  idRequiredFor: 'all_adults' | 'primary_guest';
  requireGuestPhoto: boolean;
  requireSignature: boolean;
}
export const DEFAULT_CHECK_IN_POLICY: CheckInPolicy = { idRequiredFor: 'all_adults', requireGuestPhoto: false, requireSignature: false };

export interface CheckInProblem { path: string; message: string }

@Injectable()
export class CheckInService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly property: PropertyService,
    private readonly reservations: ReservationsService,
    private readonly storage: StorageService,
  ) {}

  async policy(q: Queryable, propertyId: string): Promise<CheckInPolicy> {
    const { rows } = await q.query<{ value: Partial<CheckInPolicy> }>(`SELECT value FROM settings WHERE property_id = $1 AND key = 'check_in_policy'`, [propertyId]);
    return { ...DEFAULT_CHECK_IN_POLICY, ...(rows[0]?.value ?? {}) };
  }

  private async view(q: Queryable, draft: CheckInDraftRow) {
    const { rows: docs } = await q.query<GuestDocumentRow>(`SELECT * FROM guest_documents WHERE draft_id = $1 ORDER BY created_at, id`, [draft.id]);
    const readiness = await this.problems(q, draft, checkInDraftDataSchema.parse(draft.data));
    const { rows: summary } = await q.query<{ number: string; arrival: string; departure: string; guest_name: string; mobile: string; is_vip: boolean; special_requests: string | null }>(
      `SELECT r.number, r.arrival, r.departure, trim(g.first_name || ' ' || g.last_name) AS guest_name, g.mobile, g.is_vip, r.special_requests
         FROM reservations r JOIN guests g ON g.id = r.primary_guest_id WHERE r.id = $1`, [draft.reservation_id],
    );
    const { rows: roomRows } = await q.query<ReservationRoomRow & { room_type_name: string; room_number: string | null }>(
      `SELECT rr.*, rt.name AS room_type_name, rm.number AS room_number FROM reservation_rooms rr
         JOIN room_types rt ON rt.id = rr.room_type_id LEFT JOIN rooms rm ON rm.id = rr.room_id
        WHERE rr.id = ANY($1::uuid[])`, [draft.reservation_room_ids],
    );
    const res = summary[0]!;
    return {
      reservation: {
        number: res.number, arrival: res.arrival, departure: res.departure, guestName: res.guest_name, mobile: res.mobile, isVip: res.is_vip,
        specialRequests: res.special_requests,
        rooms: draft.reservation_room_ids.map((id) => roomRows.find((r) => r.id === id)!).map((r) => ({
          reservationRoomId: r.id, roomTypeId: r.room_type_id, roomTypeName: r.room_type_name, roomId: r.room_id, roomNumber: r.room_number,
          adults: r.adults, childAges: r.child_ages.map(Number), mealPlan: r.meal_plan, status: r.status,
        })),
      },
      id: draft.id, reservationId: draft.reservation_id, reservationRoomIds: draft.reservation_room_ids, step: draft.step,
      data: draft.data, status: draft.status, version: draft.version, updatedAt: draft.updated_at,
      documents: latestDocuments(docs).map(documentView),
      policy: await this.policy(q, draft.property_id),
      problems: readiness,
    };
  }

  /** Starts (or resumes) the check-in for a booking. A refresh or power cut resumes the same draft. */
  async start(actor: Actor, reservationId: string, reservationRoomIds?: string[]) {
    const result = await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows: resRows } = await q.query<ReservationRow>(
        `SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`, [reservationId, actor.user.propertyId],
      );
      const res = resRows[0];
      if (!res) throw notFound('Booking');
      const { rows: existing } = await q.query<CheckInDraftRow>(`SELECT * FROM check_in_drafts WHERE reservation_id = $1 AND status = 'active'`, [reservationId]);
      if (existing[0]) return { view: await this.view(q, existing[0]), created: false as const };

      if (!['confirmed', 'checked_in'].includes(res.status)) {
        throw new AppError(ERROR_CODES.INVALID_TRANSITION, res.status === 'tentative' ? 'Confirm the booking before check-in.' : 'This booking cannot be checked in.');
      }
      const bd = await this.property.today(q, actor.user.propertyId);
      if (res.arrival > bd) throw new AppError(ERROR_CODES.INVALID_TRANSITION, `Check-in opens on the arrival day, ${formatDate(res.arrival)}.`);
      if (res.departure <= bd) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'The stay dates have already passed.');

      const { rows: rooms } = await q.query<ReservationRoomRow & { guest_first: string; guest_last: string }>(
        `SELECT rr.*, g.first_name AS guest_first, g.last_name AS guest_last FROM reservation_rooms rr
           JOIN reservations r ON r.id = rr.reservation_id JOIN guests g ON g.id = r.primary_guest_id
          WHERE rr.reservation_id = $1 AND rr.status = 'reserved' ORDER BY rr.created_at`,
        [reservationId],
      );
      const chosen = reservationRoomIds ? rooms.filter((r) => reservationRoomIds.includes(r.id)) : rooms;
      if (chosen.length === 0 || (reservationRoomIds && chosen.length !== reservationRoomIds.length)) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Choose rooms of this booking that are waiting for check-in.');
      }

      // Prefill: primary guest in the first room, blank adults/children for the rest.
      const data: CheckInDraftData = {
        rooms: chosen.map((r, i) => ({
          reservationRoomId: r.id,
          roomId: r.room_id ?? undefined,
          occupants: [
            ...Array.from({ length: r.adults }, (_, a) => ({
              key: `r${i}a${a}`, fullName: i === 0 && a === 0 ? `${r.guest_first} ${r.guest_last}`.trim() : '', isPrimary: a === 0,
              isChild: false, nationality: 'IN', idType: 'none' as const,
            })),
            ...r.child_ages.map((age, c) => ({ key: `r${i}c${c}`, fullName: '', isPrimary: false, isChild: true, age: Number(age), nationality: 'IN', idType: 'none' as const })),
          ],
          vehicles: [],
        })),
        consents: { stayAndCompliance: false, marketing: false },
      };
      const { rows } = await q.query<CheckInDraftRow>(
        `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, data, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [actor.user.propertyId, reservationId, chosen.map((r) => r.id), JSON.stringify(data), actor.user.id],
      );
      await this.audit.record(q, actor, { action: 'check_in.started', entityType: 'reservation', entityId: reservationId, after: { draftId: rows[0]!.id, rooms: chosen.length } });
      return { view: await this.view(q, rows[0]!), created: true as const, res, draft: rows[0]!, data };
    });
    if (!result.created) return result.view;
    await this.prefillReturningGuest(actor, result.res, result.draft, result.data);
    return this.get(actor, result.draft.id);
  }

  /** Reuse only the booking's identified primary guest, never somebody sharing their phone/name.
   * Each ID gets a new private object and document row: previous stays remain immutable and
   * reception can view the new draft without gaining access to historical documents.
   */
  private async prefillReturningGuest(actor: Actor, res: ReservationRow, draft: CheckInDraftRow, data: CheckInDraftData) {
    const primary = data.rooms[0]?.occupants.find(o => o.isPrimary && !o.isChild);
    if (!primary) return;
    const { rows: previous } = await this.db.query<{ stay_id: string; occupant_key: string; nationality: string; id_type: typeof primary.idType; id_last4: string | null }>(
      `SELECT s.id AS stay_id, o.occupant_key, o.nationality, o.id_type, o.id_last4
         FROM stays s JOIN stay_occupants o ON o.stay_id=s.id
         JOIN guests g ON g.id=s.primary_guest_id AND g.property_id=s.property_id
        WHERE s.property_id=$1 AND s.primary_guest_id=$2 AND o.is_primary AND NOT o.is_child
          AND lower(trim(o.full_name))=lower(trim(g.first_name || ' ' || g.last_name))
        ORDER BY s.checked_in_at DESC, s.id DESC LIMIT 1`, [actor.user.propertyId, res.primary_guest_id],
    );
    const old = previous[0];
    if (!old) return;
    primary.nationality = old.nationality;
    primary.idType = old.id_type;
    primary.idLast4 = old.id_last4 ?? undefined;
    const { rows: documents } = await this.db.query<GuestDocumentRow>(
      `SELECT * FROM guest_documents WHERE property_id=$1 AND stay_id=$2 AND occupant_key=$3
         AND doc_type IN ('id_front','id_back','id_extra') ORDER BY created_at, id`,
      [actor.user.propertyId, old.stay_id, old.occupant_key],
    );
    const copied: { id: string; storageKey: string; source: GuestDocumentRow }[] = [];
    // Storage reads/writes happen outside a database transaction: no room/booking locks held.
    for (const doc of latestDocuments(documents)) {
      if (doc.status !== 'verified' || doc.id_type !== old.id_type) continue;
      let bytes: Buffer;
      try { bytes = await this.storage.getObject(doc.storage_key); }
      catch { continue; } // Missing/expired storage: ask for a fresh ID, without blocking the draft.
      if (bytes.length !== doc.size_bytes || !createHash('sha256').update(bytes).digest().equals(doc.sha256)) continue;
      const documentId = randomUUID();
      const storageKey = `${actor.user.propertyId}/drafts/${draft.id}/${documentId}`;
      try { await this.storage.putObject(storageKey, bytes, doc.content_type, doc.sha256); }
      catch { continue; }
      copied.push({ id: documentId, storageKey, source: doc });
    }
    await this.db.tx({ userId: actor.user.id }, async q => {
      const { rows: current } = await q.query<CheckInDraftRow>(
        'SELECT * FROM check_in_drafts WHERE id=$1 AND property_id=$2 FOR UPDATE', [draft.id, actor.user.propertyId],
      );
      // Another receptionist may have started editing while the files were copied.
      if (!current[0] || current[0].status !== 'active' || current[0].version !== draft.version) return;
      const { rows: captured } = await q.query<{ id: string }>(
        `SELECT id FROM guest_documents WHERE draft_id=$1 AND occupant_key=$2 AND doc_type IN ('id_front','id_back','id_extra') LIMIT 1`,
        [draft.id, primary.key],
      );
      if (captured.length) return; // A freshly captured ID must win over reuse in a second screen.
      for (const { id: documentId, storageKey, source: doc } of copied) {
        await q.query(
          `INSERT INTO guest_documents (id, property_id, draft_id, occupant_key, doc_type, id_type, storage_key,
             content_type, size_bytes, sha256, source, uploaded_by, status, verified_at, reused_from_document_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'saved_guest_id',$11,'verified',now(),$12)`,
          [documentId, actor.user.propertyId, draft.id, primary.key, doc.doc_type, doc.id_type, storageKey,
            doc.content_type, doc.size_bytes, doc.sha256, actor.user.id, doc.id],
        );
        await this.audit.record(q, actor, { action: 'document.reused', entityType: 'guest_document', entityId: documentId,
          after: { sourceDocumentId: doc.id, draftId: draft.id } });
      }
      await q.query('UPDATE check_in_drafts SET data=$2, updated_by=$3 WHERE id=$1',
        [draft.id, JSON.stringify(data), actor.user.id]);
    });
  }

  async get(actor: Actor, draftId: string) {
    const { rows } = await this.db.query<CheckInDraftRow>(`SELECT * FROM check_in_drafts WHERE id = $1 AND property_id = $2`, [draftId, actor.user.propertyId]);
    if (!rows[0]) throw notFound('Check-in');
    return this.view(this.db, rows[0]);
  }

  /** Saves a step. Optimistic version check so two screens cannot overwrite each other silently. */
  async save(actor: Actor, draftId: string, input: { version: number; step: number; data: CheckInDraftData }) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows: current } = await q.query<CheckInDraftRow>(`SELECT * FROM check_in_drafts WHERE id = $1 AND property_id = $2 FOR UPDATE`, [draftId, actor.user.propertyId]);
      const draft = current[0];
      if (!draft) throw notFound('Check-in');
      if (draft.status !== 'active') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This check-in is already finished.');
      if (draft.version !== input.version) throw staleVersion();
      const ids = input.data.rooms.map((r) => r.reservationRoomId).sort();
      if (JSON.stringify(ids) !== JSON.stringify([...draft.reservation_room_ids].sort())) {
        throw new AppError(ERROR_CODES.VALIDATION, 'The rooms in this check-in cannot be changed. Start again to choose other rooms.');
      }
      const { rows } = await q.query<CheckInDraftRow>(
        `UPDATE check_in_drafts SET step = $2, data = $3, updated_by = $4 WHERE id = $1 RETURNING *`,
        [draftId, input.step, JSON.stringify(input.data), actor.user.id],
      );
      return this.view(q, rows[0]!);
    });
  }

  async abandon(actor: Actor, draftId: string) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<IdRow & { reservation_id: string }>(
        `UPDATE check_in_drafts SET status = 'abandoned', updated_by = $3 WHERE id = $1 AND property_id = $2 AND status = 'active' RETURNING id, reservation_id`,
        [draftId, actor.user.propertyId, actor.user.id],
      );
      if (!rows[0]) throw notFound('Check-in');
      await q.query(`UPDATE capture_sessions SET closed_at = now(), closed_reason = 'abandoned' WHERE draft_id = $1 AND closed_at IS NULL`, [draftId]);
      await this.audit.record(q, actor, { action: 'check_in.abandoned', entityType: 'reservation', entityId: rows[0].reservation_id, after: { draftId } });
    });
    return { ok: true };
  }

  /** Everything that still blocks confirmation, in plain language (spec §19.6). */
  private async problems(q: Queryable, draft: CheckInDraftRow, data: CheckInDraftData): Promise<CheckInProblem[]> {
    const policy = await this.policy(q, draft.property_id);
    const problems: CheckInProblem[] = [];
    const { rows: rooms } = await q.query<ReservationRoomRow>(`SELECT * FROM reservation_rooms WHERE id = ANY($1::uuid[])`, [draft.reservation_room_ids]);
    const { rows: docs } = await q.query<GuestDocumentRow & { reused_name: string | null; reused_last4: string | null }>(
      `SELECT d.*, o.full_name AS reused_name, o.id_last4 AS reused_last4 FROM guest_documents d
         LEFT JOIN guest_documents src ON src.id=d.reused_from_document_id
         LEFT JOIN stay_occupants o ON o.stay_id=src.stay_id AND o.occupant_key=src.occupant_key
        WHERE d.draft_id=$1 ORDER BY d.created_at, d.id`, [draft.id]);
    const today = await this.property.today(q, draft.property_id);
    const { rows: readiness } = await q.query<{ id:string; number:string; is_active:boolean; housekeeping_status:string; service_status:string; max_occupancy:number; blocked:boolean }>(
      `SELECT r.id,r.number,r.is_active,r.housekeeping_status,r.service_status,t.max_occupancy,
        (EXISTS (SELECT 1 FROM stays s WHERE s.room_id=r.id AND s.status='in_house')
         OR EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id=r.id AND o.status='active'
           AND daterange(o.start_date,o.end_date,'[)') && daterange($3::date,GREATEST($3::date+1,$4::date),'[)'))
         OR EXISTS (SELECT 1 FROM room_allocations a WHERE a.room_id=r.id AND a.status IN ('reserved','checked_in')
           AND a.reservation_room_id<>ALL($5::uuid[])
           AND daterange(a.start_date,a.end_date,'[)') && daterange($3::date,GREATEST($3::date+1,$4::date),'[)'))) AS blocked
       FROM rooms r JOIN room_types t ON t.id=r.room_type_id WHERE r.property_id=$1 AND r.id=ANY($2::uuid[])`,
      [draft.property_id,data.rooms.map((r) => r.roomId ?? rooms.find((rr) => rr.id===r.reservationRoomId)?.room_id).filter(Boolean),today,rooms[0]?.departure ?? today,draft.reservation_room_ids],
    );
    const currentDocs = latestDocuments(docs);
    const docsFor = (occupantKey: string | null, type: string) => currentDocs.filter((d) => d.doc_type === type && d.occupant_key === occupantKey);

    const requireDoc = (path: string, label: string, candidates: GuestDocumentRow[]) => {
      if (candidates.some((d) => d.status === 'verified')) return;
      if (candidates.some((d) => d.status === 'pending')) problems.push({ path, message: `${label} is still uploading` });
      else if (candidates.some((d) => d.status === 'failed')) problems.push({ path, message: `${label} failed to upload — capture it again` });
      else problems.push({ path, message: `${label} is missing` });
    };

    data.rooms.forEach((roomData, i) => {
      const rr = rooms.find((r) => r.id === roomData.reservationRoomId);
      const label = data.rooms.length > 1 ? `Room ${i + 1}: ` : '';
      if (!rr) { problems.push({ path: `rooms.${i}`, message: `${label}room is no longer part of this booking` }); return; }
      if (rr.status !== 'reserved') problems.push({ path: `rooms.${i}`, message: `${label}already checked in or cancelled` });
      if (!roomData.roomId && !rr.room_id) problems.push({ path: `rooms.${i}.roomId`, message: `${label}assign a room` });
      const chosenId = roomData.roomId ?? rr.room_id;
      const chosen = readiness.find((r) => r.id===chosenId);
      if (chosenId && (!chosen?.is_active || chosen.service_status!=='in_service' || !['clean','inspected'].includes(chosen.housekeeping_status) || chosen.blocked)) {
        problems.push({ path:`rooms.${i}.roomId`,message:`${label}room ${chosen?.number ?? ''} is not ready or no longer free; choose a ready room` });
      }
      if (chosen && rr.adults+rr.child_ages.length>chosen.max_occupancy) problems.push({ path:`rooms.${i}.roomId`,message:`${label}room ${chosen.number} allows at most ${chosen.max_occupancy} guests` });


      const adults = roomData.occupants.filter((o) => !o.isChild);
      const children = roomData.occupants.filter((o) => o.isChild);
      if (adults.length !== rr.adults || children.length !== rr.child_ages.length) {
        problems.push({ path: `rooms.${i}.occupants`, message: `${label}enter ${rr.adults} adult(s) and ${rr.child_ages.length} child(ren) to match the booking (or edit the booking)` });
      }
      if (roomData.occupants.filter((o) => o.isPrimary).length !== 1) problems.push({ path: `rooms.${i}.occupants`, message: `${label}mark one guest as the primary guest` });
      roomData.occupants.forEach((o, j) => { if (!o.fullName.trim()) problems.push({ path: `rooms.${i}.occupants.${j}.fullName`, message: `${label}enter the name of guest ${j + 1}` }); });

      const needId = policy.idRequiredFor === 'all_adults' ? adults : adults.filter((o) => o.isPrimary);
      for (const o of needId) {
        const who = o.fullName || 'guest';
        if (o.idType === 'none') { problems.push({ path: `rooms.${i}.occupants.${o.key}.idType`, message: `${label}choose the ID type for ${who}` }); continue; }
        if (!o.idLast4) problems.push({ path: `rooms.${i}.occupants.${o.key}.idLast4`, message: `${label}enter the last 4 characters of ${who}'s ID` });
        const validId = (type: string) => docsFor(o.key, type).filter(d => {
          const source = docs.find(row => row.id === d.id)!;
          return d.id_type === o.idType && (d.source !== 'saved_guest_id'
            || (source.reused_name?.trim().toLowerCase() === o.fullName.trim().toLowerCase()
              && source.reused_last4?.toUpperCase() === o.idLast4?.toUpperCase()));
        });
        requireDoc(`documents.${o.key}.id_front`, `${label}${who}'s ID (front)`, validId('id_front'));
        if (ID_TYPES_WITH_BACK.includes(o.idType)) requireDoc(`documents.${o.key}.id_back`, `${label}${who}'s ID (back)`, validId('id_back'));
      }
      const primary = roomData.occupants.find((o) => o.isPrimary);
      if (policy.requireGuestPhoto && primary) requireDoc(`documents.${primary.key}.guest_photo`, `${label}guest photo of ${primary.fullName || 'the primary guest'}`, docsFor(primary.key, 'guest_photo'));
    });

    if (policy.requireSignature) requireDoc('documents.signature', 'Guest signature', docsFor(null, 'signature'));
    if (!data.consents.stayAndCompliance) problems.push({ path: 'consents.stayAndCompliance', message: 'The guest must accept the stay and legal-compliance notice' });
    return problems;
  }

  /**
   * Confirms check-in in one transaction (spec §18.3). Returns the stays created.
   * Only VERIFIED documents count; anything still uploading blocks with a clear message.
   */
  async confirm(q: Queryable, actor: Actor, draftId: string) {
    // Booking edits also update drafts: always lock the booking before the draft.
    const { rows: resRows } = await q.query<ReservationRow>(
      `SELECT r.* FROM reservations r JOIN check_in_drafts d ON d.reservation_id=r.id
        WHERE d.id=$1 AND d.property_id=$2 AND r.property_id=$2 FOR UPDATE OF r`, [draftId, actor.user.propertyId],
    );
    if (!resRows[0]) throw notFound('Check-in');
    const { rows: dr } = await q.query<CheckInDraftRow>(`SELECT * FROM check_in_drafts WHERE id = $1 AND property_id = $2 FOR UPDATE`, [draftId, actor.user.propertyId]);
    const draft = dr[0];
    if (!draft) throw notFound('Check-in');
    if (draft.status !== 'active') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This check-in is already finished.');

    const res = resRows[0]!;
    await assertVillaArrival(q, actor.user.propertyId, res.id);
    if (!['confirmed', 'checked_in'].includes(res.status)) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This booking cannot be checked in.');
    const bd = await this.property.today(q, actor.user.propertyId);
    if (res.arrival > bd || res.departure <= bd) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Check-in is only possible between the arrival day and the day before departure.');

    const data = checkInDraftDataSchema.parse(draft.data);

    // Rooms chosen inside the check-in flow are assigned first (same validation as booking assignment).
    const { rows: rooms } = await q.query<ReservationRoomRow>(`SELECT * FROM reservation_rooms WHERE id = ANY($1::uuid[]) FOR UPDATE`, [draft.reservation_room_ids]);
    for (const roomData of data.rooms) {
      const rr = rooms.find((r) => r.id === roomData.reservationRoomId);
      if (rr && rr.status === 'reserved' && roomData.roomId && roomData.roomId !== rr.room_id) {
        await this.reservations.assignRoom(q, actor, rr.id, roomData.roomId);
      }
    }
    const problems = await this.problems(q, draft, data);
    if (problems.length) {
      throw new AppError(ERROR_CODES.VALIDATION, problems[0]!.message.replace(/^./, (c) => c.toUpperCase()), { fields: problems, problems });
    }

    const { rows: documents } = await q.query<GuestDocumentRow>(`SELECT * FROM guest_documents WHERE draft_id = $1 ORDER BY created_at, id`, [draft.id]);
    const currentDocumentIds = latestDocuments(documents).filter((d) => d.status === 'verified').map((d) => d.id);
    const stays: { id: string; roomId: string }[] = [];
    for (const roomData of data.rooms) {
      const { rows: fresh } = await q.query<ReservationRoomRow>(`SELECT * FROM reservation_rooms WHERE id = $1`, [roomData.reservationRoomId]);
      const rr = fresh[0]!;
      await assertRoomReady(q,actor.user.propertyId,rr.room_id!,bd,rr.departure,bd,rr.adults+rr.child_ages.length);
      const { rowCount } = await q.query(
        `UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id = $1 AND status = 'reserved' AND room_id = $2`, [rr.id, rr.room_id],
      );
      if (rowCount !== 1) throw new AppError(ERROR_CODES.CONFLICT, 'The room allocation changed. Reload and try again.');
      await q.query(`UPDATE reservation_rooms SET status = 'checked_in' WHERE id = $1`, [rr.id]);
      const { rows: stay } = await q.query<IdRow>(
        `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id, checked_in_by, business_date_in, expected_departure)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [actor.user.propertyId, res.id, rr.id, rr.room_id, res.primary_guest_id, draft.id, actor.user.id, bd, rr.departure],
      );
      const stayId = stay[0]!.id;
      stays.push({ id: stayId, roomId: rr.room_id! });
      for (const o of roomData.occupants) {
        await q.query(
          `INSERT INTO stay_occupants (property_id, stay_id, occupant_key, full_name, is_primary, is_child, age, relation, nationality, id_type, id_last4, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [actor.user.propertyId, stayId, o.key, o.fullName.trim(), o.isPrimary, o.isChild, o.age ?? null, o.relation ?? null, o.nationality, o.idType, o.idLast4 ?? null, actor.user.id],
        );
      }
      for (const v of roomData.vehicles) {
        await q.query(
          `INSERT INTO stay_vehicles (property_id, stay_id, registration, vehicle_type, parking_slot, non_standard, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [actor.user.propertyId, stayId, normalizeVehicleNumber(v.registration), v.vehicleType, v.parkingSlot ?? null, v.nonStandard, actor.user.id],
        );
      }
      const keys = roomData.occupants.map((o) => o.key);
      await q.query(`UPDATE guest_documents SET stay_id = $1 WHERE draft_id = $2 AND occupant_key = ANY($3::text[]) AND status = 'verified' AND stay_id IS NULL AND id = ANY($4::uuid[])`, [stayId, draft.id, keys, currentDocumentIds]);
    }
    // Draft-level documents (signature) belong to the first stay.
    await q.query(`UPDATE guest_documents SET stay_id = $1 WHERE draft_id = $2 AND occupant_key IS NULL AND status = 'verified' AND stay_id IS NULL AND id = ANY($3::uuid[])`, [stays[0]!.id, draft.id, currentDocumentIds]);

    if (res.status === 'confirmed') await q.query(`UPDATE reservations SET status = 'checked_in', updated_by = $2 WHERE id = $1`, [res.id, actor.user.id]);
    await q.query(`UPDATE check_in_drafts SET status = 'confirmed', confirmed_at = now(), updated_by = $2 WHERE id = $1`, [draft.id, actor.user.id]);
    await q.query(`UPDATE capture_sessions SET closed_at = now(), closed_reason = 'confirmed' WHERE draft_id = $1 AND closed_at IS NULL`, [draft.id]);

    await this.audit.record(q, actor, {
      action: 'stay.checked_in', entityType: 'reservation', entityId: res.id,
      after: { draftId: draft.id, stays, occupants: data.rooms.reduce((n, r) => n + r.occupants.length, 0), marketingConsent: data.consents.marketing },
    });
    for (const s of stays) await this.outbox.emit(q, actor.user.propertyId, 'stay.checked_in', { type: 'stay', id: s.id }, { reservationId: res.id });
    return { reservationId: res.id, stays };
  }
}
