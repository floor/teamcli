// The daemon's isolated chores: where the heavy per-root work runs, and how a child that stops
// answering is replaced. The policy decides per root — `inline` is the rollback to the one loop
// the daemon always had, `per-root` (the default) one child each, `shared` one child for a group
// whose roots take turns a slice at a time — and the supervisor starts, watches and replaces the
// children on the daemon's own beat. A child proves it was started from here through a one-use
// token and speaks one newline-framed JSON line per message on its standard streams.
//
// The blocking fixtures hold their work for the stretch the test names: the machine socket, the
// health probe and a sibling root's chores are observed from timers, never from wall time,
// because the point of the isolation is that one root's work cannot hold the others.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readEvents } from '../src/bus/log.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { messageFile } from '../src/commands/messages.ts';
import { serveChoresChild, type ChoresSlices } from '../src/daemon/chores/child.ts';
import { createFallbackPass } from '../src/daemon/chores/fallback.ts';
import { createPresencePass } from '../src/daemon/chores/presence.ts';
import { FALLBACK_STORE_PASS_MS } from '../src/daemon/fallback-sweep.ts';
import { choresPolicyFor, tightestPolicy, type ChoresPolicy } from '../src/daemon/chores/policy.ts';
import {
  parseChoresFrame,
  readChildMessage,
  readHostMessage,
  type ChoresChildMessage,
  type ChoresHostMessage,
  type ChoresPresenceReading,
} from '../src/daemon/chores/protocol.ts';
import {
  spawnChoresChild,
  type ChoresChild,
  type ChoresChildEvent,
  type SpawnChoresInput,
} from '../src/daemon/chores/spawn.ts';
import {
  createChoresFleet,
  type ChoresFleet,
  type ChoresRouteInput,
} from '../src/daemon/chores/supervisor.ts';
import type { ChoresWatchInput } from '../src/daemon/chores/watch.ts';
import { daemonHealth, probeDaemonHealth } from '../src/daemon/health.ts';
import type { PresenceSourceStatus } from '../src/daemon/presence/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { machineConfigDir, daemonLogPath, daemonSocketPath } from '../src/daemon/paths.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { readDaemonState, writeDaemonState, type DaemonChoresState, type DaemonState } from '../src/daemon/state.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  escalatedRecordId,
  escalationMailboxId,
  markerPathOf,
  noteTransport,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackMarker,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { testIo } from './helpers.ts';

const TEAM_YAML = `format: 1
entity: floor
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const NOW = Date.parse('2026-11-02T03:00:00Z');
const AT = new Date(NOW).toISOString();
const DIGEST = 'a'.repeat(64);
const CALLER = { kind: 'seat', name: 'crew-lead', pane: 'p1', session: 'acme-dev' } as const;
const dirs: string[] = [];
/** A flat CPU reading: these synthetic children have no process behind them, so the supervisor
 *  is handed the reading it should judge instead of probing the machine. */
const flatCpu = (): number => 5_000;


/** A fixture child: consumes its token, heartbeats on the beat the token carries, and holds its
 *  own event loop on the first nudge for the stretch `CHORES_FIXTURE_BLOCK_MS` names. */
const FIXTURE_CHILD = [
  '// A fixture chores child: consumes its token, heartbeats on the beat it carries, and holds',
  '// its own event loop on the first nudge for the stretch the test names.',
  "import { readFileSync, unlinkSync } from 'node:fs';",
  "import { join } from 'node:path';",
  '',
  "const at = process.argv.indexOf('--inherited');",
  "const nonce = at === -1 ? '' : (process.argv[at + 1] ?? '');",
  "const token = join(process.env.HOME ?? '', '.config', 'team', 'chores.inherit.' + nonce + '.json');",
  'let config = { beatMs: 200 };',
  'try {',
  "  config = JSON.parse(readFileSync(token, 'utf8'));",
  '  unlinkSync(token);',
  '} catch {}',
  "const beatMs = typeof config.beatMs === 'number' ? config.beatMs : 200;",
  "const blockMs = Number(process.env.CHORES_FIXTURE_BLOCK_MS ?? '0');",
  'const write = (message) => {',
  '  try {',
  '    process.stdout.write(JSON.stringify(message) + "\\n");',
  '  } catch {}',
  '};',
  'const now = () => new Date().toISOString();',
  'const beat = () => write({ type: "heartbeat", at: now(), rssBytes: process.memoryUsage().rss, busy: null });',
  'write({ type: "ready", pid: process.pid, at: now() });',
  'beat();',
  'const timer = setInterval(beat, beatMs);',
  'let blocked = false;',
  'let buffer = "";',
  "process.stdin.setEncoding('utf8');",
  'process.stdin.on("data", (chunk) => {',
  '  buffer += chunk;',
  '  let nl = buffer.indexOf("\\n");',
  '  while (nl !== -1) {',
  '    const line = buffer.slice(0, nl);',
  '    buffer = buffer.slice(nl + 1);',
  '    nl = buffer.indexOf("\\n");',
  '    let message = null;',
  '    try {',
  '      message = JSON.parse(line);',
  '    } catch {}',
  '    if (message !== null && message.type === "tick" && !blocked && blockMs > 0) {',
  '      blocked = true;',
  '      write({ type: "heartbeat", at: now(), rssBytes: process.memoryUsage().rss, busy: "blocked" });',
  '      const end = Date.now() + blockMs;',
  '      while (Date.now() < end) {}',
  '      beat();',
  '    } else if (message !== null && message.type === "stop") {',
  '      clearInterval(timer);',
  '      write({ type: "stopped", why: "ask" });',
  '      process.exit(0);',
  '    }',
  '  }',
  '});',
  'process.stdin.on("end", () => {',
  '  clearInterval(timer);',
  '  process.exit(0);',
  '});',
].join('\n');

/** A fixture child for a shared group: it answers a pass for every root, and holds the first
 *  root in an awaited block for the stretch the test names, so the other root's pass can be
 *  observed while that wait is still running. */
const SHARED_FIXTURE_CHILD = [
  '// A fixture chores child for a shared group: it heartbeats, answers a pass for every root,',
  '// and holds the first root in an awaited block for the stretch `CHORES_FIXTURE_BLOCK_MS` names.',
  "import { readFileSync, unlinkSync } from 'node:fs';",
  "import { join } from 'node:path';",
  '',
  "const at = process.argv.indexOf('--inherited');",
  "const nonce = at === -1 ? '' : (process.argv[at + 1] ?? '');",
  "const token = join(process.env.HOME ?? '', '.config', 'team', 'chores.inherit.' + nonce + '.json');",
  'let config = { beatMs: 200, routes: [] };',
  'try {',
  "  config = JSON.parse(readFileSync(token, 'utf8'));",
  '  unlinkSync(token);',
  '} catch {}',
  'const routes = Array.isArray(config.routes) ? config.routes : [];',
  "const beatMs = typeof config.beatMs === 'number' ? config.beatMs : 200;",
  "const blockMs = Number(process.env.CHORES_FIXTURE_BLOCK_MS ?? '0');",
  'let blocked = false;',
  'let stopping = false;',
  'let started = false;',
  'const write = (message) => {',
  '  try {',
  '    process.stdout.write(JSON.stringify(message) + "\\n");',
  '  } catch {}',
  '};',
  'const now = () => new Date().toISOString();',
  'const beat = () => write({ type: "heartbeat", at: now(), rssBytes: process.memoryUsage().rss, busy: blocked ? "blocked" : null, markerCache: { read: 7, reused: 4, cached: 3 } });',
  'write({ type: "ready", pid: process.pid, at: now() });',
  'beat();',
  'const timer = setInterval(beat, beatMs);',
  'const passFor = (route) => write({ type: "pass", passes: [{ root: route.root, at: now(), notes: [], chore: "fallback", ms: 5 }] });',
  'const runSlice = async (route) => {',
  '  if (!blocked && blockMs > 0) {',
  '    blocked = true;',
  '    beat();',
  '    const end = Date.now() + blockMs;',
  '    while (!stopping && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));',
  '    blocked = false;',
  '    beat();',
  '  }',
  '  passFor(route);',
  '};',
  'const start = () => {',
  '  if (started) return;',
  '  started = true;',
  '  void (async () => {',
  '    for (const route of routes) {',
  '      void runSlice(route);',
  '      await new Promise((resolve) => setImmediate(resolve));',
  '    }',
  '  })();',
  '};',
  'const finish = () => {',
  '  stopping = true;',
  '  clearInterval(timer);',
  '  write({ type: "stopped", why: "ask" });',
  '  process.exit(0);',
  '};',
  'let buffer = "";',
  "process.stdin.setEncoding('utf8');",
  'process.stdin.on("data", (chunk) => {',
  '  buffer += chunk;',
  '  let nl = buffer.indexOf("\\n");',
  '  while (nl !== -1) {',
  '    const line = buffer.slice(0, nl);',
  '    buffer = buffer.slice(nl + 1);',
  '    nl = buffer.indexOf("\\n");',
  '    let message = null;',
  '    try {',
  '      message = JSON.parse(line);',
  '    } catch {}',
  '    if (message !== null && message.type === "tick") start();',
  '    else if (message !== null && message.type === "stop") finish();',
  '  }',
  '});',
  'process.stdin.on("end", finish);',
].join('\n');

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string };

function repo(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  return root;
}

function register(home: string, root: string): void {
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
}

function world(name = 'repo'): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-chores-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const root = repo(base, name);
  register(home, root);
  return { base, root, home };
}

function teamFile(): TeamFile {
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function policy(over: Partial<ChoresPolicy> = {}): ChoresPolicy {
  return { mode: 'per-root', sliceMs: 2000, missedBeats: 2, backoffCapMs: 30_000, ...over };
}

function word(home: string, root: string, name: string, value: unknown): void {
  const wrote = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name, value }, { now: new Date(NOW) });
  expect(wrote.ok).toBe(true);
}

function routeInput(root: string, one: ChoresPolicy): ChoresRouteInput {
  return { route: routeOf(root, 'acme', 'acme-dev', ['crew-lead']), team: teamFile(), policy: one };
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the chores state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A second, entity-level registry record: the lead a pass that names no orchestrator climbs to,
 *  exactly as the machine daemon's own fallback pass must. `register` files the checkout under
 *  its own project, so only this record has `project === entity` and answers the climb. */
function entityLead(home: string, base: string): string {
  const root = repo(base, 'floor-lobby');
  upsertTeam(home, teamIdOf(root), {
    project: 'floor',
    entity: 'floor',
    session: 'floor-dev',
    root,
    roster: [{ agent: 'agt_floorlead000', seat: 'floor-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  return root;
}

const recipientOf = (root: string): CanonicalRecipient => ({
  team: 'acme',
  seat: 'crew-lead',
  toId: null,
  session: 'acme-dev',
  root,
});

function writeMarkerFile(recipient: CanonicalRecipient, messageId: string, marker: FallbackMarker): void {
  const path = markerPathOf(recipient, messageId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker));
}

function markerNow(recipient: CanonicalRecipient, messageId: string): FallbackMarker | null {
  try {
    return JSON.parse(readFileSync(markerPathOf(recipient, messageId), 'utf8')) as FallbackMarker;
  } catch {
    return null;
  }
}

/** A due episode as a failed walk leaves it: every route gone, the escalation scheduled at
 *  `dueAt`, no intent and no escalation decided yet. */
function dueMarker(root: string, messageId: string, dueAt: number): CanonicalRecipient {
  const recipient = recipientOf(root);
  writeMarkerFile(recipient, messageId, {
    format: 1,
    messageId,
    recipient,
    recordDigest: DIGEST,
    sender: 'owner',
    status: 'all-failed',
    attempts: [],
    allFailedAt: new Date(dueAt - 60_000).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
    receipt: { kind: 'unknown' },
    updatedAt: new Date(dueAt).toISOString(),
  });
  return recipient;
}

/** A delivery that finished, the store's ordinary retirement candidate. */
function deliveredMarker(root: string, messageId: string, at: number): CanonicalRecipient {
  const recipient = recipientOf(root);
  writeMarkerFile(recipient, messageId, {
    format: 1,
    messageId,
    recipient,
    recordDigest: DIGEST,
    sender: 'owner',
    status: 'delivered',
    attempts: [],
    receipt: { kind: 'unknown' },
    updatedAt: new Date(at - 60_000).toISOString(),
  });
  return recipient;
}

/** The main-escalation events the retained log holds for one episode. */
function escalationEvents(root: string, home: string, recipient: CanonicalRecipient, messageId: string) {
  const log = readEvents('acme', root, home);
  if (!log.ok) throw new Error(log.reason);
  return log.events.filter((event) => event.payload.record_id === escalatedRecordId(recipient, messageId));
}

/** The slice seam a pass gets in the child: open, with time enough that no scene here meets it. */
const openSlices: ChoresSlices = { sliceMs: 2000, stopping: () => false, yield: async () => true };

/** The child's frames, read from its standard output by the protocol's own reader. */
function collectFrames(stream: NodeJS.ReadableStream): ChoresChildMessage[] {
  const frames: ChoresChildMessage[] = [];
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      const parsed = parseChoresFrame(line);
      const message = parsed === null ? null : readChildMessage(parsed);
      if (message !== null) frames.push(message);
    }
  });
  return frames;
}

function stateNow(home: string): DaemonState | null {
  const read = readDaemonState(home);
  return read.kind === 'ok' ? read.state : null;
}

function rowFor(home: string, root: string): DaemonChoresState | undefined {
  return stateNow(home)?.roots.find((entry) => entry.root === root)?.chores;
}

type Fake = {
  child: ChoresChild;
  sends: ChoresHostMessage[];
  kills: string[];
  emit(message: ChoresChildMessage): void;
  leave(code?: number | null, signal?: NodeJS.Signals | null): void;
};

/** A child that speaks the protocol only when the test says so: it never exits on its own, so
 *  the kill, the exit and the replacement are each observed at the instant the test chose. */
function fakeChild(pid: number): Fake {
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let settle: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const sends: ChoresHostMessage[] = [];
  const kills: string[] = [];
  let alive = true;
  const child: ChoresChild = {
    pid,
    get alive() {
      return alive;
    },
    send(message) {
      // A beat to a child that left is exactly the write this scene is about: it must never
      // reach the pipe, so the fake refuses loudly instead of recording it.
      if (!alive) throw new Error('a beat was written to a child that left');
      sends.push(message);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    kill(why) {
      kills.push(why);
    },
    exited,
  };
  return {
    child,
    sends,
    kills,
    emit(message) {
      for (const listener of [...listeners]) listener({ kind: 'message', message });
    },
    leave(code = null, signal = 'SIGTERM') {
      alive = false;
      for (const listener of [...listeners]) listener({ kind: 'exit', code, signal });
      settle();
    },
  };
}

function messages(events: readonly ChoresChildEvent[]): ChoresChildMessage[] {
  return events.flatMap((event) => (event.kind === 'message' ? [event.message] : []));
}

describe('the chores policy', () => {
  test('a root with no word gets per-root and the release limits', () => {
    const made = world();
    expect(choresPolicyFor(teamFile(), made.root, made.home, new Date(NOW))).toEqual({
      mode: 'per-root',
      sliceMs: 2000,
      missedBeats: 2,
      backoffCapMs: 30_000,
    });
  });

  test('every reading, every limit and every mode are the team word', () => {
    const made = world();
    word(made.home, made.root, 'daemon.chores', 'shared');
    word(made.home, made.root, 'daemon.chores-slice-ms', 500);
    word(made.home, made.root, 'daemon.chores-missed-beats', 4);
    word(made.home, made.root, 'daemon.chores-backoff-cap-ms', 12_000);
    expect(choresPolicyFor(teamFile(), made.root, made.home, new Date(NOW))).toEqual({
      mode: 'shared',
      sliceMs: 500,
      missedBeats: 4,
      backoffCapMs: 12_000,
    });
    for (const mode of ['inline', 'shared', 'per-root'] as const) {
      word(made.home, made.root, 'daemon.chores', mode);
      expect(choresPolicyFor(teamFile(), made.root, made.home, new Date(NOW)).mode).toBe(mode);
    }
  });

  test('a value outside the catalogue is refused at the write', () => {
    const made = world();
    const refused = [
      ['daemon.chores', 'sideways'],
      ['daemon.chores-slice-ms', 0],
      ['daemon.chores-missed-beats', 0],
      ['daemon.chores-backoff-cap-ms', 500],
    ] as const;
    for (const [name, value] of refused) {
      const wrote = writePolicySet(made.home, { level: 'team', target: made.root, teamRoot: made.root, name, value }, { now: new Date(NOW) });
      expect(wrote.ok).toBe(false);
    }
  });

  test('a shared group runs the tightest limits of its roots', () => {
    const tight = tightestPolicy([
      policy({ sliceMs: 2000, missedBeats: 3, backoffCapMs: 30_000 }),
      policy({ mode: 'shared', sliceMs: 500, missedBeats: 2, backoffCapMs: 60_000 }),
    ]);
    expect(tight).toEqual({ mode: 'per-root', sliceMs: 500, missedBeats: 2, backoffCapMs: 30_000 });
    expect(tightestPolicy([policy({ sliceMs: 750 })])).toEqual(policy({ sliceMs: 750 }));
  });
});

describe('the chores fleet', () => {
  test('per-root starts one child per root and reports its own heartbeat and size', () => {
    const made = world();
    const second = join(made.base, 'other');
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy()), routeInput(second, policy())],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4100 + made2.length * 10);
        made2.push(child);
        return child.child;
      },
    });
    expect(made2).toHaveLength(0);
    fleet.tick(new Date(clock.at));
    expect(made2).toHaveLength(2);
    expect(fleet.stateFor(made.root)).toMatchObject({ mode: 'per-root', state: 'starting', pid: 4100, restarts: 0 });
    expect(fleet.stateFor(second)).toMatchObject({ mode: 'per-root', state: 'starting', pid: 4110 });

    const rss = 48 * 1024 * 1024;
    made2[0]!.emit({ type: 'ready', pid: 4100, at: AT });
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: rss, busy: null, markerCache: null });
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', rssBytes: rss, heartbeatAt: AT, pid: 4100 });
    // The sibling child is judged on its own heartbeats, never on this one's.
    expect(fleet.stateFor(second)).toMatchObject({ state: 'starting', rssBytes: null });

    clock.at = NOW + 1000;
    fleet.tick(new Date(clock.at));
    expect(made2[0]!.sends).toEqual([{ type: 'tick', id: `${String(NOW + 1000)}-0`, at: new Date(NOW + 1000).toISOString() }]);
  });

  test('two missed beats end a child that proved its run, and every replacement waits the 60 s restart floor', async () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const log: string[] = [];
    const fleet: ChoresFleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2, backoffCapMs: 3000 }))],
      log: (text) => log.push(text),
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4200 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    expect(made2).toHaveLength(1);
    made2[0]!.emit({ type: 'ready', pid: 4200, at: AT });
    // Two hearts read since the start: this child has proved its own loop runs, so the
    // missed-beats rule is the one that judges it.
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });

    // One overdue beat is late, not missed; the second ends the child, and only once.
    tickAt(1000);
    expect(made2[0]!.kills).toHaveLength(0);
    tickAt(2000);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'late', missed: 1 });
    tickAt(3000);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'late', missed: 2, pid: 4200 });
    expect(fleet.stateFor(made.root)?.why).toContain('missed 2 heartbeats');
    expect(made2[0]!.kills).toHaveLength(1);
    expect(made2[0]!.kills[0]).toContain('missed 2 heartbeats');
    // A child that is being ended gets no beat either: a tick written into a stopping child's
    // pipe is the write this fix removes, and the fake refuses a send once it has left.
    const sendsBefore = made2[0]!.sends.length;
    tickAt(3500);
    expect(made2[0]!.kills).toHaveLength(1);
    expect(made2[0]!.sends).toHaveLength(sendsBefore);

    // The exit schedules the first replacement after the 60 s floor; the row names when.
    made2[0]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({
      restarts: 1,
      pid: null,
      nextStartAt: new Date(NOW + 3500 + 60_000).toISOString(),
    });
    expect(log.some((line) => line.includes('starting a replacement in 60000 ms'))).toBe(true);
    tickAt(63_499);
    expect(made2).toHaveLength(1);
    tickAt(63_500);
    expect(made2).toHaveLength(2);

    // A replacement that has not been read beating twice is judged by the startup deadline, not
    // by beats: one heartbeat at its start, then silence, and the row counts nothing missed.
    made2[1]!.emit({ type: 'ready', pid: 4201, at: new Date(NOW + 63_500).toISOString() });
    made2[1]!.emit({ type: 'heartbeat', at: new Date(NOW + 63_500).toISOString(), rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
    for (let offset = 64_500; offset <= 122_500; offset += 1000) tickAt(offset);
    expect(made2[1]!.kills).toHaveLength(0);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', missed: 0, why: null });
    tickAt(123_500);
    expect(made2[1]!.kills).toHaveLength(1);
    expect(made2[1]!.kills[0]).toContain('did not beat twice within 60000 ms');
    made2[1]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    // The backoff still doubles under the floor, but the floor dominates every step at this
    // policy's cap: a start that never proved a run waits the same 60 s.
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 2, nextStartAt: new Date(NOW + 123_500 + 60_000).toISOString() });
    expect(log.filter((line) => line.includes('starting a replacement in 60000 ms'))).toHaveLength(2);
    tickAt(183_500);
    expect(made2).toHaveLength(3);
    made2[2]!.emit({ type: 'ready', pid: 4202, at: new Date(NOW + 183_500).toISOString() });
    made2[2]!.emit({ type: 'heartbeat', at: new Date(NOW + 183_500).toISOString(), rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
    for (let offset = 184_500; offset <= 242_500; offset += 1000) tickAt(offset);
    expect(made2[2]!.kills).toHaveLength(0);
    tickAt(243_500);
    expect(made2[2]!.kills).toHaveLength(1);
    made2[2]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 3, nextStartAt: new Date(NOW + 243_500 + 60_000).toISOString() });
    expect(log.filter((line) => line.includes('starting a replacement in 60000 ms'))).toHaveLength(3);
  });

  test('a start that takes 25 s is not silence: a child short of its second beat is never ended by beats', () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2 }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4310 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 40 * 1024 * 1024;
    const beat = (written: number): void => {
      made2[0]!.emit({
        type: 'heartbeat',
        at: new Date(NOW + written).toISOString(),
        rssBytes: rss,
        busy: null,
        markerCache: null,
      });
    };

    tickAt(0);
    made2[0]!.emit({ type: 'ready', pid: 4310, at: AT });
    beat(0);
    // The child is building: its loop is held for twenty-five beats, so no frame crosses the
    // pipe. None of that is silence the child chose, and the start has not been proved by two
    // reads, so the beats it does not send cannot end it.
    for (let offset = 1000; offset <= 25_000; offset += 1000) {
      tickAt(offset);
      expect(made2[0]!.kills).toHaveLength(0);
    }
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', missed: 0, pid: 4310 });
    // The build ends and the child beats from there; the rule judges it on those beats again.
    for (let offset = 25_000; offset <= 30_000; offset += 1000) {
      beat(offset);
      tickAt(offset);
    }
    expect(made2[0]!.kills).toHaveLength(0);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', missed: 0, restarts: 0 });
  });

  test('a child that never beats twice is ended at the startup deadline, once, and a proved run resets the wait', async () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const log: string[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2, backoffCapMs: 30_000 }))],
      log: (text) => log.push(text),
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4320 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 40 * 1024 * 1024;
    const startsOnce = (fake: Fake, pid: number, at: number): void => {
      const iso = new Date(at).toISOString();
      fake.emit({ type: 'ready', pid, at: iso });
      fake.emit({ type: 'heartbeat', at: iso, rssBytes: rss, busy: null, markerCache: null });
    };

    tickAt(0);
    startsOnce(made2[0]!, 4320, NOW);
    // Fifty-nine on-time beats later the child is still inside its start: nothing is counted as
    // missed and nothing is ended.
    for (let offset = 1000; offset <= 59_000; offset += 1000) tickAt(offset);
    expect(made2[0]!.kills).toHaveLength(0);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', missed: 0 });
    // The deadline ends it, once, on its own reason.
    tickAt(60_000);
    expect(made2[0]!.kills).toHaveLength(1);
    expect(made2[0]!.kills[0]).toContain('did not beat twice within 60000 ms');
    // The row says the child is being ended, and carries the deadline as its own reason.
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'late' });
    expect(fleet.stateFor(made.root)?.why).toContain('did not beat twice within 60000 ms');
    tickAt(61_000);
    expect(made2[0]!.kills).toHaveLength(1);
    made2[0]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({
      restarts: 1,
      nextStartAt: new Date(NOW + 61_000 + 60_000).toISOString(),
    });

    // The replacement starts after the floor, proves its run and then fails: the next start is
    // the floor after its own exit, never pinned by the earlier deadline.
    tickAt(121_000);
    expect(made2).toHaveLength(2);
    const iso = new Date(NOW + 121_000).toISOString();
    made2[1]!.emit({ type: 'ready', pid: 4321, at: iso });
    made2[1]!.emit({ type: 'heartbeat', at: iso, rssBytes: rss, busy: null, markerCache: null });
    made2[1]!.emit({ type: 'heartbeat', at: iso, rssBytes: rss, busy: null, markerCache: null });
    for (let offset = 122_000; offset <= 124_000; offset += 1000) tickAt(offset);
    expect(made2[1]!.kills).toHaveLength(1);
    expect(made2[1]!.kills[0]).toContain('missed 2 heartbeats');
    made2[1]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({
      restarts: 2,
      nextStartAt: new Date(NOW + 124_000 + 60_000).toISOString(),
    });
    expect(log.filter((line) => line.includes('starting a replacement in 60000 ms'))).toHaveLength(2);
  });

  test('a stall ends no child whose frames were still in the pipe when the daemon resumed', () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2 }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4330 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 40 * 1024 * 1024;
    tickAt(0);
    made2[0]!.emit({ type: 'ready', pid: 4330, at: AT });
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: rss, busy: null, markerCache: null });
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: rss, busy: null, markerCache: null });
    tickAt(1000);

    // The daemon's loop is held from before the second beat until the fifth. The child kept
    // beating; those frames are still in the pipe, unread, when the late beat fires at 5000.
    tickAt(5000);
    // The next beat is on time by the daemon's own schedule, but it fires before the pipe has
    // been read: judging from the clock the stall froze would end a child that never missed.
    tickAt(6000);
    expect(made2[0]!.kills).toHaveLength(0);
    // The pipe is read once the loop is free: three beats arrive, written during the stall.
    clock.at = NOW + 6050;
    for (const written of [2000, 3000, 4000]) {
      made2[0]!.emit({
        type: 'heartbeat',
        at: new Date(NOW + written).toISOString(),
        rssBytes: rss,
        busy: null,
        markerCache: null,
      });
    }
    tickAt(7000);
    tickAt(8000);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'late', missed: 1 });
    expect(made2[0]!.kills).toHaveLength(0);
    // A child that really stops beating is still ended, on an on-time beat.
    tickAt(9000);
    expect(made2[0]!.kills).toHaveLength(1);
    expect(made2[0]!.kills[0]).toContain('missed 2 heartbeats');
  });

  test('a child that exits right after it starts is replaced, and no beat is written to its pipe', async () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy())],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4260 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    fleet.tick(new Date(NOW));
    expect(made2).toHaveLength(1);

    // The child leaves before it ever beats, and the very next beat is issued in the same turn
    // the exit lands, before the group's own exit turn has run. The group already reads the
    // child as gone, so the fake's send (which throws for a child that left) is never reached.
    made2[0]!.leave(0, null);
    clock.at = NOW + 1000;
    expect(() => fleet.tick(new Date(clock.at))).not.toThrow();
    expect(made2[0]!.sends).toHaveLength(0);

    // The exit is the restart's own trigger; the replacement starts at the first beat the
    // restart floor allows.
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 1, pid: null });
    clock.at = NOW + 61_000;
    expect(() => fleet.tick(new Date(clock.at))).not.toThrow();
    expect(made2).toHaveLength(2);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'starting', pid: 4261 });
  });

  test('a beat that arrives late is the daemon\'s own stall, not a child missing it, and ends nothing', () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2 }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4270 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    tickAt(0);
    made2[0]!.emit({ type: 'ready', pid: 4270, at: AT });
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });

    // The daemon's loop is held for eight beats. The child kept beating; its frames were
    // waiting unread in the pipe. The late beat must not charge the child for that silence.
    tickAt(8000);
    expect(made2[0]!.kills).toHaveLength(0);
    // The poll that follows the beat reads the backlog: the child is current again.
    made2[0]!.emit({
      type: 'heartbeat', at: new Date(NOW + 8000).toISOString(), rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null,
    });
    tickAt(9000);
    tickAt(10_000);
    expect(made2[0]!.kills).toHaveLength(0);
    // A child that really stopped beating is still ended, on an on-time beat.
    tickAt(11_000);
    expect(made2[0]!.kills).toHaveLength(1);
    expect(made2[0]!.kills[0]).toContain('missed 2 heartbeats');
  });

  test('a beat heard late starts the child\'s grace at the read, not at the beat\'s own time', () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2 }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4280 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 40 * 1024 * 1024;
    tickAt(0);
    made2[0]!.emit({ type: 'ready', pid: 4280, at: AT });
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: rss, busy: null, markerCache: null });
    tickAt(1000);
    expect(made2[0]!.kills).toHaveLength(0);

    // The child wrote this beat at NOW+1000; the daemon's held loop did not read it until
    // NOW+2000. The pipe delay is the daemon's, not the child's, so the child is not charged
    // for it: the beat is heard now, and the row still reports the child's own `at`.
    clock.at = NOW + 2000;
    made2[0]!.emit({
      type: 'heartbeat', at: new Date(NOW + 1000).toISOString(), rssBytes: rss, busy: null, markerCache: null,
    });
    tickAt(2000);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: new Date(NOW + 1000).toISOString(),
    });
    tickAt(3000);
    // Two on-time ticks after the read: the beat's own `at` is two beats old, the read is not.
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', missed: 0 });
    tickAt(4000);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'late', missed: 1 });
    expect(made2[0]!.kills).toHaveLength(0);
    // The grace is bounded: the same two-overdue-beats rule still ends a silent child.
    tickAt(5000);
    expect(fleet.stateFor(made.root)?.why).toContain('missed 2 heartbeats');
    expect(made2[0]!.kills).toHaveLength(1);
  });

  test('a multi-second daemon stall followed by buffered pipe frames with stale timestamps spares a beating child and still ends a silent sibling', () => {
    const made = world();
    const second = join(made.base, 'other');
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [
        routeInput(made.root, policy({ missedBeats: 2 })),
        routeInput(second, policy({ missedBeats: 2 })),
      ],
      log: () => {},
      factory: () => {
        const child = fakeChild(4290 + made2.length * 10);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 44 * 1024 * 1024;
    tickAt(0);
    for (const [idx, pid] of [
      [0, 4290],
      [1, 4300],
    ] as const) {
      made2[idx]!.emit({ type: 'ready', pid, at: AT });
      made2[idx]!.emit({ type: 'heartbeat', at: AT, rssBytes: rss, busy: null, markerCache: null });
    }

    // The daemon's event loop is blocked for 38 seconds; the timers phase fires first at +38_000
    // (stalled = true) before the poll phase drains the children's buffered stdout pipes.
    tickAt(38_000);
    expect(made2[0]!.kills).toHaveLength(0);
    expect(made2[1]!.kills).toHaveLength(0);

    // Poll phase at +38_050 reads buffered frames written 33-35 seconds earlier during the stall.
    clock.at = NOW + 38_050;
    for (const staleOffset of [3000, 4000, 5000]) {
      made2[0]!.emit({
        type: 'heartbeat',
        at: new Date(NOW + staleOffset).toISOString(),
        rssBytes: rss,
        busy: 'fallback',
        markerCache: null,
      });
    }
    made2[1]!.emit({
      type: 'heartbeat',
      at: new Date(NOW + 4000).toISOString(),
      rssBytes: rss,
      busy: null,
      markerCache: null,
    });

    // Next on-time tick at +39_000 (stalled = false, 950 ms after the pipe read): neither child
    // is charged for the 33-34 s age of the frame's own `at`, and `heartbeatAt` preserves the
    // child's self-reported timestamp.
    tickAt(39_000);
    expect(made2[0]!.kills).toHaveLength(0);
    expect(made2[1]!.kills).toHaveLength(0);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: new Date(NOW + 5000).toISOString(),
      busy: 'fallback',
    });
    expect(fleet.stateFor(second)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: new Date(NOW + 4000).toISOString(),
    });

    // Child 0 continues beating at +39_900 while Child 1 genuinely stops beating after +38_050.
    clock.at = NOW + 39_900;
    made2[0]!.emit({
      type: 'heartbeat',
      at: new Date(NOW + 39_900).toISOString(),
      rssBytes: rss,
      busy: null,
      markerCache: null,
    });

    tickAt(40_000);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: new Date(NOW + 39_900).toISOString(),
      busy: null,
    });
    expect(fleet.stateFor(second)).toMatchObject({
      state: 'late',
      missed: 1,
      heartbeatAt: new Date(NOW + 4000).toISOString(),
      why: 'the child has missed 1 heartbeat',
    });
    expect(made2[1]!.kills).toHaveLength(0);

    tickAt(41_000);
    expect(made2[0]!.kills).toHaveLength(0);
    expect(made2[1]!.kills).toHaveLength(1);
    expect(made2[1]!.kills[0]).toContain('missed 2 heartbeats');
  });

  test('falls back heartbeatAt to the daemon read clock when a frame carries a non-ISO timestamp and resets read clock across replacement', async () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2 }))],
      log: () => {},
      factory: () => {
        const child = fakeChild(4310 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 40 * 1024 * 1024;
    tickAt(0);
    made2[0]!.emit({ type: 'ready', pid: 4310, at: AT });

    // A frame with a non-ISO `at` still updates `lastBeatReadMs` to `now()` and falls back
    // `lastBeatMs` to `readAt` so `stateFor` never throws RangeError on `toISOString()`.
    clock.at = NOW + 1500;
    made2[0]!.emit({
      type: 'heartbeat',
      at: 'not-an-iso-timestamp',
      rssBytes: rss,
      busy: null,
      markerCache: null,
    });
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: new Date(NOW + 1500).toISOString(),
    });

    tickAt(2500);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', missed: 0 });
    tickAt(3500);
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'late', missed: 1 });
    expect(made2[0]!.kills).toHaveLength(0);
    tickAt(4500);
    expect(made2[0]!.kills).toHaveLength(1);

    // Once the child leaves and a replacement starts, both `lastBeatMs` and `lastBeatReadMs`
    // are cleared so the replacement is judged from its own `startedAtMs`.
    made2[0]!.leave(null, 'SIGTERM');
    await made2[0]!.child.exited;
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'restarting',
      missed: 0,
      heartbeatAt: null,
    });
    tickAt(5500);
    expect(made2).toHaveLength(2);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'starting',
      pid: 4311,
      missed: 0,
      heartbeatAt: null,
    });
    tickAt(6500);
    tickAt(7500);
    expect(made2[1]!.kills).toHaveLength(0);
    tickAt(8500);
    expect(made2[1]!.kills).toHaveLength(1);
    expect(made2[1]!.kills[0]).toContain('missed 2 heartbeats');
  });

  test('a replacement after a proved run waits the restart floor, and the beats still reset the wait', async () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2, backoffCapMs: 3000 }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const child = fakeChild(4250 + made2.length);
        made2.push(child);
        return child.child;
      },
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };
    const rss = 40 * 1024 * 1024;
    /** A child that was ready and beat twice: the row's proof that its loop moved on its own. */
    const proofOfRun = (fake: Fake, pid: number, at: number): void => {
      fake.emit({ type: 'ready', pid, at: new Date(at).toISOString() });
      for (const offset of [0, 1]) {
        fake.emit({
          type: 'heartbeat',
          at: new Date(at + offset).toISOString(),
          rssBytes: rss,
          busy: null,
          markerCache: null,
        });
      }
    };

    tickAt(0);
    proofOfRun(made2[0]!, 4250, NOW);
    tickAt(1000);
    tickAt(2000);
    tickAt(3000);
    expect(made2[0]!.kills).toHaveLength(1);
    made2[0]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 1, nextStartAt: new Date(NOW + 3_000 + 60_000).toISOString() });

    // The replacement proves its run before it fails. Its two heartbeats start the exponent over;
    // the floor dominates that step at the release cadence, so the next start is the floor after
    // this exit as well, and never a queued start the earlier failure earned.
    tickAt(63_000);
    expect(made2).toHaveLength(2);
    proofOfRun(made2[1]!, 4251, NOW + 63_000);
    tickAt(64_000);
    tickAt(65_000);
    tickAt(66_000);
    expect(made2[1]!.kills).toHaveLength(1);
    made2[1]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 2, nextStartAt: new Date(NOW + 66_000 + 60_000).toISOString() });
  });

  test('inline starts no child at all, at any beat', () => {
    const made = world();
    let spawned = 0;
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [routeInput(made.root, policy({ mode: 'inline' }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        spawned += 1;
        return fakeChild(4300).child;
      },
    });
    fleet.tick(new Date(NOW));
    fleet.tick(new Date(NOW + 1000));
    fleet.tick(new Date(NOW + 60_000));
    expect(spawned).toBe(0);
    expect(fleet.stateFor(made.root)).toEqual({
      mode: 'inline',
      state: 'inline',
      pid: null,
      startedAt: null,
      heartbeatAt: null,
      rssBytes: null,
      busy: null,
      restarts: 0,
      missed: 0,
      lastPassAt: null,
      lastPass: null,
      lastChore: null,
      presence: null,
      markerCache: null,
      nextStartAt: null,
      why: null,
    });
  });

  test('shared runs one child for the group, under the tightest limits', () => {
    const made = world();
    const second = join(made.base, 'other');
    const inputs: SpawnChoresInput[] = [];
    const fake = fakeChild(4400);
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [
        routeInput(made.root, policy({ mode: 'shared', sliceMs: 2000, missedBeats: 2 })),
        routeInput(second, policy({ mode: 'shared', sliceMs: 500, missedBeats: 5 })),
      ],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: (input) => {
        inputs.push(input);
        return fake.child;
      },
    });
    fleet.tick(new Date(NOW));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.config.routes.map((entry) => entry.root)).toEqual([made.root, second]);
    expect(inputs[0]!.config.sliceMs).toBe(500);
    expect(fleet.stateFor(made.root)).toMatchObject({ mode: 'shared', state: 'starting', pid: 4400 });
    expect(fleet.stateFor(second)).toMatchObject({ mode: 'shared', state: 'starting', pid: 4400 });
  });

  test('the record keeps a sound chores row, drops a malformed one and reads an older row as no detail', () => {
    const made = world();
    const row = (over: Partial<DaemonChoresState> = {}): DaemonChoresState => ({
      mode: 'per-root',
      state: 'ok',
      pid: 4400,
      startedAt: AT,
      heartbeatAt: AT,
      rssBytes: 48 * 1024 * 1024,
      busy: null,
      restarts: 1,
      missed: 0,
      lastPassAt: AT,
      lastPass: ['fallback sweep: escalated 0, refused 0, unreadable 0'],
      lastChore: { name: 'fallback', at: AT, ms: 1200 },
      presence: { at: AT, ms: 40, proved: 1, missed: 1 },
      markerCache: { read: 7, reused: 4, cached: 3 },
      nextStartAt: null,
      why: null,
      ...over,
    });
    const record = (chores: DaemonChoresState): DaemonState => ({
      format: 1,
      pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
      since: AT,
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: AT,
      socket: daemonSocketPath(made.home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [{ root: made.root, team: 'acme', send: 'serving', bus: 'serving', why: null, chores }],
    });
    writeDaemonState(made.home, record(row()));
    const read = readDaemonState(made.home);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.state.roots[0]?.chores).toEqual(row());
    // A row whose chore, presence answer or cache is present but malformed is display data this
    // build cannot read: the row is left out, and the rest of the record is not.
    const broken: DaemonChoresState[] = [
      row({ lastChore: { name: '', at: AT, ms: null } }),
      row({ presence: { at: AT, ms: -1, proved: 0, missed: 0 } }),
      row({ markerCache: { read: 1, reused: -1, cached: 0 } }),
    ];
    for (const chores of broken) {
      writeDaemonState(made.home, record(chores));
      const again = readDaemonState(made.home);
      expect(again.kind).toBe('ok');
      if (again.kind === 'ok') expect(again.state.roots[0]?.chores).toBeUndefined();
    }
    // A row written before these fields existed reads them as none, never as a guess.
    const older = { ...row() } as Partial<DaemonChoresState>;
    delete older.lastChore;
    delete older.presence;
    delete older.markerCache;
    writeDaemonState(made.home, record(older as DaemonChoresState));
    const legacy = readDaemonState(made.home);
    expect(legacy.kind).toBe('ok');
    if (legacy.kind === 'ok') {
      expect(legacy.state.roots[0]?.chores).toMatchObject({ lastChore: null, presence: null, markerCache: null });
    }
  });
});

describe('the fleet presence nudge', () => {
  const readings: ChoresPresenceReading[] = [{
    seat: 'crew-lead',
    status: {
      seat: 'crew-lead',
      binding: 'prs_0123456789ab',
      threadId: 'th-1',
      channel: 'connected',
      stream: 'initialized',
      baseline: 'read',
      evidenceAt: AT,
      stagedEventId: '2026-11-02T03:00:00.000Z-aaaaaaaa',
    },
  }];

  test('a ready child receives the measured readings and its result settles the pass', async () => {
    const made = world();
    const fake = fakeChild(4550);
    const inputs: SpawnChoresInput[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [{ ...routeInput(made.root, policy()), stateDir: join(made.root, '.agents') }],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: (input) => {
        inputs.push(input);
        return fake.child;
      },
    });
    // Nothing to ask before a child exists, and nothing while it is still starting: the daemon's
    // own steps answer those passes.
    expect(fleet.presence({ root: made.root, at: new Date(NOW), readings })).toBeNull();
    fleet.tick(new Date(NOW));
    expect(inputs[0]!.config.routes[0]!.stateDir).toBe(join(made.root, '.agents'));
    expect(fleet.presence({ root: made.root, at: new Date(NOW), readings })).toBeNull();
    fake.emit({ type: 'ready', pid: 4550, at: AT });
    const answer = fleet.presence({ root: made.root, at: new Date(NOW + 5), readings });
    expect(answer).not.toBeNull();
    const frame = fake.sends.find((message) => message.type === 'presence');
    expect(frame).toEqual({
      type: 'presence',
      id: expect.any(String),
      root: made.root,
      at: new Date(NOW + 5).toISOString(),
      readings,
    });
    if (frame?.type !== 'presence') throw new Error('the child was never nudged');
    fake.emit({
      type: 'presence-result',
      id: frame.id,
      root: made.root,
      at: frame.at,
      proofs: [{ seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' }],
      notes: ['the activity step failed: from the child'],
      ms: null,
    });
    await expect(answer!).resolves.toEqual({
      kind: 'answered',
      proofs: [{ seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' }],
      notes: ['the activity step failed: from the child'],
    });
  });

  test('the row names the chore, the cache and the presence answer, and a replacement starts cold', async () => {
    const made = world();
    const clock = { at: NOW };
    const made2: Fake[] = [];
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [{ ...routeInput(made.root, policy()), stateDir: join(made.root, '.agents') }],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        const fake = fakeChild(4565 + made2.length);
        made2.push(fake);
        return fake.child;
      },
    });
    fleet.tick(new Date(clock.at));
    const first = made2[0]!;
    first.emit({ type: 'ready', pid: 4565, at: AT });
    // The child's own heartbeat carries the cache its process fills; the row repeats it and has
    // run nothing for the root yet.
    first.emit({
      type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: 'chores',
      markerCache: { read: 5, reused: 3, cached: 2 },
    });
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      markerCache: { read: 5, reused: 3, cached: 2 },
      lastChore: null,
      presence: null,
    });
    // A pass frame's own name and duration become that root's last chore.
    first.emit({ type: 'pass', passes: [{ root: made.root, at: AT, notes: [], chore: 'fallback', ms: 700 }] });
    expect(fleet.stateFor(made.root)?.lastChore).toEqual({ name: 'fallback', at: AT, ms: 700 });
    // An accepted presence answer is its own chore, with the seats it proved and missed.
    const answer = fleet.presence({ root: made.root, at: new Date(clock.at), readings });
    if (answer === null) throw new Error('the ready child was not nudged');
    const nudge = first.sends.find((message) => message.type === 'presence');
    if (nudge?.type !== 'presence') throw new Error('the child was never nudged');
    first.emit({
      type: 'presence-result',
      id: nudge.id,
      root: made.root,
      at: nudge.at,
      proofs: [
        { seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' },
        { seat: 'other', miss: 'the runtime source has staged no event yet' },
      ],
      notes: [],
      ms: 40,
    });
    await expect(answer).resolves.toMatchObject({ kind: 'answered' });
    expect(fleet.stateFor(made.root)).toMatchObject({
      lastChore: { name: 'presence', at: nudge.at, ms: 40 },
      presence: { at: nudge.at, ms: 40, proved: 1, missed: 1 },
    });
    // The replacement starts cold: nothing the dead process ran or cached is claimed for it.
    first.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({ lastChore: null, presence: null, markerCache: null });
    clock.at = NOW + 60_000;
    fleet.tick(new Date(clock.at));
    expect(made2).toHaveLength(2);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'starting',
      lastChore: null,
      presence: null,
      markerCache: null,
    });
  });

  test('a leaving child settles an unanswered nudge instead of leaving the pass waiting', async () => {
    const made = world();
    const fake = fakeChild(4560);
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [routeInput(made.root, policy())],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => fake.child,
    });
    fleet.tick(new Date(NOW));
    fake.emit({ type: 'ready', pid: 4560, at: AT });
    const answer = fleet.presence({ root: made.root, at: new Date(NOW), readings });
    expect(answer).not.toBeNull();
    fake.leave();
    await expect(answer!).resolves.toEqual({
      kind: 'unavailable',
      why: 'the child left before it answered the presence pass',
    });
  });

  test('an answer that misses its own deadline settles unanswered, and a late answer is dropped', async () => {
    const made = world();
    const fake = fakeChild(4562);
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [routeInput(made.root, policy())],
      log: () => {},
      cpuTimeOf: flatCpu,
      presenceDeadlineMs: 25,
      factory: () => fake.child,
    });
    fleet.tick(new Date(NOW));
    fake.emit({ type: 'ready', pid: 4562, at: AT });
    const answer = fleet.presence({ root: made.root, at: new Date(NOW), readings });
    expect(answer).not.toBeNull();
    const first = fake.sends.find((message) => message.type === 'presence');
    if (first?.type !== 'presence') throw new Error('the child was never nudged');
    // The child never answers: the pass settles by its own deadline and says so.
    await expect(answer!).resolves.toEqual({
      kind: 'unavailable',
      why: 'the child did not answer the presence pass within 25 ms',
    });
    // A late answer to that nudge is not a pass: the entry it named is gone, so nothing is
    // recorded for it.
    fake.emit({
      type: 'presence-result',
      id: first.id,
      root: made.root,
      at: first.at,
      proofs: [{ seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' }],
      notes: [],
      ms: 40,
    });
    expect(fleet.stateFor(made.root)?.presence).toBeNull();
    expect(fleet.stateFor(made.root)?.lastChore).toBeNull();
    // The same child answers the next nudge in time, and that one is the pass.
    const again = fleet.presence({ root: made.root, at: new Date(NOW + 30), readings });
    if (again === null) throw new Error('the ready child was not nudged again');
    const nudges = fake.sends.filter((message) => message.type === 'presence');
    const second = nudges[nudges.length - 1];
    if (second?.type !== 'presence') throw new Error('the child was never nudged again');
    fake.emit({
      type: 'presence-result',
      id: second.id,
      root: made.root,
      at: second.at,
      proofs: [],
      notes: ['answered after the first deadline'],
      ms: 5,
    });
    await expect(again).resolves.toEqual({
      kind: 'answered',
      proofs: [],
      notes: ['answered after the first deadline'],
    });
    expect(fleet.stateFor(made.root)?.presence).toMatchObject({ proved: 0, missed: 0 });
  });

  test('a stop settles an unanswered nudge and an inline root is never asked', async () => {
    const made = world();
    const fake = fakeChild(4570);
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [routeInput(made.root, policy())],
      log: () => {},
      cpuTimeOf: flatCpu,
      killGraceMs: 10,
      factory: () => fake.child,
    });
    fleet.tick(new Date(NOW));
    fake.emit({ type: 'ready', pid: 4570, at: AT });
    const answer = fleet.presence({ root: made.root, at: new Date(NOW), readings });
    expect(answer).not.toBeNull();
    const stopping = fleet.stop('the test is done');
    await expect(answer!).resolves.toEqual({
      kind: 'unavailable',
      why: 'the daemon is stopping this child',
    });
    fake.leave();
    await stopping;

    const inline = world('inline');
    let spawned = 0;
    const inlineFleet = createChoresFleet({
      home: inline.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [routeInput(inline.root, policy({ mode: 'inline' }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => {
        spawned += 1;
        return fakeChild(4580).child;
      },
    });
    inlineFleet.tick(new Date(NOW));
    expect(spawned).toBe(0);
    expect(inlineFleet.presence({ root: inline.root, at: new Date(NOW), readings })).toBeNull();
  });

  test('a watched route has a remote handle: its beats cross the pipe and its frames are the record', async () => {
    const made = world();
    const fake = fakeChild(4590);
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [{
        ...routeInput(made.root, policy()),
        watch: { teamFile: join(made.root, '.agents', 'team.yaml'), presence: true },
      }],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => fake.child,
    });
    // The handle exists before any child has started, so the daemon never builds a second watch
    // for the route even briefly; the child's readiness gates the beats, not the handle.
    expect(fleet.watchFor(made.root, () => null)).not.toBeNull();
    fleet.tick(new Date(NOW));
    const health = [{ seat: 'crew-lead', healthy: true }];
    const watch = fleet.watchFor(made.root, () => health);
    expect(watch).not.toBeNull();
    // No frame has arrived: the record is the synthetic starting state, never a guess at a run.
    expect(watch?.state()).toMatchObject({
      phase: 'starting',
      required: true,
      effects: 'blocked',
      cycles: 0,
      failures: 0,
    });
    // A child that has not reported gets no beat: its run's authority is not renewed behind the
    // supervisor's own decision.
    watch!.tick(new Date(NOW));
    expect(fake.sends.some((message) => message.type === 'watch-beat')).toBe(false);

    fake.emit({ type: 'ready', pid: 4590, at: AT });
    fake.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
    watch!.tick(new Date(NOW));
    expect(fake.sends.filter((message) => message.type === 'watch-beat')).toEqual([
      { type: 'watch-beat', root: made.root, at: new Date(NOW).toISOString(), presence: health },
    ]);

    const state = {
      routeId: '0123456789abcdef0123456789abcdef',
      root: made.root,
      team: 'acme',
      session: 'acme-dev',
      phase: 'running' as const,
      startedAt: AT,
      lastCycleAt: new Date(NOW).toISOString(),
      lastCycleOutcome: 'pass' as const,
      cycles: 3,
      failures: 0,
      effects: 'open' as const,
      required: true,
      why: null,
    };
    fake.emit({ type: 'watch-state', root: made.root, state });
    // The daemon mirrors the frame exactly: it computes no second state of its own.
    expect(watch!.state()).toEqual(state);

    const outcomes: string[] = [];
    const fault = (why: string): boolean => watch!.fault(
      why,
      (recorded) => outcomes.push(`left ${recorded}`),
      (refused) => outcomes.push(`refused ${refused}`),
    );
    expect(fault('the test faults the run')).toBe(true);
    expect(fake.sends.filter((message) => message.type === 'watch-fault')).toEqual([
      { type: 'watch-fault', root: made.root, why: 'the test faults the run' },
    ]);
    fake.emit({ type: 'watch-fault-result', root: made.root, outcome: 'left', why: 'exited at its seam' });
    expect(outcomes).toEqual(['left exited at its seam']);

    // A child that leaves answers a fault that was waiting for it, and the record resets to the
    // synthetic starting state: no run is proved behind the exit. The exit is settled through
    // the child's own exit promise, so the scene waits for that turn instead of assuming it.
    expect(fault('the test faults the run again')).toBe(true);
    fake.leave(null, 'SIGTERM');
    await waitUntil(() => outcomes.length === 2);
    expect(outcomes.at(-1)).toBe('refused the chores child left before the fault reached the watch');
    await waitUntil(() => watch!.state().phase === 'starting');
    expect(watch!.state()).toMatchObject({ phase: 'starting', effects: 'blocked', cycles: 0 });
  });

  test('a route that names no watch gets no remote handle and never a frame', () => {
    const made = world();
    const fake = fakeChild(4595);
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(NOW),
      routes: [routeInput(made.root, policy())],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: () => fake.child,
    });
    fleet.tick(new Date(NOW));
    fake.emit({ type: 'ready', pid: 4595, at: AT });
    fake.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
    expect(fleet.watchFor(made.root, () => null)).toBeNull();
    // A frame for a root this child does not host a watch for changes nothing.
    fake.emit({ type: 'watch-state', root: made.root, state: {
      routeId: '0123456789abcdef0123456789abcdef',
      root: made.root,
      team: 'acme',
      session: 'acme-dev',
      phase: 'running',
      startedAt: AT,
      lastCycleAt: null,
      lastCycleOutcome: null,
      cycles: 1,
      failures: 0,
      effects: 'blocked',
      required: true,
      why: null,
    } });
    expect(fleet.watchFor(made.root, () => null)).toBeNull();
  });

  test('watch-pulse and watch-cycle count as liveness, the same as a heartbeat', () => {
    const made = world();
    const clock = { at: NOW };
    const fake = fakeChild(4598);
    const pulses: string[] = [];
    let cpu = 5_000;
    const fleet = createChoresFleet({
      home: made.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(made.root, policy({ missedBeats: 2 }))],
      log: () => {},
      cpuTimeOf: () => cpu,
      watchPulse: (root, at) => pulses.push(`${root} ${at.toISOString()}`),
      factory: () => fake.child,
    });
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    fake.emit({ type: 'ready', pid: 4598, at: AT });
    fake.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });

    // A watch-pulse on the first beat proves the child's second beat and forwards the pulse.
    clock.at = NOW + 1000;
    const pulseAt = new Date(clock.at).toISOString();
    fake.emit({ type: 'watch-pulse', root: made.root, at: pulseAt });
    expect(pulses).toEqual([`${made.root} ${pulseAt}`]);
    tickAt(1000);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: pulseAt,
    });

    // Across the next beats the child speaks only through watch-pulse and watch-cycle: neither
    // misses a beat nor ends the child.
    clock.at = NOW + 2000;
    const cycleAt = new Date(clock.at).toISOString();
    fake.emit({ type: 'watch-cycle', root: made.root, at: cycleAt } as unknown as ChoresChildMessage);
    tickAt(2000);
    tickAt(3000);
    expect(fake.kills).toHaveLength(0);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      heartbeatAt: cycleAt,
    });

    // A child spared while working returns to ok as soon as a watch-pulse or watch-cycle arrives.
    cpu = 5_200;
    tickAt(4000);
    tickAt(5000);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'late',
      missed: 2,
      why: 'the child has missed 2 heartbeats but is still working',
    });
    clock.at = NOW + 5500;
    const recoveredAt = new Date(clock.at).toISOString();
    fake.emit({ type: 'watch-cycle', root: made.root, at: recoveredAt } as unknown as ChoresChildMessage);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
      why: null,
      heartbeatAt: recoveredAt,
    });

    // Across 615 beats (615 s, past the 600 s hung ceiling), a busy child that emits watch-pulse
    // between watch steps is never marked late and never killed at the ceiling.
    for (let step = 6; step <= 620; step += 1) {
      cpu += 200;
      clock.at = NOW + step * 1000;
      fake.emit({ type: 'watch-pulse', root: made.root, at: new Date(clock.at).toISOString() });
      tickAt(step * 1000);
    }
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'ok',
      missed: 0,
    });
    expect(fake.kills).toHaveLength(0);

    // By contrast, a busy child that emits nothing across those 600 s is marked late and then
    // killed at the ceiling.
    for (let step = 621; step <= 1219; step += 1) {
      cpu += 200;
      tickAt(step * 1000);
    }
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'late',
      missed: 2,
      why: 'the child has missed 598 heartbeats but is still working',
    });
    expect(fake.kills).toHaveLength(0);
    cpu += 200;
    tickAt(1220 * 1000);
    expect(fake.kills).toEqual(['the child has not beaten for 600000 ms while its CPU kept advancing']);
    expect(fleet.stateFor(made.root)).toMatchObject({
      state: 'late',
      missed: 2,
      why: 'the child has not beaten for 600000 ms while its CPU kept advancing',
    });

    // The protocol reader accepts a well-formed watch-cycle and drops a malformed one.
    expect(readChildMessage({ type: 'watch-cycle', root: made.root, at: recoveredAt })).toEqual({
      type: 'watch-cycle',
      root: made.root,
      at: recoveredAt,
    } as unknown as ChoresChildMessage);
    expect(readChildMessage({ type: 'watch-cycle', root: '', at: recoveredAt })).toBeNull();
    expect(readChildMessage({ type: 'watch-cycle', root: made.root, at: '' })).toBeNull();
  });
});

describe('the presence frames', () => {
  const status: PresenceSourceStatus = {
    seat: 'crew-lead',
    binding: 'prs_0123456789ab',
    threadId: 'th-1',
    channel: 'connected',
    stream: 'initialized',
    baseline: 'read',
    evidenceAt: AT,
    stagedEventId: '2026-11-02T03:00:00.000Z-aaaaaaaa',
  };

  test('a nudge carries each measured reading and a result carries one proof per seat', () => {
    const readings: ChoresPresenceReading[] = [
      { seat: 'crew-lead', status },
      { seat: 'other', failed: 'the runtime source has staged no event yet' },
    ];
    expect(readHostMessage({ type: 'presence', id: 'p1', root: '/repo', at: AT, readings })).toEqual({
      type: 'presence', id: 'p1', root: '/repo', at: AT, readings,
    });
    // A reading this contract cannot carry is refused whole, never half-read.
    expect(readHostMessage({
      type: 'presence', id: 'p1', root: '/repo', at: AT,
      readings: [{ seat: 'crew-lead', status: { ...status, channel: 'serving' } }],
    })).toBeNull();
    expect(readHostMessage({
      type: 'presence', id: 'p1', root: '/repo', at: AT,
      readings: [{ seat: 'crew-lead', status: { ...status, stagedEventId: 7 } }],
    })).toBeNull();

    const proofs = [
      { seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' },
      { seat: 'other', miss: 'the runtime source has staged no event yet' },
    ];
    expect(readChildMessage({
      type: 'presence-result', id: 'p1', root: '/repo', at: AT, proofs,
      notes: ['the activity step failed: spool'],
    })).toEqual({
      type: 'presence-result', id: 'p1', root: '/repo', at: AT, proofs,
      notes: ['the activity step failed: spool'],
      ms: null,
    });
    // A row with neither a proof nor a reason is not a result this protocol carries.
    expect(readChildMessage({
      type: 'presence-result', id: 'p1', root: '/repo', at: AT,
      proofs: [{ seat: 'crew-lead' }], notes: [],
    })).toBeNull();
  });
});

describe('the chores child loop', () => {
  test('a 10 s awaited slice in one root does not hold the next root\'s slice', async () => {
    const made = world();
    const second = join(made.base, 'other');
    const lines: ChoresChildMessage[] = [];
    const stdout = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as ChoresChildMessage);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    let secondPassAt: number | null = null;
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 250,
        since: AT,
        routes: [
          { root: made.root, team: 'acme', session: 'acme-dev' },
          { root: second, team: 'acme', session: 'acme-dev' },
        ],
      },
      stdin,
      stdout,
      pass: async ({ route, slices }) => {
        if (route.root === made.root) {
          // The block the scene names: ten seconds of waiting on the outside world, which leaves
          // the event loop free and answers a stop at its next check.
          const until = Date.now() + 10_000;
          while (!slices.stopping() && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return ['the first root finished its wait'];
        }
        secondPassAt = Date.now();
        return [];
      },
    });
    try {
      const askedAt = Date.now();
      stdin.write(`${JSON.stringify({ type: 'tick', id: '1', at: AT })}\n`);
      // The second root's slice starts on its own turn, not after the first root's ten seconds.
      await waitUntil(() => secondPassAt !== null, 2000);
      expect(secondPassAt! - askedAt).toBeLessThan(1500);
      expect(
        lines.some((message) => message.type === 'pass' && message.passes.some((pass) => pass.root === second)),
      ).toBe(true);
      // And the first root's report has not landed: its wait is still running.
      expect(
        lines.some((message) => message.type === 'pass' && message.passes.some((pass) => pass.root === made.root)),
      ).toBe(false);
    } finally {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    }
    expect(await served).toBe(0);
  }, 15_000);

  test('one presence pass per root is in flight; a second nudge for that root is dropped', async () => {
    const made = world();
    const lines: ChoresChildMessage[] = [];
    const stdout = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as ChoresChildMessage);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    const asked: string[] = [];
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 250,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev', stateDir: join(made.root, '.agents') }],
      },
      stdin,
      stdout,
      pass: async () => [],
      presence: {
        async run(_route, input) {
          asked.push(input.at.toISOString());
          if (asked.length === 1) await firstGate;
          return {
            proofs: input.readings.map((reading) => ({
              seat: reading.seat,
              id: `2026-11-02T03:00:00.000Z-0000000${String(asked.length)}`,
              binding: 'prs_0123456789ab',
            })),
            notes: [],
          };
        },
      },
    });
    const nudge = (id: string, at: string): string => `${JSON.stringify({
      type: 'presence',
      id,
      root: made.root,
      at,
      readings: [{ seat: 'crew-lead', failed: 'the runtime source has staged no event yet' }],
    })}\n`;
    try {
      stdin.write(nudge('p1', AT));
      stdin.write(nudge('p2', new Date(NOW + 1).toISOString()));
      await waitUntil(() => asked.length === 1);
      // The second nudge found this root's pass still in flight and was dropped, exactly as the
      // daemon skips a route whose previous pass has not finished.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(asked).toEqual([AT]);
      release();
      await waitUntil(() => lines.some((message) => message.type === 'presence-result'));
      expect(lines.find((message) => message.type === 'presence-result')).toEqual({
        type: 'presence-result',
        id: 'p1',
        root: made.root,
        at: AT,
        proofs: [{ seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-00000001', binding: 'prs_0123456789ab' }],
        notes: [],
        ms: expect.any(Number),
      });
    } finally {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    }
    expect(await served).toBe(0);
  }, 10_000);

  test('a stop drains a presence pass and sends no result behind it', async () => {
    const made = world();
    const lines: ChoresChildMessage[] = [];
    const stdout = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as ChoresChildMessage);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    let started = false;
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 250,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev' }],
      },
      stdin,
      stdout,
      pass: async () => [],
      presence: {
        async run() {
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            proofs: [{ seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' }],
            notes: ['finished during the stop'],
          };
        },
      },
    });
    stdin.write(`${JSON.stringify({
      type: 'presence',
      id: 'p1',
      root: made.root,
      at: AT,
      readings: [{ seat: 'crew-lead', failed: 'the runtime source has staged no event yet' }],
    })}\n`);
    await waitUntil(() => started);
    stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    // The child leaves only once the pass has drained, and the answer is never written behind a
    // host that has already stopped it.
    expect(await served).toBe(0);
    expect(lines.some((message) => message.type === 'presence-result')).toBe(false);
  }, 10_000);

  test('a nudge this child cannot run is answered with its reason, never handed to the steps', async () => {
    const made = world();
    const elsewhere = join(made.base, 'elsewhere');
    const lines: ChoresChildMessage[] = [];
    const stdout = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as ChoresChildMessage);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 250,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev' }],
      },
      stdin,
      stdout,
      pass: async () => [],
      presence: {
        async run() {
          throw new Error('a nudge that cannot run must never reach the presence steps');
        },
      },
    });
    const write = (message: ChoresHostMessage): void => {
      stdin.write(`${JSON.stringify(message)}\n`);
    };
    try {
      write({ type: 'presence', id: 'bad-at', root: made.root, at: 'yesterday', readings: [{ seat: 'crew-lead', failed: 'x' }] });
      write({ type: 'presence', id: 'elsewhere', root: elsewhere, at: AT, readings: [{ seat: 'crew-lead', failed: 'x' }] });
      await waitUntil(() => lines.filter((message) => message.type === 'presence-result').length === 2);
      const results = lines.filter((message) => message.type === 'presence-result');
      expect(results).toContainEqual({
        type: 'presence-result',
        id: 'bad-at',
        root: made.root,
        at: 'yesterday',
        proofs: [{ seat: 'crew-lead', miss: 'the presence nudge names no valid instant' }],
        notes: ['a presence nudge named no valid instant'],
        ms: null,
      });
      expect(results).toContainEqual({
        type: 'presence-result',
        id: 'elsewhere',
        root: elsewhere,
        at: AT,
        proofs: [{ seat: 'crew-lead', miss: 'the chores child does not serve this root' }],
        notes: ['a presence nudge named a root this child does not serve'],
        ms: null,
      });
    } finally {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    }
    expect(await served).toBe(0);
  }, 10_000);

  test('the real presence pass stops at its own slice boundaries and keeps proofs it already has', async () => {
    const made = world();
    const route = {
      root: made.root,
      team: 'acme',
      session: 'acme-dev',
      stateDir: join(made.root, '.agents'),
      teamFile: teamFile(),
    };
    const pass = createPresencePass({
      version: 1,
      home: made.home,
      beatMs: 100,
      sliceMs: 250,
      since: AT,
      routes: [route],
    });
    const readings = [{ seat: 'crew-lead', failed: 'the runtime source has staged no event yet' }];
    // A stop before the first boundary: the activity step still runs, then the pass ends at
    // the boundary instead of building or publishing anything.
    const stopped = await pass.run(route, {
      at: new Date(NOW),
      readings,
      slices: {
        sliceMs: 250,
        stopping: () => true,
        yield: async () => {
          throw new Error('a stopped pass never yields');
        },
      },
    });
    expect(stopped.proofs).toEqual([]);
    expect(stopped.notes[stopped.notes.length - 1]).toBe('the presence pass stopped at a slice boundary');

    // A stop at the first yield, after the proofs are built: the publish step is never reached,
    // and the proofs the pass already has are not thrown away.
    let stopping = false;
    let yields = 0;
    const halfway = await pass.run(route, {
      at: new Date(NOW),
      readings,
      slices: {
        sliceMs: 250,
        stopping: () => stopping,
        yield: async () => {
          yields += 1;
          stopping = true;
          return true;
        },
      },
    });
    expect(yields).toBe(1);
    expect(halfway.proofs).toEqual([{ seat: 'crew-lead', miss: 'the runtime source has staged no event yet' }]);
    expect(halfway.notes[halfway.notes.length - 1]).toBe(
      'the presence pass stopped at a slice boundary before the publish step',
    );

    // An open pass crosses both boundaries and publishes; the same reading is the same miss.
    yields = 0;
    const open = await pass.run(route, {
      at: new Date(NOW),
      readings,
      slices: {
        sliceMs: 250,
        stopping: () => false,
        yield: async () => {
          yields += 1;
          return true;
        },
      },
    });
    expect(yields).toBe(2);
    expect(open.proofs).toEqual([{ seat: 'crew-lead', miss: 'the runtime source has staged no event yet' }]);
    expect(open.notes.some((note) => note.startsWith('the presence pass stopped'))).toBe(false);
  });

  test('the frames carry the chore, its own duration and the cache its process filled', async () => {
    const made = world();
    const lines: ChoresChildMessage[] = [];
    const stdout = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as ChoresChildMessage);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    // The child's clock is the test's, so the durations it reports are the ones this scene set.
    let clock = NOW;
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 50,
        sliceMs: 250,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev' }],
      },
      stdin,
      stdout,
      now: () => new Date(clock),
      markerCacheStats: () => ({ read: 9, reused: 4, cached: 5 }),
      pass: async () => {
        clock += 750;
        return ['the pass ran'];
      },
      presence: {
        async run() {
          clock += 30;
          return {
            proofs: [{ seat: 'crew-lead', id: '2026-11-02T03:00:00.000Z-aaaaaaaa', binding: 'prs_0123456789ab' }],
            notes: [],
          };
        },
      },
    });
    try {
      await waitUntil(() => lines.some((message) => message.type === 'pass'));
      expect(lines.find((message) => message.type === 'heartbeat')).toMatchObject({
        type: 'heartbeat',
        markerCache: { read: 9, reused: 4, cached: 5 },
      });
      const pass = lines.find((message) => message.type === 'pass');
      expect(pass?.type === 'pass' ? pass.passes[0] : null).toMatchObject({
        root: made.root,
        notes: ['the pass ran'],
        chore: 'fallback',
        ms: 750,
      });
      stdin.write(`${JSON.stringify({
        type: 'presence', id: 'p1', root: made.root, at: AT,
        readings: [{ seat: 'crew-lead', failed: 'the runtime source has staged no event yet' }],
      })}\n`);
      await waitUntil(() => lines.some((message) => message.type === 'presence-result'));
      expect(lines.find((message) => message.type === 'presence-result')).toMatchObject({
        type: 'presence-result',
        id: 'p1',
        at: AT,
        ms: 30,
      });
    } finally {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    }
    expect(await served).toBe(0);
  }, 10_000);
});

describe('a real child', () => {
  test('starts from its one-use token, reports its own size and answers a pass', async () => {
    const made = world();
    const events: ChoresChildEvent[] = [];
    const child = spawnChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 2000,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev' }],
      },
    });
    const unsubscribe = child.subscribe((event) => events.push(event));
    try {
      await waitUntil(() => messages(events).some((message) => message.type === 'ready'), 20_000);
      await waitUntil(() => messages(events).some((message) => message.type === 'heartbeat'), 20_000);
      const beat = messages(events).find((message) => message.type === 'heartbeat');
      expect(beat?.type).toBe('heartbeat');
      if (beat?.type === 'heartbeat') expect(beat.rssBytes).toBeGreaterThan(0);
      expect(child.pid).toBeGreaterThan(0);
      // One token starts one child: the child consumed it as it started.
      expect(readdirSync(machineConfigDir(made.home)).filter((name) => name.startsWith('chores.inherit.'))).toEqual([]);
      child.send({ type: 'tick', id: '1', at: AT });
      await waitUntil(
        () => messages(events).some((message) => message.type === 'pass' && message.passes.some((pass) => pass.root === made.root)),
        20_000,
      );
      // A token route with no state folder cannot run the presence steps; the real child answers
      // the nudge with that reason instead of guessing a store.
      child.send({
        type: 'presence',
        id: 'p1',
        root: made.root,
        at: AT,
        readings: [{ seat: 'crew-lead', failed: 'the runtime source has staged no event yet' }],
      });
      await waitUntil(
        () => messages(events).some((message) => message.type === 'presence-result' && message.id === 'p1'),
        20_000,
      );
      expect(messages(events).find((message) => message.type === 'presence-result' && message.id === 'p1')).toEqual({
        type: 'presence-result',
        id: 'p1',
        root: made.root,
        at: AT,
        proofs: [{ seat: 'crew-lead', miss: 'the chores child has no state folder for this root' }],
        notes: ['the presence pass has no state folder for this root'],
        ms: expect.any(Number),
      });
    } finally {
      unsubscribe();
      child.kill('the test is done');
      await child.exited;
    }
  }, 30_000);

  test('a child whose input closes mid-send throws nowhere, and its exit is marked', async () => {
    const made = world();
    const entry = join(made.base, 'closing-child.mjs');
    writeFileSync(entry, [
      "const write = (message) => { try { process.stdout.write(JSON.stringify(message) + '\\n'); } catch {} };",
      "write({ type: 'ready', pid: process.pid, at: new Date().toISOString() });",
      'let closed = false;',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', () => {",
      '  if (closed) return;',
      '  closed = true;',
      "  // The read end goes away while the host is still writing: the next write is EPIPE.",
      '  // The process stays alive for a moment after that, so the failure lands while the child',
      '  // is still running and is the input\'s own, not a write raced by the exit.',
      '  process.stdin.destroy();',
      '  setTimeout(() => process.exit(0), 500);',
      '});',
    ].join('\n'));
    const events: ChoresChildEvent[] = [];
    const child = spawnChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 2000,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev' }],
      },
      entry,
    });
    child.subscribe((event) => events.push(event));
    try {
      await waitUntil(() => events.some((event) => event.kind === 'message' && event.message.type === 'ready'), 20_000);
      // Write across the moment the child closes its input. The write that meets the closed
      // pipe is reported as a note; before this fix it was an unhandled 'error' event and the
      // whole process went down with the child.
      for (let beat = 0; beat < 40; beat += 1) {
        if (!child.send({ type: 'tick', id: String(beat), at: AT })) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await waitUntil(() => events.some((event) => event.kind === 'exit'), 10_000);
      // A child that has left takes no frame: the write is refused, never attempted.
      expect(child.send({ type: 'tick', id: 'after', at: AT })).toBe(false);
      expect(child.alive).toBe(false);
      // The writes above crossed the moment the child closed its input. Measured under this
      // runtime: the closure is buffered and surfaces only as the stream's destruction when the
      // process leaves — no 'error' event, and the write after the exit is refused. Under the
      // node runtime the same closure raises EPIPE as an 'error' event, which spawn.ts turns
      // into a note instead of the daemon's last breath. What this scene pins for both is that
      // the write path itself throws nowhere and the exit is marked exactly once.
      expect(events.filter((event) => event.kind === 'exit')).toHaveLength(1);
    } finally {
      child.kill('the test is done');
      await child.exited;
    }
  }, 30_000);

  test('a watched route drives a hosted watch here, and a stop ends it before the child leaves', async () => {
    const made = world();
    const second = join(made.base, 'other');
    const lines: ChoresChildMessage[] = [];
    const stdout = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as ChoresChildMessage);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    const beats: { root: string; at: string; presence: readonly { seat: string; healthy: boolean }[] | null }[] = [];
    const faults: { root: string; why: string }[] = [];
    let built: ChoresWatchInput | null = null;
    let releaseStop: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopAsked = false;
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 250,
        since: AT,
        routes: [
          {
            root: made.root,
            team: 'acme',
            session: 'acme-dev',
            watch: { teamFile: join(made.root, '.agents', 'team.yaml'), presence: true },
          },
          { root: second, team: 'acme', session: 'acme-dev' },
        ],
      },
      stdin,
      stdout,
      pass: async () => [],
      presence: { async run() { return { proofs: [], notes: [] }; } },
      watchFactory: (input) => {
        built = input;
        // The production module hosts only the routes that name a watch; this seam keeps that
        // rule so a beat for an unwatched root is observably ignored rather than recorded.
        const hosted = new Set(input.routes.filter((route) => route.watch !== undefined).map((route) => route.root));
        return {
          beat(root, at, presence) {
            if (!hosted.has(root)) return;
            beats.push({ root, at: at.toISOString(), presence });
          },
          fault(root, why) {
            if (!hosted.has(root)) return;
            faults.push({ root, why });
          },
          async stop(why) {
            stopAsked = why === 'the daemon asked this child to stop';
            await held;
          },
        };
      },
    });
    try {
      stdin.write(`${JSON.stringify({ type: 'watch-beat', root: made.root, at: AT, presence: [{ seat: 'crew-lead', healthy: true }] })}\n`);
      stdin.write(`${JSON.stringify({ type: 'watch-fault', root: made.root, why: 'the test faults the run' })}\n`);
      await waitUntil(() => beats.length === 1 && faults.length === 1);
      expect(beats[0]).toEqual({ root: made.root, at: AT, presence: [{ seat: 'crew-lead', healthy: true }] });
      expect(faults[0]).toEqual({ root: made.root, why: 'the test faults the run' });
      // A beat for a root this child hosts no watch for reaches no host, and is not an error.
      stdin.write(`${JSON.stringify({ type: 'watch-beat', root: second, at: AT, presence: null })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(beats).toHaveLength(1);

      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
      await waitUntil(() => stopAsked, 2000);
      // The child neither writes its last frame nor leaves while the watch is still ending at
      // its own seam: the epoch is released before the process is gone.
      let settled = false;
      void served.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(lines.some((message) => message.type === 'stopped')).toBe(false);
    } finally {
      releaseStop!();
    }
    expect(await served).toBe(0);
    expect(lines.some((message) => message.type === 'stopped')).toBe(true);
    // The whole route set crossed the seam; the production module skips the route with no watch.
    expect(built!.routes).toHaveLength(2);
  }, 10_000);
});

describe('under the machine daemon', () => {
  test('inline mode starts no child and the daemon serves as before', async () => {
    const made = world();
    word(made.home, made.root, 'daemon.chores', 'inline');
    let spawned = 0;
    const started = await startMachineDaemon({
      home: made.home,
      roots: [made.root],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 50,
      choresHosting: true,
      choresFactory: () => {
        spawned += 1;
        return fakeChild(4500).child;
      },
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitUntil(() => rowFor(made.home, made.root) !== undefined);
      expect(rowFor(made.home, made.root)).toMatchObject({ mode: 'inline', state: 'inline', pid: null });
      expect(spawned).toBe(0);
      const health = await daemonHealth(made.home, { timeoutMs: 500 });
      expect(health.state).toBe('running');
      expect(health.probe.state).toBe('answered');
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
    }
  }, 30_000);

  test('a plain run hosts its per-root child with no test seam at all', async () => {
    const made = world();
    // A cold real child outlives the release miss allowance on a busy machine; this scene is
    // about the command starting one, never about how fast the machine is.
    word(made.home, made.root, 'daemon.chores-missed-beats', 20);
    const io = testIo(made.root, { kind: 'owner' });
    // The holder, not a bare `let`: the stop seam is assigned from inside the command's own
    // callback, which a narrowed outer variable cannot see.
    const control: { stop: (() => void) | null } = { stop: null };
    let disarmed = false;
    const running = runDaemon(['run', '--root', made.root], io, {
      home: made.home,
      version: '0.5.12-chores-test',
      gitHead: null,
      heartbeatMs: 100,
      stop: (end) => {
        control.stop = end;
        return () => {
          disarmed = true;
        };
      },
    });
    try {
      await waitUntil(() => (rowFor(made.home, made.root)?.pid ?? null) !== null, 20_000);
      const row = rowFor(made.home, made.root);
      if (row === undefined) throw new Error('the run wrote no chores row');
      // The command passed chores hosting: the default per-root mode built a fleet.
      expect(row.mode).toBe('per-root');
      const childPid = row.pid;
      if (childPid === null) throw new Error('the row named no child');
      // A process of its own, not this one.
      expect(childPid).not.toBe(process.pid);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      // The same child reaches 'ok': a replacement would carry another pid.
      await waitUntil(() => {
        const now = rowFor(made.home, made.root);
        return now?.pid === childPid && now.state === 'ok';
      }, 20_000);
    } finally {
      control.stop?.();
    }
    expect(await running).toBe(0);
    expect(disarmed).toBe(true);
    expect(io.out).toContain('team daemon: running');
    expect(io.out).toContain('team daemon: stopped');
    // The clean close removes the record, and the child it named with it.
    expect(rowFor(made.home, made.root)).toBeUndefined();
  }, 90_000);

  test('the health probe answers in under 100 ms while a child sweeps a large fallback store', async () => {
    const made = world();
    // The smallest slice the catalogue allows, and a miss allowance a loaded machine cannot
    // trip: the sweep runs long enough to cover the probes, and the child yields inside it.
    word(made.home, made.root, 'daemon.chores-slice-ms', 100);
    word(made.home, made.root, 'daemon.chores-missed-beats', 20);
    // A store the sweep cannot finish inside the probe window: this lane measured about a
    // second to walk 12,000 delivered markers, so a 100 ms slice crosses it many times.
    for (let index = 0; index < 12_000; index += 1) {
      deliveredMarker(made.root, `m-${String(index).padStart(5, '0')}-health`, NOW);
    }
    const started = await startMachineDaemon({
      home: made.home,
      roots: [made.root],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 100,
      choresHosting: true,
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitUntil(() => rowFor(made.home, made.root)?.busy === 'chores', 30_000);
      const elapsed: number[] = [];
      for (let probe = 0; probe < 3; probe += 1) {
        const before = Date.now();
        const answer = await probeDaemonHealth(started.daemon.socketPath, { timeoutMs: 500 });
        elapsed.push(Date.now() - before);
        expect(answer.kind).toBe('answered');
      }
      // The daemon answered while its child was still inside the sweep: the last heartbeat, sent
      // during the probes, named the chore as running.
      expect(rowFor(made.home, made.root)?.busy).toBe('chores');
      expect(Math.max(...elapsed)).toBeLessThan(100);
      expect(rowFor(made.home, made.root)).toMatchObject({ state: 'ok', missed: 0 });
      // The sweep is the fallback pass, and it completes even while the probes are answered.
      await waitUntil(() => rowFor(made.home, made.root)?.lastChore?.name === 'fallback', 30_000);
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 20_000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
      // The store this scene wrote is large; removing it here keeps the file hook's own
      // cleanup inside its bound, and the hook's own remove of this path is a no-op.
      rmSync(made.base, { recursive: true, force: true });
    }
  }, 180_000);

  test('a hosted root\'s presence steps run in its child, and the child\'s answer is the one applied', async () => {
    const made = world();
    const fake = fakeChild(4700);
    // The fake answers a stop by leaving, so the daemon's close is not held by the kill bound.
    const child: ChoresChild = {
      ...fake.child,
      get alive() {
        return fake.child.alive;
      },
      kill(why: string) {
        fake.child.kill(why);
        fake.leave();
      },
    };
    let inlineCalls = 0;
    const started = await startMachineDaemon({
      home: made.home,
      roots: [made.root],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 100,
      choresHosting: true,
      presenceHosting: true,
      presenceEveryMs: 20,
      presenceSubscriptions: () => [{
        step: async () => undefined,
        status: () => ({
          seat: 'crew-lead',
          binding: 'prs_0123456789ab',
          threadId: 'th-1',
          channel: 'connected',
          stream: 'initialized',
          baseline: 'read',
          evidenceAt: new Date().toISOString(),
          stagedEventId: '2026-11-02T03:00:00.000Z-aaaaaaaa',
        }),
        close: async () => ({ quiesced: true }),
      }],
      presenceActivity: () => async () => {
        inlineCalls += 1;
        return { failed: null, seats: [] };
      },
      presencePublish: () => async () => {
        inlineCalls += 1;
        return { failed: null, seats: [] };
      },
      choresFactory: () => child,
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // Until the child is ready the daemon runs the presence steps itself: the fallback every
      // root kept before the isolation.
      await waitUntil(() => inlineCalls > 0, 5000);
      await waitUntil(() => fake.sends.some((message) => message.type === 'tick'), 5000);
      fake.emit({ type: 'ready', pid: 4700, at: new Date().toISOString() });
      fake.emit({ type: 'heartbeat', at: new Date().toISOString(), rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
      await waitUntil(() => fake.sends.some((message) => message.type === 'presence'), 5000);
      const frame = [...fake.sends].reverse().find((message) => message.type === 'presence');
      if (frame?.type !== 'presence') throw new Error('the child was never nudged');
      // The nudge carries the reading the daemon measured, not a verdict of its own.
      expect(frame.readings).toHaveLength(1);
      expect(frame.readings[0]).toMatchObject({
        seat: 'crew-lead',
        status: {
          binding: 'prs_0123456789ab',
          threadId: 'th-1',
          channel: 'connected',
          stream: 'initialized',
          baseline: 'read',
          stagedEventId: '2026-11-02T03:00:00.000Z-aaaaaaaa',
        },
      });
      // The child's own answer is what the daemon applies: its note reaches the daemon log, and
      // the daemon's inline steps produced no such line.
      fake.emit({
        type: 'presence-result',
        id: frame.id,
        root: made.root,
        at: frame.at,
        proofs: [{ seat: 'crew-lead', miss: 'the canonical presence projection has not applied the runtime event' }],
        notes: ['the activity step failed: from the child'],
        ms: 12,
      });
      await waitUntil(() => {
        try {
          return readFileSync(daemonLogPath(made.home), 'utf8').includes('the activity step failed: from the child');
        } catch {
          return false;
        }
      }, 5000);
      // The accepted answer reaches the record as this root's last chore and presence reading.
      await waitUntil(() => rowFor(made.home, made.root)?.presence !== null, 5000);
      expect(rowFor(made.home, made.root)?.presence).toEqual({ at: frame.at, ms: 12, proved: 0, missed: 1 });
      expect(rowFor(made.home, made.root)?.lastChore).toEqual({ name: 'presence', at: frame.at, ms: 12 });
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
    }
  }, 30_000);

  test('a watched root\'s watch runs in its child, and the daemon mirrors the child\'s frames', async () => {
    const made = world();
    const fake = fakeChild(4730);
    // The fake answers a stop by leaving, so the daemon's close is not held by the kill bound.
    const child: ChoresChild = {
      ...fake.child,
      get alive() {
        return fake.child.alive;
      },
      kill(why: string) {
        fake.child.kill(why);
        fake.leave();
      },
    };
    let inlineBuilt = 0;
    const started = await startMachineDaemon({
      home: made.home,
      roots: [made.root],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 100,
      choresHosting: true,
      watchHosting: true,
      hostedWatch: () => {
        inlineBuilt += 1;
        return { run: async () => 0 };
      },
      choresFactory: () => child,
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // The handle is the child's from the first status row: the daemon builds no inline watch.
      expect(inlineBuilt).toBe(0);
      expect(started.daemon.roots[0]?.watch).toMatchObject({ phase: 'starting', required: true, effects: 'blocked' });
      // The child is subscribed when the fleet's first beat starts it; only then can a frame
      // reach the daemon, so the scene waits for that beat before answering as the child.
      await waitUntil(() => fake.sends.some((message) => message.type === 'tick'), 5000);
      // The daemon judges a heartbeat against its own real clock, so these frames carry real
      // instants; only the watch state below is framed on the scene's fixed instant.
      fake.emit({ type: 'ready', pid: 4730, at: new Date().toISOString() });
      fake.emit({ type: 'heartbeat', at: new Date().toISOString(), rssBytes: 40 * 1024 * 1024, busy: null, markerCache: null });
      await waitUntil(() => fake.sends.some((message) => message.type === 'watch-beat'), 5000);
      const beat = fake.sends.find((message) => message.type === 'watch-beat');
      if (beat?.type !== 'watch-beat') throw new Error('no watch beat crossed the pipe');
      // This daemon hosts no presence for the route, so the child is told the reading is unknown.
      expect(beat).toMatchObject({ root: made.root, presence: null });

      // The child's frame is the record the daemon publishes: no second state is computed here.
      const state = {
        routeId: '0123456789abcdef0123456789abcdef',
        root: made.root,
        team: 'acme',
        session: 'acme-dev',
        phase: 'running' as const,
        startedAt: AT,
        lastCycleAt: AT,
        lastCycleOutcome: 'pass' as const,
        cycles: 3,
        failures: 0,
        effects: 'blocked' as const,
        required: true,
        why: null,
      };
      fake.emit({ type: 'watch-state', root: made.root, state });
      await waitUntil(() => {
        const read = readDaemonState(made.home);
        return read.kind === 'ok' && read.state.roots[0]?.watch?.cycles === 3;
      }, 5000);
      const read = readDaemonState(made.home);
      expect(read.kind).toBe('ok');
      if (read.kind === 'ok') expect(read.state.roots[0]?.watch).toMatchObject(state);
      expect(inlineBuilt).toBe(0);
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
    }
  }, 30_000);

  test('a child blocked for 10 s delays neither the socket, the health probe nor another root', async () => {
    const first = world();
    const second = repo(first.base, 'other');
    register(first.home, second);
    const fixture = join(first.base, 'chores-fixture-child.ts');
    writeFileSync(fixture, FIXTURE_CHILD);
    // A child per root, for a root whose loop is held: the isolation this scene names. A long
    // miss allowance keeps the blocked child alive while the others are observed; the same word
    // is on both roots so no replacement happens mid-observation.
    for (const root of [first.root, second]) {
      word(first.home, root, 'daemon.chores', 'per-root');
      word(first.home, root, 'daemon.chores-missed-beats', 60);
    }
    const started = await startMachineDaemon({
      home: first.home,
      roots: [first.root, second],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 200,
      choresHosting: true,
      choresFactory: (input: SpawnChoresInput) => {
        const root = input.config.routes[0]?.root ?? '';
        return root === first.root
          ? spawnChoresChild({ ...input, entry: fixture, env: { CHORES_FIXTURE_BLOCK_MS: '10000' } })
          : spawnChoresChild(input);
      },
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // The fixture names the instant it starts holding its loop.
      await waitUntil(() => rowFor(first.home, first.root)?.busy === 'blocked', 25_000);
      // While held, the row is already late and says how far behind the child is.
      await waitUntil(() => rowFor(first.home, first.root)?.state === 'late', 5000);
      expect(rowFor(first.home, first.root)?.missed).toBeGreaterThan(0);
      expect(rowFor(first.home, first.root)?.why).toContain('missed');

      // The machine socket answers during the block, inside a timer bound.
      const answered = await Promise.race([
        daemonHealth(first.home, { timeoutMs: 500 }).then((health) => health.probe.state === 'answered'),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1500);
          timer.unref();
        }),
      ]);
      expect(answered).toBe(true);

      // The sibling root's child keeps beating while the first one is held.
      await waitUntil(() => rowFor(first.home, second)?.state === 'ok', 5000);
      const beforeBeat = rowFor(first.home, second)?.heartbeatAt;
      await waitUntil(() => rowFor(first.home, second)?.heartbeatAt !== beforeBeat, 5000);
      expect(rowFor(first.home, second)?.missed).toBe(0);

      // And the daemon's own heartbeat keeps moving: the parent loop was never held.
      const beforeState = stateNow(first.home)?.heartbeatAt;
      await waitUntil(() => stateNow(first.home)?.heartbeatAt !== beforeState, 5000);
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
    }
  }, 60_000);

  test('shared mode answers the socket and runs another root while one root waits 10 s', async () => {
    const first = world();
    const second = repo(first.base, 'other');
    register(first.home, second);
    const fixture = join(first.base, 'chores-shared-fixture.ts');
    writeFileSync(fixture, SHARED_FIXTURE_CHILD);
    // Both roots take the `shared` mode by policy, a short slice, and a long miss allowance so
    // the waiting slice is observed rather than replaced.
    for (const root of [first.root, second]) {
      word(first.home, root, 'daemon.chores', 'shared');
      word(first.home, root, 'daemon.chores-slice-ms', 250);
      word(first.home, root, 'daemon.chores-missed-beats', 60);
    }
    let spawned = 0;
    const started = await startMachineDaemon({
      home: first.home,
      roots: [first.root, second],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 200,
      choresHosting: true,
      choresFactory: (input: SpawnChoresInput) => {
        spawned += 1;
        return spawnChoresChild({ ...input, entry: fixture, env: { CHORES_FIXTURE_BLOCK_MS: '10000' } });
      },
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // One child carries both roots.
      await waitUntil(() => spawned === 1, 5000);
      // The first root is inside its ten-second wait.
      await waitUntil(() => rowFor(first.home, first.root)?.busy === 'blocked', 25_000);
      // The second root's pass ran while the first root was still waiting: its own turn costs
      // one slice, never the sibling's wait.
      await waitUntil(() => rowFor(first.home, second)?.lastPassAt !== null, 3000);
      expect(rowFor(first.home, second)?.state).toBe('ok');
      // The child's own names and numbers ride its frames into the record: the chore it ran and
      // how long it took, and the marker cache its process filled.
      expect(rowFor(first.home, second)?.lastChore?.name).toBe('fallback');
      expect(rowFor(first.home, second)?.lastChore?.ms).toBe(5);
      await waitUntil(() => rowFor(first.home, second)?.markerCache !== null, 5000);
      expect(rowFor(first.home, second)?.markerCache).toEqual({ read: 7, reused: 4, cached: 3 });
      // The machine socket answers from its own loop, inside a timer bound.
      const answered = await Promise.race([
        daemonHealth(first.home, { timeoutMs: 500 }).then((health) => health.probe.state === 'answered'),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1500);
          timer.unref();
        }),
      ]);
      expect(answered).toBe(true);
      // And the daemon's own heartbeat keeps moving: only the chores wait.
      const beforeState = stateNow(first.home)?.heartbeatAt;
      await waitUntil(() => stateNow(first.home)?.heartbeatAt !== beforeState, 5000);
      // The wait is never charged as a miss: the child kept its own heartbeat throughout.
      expect(rowFor(first.home, first.root)?.state).toBe('ok');
      expect(rowFor(first.home, first.root)?.restarts).toBe(0);
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
    }
  }, 60_000);
});

describe('the child carries the team file the daemon validated', () => {
  test('a pass uses the token-carried file with the root file gone, and its escalation is one event and one mailbox', async () => {
    const made = world();
    const carried = teamFile();
    // The token's snapshot is the only team file this pass may read: the root's own file is gone
    // before the child starts, so a pass that reached for the file would refuse the root by name.
    rmSync(join(made.root, '.agents', 'team.yaml'));
    const lead = entityLead(made.home, made.base);
    const recipient = dueMarker(made.root, 'm-due-1', NOW - 60_000);
    const input = new PassThrough();
    const output = new PassThrough();
    const frames = collectFrames(output);
    const served = serveChoresChild({
      config: {
        version: 1,
        home: made.home,
        beatMs: 100,
        sliceMs: 2000,
        since: AT,
        routes: [{ root: made.root, team: 'acme', session: 'acme-dev', teamFile: carried }],
      },
      stdin: input,
      stdout: output,
      now: () => new Date(NOW),
    });
    try {
      await waitUntil(() => frames.some((frame) => frame.type === 'pass'), 5000);
    } finally {
      input.end();
    }
    expect(await served).toBe(0);
    const pass = frames.find((frame) => frame.type === 'pass');
    expect(pass).toBeDefined();
    if (pass?.type !== 'pass') throw new Error('the child reported no pass');
    expect(pass.passes).toEqual([
      {
        root: made.root,
        at: AT,
        notes: ['fallback sweep: escalated 1, refused 0, unreadable 0'],
        chore: 'fallback',
        ms: expect.any(Number),
      },
    ]);
    expect(markerNow(recipient, 'm-due-1')?.escalatedAt).toBe(AT);

    // The escalation is the signed event the sweep always writes, addressed to the entity lead.
    const events = escalationEvents(made.root, made.home, recipient, 'm-due-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      record_id: escalatedRecordId(recipient, 'm-due-1'),
      session: 'acme-dev',
      to: 'floor-lead',
      seat: 'crew-lead',
      thread: 'm-due-1',
      via: 'fallback',
    });
    // A lead in another checkout is also reached by its own mailbox record.
    expect(existsSync(messageFile(lead, 'floor-lead', escalationMailboxId(recipient, 'm-due-1')))).toBe(true);
  }, 30_000);
});

describe('the daemon beat leaves a hosted root to its child', () => {
  test('an inline root escalates on the beat while a per-root root keeps its episode pending', async () => {
    const first = world('inline-root');
    const second = repo(first.base, 'per-root-root');
    register(first.home, second);
    const lead = entityLead(first.home, first.base);
    word(first.home, first.root, 'daemon.chores', 'inline');
    word(first.home, second, 'daemon.chores', 'per-root');
    // Long enough that the never-heartbeating fake child stays in place through the observation.
    word(first.home, second, 'daemon.chores-missed-beats', 60);
    const realNow = Date.now();
    const dueInline = dueMarker(first.root, 'm-due-inline', realNow - 60_000);
    const dueHosted = dueMarker(second, 'm-due-hosted', realNow - 60_000);
    const made: Fake[] = [];
    const started = await startMachineDaemon({
      home: first.home,
      roots: [first.root, second],
      startedBy: 'manual',
      version: '0.5.12-chores-test',
      heartbeatMs: 100,
      choresHosting: true,
      choresFactory: () => {
        const child = fakeChild(4700 + made.length);
        made.push(child);
        return child.child;
      },
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitUntil(
        () => rowFor(first.home, first.root)?.mode === 'inline' && rowFor(first.home, second)?.mode === 'per-root',
        5000,
      );
      // The beat owns the inline root and escalates its due episode itself.
      await waitUntil(() => markerNow(dueInline, 'm-due-inline')?.escalatedAt !== undefined, 5000);
      expect(escalationEvents(first.root, first.home, dueInline, 'm-due-inline')).toHaveLength(1);
      expect(existsSync(messageFile(lead, 'floor-lead', escalationMailboxId(dueInline, 'm-due-inline')))).toBe(true);

      // The hosted root's child is alive and nudged while the daemon's beat is observed moving.
      await waitUntil(() => (made[0]?.sends.filter((message) => message.type === 'tick').length ?? 0) >= 2, 5000);
      const beforeHeartbeat = stateNow(first.home)?.heartbeatAt;
      await waitUntil(() => stateNow(first.home)?.heartbeatAt !== beforeHeartbeat, 5000);

      // That root's episode is untouched: the child owns it, and the daemon never swept it.
      expect(markerNow(dueHosted, 'm-due-hosted')).toMatchObject({ status: 'all-failed' });
      expect(markerNow(dueHosted, 'm-due-hosted')?.escalatedAt).toBeUndefined();
      expect(markerNow(dueHosted, 'm-due-hosted')?.outbox).toBeUndefined();
      expect(escalationEvents(second, first.home, dueHosted, 'm-due-hosted')).toHaveLength(0);
      expect(existsSync(messageFile(lead, 'floor-lead', escalationMailboxId(dueHosted, 'm-due-hosted')))).toBe(false);
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          timer.unref();
        }),
      ]);
      expect(closed).toBe(true);
    }
  }, 30_000);
});

describe('the store pass is per root and from the child\'s own start', () => {
  test('the first pass only escalates, and retirement waits for the store interval', async () => {
    const made = world();
    entityLead(made.home, made.base);
    const due = dueMarker(made.root, 'm-due-1', NOW - 60_000);
    const done = deliveredMarker(made.root, 'm-done-1', NOW);
    const route = { root: made.root, team: 'acme', session: 'acme-dev', teamFile: teamFile() };
    const pass = createFallbackPass({
      version: 1,
      home: made.home,
      beatMs: 100,
      sliceMs: 2000,
      since: AT,
      routes: [route],
    });

    // First pass: the due episode is escalated, and nothing is retired.
    expect(await pass({ route, at: new Date(NOW), slices: openSlices })).toEqual([
      'fallback sweep: escalated 1, refused 0, unreadable 0',
    ]);
    expect(markerNow(due, 'm-due-1')?.escalatedAt).toBe(AT);
    expect(existsSync(markerPathOf(done, 'm-done-1'))).toBe(true);

    // A beat later is not housekeeping: the store keeps its history.
    expect(await pass({ route, at: new Date(NOW + 1000), slices: openSlices })).toEqual([]);
    expect(existsSync(markerPathOf(done, 'm-done-1'))).toBe(true);

    // One store interval after this child's first pass, retirement runs: the delivered and the
    // refused episodes both leave, and the note names the store's own words.
    expect(await pass({ route, at: new Date(NOW + FALLBACK_STORE_PASS_MS), slices: openSlices })).toEqual([
      'fallback store: retired 2, reclaimed 0, refused 0, unreadable 0',
    ]);
    expect(markerNow(due, 'm-due-1')).toBeNull();
    expect(markerNow(done, 'm-done-1')).toBeNull();
  }, 30_000);
});
