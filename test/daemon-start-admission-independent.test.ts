// Start admission uses JSON-backed fake managers. Runtime-copy scenes use the adapter factory
// behind an inert registration runner; every path and every effect belongs to the fixture.
import { afterEach, expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { DAEMON_LABEL } from '../src/daemon/paths.ts';
import type { ServiceManager, ServiceProgram, ServiceInstallFailure } from '../src/daemon/service.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import type { Caller } from '../src/caller.ts';
import * as output from '../src/output/index.ts';
import { testIo } from './helpers.ts';
import { inertRuntimeManager, runtimeWords } from './adapters/daemon-runtime-independent.ts';
const NOW = new Date('2026-11-01T18:20:00Z');
const FIXTURE_ROOT = '/tmp/teamcli-sa-fixtures';
const bases: string[] = [];
assert.equal(homedir(), fs.realpathSync(process.env.HOME!));
afterEach(() => { const owned = bases.splice(0); if (owned.length) discardFixtures(owned, { roots: [FIXTURE_ROOT] }); }, 30_000);
type Job = { pid: number | null; program: string | null };
type Unit = { path: string; label: string | null; ownerUid: number | null; mode: number | null; programArguments: string[] | null };
function ownedFile(path: string, text: string, mode = 0o600) {
  // Preserve the requested fixture bits at creation, including the deliberately writable units.
  const previousMask = process.umask(0);
  try { fs.writeFileSync(path, text, { flag: 'wx', mode }); } finally { process.umask(previousMask); }
}
function world() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true }); const base = fs.realpathSync(fs.mkdtempSync(join(FIXTURE_ROOT, 'sa-'))); bases.push(base);
  const root = join(base, 'r'); const home = join(base, 'h'); const dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home); execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(join(dir, 'team.yaml'), `format: 1
project: admission-scene
session: admission-scene
operator: lead
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
`);
  const entry = join(base, 'synthetic-entry.ts'); fs.writeFileSync(entry, '// never executed\n');
  return { base, root, home, entry, unitPath: join(home, 'fake-unit.json'), jobPath: join(home, 'fake-job.json') };
}
type World = ReturnType<typeof world>;
function unitWords() { return [process.execPath, ...process.argv.slice(1)]; }
function record(w: World, job: Job | null = { pid: process.pid, program: process.execPath }, unit: Partial<Unit> | null = {}) {
  if (job !== null) ownedFile(w.jobPath, JSON.stringify(job));
  if (unit !== null) ownedFile(w.unitPath, JSON.stringify({ label: DAEMON_LABEL, programArguments: unitWords(), ...unit }), unit.mode ?? 0o600);
}
function fake(w: World, over: { job?: () => Job | null; unit?: () => Unit | null } = {}) {
  const trace: string[] = [];
  const manager: ServiceManager & { job(home: string): Job | null; unit(home: string): Unit | null } = {
    kind: 'system-service-manager', unitPath: home => { assert.equal(home, w.home); return w.unitPath; },
    plan: (home, program) => { assert.equal(home, w.home); return { unitPath: w.unitPath, program: [program.execPath, program.entry, 'daemon', 'run', '--started-by', 'service-manager'] }; },
    install: () => { throw new Error('install is outside start-admission scene'); }, uninstall: () => { throw new Error('uninstall forbidden'); },
    restart: () => { throw new Error('restart forbidden'); },
    job: home => { assert.equal(home, w.home); trace.push('job'); if (over.job) return over.job();
      return fs.existsSync(w.jobPath) ? JSON.parse(fs.readFileSync(w.jobPath, 'utf8')) as Job : null; },
    unit: home => { assert.equal(home, w.home); trace.push('unit'); if (over.unit) return over.unit();
      if (!fs.existsSync(w.unitPath)) return null; const stat = fs.statSync(w.unitPath);
      const text = JSON.parse(fs.readFileSync(w.unitPath, 'utf8')) as Partial<Unit>;
      return { path: w.unitPath, label: text.label ?? null, ownerUid: text.ownerUid ?? stat.uid, mode: stat.mode & 0o777, programArguments: text.programArguments ?? null }; },
  };
  return { manager, trace };
}
async function runStart(w: World, service: ServiceManager | null, caller: Caller, extra: string[] = [], serviceFlag = true) {
  const io = testIo(w.root, caller); io.env = { HOME: w.home }; const started: Parameters<NonNullable<DaemonCommandSources['start']>>[0][] = [];
  // Observe the actual refusal boundary so run's plain-text face can be checked by contract id.
  const ids: string[] = []; const original = output.refuse;
  const tap = spyOn(output, 'refuse').mockImplementation((...args: Parameters<typeof output.refuse>) => { ids.push(args[3].id); return original(...args); });
  let code: number;
  try { code = await runDaemon(['run', '--root', w.root, ...(serviceFlag ? ['--started-by', 'service-manager'] : []), ...extra], io,
    { home: w.home, service, start: async input => { started.push(input); return { kind: 'already-running', pid: 9999 }; } }); }
  finally { tap.mockRestore(); }
  return { code, io, started, ids };
}
const DETACHED: Caller = { kind: 'owner-no-tty' };
const SEAT: Caller = { kind: 'seat', name: 'worker', pane: 'synthetic-pane', session: 'admission-scene' };
for (const caller of [DETACHED, SEAT]) {
  test('a matching job and unit admit the service-managed process: ' + caller.kind, async () => {
    const w = world(); record(w); const manager = fake(w); const result = await runStart(w, manager.manager, caller);
    expect(result.code, result.io.err).toBe(0); expect(result.started).toHaveLength(1);
    expect(result.started[0]!.home).toBe(w.home); expect(result.started[0]!.roots).toEqual([w.root]);
    expect(result.started[0]!.startedBy).toBe('service-manager'); expect(result.ids).toEqual([]); expect(manager.trace).toEqual(['unit', 'job']);
  });
}
type Fault = 'pid' | 'program' | 'extra-word' | 'reordered-words' | 'missing-word' | 'missing-job' | 'missing-unit' | 'group-write' | 'world-write' | 'label' | 'owner' | 'null-pid' | 'null-program' | 'unit-executable' | 'orphan';
const faults: readonly Fault[] = ['pid','program','extra-word','reordered-words','missing-word','missing-job','missing-unit','group-write','world-write','label','owner','null-pid','null-program','unit-executable','orphan'];
for (const fault of faults) {
  test('start refuses the precise job or unit fault: ' + fault, async () => {
    const w = world(); const job: Job = { pid: process.pid, program: process.execPath }; const unit: Partial<Unit> = {};
    if (fault === 'pid') job.pid = process.pid + 111;
    if (fault === 'null-pid') job.pid = null;
    if (fault === 'program') job.program = w.entry;
    if (fault === 'null-program') job.program = null;
    if (fault === 'extra-word') unit.programArguments = [...unitWords(), '--presence'];
    if (fault === 'missing-word') unit.programArguments = unitWords().slice(0, -1);
    if (fault === 'reordered-words') unit.programArguments = unitWords().reverse();
    if (fault === 'unit-executable') unit.programArguments = [w.entry, ...process.argv.slice(1)];
    if (fault === 'group-write') unit.mode = 0o620;
    if (fault === 'world-write') unit.mode = 0o602;
    if (fault === 'label') unit.label = 'synthetic.other-daemon';
    if (fault === 'owner') unit.ownerUid = process.getuid!() + 1;
    record(w, fault === 'missing-job' || fault === 'orphan' ? null : job, fault === 'missing-unit' ? null : unit);
    if (fault === 'group-write' || fault === 'world-write') expect(fs.statSync(w.unitPath).mode & 0o777).toBe(unit.mode!);
    const manager = fake(w); const result = await runStart(w, manager.manager, fault === 'missing-job' ? SEAT : DETACHED);
    const category = ['missing-unit','group-write','world-write','label','owner'].includes(fault) ? 'unit'
      : ['pid','missing-job','null-pid','orphan'].includes(fault) ? 'pid' : 'program';
    expect(result.code, result.io.out + result.io.err).toBe(1); expect(result.ids).toEqual(['daemon.service-managed.' + category]);
    expect(result.started).toEqual([]);
    expect(manager.trace).toEqual(category === 'unit' ? ['unit'] : ['unit', 'job']);
  });
}
for (const serviceFlag of [false, true]) {
  test('owner-terminal run needs no service-manager record, flag=' + serviceFlag, async () => {
    const w = world(); const forbidden = () => { throw new Error('owner-terminal start read a manager record'); };
    const manager = fake(w, { job: forbidden, unit: forbidden }); const result = await runStart(w, manager.manager, { kind: 'owner' }, [], serviceFlag);
    expect(result.code, result.io.err).toBe(0); expect(result.started).toHaveLength(1); expect(manager.trace).toEqual([]); expect(result.ids).toEqual([]);
  });
}
test('a token flag is rejected as usage before a manager read or daemon start', async () => {
  const w = world(); record(w); const manager = fake(w); const result = await runStart(w, manager.manager, DETACHED, ['--token', 'synthetic-invalid-token', '--json']);
  expect(result.code).toBe(2); expect(result.ids).toEqual(['daemon.usage']);
  expect(result.io.err).toContain('--token'); expect(manager.trace).toEqual([]); expect(result.started).toEqual([]);
});
test('an unavailable fake service adapter refuses instead of consulting the live adapter', async () => {
  const w = world(); const result = await runStart(w, null, DETACHED);
  expect(result.code).toBe(1); expect(result.ids).toEqual(['daemon.service-managed.unit']); expect(result.started).toEqual([]);
});
type Reading = 'answer' | 'silent' | 'hung' | 'unknown' | 'refused';
function health(w: World, reading: Reading): DaemonHealth {
  const running = reading === 'answer' || reading === 'hung' || reading === 'refused';
  return { daemon: 'teamcli', socket: join(w.home, 'never-opened.sock'), state: reading === 'unknown' ? 'unknown' : running ? 'running' : 'not-running',
    running: reading === 'unknown' ? null : running, pid: running ? 9999 : null, uid: running ? process.getuid!() : null,
    since: running ? NOW.toISOString() : null, startedBy: running ? 'service-manager' : null, version: 'synthetic', gitHead: null,
    heartbeatAt: NOW.toISOString(), features: { broker: 'absent' }, stuck: [], roots: [], why: reading === 'unknown' ? 'synthetic unknown' : null,
    probe: reading === 'answer' ? { state: 'answered', at: NOW.toISOString() } : reading === 'refused' ? { state: 'refused', at: NOW.toISOString(), code: 'synthetic.refused', message: 'synthetic refusal' }
      : { state: 'unanswered', at: NOW.toISOString(), reason: 'closed' } };
}
function installer(w: World, prior: boolean, restoredAnswers: boolean) {
  const previous = 'synthetic earlier unit bytes\n'; if (prior) ownedFile(w.unitPath, previous);
  const trace: string[] = []; const unitPresent: boolean[] = []; let undone = false;
  const manager: ServiceManager & { job(home: string): Job | null; unit(home: string): Unit | null } = {
    kind: 'system-service-manager', unitPath: () => w.unitPath,
    plan: (_home, program) => ({ unitPath: w.unitPath, program: [program.execPath, program.entry, 'daemon', 'run', '--started-by', 'service-manager'] }),
    job: () => { throw new Error('install read job'); }, unit: () => { throw new Error('install read unit'); },
    uninstall: () => { throw new Error('command must use the accepted install undo, not uninstall'); },
    restart: () => { throw new Error('command must use the accepted install undo, not restart'); },
    install: (_home, program: ServiceProgram) => {
      trace.push('install'); fs.writeFileSync(w.unitPath, JSON.stringify({ words: manager.plan(w.home, program).program })); unitPresent.push(fs.existsSync(w.unitPath));
      const undo = (): ServiceInstallFailure => {
        trace.push('undo'); expect(undone).toBe(false); undone = true;
        if (prior) fs.writeFileSync(w.unitPath, previous); else fs.unlinkSync(w.unitPath);
        unitPresent.push(fs.existsSync(w.unitPath));
        return { ok: false, why: prior ? 'new daemon did not answer; previous unit was restored' : 'new daemon did not answer; fresh unit was removed',
          detail: 'synthetic unit undo', outcome: prior ? 'restored' : 'refused', kept: prior };
      };
      return { ok: true, unitPath: w.unitPath, undo };
    },
  };
  return { manager, previous, trace, unitPresent, undone: () => undone, restoredAnswers };
}
const installScenes = [
  { name: 'answers-at-once', prior: false, reading: 'answer', delayed: false, restored: false, success: true },
  { name: 'answers-after-two-probes', prior: true, reading: 'silent', delayed: true, restored: false, success: true },
  { name: 'fresh-silent-removed', prior: false, reading: 'silent', delayed: false, restored: false, success: false },
  { name: 'refresh-silent-restored', prior: true, reading: 'silent', delayed: false, restored: true, success: false },
  { name: 'restored-daemon-still-silent', prior: true, reading: 'silent', delayed: false, restored: false, success: false },
  { name: 'running-but-probe-unanswered', prior: false, reading: 'hung', delayed: false, restored: false, success: false },
  { name: 'probe-refused', prior: false, reading: 'refused', delayed: false, restored: false, success: false },
  { name: 'health-unknown', prior: false, reading: 'unknown', delayed: false, restored: false, success: false },
] as const;
for (const scene of installScenes) for (const json of [false, true]) {
  test('install requires a health answer and preserves a previous unit: ' + scene.name + ', json=' + json, async () => {
    const w = world(); const adapter = installer(w, scene.prior, scene.restored); const sleeps: number[] = []; let newProbes = 0; let restoredProbes = 0;
    const io = testIo(w.root, { kind: 'owner' }); io.env = { HOME: w.home, PATH: '/synthetic/path' };
    const code = await runDaemon(['install', '--root', w.root, ...(json ? ['--json'] : [])], io, {
      home: w.home, service: adapter.manager, program: { execPath: process.execPath, entry: w.entry }, now: () => NOW, sleep: async ms => { sleeps.push(ms); },
      health: async home => { expect(home).toBe(w.home); if (adapter.undone()) { restoredProbes++; adapter.trace.push('health-restored');
        expect(fs.readFileSync(w.unitPath, 'utf8')).toBe(adapter.previous); return health(w, scene.restored ? 'answer' : 'silent'); }
        newProbes++; adapter.trace.push('health-new'); return health(w, scene.delayed && newProbes >= 3 ? 'answer' : scene.reading); },
    });
    expect(code, io.err + io.out).toBe(scene.success ? 0 : 1); expect(adapter.trace[0]).toBe('install');
    if (scene.success) {
      expect(newProbes).toBe(scene.delayed ? 3 : 1); expect(adapter.undone()).toBe(false); expect(fs.existsSync(w.unitPath)).toBe(true);
      expect(adapter.trace).not.toContain('undo'); expect(sleeps).toEqual(scene.delayed ? [100, 200] : []);
      if (json) expect(JSON.parse(io.out).installed).toBe(true); else expect(io.out).toContain('installed for 1 checkout');
    } else {
      expect(newProbes).toBe(8); expect(adapter.trace.filter(step => step === 'undo')).toHaveLength(1);
      expect(restoredProbes).toBe(scene.prior ? (scene.restored ? 1 : 8) : 0);
      expect(sleeps.slice(0, 7)).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
      const expectedId = scene.prior ? (scene.restored ? 'daemon.install-rolled-back' : 'daemon.install-rollback-failed') : 'daemon.install-failed';
      if (json) { const error = JSON.parse(io.out).error; expect(error.id).toBe(expectedId);
        if (scene.restored) expect(error.repair).toBeNull(); else expect(error.repair).toContain('team daemon install --root'); }
      else { expect(io.err).toContain(scene.prior ? 'previous unit was restored' : 'fresh unit was removed'); expect(io.out).not.toContain('installed for'); }
      if (scene.prior) { expect(fs.readFileSync(w.unitPath, 'utf8')).toBe(adapter.previous); expect(adapter.unitPresent.every(Boolean)).toBe(true); }
      else expect(fs.existsSync(w.unitPath)).toBe(false);
    }
  });
}
test('a dry install plans without calling the fake install or health functions', async () => {
  const w = world(); const adapter = installer(w, false, false); const io = testIo(w.root, { kind: 'owner' });
  expect(await runDaemon(['install', '--root', w.root, '--dry-run', '--json'], io, { home: w.home, service: adapter.manager,
    program: { execPath: process.execPath, entry: w.entry }, health: async () => { throw new Error('dry run probed health'); } })).toBe(0);
  expect(adapter.trace).toEqual([]); expect(fs.existsSync(w.unitPath)).toBe(false); expect(JSON.parse(io.out).dry_run).toBe(true);
});

// A tiny complete package: the entry needs a sibling, the sibling needs the manifest and the
// relay package. Running it is a bounded, one-shot fixture check, never a machine daemon.
function runtimePackage(w: World, name = 'package') {
  const root = join(w.base, name), dist = join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true }); fs.mkdirSync(join(root, 'packages/relay'), { recursive: true });
  const files: Record<string, string> = {
    'dist/entry.mjs': 'import { value } from "./sibling.mjs"; console.log(value);\n',
    'dist/sibling.mjs': 'import { readFileSync } from "node:fs"; import { suffix } from "../packages/relay/value.mjs"; export const value=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).marker+suffix;\n',
    'packages/relay/value.mjs': 'export const suffix="-relay";\n',
    'package.json': '{"type":"module","marker":"prior-program"}\n',
  };
  for (const [path, bytes] of Object.entries(files)) ownedFile(join(root, path), bytes);
  const program: ServiceProgram = { execPath: process.execPath, entry: join(dist, 'entry.mjs'), roots: [w.root], runtime: { root, include: ['dist', 'packages/relay', 'package.json'] } };
  return { root, files, program };
}
function retainedFolder(w: World, entry: string): string {
  const folder = dirname(dirname(entry));
  expect(dirname(folder)).toBe(join(w.home, '.config/team/daemon-runtime')); expect(basename(folder)).toMatch(/^[0-9a-f]{64}$/);
  return folder;
}
function runFixture(w: World, words: string[] | null) {
  if (!words?.[0] || !words[1]) return { ok: false, text: '' };
  const result = spawnSync(words[0], [words[1]], { cwd: w.root, env: { HOME: w.home }, encoding: 'utf8', timeout: 2_000 });
  return { ok: result.status === 0, text: result.stdout.trim() };
}
async function runtimeInstall(w: World, adapter: ReturnType<typeof inertRuntimeManager>, program: ServiceProgram, json: boolean) {
  const io = testIo(w.root, { kind: 'owner' }); io.env = { HOME: w.home };
  const probes: { entry: string | null; ok: boolean; text: string }[] = [];
  const code = await runDaemon(['install', '--root', w.root, ...(json ? ['--json'] : [])], io, {
    home: w.home, service: adapter.manager, program, now: () => NOW, sleep: async () => {},
    health: async () => { const result = runFixture(w, adapter.active()); probes.push({ entry: adapter.active()?.[1] ?? null, ...result }); return health(w, result.ok ? 'answer' : 'silent'); },
  });
  return { code, io, probes };
}

for (const json of [false, true]) test('runtime delta: broken package sibling leaves the restored program answering, json=' + json, async () => {
  const w = world(), pkg = runtimePackage(w), adapter = inertRuntimeManager(w.home);
  const prior = adapter.manager.install(w.home, pkg.program); expect(prior.ok).toBe(true);
  const unitPath = adapter.manager.unitPath(w.home), oldText = fs.readFileSync(unitPath, 'utf8'), oldWords = runtimeWords(oldText), oldFolder = retainedFolder(w, oldWords[1]!);
  expect(runFixture(w, adapter.active())).toEqual({ ok: true, text: 'prior-program-relay' });
  for (const [path, bytes] of Object.entries(pkg.files)) expect(fs.readFileSync(join(oldFolder, path), 'utf8')).toBe(bytes);
  fs.writeFileSync(join(pkg.root, 'dist/sibling.mjs'), 'throw new Error("synthetic broken sibling");\n');
  // Same entry bytes: replacing only the imported sibling is enough to break the package.
  expect(fs.readFileSync(pkg.program.entry, 'utf8')).toBe(pkg.files['dist/entry.mjs']!);
  expect(runFixture(w, [process.execPath, pkg.program.entry]).ok).toBe(false);
  const newFolder = retainedFolder(w, adapter.manager.plan(w.home, pkg.program).program[1]!); expect(newFolder).not.toBe(oldFolder);
  const result = await runtimeInstall(w, adapter, pkg.program, json);
  expect(result.code, result.io.out + result.io.err).toBe(1);
  if (json) expect(JSON.parse(result.io.out).error.id).toBe('daemon.install-rolled-back');
  else { expect(result.io.err).toContain('previous'); expect(result.io.out).not.toContain('installed for'); }
  expect(result.probes).toHaveLength(9); expect(result.probes.slice(0, 8).every(p => !p.ok && p.entry === join(newFolder, 'dist/entry.mjs'))).toBe(true);
  expect(result.probes[8]).toEqual({ entry: oldWords[1]!, ok: true, text: 'prior-program-relay' });
  expect(fs.readFileSync(unitPath, 'utf8')).toBe(oldText); expect(adapter.active()).toEqual(oldWords);
  expect(fs.existsSync(newFolder)).toBe(false); expect(fs.existsSync(oldFolder)).toBe(true);
  for (const [path, bytes] of Object.entries(pkg.files)) expect(fs.readFileSync(join(oldFolder, path), 'utf8')).toBe(bytes);
  expect(runFixture(w, adapter.active())).toEqual({ ok: true, text: 'prior-program-relay' });
});

function seedCopy(folder: string, files: Record<string, string>, folderMode = 0o700, nestedMode = 0o700) {
  const mask = process.umask(0);
  try {
    fs.mkdirSync(folder, { recursive: true, mode: folderMode });
    for (const [path, text] of Object.entries(files)) { fs.mkdirSync(dirname(join(folder, path)), { recursive: true, mode: nestedMode }); ownedFile(join(folder, path), text); }
  } finally { process.umask(mask); }
}
function observeUnitWrites<T>(path: string, perform: () => T) {
  const writes: string[] = [], write = fs.writeFileSync, rename = fs.renameSync;
  const writeTap = spyOn(fs, 'writeFileSync').mockImplementation(((...args: unknown[]) => {
    if (String(args[0]) === path || String(args[0]).startsWith(`${path}.`)) writes.push('write');
    return Reflect.apply(write, fs, args);
  }) as typeof fs.writeFileSync);
  const renameTap = spyOn(fs, 'renameSync').mockImplementation(((...args: unknown[]) => {
    if (String(args[1]) === path) writes.push('replace');
    return Reflect.apply(rename, fs, args);
  }) as typeof fs.renameSync);
  try { return { result: perform(), writes }; } finally { renameTap.mockRestore(); writeTap.mockRestore(); }
}
test('runtime delta: valid preseeded copy is accepted and the unit-write observer sees the control', () => {
  const w = world(), pkg = runtimePackage(w), adapter = inertRuntimeManager(w.home);
  const entry = adapter.manager.plan(w.home, pkg.program).program[1]!, target = retainedFolder(w, entry);
  seedCopy(target, pkg.files);
  const observed = observeUnitWrites(adapter.manager.unitPath(w.home), () => adapter.manager.install(w.home, pkg.program));
  expect(observed.result.ok).toBe(true); expect(observed.writes).toEqual(['write', 'replace']);
  expect(runtimeWords(fs.readFileSync(adapter.manager.unitPath(w.home), 'utf8'))[1]).toBe(entry);
  expect(runFixture(w, adapter.active())).toEqual({ ok: true, text: 'prior-program-relay' });
});
type RuntimeFault = 'tampered' | 'foreign' | 'non-0700' | 'extra-file' | 'writable-member' | 'non-0700-child';
for (const prior of [false, true]) for (const fault of ['tampered', 'foreign', 'non-0700', 'extra-file', 'writable-member', 'non-0700-child'] as const) {
  test(`runtime delta: ${fault} at the computed name refuses before unit write; prior=${prior}`, () => {
    const w = world(), adapter = inertRuntimeManager(w.home), pkg = runtimePackage(w), unitPath = adapter.manager.unitPath(w.home);
    let oldText: string | null = null;
    if (prior) {
      const old = runtimePackage(w, 'old'); fs.writeFileSync(join(old.root, 'package.json'), '{"type":"module","marker":"earlier"}\n');
      expect(adapter.manager.install(w.home, old.program).ok).toBe(true); oldText = fs.readFileSync(unitPath, 'utf8');
    }
    const entry = adapter.manager.plan(w.home, pkg.program).program[1]!, target = retainedFolder(w, entry);
    seedCopy(target, pkg.files, fault === 'non-0700' ? 0o750 : 0o700, fault === 'non-0700-child' ? 0o750 : 0o700);
    expect(fs.statSync(target).mode & 0o777).toBe(fault === 'non-0700' ? 0o750 : 0o700);
    if (fault === 'tampered') fs.writeFileSync(entry, '// synthetic changed content\n');
    if (fault === 'extra-file') ownedFile(join(target, 'extra.mjs'), '// synthetic surplus member\n');
    if (fault === 'writable-member') { fs.unlinkSync(entry); ownedFile(entry, pkg.files['dist/entry.mjs']!, 0o620); expect(fs.statSync(entry).mode & 0o777).toBe(0o620); }
    const beforeCalls = adapter.calls.length, active = adapter.active(); let foreignReads = 0;
    const original = fs.lstatSync;
    const injected = ((...args: unknown[]) => {
      const value = Reflect.apply(original, fs, args) as fs.Stats | fs.BigIntStats;
      if (String(args[0]) !== target) return value;
      foreignReads++;
      return new Proxy(value, { get(obj, key) { return key === 'uid' ? typeof obj.uid === 'bigint' ? obj.uid + 1n : obj.uid + 1 : Reflect.get(obj, key); } });
    }) as typeof fs.lstatSync;
    const ownerTap = fault === 'foreign' ? spyOn(fs, 'lstatSync').mockImplementation(injected) : null;
    let observed: ReturnType<typeof observeUnitWrites<ReturnType<ServiceManager['install']>>>;
    try { observed = observeUnitWrites(unitPath, () => adapter.manager.install(w.home, pkg.program)); } finally { ownerTap?.mockRestore(); }
    const installed = observed.result; expect(observed.writes).toEqual([]);
    expect(installed.ok).toBe(false); if (installed.ok) throw new Error('unverified runtime accepted');
    expect(installed.outcome).toBe('refused'); expect(installed.kept).toBe(prior); expect(installed.why).toContain('could not be kept whole');
    const detail: Record<RuntimeFault, string> = { tampered: 'does not match the hash', foreign: "not this user's", 'non-0700': 'not owner-only', 'extra-file': 'does not match the hash', 'writable-member': 'writable by the group or the world', 'non-0700-child': 'not owner-only' };
    expect(installed.detail).toContain(detail[fault]); if (fault === 'foreign') expect(foreignReads).toBeGreaterThan(0);
    expect(adapter.calls).toHaveLength(beforeCalls); expect(adapter.active()).toEqual(active);
    if (oldText !== null) expect(fs.readFileSync(unitPath, 'utf8')).toBe(oldText); else expect(fs.existsSync(unitPath)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
}

for (const json of [false, true]) test('runtime delta: health undo retains a copy the earlier unit also names, json=' + json, async () => {
  const w = world(), pkg = runtimePackage(w), adapter = inertRuntimeManager(w.home);
  expect(adapter.manager.install(w.home, pkg.program).ok).toBe(true);
  const path = adapter.manager.unitPath(w.home), text = fs.readFileSync(path, 'utf8'), words = runtimeWords(text), folder = retainedFolder(w, words[1]!);
  let probes = 0; const io = testIo(w.root, { kind: 'owner' });
  const code = await runDaemon(['install', '--root', w.root, ...(json ? ['--json'] : [])], io, {
    home: w.home, service: adapter.manager, program: pkg.program, sleep: async () => {}, now: () => NOW,
    health: async () => { probes++; expect(fs.existsSync(folder)).toBe(true); return health(w, probes <= 8 ? 'silent' : runFixture(w, adapter.active()).ok ? 'answer' : 'silent'); },
  });
  expect(code, io.out + io.err).toBe(1); expect(probes).toBe(9);
  if (json) expect(JSON.parse(io.out).error.id).toBe('daemon.install-rolled-back');
  expect(fs.readFileSync(path, 'utf8')).toBe(text); expect(adapter.active()).toEqual(words); expect(fs.existsSync(folder)).toBe(true);
  for (const [relative, bytes] of Object.entries(pkg.files)) expect(fs.readFileSync(join(folder, relative), 'utf8')).toBe(bytes);
  expect(runFixture(w, adapter.active())).toEqual({ ok: true, text: 'prior-program-relay' });
});

for (const kind of ['writable-0777', 'symlink', 'safe-0755'] as const) test('runtime parent delta: ' + kind, () => {
  const w = world(), pkg = runtimePackage(w), adapter = inertRuntimeManager(w.home), path = adapter.manager.unitPath(w.home);
  fs.mkdirSync(dirname(path), { recursive: true });
  const prior = `<plist><dict><key>Label</key><string>${DAEMON_LABEL}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${w.entry}</string><string>daemon</string><string>run</string></array></dict></plist>\n`;
  ownedFile(path, prior);
  const parent = join(w.home, '.config/team/daemon-runtime'), linked = join(w.base, 'linked-runtime');
  fs.mkdirSync(dirname(parent), { recursive: true });
  if (kind === 'symlink') { fs.mkdirSync(linked); ownedFile(join(linked, 'sentinel'), 'untouched\n'); fs.symlinkSync(linked, parent, 'dir'); }
  else { const mask = process.umask(0); try { fs.mkdirSync(parent, { mode: kind === 'writable-0777' ? 0o777 : 0o755 }); } finally { process.umask(mask); } }
  const before = fs.lstatSync(parent); expect(before.isSymbolicLink()).toBe(kind === 'symlink');
  if (kind !== 'symlink') expect(before.mode & 0o777).toBe(kind === 'writable-0777' ? 0o777 : 0o755);
  const observed = observeUnitWrites(path, () => adapter.manager.install(w.home, pkg.program));
  if (kind === 'safe-0755') {
    expect(observed.result.ok).toBe(true); expect(observed.writes).toEqual(['write', 'replace']); expect(adapter.calls).toHaveLength(1);
    const entry = runtimeWords(fs.readFileSync(path, 'utf8'))[1]!; expect(fs.statSync(retainedFolder(w, entry)).mode & 0o777).toBe(0o700);
    expect(runFixture(w, adapter.active())).toEqual({ ok: true, text: 'prior-program-relay' });
  } else {
    expect(observed.result.ok).toBe(false); if (observed.result.ok) throw new Error('unsafe runtime parent accepted');
    expect(observed.result.detail).toContain(kind === 'symlink' ? 'symbolic link' : 'writable by the group or the world');
    expect(observed.result.kept).toBe(true); expect(observed.writes).toEqual([]); expect(adapter.calls).toEqual([]); expect(fs.readFileSync(path, 'utf8')).toBe(prior);
    expect(fs.lstatSync(parent).ino).toBe(before.ino); expect(fs.lstatSync(parent).mode).toBe(before.mode);
    if (kind === 'symlink') { expect(fs.readlinkSync(parent)).toBe(linked); expect(fs.readdirSync(linked)).toEqual(['sentinel']); expect(fs.readFileSync(join(linked, 'sentinel'), 'utf8')).toBe('untouched\n'); }
    else expect(fs.readdirSync(parent)).toEqual([]);
  }
});
