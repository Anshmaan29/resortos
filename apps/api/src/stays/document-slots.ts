import type { GuestDocumentRow } from '../db/rows';

/** Retakes replace a capture slot, regardless of upload completion order or status.
 * Rows must arrive in database creation order (including its microsecond precision).
 * Generated GRC versions and miscellaneous attachments remain separate records.
 */
export function latestDocuments<T extends Pick<GuestDocumentRow, 'id' | 'occupant_key' | 'doc_type' | 'created_at'>>(documents: T[]): T[] {
  const slots = new Map<string, T>();
  const attachments: T[] = [];
  for (const document of documents) {
    if (['guest_photo', 'id_front', 'id_back', 'id_extra', 'signature'].includes(document.doc_type)) {
      slots.set(JSON.stringify([document.occupant_key, document.doc_type]), document);
    } else attachments.push(document);
  }
  return [...slots.values(), ...attachments];
}
