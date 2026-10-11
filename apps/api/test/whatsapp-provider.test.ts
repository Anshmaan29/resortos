import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config';
import { ProviderError, type OutgoingMessage } from '../src/messaging/providers';
import { defaultBindings, verifyMetaSignature, verifyMetaToken, WHATSAPP_WORDING, whatsappNumber, whatsappParameters, WhatsAppProvider } from '../src/messaging/whatsapp';
const config = {
  WHATSAPP_ACCESS_TOKEN: randomBytes(24).toString('hex'), WHATSAPP_PHONE_NUMBER_ID: '123',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '456', WHATSAPP_GRAPH_VERSION: 'v25.0',
} as AppConfig;
const message = (): OutgoingMessage => ({
  id: 'e10cfa41-5398-4978-969f-5d7a3273a57d', channel: 'whatsapp', to: '+91 99999 99999',
  from: null, replyTo: null, subject: null, text: 'Confirmation', html: null, attachments: [], tags: [],
  whatsapp: { name: 'resortos_booking_confirmation_en', languageCode: 'en', parameters: ['Guest'], documentHeader: false },
});
describe('Meta provider', () => {
  it('sends the approved template, ordered parameters and opaque identifier, without an invented deduplication header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ messages: [{ id: 'wamid.test' }] }));
    expect(await new WhatsAppProvider(config, fetcher).send(message())).toEqual({ providerMessageId: 'wamid.test' });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v25.0/123/messages');
    expect(options?.headers).not.toHaveProperty('Idempotency-Key');
    const body = JSON.parse(String(options?.body));
    expect(body.to).toBe('919999999999');
    expect(body.biz_opaque_callback_data).toBe(message().id);
    expect(body.template.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Guest' }] }]);
  });
  it('uploads a safe invoice PDF and includes the returned media ID in the document header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: 'media_1' })).mockResolvedValueOnce(Response.json({ messages: [{ id: 'wamid.pdf' }] }));
    const m = message(); m.whatsapp!.documentHeader = true;
    m.attachments = [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-test'), contentType: 'application/pdf' }];
    await new WhatsAppProvider(config, fetcher).send(m);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/media$/);
    expect(fetcher.mock.calls[0]![1]?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).template.components[0])
      .toEqual({ type: 'header', parameters: [{ type: 'document', document: { id: 'media_1', filename: 'invoice.pdf' } }] });
  });
  it.each(['image/jpeg', 'image/png'])('rejects %s attachments before making a request', async type => {
    const fetcher = vi.fn<typeof fetch>(); const m = message(); m.whatsapp!.documentHeader = true;
    m.attachments = [{ filename: 'id.jpg', content: Buffer.from('private'), contentType: type }];
    await expect(new WhatsAppProvider(config, fetcher).send(m)).rejects.toMatchObject({ retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry uncertain delivery, missing message IDs or ambiguous server failures', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('may include sensitive details')),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({})),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 2, message: 'private recipient' } }, { status: 500 })),
    ]) {
      try { await new WhatsAppProvider(config, fetcher).send(message()); throw new Error('Expected failure'); }
      catch (error) { expect(error).toBeInstanceOf(ProviderError); expect(error).toMatchObject({ retryable: false }); expect((error as Error).message).not.toContain('private recipient'); }
    }
  });
  it('retries an explicit rate limit, but not an authentication rejection', async () => {
    for (const [status, code, retryable] of [[429, 130429, true], [401, 190, false]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code } }, { status }));
      await expect(new WhatsAppProvider(config, fetcher).send(message())).rejects.toMatchObject({ retryable });
    }
  });
  it('checks approval, wording, exact locale and header rather than trusting a name alone', async () => {
    const binding = defaultBindings()[0]!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{
      name: binding.name, language: 'en', status: 'APPROVED',
      components: [{ type: 'BODY', text: WHATSAPP_WORDING.booking_confirmation.body }],
    }] }));
    expect((await new WhatsAppProvider(config, fetcher).approval([binding]))[0]).toMatchObject({ ready: true });
    expect((await new WhatsAppProvider(config, fetcher).approval([{ ...binding, languageCode: 'en_US' }]))[0]).toMatchObject({ ready: false, approval: 'NOT_FOUND' });
  });
});
describe('WhatsApp privacy and verification', () => {
  it.each([
    ['9829204128', '919829204128'], ['+91 98292 04128', '919829204128'],
    ['0091 98292 04128', '919829204128'], ['+44 7700 900123', '447700900123'],
    ['', null], ['123', null], ['9829204128@evil', null],
  ])('normalizes %s', (input, expected) => expect(whatsappNumber(input)).toBe(expected));
  it('authenticates the exact raw bytes and fails closed on missing, malformed or changed signatures', () => {
    const secret = randomBytes(32).toString('hex'); const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyMetaSignature(secret, signature, body)).toBe(true);
    expect(verifyMetaSignature(secret, signature, Buffer.from('{}'))).toBe(false);
    expect(verifyMetaSignature(secret, 'sha256=xyz', body)).toBe(false);
    expect(verifyMetaSignature(secret, undefined, body)).toBe(false);
    expect(verifyMetaToken(secret, secret)).toBe(true);
    expect(verifyMetaToken(secret, secret + 'x')).toBe(false);
  });
  it('takes only whitelisted template variables and removes newlines from values', () => {
    const values = whatsappParameters('booking_confirmation', { guest_name: 'Test\nGuest', mobile: 'private' } as never);
    expect(values[0]).toBe('Test Guest'); expect(values).not.toContain('private');
  });
});
