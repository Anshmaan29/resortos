import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ERROR_CODES, addChargeSchema, chargeItemSchema, creditNoteSchema, debitNoteSchema, depositDecisionSchema, discountSchema,
  invoiceBuyerSchema, zIsoDate, paymentAccountSchema, recordPaymentSchema, reversePaymentSchema,
  voidLineSchema, zId,
} from '@resortos/shared';
import { z } from 'zod';
import { AppError } from '../common/errors';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { FolioService } from './folio.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

@Controller()
export class FoliosController {
  constructor(
    private readonly folios: FolioService,
    private readonly payments: PaymentsService,
    private readonly invoices: InvoicesService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  /** The bill for a stay, opened on first look. */
  @Get('stays/:id/bill')
  forStay(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.folios.forStay(actor, parse(zId, id));
  }

  @Post('folios/:id/charges')
  @HttpCode(200)
  addCharge(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const input = parse(addChargeSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.folios.addCharge(q, actor, folioId, input));
  }

  /**
   * What a discount would do, before it is given (spec §28): the amount off each charge, the share
   * of the bill, whether it needs the owner, and any room night it moves into another GST slab.
   * Saves nothing.
   */
  @Post('folios/:id/discounts/preview')
  @HttpCode(200)
  previewDiscount(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const input = parse(discountSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.folios.previewDiscount(q, actor, folioId, input));
  }

  @Post('folios/:id/discounts')
  @HttpCode(200)
  applyDiscount(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const input = parse(discountSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.folios.applyDiscount(q, actor, folioId, input));
  }

  @Post('folio-lines/:id/void')
  @HttpCode(200)
  voidLine(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const lineId = parse(zId, id);
    const input = parse(voidLineSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.folios.voidLine(q, actor, lineId, input));
  }

  // ---------------- payments (spec §25, §26) ----------------

  @Post('folios/:id/payments')
  @HttpCode(200)
  recordOnFolio(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const input = parse(recordPaymentSchema, body);
    return this.mutate(actor, req, key, body, async (q) => {
      await this.payments.record(q, actor, { folioId }, input);
      return this.folios.detail(q, actor.user.propertyId, folioId);
    });
  }

  /** The security deposit decision (spec §27): apply some to the bill, give the rest back. */
  @Post('folios/:id/deposit/settle')
  @HttpCode(200)
  settleDeposit(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const input = parse(depositDecisionSchema, body);
    return this.mutate(actor, req, key, body, async (q) => {
      const before = await this.folios.detail(q, actor.user.propertyId, folioId);
      if (!before.balance) throw new AppError(ERROR_CODES.CONFLICT, 'GST cannot be worked out for this bill yet, so what it owes is not known.');
      await this.payments.settleDeposit(q, actor, folioId, input, before.balance);
      return this.folios.detail(q, actor.user.propertyId, folioId);
    });
  }

  /** An advance taken before the guest arrives, when there is no bill yet (spec §26). */
  @Post('reservations/:id/advance')
  @HttpCode(200)
  recordAdvance(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const reservationId = parse(zId, id);
    const input = parse(recordPaymentSchema, body);
    return this.mutate(actor, req, key, body, (q) =>
      this.payments.record(q, actor, { reservationId }, { ...input, entryType: input.entryType === 'payment' ? 'advance' : input.entryType }));
  }

  @Post('payments/:id/reverse')
  @HttpCode(200)
  reversePayment(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const paymentId = parse(zId, id);
    const input = parse(reversePaymentSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.payments.reverse(q, actor, paymentId, input));
  }

  // ---------------- invoices (spec §29–§31) ----------------

  /** Exactly what checkout would issue, without a number. Saves nothing. */
  @Post('folios/:id/invoice/preview')
  @HttpCode(200)
  previewInvoice(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const { buyer } = parse(z.object({ buyer: invoiceBuyerSchema.optional() }), body ?? {});
    return this.db.tx({ userId: actor.user.id }, (q) => this.invoices.preview(q, actor, folioId, buyer));
  }

  @Get('folios/:id/invoices')
  folioInvoices(@CurrentActor() actor: Actor, @Param('id') id: string) {
    const folioId = parse(zId, id);
    return this.db.tx({ userId: actor.user.id }, (q) => this.invoices.forFolio(q, actor.user.propertyId, folioId));
  }

  /** The invoice register (owner): every document in a period, in number order. */
  @Get('invoices')
  @Roles('owner')
  register(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const range = parse(z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() }), query);
    return this.invoices.register(actor.user.propertyId, range);
  }

  @Get('invoices/:id')
  invoice(@CurrentActor() actor: Actor, @Param('id') id: string) {
    const invoiceId = parse(zId, id);
    return this.db.tx({ userId: actor.user.id }, (q) => this.invoices.detail(q, actor.user.propertyId, invoiceId));
  }

  /** Credit note (§29.4): owner only, reason required. The whole invoice cancels it. */
  @Post('invoices/:id/credit-note')
  @Roles('owner')
  @HttpCode(200)
  creditNote(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const invoiceId = parse(zId, id);
    const input = parse(creditNoteSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.invoices.creditNote(q, actor, invoiceId, input));
  }

  /** Charges added after the invoice go on a debit note against it (§22). Owner only. */
  @Post('folios/:id/debit-note')
  @Roles('owner')
  @HttpCode(200)
  debitNote(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const { reason } = parse(debitNoteSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.invoices.debitNote(q, actor, folioId, reason));
  }

  // ---------------- payment accounts (owner settings, spec §25.1) ----------------

  @Get('payment-accounts')
  listAccounts(@CurrentActor() actor: Actor, @Query('includeInactive') includeInactive?: string) {
    return this.payments.listAccounts(actor.user.propertyId, includeInactive === 'true');
  }

  /** Account-wise totals — the old software's Ledger Entries, recalculated from rows. */
  @Get('payment-accounts/balances')
  @Roles('owner')
  accountBalances(@CurrentActor() actor: Actor, @Query('from') from?: string, @Query('to') to?: string) {
    return this.payments.accountBalances(actor.user.propertyId, { from, to });
  }

  @Post('payment-accounts')
  @Roles('owner')
  createAccount(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(paymentAccountSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.payments.createAccount(q, actor, input));
  }

  @Patch('payment-accounts/:id')
  @Roles('owner')
  updateAccount(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const accountId = parse(zId, id);
    const { version, ...rest } = parse(paymentAccountSchema.extend({ version: z.coerce.number().int().min(1) }), body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.payments.updateAccount(q, actor, accountId, rest, version));
  }

  // ---------------- saved charge items (spec §24.2) ----------------

  @Get('charge-items')
  listItems(@CurrentActor() actor: Actor, @Query('includeInactive') includeInactive?: string) {
    return this.folios.listChargeItems(actor.user.propertyId, includeInactive === 'true');
  }

  // Owner settings (spec §24.2), so they follow the same shape as the other settings endpoints:
  // owner-only, guarded by an optimistic version rather than an idempotency key.
  @Post('charge-items')
  @Roles('owner')
  createItem(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(chargeItemSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.folios.createChargeItem(q, actor, input));
  }

  @Patch('charge-items/:id')
  @Roles('owner')
  updateItem(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const itemId = parse(zId, id);
    const { version, ...rest } = parse(chargeItemSchema.extend({ version: z.coerce.number().int().min(1) }), body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.folios.updateChargeItem(q, actor, itemId, rest, version));
  }
}
