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

## Patched image and upload dependencies (6 October 2026)

Root overrides now pin sharp 0.35.5 and multer 2.4.0. Sharp fixes GHSA-wq5f-xc86-pv6w in librsvg; multer fixes GHSA-3pph-fpjx-jg34 affecting aborted disk uploads. The audit gate remains enabled with no advisory acceptance entries.

Nest 11.2.5 pins an older multer and maps errors by message. Multer 2.4.0 changes `LIMIT_UNEXPECTED_FILE` to `Unexpected file field`. ResortOS never mounts multipart middleware: photos go directly to private object storage through constrained signed PUTs. The compatibility test verifies the API Nest loads, all error messages including this known change, and scans application source to prevent introduction of file interceptors while that Nest incompatibility exists. Adding multipart routes requires addressing the upstream mapping first; do not lower the security pin.

The patched sharp supplies corrected prebuilt librsvg binaries in the Railway image. Verify build, typecheck, API tests, browser uploads and the dependency audit after dependency changes.

References: [sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), [multer advisory](https://github.com/advisories/GHSA-3pph-fpjx-jg34).
