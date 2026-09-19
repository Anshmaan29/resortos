/**
 * Runs pg_dump / pg_restore / psql, whichever way this machine can.
 *
 * Client and server versions must match: pg_dump refuses to talk to a newer server. Rather than
 * depend on the right client being installed everywhere, this uses the tools inside the database
 * container when they are not on PATH — which is the normal case on a developer's Mac.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

function onPath(tool) {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * How to invoke Postgres tools here.
 * - `native`: the tool is on PATH (CI, a Linux server) and talks to the URL as given.
 * - `compose`: run it inside the compose `postgres` service, where the database is on port 5432.
 */
export function pgToolStrategy() {
  if (process.env.RESORTOS_PG_TOOLS === 'native' || onPath('pg_dump')) return 'native';
  return 'compose';
}

/** Rewrites a host URL for use *inside* the database container. */
function insideContainer(url) {
  return url.replace(/@[^/]+\//, '@localhost:5432/');
}

/**
 * Spawns a Postgres tool. Returns { stdout, stderr, code } with stdout as a Buffer, so a custom
 * format dump — which is binary — survives intact.
 */
export function runPgTool(tool, args, { url, stdin, cwd } = {}) {
  const strategy = pgToolStrategy();
  const full = strategy === 'compose'
    ? ['docker', ['compose', 'exec', '-T', 'postgres', tool, ...args.map((a) => (a === '@url' ? insideContainer(url) : a))]]
    : [tool, args.map((a) => (a === '@url' ? url : a))];

  return new Promise((resolve, reject) => {
    const child = spawn(full[0], full[1], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
