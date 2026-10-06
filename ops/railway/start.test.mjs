import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { supervise } from './start.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'resortos-supervisor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const events = join(dir, 'events');
  const log = `import { appendFileSync } from 'node:fs'; const log=(v)=>appendFileSync(${JSON.stringify(events)},v+'\\n');`;
  const service = (name, source) => ({ name, cwd: dir, env: process.env, args: ['--input-type=module', '-e', log + source] });
  return { events, service, port, readyUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000, graceMs: 1000 };
}

test('starts web after API readiness and stops API when web fails', async (t) => {
  const f = await fixture(t);
  const code = await supervise({ ...f, services: [
    f.service('API', `import { createServer } from 'node:http'; const s=createServer((q,r)=>r.end('ok')); setTimeout(()=>s.listen(${f.port},'127.0.0.1',()=>log('api-ready')),100); process.on('SIGTERM',()=>{log('api-stopped');s.close(()=>process.exit(0));});`),
    f.service('Web', `log('web-started');setTimeout(()=>process.exit(7),100);`),
  ] });
  assert.equal(code, 1);
  assert.deepEqual((await readFile(f.events, 'utf8')).trim().split('\n'), ['api-ready', 'web-started', 'api-stopped']);
});

test('does not start web when API never becomes healthy', async (t) => {
  const f = await fixture(t);
  const code = await supervise({ ...f, timeoutMs: 350, services: [
    f.service('API', `log('api-started');setInterval(()=>{},1000);process.on('SIGTERM',()=>{log('api-stopped');process.exit(0);});`),
    f.service('Web', `log('web-started');`),
  ] });
  assert.equal(code, 1);
  assert.equal((await readFile(f.events, 'utf8')).includes('web-started'), false);
});

test('API startup failure exits without starting web', async (t) => {
  const f = await fixture(t);
  const code = await supervise({ ...f, services: [
    f.service('API', `log('api-failed');process.exit(1);`),
    f.service('Web', `log('web-started');`),
  ] });
  assert.equal(code, 1);
  assert.equal((await readFile(f.events, 'utf8')).trim(), 'api-failed');
});

test('termination signal stops children and exits successfully', async (t) => {
  const f = await fixture(t);
  const services = [
    f.service('API', `import { createServer } from 'node:http';const s=createServer((q,r)=>r.end('ok')).listen(${f.port},'127.0.0.1');process.on('SIGTERM',()=>{log('api-stopped');s.close(()=>process.exit(0));});`),
    f.service('Web', `log('web-started');setInterval(()=>{},1000);process.on('SIGTERM',()=>{log('web-stopped');process.exit(0);});`),
  ];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { supervise } from ${JSON.stringify(new URL('./start.mjs', import.meta.url).href)};
    import { readFileSync } from 'node:fs';
    const poll=setInterval(()=>{
      try { if(readFileSync(${JSON.stringify(f.events)},'utf8').includes('web-started')) { clearInterval(poll);process.kill(process.pid,'SIGTERM'); } } catch {}
    },25);
    process.exitCode=await supervise(${JSON.stringify({ services, readyUrl: f.readyUrl, timeoutMs: 3000, graceMs: 1000 })});
    clearInterval(poll);
  `], { timeout: 6000, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const events = await readFile(f.events, 'utf8');
  assert.ok(events.includes('api-stopped'));
  assert.ok(events.includes('web-stopped'));
});
