import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ERROR_CODES, formatReference, nightsBetween, type IdType, type MealPlanCode } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { GrcDocumentRow, GuestDocumentRow, PropertyRow, StayRow } from '../db/rows';
import { StorageService } from '../storage/storage.service';
import { renderGrcPdf, SIGNATURE_CONTENT_TYPES, type GrcOccupant, type SignatureMethod } from './grc-pdf';

/** Privacy notice shown at check-in and printed on the card. Bump the version when the text changes. */
export const PRIVACY_NOTICE_VERSION = '2026-09-a';

export interface GrcContent {
  houseRules: { en: string[]; hi: string[] };
  notice: { version: string; en: string; hi: string };
}

/** Owner setting `grc_content` overrides this; the defaults keep a new property legally presentable. */
export const DEFAULT_GRC_CONTENT: GrcContent = {
  houseRules: {
    en: [
      '1. Checkout is by the time shown above. A later departure may be charged.',
      '2. Every adult guest must present a valid photo ID at check-in; foreign nationals must present passport and visa.',
      '3. Visitors are not allowed in rooms without reception’s knowledge.',
      '4. Please keep valuables safe; the resort is not responsible for cash or jewellery left in rooms.',
      '5. Damage to resort property will be charged to the bill.',
      '6. Smoking is not allowed inside rooms. Illegal substances and firearms are prohibited.',
      '7. Quiet hours are from 10:00 PM to 7:00 AM.',
    ],
    hi: [
      '1. चेक-आउट ऊपर दिए गए समय तक करना है। देर से जाने पर शुल्क लग सकता है।',
      '2. प्रत्येक वयस्क अतिथि को चेक-इन पर वैध फोटो पहचान पत्र देना आवश्यक है; विदेशी नागरिकों को पासपोर्ट और वीज़ा दिखाना होगा।',
      '3. रिसेप्शन की जानकारी के बिना कमरों में आने वाले मेहमानों की अनुमति नहीं है।',
      '4. कृपया कीमती सामान सुरक्षित रखें; कमरे में छोड़े गए नकद या आभूषण के लिए रिज़ॉर्ट ज़िम्मेदार नहीं है।',
      '5. रिज़ॉर्ट की संपत्ति को नुकसान होने पर शुल्क बिल में जोड़ा जाएगा।',
      '6. कमरों के अंदर धूम्रपान वर्जित है। अवैध पदार्थ और हथियार पूर्णतः प्रतिबंधित हैं।',
      '7. रात 10:00 से सुबह 7:00 बजे तक शांति बनाए रखें।',
    ],
  },
  notice: {
    version: PRIVACY_NOTICE_VERSION,
    en: 'We collect your name, contact details, address, ID details and stay details to provide your stay, '
      + 'to raise your bill and to meet legal requirements such as the guest register, GST records and reporting of '
      + 'foreign guests. ID images are stored securely, are visible only to authorised staff, and are deleted after the '
      + 'retention period set by the resort. We do not sell your data. You may ask to see, correct or erase your personal '
      + 'data, except records the law requires us to keep. Marketing messages are sent only if you agree separately below.',
    hi: 'हम आपका नाम, संपर्क विवरण, पता, पहचान विवरण और ठहरने का विवरण आपके ठहरने की व्यवस्था, बिल बनाने और अतिथि रजिस्टर, '
      + 'जीएसटी अभिलेख तथा विदेशी अतिथियों की सूचना जैसी कानूनी आवश्यकताओं को पूरा करने के लिए एकत्र करते हैं। पहचान पत्र की '
      + 'छवियाँ सुरक्षित रूप से रखी जाती हैं, केवल अधिकृत कर्मचारी ही देख सकते हैं, और रिज़ॉर्ट द्वारा निर्धारित अवधि के बाद हटा दी जाती हैं। '
      + 'हम आपका डेटा नहीं बेचते। आप अपना व्यक्तिगत डेटा देखने, सुधारने या मिटाने का अनुरोध कर सकते हैं, सिवाय उन अभिलेखों के जिन्हें '
      + 'कानून के अनुसार रखना आवश्यक है। विपणन संदेश केवल तभी भेजे जाते हैं जब आप नीचे अलग से सहमति दें।',
  },
};

/** The signature's capture source decides the method recorded on the card (spec §20). */
const SIGNATURE_METHOD_BY_SOURCE: Record<string, SignatureMethod> = {
  signature_pad: 'touchscreen',
  phone_scanner: 'phone',
  file_upload: 'paper_scan',
  desk_camera: 'paper_scan',
};

export function grcView(row: GrcDocumentRow) {
  return {
    id: row.id, number: row.number, version: row.version, supersedesId: row.supersedes_id,
    sizeBytes: row.size_bytes, sha256: row.sha256.toString('hex'),
    signatureMethod: row.signature_method, signedAt: row.signed_at, noticeVersion: row.notice_version,
    generatedAt: row.generated_at, reason: row.reason,
  };
}

/**
 * Guest registration cards (spec §20).
 *
 * Order of operations, and why: the signature must already be VERIFIED, then the PDF is rendered,
 * stored under a fresh key, and **re-read from storage and re-hashed** before the `grc_documents`
 * row is written. A stay therefore never has a card row pointing at bytes nobody checked — the same
 * rule guest documents follow (spec §19.5).
 *
 * The storage round trip runs inside the transaction on purpose. It is one low-frequency operation
 * per check-in, and keeping it inside means a storage failure leaves no row and no gap in the GRC
 * number: `next_reference` rolls back with everything else. The opposite ordering could leave a
 * recorded card whose file was never confirmed, which is the failure that actually matters.
 */
@Injectable()
export class GrcService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
  ) {}

  async content(q: Queryable, propertyId: string): Promise<GrcContent> {
    const { rows } = await q.query<{ value: Partial<GrcContent> }>(
      `SELECT value FROM settings WHERE property_id = $1 AND key = 'grc_content'`, [propertyId],
    );
    const configured = rows[0]?.value;
    return {
      houseRules: configured?.houseRules ?? DEFAULT_GRC_CONTENT.houseRules,
      notice: configured?.notice ?? DEFAULT_GRC_CONTENT.notice,
    };
  }

  /** All versions of a stay's card, newest first. */
  async list(actor: Actor, stayId: string) {
    const { rows } = await this.db.query<GrcDocumentRow>(
      `SELECT g.* FROM grc_documents g JOIN stays s ON s.id = g.stay_id
        WHERE g.stay_id = $1 AND g.property_id = $2 ORDER BY g.version DESC`,
      [stayId, actor.user.propertyId],
    );
    return { stayId, current: rows[0] ? grcView(rows[0]) : null, versions: rows.map(grcView) };
  }

  /**
   * Returns the stay's current card, generating version 1 the first time.
   * A reprint is this call: it returns the stored card and never creates a version.
   */
  async ensure(q: Queryable, actor: Actor, stayId: string) {
    const stay = await this.lockStay(q, actor, stayId);
    const current = await this.currentCard(q, stayId);
    if (current) return { grc: grcView(current), created: false };
    const row = await this.generate(q, actor, stay, null, null);
    return { grc: grcView(row), created: true };
  }

  /** A new version of the card, linked to the one it replaces. The old version and its file stay. */
  async regenerate(q: Queryable, actor: Actor, stayId: string, reason: string) {
    const stay = await this.lockStay(q, actor, stayId);
    const current = await this.currentCard(q, stayId);
    if (!current) {
      const row = await this.generate(q, actor, stay, null, null);
      return { grc: grcView(row), created: true };
    }
    const row = await this.generate(q, actor, stay, current, reason);
    return { grc: grcView(row), created: true };
  }

  private async lockStay(q: Queryable, actor: Actor, stayId: string): Promise<StayRow> {
    const { rows } = await q.query<StayRow>(`SELECT * FROM stays WHERE id = $1 AND property_id = $2 FOR UPDATE`, [stayId, actor.user.propertyId]);
    if (!rows[0]) throw notFound('Stay');
    return rows[0];
  }

  private async currentCard(q: Queryable, stayId: string): Promise<GrcDocumentRow | undefined> {
    const { rows } = await q.query<GrcDocumentRow>(`SELECT * FROM grc_documents WHERE stay_id = $1 ORDER BY version DESC LIMIT 1`, [stayId]);
    return rows[0];
  }

  private async generate(q: Queryable, actor: Actor, stay: StayRow, supersedes: GrcDocumentRow | null, reason: string | null): Promise<GrcDocumentRow> {
    const propertyId = actor.user.propertyId;

    const { rows: propertyRows } = await q.query<PropertyRow>(`SELECT * FROM properties WHERE id = $1`, [propertyId]);
    const property = propertyRows[0]!;

    const { rows: detail } = await q.query<{
      reservation_number: string; arrival: string; departure: string; meal_plan: MealPlanCode; nightly_rate: string;
      room_number: string; room_type_name: string; guest_first: string; guest_last: string; guest_mobile: string;
      guest_address: string | null; guest_city: string | null; guest_state: string | null; guest_pin: string | null; guest_country: string;
      consents: { stayAndCompliance?: boolean; marketing?: boolean } | null;
    }>(
      `SELECT r.number AS reservation_number, rr.arrival, rr.departure, rr.meal_plan, rr.nightly_rate,
              rm.number AS room_number, rt.name AS room_type_name,
              g.first_name AS guest_first, g.last_name AS guest_last, g.mobile AS guest_mobile,
              g.address_line AS guest_address, g.city AS guest_city, g.state AS guest_state, g.pin_code AS guest_pin, g.country AS guest_country,
              d.data -> 'consents' AS consents
         FROM stays s
         JOIN reservations r ON r.id = s.reservation_id
         JOIN reservation_rooms rr ON rr.id = s.reservation_room_id
         JOIN rooms rm ON rm.id = s.room_id
         JOIN room_types rt ON rt.id = rm.room_type_id
         JOIN guests g ON g.id = s.primary_guest_id
         JOIN check_in_drafts d ON d.id = s.check_in_draft_id
        WHERE s.id = $1`,
      [stay.id],
    );
    const stayDetail = detail[0]!;

    const { rows: occupants } = await q.query<{
      full_name: string; is_primary: boolean; is_child: boolean; age: number | null; relation: string | null;
      nationality: string; id_type: IdType; id_last4: string | null;
    }>(
      `SELECT full_name, is_primary, is_child, age, relation, nationality, id_type, id_last4
         FROM stay_occupants WHERE stay_id = $1 ORDER BY is_primary DESC, is_child, created_at`,
      [stay.id],
    );

    const { rows: vehicles } = await q.query<{ registration: string; vehicle_type: string; parking_slot: string | null }>(
      `SELECT registration, vehicle_type, parking_slot FROM stay_vehicles WHERE stay_id = $1 ORDER BY created_at`, [stay.id],
    );

    // The signature must already be verified — the card cannot be produced from an unchecked file.
    const { rows: signatures } = await q.query<GuestDocumentRow>(
      `SELECT * FROM guest_documents
        WHERE stay_id = $1 AND doc_type = 'signature' AND status = 'verified'
        ORDER BY verified_at DESC LIMIT 1`,
      [stay.id],
    );
    const signature = signatures[0];
    if (!signature) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Collect the guest’s signature before printing the registration card.');
    }
    if (!(SIGNATURE_CONTENT_TYPES as readonly string[]).includes(signature.content_type)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'The signature image cannot be printed. Capture the signature again.');
    }
    const signatureImage = await this.storage.getObject(signature.storage_key);

    const content = await this.content(q, propertyId);
    const version = supersedes ? supersedes.version + 1 : 1;
    const number = supersedes ? supersedes.number : await this.nextNumber(q, propertyId);
    const generatedAt = new Date();
    const primary = occupants.find((o) => o.is_primary);

    const pdf = await renderGrcPdf({
      number,
      version,
      property: {
        name: property.name,
        legalName: property.legal_name,
        addressLines: [property.address_line1, property.address_line2, `${property.city} ${property.pin_code}`].filter((l): l is string => !!l),
        gstin: property.gstin,
        phone: property.phone,
        email: property.email,
        checkOutTime: property.check_out_time,
        timezone: property.timezone,
      },
      stay: {
        reservationNumber: stayDetail.reservation_number,
        roomNumber: stayDetail.room_number,
        roomTypeName: stayDetail.room_type_name,
        mealPlan: stayDetail.meal_plan,
        nightlyRate: stayDetail.nightly_rate,
        arrival: stayDetail.arrival,
        departure: stayDetail.departure,
        nights: nightsBetween(stayDetail.arrival, stayDetail.departure),
        checkedInAt: stay.checked_in_at,
      },
      guest: {
        name: `${stayDetail.guest_first} ${stayDetail.guest_last}`.trim(),
        mobile: stayDetail.guest_mobile,
        addressLines: [stayDetail.guest_address, [stayDetail.guest_city, stayDetail.guest_state, stayDetail.guest_pin].filter(Boolean).join(' '), stayDetail.guest_country]
          .filter((l): l is string => !!l && l.trim().length > 0),
      },
      occupants: occupants.map((o): GrcOccupant => ({
        fullName: o.full_name, isChild: o.is_child, age: o.age, relation: o.relation,
        nationality: o.nationality, idType: o.id_type, idLast4: o.id_last4,
      })),
      vehicles: vehicles.map((v) => ({ registration: v.registration, vehicleType: v.vehicle_type, parkingSlot: v.parking_slot })),
      consents: {
        stayAndCompliance: !!stayDetail.consents?.stayAndCompliance,
        marketing: !!stayDetail.consents?.marketing,
      },
      houseRules: content.houseRules,
      notice: content.notice,
      signature: {
        image: signatureImage,
        contentType: signature.content_type,
        method: SIGNATURE_METHOD_BY_SOURCE[signature.source] ?? 'paper_scan',
        signedAt: signature.verified_at!,
        signedBy: primary?.full_name ?? `${stayDetail.guest_first} ${stayDetail.guest_last}`.trim(),
      },
      generatedAt,
      generatedBy: actor.user.fullName,
    });

    const sha256 = createHash('sha256').update(pdf).digest();
    const storageKey = `${this.storage.newKey(propertyId)}.pdf`;
    await this.storage.putObject(storageKey, pdf, 'application/pdf', sha256);

    // Not "stored" until the server has read the bytes back and re-hashed them.
    const check = await this.storage.verify(storageKey, pdf.length, sha256);
    if (!check.ok) {
      throw new AppError(ERROR_CODES.CONFLICT, 'The registration card could not be stored safely. Please try again.', { reason: check.reason });
    }

    const { rows: inserted } = await q.query<GrcDocumentRow>(
      `INSERT INTO grc_documents
         (property_id, stay_id, number, version, supersedes_id, storage_key, size_bytes, sha256,
          signature_method, signature_document_id, signed_at, notice_version, generated_at, generated_by, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [propertyId, stay.id, number, version, supersedes?.id ?? null, storageKey, pdf.length, sha256,
        SIGNATURE_METHOD_BY_SOURCE[signature.source] ?? 'paper_scan', signature.id, signature.verified_at,
        content.notice.version, generatedAt, actor.user.id, reason],
    );
    const row = inserted[0]!;

    await this.audit.record(q, actor, {
      action: version === 1 ? 'grc.generated' : 'grc.regenerated',
      entityType: 'stay',
      entityId: stay.id,
      reason,
      after: {
        grcId: row.id, number, version, sha256: sha256.toString('hex'), sizeBytes: pdf.length,
        signatureMethod: row.signature_method, noticeVersion: row.notice_version, supersedesId: supersedes?.id ?? null,
      },
    });
    await this.outbox.emit(q, propertyId, 'grc.generated', { type: 'stay', id: stay.id }, { grcId: row.id, version });
    return row;
  }

  private async nextNumber(q: Queryable, propertyId: string): Promise<string> {
    const { rows } = await q.query<{ n: string }>(`SELECT next_reference($1, 'grc') AS n`, [propertyId]);
    return formatReference('GRC', Number(rows[0]!.n));
  }

  /** Signed 60-second view URL for printing or re-sending; every view is logged (spec §19.7). */
  async viewUrl(actor: Actor, grcId: string) {
    const { rows } = await this.db.query<GrcDocumentRow & { stay_status: string }>(
      `SELECT g.*, s.status AS stay_status FROM grc_documents g JOIN stays s ON s.id = g.stay_id
        WHERE g.id = $1 AND g.property_id = $2`,
      [grcId, actor.user.propertyId],
    );
    const row = rows[0];
    if (!row) throw notFound('Registration card');
    if (actor.user.role !== 'owner' && row.stay_status !== 'in_house') {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Registration cards of past stays can only be opened by the owner.');
    }
    await this.db.query(
      `INSERT INTO document_access_log (property_id, grc_document_id, user_id, purpose) VALUES ($1,$2,$3,'view')`,
      [actor.user.propertyId, row.id, actor.user.id],
    );
    return { ...await this.storage.viewUrl(row.storage_key, row.content_type), number: row.number, version: row.version };
  }
}
