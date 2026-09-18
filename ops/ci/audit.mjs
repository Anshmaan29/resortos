#!/usr/bin/env node
/**
 * Dependency vulnerability gate.
 *
 * Fails the build on any high or critical advisory in the lockfile unless it has a live, dated
 * acceptance in ops/security/accepted-advisories.json. Lower severities are printed, never fatal —
 * they are reviewed at each milestone rather than blocking a push.
 *
 * Priority order in CLAUDE.md puts data safety and security above features, and this system holds
 * scans of guests' identity documents. An open high alert on the software that handles them is not
 * something to carry quietly, so the default is to stop the build and make it a decision.
 *
 * Run it anywhere: `node ops/ci/audit.mjs`.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCEPTANCES = join(ROOT, 'ops', 'security', 'accepted-advisories.json');
const BLOCKING = new Set(['high', 'critical']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** `pnpm audit` exits non-zero when it finds anything, so the exit code is not the signal — the JSON is. */
async function runAudit() {
  try {
    const { stdout } = await promisify(execFile)('pnpm', ['audit', '--json'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) return error.stdout;
    throw new Error(`pnpm audit could not run: ${error.stderr?.trim() || error.message}`);
  }
}

function parseDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`${label} is not a real date: ${value}`);
  return at;
}

/** An acceptance is only usable if it is complete, honestly dated, and within the maximum window. */
function readAcceptances(today) {
  const file = JSON.parse(readFileSync(ACCEPTANCES, 'utf8'));
  const maxDays = file.maxAcceptanceDays ?? 90;
  const problems = [];
  const live = new Map();
  const expired = [];

  for (const [index, entry] of (file.accepted ?? []).entries()) {
    const where = `accepted[${index}]`;
    try {
      for (const field of ['ghsa', 'package', 'reason', 'unexploitable_because', 'accepted_by', 'accepted_on', 'expires_on']) {
        if (!entry[field] || String(entry[field]).trim() === '') throw new Error(`${where} is missing ${field}`);
      }
      const acceptedOn = parseDate(entry.accepted_on, `${where}.accepted_on`);
      const expiresOn = parseDate(entry.expires_on, `${where}.expires_on`);
      if (expiresOn <= acceptedOn) throw new Error(`${where}.expires_on must be after accepted_on`);
      if (expiresOn - acceptedOn > maxDays * DAY_MS) {
        throw new Error(`${where} runs ${Math.round((expiresOn - acceptedOn) / DAY_MS)} days; the maximum is ${maxDays}`);
      }
      if (expiresOn < today) expired.push(entry);
      else live.set(entry.ghsa, { ...entry, expiresOn });
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { live, expired, problems };
}

const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const { live, expired, problems } = readAcceptances(today);
const audit = JSON.parse(await runAudit());

const found = Object.values(audit.advisories ?? {}).map((a) => ({
  ghsa: a.github_advisory_id,
  package: a.module_name,
  severity: a.severity,
  title: a.title,
  vulnerable: a.vulnerable_versions,
  patched: a.patched_versions,
  versions: [...new Set((a.findings ?? []).map((f) => f.version))].join(', '),
  url: a.url,
}));

const blocking = found.filter((a) => BLOCKING.has(a.severity));
const lower = found.filter((a) => !BLOCKING.has(a.severity));
const unaccepted = blocking.filter((a) => !live.has(a.ghsa));
const accepted = blocking.filter((a) => live.has(a.ghsa));
const leftovers = [...live.values()].filter((entry) => !found.some((a) => a.ghsa === entry.ghsa));

const line = (a) => `  ${a.severity.toUpperCase().padEnd(8)} ${a.package} ${a.versions} — ${a.title}\n           vulnerable ${a.vulnerable}, fixed in ${a.patched}\n           ${a.url}`;

if (lower.length) {
  console.log(`\nBelow the gate (reviewed, not blocking) — ${lower.length}:`);
  for (const a of lower) console.log(line(a));
}
if (accepted.length) {
  console.log(`\nAccepted, with an expiry — ${accepted.length}:`);
  for (const a of accepted) {
    const entry = live.get(a.ghsa);
    const daysLeft = Math.ceil((entry.expiresOn - today) / DAY_MS);
    console.log(`${line(a)}\n           accepted by ${entry.accepted_by} on ${entry.accepted_on}, expires ${entry.expires_on} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left)`);
    console.log(`           because: ${entry.unexploitable_because}`);
  }
}
if (leftovers.length) {
  console.log(`\nStale acceptances — these advisories are no longer in the lockfile, delete the entries:`);
  for (const entry of leftovers) console.log(`  ${entry.ghsa} (${entry.package})`);
}

const failures = [];
for (const problem of problems) failures.push(`Unusable acceptance: ${problem}`);
for (const entry of expired) {
  failures.push(`The acceptance for ${entry.ghsa} (${entry.package}) expired on ${entry.expires_on}. Fix the dependency, or renew the acceptance with a fresh decision and date.`);
}
for (const a of unaccepted) {
  failures.push(`${a.severity} in ${a.package} ${a.versions}: ${a.title} (${a.ghsa}). Fix it, or add a dated acceptance to ops/security/accepted-advisories.json — see docs/dependency-security.md.`);
}

if (failures.length) {
  console.error(`\n✗ Dependency audit failed:\n${failures.map((f) => `  • ${f}`).join('\n')}\n`);
  process.exit(1);
}

console.log(`\n✓ No unaccepted high or critical advisories (${audit.metadata?.totalDependencies ?? '?'} dependencies scanned).\n`);
