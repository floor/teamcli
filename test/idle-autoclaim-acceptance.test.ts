// Acceptance: an idle worker past its threshold is given queued work by the watch itself. The
// watch does not impersonate the worker and never calls the claim path: it pushes a signed
// `team next` request to the worker through the production direct-only send (`sendDirect`), which
// walks only routes that reach a live receiver without a keystroke — socket, and a functional
// headless resume — and never types, drops a copy or writes the seat's own inbox as a wake. The
// worker's runtime — standing in for that client — reads the delivered message through the real
// read-once gate (`readMessage`) and only then runs the real `team next` receiver as the worker.
// One signed request with its history line, exactly one lease, within one virtual minute and with
// no manual step after the watch starts. The world is three queued items, a worker idle since T0
// minus the 300-second default idle threshold, and a virtual clock that never really sleeps.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runNext } from '../src/commands/next.ts';
import { sendDirect, type SendHost } from '../src/commands/send.ts';
import { runWatch, workPushResultOf, type WatchSources } from '../src/commands/watch.ts';
import type { WorkPush, WorkPushRequest } from '../src/watch/dispatch.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent, HerdrAgentStatus } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import { readRecord, verifyRecord, type SignedRecord } from '../src/send/record.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Machine } from '../src/watch/machine.ts';
import type { StatusSource, StatusWaitResult } from '../src/watch/status-events.ts';
import { testIo } from './helpers.ts';

const SEAT = 'deepseek-acme';
const PANE = 'first:pane';
const SESSION = 'acme';

// No `watch.idle_first` here: the claim threshold is the policy's own `idle-threshold`, which
// ships at 300 seconds, and the worker's idle stretch already runs past it at T0. The file is
// approved (verified), so its five-second watch cadence is in force, as on a running team.
const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
watch:
  interval: 5s
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: deepseek-acme
    label: deepseek-acme
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
`;

const QUEUE = `- id: t1
  title: first queued slice
- id: t2
  title: second queued slice
- id: t3
  title: third queued slice
`;

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const START = Date.parse('2026-10-19T10:00:00.000Z');
const MINUTE = 60_000;
const THRESHOLD_MS = 300_000;
// The persisted idle clock the producer reads: the worker reached ready five seconds before the
// default threshold closed, so at T0 it is already past it.
const IDLE_SINCE = START - THRESHOLD_MS - 5_000;

// The dispatch contract is the production one now (`src/watch/dispatch.ts`): the seam the watch
// pushes through, and the two shapes it exchanges. The result's `outcome` is the transport's own
// word, required and kept verbatim; a push result is never read or claim proof.

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

function agent(name: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${workspace}:pane`, workspace, status, cwd: null };
}

function scene(workerStatus: string): Live {
  const agents = [agent('lead', 'lead', 'working'), agent(SEAT, 'first', workerStatus)];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'lead:pane': IDLE, [PANE]: IDLE },
  };
}

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

let base: string;
let root: string;
let home: string;
let sockets: string;
let file: string;
let clock: number;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-autoclaim-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  mkdirSync(sockets);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'acme\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], { cwd: root });
  file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), QUEUE);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: PANE, last_active: new Date(IDLE_SINCE).toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'lead:pane', last_active: new Date(START).toISOString() };
  });
  clock = START;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function leases(): Array<{ id: string; seat: string; pane: string; acquiredAt: string; until: string }> {
  const dir = join(root, '.agents', 'leases');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ id: name.slice(0, -'.json'.length), ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

function workerDropDir(): string {
  return join(root, '.agents', 'send-drops', SESSION, SEAT);
}

function dropNames(): string[] {
  const dir = workerDropDir();
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The signed message records the worker's inbox holds, each verified against the home's
 *  message key: a message that does not verify is not a durable signed copy. */
function workerInbox(): SignedRecord[] {
  const dir = workerDropDir();
  if (!existsSync(dir)) return [];
  const key = messageKeyState(home);
  if (key.kind !== 'key') return [];
  const records: SignedRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const read = readRecord(join(dir, name));
    if (!read.ok || read.record === null) continue;
    if (read.record.payload.to !== SEAT) continue;
    if (!verifyRecord(read.record, key.key)) continue;
    records.push(read.record);
  }
  return records;
}

/** The worker's runtime, standing in for the client that handles what lands in its inbox: the
 *  real read gate serves the delivered message and writes its signed receipt, and only then does
 *  a real `team next` receiver run as the worker. The durable signed copy is written before any
 *  attempt, so the copy's presence alone is not a wake — only the transport's own delivery signal
 *  calls the pump. The receipt, not a set kept here, is what makes a redelivered id run nothing:
 *  the second read is `already-served` and no body is served. This is the receiving side, never a
 *  seam in the watch and never an impersonated worker. */
function workerRuntime(): { pump: () => Promise<void>; claims: string[]; wake: () => void } {
  const claims: string[] = [];
  let woken = 0;
  const wake = () => {
    woken += 1;
  };
  const pump = async () => {
    if (woken === 0) return;
    woken = 0;
    for (const record of workerInbox()) {
      const read = readMessage({ dropDir: workerDropDir(), root, seat: SEAT, session: SESSION }, record.payload.id, home);
      // Already served, refused or superseded: the gate decides, and nothing runs.
      if (!read.ok) continue;
      const io = testIo(root, { kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
      await runNext([], io, { home, now: () => clock });
      claims.push(io.out.trim());
    }
  };
  return { pump, claims, wake };
}

/** The worker's session accepts cross-session frames and exposes a socket for its pane: the direct
 *  route a push is allowed to take. The declaration file is backdated so the socket is newer than
 *  it, as a session launched after its accept declaration would be. */
function directRoute(): void {
  const settings = cliHookSettingsPath(join(root, '.agents'), SESSION, SEAT);
  if (settings === null) throw new Error(`${SEAT}: no settings path for the fixture`);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(settings, past, past);
  writeFileSync(join(sockets, '222.sock'), '');
}

/** The push the watch makes, wired to the REAL production sender: the fixture host only supplies
 *  the session the pass sees and a socket transport, while `sendDirect` is the same command an
 *  ordinary send runs and `workPushResultOf` is the watch's own mapping of its ending. Only a
 *  delivered ending is a success; every held, timeout, unreachable and refused ending is a
 *  refusal. The direct walk never includes the typed or native legs, and never counts a stored
 *  drop or mcp-inbox copy as a wake. */
function pushViaSend(options: { direct: boolean; onDeliver?: () => void }): {
  push: WorkPush;
  pushed: WorkPushRequest[];
  frames: string[];
  typed: string[];
} {
  const frames: string[] = [];
  const typed: string[] = [];
  const pushed: WorkPushRequest[] = [];
  let seat = SEAT;
  let pane = PANE;
  let cli = 'claude-code';
  const host: SendHost = {
    agents: () => [{ name: seat, pane, cli }],
    processInfo: () => (options.direct ? { shell: 111, foreground: [222] } : null),
    socketsDir: sockets,
    deliver: async (_socketPath, frame) => {
      frames.push(frame);
      // The transport's own delivery is the wake the receiving runtime reacts to: the signed
      // copy waiting in the folder is not one.
      options.onDeliver?.();
      return { ok: true };
    },
    native: {
      typeText: (_session, _pane, text) => {
        typed.push(text);
        return true;
      },
      pressEnter: () => {
        typed.push('<enter>');
        return true;
      },
      status: () => 'idle',
      wait: async () => {},
    },
    now: () => new Date(clock),
    home,
    delivery: { team: ['socket'] },
  };
  const push: WorkPush = async (request) => {
    pushed.push(request);
    seat = request.seat;
    pane = request.pane;
    cli = request.cli;
    // The watch stands as the team's orchestrator, on the pane the state records for it: the
    // verified placement production has. The owner shortcut is not this path.
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'lead:pane', session: SESSION });
    const run = await sendDirect(io, host, { seat: request.seat, pane: request.pane, cli: request.cli, body: request.body });
    return workPushResultOf(run.result, io.err);
  };
  return { push, pushed, frames, typed };
}

/** The watch's world: the worker's status, a virtual clock, and an optional receiver pump, run
 *  beside each wait as the inbox side would run between passes. The worker's idle stretch is not
 *  carried here: it is the persisted `last_active` stamp in the session state. */
function watchSources(options: {
  workerStatus: HerdrAgentStatus;
  eventStatus?: HerdrAgentStatus;
  passes: number;
  onPass?: () => Promise<void>;
  pushWork?: WorkPush;
}): { sources: WatchSources; typed: string[]; paneRuns: string[] } {
  const typed: string[] = [];
  const paneRuns: string[] = [];
  const waiters: Array<(result: StatusWaitResult) => void> = [];
  let left = options.passes;
  const statusSource: StatusSource = {
    waitStatus: (_seat, _target, _timeoutMs, signal) => {
      if (signal?.aborted) return Promise.resolve({ outcome: 'error', error: 'aborted', at: clock });
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({ outcome: 'error', error: 'aborted', at: clock }), { once: true });
        waiters.push(resolve);
      });
    },
  };
  const sources: WatchSources = {
    live: () => scene(options.workerStatus),
    machine: () => fine,
    standing: () => verifiedOf(teamOf(TEAM), TEAM, root),
    readChecks: () => [],
    screen: () => IDLE,
    status: () => options.workerStatus,
    foreground: () => ['claude'],
    typeText: (pane, text) => { typed.push(`${pane} ${text}`); return true; },
    pressEnter: (pane) => { typed.push(`${pane} <enter>`); return true; },
    sendKey: (pane, key) => { typed.push(`${pane} <${key}>`); return true; },
    paneRun: (_session, pane, command) => { paneRuns.push(`${pane} ${command}`); return true; },
    sleep: async (ms) => { clock += ms; },
    notify: () => {},
    now: () => new Date(clock),
    wait: async (seconds, onTick) => {
      // The native event says the status changed; the idle clock lives in the session state.
      const event = options.eventStatus ?? 'idle';
      for (const resolve of waiters.splice(0)) resolve({ outcome: 'changed', status: event, at: clock });
      onTick?.();
      await options.onPass?.();
      clock += seconds * 1000;
      left -= 1;
      return left > 0;
    },
    alive: () => false,
    pid: 4242,
    ownPane: () => ({ pane: 'watch:pane', workspace: 'watch' }),
    home,
    statusSource,
  };
  // The dispatcher's own seam: the watch hands this to dispatchIdleWork on every pass.
  if (options.pushWork !== undefined) sources.pushWork = options.pushWork;
  return { sources, typed, paneRuns };
}

describe('the real team next receiver path', () => {
  test('claims one queued item as the idle seat', async () => {
    const io = testIo(root, { kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
    const code = await runNext([], io, { home, now: () => clock });
    expect(code).toBe(0);
    expect(io.out).toContain('team next: claimed t1');
    const held = leases();
    expect(held.map((lease) => lease.id)).toEqual(['t1']);
    expect(held[0]?.seat).toBe(SEAT);
    expect(held[0]?.pane).toBe(PANE);
  });
});

describe('the push fixture', () => {
  test('signs the request, writes its history line and dials the direct leg', async () => {
    directRoute();
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: runtime.wake });
    const result = await sent.push({ seat: SEAT, pane: PANE, cli: 'claude-code', body: 'run team next' });
    expect(result).toEqual({ ok: true, outcome: 'socket: delivered' });
    expect(sent.frames).toHaveLength(1);
    expect(sent.typed).toEqual([]);
    const inbox = workerInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload.to).toBe(SEAT);
    // The sender is the team's orchestrator seat, standing on the pane the state records for it,
    // not the owner shortcut.
    expect(inbox[0]?.payload.from).toBe('lead');
    const history = readHistory('acme', root, home);
    expect(history.ok).toBe(true);
    const lines = history.ok ? history.entries.filter((entry) => entry.to === SEAT) : [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.id).toBe(inbox[0]?.payload.id);
    // The receiving side is the worker's runtime: the real receiver claims on its signed request.
    await runtime.pump();
    expect(runtime.claims).toHaveLength(1);
    expect(runtime.claims[0]).toContain('claimed t1');
    expect(leases().map((lease) => lease.id)).toEqual(['t1']);
  });
  test('a receiver with no direct route is refused without typing', async () => {
    const sent = pushViaSend({ direct: false });
    const result = await sent.push({ seat: SEAT, pane: PANE, cli: 'claude-code', body: 'run team next' });
    expect(result.ok).toBe(false);
    expect(sent.frames).toEqual([]);
    expect(sent.typed).toEqual([]);
    // The admitted send leaves its one durable signed copy before any attempt; the direct walk
    // attempts only the socket, and the transport took nothing, so this is a held copy and a
    // refusal — never a typed delivery, never a wake.
    expect(workerInbox()).toHaveLength(1);
  });
});

describe('the watch gives an idle worker its queued work', () => {
  test('pushes one signed request, and the worker claims one item within one virtual minute', async () => {
    directRoute();
    const io = testIo(root, { kind: 'owner' });
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: runtime.wake });
    const { sources, typed, paneRuns } = watchSources({
      workerStatus: 'idle',
      passes: 13,
      onPass: runtime.pump,
      pushWork: sent.push,
    });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    // Nothing is typed, keyed or run into any pane: the request travels as a message.
    expect(typed).toEqual([]);
    expect(paneRuns).toEqual([]);
    // The durable signed copy comes before the push: one request record, and it verifies.
    const inbox = workerInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload.to).toBe(SEAT);
    // History keeps the line tied to that record, and only that one.
    const history = readHistory('acme', root, home);
    expect(history.ok).toBe(true);
    const lines = history.ok ? history.entries.filter((entry) => entry.to === SEAT) : [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.id).toBe(inbox[0]?.payload.id);
    // The push went through the direct leg once for the episode, and the send typed nothing.
    expect(sent.pushed).toHaveLength(1);
    expect(sent.frames).toHaveLength(1);
    expect(sent.typed).toEqual([]);
    // The receiver ran the real receiver path once, and the worker holds one lease.
    expect(runtime.claims).toHaveLength(1);
    expect(runtime.claims[0]).toContain('claimed t1');
    const held = leases();
    expect(held).toHaveLength(1);
    expect(held[0]?.id).toBe('t1');
    expect(held[0]?.seat).toBe(SEAT);
    expect(held[0]?.pane).toBe(PANE);
    expect(Date.parse(held[0]?.acquiredAt ?? '')).toBeLessThanOrEqual(START + MINUTE);
    // Later idle passes add no second nudge, no second request and no second lease.
    expect(dropNames().filter((name) => name.startsWith('work-'))).toEqual([]);
    expect(workerInbox()).toHaveLength(1);
    expect(leases()).toHaveLength(1);
  });

  test('a paused team pushes no request and claims nothing', async () => {
    updateState(join(root, '.agents'), (state) => {
      state.pause = { by: 'owner', at: new Date(START).toISOString(), stops: [] };
    });
    directRoute();
    const io = testIo(root, { kind: 'owner' });
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: runtime.wake });
    // The pause's own notice is still typed; what must not happen is a claim request.
    const { sources } = watchSources({
      workerStatus: 'idle',
      passes: 13,
      onPass: runtime.pump,
      pushWork: sent.push,
    });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(sent.pushed).toEqual([]);
    expect(sent.typed).toEqual([]);
    expect(workerInbox()).toEqual([]);
    expect(runtime.claims).toEqual([]);
    expect(leases()).toEqual([]);
  });

  test('a busy worker gets no request and claims nothing', async () => {
    directRoute();
    const io = testIo(root, { kind: 'owner' });
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: runtime.wake });
    const { sources, typed } = watchSources({
      workerStatus: 'working',
      eventStatus: 'working',
      passes: 13,
      onPass: runtime.pump,
      pushWork: sent.push,
    });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(typed).toEqual([]);
    expect(sent.pushed).toEqual([]);
    expect(workerInbox()).toEqual([]);
    expect(runtime.claims).toEqual([]);
    expect(leases()).toEqual([]);
  });

  test('a worker with no idle stamp is never pushed or typed at', async () => {
    // No truthful idle evidence: the persisted activity clock is absent, and the watch is not
    // allowed to guess it (no synthetic stamp is written here). The dispatcher cannot prove the
    // seat waited the threshold, so no request is pushed; the retired legacy paths type no work
    // either. The direct route is fully available, so a push is possible — it must not happen.
    updateState(join(root, '.agents'), (state) => {
      const seat = state.sessions[SESSION]?.seats[SEAT];
      if (seat !== undefined) delete seat.last_active;
    });
    directRoute();
    const io = testIo(root, { kind: 'owner' });
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: runtime.wake });
    const { sources, typed, paneRuns } = watchSources({
      workerStatus: 'idle',
      passes: 13,
      onPass: runtime.pump,
      pushWork: sent.push,
    });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(sent.pushed).toEqual([]);
    expect(sent.frames).toEqual([]);
    expect(sent.typed).toEqual([]);
    expect(typed).toEqual([]);
    expect(paneRuns).toEqual([]);
    expect(workerInbox()).toEqual([]);
    expect(dropNames().filter((name) => name.startsWith('work-'))).toEqual([]);
    expect(runtime.claims).toEqual([]);
    expect(leases()).toEqual([]);
  });

  test('an empty queue claims nothing and never nudges twice', async () => {
    writeFileSync(join(root, '.agents', 'tasks.yaml'), '[]\n');
    directRoute();
    const io = testIo(root, { kind: 'owner' });
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: runtime.wake });
    const { sources, typed } = watchSources({
      workerStatus: 'idle',
      passes: 13,
      onPass: runtime.pump,
      pushWork: sent.push,
    });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(typed).toEqual([]);
    expect(sent.typed).toEqual([]);
    expect(runtime.claims).toEqual([]);
    expect(leases()).toEqual([]);
    // Whether the watch asks and the receiver stands down, or asks not at all, there is at most
    // one request for the one idle stretch.
    expect(workerInbox().length).toBeLessThanOrEqual(1);
    expect(sent.pushed.length).toBeLessThanOrEqual(1);
  });

  test('a receiver with no direct route gets one refusal, and nothing is typed or claimed', async () => {
    // The worker exposes no socket for its pane: no direct leg can take the push. The watch
    // attempts it once and the attempt is refused before any typed fallback. The admitted send
    // still leaves its durable signed copy before any attempt, and that copy alone wakes nothing:
    // nothing is typed into the pane and no lease is taken.
    const io = testIo(root, { kind: 'owner' });
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: false, onDeliver: runtime.wake });
    const { sources, typed, paneRuns } = watchSources({
      workerStatus: 'idle',
      passes: 13,
      onPass: runtime.pump,
      pushWork: sent.push,
    });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(sent.pushed).toHaveLength(1);
    expect(sent.frames).toEqual([]);
    expect(sent.typed).toEqual([]);
    expect(typed).toEqual([]);
    expect(paneRuns).toEqual([]);
    expect(workerInbox()).toHaveLength(1);
    expect(runtime.claims).toEqual([]);
    expect(leases()).toEqual([]);
    expect(dropNames().filter((name) => name.startsWith('work-'))).toEqual([]);
  });
});
