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
import { messageFile } from '../src/commands/messages.ts';
import { serveChoresChild, type ChoresSlices } from '../src/daemon/chores/child.ts';
import { createFallbackPass } from '../src/daemon/chores/fallback.ts';
import { FALLBACK_STORE_PASS_MS } from '../src/daemon/fallback-sweep.ts';
import { choresPolicyFor, tightestPolicy, type ChoresPolicy } from '../src/daemon/chores/policy.ts';
import {
  parseChoresFrame,
  readChildMessage,
  type ChoresChildMessage,
  type ChoresHostMessage,
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
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { machineConfigDir } from '../src/daemon/paths.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { readDaemonState, type DaemonChoresState, type DaemonState } from '../src/daemon/state.ts';
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
  'const beat = () => write({ type: "heartbeat", at: now(), rssBytes: process.memoryUsage().rss, busy: blocked ? "blocked" : null });',
  'write({ type: "ready", pid: process.pid, at: now() });',
  'beat();',
  'const timer = setInterval(beat, beatMs);',
  'const passFor = (route) => write({ type: "pass", passes: [{ root: route.root, at: now(), notes: [] }] });',
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
  const child: ChoresChild = {
    pid,
    send(message) {
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
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: rss, busy: null });
    expect(fleet.stateFor(made.root)).toMatchObject({ state: 'ok', rssBytes: rss, heartbeatAt: AT, pid: 4100 });
    // The sibling child is judged on its own heartbeats, never on this one's.
    expect(fleet.stateFor(second)).toMatchObject({ state: 'starting', rssBytes: null });

    clock.at = NOW + 1000;
    fleet.tick(new Date(clock.at));
    expect(made2[0]!.sends).toEqual([{ type: 'tick', id: `${String(NOW + 1000)}-0`, at: new Date(NOW + 1000).toISOString() }]);
  });

  test('two missed beats end the child and the replacement waits out a doubling, capped backoff', async () => {
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
    made2[0]!.emit({ type: 'heartbeat', at: AT, rssBytes: 40 * 1024 * 1024, busy: null });

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
    tickAt(3500);
    expect(made2[0]!.kills).toHaveLength(1);

    // The exit schedules the first replacement one second later; the row names when.
    made2[0]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({
      restarts: 1,
      pid: null,
      nextStartAt: new Date(NOW + 3500 + 1000).toISOString(),
    });
    expect(log.some((line) => line.includes('starting a replacement in 1000 ms'))).toBe(true);
    tickAt(4499);
    expect(made2).toHaveLength(1);
    tickAt(4500);
    expect(made2).toHaveLength(2);

    // A second failure waits twice as long; a third is held at the policy's cap.
    made2[1]!.emit({ type: 'ready', pid: 4201, at: new Date(NOW + 4500).toISOString() });
    made2[1]!.emit({ type: 'heartbeat', at: new Date(NOW + 4500).toISOString(), rssBytes: 40 * 1024 * 1024, busy: null });
    tickAt(5500);
    tickAt(6500);
    tickAt(7500);
    expect(made2[1]!.kills).toHaveLength(1);
    made2[1]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 2, nextStartAt: new Date(NOW + 7500 + 2000).toISOString() });
    tickAt(9500);
    expect(made2).toHaveLength(3);
    made2[2]!.emit({ type: 'ready', pid: 4202, at: new Date(NOW + 9500).toISOString() });
    made2[2]!.emit({ type: 'heartbeat', at: new Date(NOW + 9500).toISOString(), rssBytes: 40 * 1024 * 1024, busy: null });
    tickAt(10_500);
    tickAt(11_500);
    tickAt(12_500);
    expect(made2[2]!.kills).toHaveLength(1);
    made2[2]!.leave(null, 'SIGTERM');
    await waitUntil(() => fleet.stateFor(made.root)?.state === 'restarting');
    // 4000 would be the uncapped wait; the policy's 3000 holds it.
    expect(fleet.stateFor(made.root)).toMatchObject({ restarts: 3, nextStartAt: new Date(NOW + 12_500 + 3000).toISOString() });
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
    } finally {
      unsubscribe();
      child.kill('the test is done');
      await child.exited;
    }
  }, 30_000);
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
      { root: made.root, at: AT, notes: ['fallback sweep: escalated 1, refused 0, unreadable 0'] },
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
