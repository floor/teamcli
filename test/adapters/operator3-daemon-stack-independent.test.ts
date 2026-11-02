// Service-adapter scenes: every registration command is intercepted by the synthetic runner.
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import * as child from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import type { DaemonHealth } from '../../src/daemon/health.ts';
import type { GrantOp } from '../../src/client/general-grant.ts';
import type { Io } from '../../src/io.ts';
const forbidden: string[] = [];
const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
  if (pid === process.pid && signal === 0) return true;
  forbidden.push('signal'); throw Error('no process signals in the independent scene');
}) as typeof process.kill);
const realExec = child.execFileSync;
const exec = spyOn(child, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
  if (command === 'git' && options?.cwd?.startsWith('/private/tmp/o3daemonstack-')) return realExec(command, args, options);
  if (command === 'ps') return ''; // Synthetic unavailable ancestry, no process inspection.
  forbidden.push(String(command)); throw Error('no external command in the independent scene');
}) as typeof child.execFileSync);
const spawn = spyOn(child, 'spawn').mockImplementation((() => { forbidden.push('spawn'); throw Error('no external launch'); }) as typeof child.spawn);
const spawnSync = spyOn(child, 'spawnSync').mockImplementation((() => { forbidden.push('spawnSync'); throw Error('no manager command'); }) as typeof child.spawnSync);
afterEach(() => { expect(forbidden.splice(0)).toEqual([]); });
afterAll(() => { kill.mockRestore(); exec.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore(); });
const { runDaemon } = await import('../../src/commands/daemon.ts');
const { darwinServiceManager } = await import('../../src/daemon/service-darwin.ts');
const { issueOwnerGeneralGrant, admitGeneral } = await import('../../src/client/general-grant.ts');
const { newClientKeyPair, writeClientKeyFiles, clientKeyDir } = await import('../../src/client/records.ts');
const { emptySession, updateState } = await import('../../src/state.ts');
const { intoRegistry, underRegistry } = await import('../helpers/registry-team.ts');
const now = () => new Date('2026-11-02T10:00:00Z');
const session = 'daemon-stack-independent';
function world(refuseLoad = false) {
  const base = mkdtempSync('/private/tmp/o3daemonstack-'), home = join(base, 'home'), root = join(base, 'checkout'), dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true }); mkdirSync(home);
  child.execFileSync('git', ['init', '-q'], { cwd: root });
  const file = join(dir, 'team.yaml');
  const seat = (name: string, extra: string) => `  - role: worker\n    name: ${name}\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude\n${extra}`;
  writeFileSync(file, `format: 1\nproject: daemon-stack-independent\nsession: ${session}\noperator: captain\nworkspace:\n  mode: shared\nseats:\n` + seat('captain', '    leads: true\n') + seat('observer', ''));
  intoRegistry(root, home); if (existsSync(file)) unlinkSync(file);
  updateState(dir, state => {
    const held = state.sessions[session] = emptySession();
    held.seats.captain = { stage: 'ready', pane: 'pane-captain' };
    held.seats.observer = { stage: 'ready', pane: 'pane-observer' };
  });
  const programDir = join(base, 'program'); mkdirSync(programDir);
  const entry = join(programDir, 'entry.js'); writeFileSync(entry, 'export const independentFixture = true;\n');
  const calls: { command: string; args: string[] }[] = [], waits: number[] = [];
  let running = false, loads = 0;
  const manager = darwinServiceManager({ now, sleep: ms => waits.push(ms), runner: (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'bootstrap') { loads++; running = !refuseLoad; return { status: refuseLoad ? 5 : 0, stdout: '', stderr: refuseLoad ? 'synthetic load refused' : '' }; }
    if (args[0] === 'bootout') { running = false; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'print' || args[0] === 'list') return { status: 113, stdout: '', stderr: 'synthetic job absent' };
    forbidden.push('unexpected manager call'); throw Error('unexpected manager operation');
  } });
  const unit = manager.unitPath(home);
  const seed = () => { mkdirSync(dirname(unit), { recursive: true }); writeFileSync(unit, 'independent installed unit bytes\n'); running = true; };
  const reading = (answered: boolean): DaemonHealth => ({ daemon: 'teamcli', socket: join(home, 'synthetic-machine.sock'), state: 'running', running: true,
    pid: 424242, uid: 501, since: now().toISOString(), startedBy: 'service-manager', version: 'independent', gitHead: null,
    heartbeatAt: now().toISOString(), features: null, stuck: [], roots: [], why: null,
    probe: answered ? { state: 'answered', at: now().toISOString() } : { state: 'unanswered', at: now().toISOString(), reason: 'timeout' } });
  const sources = { home, service: manager, now, program: { execPath: '/synthetic/runtime/node', entry },
    sleep: async (ms: number) => { waits.push(ms); }, health: async () => reading(true),
    start: async () => { forbidden.push('daemon start'); throw Error('a command scene must never start a daemon'); } };
  function io(caller: Caller, general?: { grant: string; key: string; grantId: string; clientId: string }, dev = false) {
    let out = '', err = '';
    const value: Io = { cwd: root, caller, general, env: { HOME: home, TEAM_CONFIG_SOURCE: 'registry', TEAMCLI_DEV_MODE: dev ? '1' : '0' },
      stdinIsTTY: false, stdoutIsTTY: false, stdout: t => { out += t; }, stderr: t => { err += t; } };
    return { value, document: () => JSON.parse(out), errorText: () => err };
  }
  function grant(ops: GrantOp[]) {
    const pair = newClientKeyPair(); const key = writeClientKeyFiles(clientKeyDir(home, 'independent-service-client'), pair);
    if (!key.ok) throw Error(key.why);
    const signed = issueOwnerGeneralGrant(home, { clientId: 'independent-service-client', publicKey: pair.publicKey,
      entities: ['*'], ops, mayIssue: false, expires: new Date(now().getTime() + 3600000) }, now());
    if (!signed.ok) throw Error(signed.why);
    return { grant: signed.path, key: key.keyPath, grantId: signed.grant.grant_id, clientId: 'independent-service-client' };
  }
  return { root, home, calls, waits, manager, sources, io, grant, seed, unit, reading, loads: () => loads, running: () => running };
}
for (const op of ['*', 'daemon'] as const) for (const verb of ['install', 'restart'] as const) {
  test(`${op} grant admits ${verb} without a terminal and keeps credentials out of the unit`, () => underRegistry(async () => {
    const w = world(), grant = w.grant([op]);
    expect(admitGeneral(w.home, grant.grant, grant.key, 'daemon', null, now()).ok).toBe(true);
    if (verb === 'restart') w.seed();
    const before = existsSync(w.unit) ? readFileSync(w.unit, 'utf8') : null;
    const io = w.io({ kind: 'owner-no-tty' }, grant);
    expect(await runDaemon([verb, '--json'], io.value, w.sources)).toBe(0);
    expect(w.loads()).toBe(1); expect(w.running()).toBe(true);
    expect(io.document()[verb === 'install' ? 'installed' : 'restarted']).toBe(true);
    const unit = readFileSync(w.unit, 'utf8');
    expect(unit).not.toContain(grant.grant); expect(unit).not.toContain(grant.key);
    if (verb === 'restart') { if (before === null) throw Error('restart scene needs its seeded unit'); expect(unit).toBe(before); expect(w.calls.map(c => c.args[0])).toEqual(['bootout', 'bootstrap']); }
  }));
}
for (const verb of ['install', 'restart'] as const) {
  test(`a signed grant with no ops refuses ${verb} before any manager operation`, () => underRegistry(async () => {
    const w = world(), io = w.io({ kind: 'owner-no-tty' }, w.grant([]));
    expect(await runDaemon([verb, '--json'], io.value, w.sources)).toBe(1);
    expect(io.document().error.id).toBe('daemon.grant-refused'); expect(w.calls).toEqual([]); expect(existsSync(w.unit)).toBe(false);
  }));
}
for (const [name, admitted] of [['captain', true], ['observer', false]] as const) {
  test(`dev-mode ${name} ${admitted ? 'restarts' : 'is refused'}`, () => underRegistry(async () => {
    const w = world(); w.seed(); const before = readFileSync(w.unit, 'utf8');
    const io = w.io({ kind: 'seat', name, pane: `pane-${name}`, session }, undefined, true);
    expect(await runDaemon(['restart', '--json'], io.value, w.sources)).toBe(admitted ? 0 : 1);
    if (admitted) { expect(io.document().restarted).toBe(true); expect(w.loads()).toBe(1); }
    else { const refusal = io.document().error; expect(refusal.id).toBe('daemon.not-owner'); expect(refusal.message).toContain('owner, a general grant naming daemon, or a lead in development mode'); expect(w.calls).toEqual([]); }
    expect(readFileSync(w.unit, 'utf8')).toBe(before);
  }));
}
test('restart with no installed unit stops nothing', () => underRegistry(async () => {
  const w = world(), io = w.io({ kind: 'owner' });
  expect(await runDaemon(['restart', '--json'], io.value, w.sources)).toBe(1);
  expect(io.document().error.id).toBe('daemon.not-installed'); expect(w.calls).toEqual([]); expect(w.running()).toBe(false);
}));
test('an unanswered restart rolls back and confirms the previous unit answers again', () => underRegistry(async () => {
  const w = world(); w.seed(); const before = readFileSync(w.unit, 'utf8'); const checks: number[] = [];
  const io = w.io({ kind: 'owner' });
  const health = async () => { checks.push(w.loads()); return w.reading(w.loads() >= 2); };
  expect(await runDaemon(['restart', '--json'], io.value, { ...w.sources, health })).toBe(1);
  expect(io.document().error.id).toBe('daemon.restart-rolled-back');
  expect(w.calls.map(c => c.args[0])).toEqual(['bootout', 'bootstrap', 'bootout', 'bootstrap']);
  expect(checks.filter(generation => generation === 1).length).toBeGreaterThan(1); expect(checks.at(-1)).toBe(2);
  expect(w.running()).toBe(true); expect(readFileSync(w.unit, 'utf8')).toBe(before);
}));

test('an install failure names the general-grant holder in its repair', () => underRegistry(async () => {
  const w = world(true), io = w.io({ kind: 'owner' });
  expect(await runDaemon(['install', '--json'], io.value, w.sources)).toBe(1);
  expect(io.document().error.repair).toContain('the owner or a general-grant holder runs');
  expect(w.loads()).toBeGreaterThan(1); expect(w.running()).toBe(false);
}));
