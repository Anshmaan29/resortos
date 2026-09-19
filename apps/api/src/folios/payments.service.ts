import { Injectable } from '@nestjs/common';
import {
  ACCOUNT_KINDS_FOR_METHOD, ERROR_CODES, formatDate, formatINR, formatReference, money, PAYMENT_METHOD_LABELS,
  toMoneyString, type DepositDecisionInput, type PaymentAccountInput, type PaymentMethod, type RecordPaymentInput,
  type ReversePaymentInput,
} from '@resortos/shared';
import { OwnerAuthorisationService } from '../auth/owner-authorisation.service';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';

interface AccountRow {
  id: string; name: string; kind: string; bank_name: string | null; account_last4: string | null;
  upi_handle: string | null; pos_terminal: string | null; opening_balance: string;
  is_active: boolean; sort_order: number; version: number;
}

interface PaymentRow {
  id: string; number: string; folio_id: string | null; reservation_id: string; guest_id: string;
  entry_type: string; method: string; payment_account_id: string | null; account_name: string | null;
  amount: string; bill_effect: string; deposit_effect: string; cash_effect: string;
  reference: string | null; note: string | null;
  business_date: string; received_at: Date; received_by_name: string;
  reverses_payment_id: string | null; reversal_reason: string | null;
  reversed_by_id: string | null; reversed_at: Date | null; reversed_reason: string | null;
}

const mapAccount = (r: AccountRow) => ({
  id: r.id, name: r.name, kind: r.kind, bankName: r.bank_name, accountLast4: r.account_last4,
  upiHandle: r.upi_handle, posTerminal: r.pos_terminal, openingBalance: r.opening_balance,
  isActive: r.is_active, sortOrder: r.sort_order, version: r.version,
});

/** "Reversed" is not a column: it is true when another row reverses this one (spec §25.4). */
const mapPayment = (r: PaymentRow) => ({
  id: r.id, number: r.number, folioId: r.folio_id, reservationId: r.reservation_id,
  entryType: r.entry_type, method: r.method, accountId: r.payment_account_id, accountName: r.account_name,
  amount: r.amount, billEffect: r.bill_effect, depositEffect: r.deposit_effect, cashEffect: r.cash_effect,
  reference: r.reference, note: r.note,
  businessDate: r.business_date, at: r.received_at, by: r.received_by_name,
  isReversal: Boolean(r.reverses_payment_id), reverses: r.reverses_payment_id, reversalReason: r.reversal_reason,
  reversed: Boolean(r.reversed_by_id), reversedAt: r.reversed_at, reversedReason: r.reversed_reason,
  status: r.reversed_by_id ? 'reversed' : 'recorded',
});

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly ownerAuth: OwnerAuthorisationService,
  ) {}

  // ---------------- accounts (owner settings, spec §25.1) ----------------

  async listAccounts(propertyId: string, includeInactive = false) {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT * FROM payment_accounts WHERE property_id = $1 AND ($2 OR is_active) ORDER BY sort_order, name`,
      [propertyId, includeInactive],
    );
    return rows.map(mapAccount);
  }

  async createAccount(q: Queryable, actor: Actor, input: PaymentAccountInput) {
    const { rows } = await q.query<AccountRow>(
      `INSERT INTO payment_accounts (property_id, name, kind, bank_name, account_last4, upi_handle, pos_terminal,
                                     opening_balance, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [actor.user.propertyId, input.name.trim(), input.kind, input.bankName ?? null, input.accountLast4 ?? null,
        input.upiHandle ?? null, input.posTerminal ?? null, input.openingBalance, input.sortOrder, actor.user.id],
    );
    const created = mapAccount(rows[0]!);
    await this.audit.record(q, actor, { action: 'payment_account.created', entityType: 'payment_account', entityId: created.id, after: created });
    return created;
  }

  async updateAccount(q: Queryable, actor: Actor, id: string, input: PaymentAccountInput, expectedVersion: number) {
    const { rows: before } = await q.query<AccountRow>(
      `SELECT * FROM payment_accounts WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId],
    );
    if (!before[0]) throw notFound('Payment account');
    // The kind is what ties an account to the methods that may use it, and old payments already
    // reference this pair. Changing it would silently re-describe money that has been banked.
    if (input.kind !== before[0].kind) {
      const { rows: used } = await q.query<{ one: number }>(`SELECT 1 AS one FROM payments WHERE payment_account_id = $1 LIMIT 1`, [id]);
      if (used[0]) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'This account already has payments against it, so what kind of account it is cannot change. Make a new account instead.',
        );
      }
    }
    const { rows } = await q.query<AccountRow>(
      `UPDATE payment_accounts SET name=$4, kind=$5, bank_name=$6, account_last4=$7, upi_handle=$8, pos_terminal=$9,
              opening_balance=$10, sort_order=$11, is_active = COALESCE($12, is_active), updated_by=$13
        WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING *`,
      [id, actor.user.propertyId, expectedVersion, input.name.trim(), input.kind, input.bankName ?? null,
        input.accountLast4 ?? null, input.upiHandle ?? null, input.posTerminal ?? null, input.openingBalance,
        input.sortOrder, input.isActive ?? null, actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    const after = mapAccount(rows[0]);
    await this.audit.record(q, actor, { action: 'payment_account.updated', entityType: 'payment_account', entityId: id, before: mapAccount(before[0]), after });
    return after;
  }

  // ---------------- payments (spec §25, §26) ----------------

  /** Everything recorded against a bill, newest last, with reversals shown against what they undo. */
  async forFolio(q: Queryable, propertyId: string, folioId: string) {
    const { rows } = await q.query<PaymentRow>(
      `SELECT p.*, a.name AS account_name, u.full_name AS received_by_name,
              r.id AS reversed_by_id, r.received_at AS reversed_at, r.reversal_reason AS reversed_reason
         FROM payment_folios pf
         JOIN payments p ON p.id = pf.payment_id
         JOIN users u ON u.id = p.received_by
         LEFT JOIN payment_accounts a ON a.id = p.payment_account_id
         LEFT JOIN payments r ON r.reverses_payment_id = p.id
        WHERE p.property_id = $1 AND pf.folio_id = $2
        ORDER BY p.received_at, p.number`,
      [propertyId, folioId],
    );
    return rows.map(mapPayment);
  }

  /** What the bill and the integrity check both mean by "paid" — recalculated, never stored. */
  async paidOnFolio(q: Queryable, folioId: string): Promise<string> {
    const { rows } = await q.query<{ paid: string }>(`SELECT folio_paid($1) AS paid`, [folioId]);
    return rows[0]!.paid;
  }

  /** The security deposit held against a bill right now (§27), recalculated from rows. */
  async depositHeld(q: Queryable, folioId: string): Promise<string> {
    const { rows } = await q.query<{ held: string }>(`SELECT folio_deposit_held($1) AS held`, [folioId]);
    return rows[0]!.held;
  }

  /**
   * The shift this person has open, if any. Every payment is tied to it when there is one, and cash
   * cannot be taken without one — cash is what gets counted at close (spec §34.2), and the database
   * refuses cash outside a shift even if this check were skipped.
   */
  private async shiftFor(q: Queryable, actor: Actor, method: PaymentMethod): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $2 AND closed_at IS NULL`,
      [actor.user.propertyId, actor.user.id],
    );
    const id = rows[0]?.id ?? null;
    if (!id && method === 'cash') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Open your shift before taking or giving back cash — cash is counted when the shift closes.', {
        action: 'open_shift',
      });
    }
    return id;
  }

  /**
   * A business date night audit has closed is history: money recorded against it would change a day
   * that has already been summarised and reported. Same rule as a charge (2.2), same override.
   */
  private async assertDateUsable(q: Queryable, actor: Actor, on: string, businessDate: string, what: string) {
    if (on > businessDate) {
      throw new AppError(ERROR_CODES.VALIDATION, `${formatDate(on)} has not happened yet.`, {
        fields: [{ path: 'businessDate', message: 'Cannot be in the future' }],
      });
    }
    const { rows } = await q.query<{ closed: boolean }>(
      `SELECT is_business_date_closed($1, $2::date) AS closed`, [actor.user.propertyId, on],
    );
    if (rows[0]!.closed) {
      throw new AppError(
        ERROR_CODES.INVALID_TRANSITION,
        `Night audit has closed ${formatDate(on)}. Record this ${what} on ${formatDate(businessDate)} instead.`,
        { fields: [{ path: 'businessDate', message: 'That day is closed' }] },
      );
    }
  }

  /** The bill a payment is being recorded against, and who it belongs to. */
  private async target(q: Queryable, propertyId: string, target: { folioId?: string; reservationId?: string }) {
    if (target.folioId) {
      const { rows } = await q.query<{ id: string; reservation_id: string; guest_id: string; status: string }>(
        `SELECT f.id, f.reservation_id, r.primary_guest_id AS guest_id, f.status
           FROM folios f JOIN reservations r ON r.id = f.reservation_id
          WHERE f.id = $1 AND f.property_id = $2 FOR UPDATE OF f`,
        [target.folioId, propertyId],
      );
      if (!rows[0]) throw notFound('Bill');
      return { folioId: rows[0].id, reservationId: rows[0].reservation_id, guestId: rows[0].guest_id, folioClosed: rows[0].status === 'closed' };
    }
    const { rows } = await q.query<{ id: string; guest_id: string; status: string }>(
      `SELECT id, primary_guest_id AS guest_id, status FROM reservations WHERE id = $1 AND property_id = $2`,
      [target.reservationId, propertyId],
    );
    if (!rows[0]) throw notFound('Booking');
    if (['cancelled', 'no_show', 'checked_out'].includes(rows[0].status)) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This booking is closed. Money for it is handled on the bill.');
    }
    // Once the guest is in house there is a bill, and an advance belongs on it.
    const { rows: folio } = await q.query<{ id: string }>(
      `SELECT f.id FROM folios f JOIN stays s ON s.id = f.stay_id
        WHERE f.reservation_id = $1 AND s.status = 'in_house' ORDER BY f.opened_at, f.id LIMIT 1`,
      [rows[0].id],
    );
    return { folioId: folio[0]?.id ?? null, reservationId: rows[0].id, guestId: rows[0].guest_id, folioClosed: false };
  }

  async record(q: Queryable, actor: Actor, target: { folioId?: string; reservationId?: string }, input: RecordPaymentInput) {
    const propertyId = actor.user.propertyId;
    const businessDate = await this.property.businessDate(q, propertyId);
    const on = input.businessDate ?? businessDate;
    await this.assertDateUsable(q, actor, on, businessDate, input.entryType === 'refund' ? 'refund' : 'payment');

    const t = await this.target(q, propertyId, target);
    // A closed bill has been invoiced. Money can still arrive against it — a guest who left owing
    // pays later — but nothing that changes what was sold, and no new deposit.
    if (t.folioClosed && !['payment', 'refund'].includes(input.entryType)) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is closed. Only a payment or refund can be recorded against it now.');
    }

    // A refund is money leaving, which a receptionist may never do alone (§4.5).
    let authorisedBy: string | null = null;
    if (input.entryType === 'refund') {
      const auth = await this.ownerAuth.require(
        q, actor,
        {
          operation: 'payment.refund',
          scope: { folioId: t.folioId, reservationId: t.reservationId, amount: input.amount, method: input.method },
          reasons: [{ action: 'refund', description: `Refund of ${formatINR(input.amount)} by ${PAYMENT_METHOD_LABELS[input.method].toLowerCase()}` }],
        },
        input.ownerAuthorisationId, { type: 'reservation', id: t.reservationId },
      );
      authorisedBy = auth?.authorisedBy ?? null;
      if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'reservation', id: t.reservationId });
    }

    const accountKind = await this.accountKind(q, propertyId, input.method, input.paymentAccountId);
    if (input.method === 'company_account') {
      if (input.entryType !== 'payment') throw new AppError(ERROR_CODES.VALIDATION, 'Only a bill can be moved to a company account.');
      authorisedBy = (await this.checkCreditLimit(q, actor, input.companyId!, input.amount, t.reservationId, input.ownerAuthorisationId)) ?? authorisedBy;
    }
    if (input.method === 'guest_credit') {
      if (input.entryType !== 'payment' && input.entryType !== 'advance') {
        throw new AppError(ERROR_CODES.VALIDATION, 'Guest credit can only be used to pay, not to refund or hold a deposit.');
      }
      await this.useGuestCredit(q, actor, t.guestId, t.reservationId, input.amount);
    }

    const shiftId = await this.shiftFor(q, actor, input.method);
    const number = await this.nextNumber(q, propertyId);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO payments (property_id, number, folio_id, reservation_id, guest_id, entry_type, method,
                             payment_account_id, account_kind, amount, reference, note, business_date,
                             received_by, cashier_shift_id, authorised_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,$16,$17) RETURNING id`,
      [propertyId, number, t.folioId, t.reservationId, t.guestId, input.entryType, input.method,
        input.paymentAccountId ?? null, accountKind, input.amount, input.reference ?? null,
        input.note ?? null, on, actor.user.id, shiftId, authorisedBy, input.companyId ?? null],
    );

    await this.audit.record(q, actor, {
      action: `payment.${input.entryType}_recorded`, entityType: 'payment', entityId: rows[0]!.id, authorisedBy,
      after: { number, amount: input.amount, method: input.method, accountId: input.paymentAccountId ?? null, businessDate: on, folioId: t.folioId, reservationId: t.reservationId },
    });
    await this.outbox.emit(q, propertyId, 'payment.recorded', { type: 'payment', id: rows[0]!.id }, { number, amount: input.amount, method: input.method, entryType: input.entryType });
    return { id: rows[0]!.id, number };
  }


  /**
   * Moving a bill to a company account (spec §32). Beyond the company's credit limit it needs the
   * owner. The company row is locked so two bills moved at once are checked one after the other.
   */
  private async checkCreditLimit(q: Queryable, actor: Actor, companyId: string, amount: string, reservationId: string, ownerAuthorisationId?: string): Promise<string | null> {
    const { rows } = await q.query<{ name: string; credit_limit: string | null; is_active: boolean }>(
      `SELECT name, credit_limit, is_active FROM companies WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [companyId, actor.user.propertyId],
    );
    const company = rows[0];
    if (!company) throw notFound('Company');
    if (!company.is_active) throw new AppError(ERROR_CODES.VALIDATION, `${company.name} is no longer an active company account.`);
    if (company.credit_limit === null) return null;
    const { rows: out } = await q.query<{ outstanding: string }>(`SELECT company_outstanding($1) AS outstanding`, [companyId]);
    const after = money(out[0]!.outstanding).plus(amount);
    if (!after.gt(company.credit_limit)) return null;
    const auth = await this.ownerAuth.require(
      q, actor,
      {
        operation: 'payment.company_over_limit',
        scope: { companyId, amount, reservationId },
        reasons: [{
          action: 'credit_limit_exceeded',
          description: `${company.name} would owe ${formatINR(toMoneyString(after))}, over its ${formatINR(company.credit_limit)} limit`,
        }],
      },
      ownerAuthorisationId, { type: 'company', id: companyId },
    );
    if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'company', id: companyId });
    return auth?.authorisedBy ?? null;
  }

  /**
   * Spend a guest's credit (from a cancellation kept as credit, §15.1). The credit ledger is
   * append-only, so using it is a negative entry; the guest row is locked so two desks cannot spend
   * the same credit twice.
   */
  private async useGuestCredit(q: Queryable, actor: Actor, guestId: string, reservationId: string, amount: string) {
    await q.query(`SELECT id FROM guests WHERE id = $1 FOR UPDATE`, [guestId]);
    const { rows } = await q.query<{ available: string }>(
      `SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS available FROM guest_credit_entries WHERE guest_id = $1`, [guestId],
    );
    if (money(rows[0]!.available).lt(amount)) {
      throw new AppError(ERROR_CODES.VALIDATION, `This guest has ${formatINR(rows[0]!.available)} of credit, which is less than ${formatINR(amount)}.`, {
        fields: [{ path: 'amount', message: 'More than the credit available' }],
      });
    }
    await q.query(
      `INSERT INTO guest_credit_entries (property_id, guest_id, reservation_id, amount, note, created_by)
       VALUES ($1,$2,$3,$4,'Used to pay a bill',$5)`,
      [actor.user.propertyId, guestId, reservationId, toMoneyString(money(amount).negated()), actor.user.id],
    );
  }

  /**
   * The security deposit decision (spec §27): some of the deposit applied to the bill, the rest given
   * back, together accounting for all of it. The two ordinary outcomes — give it all back, or apply
   * what the bill still owes and give back the rest — need nobody's permission. Any other split
   * means the resort is keeping money the bill does not explain, which is the owner's call.
   */
  async settleDeposit(q: Queryable, actor: Actor, folioId: string, input: DepositDecisionInput, balanceDue: string) {
    const propertyId = actor.user.propertyId;
    const t = await this.target(q, propertyId, { folioId });
    if (t.folioClosed) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is closed.');
    const held = money(await this.depositHeld(q, folioId));
    if (held.lte(0)) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'No security deposit is held on this bill.');
    const adjust = money(input.adjust);
    const refund = money(input.refund);
    if (!adjust.plus(refund).eq(held)) {
      throw new AppError(ERROR_CODES.VALIDATION,
        `The deposit is ${formatINR(toMoneyString(held))}. What is applied to the bill and what is given back must add up to that.`,
        { fields: [{ path: 'refund', message: 'Must add up to the deposit held' }] });
    }
    const due = money(balanceDue).isNegative() ? money(0) : money(balanceDue);
    const standard = refund.eq(held) || adjust.eq(due.gt(held) ? held : due);

    let authorisedBy: string | null = null;
    if (!standard) {
      const auth = await this.ownerAuth.require(
        q, actor,
        {
          operation: 'payment.deposit_part_refund',
          scope: { folioId, adjust: toMoneyString(adjust), refund: toMoneyString(refund) },
          reasons: [{
            action: 'deposit_part_refund',
            description: `Give back ${formatINR(toMoneyString(refund))} of a ${formatINR(toMoneyString(held))} deposit while the bill owes ${formatINR(toMoneyString(due))}`,
          }],
        },
        input.ownerAuthorisationId, { type: 'folio', id: folioId },
      );
      authorisedBy = auth?.authorisedBy ?? null;
      if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'folio', id: folioId });
    }

    const businessDate = await this.property.businessDate(q, propertyId);
    const created: string[] = [];
    if (adjust.gt(0)) {
      const number = await this.nextNumber(q, propertyId);
      await q.query(
        `INSERT INTO payments (property_id, number, folio_id, reservation_id, guest_id, entry_type, method, amount,
                               business_date, received_by, cashier_shift_id, authorised_by, note)
         VALUES ($1,$2,$3,$4,$5,'deposit_adjustment','deposit',$6,$7::date,$8,
                 (SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $8 AND closed_at IS NULL),$9,
                 'Security deposit applied to the bill')`,
        [propertyId, number, folioId, t.reservationId, t.guestId, toMoneyString(adjust), businessDate, actor.user.id, authorisedBy],
      );
      created.push(number);
    }
    if (refund.gt(0)) {
      const method = input.refundMethod!;
      const kind = await this.accountKind(q, propertyId, method, input.refundAccountId);
      const shiftId = await this.shiftFor(q, actor, method);
      const number = await this.nextNumber(q, propertyId);
      await q.query(
        `INSERT INTO payments (property_id, number, folio_id, reservation_id, guest_id, entry_type, method,
                               payment_account_id, account_kind, amount, reference, business_date, received_by,
                               cashier_shift_id, authorised_by)
         VALUES ($1,$2,$3,$4,$5,'deposit_refund',$6,$7,$8,$9,$10,$11::date,$12,$13,$14)`,
        [propertyId, number, folioId, t.reservationId, t.guestId, method, input.refundAccountId, kind,
          toMoneyString(refund), input.reference ?? null, businessDate, actor.user.id, shiftId, authorisedBy],
      );
      created.push(number);
    }

    await this.audit.record(q, actor, {
      action: 'payment.deposit_settled', entityType: 'folio', entityId: folioId, authorisedBy,
      before: { held: toMoneyString(held) },
      after: { adjusted: toMoneyString(adjust), refunded: toMoneyString(refund), entries: created },
    });
    await this.outbox.emit(q, propertyId, 'folio.changed', { type: 'folio', id: folioId }, { reason: 'deposit_settled' });
    return { entries: created };
  }

  /**
   * Reverse a payment (spec §25.4): a **new row** that points at the old one. Nothing is
   * overwritten, and the unique index on `reverses_payment_id` means it can only happen once.
   *
   * Same business date, the person who took it can reverse it. Once night audit has closed that
   * date, only the owner can — the day has been summarised and reported.
   */
  async reverse(q: Queryable, actor: Actor, paymentId: string, input: ReversePaymentInput) {
    const propertyId = actor.user.propertyId;
    const { rows } = await q.query<{
      id: string; number: string; folio_id: string | null; reservation_id: string; guest_id: string;
      entry_type: string; method: PaymentMethod; payment_account_id: string | null; account_kind: string | null;
      amount: string; business_date: string; reverses_payment_id: string | null; reversed_by: string | null;
      received_by: string; company_id: string | null;
    }>(
      `SELECT p.*, r.id AS reversed_by FROM payments p
         LEFT JOIN payments r ON r.reverses_payment_id = p.id
        WHERE p.id = $1 AND p.property_id = $2`,
      [paymentId, propertyId],
    );
    const original = rows[0];
    if (!original) throw notFound('Payment');
    if (original.reversed_by) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This payment has already been reversed.');
    if (original.reverses_payment_id) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This entry is itself a reversal. Record a new payment instead.');

    const businessDate = await this.property.businessDate(q, propertyId);
    const { rows: closed } = await q.query<{ closed: boolean }>(
      `SELECT is_business_date_closed($1, $2::date) AS closed`, [propertyId, original.business_date],
    );
    // §25.4: on the same business date a receptionist may reverse their own entry; someone else's,
    // or anything night audit has already closed, is the owner's.
    const reasons: { action: 'refund'; description: string }[] = [];
    if (closed[0]!.closed) {
      reasons.push({ action: 'refund', description: `${original.number} for ${formatINR(original.amount)} is on ${formatDate(original.business_date)}, which night audit has closed` });
    } else if (original.received_by !== actor.user.id) {
      reasons.push({ action: 'refund', description: `${original.number} for ${formatINR(original.amount)} was recorded by someone else` });
    }
    const auth = await this.ownerAuth.require(
      q, actor, { operation: 'payment.reverse', scope: { paymentId, amount: original.amount }, reasons },
      input.ownerAuthorisationId, { type: 'payment', id: paymentId },
    );
    const authorisedBy = auth?.authorisedBy ?? null;
    if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'payment', id: paymentId });

    // Undoing a use of guest credit gives the credit back, in the same append-only ledger.
    if (original.method === 'guest_credit') {
      await q.query(
        `INSERT INTO guest_credit_entries (property_id, guest_id, reservation_id, amount, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [propertyId, original.guest_id, original.reservation_id, original.amount, `Returned: ${original.number} reversed`, actor.user.id],
      );
    }

    // The reversal is recorded on today's date — the correction happens now, not in the closed past.
    const shiftId = await this.shiftFor(q, actor, original.method);
    const number = await this.nextNumber(q, propertyId);
    const { rows: created } = await q.query<{ id: string }>(
      `INSERT INTO payments (property_id, number, folio_id, reservation_id, guest_id, entry_type, method,
                             payment_account_id, account_kind, amount, reference, business_date, received_by,
                             cashier_shift_id, reverses_payment_id, reversal_reason, authorised_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [propertyId, number, original.folio_id, original.reservation_id, original.guest_id, original.entry_type,
        original.method, original.payment_account_id, original.account_kind, original.amount,
        `Reverses ${original.number}`, businessDate, actor.user.id, shiftId,
        paymentId, input.reason, authorisedBy, original.company_id],
    );

    await this.audit.record(q, actor, {
      action: 'payment.reversed', entityType: 'payment', entityId: paymentId, reason: input.reason, authorisedBy,
      before: { number: original.number, amount: original.amount, method: original.method },
      after: { reversalId: created[0]!.id, reversalNumber: number, businessDate },
    });
    await this.outbox.emit(q, propertyId, 'payment.reversed', { type: 'payment', id: created[0]!.id }, { reverses: original.number, amount: original.amount });
    return { id: created[0]!.id, number };
  }

  private async accountKind(q: Queryable, propertyId: string, method: PaymentMethod, paymentAccountId: string | undefined): Promise<string | null> {
    if (!paymentAccountId) return null;
    const { rows } = await q.query<{ kind: string; is_active: boolean }>(
      `SELECT kind, is_active FROM payment_accounts WHERE id = $1 AND property_id = $2`,
      [paymentAccountId, propertyId],
    );
    if (!rows[0]) throw notFound('Payment account');
    if (!rows[0].is_active) throw new AppError(ERROR_CODES.VALIDATION, 'That account is no longer in use. Choose another.');
    // Checked here so the desk gets a sentence rather than a constraint name; the database checks
    // it again, which is what makes it true.
    const allowed = ACCOUNT_KINDS_FOR_METHOD[method];
    if (!allowed) {
      throw new AppError(ERROR_CODES.VALIDATION, `${PAYMENT_METHOD_LABELS[method]} moves no money at the desk, so it has no account.`, {
        fields: [{ path: 'paymentAccountId', message: 'Leave empty for this method' }],
      });
    }
    if (!allowed.includes(rows[0].kind as never)) {
      throw new AppError(
        ERROR_CODES.VALIDATION,
        `${method.replace(/_/g, ' ')} money cannot be recorded against a ${rows[0].kind.replace(/_/g, ' ')} account.`,
        { fields: [{ path: 'paymentAccountId', message: 'Wrong kind of account for this method' }] },
      );
    }
    return rows[0].kind;
  }

  private async nextNumber(q: Queryable, propertyId: string): Promise<string> {
    const { rows } = await q.query<{ next_reference: string }>(`SELECT next_reference($1, 'payment')`, [propertyId]);
    return formatReference('PAY', Number(rows[0]!.next_reference));
  }

  /** Account-wise totals — the old software's Ledger Entries, recalculated from rows (§49). */
  async accountBalances(propertyId: string, range: { from?: string; to?: string } = {}) {
    const { rows } = await this.db.query<{ id: string; name: string; kind: string; opening_balance: string; received: string; entries: number }>(
      `SELECT a.id, a.name, a.kind, a.opening_balance,
              COALESCE(sum(p.cash_effect), 0) AS received,
              count(p.id)::int AS entries
         FROM payment_accounts a
         LEFT JOIN payments p ON p.payment_account_id = a.id
              AND ($2::date IS NULL OR p.business_date >= $2::date)
              AND ($3::date IS NULL OR p.business_date <= $3::date)
        WHERE a.property_id = $1
        GROUP BY a.id, a.name, a.kind, a.opening_balance, a.sort_order
        ORDER BY a.sort_order, a.name`,
      [propertyId, range.from ?? null, range.to ?? null],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, openingBalance: r.opening_balance,
      received: toMoneyString(r.received), entries: r.entries,
      balance: toMoneyString(money(r.opening_balance).plus(r.received)),
    }));
  }
}
