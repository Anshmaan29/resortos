import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * We do not accept file uploads over the API — photos and ID scans go straight to object storage
 * through pre-signed PUTs (spec §19.4) — but `@nestjs/platform-express` pins `multer` exactly at
 * 2.2.0 and its barrel `require`s the upload interceptors eagerly, so multer is loaded into every
 * API process whether we use it or not. 2.2.0 carries four advisories, so the root
 * `pnpm.overrides` raises it. This test guards the two things that override could break.
 *
 * See docs/dependency-security.md for why the pin is 2.4.0 and how its changed message is contained.
 */
// The API compiles to CommonJS, so `require` is the resolver here. multer is not a dependency of
// ours: it is only reachable from inside @nestjs/platform-express, which is where it matters.
const fromPlatformExpress = createRequire(require.resolve('@nestjs/platform-express'));

describe('multer, pinned by pnpm.overrides above what Nest asks for', () => {
  it('keeps the compatible minimum version above the older parser advisories', () => {
    const { version } = fromPlatformExpress('multer/package.json') as { version: string };
    const [major, minor] = version.split('.').map(Number);
    // Everything below 2.3.0 is vulnerable (GHSA-wc9g-mqfw-jrwm and three more).
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(4);
  });

  it('still offers the API Nest calls, so the Express adapter loads', () => {
    const multer = fromPlatformExpress('multer') as ((options: object) => Record<string, unknown>) & Record<string, unknown>;
    const instance = multer({});
    for (const method of ['single', 'array', 'fields', 'none', 'any']) {
      expect(typeof instance[method], `multer().${method}`).toBe('function');
    }
    for (const staticMember of ['diskStorage', 'memoryStorage', 'MulterError']) {
      expect(typeof multer[staticMember], `multer.${staticMember}`).toBe('function');
    }
  });

  it('tracks the changed unexpected-file message and forbids unsupported API multipart interceptors', () => {
    // Nest's transformException() switches on the error *message*, not the code, so a renamed
    // message would downgrade a 400 into a 500. We use no multipart interceptors; guard
    // that fact before accepting the one known renamed message in patched multer 2.4.0.
    const { MulterError } = fromPlatformExpress('multer') as {
      MulterError: new (code: string) => Error;
    };
    const { multerExceptions } = fromPlatformExpress(
      '@nestjs/platform-express/multer/multer/multer.constants',
    ) as { multerExceptions: Record<string, string> };

    const source = resolve(__dirname, '../src');
    const files = readdirSync(source, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.ts') && !f.name.endsWith('.test.ts'));
    for (const f of files) {
      expect(readFileSync(resolve(f.parentPath, f.name), 'utf8'), f.name).not.toMatch(/\b(?:FileInterceptor|FilesInterceptor|FileFieldsInterceptor|AnyFilesInterceptor|MulterModule)\b/);
    }
    expect(Object.keys(multerExceptions).length).toBeGreaterThan(0);
    for (const [code, expected] of Object.entries(multerExceptions)) {
      expect(new MulterError(code).message, code).toBe(code === 'LIMIT_UNEXPECTED_FILE' ? 'Unexpected file field' : expected);
    }
  });
});
