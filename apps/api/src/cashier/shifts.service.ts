import { Injectable } from '@nestjs/common';
import { ERROR_CODES, formatINR, money, toMoneyString, type CloseShiftInput, type OpenShiftInput } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, forbidden, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, gather, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';

interface ShiftRow {
  id: string; property_id: string; business_date: string; opened_at: Date; opened_by: string; opened_by_name: string;
  opening_cash: string; closed_at: Date | null; closed_by: string | null; closed_by_name: string | null;
  counted_cash: string | null; pos_batch_total: string | null; expected_cash: string | null; expected_card: string | null;
  difference_reason: string | null; handover_note: string | null; version: number;
}

interface AccountTotalRow { account_id: string; name: string; kind: string; amount: string; entries: number }

/**
 * Cashier shifts (spec §34). A shift is opened with the cash in the drawer, every payment taken
 * while it is open belongs to it (the database refuses cash outside one), and it is closed with
 * what was actually counted against what the rows say should be there.
 *
 * Nothing about the expected amounts is typed in: they are summed from `account_ledger`, the same
 * rows the account-wise ledger shows, so the shift and the ledger cannot disagree.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async load(q: Queryable, propertyId: string, id: string, lock = false): Promise<ShiftRow> {
    const { rows } = await q.query<ShiftRow>(
      lock
        ? `SELECT s.*, o.full_name AS opened_by_name, c.full_name AS closed_by_name
             FROM cashier_shifts s JOIN users o ON o.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by
            WHERE s.id = $1 AND s.property_id = $2 FOR UPDATE OF s`
        : `SELECT s.*, o.full_name AS opened_by_name, c.full_name AS closed_by_name
             FROM cashier_shifts s JOIN users o ON o.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by
            WHERE s.id = $1 AND s.property_id = $2`,
      [id, propertyId],
    );
    if (!rows[0]) throw notFound('Shift');
    return rows[0];
  }

  /** Per-account totals of everything recorded in a shift, from the ledger rows. */
  private async totals(q: Queryable, shiftId: string): Promise<AccountTotalRow[]> {
    const { rows } = await q.query<AccountTotalRow>(
      `SELECT a.id AS account_id, a.name, a.kind, COALESCE(sum(l.amount), 0)::numeric(14,2) AS amount, count(*)::int AS entries
         FROM account_ledger l JOIN payment_accounts a ON a.id = l.account_id
        WHERE l.cashier_shift_id = $1
        GROUP BY a.id, a.name, a.kind, a.sort_order
        ORDER BY a.sort_order, a.name`,
      [shiftId],
    );
    return rows;
  }

  /** What the drawer and the card machine should show, recalculated from rows. */
  private expected(shift: ShiftRow, totals: AccountTotalRow[]) {
    const cashIn = totals.filter((t) => t.kind === 'cash').reduce((sum, t) => sum.plus(t.amount), money(0));
    const card = totals.filter((t) => t.kind === 'card_pos').reduce((sum, t) => sum.plus(t.amount), money(0));
    return { cash: money(shift.opening_cash).plus(cashIn), card };
  }

  async detail(q: Queryable, propertyId: string, id: string) {
    const shift = await this.load(q, propertyId, id);
    const [totals, payments, threshold] = await gather(q, [
      () => this.totals(q, id),
      () => q.query<{ id: string; number: string; entry_type: string; method: string; amount: string; cash_effect: string; account_name: string | null; reference: string | null; received_at: Date; reverses_payment_id: string | null }>(
        `SELECT p.id, p.number, p.entry_type, p.method, p.amount, p.cash_effect, a.name AS account_name, p.reference,
                p.received_at, p.reverses_payment_id
           FROM payments p LEFT JOIN payment_accounts a ON a.id = p.payment_account_id
          WHERE p.cashier_shift_id = $1 ORDER BY p.received_at, p.number`,
        [id],
      ),
      () => this.threshold(q, propertyId),
    ]);
    const live = this.expected(shift, totals);
    // A closed shift is judged against what it was closed against; the integrity check compares the
    // two and reports if they ever differ.
    const expectedCash = shift.expected_cash ? money(shift.expected_cash) : live.cash;
    const expectedCard = shift.expected_card ? money(shift.expected_card) : live.card;
    return {
      id: shift.id, businessDate: shift.business_date, status: shift.closed_at ? 'closed' : 'open',
      openedAt: shift.opened_at, openedBy: shift.opened_by_name, openedById: shift.opened_by,
      openingCash: shift.opening_cash,
      closedAt: shift.closed_at, closedBy: shift.closed_by_name,
      accounts: totals.map((t) => ({ id: t.account_id, name: t.name, kind: t.kind, amount: toMoneyString(t.amount), entries: t.entries })),
      expectedCash: toMoneyString(expectedCash),
      expectedCard: toMoneyString(expectedCard),
      countedCash: shift.counted_cash,
      posBatchTotal: shift.pos_batch_total,
      cashDifference: shift.counted_cash ? toMoneyString(money(shift.counted_cash).minus(expectedCash)) : null,
      cardDifference: shift.pos_batch_total ? toMoneyString(money(shift.pos_batch_total).minus(expectedCard)) : null,
      differenceReason: shift.difference_reason,
      handoverNote: shift.handover_note,
      cashDifferenceThreshold: threshold,
      payments: payments.rows.map((p) => ({
        id: p.id, number: p.number, entryType: p.entry_type, method: p.method, amount: p.amount,
        cashEffect: p.cash_effect, accountName: p.account_name, reference: p.reference, at: p.received_at,
        isReversal: Boolean(p.reverses_payment_id),
      })),
      version: shift.version,
    };
  }

  private async threshold(q: Queryable, propertyId: string): Promise<string> {
    const { rows } = await q.query<{ t: string }>(`SELECT cash_difference_threshold AS t FROM properties WHERE id = $1`, [propertyId]);
    return rows[0]!.t;
  }

  /** The shift this person has open, and what the last one closed with (a hint for the opening count). */
  async current(actor: Actor) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $2 AND closed_at IS NULL`,
        [actor.user.propertyId, actor.user.id],
      );
      const { rows: last } = await q.query<{ counted_cash: string; closed_at: Date; closed_by_name: string; handover_note: string | null }>(
        `SELECT s.counted_cash, s.closed_at, u.full_name AS closed_by_name, s.handover_note
           FROM cashier_shifts s JOIN users u ON u.id = s.closed_by
          WHERE s.property_id = $1 AND s.closed_at IS NOT NULL ORDER BY s.closed_at DESC LIMIT 1`,
        [actor.user.propertyId],
      );
      return {
        shift: rows[0] ? await this.detail(q, actor.user.propertyId, rows[0].id) : null,
        lastClosed: last[0]
          ? { countedCash: last[0].counted_cash, closedAt: last[0].closed_at, closedBy: last[0].closed_by_name, handoverNote: last[0].handover_note }
          : null,
      };
    });
  }

  async list(propertyId: string, range: { from?: string; to?: string; status?: 'open' | 'closed' }) {
    const { rows } = await this.db.query<ShiftRow>(
      `SELECT s.*, o.full_name AS opened_by_name, c.full_name AS closed_by_name
         FROM cashier_shifts s JOIN users o ON o.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by
        WHERE s.property_id = $1
          AND ($2::date IS NULL OR s.business_date >= $2::date)
          AND ($3::date IS NULL OR s.business_date <= $3::date)
          AND ($4::text IS NULL OR ($4 = 'open') = (s.closed_at IS NULL))
        ORDER BY s.opened_at DESC LIMIT 200`,
      [propertyId, range.from ?? null, range.to ?? null, range.status ?? null],
    );
    return rows.map((s) => ({
      id: s.id, businessDate: s.business_date, status: s.closed_at ? 'closed' : 'open',
      openedAt: s.opened_at, openedBy: s.opened_by_name, closedAt: s.closed_at, closedBy: s.closed_by_name,
      openingCash: s.opening_cash, countedCash: s.counted_cash, expectedCash: s.expected_cash,
      cashDifference: s.counted_cash && s.expected_cash ? toMoneyString(money(s.counted_cash).minus(s.expected_cash)) : null,
      differenceReason: s.difference_reason,
    }));
  }

  async open(q: Queryable, actor: Actor, input: OpenShiftInput) {
    const businessDate = await this.property.businessDate(q, actor.user.propertyId);
    const { rows: existing } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $2 AND closed_at IS NULL`,
      [actor.user.propertyId, actor.user.id],
    );
    if (existing[0]) throw new AppError(ERROR_CODES.CONFLICT, 'You already have a shift open. Close it before opening another.');
    // The partial unique index `cashier_shifts_one_open_per_user` is what makes this true when two
    // tabs open a shift at the same moment; the check above only gives the common case a sentence.
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO cashier_shifts (property_id, business_date, opened_by, opening_cash) VALUES ($1,$2::date,$3,$4) RETURNING id`,
      [actor.user.propertyId, businessDate, actor.user.id, input.openingCash],
    );
    await this.audit.record(q, actor, {
      action: 'cashier_shift.opened', entityType: 'cashier_shift', entityId: rows[0]!.id,
      after: { openingCash: input.openingCash, businessDate },
    });
    return this.detail(q, actor.user.propertyId, rows[0]!.id);
  }

  /**
   * Close a shift (spec §34.3). The shift row is locked first, and payments take a share lock on it
   * as they are inserted, so a payment either lands before the totals are summed or is refused as
   * "shift closed" — never counted in neither.
   */
  async close(q: Queryable, actor: Actor, id: string, input: CloseShiftInput) {
    const shift = await this.load(q, actor.user.propertyId, id, true);
    if (shift.closed_at) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This shift is already closed.');
    if (shift.opened_by !== actor.user.id && actor.user.role !== 'owner') {
      throw forbidden('Only the person who opened this shift, or the owner, can close it.');
    }
    if (shift.version !== input.version) throw staleVersion();

    const totals = await this.totals(q, id);
    const expected = this.expected(shift, totals);
    const threshold = money(await this.threshold(q, actor.user.propertyId));
    const cashDiff = money(input.countedCash).minus(expected.cash);
    const cardDiff = input.posBatchTotal !== undefined ? money(input.posBatchTotal).minus(expected.card) : money(0);

    const problems: string[] = [];
    if (cashDiff.abs().gt(threshold)) problems.push(`Cash is ${cashDiff.isNegative() ? 'short' : 'over'} by ${formatINR(toMoneyString(cashDiff.abs()))}`);
    if (!cardDiff.isZero()) problems.push(`The card machine slip differs by ${formatINR(toMoneyString(cardDiff.abs()))}`);
    if (problems.length && !input.differenceReason) {
      throw new AppError(ERROR_CODES.VALIDATION, `${problems.join('. ')}. Say why before closing.`, {
        fields: [{ path: 'differenceReason', message: 'A reason is needed for this difference' }],
        expectedCash: toMoneyString(expected.cash), expectedCard: toMoneyString(expected.card),
      });
    }

    const { rows } = await q.query<{ id: string }>(
      `UPDATE cashier_shifts SET closed_at = now(), closed_by = $2, counted_cash = $3, pos_batch_total = $4,
              expected_cash = $5, expected_card = $6, difference_reason = $7, handover_note = $8
        WHERE id = $1 AND version = $9 RETURNING id`,
      [id, actor.user.id, input.countedCash, input.posBatchTotal ?? null, toMoneyString(expected.cash),
        toMoneyString(expected.card), input.differenceReason ?? null, input.handoverNote ?? null, input.version],
    );
    if (!rows[0]) throw staleVersion();

    await this.audit.record(q, actor, {
      action: 'cashier_shift.closed', entityType: 'cashier_shift', entityId: id, reason: input.differenceReason ?? null,
      after: {
        countedCash: input.countedCash, expectedCash: toMoneyString(expected.cash), cashDifference: toMoneyString(cashDiff),
        posBatchTotal: input.posBatchTotal ?? null, expectedCard: toMoneyString(expected.card),
      },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'cashier_shift.closed', { type: 'cashier_shift', id }, {
      cashDifference: toMoneyString(cashDiff), aboveThreshold: cashDiff.abs().gt(threshold),
    });
    return this.detail(q, actor.user.propertyId, id);
  }

  /** The account-wise ledger (the old software's "Ledger Entries"), with a running balance. */
  async ledger(propertyId: string, accountId: string, range: { from?: string; to?: string }) {
    return this.db.tx({}, async (q) => {
      const { rows: account } = await q.query<{ id: string; name: string; kind: string; opening_balance: string }>(
        `SELECT id, name, kind, opening_balance FROM payment_accounts WHERE id = $1 AND property_id = $2`, [accountId, propertyId],
      );
      if (!account[0]) throw notFound('Payment account');
      const [before, entries] = await gather(q, [
        () => q.query<{ total: string }>(
          `SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS total FROM account_ledger
            WHERE account_id = $1 AND $2::date IS NOT NULL AND business_date < $2::date`,
          [accountId, range.from ?? null],
        ),
        () => q.query<{ source: string; source_id: string; reference: string; business_date: string; at: Date; by_name: string; amount: string; description: string }>(
          `SELECT l.source, l.source_id, l.reference, l.business_date, l.at, u.full_name AS by_name, l.amount, l.description
             FROM account_ledger l JOIN users u ON u.id = l.by_user
            WHERE l.account_id = $1
              AND ($2::date IS NULL OR l.business_date >= $2::date)
              AND ($3::date IS NULL OR l.business_date <= $3::date)
            ORDER BY l.business_date, l.at, l.reference`,
          [accountId, range.from ?? null, range.to ?? null],
        ),
      ]);
      let running = money(account[0].opening_balance).plus(before.rows[0]!.total);
      const opening = toMoneyString(running);
      const lines = entries.rows.map((e) => {
        running = running.plus(e.amount);
        return {
          source: e.source, sourceId: e.source_id, reference: e.reference, businessDate: e.business_date, at: e.at,
          by: e.by_name, description: e.description, amount: e.amount, balance: toMoneyString(running),
        };
      });
      return {
        account: { id: account[0].id, name: account[0].name, kind: account[0].kind },
        from: range.from ?? null, to: range.to ?? null, openingBalance: opening, closingBalance: toMoneyString(running), lines,
      };
    });
  }
}
