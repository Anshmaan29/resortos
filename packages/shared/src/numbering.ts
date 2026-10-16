/** GST document numbers (spec §31): unique, consecutive per series + FY, max 16 chars. */
/** INV tax invoice · BOS bill of supply · CN credit note · DN debit note · RV receipt voucher. */
export type DocumentSeries = 'INV' | 'BOS' | 'CN' | 'DN' | 'RV';

export function formatDocumentNumber(series: DocumentSeries, financialYear: string, n: number, prefix?: string): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('Document number must be a positive integer');
  if (prefix && !/^[A-Z]{2,3}$/.test(prefix)) throw new Error("Invalid document prefix");
  const out = `${prefix??series}/${financialYear}/${String(n).padStart(5, '0')}`;
  if (out.length > 16) throw new Error(`Document number exceeds 16 characters: ${out}`);
  return out;
}

/** Human booking/payment references: BK-000183, PAY-2026-000923 */
export function formatReference(prefix: string, n: number, width = 6): string {
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

