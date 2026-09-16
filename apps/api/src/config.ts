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
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_DIR: z.string().min(1).default('storage'),
  STORAGE_SIGNING_SECRET: z.string().min(32).default('development-only-storage-signing-secret-change-me'),
});

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
  if (parsed.data.NODE_ENV === 'production' && parsed.data.STORAGE_SIGNING_SECRET.startsWith('development-only')) {
    throw new Error('STORAGE_SIGNING_SECRET must be set in production');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.STORAGE_DRIVER === 'local') {
    throw new Error('Local disk storage is for development only; production requires private, versioned, replicated object storage (spec §52)');
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
