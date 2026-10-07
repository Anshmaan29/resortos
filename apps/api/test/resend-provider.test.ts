import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResendProvider, type OutgoingMessage } from '../src/messaging/providers';

// Exercise the real HTTP adapter against a local server, with no real recipients or credentials.
let server: ReturnType<typeof createServer>;
let provider: ResendProvider;
let status = 200;
let name = '';
const requests: { key: string | undefined; body: any }[] = [];
const message: OutgoingMessage = {
  id: 'local-provider-test-001', channel: 'email', to: 'guest@example.com',
  from: { name: 'Test Resort', address: 'reception@example.com' }, replyTo: 'desk@example.com',
  subject: 'Invoice', text: 'Your invoice', html: '<p>Your invoice</p>',
  attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-Local fixture'), contentType: 'application/pdf' }], tags: [{ name: 'template', value: 'invoice' }],
};
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ key: req.headers['idempotency-key'] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { id: 'local-email-id' } : { name, message: 'Local simulated response' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider = new ResendProvider('local-test-key', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });

describe('Resend HTTP contract', () => {
  it('sends the sender, reply address, recipient and PDF with a stable deduplication key', async () => {
    expect(await provider.send(message)).toEqual({ providerMessageId: 'local-email-id' });
    await provider.send(message);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]!.key).toBe(message.id);
    expect(requests[0]!.body).toMatchObject({ from: 'Test Resort <reception@example.com>', to: ['guest@example.com'], reply_to: 'desk@example.com' });
    expect(Buffer.from(requests[0]!.body.attachments[0].content, 'base64')).toEqual(message.attachments[0]!.content);
  });
  it.each([
    [429, 'rate_limit_exceeded', true], [503, 'service_unavailable', true],
    [409, 'concurrent_idempotent_requests', true], [409, 'invalid_idempotent_request', false], [403, 'validation_error', false],
  ])('classifies HTTP %s / %s for safe retries', async (code, errorName, retryable) => {
    status = code; name = errorName;
    await expect(provider.send(message)).rejects.toMatchObject({ retryable });
  });
});
