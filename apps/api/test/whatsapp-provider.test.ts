import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config';
import { ProviderError, type OutgoingMessage } from '../src/messaging/providers';
import { defaultBindings, verifyMetaSignature, verifyMetaToken, WHATSAPP_WORDING, whatsappNumber, whatsappParameters, whatsappBody, whatsappWording, WhatsAppProvider, whatsappAvailable, whatsappPropertyIds } from '../src/messaging/whatsapp';
import { emailHtml } from '../src/messaging/templates';
import { loadConfig } from '../src/config';
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
  it('uploads only the bundled logo for image templates, never caller attachments', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({id:'logo_1'}))
      .mockResolvedValueOnce(Response.json({messages:[{id:'wamid.logo'}]}));
    const m=message();m.whatsapp!.imageHeader=true;
    await new WhatsAppProvider(config,fetcher).send(m);
    const upload=fetcher.mock.calls[0]![1]?.body as FormData;
    expect(upload.get('type')).toBe('image/png');
    expect((upload.get('file') as File).name).toBe('voitto-ventures.png');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).template.components[0])
      .toEqual({type:'header',parameters:[{type:'image',image:{id:'logo_1'}}]});
    m.attachments=[{filename:'guest.png',content:Buffer.from('private'),contentType:'image/png'}];
    fetcher.mockClear();
    await expect(new WhatsAppProvider(config,fetcher).send(m)).rejects.toMatchObject({retryable:false});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires an image header for branded templates and preserves legacy text-only approval', async()=>{
    const b={...defaultBindings()[0]!,name:'resortos_booking_confirmation_en_brand_v1'};
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({data:[{name:b.name,language:'en',status:'APPROVED',components:[{type:'BODY',text:whatsappWording(b.key,'en',b.name).body}]}]}));
    expect((await new WhatsAppProvider(config,fetcher).approval([b]))[0]?.ready).toBe(false);
    fetcher.mockResolvedValue(Response.json({data:[{name:b.name,language:'en',status:'APPROVED',components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:whatsappWording(b.key,'en',b.name).body}]}]}));
    expect((await new WhatsAppProvider(config,fetcher).approval([b]))[0]?.ready).toBe(true);
  });
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
  it('keeps approved legacy templates usable until formatted replacements are approved', async () => {
    const formatted = defaultBindings()[0]!;
    const legacy = { ...formatted, name: 'resortos_booking_confirmation_en' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { name: legacy.name, language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: whatsappWording(legacy.key, 'en', legacy.name).body }] },
      { name: formatted.name, language: 'en', status: 'PENDING', components: [{ type: 'BODY', text: WHATSAPP_WORDING.booking_confirmation.body }] },
    ] }));
    expect(await new WhatsAppProvider(config, fetcher).approval([legacy, formatted]))
      .toMatchObject([{ ready: true, matching: true }, { ready: false, matching: true, approval: 'PENDING' }]);
    const parameters = ['Sample Guest', 'BK-000009', 'Sample Hotel', '11 Oct 2026', '12 Oct 2026', '12:30', '+91 99999 99999'];
    const body = whatsappBody('booking_confirmation', parameters, 'en', formatted.name);
    expect(body).toContain('*Booking reference:* BK-000009\n*Arrival date:* 11 Oct 2026\n*Departure date:* 12 Oct 2026');
    expect(whatsappBody('booking_confirmation', parameters, 'en', legacy.name)).toContain('Your booking reference is BK-000009.');
  });
  it('checks approval, wording, exact locale and header rather than trusting a name alone', async () => {
    const binding = defaultBindings()[0]!;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{
      name: binding.name, language: 'en', status: 'APPROVED',
      components: [{ type: 'BODY', text: WHATSAPP_WORDING.booking_confirmation.body }],
    }] }));
    expect((await new WhatsAppProvider(config, fetcher).approval([binding]))[0]).toMatchObject({ ready: true });
    expect((await new WhatsAppProvider(config, fetcher).approval([{ ...binding, languageCode: 'en_US' }]))[0]).toMatchObject({ ready: false, approval: 'NOT_FOUND' });
  });
});
describe('WhatsApp privacy and verification', () => {
  it('restricts the shared sender to the explicit allowlist while supporting the original setting',()=>{
    const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
    const base={DATABASE_URL:'postgres://localhost/test',S3_BUCKET:'test',WHATSAPP_ACCESS_TOKEN:'x'.repeat(30),WHATSAPP_APP_SECRET:'y'.repeat(20),WHATSAPP_VERIFY_TOKEN:'z'.repeat(32),WHATSAPP_PHONE_NUMBER_ID:'123',WHATSAPP_BUSINESS_ACCOUNT_ID:'456',WHATSAPP_PROPERTY_ID:a};
    const c=loadConfig({...base,WHATSAPP_PROPERTY_IDS:a+', '+b});
    expect(whatsappAvailable(c,a)).toBe(true);expect(whatsappAvailable(c,b)).toBe(true);
    expect(whatsappAvailable(c,'33333333-3333-4333-8333-333333333333')).toBe(false);
    expect(whatsappPropertyIds(loadConfig(base))).toEqual([a]);
    expect(()=>loadConfig({...base,WHATSAPP_PROPERTY_IDS:a+',invalid'})).toThrow('WHATSAPP_PROPERTY_IDS');
  });
  it('renders Villa activity times and branding without claiming a hotel room or overnight stay',()=>{
    const name='resortos_villa_booking_confirmation_en_v1';
    const params=whatsappParameters('booking_confirmation',{guest_name:'Sample',resort_name:'Villa Sol by Voitto',booking_use:'Swimming pool',booking_start:'20 Oct 2026, 10:00 am',booking_end:'20 Oct 2026, 12:00 pm',reception_phone:'+919352204825'},name);
    const body=whatsappBody('booking_confirmation',params,'en',name);
    expect(body).toContain('*Booked for:* Swimming pool');expect(body).toContain('*Departure:* 20 Oct 2026, 12:00 pm');
    expect(body).toContain('Voitto Ventures');expect(body).not.toContain('room number');expect(body).not.toContain('Laxmi');
  });
  it('brands email with both identities while escaping guest input and unsafe logo URLs',()=>{
    const html=emailHtml('Hello <script>','Villa Sol & Voitto','https://example.com/logo.png');
    expect(html).toContain('VOITTO VENTURES');expect(html).toContain('Villa Sol &amp; Voitto');
    expect(html).toContain('src="https://example.com/logo.png"');expect(html).not.toContain('<script>');
    expect(emailHtml('Hello','Hotel','javascript:bad')).not.toContain('<img');
  });
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
  it('adds Wi-Fi to the new welcome and keeps approved older parameter layouts usable', () => {
    const vars = { guest_name: 'Guest', wifi: 'Network: TestGuest · Password: example-only' };
    const latest = whatsappParameters('check_in_welcome', vars, 'resortos_check_in_welcome_en_v3');
    expect(latest).toHaveLength(7);
    expect(whatsappBody('check_in_welcome', latest, 'en', 'resortos_check_in_welcome_en_v3')).toContain('*Guest Wi-Fi:* Network: TestGuest · Password: example-only');
    const previous = whatsappParameters('check_in_welcome', vars, 'resortos_check_in_welcome_en_v2');
    expect(previous).toHaveLength(6);
    expect(whatsappBody('check_in_welcome', previous, 'en', 'resortos_check_in_welcome_en_v2')).not.toContain('Wi-Fi');
    expect(whatsappParameters('check_in_welcome', vars, 'resortos_check_in_welcome_en')).toHaveLength(6);
    expect(whatsappParameters('check_in_welcome', vars, 'resortos_check_in_welcome_hi', 'hi')).toHaveLength(6);
  });
});
