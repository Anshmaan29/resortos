import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * We do not accept file uploads over the API — photos and ID scans go straight to object storage
 * through pre-signed PUTs (spec §19.4) — but `@nestjs/platform-express` pins `multer` exactly at
 * 2.2.0 and its barrel `require`s the upload interceptors eagerly, so multer is loaded into every
 * API process whether we use it or not. 2.2.0 carries four advisories, so the root
 * `pnpm.overrides` raises it. This test guards the two things that override could break.
 *
 * See docs/dependency-security.md for why the pin is 2.3.0 and not latest.
 */
// The API compiles to CommonJS, so `require` is the resolver here. multer is not a dependency of
// ours: it is only reachable from inside @nestjs/platform-express, which is where it matters.
const fromPlatformExpress = createRequire(require.resolve('@nestjs/platform-express'));

describe('multer, pinned by pnpm.overrides above what Nest asks for', () => {
  it('is a version with no known advisory', () => {
    const { version } = fromPlatformExpress('multer/package.json') as { version: string };
    const [major, minor] = version.split('.').map(Number);
    // Everything below 2.3.0 is vulnerable (GHSA-wc9g-mqfw-jrwm and three more).
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(3);
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

  it('still produces the error messages Nest maps to HTTP statuses', () => {
    // Nest's transformException() switches on the error *message*, not the code, so a renamed
    // message downgrades a clean 400 into a 500. multer 2.4.0 renames LIMIT_UNEXPECTED_FILE,
    // which is exactly why the override pins 2.3.0.
    const { MulterError } = fromPlatformExpress('multer') as {
      MulterError: new (code: string) => Error;
    };
    const { multerExceptions } = fromPlatformExpress(
      '@nestjs/platform-express/multer/multer/multer.constants',
    ) as { multerExceptions: Record<string, string> };

    expect(Object.keys(multerExceptions).length).toBeGreaterThan(0);
    for (const [code, expected] of Object.entries(multerExceptions)) {
      expect(new MulterError(code).message, code).toBe(expected);
    }
  });
});
