import { Injectable } from '@nestjs/common';
import type { PaymentEntryType, PaymentMethod } from '@resortos/shared';
import { ShiftsService } from '../cashier/shifts.service';
import { forbidden, notFound } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { InvoicesService } from '../folios/invoices.service';
import { renderInvoicePdf, renderReceiptPdf, renderShiftReportPdf, type Paper, type Seller } from './documents';

interface PropertyPrintRow {
  name: string; legal_name: string; address_line1: string; address_line2: string | null; city: string; pin_code: string;
  state_code: string; gstin: string | null; phone: string; email: string | null;
  invoice_terms: string | null; invoice_bank_details: string | null; print_mask_mobile: boolean; receipt_paper: Paper;
}

/** Loads what each printed document needs and renders it (spec §36). Reads only; writes nothing. */
@Injectable()
export class PrintingService {
  constructor(
    private readonly db: DbService,
    private readonly invoices: InvoicesService,
    private readonly shifts: ShiftsService,
  ) {}

  private async property(q: Queryable, propertyId: string) {
    const { rows } = await q.query<PropertyPrintRow>(
      `SELECT name, legal_name, address_line1, address_line2, city, pin_code, state_code, gstin, phone, email,
              invoice_terms, invoice_bank_details, print_mask_mobile, receipt_paper
         FROM properties WHERE id = $1`,
      [propertyId],
    );
    const p = rows[0]!;
    const seller: Seller = {
      legalName: p.legal_name, name: p.name, stateCode: p.state_code, gstin: p.gstin, phone: p.phone, email: p.email,
      address: [p.address_line1, p.address_line2, `${p.city} ${p.pin_code}`].filter(Boolean).join(', '),
    };
    return { seller, row: p };
  }

  async invoicePdf(actor: Actor, invoiceId: string): Promise<{ pdf: Buffer; filename: string }> {
    return this.invoicePdfFor(actor.user.propertyId, invoiceId, { userId: actor.user.id });
  }

  /**
   * The invoice as a PDF. `forEmail` is the copy that leaves the building (spec §40, CLAUDE.md rule
   * 12): the guest's mobile is always masked, and a private guest's home address is left off — a
   * company's billing address stays, because a B2B invoice needs it.
   */
  async invoicePdfFor(propertyId: string, invoiceId: string, opts: { userId?: string; forEmail?: boolean } = {}): Promise<{ pdf: Buffer; filename: string }> {
    return this.db.tx({ userId: opts.userId }, async (q) => {
      const i = await this.invoices.detail(q, propertyId, invoiceId);
      const { seller, row } = await this.property(q, propertyId);
      const buyer = opts.forEmail && !i.buyer.gstin ? { ...i.buyer, address: null } : i.buyer;
      // The seller block comes from the invoice, as issued — never from today's settings.
      const pdf = await renderInvoicePdf({
        seller: { ...seller, legalName: i.seller.legalName, address: i.seller.address, gstin: i.seller.gstin, stateCode: i.seller.stateCode },
        documentType: i.documentType, number: i.number, invoiceDate: i.invoiceDate, original: i.original?.number ? { number: i.original.number } : null, reason: i.reason,
        buyer, placeOfSupply: i.placeOfSupply, stay: i.stay, lines: i.lines, groups: i.groups,
        taxableTotal: i.taxableTotal, cgstTotal: i.cgstTotal, sgstTotal: i.sgstTotal, igstTotal: i.igstTotal,
        roundOff: i.roundOff, grandTotal: i.grandTotal, paid: i.paid, paidAtIssue: i.paidAtIssue,
        terms: row.invoice_terms, bankDetails: row.invoice_bank_details, maskMobile: opts.forEmail || row.print_mask_mobile,
        finalizedAt: new Date(i.finalizedAt), finalizedBy: i.finalizedBy,
      });
      return { pdf, filename: `${i.number.replace(/\//g, '-')}.pdf` };
    });
  }

  async receiptPdf(actor: Actor, paymentId: string, paper?: Paper): Promise<{ pdf: Buffer; filename: string }> {
    return this.receiptPdfFor(actor.user.propertyId, paymentId, { userId: actor.user.id, paper });
  }

  /** A payment receipt. The emailed copy is always A4 and always masks the mobile. */
  async receiptPdfFor(propertyId: string, paymentId: string, opts: { userId?: string; paper?: Paper; forEmail?: boolean } = {}): Promise<{ pdf: Buffer; filename: string }> {
    const actor = { user: { propertyId } };
    const paper = opts.forEmail ? 'a4' : opts.paper;
    return this.db.tx({ userId: opts.userId }, async (q) => {
      const { rows } = await q.query<{
        number: string; entry_type: PaymentEntryType; method: PaymentMethod; amount: string; reference: string | null; business_date: string;
        received_at: Date; received_by_name: string; account_name: string | null; guest_name: string; mobile: string;
        reservation_number: string; room_number: string | null; folio_number: string | null; reverses_number: string | null; reversal_reason: string | null;
      }>(
        `SELECT p.number, p.entry_type, p.method, p.amount, p.reference, p.business_date, p.received_at,
                u.full_name AS received_by_name, a.name AS account_name,
                trim(g.first_name || ' ' || g.last_name) AS guest_name, g.mobile, r.number AS reservation_number,
                rm.number AS room_number, f.number AS folio_number, o.number AS reverses_number, p.reversal_reason
           FROM payments p
           JOIN users u ON u.id = p.received_by
           JOIN reservations r ON r.id = p.reservation_id
           JOIN guests g ON g.id = p.guest_id
           LEFT JOIN payment_accounts a ON a.id = p.payment_account_id
           LEFT JOIN payment_folios pf ON pf.payment_id = p.id
           LEFT JOIN folios f ON f.id = pf.folio_id
           LEFT JOIN stays s ON s.id = f.stay_id
           LEFT JOIN rooms rm ON rm.id = s.room_id
           LEFT JOIN payments o ON o.id = p.reverses_payment_id
          WHERE p.id = $1 AND p.property_id = $2`,
        [paymentId, actor.user.propertyId],
      );
      const p = rows[0];
      if (!p) throw notFound('Payment');
      const { seller, row } = await this.property(q, actor.user.propertyId);
      const pdf = await renderReceiptPdf({
        seller, number: p.number, entryType: p.entry_type, method: p.method, amount: p.amount, reference: p.reference,
        businessDate: p.business_date, receivedAt: p.received_at, receivedBy: p.received_by_name, accountName: p.account_name,
        guestName: p.guest_name, guestMobile: p.mobile, reservationNumber: p.reservation_number, roomNumber: p.room_number,
        billNumber: p.folio_number, isReversal: Boolean(p.reverses_number), reverses: p.reverses_number, reason: p.reversal_reason,
        maskMobile: opts.forEmail || row.print_mask_mobile,
      }, paper ?? row.receipt_paper);
      return { pdf, filename: `${p.number}.pdf` };
    });
  }

  async shiftReportPdf(actor: Actor, shiftId: string, paper?: Paper): Promise<{ pdf: Buffer; filename: string }> {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const s = await this.shifts.detail(q, actor.user.propertyId, shiftId);
      if (actor.user.role !== 'owner' && s.openedById !== actor.user.id) throw forbidden('Only the owner can print someone else’s shift.');
      const { seller, row } = await this.property(q, actor.user.propertyId);
      const pdf = await renderShiftReportPdf({
        seller, openedBy: s.openedBy, openedAt: new Date(s.openedAt), closedAt: s.closedAt ? new Date(s.closedAt) : null, closedBy: s.closedBy,
        businessDate: s.businessDate, openingCash: s.openingCash, expectedCash: s.expectedCash, countedCash: s.countedCash,
        cashDifference: s.cashDifference, expectedCard: s.expectedCard, posBatchTotal: s.posBatchTotal, cardDifference: s.cardDifference,
        accounts: s.accounts, payments: s.payments.map((p) => ({ ...p, at: new Date(p.at) })),
        differenceReason: s.differenceReason, handoverNote: s.handoverNote,
      }, paper ?? row.receipt_paper);
      return { pdf, filename: `shift-${s.businessDate}.pdf` };
    });
  }
}
