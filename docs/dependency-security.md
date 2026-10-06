# Dependency security

Priority order (CLAUDE.md): **Data safety → Correctness → Security → …**. This system stores scans
of guests' identity documents, so an open high-severity advisory in the software handling them is
treated as a build failure, not a notification to read later.

## The gate

`pnpm audit` is run by `ops/ci/audit.mjs`, wired into CI as its own job (`Dependency advisories`)
and available locally as `pnpm audit`:

- **high and critical fail the build**, unless the advisory has a live acceptance (below).
- **moderate and low are printed, never fatal.** They are reviewed at each milestone. Making them
  blocking would train us to rubber-stamp acceptances, which is worse than reading a list.
- The gate reads only the lockfile. Nothing is installed, so no package's install script runs.

The job is separate from the test job so a vulnerable lockfile is visible in seconds rather than
after a thirty-minute build, and so neither failure hides the other.

## Accepting an advisory, with an expiry

Sometimes the fix is not ours to make: an upstream package pins a vulnerable dependency, and the
patched version is not out. `ops/security/accepted-advisories.json` is where that decision is
recorded — deliberately not as a permanent mute:

```json
{
  "ghsa": "GHSA-xxxx-xxxx-xxxx",
  "package": "some-package",
  "reason": "Upstream pins it; the maintainer's fix is in review (link).",
  "unexploitable_because": "The vulnerable code path is never reached — we have no such route.",
  "accepted_by": "Anshmaan (owner)",
  "accepted_on": "2026-09-18",
  "expires_on": "2026-10-18"
}
```

Every field is required. The gate then enforces the parts that make it a real decision:

| Rule | Why |
|---|---|
| **The build fails the day an acceptance expires** | The alternative is a mute nobody revisits. An expiry means the question comes back on a known date. |
| `expires_on − accepted_on` may not exceed `maxAcceptanceDays` (90) | Nothing can be accepted indefinitely, even by mistake. |
| `accepted_by` and `unexploitable_because` must be filled in | An acceptance is a named person's judgement about a specific code path, not a checkbox. |
| Stale entries are reported | Once the advisory leaves the lockfile the entry is dead weight, and dead entries make the file untrustworthy. |
| An unparseable or incomplete entry fails the build | A broken acceptance must never read as a passing one. |

Renewing is not automatic: it means writing a new `accepted_on` and a fresh reason, which is the
point.

## The multer pin — a worked example

`@nestjs/platform-express@11.2.5` depends on `multer` **pinned exactly at 2.2.0**, which carries
four advisories (three high, one low): GHSA-wc9g-mqfw-jrwm, GHSA-qfvm-cv95-jqjf, GHSA-535w-7cp7-47q4
and GHSA-qvfw-j98x-7q72. All four are fixed in **2.3.0**. Because the range is exact, Dependabot
cannot resolve a bump on its own — which is why its update job kept failing while the alerts stayed
open.

Resolved with a root `pnpm.overrides` entry raising multer to 2.3.0 for the whole workspace. Three
things were checked before taking it:

1. **The API it exposes.** Nest calls `multer()`, `.single()`, `.array()`, `.fields()`, `.none()`,
   `.any()`, plus `diskStorage`, `memoryStorage` and `MulterError`. All present and unchanged.
2. **The error messages.** `transformException()` in platform-express maps multer failures to HTTP
   statuses by matching the error **message string**, not the code. **2.4.0 — the latest release —
   renames `LIMIT_UNEXPECTED_FILE` from `Unexpected field` to `Unexpected file field`**, which would
   silently turn a clean 400 into a 500 for anyone who later adds a file interceptor. 2.3.0 keeps
   every message Nest expects, so the pin is 2.3.0 and not latest. `apps/api/test/dependency-pins.test.ts`
   asserts this, so the next bump cannot break it quietly.
3. **The full suite** — build, typecheck, unit, API integration and E2E — passed on the override.

### Could the upload middleware be dropped instead?

Not cleanly, and we do not need it to. Verified: `@nestjs/core` loads the adapter with
`require('@nestjs/platform-express')`, whose barrel eagerly re-exports `./multer`, which `require`s
multer at module load. So multer is **resident in every API process** (22 of its modules enter
`require.cache`) and cannot be excluded without patching Nest or moving to Fastify.

What is true — and is the reason this was never an exposure in practice — is that **multer's parsing
code never runs**:

- No route uses `FileInterceptor`, `FilesInterceptor`, `AnyFilesInterceptor` or `MulterModule`, so
  no multer instance is ever constructed and no multipart middleware is mounted.
- The API accepts no file uploads at all. Photos and ID scans go **browser → object storage**
  through a pre-signed PUT bound to content-type, length and SHA-256; the API only ever sees the
  key and re-reads the object to verify its checksum (spec §19.4).
- All four advisories are denial-of-service in multipart field parsing, reachable only through a
  mounted multer middleware.

Patching Nest to make the require lazy was considered and rejected: a `pnpm patch` on a framework
package is its own maintenance burden at every Nest upgrade, and the override removes the finding
outright. The conclusion is recorded here so that **whoever adds the first upload route knows that
multer is already loaded, that the pin is deliberate, and that 2.4.0's renamed message would break
Nest's error mapping.**


## Review on 6 October 2026

Next.js is updated to 16.3.6 for GHSA-vcvr-r3jv-pc5j; `source-map-js` is overridden to 1.2.2 for GHSA-68fv-2mgg-jv7q. The high/critical gate passes against the resulting lockfile.

Multer 2.3.0 now has a moderate advisory, GHSA-3pph-fpjx-jg34 (aborted uploads with orphaned disk writes), fixed in 2.4.0. The existing Nest error-message compatibility issue above remains. The API still exposes no multipart interceptors: guests upload directly to private object storage. This finding is printed by the gate and must be revisited before adding an API upload route. The compatibility test makes no claim that 2.3.0 has no known advisories.
