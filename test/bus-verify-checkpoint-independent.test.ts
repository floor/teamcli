// Independent checkpoint coverage: each read starts a fresh process over three fixture records.
// No bus server, daemon, pane or real credential directory is opened.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, eventLogPath, EVENT_DOMAIN } from '../src/bus/log.ts';
import { writeAtomic } from '../src/state.ts';
import { messageKeyOf, messageKeyPath, signDomain, type Json } from '../src/store/keys.ts';

const PROJECT = 'checkpoint-fixture';
const TS = '2026-11-01T18:00:00.000Z';
const DOMAIN = 'teamcli bus verify-checkpoint v1\n';
const KEPT = 3;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scene() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-checkpoint-independent-')));
  made.push(base);
  const root = join(base, 'project');
  const home = join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = eventLogPath(PROJECT, root, home);
  const checkpoint = join(dirname(log), 'verify-checkpoint.json');
  const at = { base, root, home, log, checkpoint };
  for (let n = 1; n <= 3; n++) append(at, n);
  return at;
}
type Scene = ReturnType<typeof scene>;

function append(at: Pick<Scene, 'root' | 'home'>, n: number) {
  const wrote = appendEvent(PROJECT, at.root, at.home, {
    ts: TS, kind: 'message.arrived', session: PROJECT, record_id: `fixture-${n}`,
  }, { kept: KEPT, retain: false });
  if (!wrote.ok) throw new Error('fixture event could not be appended');
}

type ReadReport = {
  ok: boolean; checked: number; full: boolean; unverified: number; pid: number;
  records: { seq: number; id: string | undefined }[];
};

function cold(at: Pick<Scene, 'root' | 'home'>, kept = KEPT): ReadReport {
  const source = new URL('../src/bus/log.ts', import.meta.url).href;
  const code = `import { readEvents } from ${JSON.stringify(source)};
const r = readEvents(${JSON.stringify(PROJECT)}, ${JSON.stringify(at.root)}, ${JSON.stringify(at.home)}, { kept: ${kept} });
if (!r.ok) throw new Error(r.reason);
process.stdout.write(JSON.stringify({ok:r.ok, checked:r.checked, full:r.full, unverified:r.unverified,
pid:process.pid, records:r.events.map(e=>({seq:e.payload.seq,id:e.payload.record_id}))}));`;
  const child = spawnSync(process.execPath, ['--eval', code], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HOME: at.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  // The child prints counters and public event IDs only, never keys or signed record bodies.
  if (child.status !== 0) throw new Error(`fixture reader failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as ReadReport;
}

function digest(at: Pick<Scene, 'log'>): string {
  // These fixtures contain only three well-formed records, so all retained bytes are covered.
  return createHash('sha256').update(fs.readFileSync(at.log)).digest('hex');
}

function signedCheckpoint(at: Scene, domain = DOMAIN) {
  const key = messageKeyOf(at.home);
  const fields = {
    format: 1,
    keyPrint: createHash('sha256').update(key.export({ type: 'pkcs8', format: 'pem' })).digest('hex'),
    kept: KEPT, seq: 3, digest: digest(at), store: dirname(at.log),
  };
  const record = { ...fields, signature: signDomain(domain, fields as Json, key) };
  fs.writeFileSync(at.checkpoint, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

test('a genuine checkpoint lets a distinct cold second process check zero records', () => {
  const at = scene();
  const first = cold(at);
  expect(first.checked).toBe(3);
  expect(first.full).toBe(true);
  const second = cold(at);
  expect(second.pid).not.toBe(first.pid);
  expect(second.pid).not.toBe(process.pid);
  expect(second.checked).toBe(0);
  expect(second.full).toBe(false);
  expect(second.records.map((r) => r.id)).toEqual(['fixture-1', 'fixture-2', 'fixture-3']);
  expect(fs.existsSync(at.checkpoint)).toBe(true);
});

test('a cold process verifies only a newly appended tail after a genuine checkpoint', () => {
  const at = scene();
  cold(at);
  append(at, 4);
  const next = cold(at);
  expect(next.checked).toBe(1);
  expect(next.full).toBe(false);
  expect(next.records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
});

test('an independently signed matching checkpoint is accepted by a cold reader', () => {
  const at = scene();
  signedCheckpoint(at);
  const read = cold(at);
  expect(read.checked).toBe(0);
  expect(read.full).toBe(false);
  expect(read.unverified).toBe(0);
  expect(read.records.map((r) => r.seq)).toEqual([1, 2, 3]);
});

const mutations = {
  format: (r: ReturnType<typeof signedCheckpoint>) => { r.format = 2; },
  keyPrint: (r: ReturnType<typeof signedCheckpoint>) => { r.keyPrint = '0'.repeat(64); },
  kept: (r: ReturnType<typeof signedCheckpoint>) => { r.kept = 2; },
  // Raising seq still covers the identical prefix bytes: the signature must bind this field.
  seq: (r: ReturnType<typeof signedCheckpoint>) => { r.seq = 4; },
  digest: (r: ReturnType<typeof signedCheckpoint>) => { r.digest = '0'.repeat(64); },
  store: (r: ReturnType<typeof signedCheckpoint>) => { r.store += '-other'; },
  signature: (r: ReturnType<typeof signedCheckpoint>) => { r.signature = '00'.repeat(64); },
};
for (const [field, mutate] of Object.entries(mutations)) {
  test(`mutating checkpoint ${field} forces a cold full verification`, () => {
    const at = scene();
    const record = signedCheckpoint(at);
    mutate(record);
    fs.writeFileSync(at.checkpoint, `${JSON.stringify(record)}\n`);
    const read = cold(at);
    expect(read.full).toBe(true);
    expect(read.checked).toBe(3);
    expect(read.unverified).toBe(0);
    expect(read.records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
}

test('a forged record is rejected even when its attacker recomputes the checkpoint digest', () => {
  const at = scene();
  const record = signedCheckpoint(at);
  const lines = fs.readFileSync(at.log, 'utf8').trimEnd().split('\n');
  const forged = JSON.parse(lines[1]!) as { payload: { record_id: string } };
  forged.payload.record_id = 'forged-record';
  lines[1] = JSON.stringify(forged);
  fs.writeFileSync(at.log, `${lines.join('\n')}\n`);
  record.digest = digest(at);
  fs.writeFileSync(at.checkpoint, `${JSON.stringify(record)}\n`);
  const read = cold(at);
  expect(read.full).toBe(true);
  expect(read.checked).toBe(3);
  expect(read.unverified).toBe(1);
  expect(read.records.map((r) => r.id)).toEqual(['fixture-1', 'fixture-3']);
});

test('without the message key no checkpoint or event is trusted and the read creates no key', () => {
  const at = scene();
  signedCheckpoint(at);
  fs.unlinkSync(messageKeyPath(at.home));
  const read = cold(at);
  expect(read.full).toBe(true);
  expect(read.checked).toBe(3);
  expect(read.unverified).toBe(3);
  expect(read.records).toEqual([]);
  expect(fs.existsSync(messageKeyPath(at.home))).toBe(false);
});

test('a signature from the event domain cannot authenticate a checkpoint', () => {
  const at = scene();
  signedCheckpoint(at, EVENT_DOMAIN);
  const read = cold(at);
  expect(read.full).toBe(true);
  expect(read.checked).toBe(3);
  expect(read.records).toHaveLength(3);
});

test('rewriting a genuine checkpoint to fit another store does not transfer its trust', () => {
  const at = scene();
  const record = signedCheckpoint(at);
  const otherRoot = join(at.base, 'other-project');
  fs.mkdirSync(otherRoot);
  const otherLog = eventLogPath(PROJECT, otherRoot, at.home);
  fs.mkdirSync(dirname(otherLog), { recursive: true, mode: 0o700 });
  fs.writeFileSync(otherLog, fs.readFileSync(at.log));
  record.store = dirname(otherLog);
  fs.writeFileSync(join(dirname(otherLog), 'verify-checkpoint.json'), `${JSON.stringify(record)}\n`);
  const read = cold({ root: otherRoot, home: at.home });
  expect(read.full).toBe(true);
  expect(read.checked).toBe(3);
  expect(read.records).toHaveLength(3);
});

test('atomic replacement chooses distinct temporary names without relying on their format', () => {
  const at = scene();
  const live = join(at.base, 'live.txt');
  const original = fs.writeFileSync;
  const temps: string[] = [];
  const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (String(path) !== live) temps.push(String(path));
    return Reflect.apply(original, fs, [path, ...rest]);
  }) as typeof fs.writeFileSync);
  try { writeAtomic(live, 'one\n'); writeAtomic(live, 'two\n'); }
  finally { spy.mockRestore(); }
  expect(temps).toHaveLength(2);
  expect(temps[0]).not.toBe(temps[1]);
  expect(fs.readFileSync(live, 'utf8')).toBe('two\n');
});

test('a link planted at each attempted temporary name is never written through or cleaned away', () => {
  const at = scene();
  const live = join(at.base, 'live.txt');
  const victim = join(at.base, 'untouched.txt');
  fs.writeFileSync(live, 'live before\n');
  fs.writeFileSync(victim, 'victim before\n');
  const original = fs.writeFileSync;
  const planted: string[] = [];
  const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    const name = String(path);
    if (name !== live && rest[0] === 'candidate\n') {
      fs.symlinkSync(victim, name);
      planted.push(name);
    }
    return Reflect.apply(original, fs, [path, ...rest]);
  }) as typeof fs.writeFileSync);
  let threw = false;
  try { writeAtomic(live, 'candidate\n'); } catch { threw = true; }
  finally { spy.mockRestore(); }
  expect(fs.readFileSync(victim, 'utf8')).toBe('victim before\n');
  expect(fs.readFileSync(live, 'utf8')).toBe('live before\n');
  expect(threw).toBe(true);
  expect(planted.length).toBeGreaterThan(0);
  for (const path of planted) {
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path)).toBe(victim);
  }
});

test('failed rename keeps the live bytes and removes only the temporary this call created', () => {
  const at = scene();
  const live = join(at.base, 'live.txt');
  const other = join(at.base, 'somebody-elses.tmp');
  fs.writeFileSync(live, 'live before\n');
  fs.writeFileSync(other, 'unrelated\n');
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const temps: string[] = [];
  const write = spyOn(fs, 'writeFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (String(path) !== live) temps.push(String(path));
    return Reflect.apply(originalWrite, fs, [path, ...rest]);
  }) as typeof fs.writeFileSync);
  const rename = spyOn(fs, 'renameSync').mockImplementation(((from: unknown, to: unknown) => {
    if (String(to) === live) throw Object.assign(new Error('synthetic rename refusal'), { code: 'EACCES' });
    return Reflect.apply(originalRename, fs, [from, to]);
  }) as typeof fs.renameSync);
  try { expect(() => writeAtomic(live, 'candidate\n')).toThrow('synthetic rename refusal'); }
  finally { rename.mockRestore(); write.mockRestore(); }
  expect(fs.readFileSync(live, 'utf8')).toBe('live before\n');
  expect(fs.readFileSync(other, 'utf8')).toBe('unrelated\n');
  expect(temps).toHaveLength(1);
  expect(fs.existsSync(temps[0]!)).toBe(false);
});
