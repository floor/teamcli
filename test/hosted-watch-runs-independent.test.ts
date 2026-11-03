// Independent host and command scenes. Every root, binding, clock and sender is
// synthetic. The production loop runs in this process; no machine socket or live daemon is read.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTeamCheck } from '../src/check/team.ts';
import type { WatchSources } from '../src/commands/watch.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchAuthority, type HostedWatchAuthorityInput, type WatchSenderFactoryInput } from '../src/daemon/watch-authority.ts';
import type { Io } from '../src/io.ts';
import { emptySession, LOCK_FILE, readState, STATE_FILE, updateState } from '../src/state.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../src/watch/authority.ts';
import { forgetIdleEpisodes, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { mintWatchEpoch } from '../src/watch/epoch.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { CLAUDE_IDLE } from './helpers.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';

const AT = Date.parse('2026-11-01T14:00:00Z');
const SESSION = 'harvest';
const TEXT = `format: 1
project: orchard
session: harvest
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: picker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --dangerously-load-development-channels server:team-inbox
`;
const bases: string[] = [];
const hosts: HostedWatch[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop('independent scene cleanup');
  forgetIdleEpisodes();
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function world(session = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-independent-')));
  bases.push(base);
  const root = join(base, 'orchard');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const teamFile = join(dir, 'team.yaml');
  const other = join(dir, 'other.yaml');
  writeFileSync(teamFile, TEXT);
  writeFileSync(other, TEXT.replace('project: orchard', 'project: elsewhere'));
  if (session) updateState(dir, state => { state.sessions[SESSION] = emptySession(); });
  const route = routeOf(root, 'orchard', SESSION, ['lead', 'picker']);
  const clock = { at: AT };
  const logs: string[] = [];
  let liveReads = 0;
  let unsafeWrites = 0;
  const unsafe = () => { unsafeWrites += 1; return false; };
  const sources: WatchSources = {
    home,
    pid: process.pid,
    now: () => new Date(clock.at),
    alive: pid => pid === process.pid,
    live: () => { liveReads += 1; return { running: true, agents: [], workspaces: [], screens: {} }; },
    machine: () => ({ loadPerCore: 0.1, memoryFree: 75, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    processes: () => null,
    typeText: unsafe,
    pressEnter: unsafe,
    sendKey: unsafe,
    notify: () => { unsafeWrites += 1; },
    sleep: async () => {},
    wait: async () => false,
    renameWorkspace: unsafe,
    reportDisplayAgent: unsafe,
  };
  const input: HostedWatchAuthorityInput = {
    route, teamFile, base: sources,
    now: () => new Date(clock.at),
    alive: pid => pid === process.pid,
    log: line => logs.push(line),
  };
  const bind = (file = teamFile) => updateState(dir, state => {
    (state.sessions[SESSION] ??= emptySession()).watchdog = { file, pane: 'synthetic-prior-binding' };
  });
  return { base, root, dir, home, teamFile, other, route, clock, logs, sources, input, bind,
    bytes: () => readFileSync(join(dir, STATE_FILE), 'utf8'),
    session: () => readState(dir).sessions[SESSION],
    liveReads: () => liveReads,
    unsafeWrites: () => unsafeWrites,
  };
}
type World = ReturnType<typeof world>;

function start(w: World, build = hostedWatchAuthority(w.input)) {
  const host = createHostedWatch({ route: w.route, ...build, onTick: build.tick, now: () => new Date(w.clock.at) });
  hosts.push(host);
  return host;
}
async function flush() {
  for (let n = 0; n < 8; n += 1) await new Promise(resolve => setTimeout(resolve, 0));
}
async function nextPass(w: World, host: HostedWatch) {
  const before = host.state().cycles;
  for (let n = 0; n < 120 && host.state().cycles === before; n += 1) {
    w.clock.at += 5_000;
    host.tick(new Date(w.clock.at));
    await flush();
  }
}

for (const session of [false, true]) {
  test('a hosted root claims its own absent binding and completes repeated passes: session=' + session, async () => {
    const w = world(session);
    const untouched = world();
    untouched.bind(untouched.other);
    const foreign = untouched.bytes();
    const host = start(w);
    await flush();
    expect(host.state()).toMatchObject({ phase: 'running', cycles: 1, effects: 'blocked' });
    expect(w.session()?.watchdog).toEqual({ file: w.teamFile });
    expect(w.session()?.watch).toMatchObject({ pid: process.pid });
    const epoch = w.session()?.watch?.epoch;
    expect(epoch).toMatch(/^watch_[0-9a-f]{32}$/);
    await nextPass(w, host);
    expect(host.state().cycles).toBe(2);
    expect(w.session()?.watch?.epoch).toBe(epoch);
    expect(w.liveReads()).toBeGreaterThanOrEqual(2);
    await host.stop('scene complete');
    expect(w.session()?.watch).toBeUndefined();
    expect(w.session()?.watchdog).toEqual({ file: w.teamFile });
    expect(untouched.bytes()).toBe(foreign);
    expect(w.unsafeWrites()).toBe(0);
  });
}

test('an existing binding to another file is refused without changing any state bytes', async () => {
  const w = world();
  w.bind(w.other);
  const before = w.bytes();
  const host = start(w);
  await flush();
  expect(host.state()).toMatchObject({ phase: 'standby', cycles: 0, effects: 'blocked' });
  expect(host.state().why).toContain(w.other);
  expect(w.bytes()).toBe(before);
  expect(w.liveReads()).toBe(0);
  expect(w.unsafeWrites()).toBe(0);
});

test('a pre-existing own-file alias and its pane metadata are preserved while cycling', async () => {
  const w = world();
  const alias = join(w.dir, 'alias.yaml');
  symlinkSync(w.teamFile, alias);
  w.bind(alias);
  const recorded = w.session()!.watchdog;
  const host = start(w);
  await flush();
  expect(host.state().cycles).toBe(1);
  expect(w.session()?.watchdog).toEqual(recorded);
  expect(w.unsafeWrites()).toBe(0);
});

test('an unreadable state is a refusal and is never replaced by a claim', async () => {
  const w = world();
  const corrupt = '{"format":1, unfinished synthetic writer';
  writeFileSync(join(w.dir, STATE_FILE), corrupt);
  const host = start(w);
  await flush();
  expect(host.state()).toMatchObject({ phase: 'standby', cycles: 0, effects: 'blocked' });
  expect(w.bytes()).toBe(corrupt);
  expect(w.liveReads()).toBe(0);
});

test('a concurrent binding written after construction wins before the first acquire', async () => {
  const w = world();
  const build = hostedWatchAuthority(w.input);
  w.bind(w.other);
  const written = w.bytes();
  const host = start(w, build);
  await flush();
  expect(host.state().cycles).toBe(0);
  expect(host.state().effects).toBe('blocked');
  expect(w.bytes()).toBe(written);
  expect(w.liveReads()).toBe(0);
});

for (const target of ['own', 'other'] as const) {
  test('a busy claim never waits on the writer and preserves its later ' + target + ' binding', async () => {
    const w = world();
    const lock = join(w.dir, LOCK_FILE);
    writeFileSync(lock, String(process.pid) + '\n');
    const before = w.bytes();
    const host = start(w);
    await flush();
    expect(w.bytes()).toBe(before);
    expect(existsSync(lock)).toBe(true);
    expect(host.state().cycles).toBe(0);
    unlinkSync(lock);
    w.bind(target === 'own' ? w.teamFile : w.other);
    const winner = w.session()!.watchdog;
    w.clock.at += 5_000;
    host.tick(new Date(w.clock.at));
    await flush();
    expect(w.session()?.watchdog).toEqual(winner);
    expect(host.state().effects).toBe('blocked');
    expect(host.state().cycles).toBe(target === 'own' ? 1 : 0);
    expect(w.unsafeWrites()).toBe(0);
  });
}

for (const change of ['repoint', 'clear'] as const) {
  test('a concurrent ' + change + ' drains the hosted run and keeps the successor whole', async () => {
    const w = world();
    // Start from an absent binding, so this covers the claim followed by loss as one journey.
    const host = start(w);
    await flush();
    expect(host.state().cycles).toBe(1);
    const successor = mintWatchEpoch();
    updateState(w.dir, state => {
      const session = state.sessions[SESSION]!;
      if (change === 'repoint') session.watchdog = { file: w.other, pane: 'successor' };
      else delete session.watchdog;
      session.watch = { pid: process.pid, epoch: successor, heartbeat: new Date(w.clock.at).toISOString() };
      session.seats.picker = { stage: 'ready', pane: 'successor-pane' };
    });
    const winner = w.bytes();
    w.clock.at += 5_000;
    host.tick(new Date(w.clock.at));
    await flush();
    expect(host.state()).toMatchObject({ phase: 'stopped', cycles: 1, effects: 'blocked' });
    expect(w.bytes()).toBe(winner);
    w.clock.at += 60_000;
    host.tick(new Date(w.clock.at));
    await flush();
    expect(host.state().cycles).toBe(1);
    expect(w.bytes()).toBe(winner);
    expect(w.logs.join('\n')).toContain('binding changed');
    expect(w.unsafeWrites()).toBe(0);
  });
}

for (const change of ['repoint', 'clear'] as const) {
  test('the outbound verifier refuses a ' + change + ' before the next heartbeat', async () => {
    const w = world();
    w.bind();
    let captured: WatchSenderFactoryInput | undefined;
    let sends = 0;
    const build = hostedWatchAuthority({ ...w.input,
      verifyAuthority: check => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(w.clock.at) }),
      sender: input => { captured = input; return async () => { sends += 1; return { ok: true, outcome: 'synthetic delivered' }; }; },
    });
    const host = start(w, build);
    await flush();
    expect(host.state()).toMatchObject({ phase: 'running', effects: 'open', cycles: 1 });
    expect(captured?.verify()).toBe(true);
    updateState(w.dir, state => {
      if (change === 'repoint') state.sessions[SESSION]!.watchdog = { file: w.other };
      else delete state.sessions[SESSION]!.watchdog;
    });
    expect(captured?.verify()).toBe(false);
    expect(host.state().effects).toBe('blocked');
    expect(sends).toBe(0);
    expect(w.logs.join('\n')).toContain('verifier refused');
    expect(w.unsafeWrites()).toBe(0);
  });
}

for (const change of ['unchanged', 'repoint', 'clear'] as const) {
  test('the real idle dispatch reaches only a current binding: ' + change, async () => {
    const w = world();
    w.bind();
    writeFileSync(join(w.dir, 'queue.yaml'), '- id: fruit-1\n  title: Pick the ripe fruit\n');
    updateState(w.dir, state => {
      state.sessions[SESSION]!.seats.picker = { stage: 'ready', last_active: new Date(AT - 900_000).toISOString() };
    });
    w.sources.live = () => ({
      running: true,
      agents: [{ name: 'picker', agent: 'claude', pane: 'fixture-picker', workspace: 'fixture-workspace', status: 'idle', cwd: w.root }],
      workspaces: [{ id: 'fixture-workspace', label: 'picker' }],
      screens: { 'fixture-picker': CLAUDE_IDLE },
    });
    w.sources.screen = () => CLAUDE_IDLE;
    w.sources.status = () => 'idle';
    w.sources.foreground = () => ['claude'];
    let checks = 0;
    let changedDuringPass = false;
    w.sources.readChecks = () => {
      changedDuringPass = true;
      if (change !== 'unchanged') updateState(w.dir, state => {
        if (change === 'repoint') state.sessions[SESSION]!.watchdog = { file: w.other };
        else delete state.sessions[SESSION]!.watchdog;
      });
      return [];
    };
    const sends: WorkPushRequest[] = [];
    const build = hostedWatchAuthority({ ...w.input,
      verifyAuthority: check => {
        checks += 1;
        return verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(w.clock.at) });
      },
      sender: () => async request => { sends.push(request); return { ok: true, outcome: 'synthetic delivered' }; },
    });
    const host = start(w, build);
    await flush();
    expect(changedDuringPass).toBe(true);
    expect(checks).toBeGreaterThan(0);
    expect(sends).toHaveLength(change === 'unchanged' ? 1 : 0);
    if (change === 'unchanged') expect(sends[0]).toMatchObject({ seat: 'picker', pane: 'fixture-picker', cli: 'claude-code' });
    else {
      expect(host.state().effects).toBe('blocked');
      expect(w.logs.join('\n')).toContain('verifier refused');
      expect(w.session()?.watchdog?.file).toBe(change === 'repoint' ? w.other : undefined);
    }
    expect(w.unsafeWrites()).toBe(0);
  });
}

function health(w: World, watch: HostedWatchState | undefined): DaemonHealth {
  return {
    daemon: 'teamcli', socket: join(w.home, 'synthetic.sock'), state: 'running', running: true,
    pid: 123456789, uid: 12345, since: new Date(AT - 600_000).toISOString(), startedBy: 'service-manager',
    version: 'fixture', gitHead: null, heartbeatAt: new Date(AT).toISOString(), features: { broker: 'absent' },
    heartbeatSeconds: null,
    stuck: [], why: null, probe: { state: 'answered', at: new Date(AT).toISOString() },
    roots: [{ root: w.root, team: 'orchard', send: 'serving', bus: 'serving', why: null, ...(watch === undefined ? {} : { watch }) }],
  };
}
function snapshot(w: World, over: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: 'synthetic-route', root: w.root, team: 'orchard', session: SESSION, phase: 'running',
    startedAt: new Date(AT - 600_000).toISOString(), lastCycleAt: new Date(AT - 5_000).toISOString(),
    lastCycleOutcome: 'pass', cycles: 10, failures: 0, effects: 'open', required: true, why: null, ...over,
  };
}
type Difference = { what: string; repair: string; who: string };
function check(w: World, watch: HostedWatchState | undefined, json = true) {
  let out = ''; let err = '';
  const io: Io = { cwd: w.root, env: {}, caller: { kind: 'owner' }, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: text => { out += text; }, stderr: text => { err += text; } };
  const before = w.bytes();
  const code = runTeamCheck({ file: w.teamFile, json }, io, {
    home: w.home, now: () => new Date(AT), standing: () => ({ kind: 'none' }), branch: () => 'main',
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    alive: () => false, daemon: health(w, watch), pendingGreen: () => [],
  });
  expect(w.bytes()).toBe(before);
  const doc = json ? JSON.parse(out) as { differences: Difference[]; notes: string[]; summary: { differences: number; owner_differences: number } } : undefined;
  return { out, err, code, doc, watchDifferences: doc?.differences.filter(item => item.what.startsWith('watch:')) ?? [] };
}

for (const phase of ['stopped', 'failed'] as const) {
  for (const json of [true, false]) {
    test('check counts a required ' + phase + ' hosted watch and names its repair: json=' + json, () => {
      const w = world();
      const reading = snapshot(w, { phase, effects: 'blocked', why: 'synthetic stopped run' });
      const got = check(w, reading, json);
      expect(got.code).toBe(1);
      const what = 'watch: ' + phase + ' in the daemon (synthetic stopped run)';
      if (json) {
        expect(got.watchDifferences).toEqual([{ what, repair: 'team daemon install with the same roots and --watch', who: 'the owner' }]);
        const control = check(w, snapshot(w));
        expect(got.doc!.summary.differences).toBe(control.doc!.summary.differences + 1);
        expect(got.doc!.summary.owner_differences).toBe(control.doc!.summary.owner_differences + 1);
        expect(got.doc!.notes.some(note => note.startsWith('watch:'))).toBe(false);
      } else {
        expect(got.out).toContain('difference: ' + what + '\n  repair: team daemon install with the same roots and --watch');
        expect(got.out).not.toContain('note: watch: ');
      }
      expect(got.err).toBe('');
    });
  }
}

test('check counts a blocked outbound gate while the hosted watch is running', () => {
  const w = world();
  const got = check(w, snapshot(w, { effects: 'blocked' }));
  expect(got.code).toBe(1);
  expect(got.watchDifferences).toEqual([{
    what: 'watch: outbound effects blocked; it is not enforcing anything',
    repair: 'team daemon install with the same roots and --watch', who: 'the owner',
  }]);
  const control = check(w, snapshot(w));
  expect(got.doc!.summary.differences).toBe(control.doc!.summary.differences + 1);
  expect(got.doc!.summary.owner_differences).toBe(control.doc!.summary.owner_differences + 1);
  expect(got.doc!.notes.some(note => note.includes('outbound effects blocked'))).toBe(false);
});

for (const phase of ['starting', 'running', 'standby', 'stopping', 'stopped', 'failed'] as const) {
  test('check does not invent a watch difference for the control phase ' + phase, () => {
    const w = world();
    const got = check(w, snapshot(w, { phase, required: phase !== 'stopped' && phase !== 'failed' }));
    expect(got.watchDifferences).toEqual([]);
  });
}

test('a route never configured with a hosted watch gains no hosted-watch difference', () => {
  const w = world();
  expect(check(w, undefined).watchDifferences).toEqual([]);
});

test('a failed prior cycle keeps its note beside a blocked gate difference', () => {
  const w = world();
  const got = check(w, snapshot(w, { effects: 'blocked', lastCycleOutcome: 'failed', failures: 1 }));
  expect(got.watchDifferences).toHaveLength(1);
  expect(got.doc!.notes.some(note => note.startsWith('watch: the last cycle failed'))).toBe(true);
  expect(got.doc!.notes.some(note => note.includes('outbound effects blocked'))).toBe(false);
});

async function registryScene(body: (own: World, foreign: World) => Promise<void>) {
  const own = world();
  const foreign = world();
  // Import both definitions into this one synthetic home, then retire the owned fixture
  // files. No existing file can accidentally prove either binding in these scenes.
  intoRegistry(own.root, own.home);
  intoRegistry(foreign.root, own.home);
  unlinkSync(own.teamFile);
  unlinkSync(foreign.teamFile);
  expect(existsSync(own.teamFile)).toBe(false);
  expect(existsSync(foreign.teamFile)).toBe(false);
  const began = hosts.length;
  await underRegistry(async () => {
    try { await body(own, foreign); }
    finally {
      // The loop reloads its team on every pass, including a resumed pass. Keep the source
      // in force until every host from this scene has exited.
      for (const host of hosts.slice(began)) await host.stop('registry scene complete');
    }
  });
}

test('a registry-only team claims its resolved identity and cycles across repeated reloads', async () => {
  await registryScene(async w => {
    const host = start(w);
    await flush();
    expect(host.state()).toMatchObject({ phase: 'running', cycles: 1 });
    expect(w.session()?.watchdog).toEqual({ file: w.teamFile });
    const epoch = w.session()?.watch?.epoch;
    await nextPass(w, host);
    expect(host.state().cycles).toBe(2);
    expect(w.session()?.watch?.epoch).toBe(epoch);
    expect(existsSync(w.teamFile)).toBe(false);
    expect(w.unsafeWrites()).toBe(0);
  });
});

test('a registry-only binding spelled through its root alias keeps its metadata and cycles', async () => {
  await registryScene(async w => {
    const alias = join(w.base, 'registry-root-alias');
    symlinkSync(w.root, alias);
    const handle = join(alias, '.agents', 'team.yaml');
    w.bind(handle);
    const recorded = w.session()!.watchdog;
    const host = start(w);
    await flush();
    expect(host.state()).toMatchObject({ phase: 'running', cycles: 1 });
    expect(w.session()?.watchdog).toEqual(recorded);
    expect(existsSync(handle)).toBe(false);
    expect(w.unsafeWrites()).toBe(0);
  });
});

test('a binding naming another registry-only root in the same home is never replaced', async () => {
  await registryScene(async (w, foreign) => {
    w.bind(foreign.teamFile);
    const before = w.bytes();
    const host = start(w);
    await flush();
    expect(host.state()).toMatchObject({ phase: 'standby', cycles: 0, effects: 'blocked' });
    expect(host.state().why).toContain(foreign.teamFile);
    expect(w.bytes()).toBe(before);
    expect(w.liveReads()).toBe(0);
    expect(w.unsafeWrites()).toBe(0);
  });
});

test('a different missing name beside a registry-only team is not that team identity', async () => {
  await registryScene(async w => {
    w.bind(join(w.dir, 'not-the-team.yaml'));
    const before = w.bytes();
    const host = start(w);
    await flush();
    expect(host.state()).toMatchObject({ phase: 'standby', cycles: 0, effects: 'blocked' });
    expect(w.bytes()).toBe(before);
    expect(w.liveReads()).toBe(0);
  });
});

test('the shared outbound verifier admits the registry identity and refuses a foreign registry root before a beat', async () => {
  await registryScene(async (w, foreign) => {
    // The verifier resolves its default home at runtime startup. A child with its HOME set
    // before import proves the real default-source path without changing another test's home.
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL('./hosted-watch-registry-worker.ts', import.meta.url)), w.root, w.home, foreign.teamFile,
    ], { encoding: 'utf8', env: { ...process.env, HOME: w.home, TEAM_CONFIG_SOURCE: 'registry' }, timeout: 10_000 });
    expect(JSON.parse(output)).toEqual({ cycles: 1, admitted: true, afterRepoint: false, effects: 'blocked', sends: 0, paneWrites: 0 });
    expect(w.session()?.watchdog?.file).toBe(foreign.teamFile);
    expect(w.session()?.watch).toBeUndefined();
    expect(w.unsafeWrites()).toBe(0);
  });
});
