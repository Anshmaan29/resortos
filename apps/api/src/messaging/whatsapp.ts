import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config';
import { ProviderError, type MessageProvider, type OutgoingMessage } from './providers';
import { TEMPLATE_KEYS, type TemplateKey, type TemplateVariable } from './templates';

export const WHATSAPP_WORDING: Record<TemplateKey, { body: string; variables: TemplateVariable[]; documentHeader: boolean }> = {
  booking_confirmation: {
    body: '*Booking confirmed*\n\nHello {{1}},\nYour reservation at {{3}} is confirmed.\n\n*Booking reference:* {{2}}\n*Arrival date:* {{4}}\n*Departure date:* {{5}}\n*Check-in from:* {{6}}\n\nFor questions or changes to your arrival plans, please contact our reception team.\n*Reception phone:* {{7}}\n\nWe look forward to welcoming you for your stay.',
    variables: ['guest_name', 'booking_number', 'resort_name', 'check_in_date', 'check_out_date', 'check_in_time', 'reception_phone'], documentHeader: false,
  },
  check_in_welcome: {
    body: '*Welcome — check-in complete*\n\nHello {{1}},\nWelcome to {{2}}. Your check-in is complete and your room is ready.\n\n*Your room number:* {{3}}\n*Checkout date:* {{4}}\n*Checkout due by:* {{5}}\n\nFor assistance during your stay, please contact our reception team.\n*Reception phone:* {{6}}\n\nWe hope you have a comfortable stay with us.',
    variables: ['guest_name', 'resort_name', 'room_number', 'check_out_date', 'checkout_time', 'reception_phone'], documentHeader: false,
  },
  checkout_reminder: {
    body: '*Checkout reminder*\n\nHello {{1}},\nThis is a reminder about your scheduled checkout from {{2}}.\n\n*Your room number:* {{3}}\n*Checkout date:* {{4}}\n*Checkout due by:* {{5}}\n\nFor help with checkout or your bill, please contact our reception team.\n*Reception phone:* {{6}}\n\nThank you for staying with us.',
    variables: ['guest_name', 'resort_name', 'room_number', 'check_out_date', 'checkout_time', 'reception_phone'], documentHeader: false,
  },
  invoice: {
    body: '*Your hotel invoice*\n\nHello {{1}},\nYour invoice from {{3}} is attached as a PDF document.\n\n*Invoice reference:* {{2}}\n*Invoice total:* {{4}}\n*Remaining balance:* {{5}}\n\nFor questions about these charges or payment, please contact our reception team.\n*Reception phone:* {{6}}\n\nPlease keep the attached invoice for your records.',
    variables: ['guest_name', 'invoice_number', 'resort_name', 'invoice_total', 'balance', 'reception_phone'], documentHeader: true,
  },
  receipt: {
    body: '*Payment received*\n\nHello {{1}},\nThis message confirms that {{2}} has received your payment.\n\n*Amount received:* {{3}}\n*Payment method:* {{4}}\n*Booking reference:* {{5}}\n*Receipt reference:* {{6}}\n\nYour payment receipt is attached as a PDF document. Please keep it for your records and contact reception if you have any questions.',
    variables: ['guest_name', 'resort_name', 'amount', 'payment_method', 'booking_number', 'receipt_number'], documentHeader: true,
  },
};

/** Keep already-approved templates usable while formatted replacements are reviewed. */
const LEGACY_EN_BODY: Record<TemplateKey, string> = {
  booking_confirmation: 'Hello {{1}}, your reservation at {{3}} has been confirmed. Your booking reference is {{2}}.\nYour arrival date is {{4}}, and your departure date is {{5}}. Check-in is available from {{6}}.\nFor questions about this reservation or changes to your arrival plans, please contact our reception team on {{7}}. We look forward to your stay.',
  check_in_welcome: 'Hello {{1}}, your check-in at {{2}} is complete and your room is ready.\nYour assigned room number is {{3}}. Your scheduled checkout date is {{4}}, with checkout due by {{5}}.\nIf you need assistance during your stay, please contact the reception team on {{6}}. We hope you have a comfortable stay.',
  checkout_reminder: 'Hello {{1}}, this is a reminder about your scheduled checkout from {{2}}.\nYour room number is {{3}}, and checkout is due on {{4}} by {{5}}.\nIf you need help with checkout or your bill, please contact our reception team on {{6}}. Thank you for staying with us.',
  invoice: 'Hello {{1}}, your invoice from {{3}} is attached as a PDF document.\nThe invoice reference is {{2}} and the invoice total is {{4}}. The balance remaining to be paid is {{5}}.\nFor questions about these charges or payment, please contact our reception team on {{6}}. Please keep this invoice for your records.',
  receipt: 'Hello {{1}}, this message confirms that {{2}} has received your payment.\nThe amount received is {{3}} and the payment method recorded is {{4}}. This payment relates to booking {{5}}.\nYour payment receipt {{6}} is attached as a PDF document. Please keep it for your records and contact reception if you have any questions.',
};

const HINDI_BODY: Record<TemplateKey, string> = {
  booking_confirmation: 'नमस्ते {{1}}, {{3}} में आपकी बुकिंग {{2}} पक्की है।\nआगमन: {{4}}\nप्रस्थान: {{5}}\nचेक-इन {{6}} से। रिसेप्शन: {{7}}।',
  check_in_welcome: 'नमस्ते {{1}}, {{2}} में आपका चेक-इन पूरा हुआ।\nकमरा: {{3}}\nचेकआउट: {{4}}, {{5}} तक।\nरिसेप्शन: {{6}}।',
  checkout_reminder: 'नमस्ते {{1}}, {{2}} से आपके चेकआउट की याद दिला रहे हैं।\nकमरा {{3}}: {{4}}, {{5}} तक चेकआउट।\nसहायता के लिए रिसेप्शन: {{6}}।',
  invoice: 'नमस्ते {{1}}, {{3}} से {{4}} का आपका इनवॉइस {{2}} संलग्न है।\nशेष राशि: {{5}}।\nरिसेप्शन: {{6}}।',
  receipt: 'नमस्ते {{1}}, {{2}} को बुकिंग {{5}} के लिए {{4}} से {{3}} प्राप्त हुए।\nआपकी रसीद {{6}} संलग्न है।',
};
export function whatsappWording(key: TemplateKey, language: 'en' | 'hi' = 'en', templateName?: string) {
  const body = language === 'hi' ? HINDI_BODY[key]
    : templateName === 'resortos_' + key + '_en' ? LEGACY_EN_BODY[key] : WHATSAPP_WORDING[key].body;
  return { ...WHATSAPP_WORDING[key], body };
}
export function whatsappParameters(key: TemplateKey, vars: Partial<Record<TemplateVariable, string>>) {
  return WHATSAPP_WORDING[key].variables.map(v => (vars[v] || '—').replace(/\s+/g, ' ').trim().slice(0, 500));
}
export function whatsappBody(key: TemplateKey, parameters: string[], language: 'en' | 'hi' = 'en', templateName?: string) {
  return whatsappWording(key, language, templateName).body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => parameters[Number(n) - 1] ?? '—');
}
/** Ten-digit Indian numbers are supported, as are explicit international +/00 numbers. */
export function whatsappNumber(value: string): string | null {
  const clean = value.trim().replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(clean)) return '91' + clean;
  const international = clean.startsWith('+') ? clean.slice(1) : clean.startsWith('00') ? clean.slice(2) : clean;
  return /^[1-9]\d{10,14}$/.test(international) ? international : null;
}
export function whatsappConfigured(c: AppConfig) {
  return Boolean(c.WHATSAPP_ACCESS_TOKEN && c.WHATSAPP_PHONE_NUMBER_ID && c.WHATSAPP_BUSINESS_ACCOUNT_ID
    && c.WHATSAPP_PROPERTY_ID && c.WHATSAPP_APP_SECRET && c.WHATSAPP_VERIFY_TOKEN);
}
export function verifyMetaSignature(secret: string, signature: string | undefined, body: Buffer): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(signature.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(expected, given);
}
export function verifyMetaToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface MetaErrorBody { error?: { code?: number; error_subcode?: number } }
interface MetaTemplate { name: string; language: string; status: string; components?: { type: string; format?: string; text?: string }[] }
export interface TemplateBinding { key: TemplateKey; language: 'en' | 'hi'; name: string; languageCode: string; active: boolean }

/**
 * There is no assumed Idempotency-Key support at Meta. Uncertain send failures are final for
 * automatic retries. An operator checks Meta before explicitly resending. Only explicit rate-limit
 * rejections are retried; media uploads themselves never deliver a guest message.
 */
export class WhatsAppProvider implements MessageProvider {
  readonly name = 'meta_whatsapp';
  readonly channel = 'whatsapp' as const;
  private readonly base: string;
  constructor(private readonly config: AppConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = 'https://graph.facebook.com/' + config.WHATSAPP_GRAPH_VERSION;
  }
  private async request(path: string, init: RequestInit, delivery = false): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        ...init, headers: { ...init.headers, Authorization: 'Bearer ' + this.config.WHATSAPP_ACCESS_TOKEN },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderError(delivery
        ? 'WhatsApp delivery is uncertain. Check Meta before sending again.'
        : 'Could not reach Meta. Please try again later.', !delivery);
    }
    const data = await res.json().catch(() => ({})) as Record<string, unknown> & MetaErrorBody;
    if (!res.ok) {
      const code = data.error?.code;
      const retryable = delivery ? (res.status === 429 && Boolean(data.error)) || code === 130429 || code === 131056
        : res.status === 429 || res.status >= 500;
      // Never put Meta's raw error text (which may contain a phone or token) in message history/logs.
      throw new ProviderError('Meta rejected the request (HTTP ' + res.status + (code ? ', code ' + code : '') + ').'
        + (delivery && res.status >= 500 ? ' Check Meta before sending again; delivery may be uncertain.' : ''), retryable);
    }
    return data;
  }
  async send(m: OutgoingMessage) {
    if (!m.whatsapp || !whatsappNumber(m.to)) throw new ProviderError('WhatsApp template or recipient is invalid.', false);
    const components: object[] = [];
    if (m.whatsapp.documentHeader) {
      const a = m.attachments[0];
      if (m.attachments.length !== 1 || !a || a.contentType !== 'application/pdf' || a.content.length > 10 * 1024 * 1024) {
        throw new ProviderError('This WhatsApp template needs one invoice or receipt PDF under 10 MB.', false);
      }
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', 'application/pdf');
      form.append('file', new Blob([new Uint8Array(a.content)], { type: 'application/pdf' }), a.filename);
      const media = await this.request('/' + this.config.WHATSAPP_PHONE_NUMBER_ID + '/media', { method: 'POST', body: form });
      if (typeof media.id !== 'string') throw new ProviderError('Meta did not return a media ID.', true);
      components.push({ type: 'header', parameters: [{ type: 'document', document: { id: media.id, filename: a.filename } }] });
    }
    components.push({ type: 'body', parameters: m.whatsapp.parameters.map(text => ({ type: 'text', text })) });
    const data = await this.request('/' + this.config.WHATSAPP_PHONE_NUMBER_ID + '/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: whatsappNumber(m.to), type: 'template',
        biz_opaque_callback_data: m.id,
        template: { name: m.whatsapp.name, language: { code: m.whatsapp.languageCode }, components },
      }),
    }, true);
    const id = (data.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!id) throw new ProviderError('WhatsApp delivery is uncertain: Meta returned no message ID. Check Meta before sending again.', false);
    return { providerMessageId: id };
  }
  /** Read Meta's current approval state and check the exact parameter layout before activation. */
  async approval(bindings: TemplateBinding[]) {
    const templates: MetaTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ fields: 'name,language,status,components', limit: '100' });
      if (after) query.set('after', after);
      const data = await this.request('/' + this.config.WHATSAPP_BUSINESS_ACCOUNT_ID + '/message_templates?' + query, {});
      templates.push(...((data.data as MetaTemplate[] | undefined) ?? []));
      const paging = data.paging as { next?: string; cursors?: { after?: string } } | undefined;
      if (!paging?.next || !paging.cursors?.after) break;
      after = paging.cursors.after;
      if (page === 19) throw new ProviderError('Too many Meta templates to check. Please contact the operator.', false);
    }
    return bindings.map(b => {
      const found = templates.find(t => t.name === b.name && t.language === b.languageCode);
      const wording = whatsappWording(b.key, b.language, b.name);
      const components = found?.components ?? [];
      const body = components.find(x => x.type === 'BODY');
      const header = components.find(x => x.type === 'HEADER');
      const matching = body?.text === wording.body
        && (wording.documentHeader ? header?.format === 'DOCUMENT' : !header)
        && !components.some(x => !['BODY', 'HEADER'].includes(x.type));
      return { ...b, approval: found?.status ?? 'NOT_FOUND', matching, ready: found?.status === 'APPROVED' && matching };
    });
  }
}
export const defaultBindings = (): TemplateBinding[] => TEMPLATE_KEYS.map(key => ({
  key, language: 'en', languageCode: 'en', name: 'resortos_' + key + '_en_v2', active: true,
}));
