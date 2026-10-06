import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// One public service runs the web app and API; only the web port is exposed.
// A failure in either child stops the service so Railway can restart both together.
export async function supervise({ services, readyUrl, timeoutMs = 90_000, graceMs = 20_000 }) {
  const children = new Set();
  let stopping = false;
  let resolveDone;
  const done = new Promise((resolveResult) => { resolveDone = resolveResult; });
  let shutdownTimer;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    shutdownTimer = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
    }, graceMs);
    const finish = () => {
      if (children.size) return;
      clearTimeout(shutdownTimer);
      resolveDone(code);
    };
    for (const child of children) child.once('exit', finish);
    finish();
  };
  const onTerm = () => stop(0);
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
  const launch = (service) => {
    const child = spawn(process.execPath, service.args, { cwd: service.cwd, env: service.env, stdio: 'inherit' });
    children.add(child);
    child.once('error', () => {
      children.delete(child);
      console.error(`Could not start ${service.name}.`);
      stop(1);
    });
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (!stopping) {
        console.error(`${service.name} stopped (${signal ?? code}); stopping the service.`);
        stop(1);
      }
    });
    return child;
  };
  try {
    launch(services[0]);
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(readyUrl, { signal: AbortSignal.timeout(1_000) });
        ready = response.ok;
      } catch { /* API is still starting. */ }
      if (ready) break;
      await Promise.race([delay(250), done]);
    }
    if (!stopping && !ready) {
      console.error('API did not become ready; check database setup and service logs.');
      stop(1);
    }
    if (!stopping) launch(services[1]);
    return await done;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onTerm);
    clearTimeout(shutdownTimer);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 4000) {
    console.error('PORT must be a valid public port other than the internal API port 4000.');
    process.exitCode = 1;
  } else {
    const env = { ...process.env, API_PORT: '4000' };
    process.exitCode = await supervise({
      services: [
        { name: 'API', cwd: resolve(root, 'apps/api'), args: ['dist/main.js'], env },
        { name: 'Web', cwd: resolve(root, 'apps/web'), args: ['node_modules/next/dist/bin/next', 'start', '--port', String(port), '--hostname', '0.0.0.0'], env },
      ],
      readyUrl: 'http://127.0.0.1:4000/api/v1/health/db',
    });
  }
}
