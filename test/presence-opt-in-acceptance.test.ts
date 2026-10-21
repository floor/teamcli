// Independent acceptance for the presence opt-in chain at 742d5a1c0: the service unit
// (a0fb1fc12), the hosted send server's per-seat proof (38677807f) and the strict endpoint reader
// (742d5a1c0, shared with cc6016621).
//
// Every world is synthetic: a scratch team and state under a temporary directory, the real service
// adapter writing its unit with an injected runner (no service-manager call leaves the process), the
// real `team daemon install/run` command surface, and the real machine daemon with its presence
// pipeline. No live install, reload, service, seat, pane or credential file is touched.
//
// The three things that must stay true: the default is off (a plain install writes no flag, a
// plain run passes no presence fields, and a service-manager start without the flag hosts no
// presence); the service unit is the one no-terminal start admitted, carrying the exact run
// command plus the opt-in only when installed with it, while a manual no-terminal start stays
// refused; and when hosting is on, the send server gets the team file's own presence folder and a
// per-seat channel answer. At the last mile the pair decides: a working projection holds with the
// channel proven, the same projection holds without the opt-in because the channel is then
// unproven, a projected idle types, and a seat with no projection keeps the labelled fallback.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { createPresenceActivity } from '../src/daemon/presence/activity.ts';
import { mintPresenceBinding, readPresenceReading } from '../src/daemon/presence/contract.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceManager, ServiceProgram } from '../src/daemon/service.ts';
import { startSendDaemon, type DaemonHost } from '../src/send/daemon.ts';
import { STATE_FILE } from '../src/state.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
# The typed leg, so a delivery reaches the daemon's last mile without the default drop step.
delivery_order: [mcp-inbox, typed]
`;

const SEAT_ID = 'seat_0123456789ab';
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; dir: string; sockets: string };

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'o-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'h');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEAM);
  return { base, root, home, dir, sockets };
}

const owner = { kind: 'owner' } as const;

function sourcesOf(home: string, overrides: Partial<DaemonCommandSources> = {}): DaemonCommandSources {
  return {
    home,
    program: { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js' },
    version: 'test',
    ...overrides,
  };
}

function writeSeatState(dir: string, fields: Record<string, unknown>): void {
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
    format: 1,
    sessions: { acme: { seats: { clerk: { id: SEAT_ID, stage: 'ready', ...fields } }, worktrees: {} } },
  })}\n`);
}

/** The arguments the written unit itself would start, read back out of its ProgramArguments. */
function unitArguments(unitPath: string): string[] {
  const text = readFileSync(unitPath, 'utf8');
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (block === undefined) throw new Error('the unit has no ProgramArguments');
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((one) => one[1] as string);
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted presence reading');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The presence reading for one seat, or null while it is not serving yet. */
async function seatReading(home: string, seat: string): Promise<{ state: string; healthy: boolean } | null> {
  const reading = await daemonHealth(home);
  const presence = reading.roots?.[0]?.presence;
  const seats = presence !== undefined && 'seats' in presence ? presence.seats : undefined;
  if (presence?.state !== 'serving') return null;
  return seats?.find((one) => one.seat === seat) ?? null;
}

/** The seat's applied projection state, read from the file the presence pipeline writes. */
async function projectionState(dir: string, seat: string): Promise<string | null> {
  const paths = presencePaths(dir, 'acme', seat);
  if (paths === null) return null;
  try {
    const read = readPresenceReading(readFileSync(paths.current, 'utf8'));
    return read.kind === 'ok' ? read.reading.state : null;
  } catch {
    return null;
  }
}

/** Runs the real producer once for a scene whose daemon deliberately hosts no presence. */
async function ingestOnce(dir: string, seat: string): Promise<void> {
  const ingester = createPresenceIngester({ stateDir: dir, session: 'acme', now: () => new Date() });
  const step = await ingester.step();
  expect(step.ingested.length).toBeGreaterThan(0);
  expect(step.errors).toEqual([]);
  const applied = await createPresenceActivity({ stateDir: dir, session: 'acme', seats: [seat] })(new Date());
  expect(applied.failed).toBeNull();
}

describe('the presence opt-in default and the service unit', () => {
  test('a plain install writes no flag; install --presence records the exact run opt-in', async () => {
    const { root, home } = world();
    const programs: ServiceProgram[] = [];
    const service: ServiceManager = {
      kind: 'system-service-manager',
      unitPath: (at) => join(at, 'unit.plist'),
      plan: (at, program) => ({ unitPath: join(at, 'unit.plist'), program: [program.execPath, program.entry] }),
      install: (at, program) => {
        programs.push(program);
        return { ok: true, unitPath: join(at, 'unit.plist') };
      },
      uninstall: (at) => ({ ok: true, unitPath: join(at, 'unit.plist'), removed: true }),
    };

    const plain = testIo(root, owner);
    expect(await runDaemon(['install'], plain, sourcesOf(home, { service }))).toBe(0);
    expect(programs.at(-1)).toEqual({ execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: [root] });
    expect(programs.at(-1)?.presence).toBeUndefined();

    const opted = testIo(root, owner);
    expect(await runDaemon(['install', '--presence'], opted, sourcesOf(home, { service }))).toBe(0);
    expect(programs.at(-1)).toEqual({
      execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: [root], presence: true,
    });
    expect(opted.out).toContain('team daemon: installed');
  });

  test('the real unit carries --presence exactly when installed with it, and its own argv is admitted', async () => {
    const { root, home } = world();
    const calls: string[][] = [];
    const manager = darwinServiceManager({
      runner: (command, args) => {
        calls.push([command, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      },
      uid: 501,
    });

    const plainUnit = manager.install(home, {
      execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: [root],
    });
    expect(plainUnit.ok).toBe(true);
    if (!plainUnit.ok) return;
    const plainArgs = unitArguments(plainUnit.unitPath);
    expect(plainArgs).toEqual([
      '/runtime/bin/node', '/app/dist/cli.js', 'daemon', 'run',
      '--started-by', 'service-manager', '--root', root,
    ]);
    expect(plainArgs).not.toContain('--presence');

    const optedUnit = manager.install(home, {
      execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: [root], presence: true,
    });
    expect(optedUnit.ok).toBe(true);
    if (!optedUnit.ok) return;
    const optedArgs = unitArguments(optedUnit.unitPath);
    expect(optedArgs).toEqual([
      '/runtime/bin/node', '/app/dist/cli.js', 'daemon', 'run',
      '--started-by', 'service-manager', '--root', root, '--presence',
    ]);
    expect(calls.every((call) => call[0] === 'launchctl')).toBe(true);

    // The unit's own argv, replayed through the command: the no-terminal owner is admitted
    // because the source is service-manager, and the presence fields follow the unit's flag.
    const seen: Array<Parameters<typeof startMachineDaemon>[0]> = [];
    const start = async (input: Parameters<typeof startMachineDaemon>[0]) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 42 };
    };
    const unitIo = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(optedArgs.slice(3), unitIo, sourcesOf(home, { start }))).toBe(0);
    expect(seen[0]).toMatchObject({ startedBy: 'service-manager', roots: [root], presenceHosting: true });
    expect(seen[0]?.presenceCodexEndpoint).toBeDefined();

    const plainIo = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(plainArgs.slice(3), plainIo, sourcesOf(home, { start }))).toBe(0);
    expect(seen[1]).toMatchObject({ startedBy: 'service-manager', roots: [root] });
    expect(seen[1]?.presenceHosting).toBeUndefined();
    expect(seen[1]?.presenceCodexEndpoint).toBeUndefined();

    // A no-terminal manual start is not admitted, with or without the opt-in.
    const manual = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(['run', '--presence'], manual, sourcesOf(home, { start }))).toBe(1);
    expect(manual.err).toContain('only the owner or the system service manager runs the machine daemon');
    expect(seen).toHaveLength(2);

    // A foreground owner run still takes the flag; status refuses it.
    const foreground = testIo(root, owner);
    expect(await runDaemon(['run', '--presence'], foreground, sourcesOf(home, { start }))).toBe(0);
    expect(seen[2]?.presenceHosting).toBe(true);
    const refused = testIo(root, owner);
    expect(await runDaemon(['status', '--presence'], refused, sourcesOf(home))).toBe(2);
    expect(refused.err).toContain('--presence belongs to run or install');
  });
});

describe('the strict endpoint reader behind the opt-in', () => {
  test('only the exact record under the current binding is handed to the presence work', async () => {
    const { root, home, dir } = world();
    const seen: Array<Parameters<typeof startMachineDaemon>[0]> = [];
    const start = async (input: Parameters<typeof startMachineDaemon>[0]) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 42 };
    };
    expect(await runDaemon(['run', '--presence'], testIo(root, owner), sourcesOf(home, { start }))).toBe(0);
    expect(seen[0]?.presenceHosting).toBe(true);
    const endpoint = seen[0]?.presenceCodexEndpoint;
    expect(endpoint).toBeDefined();
    const route: HostedRoute = { root, team: 'acme', session: 'acme', seats: ['clerk', 'op-1'] };
    const at = (): string | null | undefined => endpoint?.(route, dir, 'clerk');

    const binding = mintPresenceBinding();
    const predecessor = mintPresenceBinding();
    const url = `unix:///private/tmp/launch/${binding}.sock`;
    const record = (fields: Record<string, unknown>): Record<string, unknown> => ({
      url, binding, pid: 4242, started_at: '2026-10-20T05:00:00.000Z', ...fields,
    });

    writeSeatState(dir, { presence_binding: binding, codex_endpoint: record({}) });
    expect(at()).toBe(url);

    // A seat the team file does not record, and an unreadable state file, answer no endpoint.
    expect(endpoint?.(route, dir, 'op-1')).toBeNull();
    writeFileSync(join(dir, STATE_FILE), 'not a state file\n');
    expect(at()).toBeNull();

    const refusals: { name: string; fields: Record<string, unknown>; endpoint: unknown }[] = [
      { name: 'predecessor binding', fields: { presence_binding: predecessor, codex_endpoint: record({}) }, endpoint: record({}) },
      { name: 'array', fields: { presence_binding: binding, codex_endpoint: [] }, endpoint: [] },
      {
        name: 'normalized timestamp',
        fields: { presence_binding: binding, codex_endpoint: record({ started_at: '2026-10-20T05:00:00.000+00:00' }) },
        endpoint: record({ started_at: '2026-10-20T05:00:00.000+00:00' }),
      },
      { name: 'pid zero', fields: { presence_binding: binding, codex_endpoint: record({ pid: 0 }) }, endpoint: record({ pid: 0 }) },
      { name: 'pid fractional', fields: { presence_binding: binding, codex_endpoint: record({ pid: 1.5 }) }, endpoint: record({ pid: 1.5 }) },
      {
        name: 'pid past the safe range',
        fields: { presence_binding: binding, codex_endpoint: record({ pid: Number.MAX_SAFE_INTEGER + 1 }) },
        endpoint: record({ pid: Number.MAX_SAFE_INTEGER + 1 }),
      },
      { name: 'relative URL', fields: { presence_binding: binding, codex_endpoint: record({ url: `unix://${binding}.sock` }) }, endpoint: record({ url: `unix://${binding}.sock` }) },
      { name: 'no current binding', fields: { codex_endpoint: record({}) }, endpoint: record({}) },
    ];
    for (const refusal of refusals) {
      writeSeatState(dir, refusal.fields);
      expect({ name: refusal.name, endpoint: at() }).toEqual({ name: refusal.name, endpoint: null });
    }
  });
});

/** The fake pane/host surface the real send daemon types through; no herdr is read. */
function sendHost(w: World): DaemonHost & SendHost & { typed: { pane: string; text: string }[]; enters: string[] } {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const statusByPane: Record<string, string> = { 'pane-clerk': 'idle', 'pane-op-1': 'idle' };
  const rule = '\u2500'.repeat(30);
  return {
    typed,
    enters,
    agents: () => [
      { name: 'clerk', pane: 'pane-clerk' },
      { name: 'op-1', pane: 'pane-op-1' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session, pane) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((one) => one.pane === pane);
        if (last !== undefined && !enters.includes(pane)) return `${rule}\n\u276f ${last.text}\n${rule}`;
        return `${rule}\n\u276f \n${rule}`;
      },
    },
    now: () => new Date(),
    home: w.home,
    deliverWaitMs: 80,
    pollReadyMs: 5,
  };
}

function stageEvent(w: World, seat: string, event: 'turn-start' | 'turn-end', binding: string, at: number): void {
  const staged = stagePresenceRecord(w.dir, {
    session: 'acme', seat, binding, source: 'runtime-hook', event, ts: new Date(at).toISOString(),
  });
  expect(staged.kind).toBe('staged');
}

describe('the hosted send server per-seat proof', () => {
  test('off passes neither field; on passes the team folder and a default-closed per-seat answer', async () => {
    const w = world();
    const binding = mintPresenceBinding();
    writeSeatState(w.dir, { presence_binding: binding });
    const sends: Array<Parameters<typeof startSendDaemon>[0]> = [];
    const sendStart = async (input: Parameters<typeof startSendDaemon>[0]) => {
      sends.push(input);
      return { kind: 'already-running' as const, socketPath: join(w.home, 'no-send.sock'), pid: null };
    };

    const off = await startMachineDaemon({ home: w.home, roots: [w.root], startedBy: 'manual', version: 'test', sendStart });
    expect(off.kind).toBe('serving');
    if (off.kind !== 'serving') return;
    await off.daemon.close();
    expect(sends[0]?.presenceStateDir).toBeUndefined();
    expect(sends[0]?.presenceChannelHealthy).toBeUndefined();

    const on = await startMachineDaemon({
      home: w.home, roots: [w.root], startedBy: 'manual', version: 'test', sendStart,
      presenceHosting: true, presenceEveryMs: 10,
    });
    expect(on.kind).toBe('serving');
    if (on.kind !== 'serving') return;
    try {
      expect(sends[1]?.presenceStateDir).toBe(w.dir);
      const healthy = sends[1]?.presenceChannelHealthy;
      expect(healthy).toBeDefined();
      // Default-closed during startup, and a name outside the route never answers true.
      expect(healthy?.('clerk')).toBe(false);
      expect(healthy?.('op-1')).toBe(false);
      expect(healthy?.('outsider')).toBe(false);
      // The channel goes current from the daemon's own pass; only then does the bound hook seat
      // qualify. The unbound sibling stays false: it records no binding to fence.
      stageEvent(w, 'clerk', 'turn-end', binding, Date.now() - 5000);
      await waitFor(() => healthy?.('clerk') === true, 8000);
      expect(healthy?.('op-1')).toBe(false);
    } finally {
      await on.daemon.close();
    }
  }, 25_000);

  test('the last mile holds a working projection with and without the opt-in, and types only a projected idle', async () => {
    const w = world();
    const binding = mintPresenceBinding();
    writeSeatState(w.dir, { presence_binding: binding });
    const host = sendHost(w);
    const t0 = Date.now() - 60_000;

    // Default off: the same team folder is read, but no channel proof is passed, so a projected
    // turn holds rather than being believed from the screen's idle word.
    const off = await startMachineDaemon({ home: w.home, roots: [w.root], startedBy: 'manual', version: 'test', sendHost: host });
    expect(off.kind).toBe('serving');
    if (off.kind !== 'serving') return;
    try {
      stageEvent(w, 'clerk', 'turn-start', binding, t0);
      // The daemon hosts no presence; the scene runs the real producer once so the send last
      // mile has a current projection to judge. Its channel stays unproven either way.
      await ingestOnce(w.dir, 'clerk');
      await waitFor(async () => (await projectionState(w.dir, 'clerk')) === 'working');
      const io = testIo(w.root, owner);
      expect(await runSend(['clerk', 'do not clobber the unproven turn', '--json'], io, host)).toBe(1);
      const refused = JSON.parse(io.out.trim()) as { error: { id: string; message: string } };
      expect(refused.error.id).toBe('send.held');
      expect(refused.error.message).toContain('the seat\'s native presence does not allow typing');
      expect(refused.error.message).toContain('the presence channel is not known healthy this pass');
      expect(host.typed).toEqual([]);
      expect(host.enters).toEqual([]);
    } finally {
      await off.daemon.close();
    }
    // The projection belongs to the same seat; the opt-in start re-reads it.
    const on = await startMachineDaemon({
      home: w.home, roots: [w.root], startedBy: 'manual', version: 'test', sendHost: host,
      presenceHosting: true, presenceEveryMs: 10,
    });
    expect(on.kind).toBe('serving');
    if (on.kind !== 'serving') return;
    try {
      // The daemon's health reading carries the same per-seat verdict the send server asks.
      await waitFor(async () => (await seatReading(w.home, 'clerk'))?.healthy === true, 8000);
      // The proven channel still holds the running turn: the runtime record outranks the idle
      // screen, and the message names the turn as the reason.
      const working = testIo(w.root, owner);
      expect(await runSend(['clerk', 'still do not clobber', '--json'], working, host)).toBe(1);
      const held = JSON.parse(working.out.trim()) as { error: { id: string; message: string } };
      expect(held.error.id).toBe('send.held');
      expect(held.error.message).toContain('the seat\'s native presence does not allow typing');
      expect(held.error.message).toContain('working');
      expect(host.typed).toEqual([]);
      expect(host.enters).toEqual([]);

      // The projected turn ends: the last mile may now type once.
      stageEvent(w, 'clerk', 'turn-end', binding, t0 + 1000);
      await waitFor(async () => (await projectionState(w.dir, 'clerk')) === 'idle');
      const idle = testIo(w.root, owner);
      expect(await runSend(['clerk', 'the projected turn ended'], idle, host)).toBe(0);
      expect(idle.out).toContain('clerk: sent (unconfirmed)');
      expect(host.typed).toHaveLength(1);
      expect(host.enters).toHaveLength(1);

      // A seat with no binding and no projection keeps the labelled fallback: the legacy path
      // exists only where there is no native record to prove.
      const fallback = testIo(w.root, owner);
      expect(await runSend(['op-1', 'legacy unbound seat'], fallback, host)).toBe(0);
      expect(fallback.out).toContain('op-1: sent (unconfirmed)');
      expect(host.typed).toHaveLength(2);
      expect(host.enters).toHaveLength(2);
    } finally {
      await on.daemon.close();
    }
  }, 30_000);
});
