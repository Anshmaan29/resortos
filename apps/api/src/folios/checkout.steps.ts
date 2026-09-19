import { Injectable } from '@nestjs/common';
import { checkoutInvoiceSchema, checkoutSettlementSchema, formatINR, money, toMoneyString } from '@resortos/shared';
import { OwnerAuthorisationService } from '../auth/owner-authorisation.service';
import { parse } from '../common/zod';
import type { CheckoutBlocker, CheckoutContext, CheckoutStep } from '../stays/checkout-pipeline';
import { FolioService } from './folio.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

/**
 * Billing's part of checkout (spec §22), registered on the extension points 1.8 left for it:
 *
 *   15 deposit      a security deposit still held must be given back or applied first (§27)
 *   20 settlement   the balance must be zero — or the owner allows leaving with it owed
 *   80 invoice      the tax invoice is issued and the bill closed, in the checkout transaction
 *
 * `check()` runs for the checkout screen and again at confirmation; `apply()` only at confirmation.
 */
@Injectable()
export class DepositCheckoutStep implements CheckoutStep {
  readonly name = 'deposit';
  readonly order = 15;
  constructor(private readonly folios: FolioService, private readonly payments: PaymentsService) {}

  async check({ q, actor, stay }: CheckoutContext): Promise<CheckoutBlocker[]> {
    const folio = await this.folios.ensureForStay(q, actor, stay.id);
    const held = money(await this.payments.depositHeld(q, folio.id));
    return held.gt(0)
      ? [{ step: this.name, message: `A security deposit of ${formatINR(toMoneyString(held))} is still held. Give it back or apply it to the bill first.` }]
      : [];
  }
}

@Injectable()
export class SettlementCheckoutStep implements CheckoutStep {
  readonly name = 'settlement';
  readonly order = 20;
  constructor(private readonly folios: FolioService, private readonly ownerAuth: OwnerAuthorisationService) {}

  private async balance({ q, actor, stay }: CheckoutContext) {
    const folio = await this.folios.ensureForStay(q, actor, stay.id);
    const bill = await this.folios.detail(q, actor.user.propertyId, folio.id);
    return { folio, balance: bill.balance === null ? null : money(bill.balance) };
  }

  async check(ctx: CheckoutContext): Promise<CheckoutBlocker[]> {
    const input = parse(checkoutSettlementSchema, ctx.input[this.name]);
    const { balance } = await this.balance(ctx);
    if (balance === null) return [{ step: this.name, message: 'GST cannot be worked out for this bill, so what the guest owes is not known. Set up the tax rates first.' }];
    if (balance.isNegative()) {
      return [{ step: this.name, message: `The guest has paid ${formatINR(toMoneyString(balance.abs()))} more than the bill. Record a refund before checkout.` }];
    }
    if (balance.gt(0) && !input.pendingBalance) {
      return [{
        step: this.name,
        message: `${formatINR(toMoneyString(balance))} is still to pay. Record the payment, move it to a company account, or ask the owner to allow checkout with the balance pending.`,
      }];
    }
    return [];
  }

  /** Leaving with money owed is recorded as a receivable the owner authorised (§22). */
  async apply(ctx: CheckoutContext): Promise<void> {
    const input = parse(checkoutSettlementSchema, ctx.input[this.name]);
    const { folio, balance } = await this.balance(ctx);
    if (!balance || !balance.gt(0)) return;
    const auth = await this.ownerAuth.require(
      ctx.q, ctx.actor,
      {
        operation: 'stay.checkout_pending_balance',
        scope: { stayId: ctx.stay.id, balance: toMoneyString(balance) },
        reasons: [{ action: 'pending_balance_checkout', description: `Check out with ${formatINR(toMoneyString(balance))} still to pay` }],
      },
      input.ownerAuthorisationId, { type: 'folio', id: folio.id },
    );
    if (auth) await this.ownerAuth.recordOverrides(ctx.q, ctx.actor, auth, { type: 'folio', id: folio.id });
  }
}

@Injectable()
export class InvoiceCheckoutStep implements CheckoutStep {
  readonly name = 'invoice';
  readonly order = 80;
  constructor(private readonly folios: FolioService, private readonly invoices: InvoicesService) {}

  async check(): Promise<CheckoutBlocker[]> {
    return [];
  }

  async apply({ q, actor, stay, input }: CheckoutContext): Promise<void> {
    const { buyer } = parse(checkoutInvoiceSchema, input[this.name]);
    const folio = await this.folios.ensureForStay(q, actor, stay.id);
    await this.invoices.finalize(q, actor, folio.id, buyer);
  }
}
