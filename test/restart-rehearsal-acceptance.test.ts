// A machine restart rehearsed end to end, for the Claude seats' channel push. Before the
// restart every seat ran from its launch line, with the development-channel flag. The terminal
// host then resumed each seat's conversation in its own pane without that line, as herdr does,
// while each seat's inbox server still declares the channel. The daemon's restore sweep runs
// over the real `team up` pass, the real relaunch and reach check, and the real `team restart`,
// against a fake terminal host and process table. Then a send goes to each seat, and the clock
// passes the reach bound. The test fails when any Claude seat is left counted as a channel push
// it does not have:
//   (a) each idle restored seat except the entity's main orchestrator is restarted through its
//       launch line (the channel flag and --resume with its own conversation), one at a time;
//   (b) a seat working, or holding unsent text, is not touched until it is idle and empty;
//   (c) after the sweep a send walks the channel only to a relaunched seat; the orchestrator's
//       send skips it and says why (the honest fallback: the stored copy and the pointer);
//   (d) the owner's line names `team restart <orchestrator> --resume <its conversation>`;
//   (e) a relaunched seat still unproven past the bound is said once to the lead as unreachable,
//       and `team doctor` fails it.
// Synthetic throughout: no live herdr, no live process, no live send.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import * as send from '../src/commands/send.ts';
import type { Launch, UpSources } from '../src/commands/up.ts';
import { listenerKeyOf, proveOffer } from '../src/comms/offer.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { runRestoreSweepForRoute, type RestoreSweepResult } from '../src/launch/restore-sweep.ts';
import type { RestoreRelaunchDeps } from '../src/launch/restore-relaunch.ts';
import { inboxLive, writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import { pendingProbe, placeChannelProbe } from '../src/queue/channel-probe.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { takeCopyNumber } from '../src/queue/handover.ts';
import { seatDropDir, seatMailDirIn } from '../src/queue/mail-tree.ts';
import { CHANNEL_OVERDUE_MS, channelUnproven } from '../src/queue/resend.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { writeRuntimeNotice } from '../src/send/endpoint-notice.ts';
import { beginSession } from '../src/sessions/registry.ts';
import { readState, type SeatState } from '../src/state.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import type { Machine } from '../src/watch/machine.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';
import { registerDefaultChannelFixture } from './helpers/default-channel.ts';
import { fake, quietNative } from './send-native-fixtures.ts';

const SESSION = 'drill';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const LINE = `claude --model claude-opus-5-5 ${FLAG}`;
const UNSENT = readFileSync(new URL('./fixtures/claude-code/2.1.289/unsent-typed-ansi.txt', import.meta.url), 'utf8');
const CALM: Machine = { loadPerCore: 0.2, memoryFree: 60, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9 };
/** Process ids past any real pid limit: a read that reaches the machine's own table finds none. */
const P = 50_000_000;
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };

/** The six Claude seats: the entity's main orchestrator (in the owner's pane), the team's other
 *  lead (its operator, a lead that is not the entity's main orchestrator), two ordinary seats, one
 *  working when the host came back, one holding unsent text. Every one declares the channel flag
 *  on its launch line. */
const SEATS = ['boss', 'lead2', 'worker-a', 'worker-b', 'busy', 'drafty'] as const;
type Name = typeof SEATS[number];
const RELAUNCHED: readonly Name[] = ['lead2', 'worker-a', 'worker-b', 'busy', 'drafty'];

function teamText(root: string): string {
  const seat = (name: Name, role: string, extra = ''): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${LINE}
${extra}`;
  return `format: 1
project: drill
entity: drill
coordinator: boss
operator: lead2
session: ${SESSION}
trust:
  - ~/.config/team/lobbies/drill
  - ${root}
workspace:
  mode: shared
seats:
${seat('boss', 'coordinator')}${seat('lead2', 'operator')}${seat('worker-a', 'implementer')}${seat('worker-b', 'implementer')}${seat('busy', 'implementer')}${seat('drafty', 'implementer')}`;
}

let base: string;
let root: string;
let home: string;
let dir: string;
let teamFile: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restart-rehearsal-')));
  root = join(base, 'drill');
  home = join(base, 'home');
  dir = join(root, '.agents');
  teamFile = join(dir, 'team.yaml');
  // The project folder carries a channel pair, which the product refuses in a group- or
  // world-writable folder; the mode is stated so a umask of 002 (common on Linux) does not decide it.
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(teamFile, teamText(root));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** One pane of the fake terminal host. */
type Pane = { pane: string; workspace: string; name: string | null; status: string; screen: string; shell: number; cli: number; session: string | null; box?: string };

type World = {
  clock: number;
  panes: Map<string, Pane>;
  /** Every `team restart` the sweep ran, its words and the line typed into the new pane. */
  restarts: { argv: string[]; exit: number; said: string }[];
  ran: { pane: string; command: string }[];
  closed: string[];
  /** The most restarts in flight at once. */
  overlap: number;
  inFlight: number;
  probes: string[];
  notices: { lead: string; body: string; id: string }[];
  next: number;
  /** Each pid's birth (ms) and parent, as the process table reads them. */
  births: Map<number, number>;
  parents: Map<number, number>;
};

const conv = (name: string): string => `conv-${name}`;

/** `unprovable`: seats whose resumed process has no readable birth, so the restart rebind's
 *  proof refuses them and the restore pass leaves their pre-restart record as it was. */
function makeWorld(unprovable: readonly Name[] = []): World {
  const panes = new Map<string, Pane>();
  const clock = Date.now();
  const births = new Map<number, number>();
  const parents = new Map<number, number>();
  SEATS.forEach((name, at) => {
    // Before the restart: the launch line's shell and CLI, an hour ago. After it: the host's own.
    births.set(P + 100 + at, clock - 3_600_000);
    births.set(P + 200 + at, clock - 3_599_000);
    if (!unprovable.includes(name)) {
      births.set(P + 700 + at, clock - 60_000);
      births.set(P + 800 + at, clock - 59_000);
    }
    parents.set(P + 800 + at, P + 700 + at);
    // The host restored each pane and resumed its conversation: a new shell and CLI, not the ones
    // the launch line started, and no development-channel flag on the process.
    panes.set(`p-${name}`, {
      pane: `p-${name}`, workspace: `ws-${name}`, name, status: name === 'busy' ? 'working' : 'idle',
      screen: name === 'drafty' ? UNSENT : CLAUDE_IDLE, shell: P + 700 + at, cli: P + 800 + at, session: conv(name),
    });
  });
  return { clock, panes, restarts: [], ran: [], closed: [], overlap: 0, inFlight: 0, probes: [], notices: [], next: 0, births, parents };
}

/** The record each seat had before the restart: ready, launched through its line, its conversation. */
/** `leadPair: false` leaves the project folder without lead2's channel pair: its restart then
 *  launches without the channel flag. */
function recordBeforeRestart(w: World, leadPair = true): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(`the drill team does not load: ${JSON.stringify(loaded.errors)}`);
  const seats: Record<string, SeatState> = {};
  SEATS.forEach((name, at) => {
    seats[name] = {
      stage: 'ready', pane: `p-${name}`, workspace: `ws-${name}`, cli: 'claude-code',
      launched: { shell: P + 100 + at, cli: [P + 200 + at], cli_start: [w.births.get(P + 200 + at)!] }, pane_shell: P + 100 + at,
      pane_shell_start: w.births.get(P + 100 + at)!, agent_session: conv(name), channel_launch: true,
    } as SeatState;
    const seat = loaded.team.seats.find((one) => one.name === name)!;
    registerAgent(home, {
      name, signing: { model: 'Claude Opus', version: '5.5', role: seat.role }, lab: 'anthropic', cli: 'claude-code', launcher: null, launch: LINE,
      reach: { team: teamIdOf(root), seat: name, session: SESSION, pane: `p-${name}`, address: null, agent_session: conv(name) },
      mcp: [], skills: [], lifecycle: 'running', by: 'team up',
    });
    beginSession({ home, root, team: loaded.team, session: SESSION, seat, pane: `p-${name}`, workspace: `ws-${name}`, cli_session: conv(name), now: new Date(w.clock - 3_600_000) });
  });
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify({ format: 1, sessions: { [SESSION]: { seats, worktrees: {} } } }));
  // The team's registry row (one root, its roster and lobby) and the project folder's channel
  // pair for the lead that runs there and is restarted from here.
  registerDefaultChannelFixture(root, home, leadPair ? 'lead2' : undefined);
  upsertTeam(home, teamIdOf(root), { lifecycle: 'running', by: 'owner' });
}

const LISTENED_AT = new Date().toISOString();
const LISTENER = (name: string): InboxListener => ({ v: 1, seat: name, session: SESSION, root, cli: 'claude-code', pid: process.pid, ts: LISTENED_AT, channel: true, level: 3 });

/** Each seat's inbox server, started by the resumed CLI: live, and declaring the channel. */
function listenersUp(): void {
  for (const name of SEATS) {
    const drop = seatMailDirIn(dir, SESSION, name);
    mkdirSync(drop, { recursive: true, mode: 0o700 });
    expect(writeListener(drop, LISTENER(name))).toBe(true);
  }
}

function keyOf() {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('no message key');
  return state.key;
}

/** A relaunched seat's server answers the channel proof probe the reach check placed: it pushes
 *  the probe with an offer, and the seat acks it. */
function proveChannel(name: string, w: World): void {
  const drop = seatMailDirIn(dir, SESSION, name);
  const listener = listenerKeyOf(LISTENER(name));
  const id = pendingProbe({ root, session: SESSION, seat: name, key: keyOf(), listenerKey: listener, nowMs: w.clock, lead: 'boss' });
  expect(id, `${name} has a channel proof probe waiting`).not.toBeNull();
  const token = 'b'.repeat(32);
  expect(takeCopyNumber(seatMailDirIn(dir, SESSION, name, 'stamped'), id!, 'channel', w.clock, { token, listener })).not.toBeNull();
  expect(publishRecordRead({ dropDir: drop, id: id!, to: name, root, session: SESSION, home, key: keyOf(), at: new Date(w.clock).toISOString(), readBy: 'channel' }).kind).toBe('published');
  expect(proveOffer(drop, id!, token, listener, { root, session: SESSION, seat: name, key: keyOf() }, w.clock)).not.toBeNull();
}

const agentsOf = (w: World): HerdrAgent[] => [...w.panes.values()].map((one) => ({
  name: one.name, agent: 'claude', pane: one.pane, workspace: one.workspace, status: one.status, cwd: root, ...(one.session === null ? {} : { session: one.session }),
}));

function doctorSources(w: World): DoctorSources {
  return {
    version: () => '2.1.288', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1',
    sessionRunning: () => true, now: () => new Date(w.clock), home,
  };
}

/** The fake terminal host's launch side: panes created, lines run in them, workspaces closed. */
function launchOf(w: World): Launch {
  return {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const n = ++w.next;
      const made: Pane = { pane: `p-new-${String(n)}`, workspace: `ws-new-${String(n)}`, name: null, status: 'idle', screen: '', shell: P + 900 + n, cli: 0, session: null };
      w.births.set(made.shell, w.clock);
      w.panes.set(made.pane, made);
      void label;
      return { pane: made.pane, workspace: made.workspace };
    },
    paneRun(_session, pane, command) {
      w.ran.push({ pane, command });
      const one = w.panes.get(pane);
      if (one !== undefined) {
        one.cli = one.shell + 1000;
        w.births.set(one.cli, w.clock);
        w.parents.set(one.cli, one.shell);
        one.screen = CLAUDE_IDLE;
        const resumed = /--resume\s+(\S+)/.exec(command);
        one.session = resumed?.[1] ?? null;
      }
      return true;
    },
    renameAgent(_session, pane, name) {
      const one = w.panes.get(pane);
      if (one !== undefined) one.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      w.closed.push(workspace);
      for (const [id, one] of w.panes) if (one.workspace === workspace) w.panes.delete(id);
      return true;
    },
    agentPanes: () => [...w.panes.values()].filter((one) => one.cli !== 0).map((one) => one.pane),
    agents: () => agentsOf(w).filter((one) => w.panes.get(one.pane)!.cli !== 0),
    workspacePanes: (_session, workspace) => [...w.panes.values()].filter((one) => one.workspace === workspace).map((one) => one.pane),
    paneText: (_session, pane) => w.panes.get(pane)?.screen ?? null,
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: (_session, pane) => w.panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => (w.panes.get(pane)?.cli ? ['claude'] : ['zsh']),
    processInfo: (_session, pane): PaneProcesses | null => {
      const one = w.panes.get(pane);
      if (one === undefined) return null;
      return one.cli === 0 ? { shell: one.shell, foreground: [one.shell] } : { shell: one.shell, foreground: [one.cli] };
    },
    processStartOf: (pid) => w.births.get(pid) ?? null,
    processParent: (pid) => {
      const ppid = w.parents.get(pid);
      const birth = w.births.get(pid);
      return ppid === undefined || birth === undefined ? null : { pid, ppid, birth };
    },
    sleep: async (ms) => { w.clock += ms; },
    now: () => new Date(w.clock),
  } as Launch;
}

function upSources(w: World): UpSources {
  const launch = launchOf(w);
  return {
    home,
    now: () => new Date(w.clock),
    sleep: launch.sleep,
    machine: () => CALM,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => launch.agents(SESSION),
    workspaces: (): HerdrWorkspace[] => [...w.panes.values()].map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    launch,
    doctor: doctorSources(w),
  };
}

/** `team restart`'s own world over the same fake host. */
function restartSources(w: World): RestartSources {
  const upLaunch = launchOf(w);
  // The stop types the CLI's exit into an empty box; the Enter takes the pane back to its shell.
  const downLaunch: DownLaunch = {
    typeText: (_session, pane, text) => {
      const one = w.panes.get(pane);
      if (one !== undefined) one.box = text;
      return true;
    },
    sendKey: () => true,
    pressEnter: (_session, pane) => {
      const one = w.panes.get(pane);
      if (one !== undefined) {
        one.cli = 0;
        one.box = undefined;
        one.screen = '';
        one.session = null;
      }
      return true;
    },
    agentPanes: upLaunch.agentPanes,
    closeWorkspace: upLaunch.closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => new Date(w.clock),
  };
  return {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => agentsOf(w),
    workspaces: () => [...w.panes.values()].map((one) => ({ id: one.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => claudeBox(w.panes.get(pane)?.box ?? ''),
    status: () => 'idle',
    foreground: upLaunch.foreground,
    now: () => new Date(w.clock),
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor: doctorSources(w),
    machine: () => CALM,
  } as RestartSources;
}

/** The relaunch's wiring as the daemon builds it (restore-sweep.ts realRelaunchDeps): the real
 *  restart command, channel proof, probe and lead notice, over the fake host and the test clock. */
function relaunchDeps(w: World): RestoreRelaunchDeps {
  const lead = 'boss';
  return {
    restart: async (argv, io: Io) => {
      w.inFlight += 1;
      w.overlap = Math.max(w.overlap, w.inFlight);
      try {
        const said: string[] = [];
        const exit = await runRestart(argv, { ...io, stdout: (text) => { said.push(text); io.stdout(text); }, stderr: (text) => { said.push(text); io.stderr(text); } }, restartSources(w));
        w.restarts.push({ argv, exit, said: said.join('') });
        return exit;
      } finally {
        w.inFlight -= 1;
      }
    },
    unproven: (seat) => channelUnproven({
      dropDir: seatDropDir(root, SESSION, seat), root, session: SESSION, seat,
      context: { to: seat, root, session: SESSION, lead }, key: keyOf(), nowMs: w.clock,
    }),
    probe: (seat) => {
      w.probes.push(seat);
      const live = inboxLive(seatDropDir(root, SESSION, seat), root, SESSION, seat);
      if (!live.live || live.listener.channel !== true) return;
      const listenerKey = listenerKeyOf(live.listener);
      if (pendingProbe({ root, session: SESSION, seat, key: keyOf(), listenerKey, nowMs: w.clock, lead }) !== null) return;
      placeChannelProbe({ home, root, session: SESSION, seat, listenerKey, now: new Date(w.clock) });
    },
    notify: (one) => {
      w.notices.push(one);
      return writeRuntimeNotice({ home, root, session: SESSION, lead: one.lead, id: one.id, body: one.body, at: new Date(w.clock).toISOString() }).ok;
    },
  };
}

async function approve(w: World): Promise<void> {
  const code = await runApprove(['--file', teamFile], testIo(root, { kind: 'owner' }), {
    ask: async () => '5', waiting: () => 'empty', now: () => new Date(w.clock), home,
  });
  expect(code).toBe(0);
}

const sweep = (w: World): Promise<RestoreSweepResult> => runRestoreSweepForRoute({
  home, root, teamFile, sources: upSources(w), relaunchDeps: relaunchDeps(w),
});

const held = (name: string): SeatState | undefined => readState(dir).sessions[SESSION]?.seats[name];

/** The tail of every send id here: the orchestrator's stored copy is found by it. */
const SEND_TAIL = '-0000-4000-8000-000000005e4d';

type Leg = { leg: string; state: string; reason?: string };

/** One owner send to the seat, as JSON: its walked legs and its message. */
async function sendTo(w: World, name: string): Promise<{ legs: Leg[]; text: string }> {
  const io = testIo(root, { kind: 'owner' });
  const host = fake({ root, dir, sockets: join(base, 'sockets'), home, cleanup: () => {} }, {
    agents: () => [...w.panes.values()].filter((one) => one.name !== null).map((one) => ({ name: one.name!, pane: one.pane, cli: 'claude' })),
    processInfo: (pane: string) => {
      const one = w.panes.get(pane);
      return one === undefined ? null : { shell: one.shell, foreground: [one.cli] };
    },
    native: quietNative(),
    sendId: () => `${String(++w.next).padStart(8, '0')}${SEND_TAIL}`,
    channelGraceMs: 0,
    now: () => new Date(w.clock),
  } as Partial<send.SendHost>);
  await send.runSend([name, `hello ${name}`, '--json'], io, host);
  const text = io.out.trim() === '' ? io.err : io.out;
  const doc = JSON.parse(text) as { delivery?: Leg[] };
  return { legs: doc.delivery ?? [], text };
}

const fromPane = (w: World, name: Name): Pane => [...w.panes.values()].find((one) => one.name === name)!;
const restartsOf = (w: World): string[] => w.restarts.map((one) => one.argv[0]!);
const noticesFor = (w: World, text: string) => w.notices.filter((one) => one.body.includes(text));

describe('a machine restart, rehearsed: every Claude seat ends with a working push or an honest fallback', () => {
  test('relaunch through the launch line one at a time, never the orchestrator or a busy pane; honest sends; one unreachable report', async () => {
    mkdirSync(join(base, 'sockets'), { recursive: true });
    const w = makeWorld();
    messageKeyOf(home);
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    recordBeforeRestart(w);
    listenersUp();
    await approve(w);
    const before = new Map(SEATS.map((name) => [name, { ...fromPane(w, name) }]));

    // Pass 1, right after the restart.
    const first = await sweep(w);
    expect(first.kind, JSON.stringify(first)).toBe('ran');
    if (first.kind !== 'ran') return;
    // (a) The idle seats, in roster order, each through `team restart <seat> --resume <its own
    // conversation>`, never two at once; each new pane runs the declared line with the flag.
    expect(restartsOf(w)).toEqual(['lead2', 'worker-a', 'worker-b']);
    expect(w.overlap).toBe(1);
    for (const one of w.restarts) {
      const name = one.argv[0]!;
      expect(one.exit, one.said).toBe(0);
      expect(one.argv.slice(0, 4)).toEqual([name, '--resume', conv(name), '--session']);
      const ran = w.ran.filter((run) => run.command.includes(`--name ${name} `));
      expect(ran).toHaveLength(1);
      expect(ran[0]!.command).toContain(`claude --model claude-opus-5-5 ${FLAG} --resume ${conv(name)} `);
      expect(held(name)?.channel_launch).toBe(true);
      expect(held(name)?.agent_session).toBe(conv(name));
      expect(first.summary.line).toContain(`${name}: relaunched through its launch line with its conversation ${conv(name)}`);
    }
    // The restore re-tie recorded every pane the host resumed as carrying no channel flag.
    for (const name of ['boss', 'busy', 'drafty'] as const) {
      expect(held(name)?.channel_launch, name).toBe(false);
      expect(held(name)?.launched?.cli).toEqual([before.get(name)!.cli]);
    }
    // (d) The orchestrator in the owner's pane is not restarted: the owner is named the restart.
    expect(first.summary.line).toContain('boss: restored without its launch line, so its channel push is off');
    expect(first.summary.line).toContain('the owner approves `team restart boss --resume conv-boss`');
    expect(noticesFor(w, 'team restart boss --resume conv-boss')).toHaveLength(1);
    expect(noticesFor(w, 'team restart boss --resume conv-boss')[0]!.lead).toBe('boss');
    // (b) The working seat and the one holding unsent text are left exactly as they were.
    expect(first.retry).toBe('load');
    expect(first.detail).toContain('busy is not idle at an empty prompt; relaunched on a later pass');
    expect(first.detail).toContain('drafty is not idle at an empty prompt; relaunched on a later pass');
    for (const name of ['boss', 'busy', 'drafty'] as const) {
      expect(fromPane(w, name)).toEqual(before.get(name)!);
      expect(w.closed).not.toContain(`ws-${name}`);
    }
    // The reach check asked each relaunched seat's server for its proof.
    expect(w.probes).toEqual(['lead2', 'worker-a', 'worker-b']);

    // Pass 2, ten seconds on: lead2 and worker-a have proven their channel; busy still works and
    // drafty still holds its text. Nothing new is restarted and the owner is not told twice.
    proveChannel('lead2', w);
    proveChannel('worker-a', w);
    w.clock += 10_000;
    const second = await sweep(w);
    expect(second.kind).toBe('ran');
    expect(restartsOf(w)).toHaveLength(3);
    expect(fromPane(w, 'busy')).toEqual(before.get('busy')!);
    expect(fromPane(w, 'drafty')).toEqual(before.get('drafty')!);
    expect(noticesFor(w, 'owner approves')).toHaveLength(1);

    // Pass 3: both are idle at an empty prompt now, and each comes back the same way, one at a time.
    fromPane(w, 'busy').status = 'idle';
    fromPane(w, 'drafty').screen = CLAUDE_IDLE;
    w.clock += 10_000;
    const third = await sweep(w);
    expect(third.kind).toBe('ran');
    expect(restartsOf(w)).toEqual(['lead2', 'worker-a', 'worker-b', 'busy', 'drafty']);
    expect(w.overlap).toBe(1);
    for (const name of ['busy', 'drafty'] as const) {
      expect(w.ran.filter((run) => run.command.includes(`--name ${name} `))[0]!.command).toContain(`${FLAG} --resume ${conv(name)} `);
      expect(held(name)?.channel_launch).toBe(true);
    }
    proveChannel('busy', w);
    proveChannel('drafty', w);

    // (e) Past the bound, worker-b never proved its channel: said once to the lead, never twice,
    // and not restarted again.
    w.clock += CHANNEL_OVERDUE_MS;
    const fourth = await sweep(w);
    if (fourth.kind !== 'ran') throw new Error(JSON.stringify(fourth));
    expect(fourth.summary.line).toContain('worker-b: unreachable after restore: unproven since launch');
    expect(fourth.retry).toBeUndefined();
    const fifth = await sweep(w);
    if (fifth.kind !== 'ran') throw new Error(JSON.stringify(fifth));
    expect(fifth.summary.line).not.toContain('unreachable after restore');
    expect(noticesFor(w, 'unreachable after restore')).toEqual([
      { lead: 'boss', body: 'worker-b: unreachable after restore: unproven since launch', id: expect.any(String) },
    ]);
    expect(restartsOf(w)).toHaveLength(5);
    // Each notice is a signed record in the lead's inbox, once.
    const leadInbox = seatDropDir(root, SESSION, 'boss');
    for (const one of w.notices) expect(existsSync(join(leadInbox, one.id)), one.body).toBe(true);

    // `team doctor` fails worker-b, and the orchestrator still unrestarted; no proven seat.
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', teamFile], io, doctorSources(w));
    const doctorText = `${io.out}${io.err}`;
    const misses = doctorText.split('\n').filter((line) => line.startsWith('MISS') && line.includes('unreachable after restore'));
    expect(misses).toEqual([
      'MISS  boss: unreachable after restore: not started from its launch line',
      'MISS  worker-b: unreachable after restore: unproven since launch',
    ]);
    for (const name of ['lead2', 'worker-a', 'busy', 'drafty']) expect(doctorText).not.toMatch(new RegExp(`(MISS|warn) +${name}: `));

    // (c) A send to each seat now: the channel is walked for every relaunched seat; the
    // orchestrator's send skips it and says why, and its copy waits in its inbox for the pointer.
    for (const name of RELAUNCHED) {
      const sent = await sendTo(w, name);
      const channel = sent.legs.find((leg) => leg.leg === 'channel');
      expect(channel, `${name}: ${sent.text}`).toBeDefined();
      expect(channel!.reason, name).not.toBe(send.CHANNEL_FLAG_DROPPED);
      expect(channel!.reason, name).toBe('no push receipt within 0 ms');
      expect(sent.text).not.toContain('not a working push');
    }
    const orchestrator = await sendTo(w, 'boss');
    expect(orchestrator.legs.find((leg) => leg.leg === 'channel')).toEqual({ leg: 'channel', state: 'skipped', reason: send.CHANNEL_FLAG_DROPPED });
    expect(orchestrator.legs.find((leg) => leg.leg === 'drop')?.state).toBe('attempted');
    expect(orchestrator.text).toContain('its channel is not a working push: the process in its pane was not started from its launch line');
    expect(readdirSync(seatMailDirIn(dir, SESSION, 'boss', 'stamped')).some((one) => one.endsWith(SEND_TAIL))).toBe(true);
  });

  test('a seat the rebind could not prove is still taken; a restart without the flag is not called one through the line', async () => {
    mkdirSync(join(base, 'sockets'), { recursive: true });
    // boss and worker-a come back with no readable process birth: the rebind refuses both, and
    // their records still name the pre-restart launch with the channel flag on. lead2's folder
    // has no channel pair, so its restart launches without the flag.
    const w = makeWorld(['boss', 'worker-a']);
    messageKeyOf(home);
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    recordBeforeRestart(w, false);
    listenersUp();
    await approve(w);

    const first = await sweep(w);
    if (first.kind !== 'ran') throw new Error(JSON.stringify(first));
    // The seat whose rebind failed is relaunched like the others, with its own conversation.
    expect(restartsOf(w)).toEqual(['lead2', 'worker-a', 'worker-b']);
    expect(w.ran.find((run) => run.command.includes('--name worker-a '))?.command).toContain(`${FLAG} --resume conv-worker-a `);
    expect(held('worker-a')?.channel_launch).toBe(true);
    // The orchestrator the rebind could not prove: not restarted, the owner named the restart,
    // and a send routes around its channel.
    expect(first.summary.line).toContain('the owner approves `team restart boss --resume conv-boss`');
    expect(held('boss')?.channel_launch).toBe(false);
    const orchestrator = await sendTo(w, 'boss');
    expect(orchestrator.legs.find((leg) => leg.leg === 'channel')).toEqual({ leg: 'channel', state: 'skipped', reason: send.CHANNEL_FLAG_DROPPED });
    // lead2 restarted, but its new process carries no channel flag: not said as through its line.
    expect(held('lead2')?.channel_launch).toBe(false);
    expect(first.summary.line).not.toContain('lead2: relaunched through its launch line');
    expect(first.summary.line).toContain('lead2: restarted with its conversation conv-lead2, but its new process carries no channel flag');
    // The reach check takes it from there: past the bound it is said once as unreachable, and it
    // is not restarted again.
    w.clock += CHANNEL_OVERDUE_MS + 1_000;
    const late = await sweep(w);
    if (late.kind !== 'ran') throw new Error(JSON.stringify(late));
    expect(late.summary.line).toContain('lead2: unreachable after restore: not started from its launch line');
    await sweep(w);
    expect(noticesFor(w, 'lead2: unreachable after restore')).toHaveLength(1);
    expect(restartsOf(w).filter((one) => one === 'lead2')).toHaveLength(1);
  });
});
