import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SESSION_HOURS_TRUSTED: z.coerce.number().int().min(1).max(24).default(12),
  SESSION_HOURS_DEFAULT: z.coerce.number().int().min(1).max(24).default(8),
  /** Public URL of the web app, used in phone-scanner QR codes (a LAN HTTPS address or tunnel in development). */
  PUBLIC_WEB_URL: z.string().url().optional(),
  /** S3 API endpoint used by the server (omit for AWS). Development: http://localhost:9000 (MinIO). */
  S3_ENDPOINT: z.string().url().optional(),
  /** Endpoint written into pre-signed URLs; must be reachable by browsers and phones. Defaults to S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Background job runner. Off in tests, which drive the dispatcher directly and deterministically. */
  JOBS_ENABLED: z.enum(['true', 'false']).optional().transform((v) => v === undefined ? undefined : v === 'true'),
}).transform((c) => ({ ...c, JOBS_ENABLED: c.JOBS_ENABLED ?? c.NODE_ENV !== 'test' }));

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Fail fast at boot with the names of bad variables — never their values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SECURE must be true in production');
  }
  if (parsed.data.NODE_ENV === 'production' && (parsed.data.S3_BUCKET.includes('-dev') || parsed.data.S3_BUCKET.includes('-test'))) {
    throw new Error('Production must use the production document bucket');
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
