// Synthetic homes and units, with an inert runner beneath the real service adapter.
import { afterAll, afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { generalDoor } from '../src/client/general-door.ts';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, clientKeyDir, writeClientKeyFiles } from '../src/client/records.ts';
import { systemServiceManager } from '../src/daemon/service.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { keyOf } from '../src/store/keys.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
// The unit worlds hold client keys, which the product refuses inside the OS temp directory, so
// they live under the machine home. They sit inside one declared root — a subfolder of the home,
// never the home itself — so a machine without trash can still remove them within the cleanup
// bound, and nothing outside that root is ever a removal target.
const controlRoot = join(process.env.HOME!, '.cache', 'teamcli-test-controls');
fs.mkdirSync(controlRoot, { recursive: true });
const fixtureRoot = fs.realpathSync(fs.mkdtempSync(join(controlRoot, 'daemon-unit-no-key-')));
const bases: string[] = [];
afterEach(() => { const owned = bases.splice(0); if (owned.length) discardFixtures(owned, { roots: [fixtureRoot] }); }, 30_000);
afterAll(() => { discardFixtures([fixtureRoot], { roots: [controlRoot] }); });
const NOW = new Date('2026-11-01T16:00:00Z');
/** The reading the install's confirmation gate receives: the daemon the command just wrote
 *  answers, so a scene never opens the machine socket. */
const ANSWERING: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'running',
  running: true,
  pid: 42,
  uid: 501,
  since: '2026-11-01T00:00:00.000Z',
  startedBy: 'system-service-manager',
  version: 'test',
  gitHead: null,
  heartbeatAt: null,
  heartbeatSeconds: null,
  features: null,
  stuck: [],
  roots: [],
  probe: { state: 'answered', at: '2026-11-01T00:00:01.000Z' },
  why: null,
};
const FILE = `format: 1
project: unit-scene
session: unit-scene
operator: operator
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
  - role: operator
    name: operator
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
`;
function must<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  if (!value.ok) throw new Error(JSON.stringify(value)); return value as Extract<T, { ok: true }>;
}
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(fixtureRoot, 'unit-'))); bases.push(base);
  const root = join(base, 'r'); const dir = join(root, '.agents'); const home = join(base, 'h'); const entry = join(base, 'synthetic-entry.ts');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home); execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(join(dir, 'team.yaml'), FILE); fs.writeFileSync(entry, '// synthetic service program, never executed\n');
  updateState(dir, state => { const session = emptySession();
    session.seats.lead = { stage: 'ready', pane: 'synthetic-lead', workspace: 'synthetic-workspace' };
    session.seats.operator = { stage: 'ready', pane: 'synthetic-operator', workspace: 'synthetic-workspace' };
    state.sessions['unit-scene'] = session; });
  const calls: { command: string; args: string[] }[] = [];
  const manager = systemServiceManager({ platform: 'darwin', uid: 98765, now: () => NOW, sleep: () => {}, runner: (command, args) => {
    calls.push({ command, args }); return { status: 0, stdout: 'synthetic manager answer', stderr: '' };
  } }); assert.ok(manager);
  const pair = newClientKeyPair(); const keys = must(writeClientKeyFiles(clientKeyDir(home, 'unit-fixture'), pair));
  const grant = must(issueOwnerGeneralGrant(home, { clientId: 'unit-fixture', publicKey: pair.publicKey, entities: ['*'], ops: ['daemon'], mayIssue: false, expires: new Date(Date.now() + 86_400_000) }));
  return { base, root, dir, home, entry, calls, manager, keys, grant };
}
type World = ReturnType<typeof world>;
function sources(w: World) {
  return { home: w.home, service: w.manager, program: { execPath: process.execPath, entry: w.entry }, now: () => NOW,
    // The install confirms the daemon it wrote answers; this stands for that answer, and no
    // scene touches a socket or starts a process.
    health: async () => ANSWERING,
    start: async () => { throw new Error('unexpected synthetic daemon start'); },
  };
}
function ioFor(w: World, caller: Caller = { kind: 'owner' }) {
  const io = testIo(w.root, caller); io.env = { HOME: w.home, PATH: '/synthetic/bin' }; io.stdinIsTTY = caller.kind === 'owner'; return io;
}
function assertClean(w: World, text: string) {
  for (const value of ['--general', '--key', w.grant.path, w.keys.keyPath, fs.readFileSync(w.keys.keyPath, 'utf8').trim()]) expect(text).not.toContain(value);
}
async function install(w: World, json = false) {
  const io = ioFor(w); const code = await runDaemon(['install', '--root', w.root, ...(json ? ['--json'] : [])], io, sources(w));
  expect(code, io.err + io.out).toBe(0); return io;
}
for (const dry of [true, false]) {
  test('an install admitted by the actual general door keeps authorization out of the ' + (dry ? 'plan' : 'unit'), async () => {
    const w = world(); const io = ioFor(w, { kind: 'unplaced', reason: 'synthetic external principal' });
    const argv = ['install', '--root', w.root, '--json', ...(dry ? ['--dry-run'] : []), '--general', w.grant.path, '--key', w.keys.keyPath];
    const door = generalDoor('daemon', argv, io);
    if (door.kind !== 'admitted') throw new Error('the synthetic signed grant did not admit: ' + JSON.stringify(door));
    expect(door.kind).toBe('admitted');
    expect(await runDaemon(door.argv, door.io, sources(w)), io.out + io.err).toBe(0);
    const result = JSON.parse(io.out); assertClean(w, JSON.stringify(result.program));
    expect(result.program).toContain('--started-by'); expect(result.program).toContain('service-manager');
    if (dry) { expect(w.calls).toEqual([]); expect(fs.existsSync(w.manager.unitPath(w.home))).toBe(false); }
    else { const unit = fs.readFileSync(w.manager.unitPath(w.home), 'utf8'); assertClean(w, unit); expect(w.calls.length).toBeGreaterThan(0); }
  });
}
for (const flags of [['--general'], ['--key'], ['--general', '--key']]) {
  for (const json of [false, true]) {
    test('an earlier unit carrying ' + flags.join('/') + ' is rewritten and reported, json=' + json, async () => {
      const w = world(); await install(w); const unitPath = w.manager.unitPath(w.home);
      const before = fs.readFileSync(unitPath, 'utf8');
      const words = flags.flatMap(flag => [flag, flag === '--key' ? w.keys.keyPath : w.grant.path]);
      fs.writeFileSync(unitPath, before.replace('</array>', words.map(word => '    <string>' + word + '</string>').join('\n') + '\n  </array>'));
      const io = await install(w, json); const after = fs.readFileSync(unitPath, 'utf8'); assertClean(w, after);
      if (json) expect(JSON.parse(io.out).dropped_authorization).toBe(true);
      else expect(io.out).toContain('the earlier unit named a client key or a general grant; this unit was rewritten without either');
      expect(io.out + io.err).not.toContain(w.keys.keyPath); expect(io.out + io.err).not.toContain(w.grant.path);
    });
  }
}
for (const json of [false, true]) {
  test('a clean unit refresh invents no authorization-removal notice, json=' + json, async () => {
    const w = world(); await install(w); const io = await install(w, json); assertClean(w, fs.readFileSync(w.manager.unitPath(w.home), 'utf8'));
    if (json) expect(JSON.parse(io.out).dropped_authorization).toBeUndefined();
    else expect(io.out).not.toContain('earlier unit named');
  });
}
const placed: Record<string, Caller> = {
  lead: { kind: 'seat', name: 'lead', pane: 'synthetic-lead', session: 'unit-scene' },
  operator: { kind: 'seat', name: 'operator', pane: 'synthetic-operator', session: 'unit-scene' },
  'wrong-pane': { kind: 'seat', name: 'lead', pane: 'other-pane', session: 'unit-scene' },
  'wrong-session': { kind: 'seat', name: 'lead', pane: 'synthetic-lead', session: 'other-session' },
};
for (const name of ['lead', 'operator', 'wrong-pane', 'wrong-session']) {
  test('machine dev mode admits only the recorded lead, caller=' + name, async () => {
    const w = world(); keyOf(w.home); must(writeDevelopmentMode({ home: w.home, mode: 'local-fast', now: NOW, caller: 'owner' }));
    const io = ioFor(w, placed[name]); const code = await runDaemon(['install', '--root', w.root, '--json'], io, sources(w));
    if (name === 'lead') {
      expect(code, io.out + io.err).toBe(0); expect(io.err).toContain('dev mode continues'); assertClean(w, fs.readFileSync(w.manager.unitPath(w.home), 'utf8'));
    } else {
      expect(code).toBe(1); expect(JSON.parse(io.out).error.id).toBe('daemon.not-owner'); expect(w.calls).toEqual([]);
      expect(fs.existsSync(w.manager.unitPath(w.home))).toBe(false);
    }
  });
}
