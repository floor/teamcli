// Every manager operation is an in-process fake over owned JSON fixtures. No real adapter.
import { afterEach, expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { DAEMON_LABEL } from '../src/daemon/paths.ts';
import type { ServiceManager, ServiceProgram, ServiceInstallFailure } from '../src/daemon/service.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import type { Caller } from '../src/caller.ts';
import * as output from '../src/output/index.ts';
import { testIo } from './helpers.ts';
const NOW = new Date('2026-11-01T18:20:00Z');
const bases: string[] = [];
assert.equal(homedir(), fs.realpathSync(process.env.HOME!));
afterEach(() => { const owned = bases.splice(0); if (owned.length) execFileSync('trash', owned, { timeout: 20_000 }); }, 30_000);
type Job = { pid: number | null; program: string | null };
type Unit = { path: string; label: string | null; ownerUid: number | null; mode: number | null; programArguments: string[] | null };
function ownedFile(path: string, text: string, mode = 0o600) {
  // Preserve the requested fixture bits at creation, including the deliberately writable units.
  const previousMask = process.umask(0);
  try { fs.writeFileSync(path, text, { flag: 'wx', mode }); } finally { process.umask(previousMask); }
}
function world() {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/sa-')); bases.push(base);
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
