import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config';
import type { Channel } from './templates';

/** One message, ready to hand to whoever delivers it. */
export interface OutgoingMessage {
  /** Our message id: also the provider idempotency key, so a retry can never send twice. */
  id: string;
  channel: Channel;
  to: string;
  from: { name: string; address: string } | null;
  replyTo: string | null;
  subject: string | null;
  text: string;
  html: string | null;
  attachments: { filename: string; content: Buffer; contentType: string }[];
  /** For the provider's own dashboard; never personal data. */
  tags: { name: string; value: string }[];
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Whoever delivers a channel (spec §40). Email today; WhatsApp and SMS implement the same interface
 * and use the same templates, rows and delivery tracking when their accounts exist.
 */
export interface MessageProvider {
  readonly name: string;
  readonly channel: Channel;
  send(message: OutgoingMessage): Promise<{ providerMessageId: string }>;
}

/**
 * Resend (https://resend.com), over its HTTP API — no SDK, one request. The `Idempotency-Key`
 * header is our message id, so a send that timed out and is retried cannot reach the guest twice.
 */
export class ResendProvider implements MessageProvider {
  readonly name = 'resend';
  readonly channel = 'email' as const;
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(m: OutgoingMessage) {
    if (!m.from) throw new ProviderError('No sender address is set in message settings.', false);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.id },
        body: JSON.stringify({
          from: `${m.from.name.replace(/[<>"]/g, '')} <${m.from.address}>`,
          to: [m.to],
          subject: m.subject ?? '',
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
          ...(m.replyTo ? { reply_to: m.replyTo } : {}),
          ...(m.attachments.length ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType })) } : {}),
          tags: m.tags,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ProviderError(`Could not reach Resend: ${(err as Error).message}`, true);
    }
    const body = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (res.ok && body.id) return { providerMessageId: body.id };
    // 429 and 5xx are the provider's problem and pass; 4xx means this message will never be accepted.
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`Resend ${res.status}: ${body.message ?? body.name ?? 'rejected the message'}`, retryable);
  }
}

/**
 * Development and tests: records the message as sent and keeps it in memory, so a test can read what
 * would have gone out. Never used in production (config refuses it).
 */
export class DevProvider implements MessageProvider {
  readonly name = 'dev';
  readonly channel = 'email' as const;
  readonly sent: OutgoingMessage[] = [];
  /** Tests set this to make the next sends fail. */
  failNext: { message: string; retryable: boolean; times: number } | null = null;

  async send(m: OutgoingMessage) {
    if (this.failNext && this.failNext.times > 0) {
      this.failNext.times -= 1;
      throw new ProviderError(this.failNext.message, this.failNext.retryable);
    }
    this.sent.push(m);
    return { providerMessageId: `dev_${m.id}` };
  }
}

export const MESSAGE_PROVIDERS = Symbol('MESSAGE_PROVIDERS');

export function providersFor(config: AppConfig): MessageProvider[] {
  switch (config.MESSAGING_PROVIDER) {
    case 'resend': return [new ResendProvider(config.RESEND_API_KEY!, config.RESEND_API_URL)];
    case 'dev': return [new DevProvider()];
    default: return [];
  }
}

/**
 * Resend signs webhooks with Svix: HMAC-SHA256 over `id.timestamp.body`, keyed with the
 * base64 part of the `whsec_` secret, sent as one or more `v1,<base64>` signatures. Rejects
 * anything older than five minutes, so a captured webhook cannot be replayed later.
 */
export function verifySvixSignature(
  secret: string, headers: { id?: string; timestamp?: string; signature?: string }, rawBody: Buffer, nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.`).update(rawBody).digest();
  return headers.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
