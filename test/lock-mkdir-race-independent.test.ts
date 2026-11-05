// Synthetic paths and child processes only; no keys, CLI state, or nonzero signals.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardFixtures } from './fixture-cleanup.ts';

const base = mkdtempSync(join(tmpdir(), 'independent-lock-mkdir-'));
const worker = join(base, 'worker.ts');
const modulePath = join(import.meta.dir, '..', 'src', 'state.ts');
writeFileSync(worker, `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
const real = { ...fs };
const [scene, root] = process.argv.slice(2);
const dir = join(root, 'lock-folder');
const path = join(dir, 'team.lock');
let mkdirCalls = 0, openCalls = 0, workCalls = 0, nestedWork = 0;
let nestedError = null, during = null;
if (scene === 'file') real.writeFileSync(dir, 'sentinel');
if (scene === 'directory-link') { real.mkdirSync(join(root, 'target')); real.symlinkSync(join(root, 'target'), dir); }
if (scene === 'file-link') { real.writeFileSync(join(root, 'target'), 'sentinel'); real.symlinkSync(join(root, 'target'), dir); }
if (scene === 'dangling-link') real.symlinkSync(join(root, 'missing'), dir);
if (scene === 'key-link') {
  real.mkdirSync(dir); real.writeFileSync(join(root, 'target'), String(process.pid));
  real.symlinkSync(join(root, 'target'), path);
}
const fault = code => Object.assign(new Error(code), { code });
mock.module('node:fs', () => ({ ...real,
  mkdirSync: (at, options) => {
    if (String(at) !== dir) return real.mkdirSync(at, options);
    mkdirCalls++;
    if (scene === 'bounded') throw fault('EEXIST');
    if (scene === 'denied') throw fault('EACCES');
    const made = real.mkdirSync(at, options);
    if (scene === 'still-directory' && mkdirCalls === 1) throw fault('EEXIST');
    if (scene === 'removed' && mkdirCalls <= 2) { real.rmdirSync(dir); throw fault('EEXIST'); }
    return made;
  },
  openSync: (at, ...rest) => {
    if (String(at) === path) openCalls++;
    return real.openSync(at, ...rest);
  },
}));
const { withLock } = await import(${JSON.stringify(modulePath)});
let error = null;
try {
  withLock(dir, () => {
    workCalls++;
    during = real.readFileSync(path, 'utf8').trim();
    if (scene === 'still-directory' || scene === 'removed') {
      try { withLock(dir, () => { nestedWork++; }, { waitMs: 0 }); }
      catch (e) { nestedError = e.name; }
    }
  }, { waitMs: 0 });
} catch (e) { error = { name: e.name, code: e.code }; }
let nodeKind = 'absent';
try { const stat = real.lstatSync(dir); nodeKind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file'; } catch {}
console.log(JSON.stringify({ scene, mkdirCalls, openCalls, workCalls, nestedWork, nestedError, during, error, nodeKind,
  keyExists: real.existsSync(path), target: real.existsSync(join(root, 'target')) && !real.statSync(join(root, 'target')).isDirectory()
    ? real.readFileSync(join(root, 'target'), 'utf8') : null }));
`);
afterAll(() => discardFixtures([base]));

async function run(scene: string) {
  const root = join(base, scene);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const child = Bun.spawn([process.execPath, worker, scene, root], {
    env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(err).toBe(''); expect(code).toBe(0);
  const result = JSON.parse(out);
  console.log(JSON.stringify(result));
  return result;
}

for (const scene of ['still-directory', 'removed']) {
  test(`${scene}: recovery runs once and a second hold is refused`, async () => {
    const r = await run(scene);
    expect(r.error).toBeNull(); expect(r.workCalls).toBe(1);
    expect(r.nestedWork).toBe(0); expect(r.nestedError).toBe('LockBusyError');
    expect(r.during).toMatch(/^\d+$/); expect(r.keyExists).toBe(false);
    expect(r.mkdirCalls).toBe(scene === 'removed' ? 4 : 2);
  });
}
test('persistent mkdir EEXIST stops after the shared recreation allowance', async () => {
  const r = await run('bounded');
  expect(r.error?.code).toBe('EEXIST'); expect(r.mkdirCalls).toBe(9);
  expect(r.openCalls).toBe(0); expect(r.workCalls).toBe(0);
});
test('a different mkdir error is not retried', async () => {
  const r = await run('denied');
  expect(r.error?.code).toBe('EACCES'); expect(r.mkdirCalls).toBe(1);
  expect(r.openCalls).toBe(0); expect(r.workCalls).toBe(0);
});
for (const scene of ['file', 'file-link', 'dangling-link', 'directory-link']) {
  test(`${scene}: a real obstructing node refuses the work`, async () => {
    const r = await run(scene);
    expect(r.error).not.toBeNull(); expect(r.workCalls).toBe(0);
    expect(r.nodeKind).toBe(scene === 'file' ? 'file' : 'link');
    if (scene === 'file-link') expect(r.target).toBe('sentinel');
  });
}
test('an occupied key link does not grant another hold', async () => {
  const r = await run('key-link');
  expect(r.error?.name).toBe('LockBusyError'); expect(r.workCalls).toBe(0);
  expect(r.keyExists).toBe(true); expect(r.target).toMatch(/^\d+$/);
});
