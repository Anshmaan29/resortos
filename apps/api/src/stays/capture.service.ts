import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ERROR_CODES, type DocumentUploadRequest } from '@resortos/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { CaptureSessionRow, CheckInDraftRow, GuestDocumentRow, IdRow } from '../db/rows';
import { newToken, tokenHash } from '../auth/tokens';
import { StorageService } from '../storage/storage.service';

const SESSION_MINUTES = 10;
/** How often the event stream re-checks for a change worth telling the desk about. */
const SESSION_EVENT_INTERVAL_MS = 800;

const DOC_LABELS: Record<string, string> = {
  guest_photo: 'Guest photo', id_front: 'ID front', id_back: 'ID back', id_extra: 'Extra page', signature: 'Signature', grc: 'Registration card', other: 'Document',
};

export function documentView(d: GuestDocumentRow) {
  return {
    id: d.id, docType: d.doc_type, label: DOC_LABELS[d.doc_type] ?? d.doc_type, idType: d.id_type, occupantKey: d.occupant_key,
    status: d.status, source: d.source, sizeBytes: d.size_bytes,
    createdAt: d.created_at, verifiedAt: d.verified_at, failureReason: d.failure_reason,
  };
}

/**
 * Phone as scanner (spec §19.2). Security rules:
 * - the QR carries a random token (not a guest id); only its SHA-256 is stored
 * - valid for 10 minutes and for exactly one check-in draft
 * - single use: the first phone that opens it claims it with a device secret; any other device is refused
 * - the phone can only create uploads for that draft — no endpoint returns guest data to it
 * - closed when the desk taps Done, the check-in is confirmed, a new QR is shown, or it expires
 */
@Injectable()
export class CaptureService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async activeDraft(q: Queryable, propertyId: string, draftId: string): Promise<CheckInDraftRow> {
    const { rows } = await q.query<CheckInDraftRow>(`SELECT * FROM check_in_drafts WHERE id = $1 AND property_id = $2`, [draftId, propertyId]);
    if (!rows[0]) throw notFound('Check-in');
    if (rows[0].status !== 'active') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This check-in is already finished.');
    return rows[0];
  }

  // ---------------- desk ----------------

  async createSession(actor: Actor, draftId: string) {
    const token = newToken();
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      await this.activeDraft(q, actor.user.propertyId, draftId);
      await q.query(
        `UPDATE capture_sessions SET closed_at = now(), closed_reason = 'replaced' WHERE draft_id = $1 AND closed_at IS NULL`, [draftId],
      );
      const { rows } = await q.query<{ id: string; expires_at: Date }>(
        `INSERT INTO capture_sessions (property_id, draft_id, token_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval) RETURNING id, expires_at`,
        [actor.user.propertyId, draftId, tokenHash(token), actor.user.id, String(SESSION_MINUTES)],
      );
      await this.audit.record(q, actor, { action: 'capture_session.created', entityType: 'check_in_draft', entityId: draftId, after: { sessionId: rows[0]!.id } });
      const base = this.config.PUBLIC_WEB_URL ?? this.config.WEB_ORIGIN;
      return { sessionId: rows[0]!.id, token, captureUrl: `${base}/capture/${token}`, expiresAt: rows[0]!.expires_at };
    });
  }

  async closeSession(actor: Actor, sessionId: string) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<CaptureSessionRow>(
        `UPDATE capture_sessions SET closed_at = now(), closed_reason = 'done'
          WHERE id = $1 AND property_id = $2 AND closed_at IS NULL RETURNING *`,
        [sessionId, actor.user.propertyId],
      );
      if (rows[0]) {
        await this.audit.record(q, actor, {
          action: 'capture_session.closed', entityType: 'check_in_draft', entityId: rows[0].draft_id,
          after: { sessionId, filesReceived: rows[0].files_received, claimed: !!rows[0].claimed_at },
        });
      }
    });
    return { ok: true };
  }

  async sessionStatus(actor: Actor, sessionId: string) {
    const { rows } = await this.db.query<CaptureSessionRow>(`SELECT * FROM capture_sessions WHERE id = $1 AND property_id = $2`, [sessionId, actor.user.propertyId]);
    const s = rows[0];
    if (!s) throw notFound('Scanner session');
    return {
      sessionId: s.id, draftId: s.draft_id, claimed: !!s.claimed_at, expiresAt: s.expires_at,
      open: !s.closed_at && s.expires_at > new Date(), closedReason: s.closed_reason, filesReceived: s.files_received,
      documents: await this.draftDocuments(actor.user.propertyId, s.draft_id),
    };
  }

  /**
   * Live desk updates (spec §19.2). One long-lived connection replaces the desk polling every
   * 1.5 seconds; the browser keeps its polling as the fallback the spec asks for, used when
   * EventSource is unavailable or the stream drops.
   *
   * Change detection lives here: a message is sent only when the session or its documents actually
   * differ from what this desk was last sent, so a connected desk sits quiet until a phone does
   * something. The stream ends by itself when the session closes or expires.
   *
   * This still reads the database on a timer — it moves the polling off the network, not off the
   * database. PostgreSQL LISTEN/NOTIFY is the real fix and belongs with the outbox worker, which
   * needs the same listener connection.
   */
  sessionEvents(actor: Actor, sessionId: string): Observable<{ data: unknown }> {
    return new Observable<{ data: unknown }>((subscriber) => {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let lastSent = '';

      const tick = async () => {
        if (stopped) return;
        try {
          const status = await this.sessionStatus(actor, sessionId);
          const json = JSON.stringify(status);
          if (json !== lastSent) {
            lastSent = json;
            subscriber.next({ data: status });
          }
          if (!status.open) { subscriber.complete(); return; }
        } catch (err) {
          subscriber.error(err);
          return;
        }
        timer = setTimeout(() => void tick(), SESSION_EVENT_INTERVAL_MS);
      };

      void tick();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    });
  }

  async draftDocuments(propertyId: string, draftId: string) {
    const { rows } = await this.db.query<GuestDocumentRow>(
      `SELECT * FROM guest_documents WHERE property_id = $1 AND draft_id = $2 ORDER BY created_at`, [propertyId, draftId],
    );
    return rows.map(documentView);
  }

  /** Desk webcam, file upload or signature pad. */
  async deskUploadRequest(actor: Actor, draftId: string, req: DocumentUploadRequest, source: 'desk_camera' | 'file_upload' | 'signature_pad') {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      await this.activeDraft(q, actor.user.propertyId, draftId);
      return this.createDocument(q, actor.user.propertyId, draftId, req, { source, uploadedBy: actor.user.id, sessionId: null, device: actor.device });
    });
  }

  // ---------------- phone (no login; token + device secret) ----------------

  private async sessionByToken(q: Queryable, token: string, lock = false): Promise<CaptureSessionRow> {
    const { rows } = lock
      ? await q.query<CaptureSessionRow>(`SELECT * FROM capture_sessions WHERE token_hash = $1 FOR UPDATE`, [tokenHash(token)])
      : await q.query<CaptureSessionRow>(`SELECT * FROM capture_sessions WHERE token_hash = $1`, [tokenHash(token)]);
    const s = rows[0];
    const gone = (message: string) => new AppError(ERROR_CODES.FORBIDDEN, message, { scannerClosed: true });
    if (!s) throw gone('This QR code is not valid. Ask the desk to show a new one.');
    if (s.closed_at) throw gone('This scanner session has ended. Ask the desk to show a new QR code.');
    if (s.expires_at <= new Date()) throw gone('This QR code has expired (codes last 10 minutes). Ask the desk to show a new one.');
    return s;
  }

  async claim(token: string, userAgent: string | null) {
    const secret = newToken();
    return this.db.tx({}, async (q) => {
      const s = await this.sessionByToken(q, token, true);
      if (s.device_secret_hash) {
        throw new AppError(ERROR_CODES.CONFLICT, 'This QR code was already opened on another phone. Ask the desk to show a new code.');
      }
      await q.query(
        `UPDATE capture_sessions SET device_secret_hash = $2, claimed_at = now(), claimed_user_agent = $3 WHERE id = $1`,
        [s.id, tokenHash(secret), userAgent?.slice(0, 200) ?? null],
      );
      await this.audit.recordSystem(q, s.property_id, {
        userId: s.created_by, action: 'capture_session.claimed', entityType: 'check_in_draft', entityId: s.draft_id,
        after: { sessionId: s.id, device: userAgent?.slice(0, 120) ?? null },
      });
      const occupants = await this.occupantSlots(q, s.draft_id);
      return { deviceSecret: secret, expiresAt: s.expires_at, occupants };
    });
  }

  private async phoneSession(q: Queryable, token: string, deviceSecret: string | undefined, lock = false) {
    const s = await this.sessionByToken(q, token, lock);
    if (!deviceSecret || !s.device_secret_hash || !s.device_secret_hash.equals(tokenHash(deviceSecret))) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'This phone is not connected to the scanner session. Scan the QR code again.');
    }
    return s;
  }

  async phoneUploadRequest(token: string, deviceSecret: string | undefined, req: DocumentUploadRequest, userAgent: string | null) {
    return this.db.tx({}, async (q) => {
      const s = await this.phoneSession(q, token, deviceSecret);
      if (req.docType === 'grc') throw new AppError(ERROR_CODES.FORBIDDEN, 'This document type cannot be uploaded from the phone.');
      const { rows } = await q.query<Pick<CheckInDraftRow, 'status'>>(`SELECT status FROM check_in_drafts WHERE id = $1`, [s.draft_id]);
      if (rows[0]?.status !== 'active') throw new AppError(ERROR_CODES.FORBIDDEN, 'This check-in is already finished.');
      return this.createDocument(q, s.property_id, s.draft_id, req, { source: 'phone_scanner', uploadedBy: s.created_by, sessionId: s.id, device: userAgent });
    });
  }

  /** Lets the phone page resume after a refresh: session state and this session's documents only. */
  async phoneStatus(token: string, deviceSecret: string | undefined) {
    const s = await this.phoneSession(this.db, token, deviceSecret);
    const { rows } = await this.db.query<GuestDocumentRow>(`SELECT * FROM guest_documents WHERE capture_session_id = $1 ORDER BY created_at`, [s.id]);
    return {
      expiresAt: s.expires_at,
      occupants: await this.occupantSlots(this.db, s.draft_id),
      documents: rows.map((d) => ({ id: d.id, docType: d.doc_type, idType: d.id_type, occupantKey: d.occupant_key, status: d.status, failureReason: d.failure_reason })),
    };
  }

  /** A fresh pre-signed URL for the same pending document (the previous one expired or the network dropped). */
  async phoneRefreshGrant(token: string, deviceSecret: string | undefined, documentId: string) {
    const s = await this.phoneSession(this.db, token, deviceSecret);
    return this.refreshGrant(s.property_id, documentId, { captureSessionId: s.id });
  }

  async deskRefreshGrant(actor: Actor, draftId: string, documentId: string) {
    await this.activeDraft(this.db, actor.user.propertyId, draftId);
    return this.refreshGrant(actor.user.propertyId, documentId, { draftId });
  }

  private async refreshGrant(propertyId: string, documentId: string, scope: { captureSessionId?: string; draftId?: string }) {
    const { rows } = await this.db.query<GuestDocumentRow>(`SELECT * FROM guest_documents WHERE id = $1 AND property_id = $2`, [documentId, propertyId]);
    const d = rows[0];
    if (!d || (scope.captureSessionId && d.capture_session_id !== scope.captureSessionId) || (scope.draftId && d.draft_id !== scope.draftId)) throw notFound('Document');
    if (d.status !== 'pending') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This document is already processed.', { status: d.status });
    return { documentId: d.id, upload: await this.storage.uploadGrant(d.storage_key, d.content_type, d.size_bytes, d.sha256.toString('hex')) };
  }

  private async occupantSlots(q: Queryable, draftId: string) {
    const draft = await q.query<Pick<CheckInDraftRow, 'data'>>(`SELECT data FROM check_in_drafts WHERE id = $1`, [draftId]);
    // Only neutral slot labels go to the phone — never names, mobile numbers, room or booking details.
    const data = (draft.rows[0]?.data ?? {}) as { rooms?: { occupants?: { key: string; isChild?: boolean; isPrimary?: boolean; idType?: string }[] }[] };
    let adult = 0;
    let child = 0;
    return (data.rooms ?? []).flatMap((r) => r.occupants ?? []).map((o) => ({
      key: o.key, label: o.isChild ? `Child ${++child}` : `Guest ${++adult}`, isChild: !!o.isChild, isPrimary: !!o.isPrimary,
      idType: o.idType && o.idType !== 'none' ? o.idType : null,
    }));
  }

  async phoneConfirm(token: string, deviceSecret: string | undefined, documentId: string) {
    const s = await this.phoneSession(this.db, token, deviceSecret);
    const doc = await this.verifyDocument(s.property_id, documentId, { captureSessionId: s.id });
    return { id: doc.id, status: doc.status, failureReason: doc.failureReason };
  }

  // ---------------- shared ----------------

  private async createDocument(q: Queryable, propertyId: string, draftId: string, req: DocumentUploadRequest,
    by: { source: string; uploadedBy: string; sessionId: string | null; device: string | null }) {
    const key = this.storage.newKey(propertyId);
    const { rows } = await q.query<IdRow>(
      `INSERT INTO guest_documents (property_id, draft_id, occupant_key, doc_type, id_type, storage_key, content_type, size_bytes, sha256,
                                    source, capture_session_id, uploaded_by, device, client_upload_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (draft_id, client_upload_id) WHERE client_upload_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [propertyId, draftId, req.occupantKey ?? null, req.docType, req.idType ?? null, key, req.contentType, req.sizeBytes,
        Buffer.from(req.sha256, 'hex'), by.source, by.sessionId, by.uploadedBy, by.device?.slice(0, 120) ?? null, req.clientUploadId ?? null],
    );
    if (rows[0]) return { documentId: rows[0].id, upload: await this.storage.uploadGrant(key, req.contentType, req.sizeBytes, req.sha256) };

    // Retry of an upload the server already knows: same document, same declared bytes.
    const { rows: existing } = await q.query<GuestDocumentRow>(
      `SELECT * FROM guest_documents WHERE draft_id = $1 AND client_upload_id = $2`, [draftId, req.clientUploadId],
    );
    const d = existing[0]!;
    if (d.sha256.toString('hex') !== req.sha256 || d.size_bytes !== req.sizeBytes || d.doc_type !== req.docType || (by.sessionId && d.capture_session_id !== by.sessionId)) {
      throw new AppError(ERROR_CODES.IDEMPOTENCY_MISMATCH, 'This upload id was already used for a different photo.');
    }
    if (d.status !== 'pending') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This document is already processed.', { status: d.status, documentId: d.id });
    return { documentId: d.id, upload: await this.storage.uploadGrant(d.storage_key, d.content_type, d.size_bytes, req.sha256) };
  }

  /**
   * PENDING → VERIFIED only when the server has re-read the stored bytes and they match the declared
   * size and SHA-256 (spec §19.5). A mismatch marks the document FAILED; the device uploads a new one.
   */
  async verifyDocument(propertyId: string, documentId: string, scope: { captureSessionId?: string; draftId?: string }) {
    const { rows } = await this.db.query<GuestDocumentRow>(
      `SELECT * FROM guest_documents WHERE id = $1 AND property_id = $2`, [documentId, propertyId],
    );
    const d = rows[0];
    if (!d || (scope.captureSessionId && d.capture_session_id !== scope.captureSessionId) || (scope.draftId && d.draft_id !== scope.draftId)) {
      throw notFound('Document');
    }
    if (d.status !== 'pending') return documentView(d);

    const result = await this.storage.verify(d.storage_key, d.size_bytes, d.sha256);
    if (!result.ok && result.reason === 'not_received') {
      throw new AppError(ERROR_CODES.CONFLICT, 'The file has not arrived yet. Keep the app open — it will retry.', { retryable: true });
    }
    return this.db.tx({ userId: d.uploaded_by ?? undefined }, async (q) => {
      const { rows: upd } = await q.query<GuestDocumentRow>(
        result.ok
          ? `UPDATE guest_documents SET status = 'verified', verified_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`
          : `UPDATE guest_documents SET status = 'failed', failure_reason = $2 WHERE id = $1 AND status = 'pending' RETURNING *`,
        result.ok ? [d.id] : [d.id, result.reason],
      );
      const updated = upd[0];
      if (!updated) {
        const { rows: again } = await q.query<GuestDocumentRow>(`SELECT * FROM guest_documents WHERE id = $1`, [d.id]);
        return documentView(again[0]!);
      }
      if (result.ok && d.capture_session_id) {
        await q.query(`UPDATE capture_sessions SET files_received = files_received + 1 WHERE id = $1 AND closed_at IS NULL`, [d.capture_session_id]);
      }
      await this.audit.recordSystem(q, propertyId, {
        userId: d.uploaded_by, action: result.ok ? 'document.verified' : 'document.verification_failed', entityType: 'guest_document', entityId: d.id,
        after: { docType: d.doc_type, source: d.source, sizeBytes: d.size_bytes }, reason: result.ok ? null : result.reason ?? null,
      });
      return documentView(updated);
    });
  }

  /** Signed 60-second view URL; every view is logged (spec §19.7). */
  async viewUrl(actor: Actor, documentId: string, download = false) {
    const { rows } = await this.db.query<GuestDocumentRow & { stay_status: string | null; draft_status: string | null }>(
      `SELECT d.*, s.status AS stay_status, dr.status AS draft_status
         FROM guest_documents d LEFT JOIN stays s ON s.id = d.stay_id LEFT JOIN check_in_drafts dr ON dr.id = d.draft_id
        WHERE d.id = $1 AND d.property_id = $2`,
      [documentId, actor.user.propertyId],
    );
    const d = rows[0];
    if (!d || d.status !== 'verified') throw notFound('Document');
    const current = d.stay_status === 'in_house' || (d.stay_id === null && d.draft_status === 'active');
    if (actor.user.role !== 'owner' && !current) throw new AppError(ERROR_CODES.FORBIDDEN, 'Documents of past stays can only be viewed by the owner.');
    await this.db.query(
      `INSERT INTO document_access_log (property_id, document_id, user_id, purpose) VALUES ($1,$2,$3,$4)`, [actor.user.propertyId, d.id, actor.user.id, download ? 'download' : 'view'],
    );
    return this.storage.viewUrl(d.storage_key, d.content_type, download ? `document-${d.id}.${({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' } as Record<string, string>)[d.content_type] ?? 'bin'}` : undefined);
  }
}
