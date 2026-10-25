// Independent acceptance for the shared presence seat construction (97e2a1c2e) and the swap
// hold (0dbe31113).
//
// Every world here is synthetic: a temporary team file, a temporary state, and presence
// projections written by the real spool writer, the real ingester and the real activity
// reconciler. No live seat, pane, session, owner home or credential file is read, and no
// presence projection is written by hand.
//
// The swap scenes drive the real `team swap --run` command with a fake herdr whose screen reads
// idle (or broken). The native hold is the run's own: it reads the store at decision time through
// the same `presenceSeatOf`/`presenceVerdict` the watch uses. Every automatic route — the normal
// boundary, the past-deadline pause and the broken screen — is exercised against a running turn,
// a person wait, a session end, an unfenced record, a predecessor binding and an unproven
// channel; each scene carries its own control (a qualified native idle and an unbound seat take
// the ordinary path) and the one override is the owner's explicit `now`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runSwap, type SwapCommandOptions } from '../src/commands/swap.ts';
import type { Launch } from '../src/commands/up.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import { createPresenceActivity } from '../src/daemon/presence/activity.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { idleWorkReport } from '../src/watch/idle-work.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { emptySession, readState, STATE_FILE, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import {
  nativeAllowsTyping,
  prefetchPresence,
  presenceSeatOf,
  presenceVerdict,
  type PresenceRead,
  type PresenceVerdict,
} from '../src/watch/presence.ts';
import type { Screen } from '../src/watch/screen.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const iso = (before: number): string => new Date(NOW.getTime() - before).toISOString();
const OWNER: Caller = { kind: 'owner' };

const SEAT_ID = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
// The incarnation a relaunch leaves behind.
const PREDECESSOR = 'prs_ffffffffffff';

let root = '';
let home = '';
let dir = '';
let team: TeamFile;
let places: string[] = [];
/** The entity's lobby, the trust entry the swap's own file check requires. */
const lobbyOf = (): string => join(home, '.config', 'team', 'lobbies', 'lab');

const TEAM = (rootPath: string, lobby: string): string => `format: 1
project: acme
session: acme
entity: lab
operator: lead
coordinator: lead
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${rootPath}
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b7-swap-hold-')));
  places.push(base);
  root = join(base, 'acme');
  home = join(base, 'home');
  dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyOf(), { recursive: true, mode: 0o700 });
  const text = TEAM(root, lobbyOf());
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  team = loaded.team;
});

afterEach(() => {
  for (const place of places.splice(0)) rmSync(place, { recursive: true, force: true });
});

function setRule(value: string): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

async function swap(
  argv: string[],
  caller: Caller = OWNER,
  options: Partial<SwapCommandOptions> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runSwap(argv, io, { home, now: () => NOW, ...options });
  return { code, out: io.out, err: io.err };
}

const queue = () => readState(dir).swaps ?? {};

/**
 * The state a launch leaves for the worker: its managed id, its runtime binding, an old activity
 * stamp and the pane herdr reports. The swap run and the ingester both read this record.
 */
function seedSeat(binding = BINDING): void {
  const stored = readState(dir);
  const session = stored.sessions.acme ?? emptySession();
  session.seats.worker = {
    ...(session.seats.worker ?? {}),
    stage: 'ready',
    id: SEAT_ID,
    presence_binding: binding,
    last_active: iso(120 * 60_000),
    pane: 'pane-old',
  };
  writeFileSync(
    join(dir, STATE_FILE),
    `${JSON.stringify({ ...stored, format: 1, sessions: { ...stored.sessions, acme: session } }, null, 2)}\n`,
  );
}

function rewriteBinding(binding: string): void {
  const path = join(dir, STATE_FILE);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: { acme: { seats: Record<string, { presence_binding?: string }> } };
  };
  const record = parsed.sessions.acme.seats.worker;
  if (record === undefined) throw new Error('the state records no worker');
  record.presence_binding = binding;
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

type PresenceEventName = 'turn-start' | 'turn-end' | 'human-wait' | 'session-end';

/**
 * One projection through the real pipeline: the spool writer stages it, the real ingester
 * applies it to the event log and `current.json`, and the real activity reconciler writes the
 * canonical fence and advances the persisted activity clock for the turn transitions.
 */
async function apply(
  event: PresenceEventName,
  ts: string,
  opts: { id: string; binding?: string; fence?: boolean },
): Promise<void> {
  const staged = stagePresenceRecord(dir, {
    session: 'acme',
    seat: 'worker',
    binding: opts.binding ?? BINDING,
    source: 'runtime-event',
    event,
    ts,
    id: opts.id,
  });
  if (staged.kind !== 'staged') throw new Error(`the transition was not staged: ${staged.why}`);
  const ingester = createPresenceIngester({ stateDir: dir, session: 'acme', now: () => NOW });
  const stepped = await ingester.step();
  await ingester.close();
  expect(stepped.ingested.length).toBeGreaterThan(0);
  expect(stepped.errors).toEqual([]);
  if (opts.fence === false) return;
  const activity = createPresenceActivity({ stateDir: dir, session: 'acme', seats: ['worker'] });
  const applied = await activity(NOW);
  expect(applied.failed).toBeNull();
}

function sessionOf(): SessionState {
  return readState(dir).sessions.acme ?? emptySession();
}

async function readsOf(): Promise<ReadonlyMap<string, PresenceRead>> {
  return prefetchPresence({ stateDir: dir, session: 'acme', seatNames: ['worker'] });
}

function verdictOf(
  state: SessionState,
  reads: ReadonlyMap<string, PresenceRead>,
  healthy: (seat: string) => boolean,
  now: Date = NOW,
): PresenceVerdict {
  const read = reads.get('worker');
  if (read === undefined) throw new Error('the snapshot read nothing for worker');
  return presenceVerdict(read, presenceSeatOf(state, 'worker', healthy), { now, thresholdSeconds: 0 });
}

function liveWorld(): Live {
  return {
    running: true,
    agents: [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: root }],
    workspaces: [{ id: 'ws-old', label: 'worker' }],
    screens: { 'pane-old': CLAUDE_IDLE },
  };
}

/** `team swap queue worker` on a fresh entity: the swap's record stands in the real state. */
async function prepared(binding = BINDING): Promise<void> {
  setRule('*=!anthropic');
  const queued = await swap(['queue', 'worker']);
  if (queued.code !== 0) throw new Error(`queue failed: ${queued.code} ${queued.err} ${readFileSync(join(dir, "team.yaml"), "utf8")}`);
  seedSeat(binding);
}

type FakeHerdr = {
  sources: RestartSources;
  did: { typed: string[]; closed: string[]; runs: string[] };
};

/**
 * The herdr world one run reads: the worker on `pane-old`, a launch that makes `pane-new-1`
 * (its text is the captured idle screen, so the read-back is unread), and a clock that advances
 * on the run's own sleeps. `screen` is the old pane's word; `unreadable` is herdr failing to
 * answer at all.
 */
function fakeHerdr(
  opts: { status?: string; screen?: 'idle' | 'working' | 'unsent' | 'provider error' | 'rate limit'; unreadable?: boolean } = {},
): FakeHerdr {
  const did = { typed: [] as string[], closed: [] as string[], runs: [] as string[] };
  let clock = NOW.getTime();
  const now = (): Date => new Date(clock);
  let handoverTurn = false;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    if (handoverTurn) {
      handoverTurn = false;
      const old = led[0];
      if (old) old.status = 'idle';
    }
  };
  const led: { name: string; pane: string; workspace: string; status: string }[] = [
    { name: 'worker', pane: 'pane-old', workspace: 'ws-old', status: opts.status ?? 'idle' },
  ];
  let boxedText = CLAUDE_IDLE;
  let shelled = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const binaries = new Map<string, string>();
  let workingLeft = 0;
  let created = 0;
  const agents = (): HerdrAgent[] => [
    ...led.map((seat) => ({
      name: seat.name,
      agent: 'claude-code',
      pane: seat.pane,
      workspace: seat.workspace,
      status: seat.status,
      cwd: root,
    })),
    ...[...newPanes.entries()]
      .filter(([, slot]) => slot.agent)
      .map(([pane, slot]) => ({
        name: slot.name ?? '',
        agent: 'claude-code',
        pane,
        workspace: slot.workspace,
        status: 'idle',
        cwd: root,
      })),
  ];
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    did.closed.push(workspace);
    for (let index = led.length - 1; index >= 0; index -= 1) {
      if (led[index]!.workspace === workspace) led.splice(index, 1);
    }
    for (const [pane, slot] of [...newPanes.entries()]) {
      if (slot.workspace === workspace) newPanes.delete(pane);
    }
    return true;
  };
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      did.typed.push(text);
      if (pane === 'pane-old') boxedText = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      if (pane === 'pane-old') shelled = true;
      return true;
    },
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep,
    now,
  };
  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      created += 1;
      const pane = `pane-new-${created}`;
      const workspace = `ws-new-${created}`;
      newPanes.set(pane, { text: CLAUDE_IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      binaries.set(pane, command.trim().split(/\s+/).find((word) => !word.includes('=')) ?? 'claude');
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? CLAUDE_IDLE,
    agentStatus: (_session, pane) => {
      if (workingLeft > 0) {
        workingLeft -= 1;
        return 'working';
      }
      return newPanes.has(pane) ? 'idle' : null;
    },
    foreground: (_session, pane) => [binaries.get(pane) ?? 'claude'],
    typeText(_session, pane, text) {
      did.typed.push(text);
      const at = / to (\S+):/.exec(text);
      if (at) {
        writeFileSync(at[1]!, '# handover\n\nwhat is left\n');
        if (pane === 'pane-old') {
          handoverTurn = true;
          if (led[0]) led[0].status = 'working';
        }
      }
      const slot = newPanes.get(pane);
      if (slot !== undefined) {
        slot.text = slot.text.includes('› Ask Codex to do anything')
          ? slot.text.replace('› Ask Codex to do anything', `› ${text}`)
          : claudeBox(text);
      }
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot !== undefined) {
        slot.text = CLAUDE_IDLE;
        workingLeft = 1;
      }
      return true;
    },
    sleep,
    now,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now,
    home,
  };
  const screenKind = opts.screen ?? 'idle';
  const screenOf = (kind: Screen['kind']): Screen => (kind === 'rate limit' ? { kind, reset: null } : { kind });
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => (opts.unreadable ? null : agents()),
    workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: (_session, pane) => (pane === 'pane-old' ? screenOf(screenKind) : { kind: 'idle' }),
    screenText: (_session, pane) => (pane === 'pane-old' ? boxedText : newPanes.get(pane)?.text ?? CLAUDE_IDLE),
    status: (_session, pane) => agents().find((agent) => agent.pane === pane)?.status ?? null,
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : [binaries.get(pane) ?? 'claude']),
    now,
    sleep,
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources, did };
}

const HOLD_TEXT = 'worker: stays queued (past its wait; the native presence proof holds the seat)';
const later = (): Date => new Date(NOW.getTime() + 31 * 60_000);

describe('the presence seat construction is shared (97e2a1c2e)', () => {
  test('one helper reads the real state record, and the watch and the swap reach the same verdict', async () => {
    await prepared();
    await apply('turn-start', iso(40 * 60_000), { id: `${iso(40 * 60_000)}-11111111` });

    const calls: string[] = [];
    const workingState = sessionOf();
    const facts = presenceSeatOf(workingState, 'worker', (seat) => {
      calls.push(seat);
      return true;
    });
    expect(calls).toEqual(['worker']);
    const record = workingState.seats.worker!;
    expect(facts).toEqual({
      seat: 'worker',
      seatId: SEAT_ID,
      binding: BINDING,
      fence: record.presence_applied,
      lastActive: record.last_active,
      channelHealthy: true,
    });
    expect(facts.fence).toMatchObject({ seat_id: SEAT_ID, binding: BINDING, seq: 1, applied_at: NOW.toISOString() });
    expect(facts.lastActive).toBe(iso(40 * 60_000));
    expect(presenceSeatOf(workingState, 'worker', undefined).channelHealthy).toBe(false);
    expect(presenceSeatOf(workingState, 'worker', () => false).channelHealthy).toBe(false);

    const workingReads = await readsOf();
    const working = presenceVerdict(workingReads.get('worker')!, facts, { now: NOW, thresholdSeconds: 0 });
    expect(working).toMatchObject({ idle: false, reason: 'working' });
    expect(nativeAllowsTyping(working)).toBe(false);
    // The watch's own consumer, on the same snapshot and provider, agrees: not idle.
    const workingReport = idleWorkReport({
      root,
      team,
      state: workingState,
      live: liveWorld(),
      now: NOW,
      home,
      presence: workingReads,
      presenceChannelHealthy: () => true,
    });
    expect(workingReport.idle).toEqual([]);

    // The hold is lifted by a real turn-end, never by writing a new snapshot.
    await apply('turn-end', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-22222222` });
    const idleReads = await readsOf();
    const idleState = sessionOf();
    const idleFacts = presenceSeatOf(idleState, 'worker', () => true);
    const idle = presenceVerdict(idleReads.get('worker')!, idleFacts, { now: NOW, thresholdSeconds: 0 });
    expect(idle).toMatchObject({ idle: true, source: 'runtime-event', nativeSince: iso(10 * 60_000) });
    expect(nativeAllowsTyping(idle)).toBe(true);
    const idleReport = idleWorkReport({
      root,
      team,
      state: idleState,
      live: liveWorld(),
      now: NOW,
      home,
      presence: idleReads,
      presenceChannelHealthy: () => true,
    });
    expect(idleReport.idle.map((entry) => entry.seat)).toEqual(['worker']);
    expect(idleReport.idle[0]!.native_since).toBe(iso(10 * 60_000));

    // The two consumers share the construction rather than carrying parallel copies.
    const idleWork = readFileSync(new URL('../src/watch/idle-work.ts', import.meta.url), 'utf8');
    const swapRun = readFileSync(new URL('../src/swap/run.ts', import.meta.url), 'utf8');
    expect(idleWork).toMatch(/import \{[^\n]*presenceSeatOf[^\n]*\} from '\.\/presence\.ts'/);
    expect(swapRun).toMatch(/import \{[^\n]*presenceSeatOf[^\n]*\} from '\.\.\/watch\/presence\.ts'/);
  });

  test('the watch hands its per-seat health provider to its swap source', () => {
    const watch = readFileSync(new URL('../src/commands/watch.ts', import.meta.url), 'utf8');
    const at = watch.indexOf('sources: sources.swapSources');
    expect(at).toBeGreaterThan(-1);
    expect(watch.slice(at, at + 500)).toContain('presenceChannelHealthy: sources.presenceChannelHealthy');
    const command = readFileSync(new URL('../src/commands/swap.ts', import.meta.url), 'utf8');
    expect(command).toContain('presenceChannelHealthy?: (seat: string) => boolean');
    expect(command).toContain('options.presenceChannelHealthy');
  });
});

describe('team swap holds for the native proof (0dbe31113)', () => {
  test('the normal boundary does not stop a seat the runtime reports working', async () => {
    await prepared();
    await apply('turn-start', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-33333333` });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources, presenceChannelHealthy: () => true });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('worker: stays queued (not due yet)');
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
    expect(world.did.runs).toEqual([]);
    expect(queue().worker).toBeDefined();
  });

  test('past its wait, a running turn holds against an idle screen', async () => {
    await prepared();
    await apply('turn-start', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-44444444` });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
    expect(world.did.runs).toEqual([]);
    expect(queue().worker).toBeDefined();
  });

  test('a broken screen does not stop a seat the runtime reports working', async () => {
    await prepared();
    await apply('turn-start', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-55555555` });
    const world = fakeHerdr({ screen: 'provider error' });
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
    expect(queue().worker).toBeDefined();
  });

  test('a person wait holds past its wait', async () => {
    await prepared();
    await apply('human-wait', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-66666666` });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
  });

  test('a session end holds past its wait', async () => {
    await prepared();
    await apply('session-end', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-77777777` });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
  });

  test('an unfenced projection holds past its wait', async () => {
    await prepared();
    await apply('turn-start', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-88888888`, fence: false });
    const state = sessionOf();
    const reads = await readsOf();
    expect(verdictOf(state, reads, () => true)).toMatchObject({
      idle: false,
      reason: 'invalid',
      why: 'the canonical activity fence is absent on the seat record',
    });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.typed).toEqual([]);
  });

  test('a predecessor binding holds past its wait', async () => {
    await prepared(PREDECESSOR);
    await apply('turn-start', iso(10 * 60_000), {
      id: `${iso(10 * 60_000)}-99999999`,
      binding: PREDECESSOR,
    });
    rewriteBinding(BINDING);
    const state = sessionOf();
    const reads = await readsOf();
    expect(verdictOf(state, reads, () => true)).toMatchObject({
      idle: false,
      reason: 'invalid',
      why: 'the projection was emitted by a predecessor runtime binding',
    });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.closed).toEqual([]);
  });

  test('a channel this caller cannot vouch for holds even a qualified native idle', async () => {
    await prepared();
    await apply('turn-end', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-aaaaaaaa` });
    const state = sessionOf();
    const reads = await readsOf();
    expect(verdictOf(state, reads, () => true)).toMatchObject({ idle: true });
    expect(verdictOf(state, reads, () => false)).toMatchObject({
      idle: false,
      reason: 'invalid',
      why: 'the presence channel is not known healthy this pass',
    });

    const denied = fakeHerdr();
    const first = await swap(['--run'], OWNER, {
      sources: denied.sources,
      now: later,
      presenceChannelHealthy: () => false,
    });
    expect(first.code).toBe(0);
    expect(first.out).toContain(HOLD_TEXT);
    expect(denied.did.typed).toEqual([]);

    // Per seat: a provider that vouches for another seat does not vouch for this one.
    const otherSeat = fakeHerdr();
    const second = await swap(['--run'], OWNER, {
      sources: otherSeat.sources,
      now: later,
      presenceChannelHealthy: (seat) => seat === 'lead',
    });
    expect(second.code).toBe(0);
    expect(second.out).toContain(HOLD_TEXT);
    expect(otherSeat.did.typed).toEqual([]);
    expect(queue().worker).toBeDefined();
  });

  test('a run with no channel provider holds a native idle', async () => {
    await prepared();
    await apply('turn-end', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-bbbbbbbb` });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources, now: later });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(HOLD_TEXT);
    expect(world.did.typed).toEqual([]);
    expect(queue().worker).toBeDefined();
  });

  test('a qualified native idle runs at the boundary', async () => {
    await prepared();
    await apply('turn-end', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-cccccccc` });
    const state = sessionOf();
    const reads = await readsOf();
    expect(verdictOf(state, reads, () => true)).toMatchObject({ idle: true });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources, presenceChannelHealthy: () => true });
    if (ran.code !== 0) throw new Error(`run failed: ${ran.code} ${ran.err} ${ran.out}`);
    expect(world.did.closed).toEqual(['ws-old']);
    expect(world.did.typed.length).toBeGreaterThan(0);
    expect(queue()).toEqual({});
  });

  test('a seat with no projection keeps the labelled screen boundary', async () => {
    await prepared();
    const reads = await readsOf();
    expect(verdictOf(sessionOf(), reads, () => true)).toMatchObject({ idle: false, reason: 'fallback-absent' });
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: later,
      presenceChannelHealthy: () => true,
    });
    if (ran.code !== 0) throw new Error(`run failed: ${ran.code} ${ran.err} ${ran.out}`);
    expect(ran.out).toContain('swapped: worker in pane-new-1 (read-back unread)');
    expect(queue()).toEqual({});
  });

  test('an explicit force still runs a seat the native proof holds', async () => {
    await prepared();
    await apply('turn-start', iso(10 * 60_000), { id: `${iso(10 * 60_000)}-dddddddd` });
    const state = sessionOf();
    const reads = await readsOf();
    expect(verdictOf(state, reads, () => true)).toMatchObject({ idle: false, reason: 'working' });
    const world = fakeHerdr();
    const forced = await swap(['now', 'worker'], OWNER, {
      sources: world.sources,
      presenceChannelHealthy: () => true,
    });
    if (forced.code !== 0) throw new Error(`force failed: ${forced.code} ${forced.err} ${forced.out}`);
    expect(world.did.typed.length).toBeGreaterThan(0);
    expect(queue()).toEqual({});
  });
});
