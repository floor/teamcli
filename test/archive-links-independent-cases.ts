// Real filesystem obstacles and signed fixtures; foreign ownership alone is simulated.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rules from '../src/launch/rules-file.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './archive-links-home-fixture.ts';
const load = (name: string): Promise<any> => import(pathToFileURL(join(import.meta.dir, '../src', name)).href);
const NOW = new Date('2026-11-02T12:00:00.000Z'), OLD = new Date('2026-10-01T12:00:00.000Z'), DAY = NOW.toISOString().slice(0, 10), SESSION = 'archive-scene';
const owned: string[] = [], restores: { mockRestore(): void }[] = [];
afterEach(() => { for (const s of restores.splice(0)) s.mockRestore(); for (const p of owned.splice(0)) releaseIndependentFixture(p); });
test('archive modules load only after synthetic HOME startup', assertIndependentHome);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function snapshot(at: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string, key: string) {
    let stat; try { stat = lstatSync(path); } catch { return; }
    if (stat.isSymbolicLink()) result[key] = 'link:' + readlinkSync(path);
    else if (stat.isFIFO()) result[key] = 'fifo';
    else if (stat.isFile()) result[key] = digest(readFileSync(path));
    else if (stat.isDirectory()) { result[key] = 'directory'; for (const n of readdirSync(path).sort()) walk(join(path, n), key + '/' + n); }
    else result[key] = 'other';
  }
  walk(at, ''); return result;
}
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-matrix-'))); owned.push(base);
  const root = join(base, 'project'), agents = join(root, '.agents'), home = join(base, 'home'), other = join(base, 'other-team'), outside = join(base, 'outside');
  for (const p of [agents, home, other, outside]) mkdirSync(p, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv() });
  const text = `format: 1
project: archive-fixture
session: ${SESSION}
operator: captain
workspace:
  mode: shared
seats:
  - name: captain
    role: orchestrator
    leads: true
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
  - name: worker
    role: worker
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
`;
  writeFileSync(join(agents, 'team.yaml'), text); writeFileSync(join(other, 'live-message'), 'other team bytes never move'); writeFileSync(join(outside, 'sentinel'), 'outside bytes never change');
  return { base, root, agents, home, text, other, outside };
}
type World = ReturnType<typeof world>;
type Kind = 'link' | 'fifo' | 'file' | 'foreign';
function obstacle(w: World, path: string, kind: Kind) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (kind === 'link') symlinkSync(w.outside, path);
  else if (kind === 'fifo') execFileSync('mkfifo', [path]);
  else if (kind === 'file') writeFileSync(path, 'not a folder');
  else {
    mkdirSync(path, { mode: 0o700 });
    const original = rules.heldAt;
    restores.push(spyOn(rules, 'heldAt').mockImplementation(at => {
      const read = original(at);
      return resolve(at) === resolve(path) && read.kind === 'folder' ? { ...read, uid: (process.getuid?.() ?? 0) + 10001 } : read;
    }));
  }
}
async function family(w: World, store: 'send-drops' | 'messages', status: 'read' | 'unread' | 'fresh' | 'pending' = 'read') {
  const api = await load('commands/messages.ts'), rec = await load('send/record.ts'), keys = await load('store/keys.ts');
  const id = randomUUID(); let files: string[];
  if (store === 'send-drops') {
    const path = api.plantRecord(w.home, w.root, SESSION, 'worker', id, 'signed archived payload ' + id, { at: OLD.toISOString(), from: 'captain' });
    files = [path];
    if (status !== 'unread') {
      const receipt = rec.signReceiptPayload({ kind: 'receipt', status: 'read', id, to: 'worker', root: w.root, session: SESSION, at: OLD.toISOString() }, w.home);
      const result = rec.writeReceipt(dirname(path), receipt, w.home); if (!result.ok) throw new Error(result.reason);
      files.push(join(dirname(path), id + '.read.json'));
    }
    if (status === 'pending') { const p = join(dirname(path), id + '.pending'); writeFileSync(p, 'pending handoff'); files.push(p); }
  } else {
    api.plantMessage(w.home, w.root, 'worker', id, { kind: 'message', id, from: 'captain', to: 'worker', root: w.root, session: SESSION, at: OLD.toISOString(), body: 'legacy signed payload ' + id });
    const path = join(w.agents, 'messages/worker', id + '.json'); files = [path];
    const payload = { kind: 'receipt', id, to: 'worker', root: w.root, session: SESSION, at: OLD.toISOString() };
    const receipt = { payload, signature: keys.signDomain(keys.RECEIPT_DOMAIN, payload, keys.messageKeyOf(w.home)) };
    const p = join(dirname(path), id + '.read.json'); writeFileSync(p, JSON.stringify(receipt)); files.push(p);
  }
  for (const p of files) utimesSync(p, status === 'fresh' ? NOW : OLD, status === 'fresh' ? NOW : OLD);
  return { id, files, bytes: new Map(files.map(p => [p, readFileSync(p)])) };
}
async function scoped(w: World) {
  const { runArchive } = await load('commands/archive.ts');
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runArchive(['--seat', 'worker', '--older-than', '7d'], io, { home: w.home, now: () => NOW, sessionRunning: () => false, agents: () => [], alive: () => false, screen: () => ({ kind: 'idle' }), screenText: () => '', status: () => 'idle', foreground: () => [], sleep: async () => {}, launch: { typeText: () => { throw Error('typing'); }, sendKey: () => false, pressEnter: () => false, agentPanes: () => [], closeWorkspace: () => { throw Error('close'); }, stopSession: () => { throw Error('stop'); }, kill: () => { throw Error('signal'); }, sleep: async () => {}, now: () => NOW } });
  return { code, text: io.out + io.err };
}
function archives(w: World) { return Object.fromEntries(['send-drops-archive', 'messages-archive', 'archive-manifests'].map(name => [name, snapshot(join(w.agents, name))])); }
if (process.env.TEAM_ARCHIVE_KIND === 'scoped') {
  const components = [
    ['send-drops', 'send-drops-archive'], ['send-drops', `send-drops-archive/${DAY}`], ['send-drops', `send-drops-archive/${DAY}/${SESSION}`], ['send-drops', `send-drops-archive/${DAY}/${SESSION}/worker`],
    ['messages', 'messages-archive'], ['messages', `messages-archive/${DAY}`], ['messages', `messages-archive/${DAY}/worker`],
    ['send-drops', 'archive-manifests'], ['send-drops', `archive-manifests/${DAY}`],
  ] as const;
  for (const [store, relative] of components) for (const kind of ['link', 'fifo', 'file', 'foreign'] as const) test(`scoped ${store}: refuse ${kind} at ${relative} before payload writes`, async () => {
    const w = world(), f = await family(w, store), live = await family(w, 'send-drops', 'unread');
    if (!relative.startsWith('archive-manifests')) mkdirSync(join(w.agents, 'archive-manifests', DAY), { recursive: true, mode: 0o700 });
    obstacle(w, join(w.agents, relative), kind);
    const before = archives(w), outside = snapshot(w.outside), other = snapshot(w.other);
    const out = await scoped(w);
    expect(out.code, out.text).toBe(1);
    for (const [p, bytes] of [...f.bytes, ...live.bytes]) expect(readFileSync(p)).toEqual(bytes);
    expect(archives(w)).toEqual(before); expect(snapshot(w.outside)).toEqual(outside); expect(snapshot(w.other)).toEqual(other);
  });
  test('scoped success preserves live families and every manifest row describes real destination bytes', async () => {
    const w = world(), due = [await family(w, 'send-drops'), await family(w, 'messages')], stays = [await family(w, 'send-drops', 'unread'), await family(w, 'send-drops', 'fresh'), await family(w, 'send-drops', 'pending')];
    const other = snapshot(w.other), out = await scoped(w); expect(out.code, out.text).toBe(0);
    for (const f of stays) for (const [p, bytes] of f.bytes) expect(readFileSync(p)).toEqual(bytes);
    const folder = join(w.agents, 'archive-manifests', DAY), manifests = readdirSync(folder); expect(manifests).toHaveLength(1);
    const rows = readFileSync(join(folder, manifests[0]!), 'utf8').trim().split('\n').slice(1); expect(rows).toHaveLength(4);
    const expected = new Map(due.flatMap(f => [...f.bytes].map(([p, bytes]) => [p, bytes] as const)));
    for (const row of rows) {
      const [sha, size, src, dest] = row.split('\t'); const bytes = readFileSync(join(w.root, dest!));
      expect(digest(bytes)).toBe(sha!); expect(bytes.byteLength).toBe(Number(size)); expect(bytes).toEqual(expected.get(join(w.root, src!))!); expect(existsSync(join(w.root, src!))).toBe(false);
    }
    expect(snapshot(w.other)).toEqual(other);
  });
}

async function fallback(w: World, trying = false) {
  const api = await load('send/fallback-events.ts'), { validateTeamFile } = await load('file/validate.ts'), { historyPath } = await load('send/history.ts');
  const checked = validateTeamFile(w.text); if (!checked.ok) throw Error('invalid fallback fixture');
  const recipient = { team: 'archive-fixture', seat: 'worker', toId: null, session: SESSION, root: w.root }, id = randomUUID();
  const ctx = { caller: { kind: 'seat', name: 'captain', pane: 'fixture-pane', session: SESSION }, root: w.root, home: w.home, team: checked.team, now: () => NOW };
  const fact = { recipient, messageId: id, recordDigest: 'a'.repeat(64), route: 'native', outcome: trying ? 'held' : 'delivered', at: NOW.toISOString(), ms: 5, liveRoutesRemain: trying };
  const noted = api.noteTransport(ctx, fact); if (!noted.ok) throw Error(noted.reason);
  const store = dirname(historyPath(checked.team.project, w.root, w.home)), marker = api.markerPathOf(recipient, id), ledger = join(store, api.attemptLedgerFileName(recipient, id));
  const hash = digest(api.fallbackKeyOf(recipient, id)).slice(0, 16), archived = join(store, 'fallback-archive/markers', hash + '.json'), attempts = join(store, 'fallback-archive/attempts', api.attemptLedgerFileName(recipient, id));
  return { api, ctx, recipient, id, store, marker, ledger, archived, attempts };
}
if (process.env.TEAM_ARCHIVE_KIND === 'fallback') {
  for (const component of ['fallback-archive', 'fallback-archive/markers', 'fallback-archive/attempts']) for (const kind of ['link', 'fifo', 'file', 'foreign'] as const) test(`fallback: refuse ${kind} at ${component} before the archive marker write`, async () => {
    const w = world(), f = await fallback(w), live = await family(w, 'send-drops', 'unread');
    obstacle(w, join(f.store, component), kind);
    if (component.endsWith('/markers')) mkdirSync(join(f.store, 'fallback-archive/attempts'), { mode: 0o700 });
    if (component.endsWith('/attempts')) mkdirSync(join(f.store, 'fallback-archive/markers'), { mode: 0o700 });
    // Pre-existing valid sibling folders let this scene observe payload writes independently of mkdir.
    const archiveBefore = snapshot(join(f.store, 'fallback-archive')), outside = snapshot(w.outside), other = snapshot(w.other), marker = readFileSync(f.marker), ledger = readFileSync(f.ledger);
    const out = f.api.retireFinished(f.ctx, { at: NOW, lockWaitMs: 0 });
    expect(out.retired).toHaveLength(0); expect(out.refused).toHaveLength(1);
    expect(readFileSync(f.marker)).toEqual(marker); expect(readFileSync(f.ledger)).toEqual(ledger);
    for (const [p, bytes] of live.bytes) expect(readFileSync(p)).toEqual(bytes);
    expect(snapshot(join(f.store, 'fallback-archive'))).toEqual(archiveBefore); expect(snapshot(w.outside)).toEqual(outside); expect(snapshot(w.other)).toEqual(other);
  });
  test('fallback success retains message bytes and archives complete marker and attempts exactly once', async () => {
    const w = world(), f = await fallback(w), live = await family(w, 'send-drops', 'unread'), marker = JSON.parse(readFileSync(f.marker, 'utf8')), ledger = readFileSync(f.ledger), other = snapshot(w.other);
    const out = f.api.retireFinished(f.ctx, { at: NOW, lockWaitMs: 0 }); expect(out.refused).toEqual([]); expect(out.retired).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.archived, 'utf8'))).toEqual(marker); expect(readFileSync(f.attempts)).toEqual(ledger);
    expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.ledger)).toBe(false);
    for (const [p, bytes] of live.bytes) expect(readFileSync(p)).toEqual(bytes); expect(snapshot(w.other)).toEqual(other);
    const before = snapshot(join(f.store, 'fallback-archive')); expect(f.api.retireFinished(f.ctx, { at: NOW, lockWaitMs: 0 }).retired).toEqual([]); expect(snapshot(join(f.store, 'fallback-archive'))).toEqual(before);
  });
  test('fallback retry does not append an attempt ledger already archived before source cleanup', async () => {
    const w = world(), f = await fallback(w), bytes = readFileSync(f.ledger);
    mkdirSync(dirname(f.attempts), { recursive: true, mode: 0o700 }); writeFileSync(f.attempts, bytes);
    const out = f.api.retireFinished(f.ctx, { at: NOW, lockWaitMs: 0 }); expect(out.refused).toEqual([]); expect(out.retired).toHaveLength(1); expect(readFileSync(f.attempts)).toEqual(bytes);
  });
  test('fallback leaves an unfinished current episode and its message untouched', async () => {
    const w = world(), f = await fallback(w, true), marker = readFileSync(f.marker), ledger = readFileSync(f.ledger);
    const out = f.api.retireFinished(f.ctx, { at: NOW, lockWaitMs: 0 }); expect(out.retired).toEqual([]); expect(readFileSync(f.marker)).toEqual(marker); expect(readFileSync(f.ledger)).toEqual(ledger);
  });
}
