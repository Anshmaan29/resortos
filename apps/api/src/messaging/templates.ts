/**
 * Guest message templates (spec §40): the built-in wording, used until the owner writes their own,
 * and the one function that turns a template into text.
 *
 * **Only the variables listed in `TEMPLATE_VARIABLES` can ever reach a message.** Anything else in
 * braces renders as nothing. That list deliberately has no guest mobile, no address, no ID number,
 * no card detail and no PIN (spec §41 "Never send", CLAUDE.md rule 12): a template typo, or an owner
 * experimenting, cannot put them in an email.
 */

export const TEMPLATE_KEYS = ['booking_confirmation', 'check_in_welcome', 'checkout_reminder', 'invoice', 'receipt'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type Language = 'en' | 'hi';
export type Channel = 'email' | 'whatsapp' | 'sms';

export const TEMPLATE_VARIABLES = [
  'guest_name', 'resort_name', 'booking_number', 'room_number', 'check_in_date', 'check_out_date', 'nights',
  'checkout_time', 'check_in_time', 'advance_received', 'balance', 'invoice_number', 'invoice_total',
  'receipt_number', 'amount', 'payment_method', 'reception_phone', 'location_link', 'wifi',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateVars = Partial<Record<TemplateVariable, string>>;

export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  booking_confirmation: 'Booking confirmed',
  check_in_welcome: 'Welcome after check-in',
  checkout_reminder: 'Checkout reminder (evening before)',
  invoice: 'Thank you + invoice',
  receipt: 'Payment receipt',
};

/** Checkout reminders respect quiet hours; the rest answer something the guest just did. */
export const NON_URGENT: ReadonlySet<TemplateKey> = new Set(['checkout_reminder']);

interface Wording { subject: string; body: string }

export const DEFAULT_TEMPLATES: Record<TemplateKey, Record<Language, Wording>> = {
  booking_confirmation: {
    en: {
      subject: 'Your booking {{booking_number}} at {{resort_name}} is confirmed',
      body: 'Dear {{guest_name}},\n\nThank you for booking with {{resort_name}}. Your stay is confirmed.\n\nBooking: {{booking_number}}\nArrival: {{check_in_date}} (check-in from {{check_in_time}})\nDeparture: {{check_out_date}} (checkout by {{checkout_time}})\nNights: {{nights}}\nAdvance received: {{advance_received}}\n\nFind us: {{location_link}}\nReception: {{reception_phone}}\n\nWe look forward to welcoming you.\n{{resort_name}}',
    },
    hi: {
      subject: '{{resort_name}} में आपकी बुकिंग {{booking_number}} पक्की हो गई है',
      body: 'प्रिय {{guest_name}},\n\n{{resort_name}} में बुकिंग के लिए धन्यवाद। आपका ठहराव पक्का है।\n\nबुकिंग: {{booking_number}}\nआगमन: {{check_in_date}} ({{check_in_time}} से चेक-इन)\nप्रस्थान: {{check_out_date}} ({{checkout_time}} तक चेकआउट)\nरातें: {{nights}}\nअग्रिम प्राप्त: {{advance_received}}\n\nहमारा पता: {{location_link}}\nरिसेप्शन: {{reception_phone}}\n\nआपके स्वागत की प्रतीक्षा है।\n{{resort_name}}',
    },
  },
  check_in_welcome: {
    en: {
      subject: 'Welcome to {{resort_name}}',
      body: 'Dear {{guest_name}},\n\nWelcome! You are in room {{room_number}}.\n\nCheckout: {{check_out_date}} by {{checkout_time}}\nWi-Fi: {{wifi}}\nReception: {{reception_phone}}\n\nIf you need anything at all, call the reception.\n{{resort_name}}',
    },
    hi: {
      subject: '{{resort_name}} में आपका स्वागत है',
      body: 'प्रिय {{guest_name}},\n\nआपका स्वागत है! आपका कमरा {{room_number}} है।\n\nचेकआउट: {{check_out_date}}, {{checkout_time}} तक\nवाई-फ़ाई: {{wifi}}\nरिसेप्शन: {{reception_phone}}\n\nकिसी भी ज़रूरत के लिए रिसेप्शन पर फ़ोन करें।\n{{resort_name}}',
    },
  },
  checkout_reminder: {
    en: {
      subject: 'Checkout tomorrow at {{checkout_time}}',
      body: 'Dear {{guest_name}},\n\nA reminder that checkout from room {{room_number}} is tomorrow, {{check_out_date}}, by {{checkout_time}}.\n\nWould you like a late checkout? Call the reception on {{reception_phone}} and we will do our best.\n\nThank you for staying with us.\n{{resort_name}}',
    },
    hi: {
      subject: 'कल {{checkout_time}} तक चेकआउट',
      body: 'प्रिय {{guest_name}},\n\nयाद दिला दें कि कमरा {{room_number}} से चेकआउट कल, {{check_out_date}}, {{checkout_time}} तक है।\n\nदेर से चेकआउट चाहिए? रिसेप्शन पर {{reception_phone}} पर फ़ोन करें।\n\nहमारे साथ ठहरने के लिए धन्यवाद।\n{{resort_name}}',
    },
  },
  invoice: {
    en: {
      subject: 'Thank you for staying with us — invoice {{invoice_number}}',
      body: 'Dear {{guest_name}},\n\nThank you for staying at {{resort_name}}. Your invoice {{invoice_number}} for {{invoice_total}} is attached.\n\nBalance: {{balance}}\n\nWe hope to see you again.\n{{resort_name}}',
    },
    hi: {
      subject: 'हमारे साथ ठहरने के लिए धन्यवाद — इनवॉइस {{invoice_number}}',
      body: 'प्रिय {{guest_name}},\n\n{{resort_name}} में ठहरने के लिए धन्यवाद। {{invoice_total}} का आपका इनवॉइस {{invoice_number}} संलग्न है।\n\nशेष राशि: {{balance}}\n\nफिर मिलेंगे।\n{{resort_name}}',
    },
  },
  receipt: {
    en: {
      subject: 'Receipt {{receipt_number}} — {{amount}} received',
      body: 'Dear {{guest_name}},\n\nWe have received {{amount}} by {{payment_method}} for booking {{booking_number}}. Your receipt {{receipt_number}} is attached.\n\nThank you.\n{{resort_name}}',
    },
    hi: {
      subject: 'रसीद {{receipt_number}} — {{amount}} प्राप्त',
      body: 'प्रिय {{guest_name}},\n\nबुकिंग {{booking_number}} के लिए {{payment_method}} से {{amount}} प्राप्त हुए। आपकी रसीद {{receipt_number}} संलग्न है।\n\nधन्यवाद।\n{{resort_name}}',
    },
  },
};

const ALLOWED = new Set<string>(TEMPLATE_VARIABLES);

/** `{{guest_name}}` → the value. Unknown or missing variables render as nothing, never as the raw braces. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name: string) => (ALLOWED.has(name) ? vars[name as TemplateVariable] ?? '' : ''));
}

/** Variables a template uses that are not on the allowed list — shown to the owner when saving. */
export function unknownVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!).filter((n) => !ALLOWED.has(n)))];
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A plain, readable HTML version of a rendered body: paragraphs, and https links made clickable.
 * The body is escaped first, so nothing a guest typed into their own name can become markup.
 */
export function emailHtml(body: string, resortName: string): string {
  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>').replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,'Noto Sans',sans-serif;color:#111827">`
    + `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;font-size:15px;line-height:1.55">${paragraphs}</div>`
    + `<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#6b7280;text-align:center">${escapeHtml(resortName)}</p></body></html>`;
}
