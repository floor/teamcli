// One run per row of contract/exit-codes.json. Each trigger is a temporary directory and the
// injectable stand-ins the other command tests use: no herdr session, no user-level store.
import { seatOwner } from './helpers/owner-seat.ts';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, describe } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { startBroker } from '../src/broker/server.ts';
import { saveReadings, type Seen } from '../src/budgets/readings.ts';
import type { Caller } from '../src/caller.ts';
import type { CheckSources } from '../src/check/team.ts';
import { clientKeyDir, newClientKeyPair, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runArchive, writeArchive } from '../src/commands/archive.ts';
import { runAskShow } from '../src/commands/ask-show.ts';
import { runApprove, type ApproveSources, type Waiting } from '../src/approve/command.ts';
import { runBroker, type BrokerSources } from '../src/commands/broker.ts';
import { runBrief } from '../src/commands/brief.ts';
import { runBus, type BusCommandSources } from '../src/commands/bus.ts';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import type { DaemonHealthSnapshot } from '../src/daemon/protocol.ts';
import { FAULT_WHY, faultRequestPath, faultResultPath, writeFaultRequest } from '../src/daemon/fault.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { routeId, routeOf } from '../src/daemon/routes.ts';
import { writeDaemonState, type DaemonRootState } from '../src/daemon/state.ts';
import runPresenceHook from '../src/daemon/presence/hook.ts';
import type { ServiceManager } from '../src/daemon/service.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { check, loadConfig, type LoadConfig } from '../src/commands/check.ts';
import { runClient } from '../src/commands/client.ts';
import { commits } from '../src/commands/commits.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runDrops } from '../src/commands/drops.ts';
import { runFeed } from '../src/commands/feed.ts';
import { realSources, runMcp, type McpSources } from '../src/commands/mcp.ts';
import { runInit } from '../src/commands/init.ts';
import { runRoute } from '../src/commands/route.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { pendingPath } from '../src/send/pending.ts';
import { plantMessage, plantRecord, recordDir, runMessages, type MessagePayload } from '../src/commands/messages.ts';
import { clientInboxFolder } from '../src/client/inbox.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { runIssues } from '../src/commands/issues.ts';
import { runList, type ListSources } from '../src/commands/list.ts';
import { runLock } from '../src/commands/lock.ts';
import { runUnlock } from '../src/commands/unlock.ts';
import { runTempo } from '../src/commands/tempo.ts';
import { runHold } from '../src/commands/hold.ts';
import { runRaise } from '../src/commands/raise.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runAck } from '../src/commands/ack.ts';
import { runDevelopmentMode } from '../src/commands/development-mode.ts';
import { runOwnerSeat } from '../src/commands/owner-seat.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runNext } from '../src/commands/next.ts';
import { runPause } from '../src/commands/pause.ts';
import { runPlan } from '../src/commands/plan.ts';
import { runQueue } from '../src/commands/queue.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { pr } from '../src/commands/pr.ts';
import { runProc, type ProcSources } from '../src/commands/proc.ts';
import { runProjects, type ProjectSources, type ProjectView } from '../src/commands/projects.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { runReply } from '../src/commands/reply.ts';
import { runResume } from '../src/commands/resume.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runRename } from '../src/commands/rename.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runSeats, type SeatsSources } from '../src/commands/seats.ts';
import { runSeat } from '../src/commands/seat.ts';
import { runSessions } from '../src/commands/sessions.ts';
import { runConfig } from '../src/commands/config.ts';
import { runSettings, type SettingsCommandOptions } from '../src/commands/settings.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runSwap } from '../src/commands/swap.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runUsage } from '../src/commands/usage.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { runWorkflow } from '../src/commands/workflow.ts';
import { runWorktree, type WorktreeSources } from '../src/commands/worktree.ts';
import { main, reportFailure, version } from '../src/cli.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { delegateGate, type DelegateSources } from '../src/delegate.ts';
import { listFolder } from '../src/file/landing.ts';
import { findRoot, loadTeamFile } from '../src/file/load.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { grantGate, type GrantSources } from '../src/grant.ts';
import { defaultFs, lobbyDir } from '../src/lobby/gate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { acquireRunLock } from '../src/launch/run-lock.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lockDirectory, type LockIdentity, type LockSources } from '../src/lock/machine.ts';
import type { Key, Terminal } from '../src/launch/terminal.ts';
import { writeGrant } from '../src/permissions/grants.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { overridesPath } from '../src/profiles/overrides.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { projectsFile, ProjectsError } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { installKey, keyOf, MESSAGE_DOMAIN, messageKeyOf, signDomain } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { analyze, loadContract, problems, render, type ExitRow } from '../scripts/exit-codes.ts';
import { runRelease } from '../src/commands/release.ts';
import type { KeyReader } from '../src/release/keychain.ts';
import { leadPart, outsidePart, scenePart, skipsScene, unknownScenes, wantedScenes } from './exit-filter.ts';
import { fakeFetch, fixture, happy, json, URLS, type Answers } from './release/world.ts';
import { runImport } from '../src/commands/import.ts';
import { intoRegistry, realRegistryTouched, storedTeam, underRegistry } from './helpers/registry-team.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { CLAUDE_IDLE, claudeBox, deliverBriefs, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const owner = { kind: 'owner' } as const;
const detachedCaller = { kind: 'owner-no-tty' } as const;
const other = { kind: 'seat', name: 'other', pane: 'w9:p1' } as const;
const leadSeat = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const hot: Machine = { ...fine, loadPerCore: 9 };
const quiet: Live = { running: false, agents: [], workspaces: [], screens: {} };
const IDLE = CLAUDE_IDLE;

const LEAD = `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const WORKER = `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${LEAD}# The send scenes on this file walk the typed trigger: the inbox is tried and skipped for
# want of a listener, then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;

const TWO = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${LEAD}${WORKER}`;

const BUDGET = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${LEAD}  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: openai
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

const CHECKED = `format: 1
project: acme
coordinator: lead
operator: lead
identity:
  humans: [test@example.com]
workspace:
  mode: shared
seats:
${LEAD}`;

/** The body signature CHECKED's lead seat writes: `**Agent:** {display} · {role}`. */
const PR_BODY = '**Agent:** Claude Opus 5.5 · coordinator';

const CHECK_ACCOUNT = `${TEAM}budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [check], check: team-exit-no-such-check }
`;

const WITH_BASE = TEAM.replace('  mode: shared\n', '  mode: shared\n  base: main\n');

function narrow(place: Place): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${place.root}
  - ${join(place.base, 'worktrees', 'acme')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [., live]
seats:
${LEAD}${WORKER.replace('    stopped: true\n', '    cwd: live\n')}`;
}

type Place = { base: string; root: string; home: string; file: string };
type Ran = { code: number; out: string; err: string };
type Scene = (place: Place) => Promise<Ran>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function layout(repo: boolean): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-exit-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  if (repo) {
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'acme\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'first');
  }
  return { base, root, home, file: join(root, '.agents', 'team.yaml') };
}

function write(place: Place, text: string): void {
  writeFileSync(place.file, text);
}

function approve(place: Place, text: string): void {
  const fileText = text.includes('trust:') ? text : text.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${place.root}\nworkspace:\n`);
  write(place, fileText);
  const loaded = loadTeamFile(place.root, { file: place.file, home: place.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, place.home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: fileText },
    loaded.team.seats,
    place.home,
    NOW,
  );
}

function approvalFile(place: Place): string {
  const loaded = loadTeamFile(place.root, { file: place.file, home: place.home });
  if (!loaded.ok) throw new Error('team file');
  return join(storePath(loaded.team.project, loaded.root, place.home), 'approval.json');
}

function editApproval(place: Place, edit: (record: Record<string, unknown>) => void): void {
  const path = approvalFile(place);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

function doctor(home: string, over: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...over,
  };
}

function launching(text: string, paneOk: (command: string) => boolean = () => true, server = true): Launch {
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { text: string; agent: boolean }>();
  return {
    sessionState: () => session,
    startServer() {
      if (!server) return false;
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.set(pane, { text, agent: false });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      if (!paneOk(command)) return false;
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
}

function addSources(place: Place, over: Partial<AddSources> = {}): AddSources {
  return {
    home: place.home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(place.home),
    now: () => NOW,
    launch: launching(IDLE),
    ...over,
  };
}

function downLaunch(over: Partial<DownLaunch> = {}): DownLaunch {
  return {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => [],
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
    ...over,
  };
}

function downSources(over: Partial<RemoveSources> = {}): RemoveSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    home: undefined,
    ...over,
  };
}

/** The owner's terminal for `up` scenes: the pause reads its keys here, and `reads` is the proof
 *  it asked. A scene must never fall through to the test process's own stdin, whose state is its
 *  invoker's — under `bun test` stdin is inherited by the whole run, and a pipe left open never
 *  delivers the end a scene would need. No test may reach the pause without queueing what the
 *  terminal does next: a silent fallback would hide an unexpected prompt. */
function ownerTerminal(keys: Key[] = []): Terminal & { reads: number } {
  const terminal = {
    reads: 0,
    async key(): Promise<Key> {
      terminal.reads += 1;
      const next = keys.shift();
      if (next === undefined) throw new Error('the pause read the terminal, and no key was queued');
      return next;
    },
    // Nothing is buffered behind this terminal: the pause's drains have nothing to discard.
    drain(): void {},
  };
  return terminal;
}

function upSources(place: Place, over: Partial<UpSources> = {}): UpSources {
  return { sessionRunning: () => false, agents: () => [], home: place.home, now: () => NOW, terminal: () => ownerTerminal(), ...over };
}

function watchSources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => quiet,
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    sleep: async () => {},
    pressEnter: () => false,
    notify: () => {},
    now: () => NOW,
    wait: async () => false,
    alive: () => false,
    pid: 1,
    ...over,
  };
}

function statusSources(live: Live | null, standing: Standing = { kind: 'none' }): StatusSources {
  return {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
  };
}

// The two teams of the fixture project, by team ID: the ID a team record is stored under and the
// ID a project's own `teams` list names.
const TEAM_A = '1a2b3c4d5e6f';
const TEAM_B = '6f5e4d3c2b1a';

const PROJECTS: ProjectView[] = [
  {
    id: '4f2a1b7c9d0e',
    name: 'TeamCLI',
    entity: 'floor',
    lead: 'agt_2b9f',
    teams: [TEAM_A, TEAM_B],
    provenance: { registered_by: 'test', registered_at: NOW.toISOString(), updated_at: NOW.toISOString() },
  },
];

/** The registry the project views read: one project of two teams, through the same three reads
 *  the real sources bind to. */
function projectSources(): ProjectSources {
  return {
    list: () => PROJECTS,
    byName: (key) => PROJECTS.find((project) => project.name === key) ?? null,
    ofTeam: (teamId) => PROJECTS.find((project) => project.teams.includes(teamId)) ?? null,
  };
}

function approveSources(place: Place, answer: string | null, home = place.home, waiting: Waiting = 'empty', over: Partial<ApproveSources> = {}): ApproveSources {
  return { ask: async () => answer, waiting: () => waiting, now: () => NOW, home, ...over };
}

function worktreeSources(place: Place): WorktreeSources {
  return { home: place.home, now: () => NOW };
}

function loader(place: Place): LoadConfig {
  return (cwd, file) => loadConfig(cwd, file, place.home);
}

const agent = (name: string, status = 'idle'): HerdrAgent => ({
  name, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null,
});

let compareDry = false;

function show(value: Ran, needle: string): Ran {
  if (!compareDry) expect(`${value.err}${value.out}`).toContain(needle);
  return value;
}

function projectBytes(place: Place): { state: string | null; log: string | null } {
  const state = join(place.root, '.agents', 'team.state.json');
  const log = join(place.root, '.agents', 'team.log');
  return {
    state: existsSync(state) ? readFileSync(state, 'utf8') : null,
    log: existsSync(log) ? readFileSync(log, 'utf8') : null,
  };
}

function dryArgv(argv: string[]): string[] {
  if (!compareDry || argv.includes('--dry-run')) return argv;
  return [...argv, '--dry-run'];
}

async function runCompared(place: Place, argv: string[], go: (args: string[]) => Promise<number>, io: ReturnType<typeof testIo>): Promise<Ran> {
  const args = dryArgv(argv);
  const before = compareDry ? projectBytes(place) : null;
  const code = await go(args);
  if (before) expect(projectBytes(place)).toEqual(before);
  return { code, out: io.out, err: io.err };
}

async function entry(argv: string[], io: ReturnType<typeof testIo>): Promise<Ran> {
  try {
    return { code: await main(argv, io), out: io.out, err: io.err };
  } catch (error) {
    return { code: reportFailure(error, (text) => io.stderr(text)), out: io.out, err: io.err };
  }
}

async function added(place: Place, argv: string[], caller: Caller, sources: AddSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return runCompared(place, argv, (args) => runAdd(args, io, sources), io);
}

async function approved(place: Place, argv: string[], caller: Caller, sources: ApproveSources, cwd = place.root): Promise<Ran> {
  const io = testIo(cwd, caller);
  return { code: await runApprove(argv, io, sources), out: io.out, err: io.err };
}

function publish(place: Place): void {
  const remote = join(place.base, 'remote.git');
  git(place.base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(place.root, 'remote', 'add', 'origin', remote);
  git(place.root, 'push', '-q', '-u', 'origin', 'main');
}

function worktreeText(patch: {
  mode?: 'shared' | 'worktree';
  path?: string | null;
  branch?: string;
  base?: string | null;
  trust?: string;
  limit?: number;
  setup?: string;
  sharedSeat?: boolean;
} = {}): string {
  const mode = patch.mode ?? 'worktree';
  const trust = patch.trust ?? '../worktrees/acme/*';
  const seat = patch.sharedSeat ? LEAD.replace('launch: claude --model claude-opus-5-5\n', 'launch: claude --model claude-opus-5-5\n    mode: shared\n') : LEAD;
  if (mode === 'shared') {
    return `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
identity:
  forbidden_public:
    - "\\\\bWEB-[0-9]+\\\\b"
trust:
  - ${trust}
workspace:
  mode: shared
seats:
${seat}`;
  }
  const path = patch.path === undefined ? '../worktrees/{repo}/{task}' : patch.path;
  const base = patch.base === undefined ? 'main' : patch.base;
  const lines = ['workspace:', '  mode: worktree'];
  if (path) lines.push(`  path: ${path}`);
  lines.push(`  branch: ${JSON.stringify(patch.branch ?? '{kind}/{task}')}`);
  if (base) lines.push(`  base: ${base}`);
  if (patch.limit) lines.push(`  limit: ${patch.limit}`);
  if (patch.setup) lines.push(patch.setup);
  return `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
identity:
  forbidden_public:
    - "\\\\bWEB-[0-9]+\\\\b"
trust:
  - ${trust}
${lines.join('\n')}
seats:
${seat}`;
}

function spendReading(): Seen {
  return {
    account: 'openai', window: 'weekly', left: 5, used: 95,
    changedAt: NOW.getTime() - 60_000, resetsAt: NOW.getTime() + 3_600_000,
    seat: 'worker', source: 'status_line', confirmed: true,
  };
}

// A local run may narrow the scenes to the ids the diff touches (`TEAM_EXIT_IDS`). The map
// stays complete under a filter — the invariants below read it — and the filter only
// narrows which scenes get a test registered.
const wanted = wantedScenes(process.env.TEAM_EXIT_IDS);
// CI's split of one full run over shards (`TEAM_EXIT_PART=i/n`): each scene runs in one part.
const part = scenePart(process.env.TEAM_EXIT_PART);
const scenePosition = new Map<string, number>();
/** A scene this run leaves to a filter or to another part. */
const skips = (id: string): boolean => skipsScene(wanted, id) || outsidePart(part, scenePosition.get(id) ?? 0);
/** Whole-repo checks and analyzer probes: once per full run, in part 0. */
const leadTest: typeof test = ((...args: Parameters<typeof test>) => (leadPart(part) ? test(...args) : undefined)) as typeof test;
const scenes = new Map<string, Scene>();
const bare = new Set<string>();
function scene(id: string, run: Scene, repo = true): void {
  scenes.set(id, run);
  if (!repo) bare.add(id);
}

function invalid(place: Place): void {
  writeFileSync(join(place.root, 'team.yaml'), 'format: [\n');
}

scene('add.invocation', async (place) => show(await added(place, ['--nope'], owner, addSources(place)), 'unknown option'));
scene('add.seat-name', async (place) => show(await added(place, [], owner, addSources(place)), 'a seat name is required'));
scene('add.reserved-name', async (place) => {
  // The file names its lead the way `team init` writes it, so `lead` would be a new name; a
  // legacy file that already declares the seat starts it instead (the add tests hold that half).
  write(
    place,
    TWO.replace('coordinator: lead\n', 'coordinator: orchestrator\n')
      .replace('operator: lead\n', 'operator: orchestrator\n')
      .replace('    name: lead\n    label: lead\n', '    name: orchestrator\n    label: orchestrator\n'),
  );
  return show(await added(place, ['lead'], owner, addSources(place)), '"lead" is reserved');
});
scene('add.temporary-unexpected', async (place) => show(await added(place, ['extra', '--temporary'], owner, addSources(place)), 'unexpected'));
scene('add.temporary-flags', async (place) => show(await added(place, ['worker', '--until', 'result:out.md'], owner, addSources(place)), '--until and --worktree'));
scene('add.not-a-repo', async (place) => show(await added(place, ['worker'], owner, addSources(place)), 'not inside a git repository'), false);
scene('add.file', async (place) => show(await added(place, ['worker', '--file', 'missing.yaml'], owner, addSources(place)), 'no team file'));
scene('add.file-invalid', async (place) => {
  invalid(place);
  return show(await added(place, ['worker', '--file', 'team.yaml'], owner, addSources(place)), 'line');
});
scene('add.file-owner', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--file', '.agents/team.yaml'], other, addSources(place)), "--file is the owner's");
});
scene('add.caller', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker'], other, addSources(place)), 'only the owner or a standing grant (delegate)');
});
scene('add.session-owner', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--session', 'other'], leadSeat, addSources(place)), "--session is the owner's");
});
scene('add.default-session', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--session', 'default', '--file', place.file], owner, addSources(place)), 'can\'t be "default"');
});
scene('add.never-approved', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified' }),
  })), 'cannot be verified');
});
scene('add.herdr', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { sessionState: () => null })), "doesn't answer");
});
scene('add.stopped', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { sessionState: () => 'stopped' })), 'is stopped');
});
scene('add.agents', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { sessionState: () => 'running', agents: () => null })), "can't be read");
});
scene('add.ceilings', async (place) => {
  approve(place, TWO);
  editApproval(place, (record) => { delete record.ceilings; });
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place)), 'no "ceilings"');
});
scene('add.no-seat', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['missing', '--file', place.file], owner, addSources(place)), 'no seat "missing"');
});
scene('add.human', async (place) => {
  approve(place, TWO.replace('    stopped: true\n', '    stopped: true\n    human: true\n'));
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place)), "worker is a human's pane");
});
scene('add.no-like', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['--temporary', '--like', 'missing', '--until', 'result:out.md', '--file', place.file], owner, addSources(place)), 'no seat "missing"');
});
scene('add.like-exists', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--like', 'lead', '--file', place.file], owner, addSources(place)), 'already declares "worker"');
});
scene('add.until', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'nope', '--file', place.file], owner, addSources(place)), '--until is result');
});
scene('add.result-absolute', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'result:/tmp/out.md', '--file', place.file], owner, addSources(place)), 'relative to the project');
});
scene('add.result-exists', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'result:README.md', '--file', place.file], owner, addSources(place)), 'already exists');
});
scene('add.merged-base', async (place) => {
  approve(place, TEAM);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'merged:topic', '--file', place.file], owner, addSources(place)), 'workspace.base is required');
});
scene('add.branch-missing', async (place) => {
  approve(place, WITH_BASE);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'merged:missing', '--file', place.file], owner, addSources(place)), "doesn't exist");
});
scene('add.worktree-missing', async (place) => {
  approve(place, TEAM);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'result:out.md', '--worktree', 'missing', '--file', place.file], owner, addSources(place)), 'no worktree named');
});
scene('add.worktree-failed', async (place) => {
  approve(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.worktrees.task = { path: '../worktrees/acme/task', branch: 'fix/task', setup: 'failed' };
  });
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'result:out.md', '--worktree', 'task', '--file', place.file], owner, addSources(place)), 'failed setup');
});
scene('add.already-running', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    sessionState: () => 'running', agents: () => [agent('worker')], workspaces: () => [{ id: 'w1' }],
  })), 'already running');
});
scene('add.session-doubt', async (place) => {
  approve(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = { stage: 'ready', workspace: 'w1', pane: 'w1:p1', launched: { shell: 400, cli: [401] } };
  });
  const launch = launching(IDLE);
  launch.processInfo = () => ({ shell: 400, foreground: [500] });
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    sessionState: () => 'running',
    agents: () => [agent('worker')],
    workspaces: () => [{ id: 'w1' }],
    launch,
  })), 'cannot tie to the launch');
});
scene('add.placed', async (place) => {
  const side = join(place.base, 'side');
  mkdirSync(side);
  const text = TWO.replace('workspace:', 'trust:\n  - ../side\nworkspace:');
  approve(place, text);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    sessionState() {
      rmSync(side, { recursive: true, force: true });
      symlinkSync(place.base, side);
      return 'absent';
    },
  })), "names the project's parent");
});
scene('add.pretrust', async (place) => {
  approve(place, TWO);
  writeFileSync(join(place.home, '.claude.json'), 'not json\n');
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place)), 'not trusted for claude');
});
scene('add.lobby', async (place) => {
  approve(place, TWO);
  const fs = {
    ...defaultFs,
    mkdir() {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { fs })), 'failed to create');
});
scene('add.start', async (place) => {
  approve(place, narrow(place));
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place)), 'inside the protected checkout');
});
scene('add.doctor', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { doctor: doctor(place.home, { version: () => null }) })), 'install');
});
scene('add.machine', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { machine: () => hot })), 'the load is 9.0');
});
scene('add.machine-again', async (place) => {
  approve(place, TWO);
  let calls = 0;
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    machine: () => (++calls === 1 ? fine : hot),
  })), 'the load is 9.0');
});
scene('add.ceiling', async (place) => {
  approve(place, TWO);
  // The ceiling is the live file's. One seat is already running, and the file allows one.
  // `approve` writes the absolute trust this command requires before it reaches the ceiling.
  const text = readFileSync(place.file, 'utf8');
  writeFileSync(place.file, text.replace('workspace:\n', 'limits:\n  seats: 1\nworkspace:\n'));
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    sessionState: () => 'running',
    agents: () => [agent('lead')],
  })), 'allows 1 seats');
});
scene('add.client-refused', async (place) => show(await added(place, ['worker', '--client', 'missing-grant.json', '--key', 'missing.key', '--team', 'acme'], detachedCaller, addSources(place)), 'no client grant can verify'));
scene('add.dry-run', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--dry-run', '--file', place.file], owner, addSources(place)), 'dry run: nothing was run');
});
scene('add.override-owner', async (place) => {
  // The map's row refuses every seat, so the one caller who reaches the flags' own refusal in
  // 0.5.0 is the approved delegate: the verdict below passes, the target is the approved copy's
  // own live stanza (`lead`, never stopped), and the add still refuses the owner's flags.
  approve(place, DELEGATED_ADD_REMOVE);
  return show(await added(place, ['lead', '--model', 'claude-sonnet-5-5'], addRemoveCaller, addSources(place, {
    delegateGate: () => ({ kind: 'passed' as const, pane: 'main/w1:p1' }),
  })), "--model and --effort on a declared seat are the owner's");
});
scene('add.model', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--model', 'unknown', '--file', place.file], owner, addSources(place)), 'unknown model "unknown"');
});
scene('add.effort', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--effort', 'unknown', '--file', place.file], owner, addSources(place)), 'effort "unknown" is not one of anthropic\'s');
});
scene('add.budget', async (place) => {
  approve(place, BUDGET);
  saveReadings(join(place.root, '.agents'), [spendReading()], NOW.getTime());
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place)), 'refused:');
});
scene('add.changed', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    doctor: doctor(place.home, { version: () => { writeFileSync(place.file, `${readFileSync(place.file, 'utf8')}\n`); return '2.1.288'; } }),
  })), 'changed while add');
});
scene('add.ready', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { launch: launching(IDLE) })), 'ready');
});
scene('add.not-ready', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { launch: launching('') })), 'timed out');
});
scene('add.run-lock', async (place) => {
  approve(place, TWO);
  // The session mutator lock another run holds, in the file every session mutator shares: this
  // test process's pid is alive, so the token is never judged stale. Nothing else is stood in,
  // so the run reaches the lock on the ordinary path — the refusals above it are all decided.
  const dir = join(place.root, '.agents');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  writeFileSync(seatLockPath(dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { launch: launching(IDLE) })), 'another session-mutating run is holding');
});
scene('add.server', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { launch: launching(IDLE, () => true, false) })), 'its server did not start');
});

// The delegated runs. The file names a delegate — a pane outside the team's session — and the
// caller stands on it as a seat of that other session, a caller the ordinary rule refuses before
// the gate is asked. The scenes below hand the command the contract's verdicts through the test's
// own injection (`sources.delegateGate`), each with the sentence the real gate gives; what they
// prove is the command's own behaviour — the verdict printed behind its prefix, exit 1, nothing
// started. The two registered without an injection are the real gate's own: `delegate-approval`
// (no record under the home it answers for, so its first read refuses the run before herdr is
// ever asked) and `delegate-edit` (a passed gate, an add that would edit the file). The verdicts'
// reasons are the gate's tests'.
const DELEGATED_ADD_REMOVE = TWO + `delegates:
  - pane: main/w1:p1
    commands: [add, remove]
`;
const addRemoveCaller = { kind: 'seat', name: 'pilot', pane: 'w1:p1', session: 'main' } as const;
const refused = (id: string, text: string) => ({ kind: 'refused' as const, id, text });

const ADD_GATE_REFUSALS: [suffix: string, sentence: string, needle: string][] = [
  ['delegate-evidence', "delegation cannot verify its placement or seats: herdr doesn't answer", 'placement or seats'],
  ['delegate-placement', 'the approved delegate must be an external non-seat pane', 'non-seat pane'],
  ['delegate', 'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is pilot', 'or a standing grant (delegate)'],
  ['delegate-command', 'the approved delegate main/w1:p1 may not run `add`; its approved commands are remove', 'may not run'],
];
for (const [suffix, sentence, needle] of ADD_GATE_REFUSALS) {
  scene(`add.${suffix}`, async (place) => {
    write(place, DELEGATED_ADD_REMOVE);
    return show(await added(place, ['worker'], addRemoveCaller, addSources(place, {
      delegateGate: () => refused(`add.${suffix}`, sentence),
    })), needle);
  });
}
scene('add.delegate-flag', async (place) => {
  write(place, DELEGATED_ADD_REMOVE);
  return show(await added(place, ['--temporary', '--like', 'lead', '--until', 'result:out.md'], addRemoveCaller, addSources(place, {
    delegateGate: () => refused('add.delegate-flag', "--temporary is the owner's; the approved delegate cannot use it"),
  })), 'cannot use it');
});
scene('add.delegate-approval', async (place) => {
  write(place, DELEGATED_ADD_REMOVE);
  return show(await added(place, ['worker'], addRemoveCaller, addSources(place)), 'delegation needs a verified approval');
});
scene('add.delegate-edit', async (place) => {
  approve(place, DELEGATED_ADD_REMOVE);
  return show(await added(place, ['worker'], addRemoveCaller, addSources(place, {
    delegateGate: () => ({ kind: 'passed' as const, pane: 'main/w1:p1' }),
  })), 'only a same-copy seat');
});

async function briefed(place: Place, argv: string[], caller: Caller): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runBrief(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}

// A live, settled lead: the state records it on its pane and the launch delivered the brief.
function settledLead(place: Place): void {
  recordsLead(place);
  deliverBriefs({ dir: join(place.root, '.agents'), root: place.root, session: 'acme', seats: ['lead'], home: place.home, at: NOW.toISOString() });
}

scene('brief.plan', async (place) => {
  write(place, TEAM);
  settledLead(place);
  return show(await briefed(place, ['rollout'], owner), 'brief lead: current');
});
scene('brief.stale', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  return show(await briefed(place, ['rollout'], owner), 'deliver lead:');
});
scene('brief.current', async (place) => {
  write(place, TEAM);
  settledLead(place);
  return show(await briefed(place, ['rollout', '--apply'], owner), 'brief lead: current');
});
scene('brief.incomplete', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  // A regular file where the seat's drop folder must be: the claim is written, the record is not.
  mkdirSync(join(place.root, '.agents', 'send-drops', 'acme'), { recursive: true });
  writeFileSync(join(place.root, '.agents', 'send-drops', 'acme', 'lead'), 'not a folder\n');
  return show(await briefed(place, ['rollout', '--apply'], owner), 'failed lead:');
});
scene('brief.file-owner', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  return show(await briefed(place, ['rollout', '--file', '.agents/team.yaml'], leadSeat), "--file is the owner's");
});
scene('brief.session-owner', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  return show(await briefed(place, ['rollout', '--session', 'other'], leadSeat), "--session is the owner's");
});
scene('brief.not-yours', async (place) => {
  write(place, TEAM);
  return show(await briefed(place, ['rollout'], other), 'this team is not yours to read');
});
scene('brief.invocation', async (place) => show(await briefed(place, ['deploy'], owner), 'unexpected "deploy"'));
scene('brief.file', async (place) => show(await briefed(place, ['rollout', '--file', 'missing.yaml'], owner), 'no team file'));
scene('brief.file-invalid', async (place) => {
  invalid(place);
  return show(await briefed(place, ['rollout', '--file', 'team.yaml'], owner), 'line');
});

async function checked(place: Place, argv: string[], caller: Caller, sources: CheckSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await check(argv, io, loader(place), sources), out: io.out, err: io.err };
}

function checkSources(live: Live | null, standing: Standing = { kind: 'none' }, home?: string): CheckSources {
  return { live: () => live, branch: () => 'main', standing: () => standing, now: () => NOW, ...(home === undefined ? {} : { home }) };
}

// The state record a passing seat stands on: the file's own seat, on the pane herdr lists it in.
// Without it the walk cannot place the caller, and every seat is not-yours.
function recordsLead(place: Place, pane = 'w1:p1'): void {
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane };
  });
}

scene('check.invocation', async (place) => {
  // A word that belongs to neither spelling's options keeps the old refusal, byte for byte, and
  // takes no notice line: an error already says what to fix.
  return show(await checked(place, ['--nope'], owner, checkSources(quiet)), 'unknown option --nope');
});
scene('check.ok', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({ dir: join(place.root, '.agents'), root: place.root, session: 'acme', seats: ['lead'], home: place.home, at: NOW.toISOString() });
  approve(place, TEAM);
  const matched: Live = {
    running: true,
    agents: [agent('lead')],
    workspaces: [{ id: 'w1', label: 'lead' }],
    // The lead's own pane, readable: a quiet seat on a screen no profile reads is a
    // difference the check reports, so a healthy team's pane says what it is.
    screens: { 'w1:p1': IDLE },
  };
  return show(await checked(place, [], owner, checkSources(matched, approvalStanding(place.root, place.home), place.home)), 'no differences');
});
scene('check.findings', async (place) => {
  write(place, TEAM);
  return show(await checked(place, [], owner, checkSources(quiet)), 'is in the file and is not running');
});
scene('check.file-owner', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  return show(await checked(place, ['--file', '.agents/team.yaml'], leadSeat, checkSources(quiet)), "--file is the owner's");
});
scene('check.session-owner', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  return show(await checked(place, ['--session', 'other'], leadSeat, checkSources(quiet)), "--session is the owner's");
});
scene('check.repair-owner', async (place) => {
  write(place, TEAM);
  recordsLead(place);
  return show(await checked(place, ['--repair'], leadSeat, checkSources(quiet)), "--repair is the owner's");
});
scene('check.repaired', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
    // A record for a seat the file no longer declares, and a session with no seat of the team in
    // it: the owner's --repair drops both, and the state says what the file does.
    session.seats.gone = { stage: 'ready', pane: 'w1:p2', workspace: 'w1' };
    state.sessions.left = { seats: {}, worktrees: {} };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({ dir: join(place.root, '.agents'), root: place.root, session: 'acme', seats: ['lead'], home: place.home, at: NOW.toISOString() });
  approve(place, TEAM);
  const matched: Live = {
    running: true,
    agents: [agent('lead')],
    workspaces: [{ id: 'w1', label: 'lead' }],
    screens: { 'w1:p1': IDLE },
  };
  const sources = checkSources(matched, approvalStanding(place.root, place.home), place.home);
  return show(await checked(place, ['--repair'], owner, sources), 'repaired:');
});
scene('check.not-yours', async (place) => {
  // A caller that does not pass learns nothing, even when the target does not load: the answer is
  // the one fixed sentence, byte for byte, on stderr, and nothing else anywhere.
  const ran = await checked(place, [], other, checkSources(quiet));
  expect(ran.err).toBe('team check: this team is not yours to check\n');
  expect(ran.out).toBe('');
  return ran;
});
scene('check.not-a-repo', async (place) => show(await checked(place, [], owner, checkSources(quiet)), 'not inside a git repository'), false);
scene('check.file', async (place) => show(await checked(place, ['--file', 'missing.yaml'], owner, checkSources(quiet)), 'no team file'));
scene('check.file-invalid', async (place) => {
  invalid(place);
  return show(await checked(place, ['--file', 'team.yaml'], owner, checkSources(quiet)), 'line');
});
scene('check.state', async (place) => {
  write(place, TEAM);
  writeFileSync(join(place.root, '.agents', 'team.state.json'), '{');
  return show(await checked(place, [], owner, checkSources(quiet)), 'not valid JSON');
});
scene('check.herdr', async (place) => {
  write(place, TEAM);
  return show(await checked(place, [], owner, checkSources(null)), "doesn't answer");
});

// The keygen scenes need a home outside the OS temp tree: the placement rule refuses a key
// directory that overlaps it, and every other scene's place lives under mkdtemp's tree.
function clientHome(label: string): string {
  return realpathSync(mkdtempSync(join(process.cwd(), `.client-exit-${label}-`)));
}

function ranClient(place: Place, argv: string[], home: string = place.home, caller: Caller = owner): Ran {
  const io = testIo(place.root, caller);
  return { code: runClient(argv, io, home), out: io.out, err: io.err };
}

scene('client.usage', async (place) => show(ranClient(place, []), 'a subcommand is required'));
scene('client.unknown', async (place) => show(ranClient(place, ['nope']), 'unknown subcommand'));
scene('client.keygen.invocation', async (place) => show(ranClient(place, ['keygen']), '--out is required'));
scene('client.keygen.refused', async (place) => show(ranClient(place, ['keygen', '--out', join(place.home, 'keys')]), 'is outside'));
scene('client.keygen.pane', async (place) => show(
  ranClient(place, ['keygen', '--out', join(place.home, '.config', 'team-client', 'grok-bot')], place.home, { kind: 'seat', name: 'orchestrator', pane: 'w1:p1' }),
  'a client key is not used from inside a team pane',
));
scene('client.keygen.write', async (place) => {
  const home = clientHome('write');
  try {
    const held = join(home, '.config', 'team-client', 'held');
    mkdirSync(dirname(held), { recursive: true });
    writeFileSync(held, 'not a directory\n');
    return show(ranClient(place, ['keygen', '--out', held], home), 'cannot be created');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
scene('client.keygen.done', async (place) => {
  const home = clientHome('done');
  try {
    const dir = join(home, '.config', 'team-client', 'bot');
    const ran = ranClient(place, ['keygen', '--out', dir], home);
    if (ran.code !== 0) throw new Error(`${ran.err}${ran.out}`);
    expect(existsSync(join(dir, 'client.key'))).toBe(true);
    expect(existsSync(join(dir, 'client.pub'))).toBe(true);
    return show(ran, 'key isolation: enforced against team panes (key file still readable by same-user processes)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
scene('commits.invocation', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check'], io, loader(place)), out: io.out, err: io.err }, 'a <ref> is required');
});
scene('commits.not-a-repo', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD'], io, loader(place)), out: io.out, err: io.err }, 'not inside a git repository');
}, false);
scene('commits.file', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD'], io, loader(place)), out: io.out, err: io.err }, 'no team file');
});
scene('commits.file-invalid', async (place) => {
  invalid(place);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--file', 'team.yaml'], io, loader(place)), out: io.out, err: io.err }, 'line');
});
scene('commits.ledger', async (place) => {
  approve(place, CHECKED);
  writeFileSync(join(dirname(approvalFile(place)), 'ledger.json'), '{');
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'ledger.json');
});
scene('commits.passed', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'ok');
});
scene('commits.refused', async (place) => {
  write(place, CHECKED);
  writeFileSync(join(place.root, 'note.txt'), 'note\n');
  git(place.root, 'add', 'note.txt');
  execFileSync('git', ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '-m', 'fix: unsigned'], {
    cwd: place.root, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'refused');
});
scene('commits.threw', async (place) => {
  write(place, CHECKED);
  const loaded = loadConfig(place.root, place.file, place.home);
  if (!loaded.ok) throw new Error('team file');
  const config = { ...loaded.config, forbidden: ['['] };
  const io = testIo(place.root, owner);
  try {
    const code = await commits(['check', 'HEAD', '--file', place.file], io, () => ({ ok: true, config, warnings: [] }));
    return show({ code, out: io.out, err: io.err }, 'not a regular expression');
  } catch (error) {
    return show({ code: reportFailure(error, (text) => io.stderr(text)), out: io.out, err: io.err }, 'not a regular expression');
  }
});
scene('commits.outside', async (place) => {
  writeFileSync(join(place.base, 'team.yaml'), CHECKED);
  const io = testIo(place.base, owner);
  return show({ code: await commits(['check', 'HEAD', '--file', 'team.yaml'], io, loader(place)), out: io.out, err: io.err }, 'team commits check: not in a git repository\n');
});
scene('commits.no-commit', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'not-a-ref', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, "doesn't name a commit");
});
scene('commits.range', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'missing..also', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, "can't be resolved");
});
scene('commits.empty-range', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD..HEAD', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'holds no commit');
});
scene('commits.since-missing', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--since', 'missing', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'since "missing"');
});
scene('commits.since-unreachable', async (place) => {
  write(place, CHECKED);
  const tree = git(place.root, 'rev-parse', 'HEAD^{tree}').trim();
  const otherCommit = git(place.root, 'commit-tree', tree, '-m', 'other').trim();
  git(place.root, 'update-ref', 'refs/heads/topic', otherCommit);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--since', 'topic', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'is not reachable');
});
scene('commits.not-a-ref', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await commits(['check', 'HEAD', '--since', '--bad', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'is not a ref');
});

scene('pr.invocation', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check'], io, loader(place)), out: io.out, err: io.err }, 'a <file> is required');
});
scene('pr.not-a-repo', async (place) => {
  // In a folder with no repository the refusal is the loader's, not a git one: `pr check`
  // runs no git at all. The pass in one is the names test's own case.
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'body.md'], io, loader(place)), out: io.out, err: io.err }, 'not inside a git repository');
}, false);
scene('pr.file', async (place) => {
  writeFileSync(join(place.root, 'body.md'), PR_BODY);
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'body.md'], io, loader(place)), out: io.out, err: io.err }, 'no team file');
});
scene('pr.file-invalid', async (place) => {
  invalid(place);
  writeFileSync(join(place.root, 'body.md'), PR_BODY);
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'body.md', '--file', 'team.yaml'], io, loader(place)), out: io.out, err: io.err }, 'line');
});
scene('pr.ledger', async (place) => {
  approve(place, CHECKED);
  writeFileSync(join(dirname(approvalFile(place)), 'ledger.json'), '{');
  writeFileSync(join(place.root, 'body.md'), PR_BODY);
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'body.md', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'ledger.json');
});
scene('pr.body', async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'missing.md', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, "can't read the pull request body");
});
scene('pr.passed', async (place) => {
  write(place, CHECKED);
  writeFileSync(join(place.root, 'body.md'), `${PR_BODY}\n`);
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'body.md', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, '1 pull request body checked: ok');
});
scene('pr.refused', async (place) => {
  write(place, CHECKED);
  writeFileSync(join(place.root, 'body.md'), 'Bump the retry window to thirty seconds.\n');
  const io = testIo(place.root, owner);
  return show({ code: await pr(['check', 'body.md', '--file', place.file], io, loader(place)), out: io.out, err: io.err }, 'the pull request body refused');
});

const WORKFLOW_OK = `workflow: tiny
version: 1
initial: start
states:
  start: {}
  complete: {}
transitions:
  - from: start
    to: complete
    on: pr-opened
    role: owner
`;

const WORKFLOW_SCRIPT_OK = `format: 1
target: "project://tiny"
artifact:
  kind: none
inputs: {}
settings: {}
evidence:
  step-1:
    type: step
    target: "project://tiny"
signals:
  - signal: pr-opened
    at: "2026-10-21T12:00:00Z"
    request-id: req-1
    expected-revision: 0
    evidence: [step-1]
`;

scene('workflow.check.invocation', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runWorkflow(['check'], io), out: io.out, err: io.err }, 'a <path> is required');
});
scene('workflow.check.file', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runWorkflow(['check', 'missing.yaml'], io), out: io.out, err: io.err }, "can't read missing.yaml");
});
scene('workflow.check.file-invalid', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), 'format: [\n');
  const io = testIo(place.root, owner);
  return show({ code: await runWorkflow(['check', 'workflow.yaml'], io), out: io.out, err: io.err }, 'workflow.yaml:1:');
});
scene('workflow.check.passed', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  const io = testIo(place.root, owner);
  return show({ code: await runWorkflow(['check', 'workflow.yaml'], io), out: io.out, err: io.err }, 'team workflow check: workflow.yaml: ok');
});
scene('workflow.check.refused', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK.replace('to: complete', 'to: missing'));
  const io = testIo(place.root, owner);
  return show({ code: await runWorkflow(['check', 'workflow.yaml'], io), out: io.out, err: io.err }, 'refused');
});
scene('workflow.invocation', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runWorkflow([], io), out: io.out, err: io.err }, 'a subcommand is required');
});
scene('workflow.file', async (place) => {
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['run', 'missing.yaml', '--dry', '--script', 'script.yaml'], io), out: io.out, err: io.err },
    "can't read missing.yaml",
  );
});
scene('workflow.dry-only', async (place) => {
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['run', 'workflow.yaml'], io), out: io.out, err: io.err },
    'Kernel workflow gate (amendment 04)',
  );
});
scene('workflow.script', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK.replace('format: 1', 'format: 2'));
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml'], io), out: io.out, err: io.err },
    'format must be the integer 1',
  );
});
scene('workflow.evidence', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK.replace('  step-1:\n    type: step\n    target: "project://tiny"', '  step-1: not-a-map'));
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml'], io), out: io.out, err: io.err },
    'evidence.step-1 must be a mapping',
  );
});
scene('workflow.run-dry', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK);
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml'], io), out: io.out, err: io.err },
    'script-exhausted',
  );
});
scene('workflow.refused', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK.replace('expected-revision: 0', 'expected-revision: 9'));
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml'], io), out: io.out, err: io.err },
    'stopped (refused core.revision-stale',
  );
});
scene('workflow.replay', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK);
  const runIo = testIo(place.root, owner);
  await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml', '--json'], runIo);
  writeFileSync(join(place.root, 'journal.json'), runIo.out);
  writeFileSync(join(place.root, 'evidence.json'), '{"step-1":{"type":"step","target":"project://tiny"}}\n');
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['replay', 'workflow.yaml', 'journal.json', '--evidence', 'evidence.json'], io), out: io.out, err: io.err },
    'team workflow replay: journal.json: ok',
  );
});
scene('workflow.replay-mismatch', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK);
  const runIo = testIo(place.root, owner);
  await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml', '--json'], runIo);
  const journal = JSON.parse(runIo.out);
  journal.steps[0].activation = 99;
  writeFileSync(join(place.root, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(join(place.root, 'evidence.json'), '{"step-1":{"type":"step","target":"project://tiny"}}\n');
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['replay', 'workflow.yaml', 'journal.json', '--evidence', 'evidence.json'], io), out: io.out, err: io.err },
    '[workflow.replay-mismatch]',
  );
});
scene('workflow.journal', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'journal.json'), '{ not json\n');
  writeFileSync(join(place.root, 'evidence.json'), '{}\n');
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['replay', 'workflow.yaml', 'journal.json', '--evidence', 'evidence.json'], io), out: io.out, err: io.err },
    '[workflow.journal]',
  );
});
scene('workflow.definition', async (place) => {
  writeFileSync(join(place.root, 'workflow.yaml'), WORKFLOW_OK);
  writeFileSync(join(place.root, 'script.yaml'), WORKFLOW_SCRIPT_OK);
  const runIo = testIo(place.root, owner);
  await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml', '--json'], runIo);
  writeFileSync(join(place.root, 'journal.json'), runIo.out);
  writeFileSync(join(place.root, 'other.yaml'), WORKFLOW_OK.replace('workflow: tiny', 'workflow: other'));
  writeFileSync(join(place.root, 'evidence.json'), '{}\n');
  const io = testIo(place.root, owner);
  return show(
    { code: await runWorkflow(['replay', 'other.yaml', 'journal.json', '--evidence', 'evidence.json'], io), out: io.out, err: io.err },
    '[workflow.definition]',
  );
});

scene('conformance-adapter.finished', async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const proc = Bun.spawn(['bun', 'src/cli.ts', 'conformance-adapter'], {
    cwd: repo, stdin: new TextEncoder().encode('not json\n'), stdout: 'pipe', stderr: 'pipe',
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  return show({ code, out, err: await new Response(proc.stderr).text() }, 'the line is not JSON');
});

scene('development-mode.done', async (place) => {
  const io = testIo(place.root, other);
  return show(
    { code: await runDevelopmentMode(['set', 'local-fast', '--show'], io, { home: place.home, now: NOW }), out: io.out, err: io.err },
    'would set the machine development mode to local-fast',
  );
});
scene('development-mode.refused', async (place) => {
  const io = testIo(place.root, other);
  return show(
    { code: await runDevelopmentMode(['set', 'off'], io, { home: place.home, now: NOW }), out: io.out, err: io.err },
    'only the owner switches the machine development mode',
  );
});
scene('development-mode.invocation', async (place) => {
  const io = testIo(place.root, other);
  return show(
    { code: await runDevelopmentMode(['set', 'maybe'], io, { home: place.home, now: NOW }), out: io.out, err: io.err },
    'the mode must be one of local-fast|pr-per-change|off',
  );
});

scene('owner-seat.done', async (place) => {
  const io = testIo(place.root, other);
  return show({ code: await runOwnerSeat(['status'], io, { home: place.home }), out: io.out, err: io.err }, 'security profile: strict');
});
scene('owner-seat.refused', async (place) => {
  const io = testIo(place.root, other);
  return show({ code: await runOwnerSeat(['profile', 'relaxed'], io, { home: place.home }), out: io.out, err: io.err }, 'no owner seat is registered');
});
scene('owner-seat.invocation', async (place) => {
  const io = testIo(place.root, other);
  return show({ code: await runOwnerSeat(['profile', 'maybe'], io, { home: place.home }), out: io.out, err: io.err }, 'profile is strict, relaxed or dev');
});

scene('doctor.invocation', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['extra'], io, doctor(place.home)), out: io.out, err: io.err }, 'unexpected');
});
scene('doctor.both-modes', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['--login', '--jules'], io, doctor(place.home)), out: io.out, err: io.err }, 'ask one at a time');
});
scene('doctor.not-a-repo', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor([], io, doctor(place.home)), out: io.out, err: io.err }, 'not inside a git repository');
}, false);
scene('doctor.file', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['--file', 'missing.yaml'], io, doctor(place.home)), out: io.out, err: io.err }, 'no team file');
});
scene('doctor.file-invalid', async (place) => {
  invalid(place);
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['--file', 'team.yaml'], io, doctor(place.home)), out: io.out, err: io.err }, 'line');
});
scene('doctor.clear', async (place) => {
  approve(place, TEAM);
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['--file', place.file], io, doctor(place.home)), out: io.out, err: io.err }, 'nothing missing');
});
scene('doctor.missing', async (place) => {
  approve(place, TEAM);
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['--file', place.file], io, doctor(place.home, { version: () => null })), out: io.out, err: io.err }, 'install');
});

async function down(place: Place, argv: string[], caller: Caller, sources: RemoveSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return runCompared(place, argv, (args) => runDown(args, io, { ...sources, home: sources.home ?? place.home }), io);
}

scene('down.invocation', async (place) => show(await down(place, ['extra'], owner, downSources()), 'unexpected'));
scene('down.not-a-repo', async (place) => show(await down(place, [], owner, downSources()), 'not inside a git repository'), false);
scene('down.file', async (place) => show(await down(place, ['--file', 'missing.yaml'], owner, downSources()), 'no team file'));
scene('down.file-invalid', async (place) => {
  invalid(place);
  return show(await down(place, ['--file', 'team.yaml'], owner, downSources()), 'line');
});
scene('down.herdr', async (place) => {
  write(place, TEAM);
  return show(await down(place, [], owner, downSources({ sessionRunning: () => null })), "doesn't answer");
});
scene('down.idle', async (place) => {
  write(place, TEAM);
  return show(await down(place, [], owner, downSources()), 'nothing to stop');
});
scene('down.agents', async (place) => {
  write(place, TEAM);
  return show(await down(place, [], owner, downSources({ sessionRunning: () => true, agents: () => null })), "can't be read");
});
scene('down.dry-run', async (place) => {
  approve(place, TEAM);
  return show(await down(place, ['--dry-run'], owner, downSources({ sessionRunning: () => true, agents: () => [], home: place.home })), 'dry run: nothing was run');
});
scene('down.caller', async (place) => {
  write(place, TEAM);
  return show(await down(place, [], other, downSources({ sessionRunning: () => true, agents: () => [] })), 'only the owner or `leads` stops the team');
});
scene('down.client-refused', async (place) => show(await down(place, ['--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller, downSources()), 'no client grant can verify'));
scene('down.file-owner', async (place) => {
  write(place, TWO);
  return show(await down(place, ['--file', '.agents/team.yaml'], other, downSources()), "--file is the owner's");
});
scene('down.no-pane', async (place) => {
  write(place, TEAM);
  return show(await down(place, [], leadSeat, downSources({ sessionRunning: () => true, agents: () => [], home: place.home })), 'no pane is recorded for seat lead');
});
scene('down.session-owner', async (place) => {
  write(place, TEAM);
  return show(await down(place, ['--session', 'other'], leadSeat, downSources({ sessionRunning: () => true, agents: () => [] })), "--session is the owner's");
});
scene('down.another-pane', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w2:p1' };
  });
  return show(await down(place, [], leadSeat, downSources({ sessionRunning: () => true, agents: () => [], home: place.home })), 'the state records pane w2:p1 for seat lead');
});
scene('down.abandon', async (place) => {
  write(place, TEAM);
  return show(await down(place, ['--abandon'], leadSeat, downSources({ sessionRunning: () => true, agents: () => [] })), 'only the owner abandons');
});

// The delegate branch's own refusals. The file carries a `delegates` section, the caller is a
// pane the ordinary rule refuses — `other`, whose name is no coordinator's — and the gate's
// verdict is injected: what these scenes pin is the command's side of the contract, the text
// and the exit code of each id. The gate's own decisions are its own test file's.
const DELEGATED = `${TEAM}delegates:\n  - pane: hook/w2:p9\n    commands: [up, down]\n`;
const refusedBy = (id: string, text: string) => (): { kind: 'refused'; id: string; text: string } => ({ kind: 'refused', id, text });
const delegated = (id: string, text: string) => downSources({ sessionRunning: () => true, agents: () => [], gate: refusedBy(id, text) });

scene('down.delegate', async (place) => {
  write(place, DELEGATED);
  const text = 'only the owner, `leads` or the approved delegate stops the team; this call is other';
  const ran = await down(place, [], other, delegated('down.delegate', text));
  if (compareDry) expect(ran.out).toContain(`! down would refuse: ${text}\n`);
  else expect(ran.err).toBe(`team down: ${text}\n`);
  return ran;
});
scene('down.delegate-approval', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-approval', 'delegation needs a verified approval: no approval is in force')), 'delegation needs a verified approval');
});
scene('down.delegate-command', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-command', 'the delegate may not run down')), 'may not run down');
});
scene('down.delegate-evidence', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-evidence', "delegation cannot verify its placement or seats: herdr doesn't answer")), 'cannot verify its placement or seats');
});
scene('down.delegate-flag', async (place) => {
  write(place, DELEGATED);
  const text = "--abandon is the owner's; the approved delegate cannot use it";
  const ran = await down(place, ['--abandon'], other, delegated('down.delegate-flag', text));
  // The gate's flag refusal is the run's only refusal: today's abandon line stays out of it.
  if (compareDry) expect(ran.out).toContain(`! down would refuse: ${text}\n`);
  else expect(ran.err).toBe(`team down: ${text}\n`);
  return ran;
});
scene('down.delegate-placement', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-placement', 'the approved delegate must be an external non-seat pane')), 'external non-seat pane');
});

// The grant's refusals of `down`, asked only once the ordinary rule has accepted the
// orchestrator. A file with no grant is not these scenes.
function grantDown(place: Place, over: GrantSources = {}): RemoveSources {
  return downSources({
    home: place.home,
    grantGate: (input) => grantGate({ ...input, sources: over }),
  });
}

scene('down.grant-approval', async (place) => {
  write(place, GRANTED);
  recordLead(place, 'w1:p1');
  return show(await down(place, [], leadSeat, grantDown(place)), 'a grant needs a verified approval');
});
scene('down.grant-scope', async (place) => {
  approve(place, GRANT_UP);
  recordLead(place, 'w1:p1');
  return show(await down(place, [], leadSeat, grantDown(place)), 'the grant does not list `down`');
});
scene('down.no-launch', async (place) => {
  approve(place, TEAM);
  return show(await down(place, [], owner, downSources({ sessionRunning: () => true, agents: () => [], home: place.home })), 'no way to reach herdr');
});
scene('down.stopped', async (place) => {
  approve(place, TEAM);
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [], launch: downLaunch(), home: place.home,
  })), 'stopped');
});
scene('down.run-lock', async (place) => {
  approve(place, TEAM);
  // The session mutator lock another run holds, in the file every session mutator shares: this
  // test process's pid is alive, so the token is never judged stale. The session with nothing to
  // stop and a dry run both return before the lock; this scene is a real stop that meets it.
  const dir = join(place.root, '.agents');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  writeFileSync(seatLockPath(dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [], launch: downLaunch(), home: place.home,
  })), 'another session-mutating run is holding');
});
scene('down.held', async (place) => {
  approve(place, TEAM);
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true,
    agents: () => [agent('lead')],
    launch: downLaunch({ typeText: () => false }),
    home: place.home,
  })), 'its exit was not typed');
});
scene('down.never-approved', async (place) => {
  write(place, TEAM);
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('lead')], home: place.home,
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified' }),
  })), 'cannot be verified');
});
scene('down.legacy', async (place) => {
  approve(place, TEAM);
  editApproval(place, (record) => {
    record.format = 1;
    delete record.signature;
    delete record.generation;
  });
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('lead')], home: place.home,
  })), 'approved before records were signed');
});
scene('down.refused', async (place) => {
  approve(place, TEAM);
  editApproval(place, (record) => {
    // A change of meaning: the signature covers the canonical record, so layout alone would verify.
    record.file = String(record.file).replace('project: acme', 'project: acme-changed');
  });
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('lead')], home: place.home,
  })), 'valid signature');
});

async function archived(place: Place, argv: string[], caller: Caller, sources: RemoveSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return runCompared(place, argv, (args) => runArchive(args, io, { ...sources, home: sources.home ?? place.home }), io);
}

scene('archive.invocation', async (place) => show(await archived(place, ['extra'], owner, downSources()), 'unexpected'));
scene('archive.stop-flags', async (place) => show(
  await archived(place, ['--keep-running', '--abandon'], owner, downSources()),
  '--keep-running takes the snapshot alone',
));
scene('archive.not-a-repo', async (place) => show(await archived(place, [], owner, downSources()), 'not inside a git repository'), false);
scene('archive.file', async (place) => show(await archived(place, ['--file', 'missing.yaml'], owner, downSources()), 'no team file'));
scene('archive.file-invalid', async (place) => {
  invalid(place);
  return show(await archived(place, ['--file', 'team.yaml'], owner, downSources()), 'line');
});
scene('archive.detached', async (place) => show(await archived(place, [], detachedCaller, downSources()), SENTENCE));
scene('archive.file-owner', async (place) => {
  write(place, TEAM);
  return show(await archived(place, ['--file', '.agents/team.yaml'], other, downSources()), "--file is the owner's");
});
scene('archive.out-owner', async (place) => {
  write(place, TEAM);
  return show(await archived(place, ['--out', join(place.home, 'elsewhere')], other, downSources()), "--out is the owner's");
});
scene('archive.keep-running', async (place) => {
  write(place, TEAM);
  return show(await archived(place, ['--keep-running'], owner, downSources()), '--keep-running: the stop is skipped.');
});
scene('archive.exists', async (place) => {
  write(place, TEAM);
  // The pinned clock and the one home put both runs in the same folder: the second is the
  // refusal, which is the outcome this row names.
  const first = await archived(place, ['--keep-running'], owner, downSources());
  if (first.code !== 0) throw new Error(`${first.err}${first.out}`);
  return show(await archived(place, ['--keep-running'], owner, downSources()), 'exists already');
});

async function initial(
  place: Place,
  argv: string[],
  caller: Caller = owner,
  home = place.home,
  readStanding?: (root: string) => Standing,
): Promise<Ran> {
  const io = testIo(place.root, caller);
  try {
    return { code: await runInit(argv, io, home, readStanding), out: io.out, err: io.err };
  } catch (error) {
    return { code: reportFailure(error, (text) => io.stderr(text)), out: io.out, err: io.err };
  }
}

scene('init.invocation', async (place) => show(await initial(place, ['extra']), 'unexpected'));
scene('init.not-owner', async (place) => show(await initial(place, [], other), 'only the owner'));
scene('init.not-a-repo', async (place) => show(await initial(place, []), 'not inside a git repository'), false);
scene('init.tracked', async (place) => {
  write(place, TEAM);
  git(place.root, 'add', '-f', '.agents/team.yaml');
  git(place.root, 'commit', '-q', '-m', 'track the team file');
  return show(await initial(place, []), 'tracked by git');
});
scene('init.exists', async (place) => {
  write(place, TEAM);
  return show(await initial(place, []), 'exists already');
});
scene('init.nothing', async (place) => show(await initial(place, ['--restore']), 'nothing to restore'));
scene('init.legacy', async (place) => show(
  await initial(place, ['--restore'], owner, place.home, () => ({ kind: 'legacy' })),
  'approved before records were signed',
));
scene('init.refused', async (place) => show(
  await initial(place, ['--restore'], owner, place.home, () => ({ kind: 'refused', why: 'the stored record does not verify' })),
  'does not verify',
));
scene('init.restore-invalid', async (place) => {
  // A verified record whose stored copy no longer validates: refused, and nothing is written.
  const copy = 'format: [\n';
  write(place, TEAM);
  const loaded = loadTeamFile(place.root, { file: place.file, home: place.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  rmSync(place.file);
  const standing = { kind: 'verified' as const, record: { approval: approvalOf(loaded.team, loaded.root, NOW), file: copy }, generation: 1, signedAt: NOW.toISOString() };
  const ran = show(await initial(place, ['--restore'], owner, place.home, () => standing), "the stored copy doesn't validate");
  expect(existsSync(place.file)).toBe(false);
  return ran;
});
scene('init.wrote', async (place) => show(await initial(place, []), 'Wrote'));
scene('init.approval', async (place) => show(await initial(place, ['--approvals']), 'team-create approval rules'));
scene('init.approval-refused', async (place) => show(await initial(place, ['--revoke-approval', 'nope']), 'is not a rule id'));
scene('init.restored', async (place) => {
  approve(place, TEAM);
  rmSync(place.file);
  return show(await initial(place, ['--restore']), 'Restored');
});

/** An archive of `text`, written by the real writer: its manifest, its hashes and its folder are
 *  the ones a restore reads, so a scene never plants a hand-made stand-in for them. */
function archiveIn(place: Place, text: string): string {
  const root = join(place.base, 'archived');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const written = writeArchive({
    file: join(root, '.agents', 'team.yaml'),
    root,
    project: 'acme',
    session: 'acme',
    home: place.home,
    out: join(place.home, '.config', 'team', 'archive'),
    caller: 'owner',
    now: NOW,
    dry: false,
  });
  if (!written.ok) throw new Error(written.reason);
  return written.dir;
}

scene('init.sources', async (place) => show(
  await initial(place, ['--restore', '--from-archive', join(place.base, 'somewhere')]),
  'two sources',
));
scene('init.from-archive', async (place) => show(
  await initial(place, ['--from-archive', join(place.base, 'missing')]),
  'nothing was restored',
));
scene('init.from-archive-invalid', async (place) => {
  const dir = archiveIn(place, 'format: 1\nproject: acme\nseats: nope\n');
  return show(await initial(place, ['--from-archive', dir]), "doesn't validate");
});
scene('init.restored-archive', async (place) => {
  const dir = archiveIn(place, readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8'));
  return show(await initial(place, ['--from-archive', dir]), 'from an archive');
});
scene('init.skeleton', async (place) => {
  const root = join(place.base, 'a b');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  return show(await entry(['init'], testIo(root, owner)), "doesn't validate");
});
scene('init.git-silent', async (place) => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const bin = join(place.base, 'bin');
  mkdirSync(bin);
  const saved = process.env.PATH ?? '';
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "-C" ]; then exit 1; fi
done
PATH=${JSON.stringify(saved)} exec git "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const program = `
    import { main, reportFailure } from ${JSON.stringify(join(repo, 'src/cli.ts'))};
    let out = '', err = '';
    const io = {
      stdout(text) { out += text; }, stderr(text) { err += text; },
      cwd: ${JSON.stringify(place.root)}, env: {}, stdinIsTTY: false, caller: { kind: 'owner' },
    };
    let code;
    try { code = await main(['init'], io); }
    catch (error) { code = reportFailure(error, (text) => { err += text; }); }
    console.log(JSON.stringify({ code, out, err }));
  `;
  const proc = Bun.spawn(['bun', '-e', program], {
    cwd: repo, env: { ...process.env, PATH: `${bin}:${saved}` }, stdout: 'pipe', stderr: 'pipe',
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  const parsed = JSON.parse(out) as Ran;
  return show(parsed, "doesn't answer");
});

async function removed(place: Place, argv: string[], caller: Caller, sources: RemoveSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runRemove(argv, io, { ...sources, home: sources.home ?? place.home }), out: io.out, err: io.err };
}

scene('remove.invocation', async (place) => show(await removed(place, [], owner, downSources()), 'a seat name is required'));
scene('remove.client-refused', async (place) => show(await removed(place, ['worker', '--client', 'missing-grant.json', '--key', 'missing.key', '--team', 'acme'], detachedCaller, downSources()), 'no client grant can verify'));
scene('remove.not-a-repo', async (place) => show(await removed(place, ['worker'], owner, downSources()), 'not inside a git repository'), false);
scene('remove.file', async (place) => show(await removed(place, ['worker', '--file', 'missing.yaml'], owner, downSources()), 'no team file'));
scene('remove.file-invalid', async (place) => {
  invalid(place);
  return show(await removed(place, ['worker', '--file', 'team.yaml'], owner, downSources()), 'line');
});
scene('remove.file-owner', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker', '--file', '.agents/team.yaml'], other, downSources({ home: place.home })), "--file is the owner's");
});
scene('remove.caller', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker'], other, downSources({ home: place.home })), 'only the owner or `leads` removes a seat');
});
scene('remove.no-pane', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker'], leadSeat, downSources({ home: place.home })), 'no pane is recorded for seat lead');
});
scene('remove.session-owner', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker', '--session', 'other'], leadSeat, downSources({ home: place.home })), "--session is the owner's");
});
scene('remove.another-pane', async (place) => {
  write(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w2:p1' };
  });
  return show(await removed(place, ['worker'], leadSeat, downSources({ home: place.home })), 'the state records pane w2:p1 for seat lead');
});
scene('remove.default-session', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker', '--session', 'default'], owner, downSources({ home: place.home })), 'can\'t be "default"');
});
scene('remove.abandon', async (place) => {
  write(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
  return show(await removed(place, ['worker', '--abandon'], leadSeat, downSources({ home: place.home })), 'only the owner abandons');
});
scene('remove.coordinator', async (place) => {
  write(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
  return show(await removed(place, ['lead'], leadSeat, downSources({ home: place.home })), 'only the owner removes the orchestrator');
});
// A lead's `--keep` is a swap. The seat never swaps itself; another lead swaps it only
// under a grant that lists `swap`; the owner's swap stops it and leaves the file as it was.
scene('remove.swap-self', async (place) => {
  write(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
  return show(await removed(place, ['lead', '--keep'], leadSeat, downSources({ home: place.home })), "can't swap its own seat");
});
scene('remove.swap-grant', async (place) => {
  write(place, TWO.replace('operator: lead', 'operator: worker').replace('    stopped: true\n', ''));
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
  return show(await removed(place, ['worker', '--keep'], leadSeat, downSources({ home: place.home })), 'swaps the orchestrator');
});
scene('remove.no-seat', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['missing'], owner, downSources({ home: place.home })), 'no seat "missing"');
});
scene('remove.keep-temporary', async (place) => {
  approve(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = { stage: 'ready', temporary: { like: 'lead', until: 'result:out.md' } };
  });
  return show(await removed(place, ['worker', '--keep'], owner, downSources({ home: place.home })), 'nothing to keep');
});
scene('remove.herdr', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({ sessionRunning: () => null, home: place.home })), "doesn't answer");
});
scene('remove.agents', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({ sessionRunning: () => true, agents: () => null, home: place.home })), "can't be read");
});
scene('remove.busy', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('worker', 'working')], screen: () => ({ kind: 'working' }), home: place.home,
  })), 'is working');
});
scene('remove.edit', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['lead'], owner, downSources({ home: place.home })), 'coordinator "lead"');
});
scene('remove.endpoint', async (place) => {
  // A managed seat whose pane is left running keeps its endpoint record, so the seat stays too.
  const humanWorker = WORKER.replace('    stopped: true\n', '    human: true\n');
  approve(place, TWO.replace(WORKER, humanWorker));
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.worker = {
      stage: 'ready',
      pane: 'w1:p1',
      presence_binding: 'prs_ab12cd34ef56',
      codex_endpoint: {
        url: 'unix:///tmp/acme/run/acme/worker/ab12cd34ef56.sock',
        binding: 'prs_ab12cd34ef56',
        pid: 4242,
        started_at: '2026-10-04T08:00:00Z',
      },
    };
  });
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('worker')], home: place.home,
  })), 'records a managed Codex endpoint');
});
scene('remove.unverified', async (place) => {
  approve(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.extra = { stage: 'ready' };
  });
  return show(await removed(place, ['extra'], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('extra')], home: place.home,
  })), 'not a declared seat');
});
scene('remove.ambiguous', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true,
    agents: () => [agent('worker'), { ...agent('worker'), pane: 'w2:p1' }],
    home: place.home,
  })), 'more than one agent of this name');
});
scene('remove.never-approved', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    home: place.home,
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified' }),
  })), 'cannot be verified');
});
scene('remove.no-launch', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('worker')], home: place.home,
  })), 'no way to reach herdr');
});
scene('remove.stop-failed', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true,
    agents: () => [agent('worker')],
    home: place.home,
    launch: downLaunch({ typeText: () => false }),
  })), 'its exit was not typed');
});
scene('remove.locked', async (place) => {
  approve(place, TWO);
  // The pane's box, physically: empty before the typing, holding the exit text after it.
  let letBox: string | undefined = claudeBox('');
  const swapped = `format: 1
project: acme
coordinator: worker
operator: worker
workspace:
  mode: shared
seats:
  - role: coordinator
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true,
    agents: () => [agent('worker')],
    home: place.home,
    screenText: () => letBox,
    launch: downLaunch({
      typeText() {
        writeFileSync(place.file, swapped);
        letBox = claudeBox('/exit');
        return true;
      },
      sendKey: () => { letBox = claudeBox(''); return true; },
    }),
  })), 'coordinator "worker"');
});
scene('remove.removed', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({ home: place.home })), 'removed worker');
});
scene('remove.run-lock', async (place) => {
  approve(place, TWO);
  // The session mutator lock another run holds, in the file every session mutator shares: this
  // test process's pid is alive, so the token is never judged stale. The never-approved refusal
  // is decided before the lock; this scene is an approved, ordinary removal that meets it.
  const dir = join(place.root, '.agents');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  writeFileSync(seatLockPath(dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
  return show(await removed(place, ['worker'], owner, downSources({ home: place.home })), 'another session-mutating run is holding');
});
scene('remove.kept', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker', '--keep'], owner, downSources({ home: place.home })), 'stopped worker');
});
scene('remove.swapped', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['lead', '--keep'], owner, downSources({ home: place.home })), 'stopped lead for a swap');
});
scene('remove.temporary', async (place) => {
  approve(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = { stage: 'ready', temporary: { like: 'lead', until: 'result:out.md' } };
  });
  return show(await removed(place, ['worker', '--abandon'], owner, downSources({ home: place.home })), 'removed temporary worker');
});

// The delegated `remove`: the same shape as add's scenes above, with the verdicts the gate gives
// this command. `delegate-approval` runs the real gate, which refuses on its first read before
// herdr is asked; the rest hand the verdict in, and the scene proves the command prints it and
// exits 1 with nothing stopped.
const REMOVE_GATE_REFUSALS: [suffix: string, sentence: string, needle: string][] = [
  ['delegate-evidence', "delegation cannot verify its placement or seats: herdr doesn't answer", 'placement or seats'],
  ['delegate-placement', 'the approved delegate must be an external non-seat pane', 'non-seat pane'],
  ['delegate', 'only the owner, the orchestrator, the operator or the approved delegate runs it; this call is pilot', 'or the approved delegate runs it'],
  ['delegate-command', 'the approved delegate main/w1:p1 may not run `remove`; its approved commands are add', 'may not run'],
];
for (const [suffix, sentence, needle] of REMOVE_GATE_REFUSALS) {
  scene(`remove.${suffix}`, async (place) => {
    write(place, DELEGATED_ADD_REMOVE);
    return show(await removed(place, ['worker'], addRemoveCaller, downSources({
      home: place.home,
      delegateGate: () => refused(`remove.${suffix}`, sentence),
    })), needle);
  });
}
scene('remove.delegate-flag', async (place) => {
  write(place, DELEGATED_ADD_REMOVE);
  return show(await removed(place, ['worker', '--keep'], addRemoveCaller, downSources({
    home: place.home,
    delegateGate: () => refused('remove.delegate-flag', "--keep is the owner's; the approved delegate cannot use it"),
  })), 'cannot use it');
});
scene('remove.delegate-approval', async (place) => {
  write(place, DELEGATED_ADD_REMOVE);
  return show(await removed(place, ['worker'], addRemoveCaller, downSources({ home: place.home })), 'delegation needs a verified approval');
});

const RELEASE_TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
releases:
  - package: material
    github: floor/material
    trusted_publishing: true
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

async function released(place: Place, argv: string[], answers: Answers): Promise<Ran> {
  const io = testIo(place.root, owner);
  const { fetcher } = fakeFetch(answers);
  return { code: await runRelease(argv, io, fetcher), out: io.out, err: io.err };
}

scene('release.passed', async (place) => {
  write(place, RELEASE_TEAM);
  return show(await released(place, ['check', 'material@3.0.2'], happy()), 'pass');
});
scene('release.missing', async (place) => {
  write(place, RELEASE_TEAM);
  const answers = happy();
  answers.set(URLS.compare, json({ ...fixture('github-compare.json'), status: 'behind' }));
  return show(await released(place, ['check', 'material@3.0.2'], answers), 'missing');
});
scene('release.unknown', async (place) => {
  write(place, RELEASE_TEAM);
  const answers = happy();
  answers.set(URLS.npm, [json({}, 500), json({}, 500)]);
  return show(await released(place, ['check', 'material@3.0.2'], answers), 'unknown');
});
scene('release.configuration', async (place) => {
  write(place, 'format: [\n');
  return show(await released(place, ['check', 'material@3.0.2'], new Map()), 'line');
});
scene('release.usage', async (place) => show(await released(place, [], new Map()), 'a subcommand is required'));

async function status(place: Place, argv: string[], sources: StatusSources, caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runStatus(argv, io, sources), out: io.out, err: io.err };
}

scene('status.invocation', async (place) => show(await status(place, ['extra'], statusSources(quiet)), 'unexpected'));
scene('status.not-a-repo', async (place) => show(await status(place, [], statusSources(quiet)), 'not inside a git repository'), false);
scene('status.file', async (place) => show(await status(place, ['--file', 'missing.yaml'], statusSources(quiet)), 'no team file'));
scene('status.file-invalid', async (place) => {
  invalid(place);
  return show(await status(place, ['--file', 'team.yaml'], statusSources(quiet)), 'line');
});
scene('status.herdr', async (place) => {
  write(place, TEAM);
  return show(await status(place, [], statusSources(null)), "doesn't answer");
});
scene('status.agrees', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
  });
  const matched: Live = {
    running: true,
    agents: [agent('lead')],
    workspaces: [{ id: 'w1', label: 'lead' }],
    screens: {},
  };
  approve(place, TEAM);
  const standing = approvalStanding(place.root, place.home);
  return show(await status(place, [], statusSources(matched, standing)), 'no differences');
});
scene('status.difference', async (place) => {
  write(place, TEAM);
  return show(await status(place, [], statusSources(quiet)), 'is in the file and is not running');
});
scene('status.file-owner', async (place) => show(await status(place, ['--file', '.agents/team.yaml'], statusSources(quiet), other), "--file is the owner's"));
scene('status.client-refused', async (place) => show(await status(place, ['--client', 'missing-grant.json', '--key', 'missing.key'], { ...statusSources(quiet), home: place.home }, detachedCaller), 'no client grant can verify'));
scene('status.session-owner', async (place) => show(await status(place, ['--session', 'team'], statusSources(quiet), other), "--session is the owner's"));
scene('status.not-yours', async (place) => {
  // A caller that does not pass learns nothing, even when the target does not load: the answer is
  // the one fixed sentence, byte for byte, on stderr, and nothing else anywhere.
  const ran = await status(place, [], { ...statusSources(quiet), home: place.home, gate: { standing: () => ({ kind: 'none' }) } }, other);
  expect(ran.err).toBe('team status: this team is not yours to read\n');
  expect(ran.out).toBe('');
  return ran;
});
scene('status.project-listed', async (place) => {
  // One of the project's two teams is registered; the other is not, and is said as such. The
  // project path reads the registry wherever the run stands: no team file is written.
  upsertTeam(place.home, TEAM_A, {
    project: 'TeamCLI',
    session: 'teamcli',
    root: place.root,
    roster: [{ agent: 'agt_1', seat: 'lead', role: 'coordinator', leads: true }],
  });
  const ran = await status(place, ['--project', 'TeamCLI'], { ...statusSources(quiet), projects: projectSources(), home: place.home });
  expect(ran.out).toContain('project TeamCLI  4f2a1b7c9d0e');
  expect(ran.out).toContain(`  ${TEAM_A}  session "teamcli"  defined  1 seat`);
  expect(ran.out).toContain(`  ${TEAM_B}  not registered`);
  return show(ran, 'lead agt_2b9f');
});
scene('status.project-unknown', async (place) => show(
  await status(place, ['--project', 'nope'], { ...statusSources(quiet), projects: projectSources(), home: place.home }),
  'no project named "nope"',
));

async function projects(place: Place, argv: string[], sources: ProjectSources, caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runProjects(argv, io, sources), out: io.out, err: io.err };
}

scene('projects.invocation', async (place) => show(await projects(place, ['extra'], projectSources()), 'unexpected'));
scene('projects.listed', async (place) => {
  const empty = await projects(place, [], { ...projectSources(), list: () => [] });
  expect(empty.code).toBe(0);
  expect(empty.out).toBe('ID  NAME  ENTITY  LEAD  TEAMS\n0 projects\n');
  const ran = await projects(place, [], projectSources());
  expect(ran.out).toContain('TeamCLI');
  expect(ran.out).toContain(TEAM_A);
  expect(ran.out).toContain(TEAM_B);
  return show(ran, '4f2a1b7c9d0e');
});
scene('projects.unreadable', async (place) => show(
  await projects(place, [], {
    ...projectSources(),
    list: () => { throw new ProjectsError(`${projectsFile(place.home)}: line 2: "projects" must be a map`); },
  }),
  'the project registry cannot be read',
));

async function seats(place: Place, argv: string[], sources: SeatsSources, caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runSeats(argv, io, sources), out: io.out, err: io.err };
}

scene('seats.invocation', async (place) => show(await seats(place, ['extra'], statusSources(quiet)), 'unexpected'));
scene('seats.client-refused', async (place) => show(await seats(place, ['--client', 'missing-grant.json', '--key', 'missing.key'], { ...statusSources(quiet), home: place.home }, detachedCaller), 'no client grant can verify'));
scene('seats.not-a-repo', async (place) => show(await seats(place, [], statusSources(quiet)), 'not inside a git repository'), false);
scene('seats.file', async (place) => show(await seats(place, ['--file', 'missing.yaml'], statusSources(quiet)), 'no team file'));
scene('seats.file-invalid', async (place) => {
  invalid(place);
  return show(await seats(place, ['--file', 'team.yaml'], statusSources(quiet)), 'line');
});
scene('seats.herdr', async (place) => {
  write(place, TEAM);
  return show(await seats(place, [], statusSources(null)), "doesn't answer");
});
scene('seats.shown', async (place) => {
  write(place, TEAM);
  return show(await seats(place, [], statusSources(quiet)), 'SEAT');
});
scene('seats.file-owner', async (place) => show(await seats(place, ['--file', '.agents/team.yaml'], statusSources(quiet), other), "--file is the owner's"));
scene('seats.session-owner', async (place) => show(await seats(place, ['--session', 'team'], statusSources(quiet), other), "--session is the owner's"));
scene('seats.not-yours', async (place) => {
  const ran = await seats(place, [], { ...statusSources(quiet), home: place.home, gate: { standing: () => ({ kind: 'none' }) } }, other);
  expect(ran.err).toBe('team seats: this team is not yours to read\n');
  expect(ran.out).toBe('');
  return ran;
});

{
  async function configRun(place: Place, argv: readonly string[]): Promise<Ran> {
    const io = testIo(place.root, owner);
    return { code: await runConfig([...argv], io), out: io.out, err: io.err };
  }
  scene('config.invocation', async (place) => show(await configRun(place, []), 'a subcommand is required'));
  scene('config.shown', async (place) => show(await configRun(place, ['keys']), 'delivery_order'));
  async function recordRun(place: Place, argv: readonly string[], caller: Caller = owner, editor?: (path: string) => number, registry = false): Promise<Ran> {
    const io = testIo(place.root, caller);
    const env = { ...process.env, TEAM_CONFIG_SOURCE: registry ? 'registry' : 'file' };
    return { code: await runConfig([...argv], io, { home: place.home, env, now: () => NOW, ...(editor ? { editor } : {}) }), out: io.out, err: io.err };
  }
  scene('config.usage', async (place) => show(await recordRun(place, ['set', 'watch']), 'a value is required'));
  scene('config.no-team', async (place) => show(await recordRun(place, ['get', 'project']), 'no team is registered'));
  scene('config.unreadable', async (place) => {
    write(place, TEAM);
    await imported(place, 'migrate', []);
    corruptTeamRecord(place);
    return show(await recordRun(place, ['get', 'project'], owner, undefined, true), 'cannot be read');
  });
  scene('config.no-value', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['get', 'watch.missing']), 'watch.missing is not set');
  });
  scene('config.value', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['get', 'project']), 'acme');
  });
  scene('config.detached', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['set', 'project', 'other'], detachedCaller), 'terminal');
  });
  scene('config.not-owner', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['set', 'project', 'other'], other), "only the owner edits the team's record");
  });
  scene('config.editor', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['edit'], owner, () => 3), 'the editor exited 3');
  });
  scene('config.path', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['set', 'seats.ghost.cli', 'claude-code']), 'has no item named "ghost"');
  });
  scene('config.unchanged', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['set', 'project', 'acme']), 'nothing changed');
  });
  scene('config.invalid', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['set', 'format', '9']), 'does not validate');
  });
  scene('config.written', async (place) => {
    write(place, TEAM);
    return show(await recordRun(place, ['set', 'seats.lead.label', 'boss']), 'set seats.lead.label');
  });
}

/** A home whose registry holds the owner's key and one registered `lead` agent in the roster,
 *  so a settings write has a record to land in. */
function registeredSeat(place: Place): string {
  installKey(place.home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const agentId = registerAgent(place.home, {
    name: 'Lead One',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: 'acme', seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
  upsertTeam(place.home, teamIdOf(place.root), {
    project: 'acme',
    session: 'acme',
    root: place.root,
    lobby: '',
    roster: [{ agent: agentId, seat: 'lead', role: 'coordinator' }],
  });
  return agentId;
}

/** A home whose registry holds one signed seat setting for `lead`, tampered so the record no
 *  longer verifies: the settings reads must refuse it rather than fall back to the file. */
function tamperedSeatSetting(place: Place): void {
  const agentId = registeredSeat(place);
  const plan = planConfigSet(place.home, {
    level: 'seat',
    target: agentId,
    settings: [{ key: 'model', value: 'claude-opus-5-5' }],
  });
  if (!plan.ok) throw new Error(`plan refused: ${plan.why}`);
  const written = writeConfigSet(place.home, plan, { now: NOW });
  if (!written.ok) throw new Error(`write refused: ${written.why}`);
  const path = join(agentsDir(place.home), `${agentId}.yaml`);
  const text = readFileSync(path, 'utf8');
  // The fixture's launch line carries the same model name, so the tamper targets the settings
  // entry's own `value:` line; the first match would land on `launch` and leave the record
  // verifying.
  const tampered = text.replace('value: "claude-opus-5-5"', 'value: "claude-haiku-5-5"');
  if (tampered === text) throw new Error('the record has no value to tamper');
  writeFileSync(path, tampered);
}

{
  async function settingsRun(
    place: Place,
    argv: readonly string[],
    caller: Caller = owner,
    over: SettingsCommandOptions = {},
  ): Promise<Ran> {
    const io = testIo(place.root, caller);
    return {
      code: await runSettings([...argv], io, { home: place.home, now: NOW, ...over }),
      out: io.out,
      err: io.err,
    };
  }
  scene('settings.invocation', async (place) => show(await settingsRun(place, []), 'a seat name is required'));
  scene('settings.file-owner', async (place) => show(await settingsRun(place, ['lead', '--file', '.agents/team.yaml'], other), "--file is the owner's"));
  scene('settings.not-a-repo', async (place) => show(await settingsRun(place, ['lead']), 'not inside a git repository'), false);
  scene('settings.file', async (place) => show(await settingsRun(place, ['lead', '--file', 'missing.yaml']), 'no team file'));
  scene('settings.file-invalid', async (place) => {
    invalid(place);
    return show(await settingsRun(place, ['lead', '--file', 'team.yaml']), 'line');
  });
  scene('settings.not-yours', async (place) => {
    write(place, TEAM);
    return show(
      await settingsRun(place, ['lead'], other, { gate: { standing: () => ({ kind: 'none' }) } }),
      'this team is not yours to read',
    );
  });
  scene('settings.no-seat', async (place) => {
    write(place, TEAM);
    return show(await settingsRun(place, ['ghost']), 'no seat "ghost" is declared in acme');
  });
  scene('settings.shown', async (place) => {
    write(place, TEAM);
    return show(await settingsRun(place, ['lead']), 'delivery_order');
  });
  scene('settings.source', async (place) => {
    write(place, TEAM);
    tamperedSeatSetting(place);
    return show(await settingsRun(place, ['lead']), 'signature verification failed for setting "model"');
  });
  scene('settings.set', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(await settingsRun(place, ['set', 'lead', 'nickname=Atlas']), 'settings: set nickname=Atlas at seat (lead)');
  });
  scene('settings.unset', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    const set = await settingsRun(place, ['set', 'lead', 'nickname=Atlas']);
    if (set.code !== 0) throw new Error(`the set before the unset failed: ${set.err}`);
    return show(await settingsRun(place, ['unset', 'lead', 'nickname']), 'settings: unset nickname at seat (lead)');
  });
  scene('settings.dry-run', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(
      await settingsRun(place, ['set', 'lead', 'nickname=Atlas', '--dry-run']),
      'settings: would set nickname=Atlas at seat (lead)',
    );
  });
  scene('settings.key', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(await settingsRun(place, ['set', 'lead', 'nope=1']), 'unknown setting "nope"');
  });
  scene('settings.value', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(await settingsRun(place, ['set', 'lead', 'model=nope']), 'unknown model "nope" for claude-code');
  });
  scene('settings.policy', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(
      await settingsRun(place, ['set', 'lead', 'delivery_order=drop']),
      'loosens policy "delivery-order"',
    );
  });
  scene('settings.not-owner', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(await settingsRun(place, ['set', 'lead', 'nickname=Atlas'], other), 'only the owner sets a seat');
  });
  scene('settings.no-agent', async (place) => {
    write(place, TEAM);
    // The seat is declared and never launched, so the first set bootstraps its record; a path
    // where the agent registry belongs cannot hold it, and the refusal names that instead.
    mkdirSync(join(place.home, '.config', 'team'), { recursive: true });
    writeFileSync(join(place.home, '.config', 'team', 'agents'), 'not a directory');
    return show(await settingsRun(place, ['set', 'lead', 'nickname=Atlas']), 'has no registered agent record');
  });
  scene('settings.not-set', async (place) => {
    write(place, TEAM);
    registeredSeat(place);
    return show(await settingsRun(place, ['unset', 'lead', 'model']), 'is not set at level seat');
  });
}

{
  async function seatRun(
    place: Place,
    argv: readonly string[],
    caller: Caller = owner,
    sources: SeatsSources = statusSources(quiet),
  ): Promise<Ran> {
    const io = testIo(place.root, caller);
    return { code: await runSeat([...argv], io, sources), out: io.out, err: io.err };
  }
  scene('seat.invocation', async (place) => show(await seatRun(place, []), 'a seat name is required'));
  scene('seat.client-refused', async (place) => show(await seatRun(place, ['lead', '--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller, { ...statusSources(quiet), home: place.home }), 'no client grant can verify'));
  scene('seat.file-owner', async (place) => show(await seatRun(place, ['lead', '--file', '.agents/team.yaml'], other), "--file is the owner's"));
  scene('seat.session-owner', async (place) => show(await seatRun(place, ['lead', '--session', 'acme'], other), "--session is the owner's"));
  scene('seat.not-a-repo', async (place) => show(await seatRun(place, ['lead']), 'not inside a git repository'), false);
  scene('seat.file', async (place) => show(await seatRun(place, ['lead', '--file', 'missing.yaml']), 'no team file'));
  scene('seat.file-invalid', async (place) => {
    invalid(place);
    return show(await seatRun(place, ['lead', '--file', 'team.yaml']), 'line');
  });
  scene('seat.not-yours', async (place) => {
    write(place, TEAM);
    return show(
      await seatRun(place, ['lead'], other, {
        ...statusSources(quiet),
        home: place.home,
        gate: { standing: () => ({ kind: 'none' }) },
      }),
      'this team is not yours to read',
    );
  });
  scene('seat.no-seat', async (place) => {
    write(place, TEAM);
    return show(await seatRun(place, ['ghost']), 'no seat "ghost" is declared in acme');
  });
  scene('seat.herdr', async (place) => {
    write(place, TEAM);
    return show(await seatRun(place, ['lead'], owner, statusSources(null)), "doesn't answer");
  });
  scene('seat.sessions', async (place) => {
    write(place, TEAM);
    const log = sessionsRegistry(place);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(join(place.base, 'real-sessions.jsonl'), '');
    symlinkSync(join(place.base, 'real-sessions.jsonl'), log);
    return show(
      await seatRun(place, ['lead'], owner, { ...statusSources(quiet), home: place.home }),
      'a symbolic link was found and not followed',
    );
  });
  scene('seat.shown', async (place) => {
    write(place, TEAM);
    return show(await seatRun(place, ['lead']), 'delivery_order');
  });
  scene('seat.source', async (place) => {
    write(place, TEAM);
    tamperedSeatSetting(place);
    return show(
      await seatRun(place, ['lead'], owner, { ...statusSources(quiet), home: place.home }),
      'signature verification failed for setting "model"',
    );
  });
}

async function up(place: Place, argv: string[], caller: Caller, sources: UpSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return runCompared(place, argv, (args) => runUp(args, io, sources), io);
}

scene('up.invocation', async (place) => show(await up(place, ['extra'], owner, upSources(place)), 'unexpected'));
scene('up.not-a-repo', async (place) => show(await up(place, [], owner, upSources(place)), 'not inside a git repository'), false);
scene('up.file', async (place) => show(await up(place, ['--file', 'missing.yaml'], owner, upSources(place)), 'no team file'));
scene('up.file-invalid', async (place) => {
  invalid(place);
  return show(await up(place, ['--file', 'team.yaml'], owner, upSources(place)), 'line');
});
scene('up.client-refused', async (place) => show(await up(place, ['--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller, upSources(place)), 'no client grant can verify'));
scene('up.dry-run', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--dry-run', '--file', place.file], owner, upSources(place)), 'dry run: nothing was run');
});
scene('up.not-owner', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], other, upSources(place)), 'deny');
});
scene('up.deny', async (place) => {
  write(place, TEAM);
  return show(await up(place, [], other, upSources(place)), 'deny');
});
scene('up.never-approved', async (place) => {
  write(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, {
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified' }),
  })), 'cannot be verified');
});
scene('up.doctor', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { doctor: doctor(place.home, { version: () => null }) })), 'install');
});
scene('up.machine', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { machine: () => hot })), 'the load is 9.0');
});
scene('up.herdr', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { sessionRunning: () => null })), "doesn't answer");
});
scene('up.stopped', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { sessionState: () => 'stopped' })), 'is stopped');
});
scene('up.clear', async (place) => {
  approve(place, TEAM);
  writeFileSync(
    join(place.root, '.agents/team.state.json'),
    JSON.stringify({ format: 1, sessions: { acme: { seats: {}, worktrees: {} } } }),
  );
  const launch = launching(IDLE);
  launch.deleteSession = () => false;
  return show(await up(place, ['--file', place.file], owner, upSources(place, {
    sessionState: () => 'stopped',
    launch,
  })), 'did not clear');
});
scene('up.agents', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { sessionState: () => 'running', agents: () => null })), "can't be read");
});
scene('up.run-lock', async (place) => {
  approve(place, TEAM);
  // The session mutator lock another run holds: this test process's pid is alive, so the token is
  // never judged stale. It sits where the run looks for it — the session's lock folder beside
  // the state, the session defaulting to the project's name — and nothing else is stood in.
  const dir = join(place.root, '.agents');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  writeFileSync(seatLockPath(dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { launch: launching(IDLE) })), 'another session-mutating run is holding');
});
scene('up.lobby', async (place) => {
  // The lead starts in the project. The worker is the seat that starts in the lobby, so the
  // make under the run lock is the one made to fail. `mkdir` is the only call stood in.
  approve(place, TWO.replace('    stopped: true\n', ''));
  const fs = {
    ...defaultFs,
    mkdir() {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  return show(await up(place, ['--file', place.file], owner, upSources(place, { launch: launching(IDLE), fs })), 'failed to create');
});
scene('up.unknown', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, {
    sessionState: () => 'running', agents: () => [agent('stranger')],
  })), "doesn't record");
});
scene('up.placement', async (place) => {
  approve(place, narrow(place));
  return show(await up(place, ['--file', place.file], owner, upSources(place)), 'inside the protected checkout');
});
scene('up.no-launch', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place)), 'no way to reach herdr');
});
scene('up.ready', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { launch: launching(IDLE) })), 'ready');
});
scene('up.pending', async (place) => {
  approve(place, TEAM);
  // §3: a seat that never idles now stops at the pause's `timeout` classification, asked of its
  // owner, instead of a bare timed-out record. The code and the row's meaning are unchanged.
  // The ask goes to this scene's own terminal — never the test process's stdin — and nobody is
  // there to press a key: its input ends, the one answer a run with nobody at the terminal gets.
  // The read is asserted, so a pause that quietly reached for stdin would fail this scene.
  const terminal = ownerTerminal(['eof']);
  const ran = await up(place, ['--file', place.file], owner, upSources(place, { launch: launching(''), terminal: () => terminal }));
  expect(terminal.reads).toBe(1);
  return show(ran, 'waiting at timeout');
});
scene('up.server', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, { launch: launching(IDLE, () => true, false) })), 'its server did not start');
});
scene('up.watch', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--file', place.file], owner, upSources(place, {
    launch: launching(IDLE, (command) => !command.includes(' watch')),
  })), 'watch: it did not start');
});

// §RFC0007: one run per delegate refusal of `up`. The gate is the real one in every scene — the
// command calls it with no stand-ins of its own — and only the reads it cannot make here are
// stood in: the approval store this harness owns (the gate reads the user's own), and herdr,
// which no scene here has. `DELEGATES` names an external pane whose commands list `up`; the
// approved copy holds the same text, so no scene drifts.
const DELEGATES = `\ndelegates:\n  - pane: main/w1:p1\n    commands: [up]\n`;
const delegateCaller = { kind: 'seat', name: 'other', pane: 'w1:p1', session: 'main' } as const;
const gateAt = (place: Place, over: DelegateSources = {}): Partial<UpSources> => ({
  delegateGate: (input) => delegateGate({ ...input, sources: { standing: () => approvalStanding(input.root, place.home), ...over } }),
});
scene('up.delegate-approval', async (place) => {
  write(place, `${TEAM}${DELEGATES}`);
  return show(await up(place, ['--file', place.file], other, upSources(place, gateAt(place))), 'deny');
});
scene('up.delegate-evidence', async (place) => {
  approve(place, `${TEAM}${DELEGATES}`);
  // A herdr that does not answer answers nothing: no agent list, and no session answer either —
  // a session herdr reports as not running has no seats, and would pass the gate.
  return show(await up(place, ['--file', place.file], other, upSources(place, gateAt(place, { agents: () => null, sessionRunning: () => null }))), 'deny');
});
scene('up.delegate', async (place) => {
  approve(place, `${TEAM}${DELEGATES}`);
  return show(await up(place, ['--file', place.file], other, upSources(place, gateAt(place, { agents: () => [] }))), 'deny');
});
scene('up.delegate-command', async (place) => {
  approve(place, `${TEAM}${DELEGATES.replace('commands: [up]', 'commands: [down]')}`);
  return show(await up(place, ['--file', place.file], delegateCaller, upSources(place, gateAt(place, { agents: () => [] }))), 'deny');
});
scene('up.delegate-flag', async (place) => {
  approve(place, `${TEAM}${DELEGATES}`);
  return show(await up(place, ['--session', 'elsewhere'], delegateCaller, upSources(place, gateAt(place, { agents: () => [] }))), "--session is the owner's");
});

// The grant's refusals of `up`. The gate is the real one. A file that lists `grant` and a caller
// the ordinary rule refuses is judged by it; the approved copy is this harness's store.
const GRANTED = `${TEAM}grant:\n  session: acme\n  seat: lead\n  scope:\n    - up\n    - down\n`;
const GRANT_UP = `${TEAM}grant:\n  session: acme\n  seat: lead\n  scope:\n    - up\n`;
const GRANT_DOWN = `${TEAM}grant:\n  session: acme\n  seat: lead\n  scope:\n    - down\n`;

function grantRead(over: GrantSources = {}): Partial<UpSources> {
  return { grantGate: (input) => grantGate({ ...input, sources: over }) };
}

scene('up.grant-approval', async (place) => {
  write(place, GRANTED);
  return show(await up(place, [], leadSeat, upSources(place)), 'deny');
});
scene('up.grant-caller', async (place) => {
  approve(place, GRANTED);
  recordLead(place, 'w1:p1');
  return show(await up(place, [], other, upSources(place)), 'deny');
});
scene('up.grant-no-pane', async (place) => {
  approve(place, GRANTED);
  return show(await up(place, [], leadSeat, upSources(place)), 'deny');
});
scene('up.grant-another-pane', async (place) => {
  approve(place, GRANTED);
  recordLead(place, 'w2:p1');
  return show(await up(place, [], leadSeat, upSources(place)), 'deny');
});
scene('up.grant-scope', async (place) => {
  approve(place, GRANT_DOWN);
  recordLead(place, 'w1:p1');
  unlisted(place);
  return show(await up(place, [], leadSeat, upSources(place)), 'deny');
});
scene('up.grant-flag', async (place) => {
  approve(place, GRANTED);
  recordLead(place, 'w1:p1');
  return show(await up(place, ['--session', 'elsewhere'], leadSeat, upSources(place)), "--session is the owner's; the granted seat cannot use it");
});

async function watched(place: Place, argv: string[], caller: Caller, sources: WatchSources = watchSources()): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runWatch(argv, io, sources), out: io.out, err: io.err };
}

scene('watch.invocation', async (place) => show(await watched(place, ['extra'], owner), 'unexpected'));
scene('watch.not-a-repo', async (place) => show(await watched(place, [], owner), 'not inside a git repository'), false);
scene('watch.file', async (place) => show(await watched(place, ['--file', 'missing.yaml'], owner), 'no team file'));
scene('watch.file-invalid', async (place) => {
  invalid(place);
  return show(await watched(place, ['--file', 'team.yaml'], owner), 'line');
});
scene('watch.file-owner', async (place) => {
  write(place, TEAM);
  return show(await watched(place, ['--file', '.agents/team.yaml'], other), "--file is the owner's");
});
scene('watch.watchdog', async (place) => {
  // Beside the team file, where `up` writes it — the watch reads that state, not its start folder.
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watchdog = { file: join(place.root, 'custom', 'team.yaml'), pane: 'w2:p1' };
  });
  return show(await watched(place, ['--session', 'acme'], other), 'only the watch this session records');
});
scene('watch.no-nudge', async (place) => {
  write(place, TEAM);
  return show(await watched(place, ['--no-nudge'], other), '--no-nudge');
});
scene('watch.no-notify', async (place) => {
  write(place, TEAM);
  return show(await watched(place, ['--no-notify'], other), '--no-notify');
});
scene('watch.already', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 99, heartbeat: NOW.toISOString() };
  });
  return show(await watched(place, [], owner, watchSources({ alive: (pid) => pid === 99 })), 'already runs');
});
scene('watch.standby', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 99, heartbeat: NOW.toISOString() };
  });
  const stood: string[] = [];
  const hosted = {
    signal: new AbortController().signal,
    wait: async () => false,
    cycled: () => {},
    standby: (why: string) => void stood.push(why),
  };
  const ran = await watched(place, [], owner, watchSources({ alive: (pid) => pid === 99, hosted }));
  expect(stood).toEqual([`a watch already runs for the session "acme" (pid 99)`]);
  return ran;
});
scene('watch.stopped', async (place) => {
  write(place, TEAM);
  return show(await watched(place, [], owner), 'stopped');
});
scene('watch.workspace', async (place) => {
  write(place, TEAM);
  return show(await watched(place, [], owner, watchSources({
    createWorkspace: () => null,
    paneRun: () => false,
    watchCommand: () => 'team watch',
  })), 'did not start in its workspace');
});
scene('watch.started', async (place) => {
  write(place, TEAM);
  return show(await watched(place, [], owner, watchSources({
    createWorkspace: () => ({ pane: 'w2:p1', workspace: 'w2' }),
    paneRun: () => true,
    watchCommand: () => 'team watch',
  })), 'the watch runs in its own workspace');
});

// The hidden settings-file hook prints nothing by design, so its scenes assert the status and
// the spool the run leaves behind, never output. `--dir` is the team file's own folder.
const HOOK_BINDING = 'prs_0123456789ab';
function hooked(place: Place, words: string[]): Ran {
  return { code: runPresenceHook(['--dir', place.root, ...words]), out: '', err: '' };
}
scene('team.presence-hook-invalid', async (place) => {
  const ran = hooked(place, ['--session', 'crew', '--seat', 'writer', '--binding', 'not-a-binding', '--event', 'turn-end']);
  expect(existsSync(join(place.root, 'presence'))).toBe(false);
  return ran;
});
scene('team.presence-hook-ignored', async (place) => {
  // A notification that is not the measured permission prompt declines with exit 0 and stages
  // nothing: the payload filter, not the event word alone, is the whole condition.
  const code = runPresenceHook(
    ['--dir', place.root, '--session', 'crew', '--seat', 'writer', '--binding', HOOK_BINDING, '--event', 'human-wait', '--notification', 'permission_prompt'],
    () => JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
  );
  expect(existsSync(join(place.root, 'presence'))).toBe(false);
  return { code, out: '', err: '' };
});
scene('team.presence-hook-staged', async (place) => {
  const ran = hooked(place, ['--session', 'crew', '--seat', 'writer', '--binding', HOOK_BINDING, '--event', 'turn-end']);
  const spool = join(place.root, 'presence', 'crew', 'writer', 'spool');
  expect(readdirSync(spool).some((name) => name.endsWith('.json'))).toBe(true);
  return ran;
});
scene('team.presence-hook-refused', async (place) => {
  // The writer refuses the seat name before any folder is made: a record the contract's seat
  // rule rejects still leaves the hook exit 1, and the settings-file command ignores it.
  const ran = hooked(place, ['--session', 'crew', '--seat', 'not a seat', '--binding', HOOK_BINDING, '--event', 'turn-end']);
  expect(existsSync(join(place.root, 'presence'))).toBe(false);
  return ran;
});

async function used(place: Place, argv: string[], caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runUsage(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}

// The machine's report is reached by a seat as well: `usage` gates no caller, and a seat reads
// the restricted view of it. A folder with no team file is the same exit: the report prints and
// the one note says there is no project block from here.
scene('usage.block', async (place) => {
  write(place, TEAM);
  return show(await used(place, [], other), 'usage on this machine');
});
scene('usage.invocation', async (place) => show(await used(place, ['extra']), 'unexpected'));

async function listed(place: Place, argv: string[], sources: ListSources): Promise<Ran> {
  const io = testIo(place.root, owner);
  return { code: await runList(argv, io, sources), out: io.out, err: io.err };
}

const noTeam: ListSources = { sessions: () => [], roster: () => [], team: () => null };
scene('list.invocation', async (place) => show(await listed(place, ['--nope'], noTeam), 'unknown option'), false);
scene('list.herdr-down', async (place) => show(await listed(place, [], { ...noTeam, sessions: () => null }), 'herdr is not running'), false);
scene('list.empty', async (place) => show(await listed(place, [], noTeam), 'no running sessions\n0 sessions'), false);
scene('list.shown', async (place) => show(await listed(place, [], {
  sessions: () => [{ name: 'acme', running: true }],
  roster: () => [],
  team: () => null,
}), 'orphan'), false);
// The one refusal beside the invocation: the stores folder itself cannot be read. It is a file
// where the folder belongs, and the caller here is the owner, who alone reads its message.
scene('usage.store', async (place) => {
  mkdirSync(join(place.home, '.config'), { recursive: true });
  writeFileSync(join(place.home, '.config', 'team'), 'not a folder\n');
  return show(await used(place, []), 'the store folder');
});

async function worktree(place: Place, argv: string[], caller: Caller = owner, sources?: WorktreeSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runWorktree(argv, io, sources ?? worktreeSources(place)), out: io.out, err: io.err };
}

scene('worktree.invocation', async (place) => show(await worktree(place, ['--nope']), 'unknown option'));
scene('worktree.subcommand', async (place) => show(await worktree(place, []), 'a subcommand is required'));
scene('worktree.task-required', async (place) => show(await worktree(place, ['new']), 'a task name is required'));
scene('worktree.extra', async (place) => show(await worktree(place, ['new', 'task', 'extra']), 'unexpected'));
scene('worktree.remove-flags', async (place) => show(await worktree(place, ['remove', 'task', '--kind', 'fix']), 'remove takes no'));
scene('worktree.branch-flags', async (place) => show(await worktree(place, ['new', 'task', '--branch', 'fix/task']), 'takes no --branch'));
scene('worktree.not-a-repo', async (place) => show(await worktree(place, ['new', 'task']), 'not inside a git repository'), false);
scene('worktree.file', async (place) => show(await worktree(place, ['new', 'task', '--file', 'missing.yaml']), 'no team file'));
scene('worktree.file-invalid', async (place) => {
  invalid(place);
  return show(await worktree(place, ['new', 'task', '--file', 'team.yaml']), 'line');
});
scene('worktree.file-owner', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task', '--file', '.agents/team.yaml'], other), "--file is the owner's");
});
scene('worktree.caller', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task'], other), 'only the owner, the orchestrator or the operator');
});
scene('worktree.no-pane', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task'], leadSeat), 'no pane is recorded for seat lead');
});
scene('worktree.session-owner', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task', '--session', 'other'], leadSeat), "--session is the owner's");
});
scene('worktree.another-pane', async (place) => {
  approve(place, worktreeText());
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w2:p1' };
  });
  return show(await worktree(place, ['new', 'task'], leadSeat), 'the state records pane w2:p1 for seat lead');
});
scene('worktree.default-session', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task', '--session', 'default']), 'can\'t be "default"');
});
scene('worktree.never-approved', async (place) => {
  write(place, worktreeText());
  return show(await worktree(place, ['new', 'task'], owner, {
    ...worktreeSources(place),
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified' }),
  }), 'cannot be verified');
});
scene('worktree.task', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', '../task']), 'one segment');
});
scene('worktree.kind', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task', '--kind', '../fix']), '--kind:');
});
scene('worktree.shared', async (place) => {
  approve(place, worktreeText({ mode: 'shared' }));
  return show(await worktree(place, ['new', 'task']), 'workspace.mode is shared');
});
scene('worktree.config', async (place) => {
  approve(place, worktreeText({ path: null, base: null, sharedSeat: true }));
  return show(await worktree(place, ['new', 'task']), 'workspace.path and workspace.base are required');
});
scene('worktree.path-kind', async (place) => {
  approve(place, worktreeText({ path: '../worktrees/{repo}/{kind}/{task}' }));
  return show(await worktree(place, ['new', 'task']), 'fills {repo} and {task} only');
});
scene('worktree.kind-required', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task']), '--kind is required');
});
scene('worktree.kind-nowhere', async (place) => {
  approve(place, worktreeText({ branch: '{task}' }));
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'nowhere to go');
});
scene('worktree.placeholder', async (place) => {
  approve(place, worktreeText({ branch: '{nope}' }));
  return show(await worktree(place, ['new', 'task']), 'placeholder');
});
scene('worktree.forbidden', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'WEB-1', '--kind', 'fix']), 'forbidden_public');
});
scene('worktree.trust', async (place) => {
  approve(place, worktreeText({ trust: '../worktrees/acme/task' }));
  return show(await worktree(place, ['new', 'select-width', '--kind', 'fix']), "outside the file's trust paths");
});
scene('worktree.symlink', async (place) => {
  approve(place, worktreeText());
  const escaped = join(place.base, 'escaped');
  mkdirSync(escaped);
  symlinkSync(escaped, join(place.base, 'worktrees'));
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'symlink');
});
scene('worktree.seat', async (place) => {
  publish(place);
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task', '--kind', 'fix', '--seat', 'missing']), 'names no declared seat');
});
scene('worktree.limit', async (place) => {
  approve(place, worktreeText({ limit: 1 }));
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.worktrees.other = { path: '../worktrees/acme/other', branch: 'fix/other', setup: 'ok' };
  });
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'worktree limit is 1');
});
scene('worktree.recorded', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'already recorded');
});
scene('worktree.recorded-elsewhere', async (place) => {
  approve(place, worktreeText());
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.other ??= emptySession());
    session.worktrees.task = { path: '../worktrees/acme/task', branch: 'fix/task', setup: 'ok' };
  });
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'already recorded in session');
});
scene('worktree.exists', async (place) => {
  publish(place);
  approve(place, worktreeText());
  mkdirSync(join(place.base, 'worktrees', 'acme', 'task'), { recursive: true });
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'already exists');
});
scene('worktree.branch', async (place) => {
  publish(place);
  approve(place, worktreeText());
  git(place.root, 'branch', 'fix/task', 'main');
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'branch fix/task already exists');
});
scene('worktree.published', async (place) => {
  publish(place);
  approve(place, worktreeText());
  git(place.root, 'push', '-q', 'origin', 'main:fix/task');
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'already exists');
});
scene('worktree.branch-name', async (place) => {
  publish(place);
  approve(place, worktreeText({ branch: '{kind}/{task}.lock' }));
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'is not a branch name');
});
scene('worktree.base', async (place) => {
  publish(place);
  approve(place, worktreeText({ base: 'nosuch' }));
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'is not a branch here');
});
scene('worktree.tracking', async (place) => {
  publish(place);
  approve(place, worktreeText());
  git(place.root, 'branch', 'side', 'main');
  git(place.root, 'branch', '--set-upstream-to', 'side', 'main');
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), "isn't a remote branch");
});
scene('worktree.fetch', async (place) => {
  publish(place);
  approve(place, worktreeText());
  git(place.root, 'remote', 'set-url', 'origin', join(place.base, 'missing.git'));
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), "couldn't fetch");
});
scene('worktree.create-failed', async (place) => {
  publish(place);
  approve(place, worktreeText());
  const parent = join(place.base, 'worktrees', 'acme');
  mkdirSync(parent, { recursive: true });
  chmodSync(parent, 0o555);
  try {
    return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'was not created');
  } finally {
    chmodSync(parent, 0o755);
  }
});
scene('worktree.setup', async (place) => {
  publish(place);
  approve(place, worktreeText({ setup: '  setup:\n    - "false"\n' }));
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), 'setup failed');
});
scene('worktree.created', async (place) => {
  publish(place);
  approve(place, worktreeText());
  return show(await worktree(place, ['new', 'task', '--kind', 'fix']), '../worktrees/acme/task');
});
scene('worktree.listed', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['list']), '0 worktrees');
});
scene('worktree.remove-task', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['remove', '../task']), 'one segment');
});
scene('worktree.missing', async (place) => {
  approve(place, worktreeText());
  return show(await worktree(place, ['remove', 'task']), 'no worktree named');
});
scene('worktree.elsewhere', async (place) => {
  approve(place, worktreeText());
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.other ??= emptySession());
    session.worktrees.task = { path: '../worktrees/acme/task', branch: 'fix/task', setup: 'ok' };
  });
  return show(await worktree(place, ['remove', 'task']), 'not in acme');
});
scene('worktree.occupied', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats['lead-tmp-1'] = { stage: 'ready', temporary: { like: 'lead', until: 'merged:fix/task', task: 'task' } };
  });
  return show(await worktree(place, ['remove', 'task']), 'lead-tmp-1');
});
scene('worktree.unreadable', async (place) => {
  approve(place, worktreeText());
  const plain = join(place.base, 'plain');
  mkdirSync(plain);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.worktrees.task = { path: '../plain', branch: 'fix/task', setup: 'ok' };
  });
  return show(await worktree(place, ['remove', 'task']), "couldn't read");
});
scene('worktree.dirty', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  writeFileSync(join(place.base, 'worktrees', 'acme', 'task', 'README.md'), 'changed\n');
  return show(await worktree(place, ['remove', 'task']), 'README.md');
});
scene('worktree.unpublished', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  const folder = join(place.base, 'worktrees', 'acme', 'task');
  writeFileSync(join(folder, 'README.md'), 'committed\n');
  git(folder, 'add', 'README.md');
  git(folder, 'commit', '-q', '-m', 'local only');
  return show(await worktree(place, ['remove', 'task']), 'local only');
});
scene('worktree.remove-failed', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  const folder = join(place.base, 'worktrees', 'acme', 'task');
  git(place.root, 'worktree', 'lock', folder);
  return show(await worktree(place, ['remove', 'task']), 'was not removed');
});
scene('worktree.record-gone', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  rmSync(join(place.base, 'worktrees', 'acme', 'task'), { recursive: true, force: true });
  return show(await worktree(place, ['remove', 'task']), 'already gone');
});
scene('worktree.removed', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  return show(await worktree(place, ['remove', 'task']), 'the branch fix/task is kept');
});
scene('worktree.remove-branch', async (place) => {
  publish(place);
  approve(place, worktreeText());
  expect((await worktree(place, ['new', 'task', '--kind', 'fix'])).code).toBe(0);
  return show(await worktree(place, ['remove', 'task', '--branch', 'fix/other']), 'does not name the branch');
});

scene('team.help', async (place) => show(await entry(['--help'], testIo(place.root, owner)), 'Usage:'));
scene('team.no-command', async (place) => show(await entry([], testIo(place.root, owner)), 'Usage:'));
scene('team.version', async (place) => show(await entry(['--version'], testIo(place.root, owner)), version()));
scene('team.unknown', async (place) => show(await entry(['nosuch'], testIo(place.root, owner)), 'unknown command'));
scene('team.approve-removed', async (place) => show(await entry(['approve'], testIo(place.root, owner)), 'team approve was removed in 0.5.0'));
scene('team.command-help', async (place) => show(await entry(['status', '--help'], testIo(place.root, owner)), 'Usage: team status'));
scene('team.command-threw', async (place) => {
  // An invalid skeleton is `init`'s own refusal now; a plain file where its folder goes still
  // throws from the write, and the process entry point reports it on the one `team:` line.
  const root = join(place.base, 'threw');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.agents'), 'not a folder\n');
  return show(await entry(['init'], testIo(root, owner)), 'team:');
});

const CURSOR_TRUST = readFileSync(new URL('./fixtures/cursor/2026.10.01/trust.txt', import.meta.url), 'utf8');
const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');

/** The owner's live grant, the way `team grant @team --capabilities dialogs.trust` writes it. */
function trustGranted(home: string, root: string): void {
  const written = writeGrant(home, {
    name: `team-${teamIdOf(root)}`,
    kind: 'team',
    grantee: teamIdOf(root),
    capabilities: ['dialogs.trust'],
    roots: [root],
    scope: [root],
  }, { now: NOW });
  if (!written.ok) throw new Error(`the scene's grant was refused: ${written.why}`);
}

function cursorTeam(lobby: string, setting: 'off' | 'trust', root: string, home: string): string {
  if (setting === 'trust') trustGranted(home, root);
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor-agent
`;
}

function cursorBox(text: string): string {
  const lines = text.split('\n');
  const body = [`  → ${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `    ${line}`)].join('\n');
  return CURSOR_IDLE.replace('  → Plan, search, build anything', body);
}

function answerHost(place: Place, screen: string, opts: { version?: string; send?: boolean; type?: boolean } = {}): AnswerHost & { keys: string[] } {
  let at = NOW.getTime();
  let text = screen;
  let status = 'idle';
  const host: AnswerHost & { keys: string[] } = {
    keys: [],
    version: () => opts.version ?? '2026.10.01-14929f9',
    agents: () => [{ name: 'lead', pane: 'w1:p1', workspace: 'w1' }],
    pane: () => text,
    sendKey: (_session, _pane, key) => {
      if (opts.send === false) return false;
      host.keys.push(key);
      text = CURSOR_IDLE;
      return true;
    },
    rename: () => true,
    foreground: () => ['cursor-agent'],
    foregroundCwd: () => lobbyDir(place.home),
    list: (dir) => listFolder(dir),
    status: () => status,
    type: (_session, _pane, value) => {
      if (opts.type === false) return false;
      text = cursorBox(value);
      return true;
    },
    enter: () => {
      text = CURSOR_IDLE;
      status = 'working';
      return true;
    },
    now: () => new Date(at),
    sleep: async (ms) => { at += ms; },
    home: place.home,
    standing: (root) => approvalStanding(root, place.home),
  };
  return host;
}

async function answered(place: Place, argv: string[], caller: Caller, host: AnswerHost): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runAnswer(argv, io, host);
  return { code, out: io.out, err: io.err };
}

scene('answer.usage', async (place) => show(await answered(place, [], owner, answerHost(place, '')), 'a seat and trust are required'));
scene('answer.configuration', async (place) => show(await answered(place, ['lead', 'trust', '--file', 'missing.yaml'], owner, answerHost(place, '')), 'no team file'));
scene('answer.caller', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  return show(await answered(place, ['lead', 'trust'], other, answerHost(place, '')), 'only the owner');
});
scene('answer.file-owner', async (place) => {
  write(place, TWO);
  return show(await answered(place, ['lead', 'trust', '--file', '.agents/team.yaml'], other, answerHost(place, '')), "--file is the owner's");
});
scene('answer.human', async (place) => {
  write(place, TWO.replace('    stopped: true\n', '    human: true\n'));
  return show(await answered(place, ['worker', 'trust'], owner, answerHost(place, '')), "worker: the pane is a human's");
});
scene('answer.no-pane', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  return show(await answered(place, ['lead', 'trust'], leadSeat, answerHost(place, '')), 'no pane is recorded for seat lead');
});
scene('answer.session-owner', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  return show(await answered(place, ['lead', 'trust', '--session', 'other'], leadSeat, answerHost(place, '')), "--session is the owner's");
});
scene('answer.another-pane', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w2:p1' };
  });
  return show(await answered(place, ['lead', 'trust'], leadSeat, answerHost(place, '')), 'the state records pane w2:p1 for seat lead');
});
scene('answer.policy', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'off', place.root, place.home));
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, '')), 'use team up and [o] (dialogs.trust is off; only the owner can turn it on: team grant @team --capabilities dialogs.trust)');
});
scene('answer.process', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = {
      seats: {
        lead: {
          stage: 'launched',
          pane: 'w1:p1',
          launched: { shell: 400, cli: [401] },
          waiting: { state: 'waiting-owner', classification: 'trust' },
        },
      },
      worktrees: {},
    };
  });
  const screen = CURSOR_TRUST.replace('<untrusted-directory>', lobby);
  const host = answerHost(place, screen);
  host.processInfo = () => ({ shell: 400, foreground: [500] });
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, host), 'not the one team launched');
});
scene('answer.unverified', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { extra: { stage: 'ready', pane: 'w9:p1' } }, worktrees: {} };
  });
  return show(await answered(place, ['extra', 'trust', '--file', place.file], owner, answerHost(place, '')), 'not a declared seat');
});
scene('answer.ambiguous', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1' } }, worktrees: {} };
  });
  const host = answerHost(place, '');
  host.agents = () => [
    { name: 'lead', pane: 'w1:p1', workspace: 'w1' },
    { name: 'lead', pane: 'w2:p1', workspace: 'w2' },
  ];
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, host), 'more than one agent of this name');
});
scene('answer.state', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  const host = answerHost(place, '');
  host.agents = () => [];
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, host), 'not a live seat');
});
scene('answer.version', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, CURSOR_TRUST, { version: '2026.10.02' })), 'no trust answer');
});
scene('answer.screen', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, 'not a dialog\n')), 'not the trust dialog');
});
scene('answer.label', async (place) => {
  // The shipped predicate already requires the recorded label, so a one-character change is refused
  // as the screen. The label return is the same exit, reached when a trust screen lacks the mark.
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  const screen = CURSOR_TRUST.replace('[a] Trust this workspace', '[a] Trust this workspacX').replace('<untrusted-directory>', lobby);
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, screen)), 'not the trust dialog');
});
scene('answer.folder', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home).replace(`trust:\n  - ${lobby}\n  - ${place.root}`, 'trust:\n  - .'));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  const screen = CURSOR_TRUST.replace('<untrusted-directory>', lobby);
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, screen)), 'not an exact trust entry');
});
scene('answer.recovery', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'trust-sent-recovery', classification: 'trust' } } }, worktrees: {} };
  });
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, 'not a dialog\n')), 'recovery required');
});
scene('answer.ready', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'trust', place.root, place.home));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  const screen = CURSOR_TRUST.replace('<untrusted-directory>', lobby);
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, screen)), 'answered trust');
});

// These returns are reached when a second validation disagrees with the first, or when no data
// this version ships can reach them. The stand-in is the same idea as a fake herdr: the command
// runs, and only that later check is made to fail. `answer.action` is the second kind: a send
// that reports false now leaves the recovery state (`answer.recovery`), so the only action
// refusal left is a record whose byte the build does not send, and the shipped profiles record
// 0d, 31 and 61 — all keys the build sends. The check defends against a profile that does not.
// `up.delegate-placement` joins them: the gate's collision backstop. It fires for a malformed
// pane, a pane in the team's own session, or a pane a seat the state records under the session
// it was recorded in. The live agent list does not decide it. The malformed pane and the team's
// own session are refused by the file's own load (`sections/delegate.ts` reads the shape, the
// session and the duplicates before `up` ever calls the gate). The gate's own tests hold the
// recorded-seat verdict, so no scene here reaches it.
function messageRecord(place: Place, over: Partial<MessagePayload> = {}): MessagePayload {
  const root = findRoot(place.root);
  if (!root) throw new Error('the scene is not a checkout');
  return {
    kind: 'message', id: 'm1', to: 'lead', root, session: 'acme',
    at: NOW.toISOString(), body: 'hello', from: 'harness', ...over,
  };
}

async function messaged(place: Place, argv: string[] = []): Promise<Ran> {
  const io = testIo(place.root, owner);
  return { code: await runMessages(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}

scene('messages.none', async (place) => {
  write(place, TEAM);
  return show(await messaged(place), 'nothing is waiting');
});
scene('messages.shown', async (place) => {
  write(place, TEAM);
  const record = messageRecord(place);
  plantMessage(place.home, record.root, 'lead', 'm1', record);
  return show(await messaged(place), 'hello');
});
scene('messages.file', async (place) => show(await messaged(place), 'no team file here'));
scene('messages.id', async (place) => {
  write(place, TEAM);
  const record = messageRecord(place);
  plantMessage(place.home, record.root, 'lead', 'm2', record);
  return show(await messaged(place), 'the filename is the id');
});
scene('messages.key', async (place) => {
  write(place, TEAM);
  const root = findRoot(place.root);
  if (!root) throw new Error('the scene is not a checkout');
  mkdirSync(join(root, '.agents', 'messages', 'lead'), { recursive: true });
  writeFileSync(join(root, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
  return show(await messaged(place), 'no message key');
});
scene('messages.root', async (place) => {
  write(place, TEAM);
  const record = messageRecord(place, { root: '/tmp/elsewhere' });
  plantMessage(place.home, findRoot(place.root) as string, 'lead', 'm1', record);
  return show(await messaged(place), 'another checkout');
});
scene('messages.seat', async (place) => {
  write(place, TEAM);
  const record = messageRecord(place);
  plantMessage(place.home, record.root, 'worker', 'm1', record);
  return show(await messaged(place), 'addressed to lead');
});
scene('messages.session', async (place) => {
  write(place, TEAM);
  const record = messageRecord(place, { session: 'other' });
  plantMessage(place.home, record.root, 'lead', 'm1', record);
  return show(await messaged(place), 'session "other"');
});
scene('messages.shape', async (place) => {
  write(place, TEAM);
  messageKeyOf(place.home);
  const root = findRoot(place.root);
  if (!root) throw new Error('the scene is not a checkout');
  mkdirSync(join(root, '.agents', 'messages', 'lead'), { recursive: true });
  writeFileSync(join(root, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
  return show(await messaged(place), 'not a message');
});
scene('messages.signature', async (place) => {
  write(place, TEAM);
  const record = messageRecord(place);
  plantMessage(place.home, record.root, 'lead', 'm1', record, signDomain(MESSAGE_DOMAIN, record, keyOf(place.home)));
  return show(await messaged(place), 'not the message key\'s');
});
scene('messages.invocation', async (place) => show(await messaged(place, ['extra']), 'unexpected'));
scene('messages.not-a-repo', async (place) => show(await messaged(place), 'run team from a project\n'), false);

const TASKS = `${TEAM}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const LINEAR = `${TEAM}tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
`;

async function issued(place: Place, argv: string[] = []): Promise<Ran> {
  const io = testIo(place.root);
  return { code: await runIssues(argv, io, { home: place.home }), out: io.out, err: io.err };
}

scene('issues.none', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '[]\n');
  return show(await issued(place), '0 issues');
});
scene('issues.shown', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  return show(await issued(place), 'm1  open   -         the task title');
});
scene('issues.file', async (place) => show(await issued(place), 'no team file here'));
scene('issues.missing', async (place) => {
  write(place, TASKS);
  return show(await issued(place), 'the task file is not there');
});
scene('issues.shape', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n');
  return show(await issued(place), 'title is required');
});
scene('issues.invocation', async (place) => show(await issued(place, ['extra']), 'unexpected'));
scene('issues.not-a-repo', async (place) => show(await issued(place), 'run team from a project\n'), false);

// The session registry's scenes write the append-only stream directly, in the shape the launch
// commands append: one `start` event per session and one `end` for a session that ended.
function sessionsRegistry(place: Place): string {
  return join(storePath('acme', place.root, place.home), 'sessions.jsonl');
}

function startEvent(id: string, seat: string, ts: string): Record<string, unknown> {
  return {
    event: 'start', ts, id, project: 'acme', team: 'acme', seat, nickname: seat === 'lead' ? 'Lead' : undefined,
    cli: 'claude-code', lab: 'anthropic', model: 'claude-opus-5-5', version: '5.5', account: 'anthropic',
    herdr_session: 'acme', pane: 'w1:p1', cli_session: '2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c', resumable: true,
  };
}

async function sessionsRun(place: Place, argv: string[] = []): Promise<Ran> {
  const io = testIo(place.root);
  return { code: await runSessions(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}

scene('sessions.none', async (place) => show(await sessionsRun(place), '0 sessions'));
scene('sessions.client-refused', async (place) => show(await sessionsRun(place, ['--client', 'missing-grant.json', '--key', 'missing.key']), 'no client grant can verify'));
scene('sessions.shown', async (place) => {
  const file = sessionsRegistry(place);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    JSON.stringify(startEvent('ses_000000000001', 'lead', '2026-10-04T08:00:00.000Z')),
    JSON.stringify({ event: 'end', ts: '2026-10-04T08:30:00.000Z', id: 'ses_000000000001', reason: 'owner-stop' }),
    JSON.stringify(startEvent('ses_000000000002', 'worker', '2026-10-04T08:31:00.000Z')),
  ].join('\n') + '\n');
  const ran = await sessionsRun(place);
  show(ran, 'ses_000000000001  lead    acme  claude-opus-5-5  2026-10-04 08:00Z  2026-10-04 08:30Z  owner-stop  unknown');
  return ran;
});
scene('sessions.read', async (place) => {
  mkdirSync(sessionsRegistry(place), { recursive: true });
  return show(await sessionsRun(place), 'the session registry path is a directory');
});
scene('sessions.invocation', async (place) => show(await sessionsRun(place, ['--by', 'nothing']), 'must be one of model, team, entity'));

// A machine lock is a directory under the scene's own home. The holder and the clock are
// injected, so these scenes never read a team file or the wall clock. The project refusals are
// the exception: they are that read, of a folder that has no team file.
const LOCK_OWNER: LockIdentity = { team: 'acme', by: 'owner' };
const LOCK_SEAT: LockIdentity = { team: 'acme', by: 'lead' };

function lockSources(place: Place, identity?: LockIdentity): LockSources {
  return {
    home: place.home,
    ...(identity ? { identity } : {}),
    now: () => NOW,
    sleep: () => {},
  };
}

async function locked(place: Place, argv: string[], identity?: LockIdentity): Promise<Ran> {
  const io = testIo(place.root, owner);
  const code = await runLock(argv, io, lockSources(place, identity));
  return { code, out: io.out, err: io.err };
}

async function unlocked(place: Place, argv: string[], identity?: LockIdentity): Promise<Ran> {
  const io = testIo(place.root, owner);
  const code = await runUnlock(argv, io, lockSources(place, identity));
  return { code, out: io.out, err: io.err };
}

scene('lock.taken', async (place) => show(await locked(place, ['heavy-run', '--for', 'release CI'], LOCK_OWNER), 'heavy-run: taken'));
scene('lock.held', async (place) => {
  await locked(place, ['heavy-run', '--for', 'release CI'], LOCK_OWNER);
  return show(await locked(place, ['heavy-run'], LOCK_SEAT), 'held since');
});
scene('lock.io', async (place) => {
  mkdirSync(join(place.home, '.config'), { recursive: true });
  writeFileSync(join(place.home, '.config', 'team'), 'not a folder\n');
  return show(await locked(place, ['heavy-run'], LOCK_OWNER), 'not a directory');
});
scene('lock.invocation', async (place) => show(await locked(place, [], LOCK_OWNER), 'a <name> is required'));
scene('lock.project', async (place) => show(await locked(place, ['heavy-run']), 'no team file'));

scene('unlock.released', async (place) => {
  await locked(place, ['heavy-run'], LOCK_OWNER);
  return show(await unlocked(place, ['heavy-run'], LOCK_OWNER), 'heavy-run: released');
});
scene('unlock.io', async (place) => {
  await locked(place, ['heavy-run'], LOCK_OWNER);
  writeFileSync(join(lockDirectory(place.home, 'heavy-run'), 'extra'), 'leave me\n');
  return show(await unlocked(place, ['heavy-run'], LOCK_OWNER), 'could not remove');
});
scene('unlock.not-held', async (place) => show(await unlocked(place, ['heavy-run'], LOCK_OWNER), 'not held'));
scene('unlock.not-yours', async (place) => {
  await locked(place, ['heavy-run', '--for', 'release CI'], LOCK_OWNER);
  return show(await unlocked(place, ['heavy-run'], LOCK_SEAT), 'not you');
});
scene('unlock.unknown-holder', async (place) => {
  mkdirSync(lockDirectory(place.home, 'heavy-run'), { recursive: true });
  return show(await unlocked(place, ['heavy-run'], LOCK_OWNER), 'its holder file is not there yet');
});
scene('unlock.invocation', async (place) => show(await unlocked(place, [], LOCK_OWNER), 'a <name> is required'));
scene('unlock.project', async (place) => show(await unlocked(place, ['heavy-run']), 'no team file'));

/** The pid every `team proc` scene's reading calls running: the map is a stand-in, so no
 *  assertion depends on a pid this machine happens to have. */
const PROC_LIVE = 4243;
const workerSeat = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' } as const;

async function proced(place: Place, argv: string[], caller: Caller = owner, over: Partial<ProcSources> = {}): Promise<Ran> {
  const io = testIo(place.root, caller);
  const sources: ProcSources = { home: place.home, now: () => NOW, alive: (pid) => pid === PROC_LIVE, ...over };
  return { code: await runProc(argv, io, sources), out: io.out, err: io.err };
}

function seedProcs(place: Place, procs: Record<string, { by: string; at: string; pid?: number; note?: string }>): void {
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).procs = { ...procs };
  });
}

scene('proc.added', async (place) => {
  write(place, TEAM);
  return show(await proced(place, ['add', 'build', '--pid', String(PROC_LIVE), '--note', 'the release build']), 'proc build: added');
});
scene('proc.done', async (place) => {
  write(place, TEAM);
  seedProcs(place, { build: { by: 'owner', at: NOW.toISOString() } });
  return show(await proced(place, ['done', 'build']), 'proc build: done');
});
scene('proc.listed', async (place) => {
  write(place, TEAM);
  return show(await proced(place, ['list']), '0 processes');
});
scene('proc.caller', async (place) => {
  write(place, TEAM);
  return show(await proced(place, ['add', 'build'], other), 'only a seat of this team or the owner records a process');
});
scene('proc.detached', async (place) => {
  write(place, TEAM);
  return show(await proced(place, ['add', 'build'], detachedCaller), 'only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane');
});
scene('proc.other-seat', async (place) => {
  write(place, TWO);
  seedProcs(place, { build: { by: 'lead', at: NOW.toISOString(), pid: PROC_LIVE } });
  return show(await proced(place, ['done', 'build'], workerSeat), 'only lead, a lead or the owner clears it');
});
scene('proc.pid', async (place) => {
  write(place, TEAM);
  return show(await proced(place, ['add', 'build', '--pid', '4244']), 'is not running');
});
scene('proc.taken', async (place) => {
  write(place, TWO);
  seedProcs(place, { build: { by: 'lead', at: NOW.toISOString(), pid: PROC_LIVE } });
  return show(await proced(place, ['add', 'build'], workerSeat), 'is lead\'s, live since');
});
scene('proc.unknown', async (place) => {
  write(place, TEAM);
  return show(await proced(place, ['done', 'build']), 'no process named "build"');
});
scene('proc.file', async (place) => show(await proced(place, ['add', 'build']), 'no team file'));
scene('proc.file-invalid', async (place) => {
  write(place, 'format: [\n');
  return show(await proced(place, ['add', 'build']), 'line');
});
scene('proc.invocation', async (place) => {
  write(place, TEAM);
  return show(await proced(place, []), 'a subcommand is required');
});
scene('proc.not-yours', async (place) => {
  write(place, TEAM);
  const ran = await proced(place, ['list'], other);
  expect(ran.err).toBe('team proc: this team is not yours to read\n');
  expect(ran.out).toBe('');
  return ran;
});

async function tempo(place: Place, argv: string[], caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runTempo(argv, io, { home: place.home }), out: io.out, err: io.err };
}

scene('tempo.set', async (place) => {
  write(place, TEAM);
  return show(await tempo(place, ['urgent']), 'tempo: urgent');
});
scene('tempo.unchanged', async (place) => {
  write(place, TEAM.replace('format: 1\n', 'format: 1\ntempo: urgent\n'));
  const ran = await tempo(place, ['urgent']);
  expect(ran.err).toBe('');
  return show(ran, 'tempo: urgent');
});
scene('tempo.not-owner', async (place) => {
  write(place, TEAM);
  return show(await tempo(place, ['urgent'], other), 'only the owner runs tempo');
});
scene('tempo.detached', async (place) => show(await tempo(place, ['urgent'], detachedCaller), 'only the owner runs this, from a terminal outside herdr'));
scene('tempo.invocation', async (place) => show(await tempo(place, []), 'a word is required'));
scene('tempo.word', async (place) => show(await tempo(place, ['faster']), 'must be relaxed, normal or urgent'));
scene('tempo.not-a-repo', async (place) => show(await tempo(place, ['urgent']), 'run team from a project\n'), false);
scene('tempo.file', async (place) => show(await tempo(place, ['urgent']), 'no team file'));

async function held(place: Place, argv: string[], caller: Caller = owner, now: Date = NOW): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runHold(argv, io, { home: place.home, now: () => now }), out: io.out, err: io.err };
}

scene('hold.placed', async (place) => {
  write(place, TEAM);
  return show(await held(place, ['freeze deploys']), 'hold: freeze deploys');
});
scene('hold.released', async (place) => {
  write(place, TEAM);
  await held(place, ['freeze deploys']);
  return show(await held(place, ['--release']), 'hold: released');
});
scene('hold.held', async (place) => {
  write(place, TEAM);
  await held(place, ['freeze deploys']);
  return show(await held(place, ['something else']), 'already held: freeze deploys');
});
scene('hold.not-held', async (place) => {
  write(place, TEAM);
  return show(await held(place, ['--release']), 'not held');
});
scene('hold.until', async (place) => {
  write(place, TEAM);
  return show(await held(place, ['freeze deploys', '--until', 'tomorrow']), '--until is a local <HH:MM>');
});
scene('hold.client-refused', async (place) => show(await held(place, ['freeze deploys', '--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller), 'no client grant can verify'));
scene('hold.detached', async (place) => {
  write(place, TEAM);
  return show(await held(place, ['freeze deploys'], detachedCaller), 'only the owner, the orchestrator or the operator runs this, from a terminal outside herdr or its own seat');
});
scene('hold.caller', async (place) => {
  write(place, TEAM);
  return show(await held(place, ['freeze deploys'], other), 'only the owner, the orchestrator or the operator holds the team');
});
scene('hold.io', async (place) => {
  write(place, TEAM);
  writeFileSync(join(place.root, '.agents', 'team.state.json'), '{ not json\n');
  return show(await held(place, ['freeze deploys']), 'is not valid JSON');
});
scene('hold.file', async (place) => {
  const inRepo = show(await held(place, ['freeze deploys']), 'no team file');
  // Outside any checkout the same failure names only the project: hold takes no `--file`.
  const outside = await held({ ...place, root: place.base }, ['freeze deploys']);
  show(outside, 'not inside a git repository: run team from a project\n');
  expect(`${outside.out}${outside.err}`).not.toContain('--file');
  return inRepo;
});
scene('hold.invocation', async (place) => {
  write(place, TEAM);
  return show(await held(place, []), 'a <reason> is required');
});

async function pausedTeam(place: Place, argv: string[], caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runPause(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}

scene('pause.placed', async (place) => {
  write(place, TEAM);
  return show(await pausedTeam(place, []), 'stop lead: no record');
});
scene('pause.paused', async (place) => {
  write(place, TEAM);
  await pausedTeam(place, []);
  return show(await pausedTeam(place, []), 'already paused: paused since 2026-10-04T09:00:00.000Z by owner');
});
scene('pause.caller', async (place) => {
  write(place, TEAM);
  return show(await pausedTeam(place, [], other), 'only the owner or the orchestrator pauses the team; this call is other');
});
scene('pause.client-refused', async (place) => show(await pausedTeam(place, ['--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller), 'no client grant can verify'));
scene('pause.detached', async (place) => {
  write(place, TEAM);
  return show(await pausedTeam(place, [], detachedCaller), 'only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat');
});
scene('pause.io', async (place) => {
  write(place, TEAM);
  writeFileSync(join(place.root, '.agents', 'team.state.json'), '{ not json\n');
  return show(await pausedTeam(place, []), 'is not valid JSON');
});
scene('pause.file', async (place) => show(await pausedTeam(place, []), 'no team file'));
scene('pause.team', async (place) => {
  write(place, TEAM);
  return show(await pausedTeam(place, ['other']), 'no seat named "other" is declared in acme, and no registered team has that name');
});
scene('pause.invocation', async (place) => {
  write(place, TEAM);
  return show(await pausedTeam(place, ['--all', '--json']), "can't be used together");
});

async function resumedTeam(place: Place, argv: string[], caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runResume(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}

scene('resume.resumed', async (place) => {
  write(place, TEAM);
  await pausedTeam(place, []);
  return show(await resumedTeam(place, []), 'resumed acme (paused since 2026-10-04T09:00:00.000Z by owner)');
});
scene('resume.not-paused', async (place) => {
  write(place, TEAM);
  return show(await resumedTeam(place, []), 'not paused');
});
scene('resume.caller', async (place) => {
  write(place, TEAM);
  return show(await resumedTeam(place, [], other), 'only the owner or the orchestrator resumes the team; this call is other');
});
scene('resume.client-refused', async (place) => show(await resumedTeam(place, ['--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller), 'no client grant can verify'));
scene('resume.detached', async (place) => {
  write(place, TEAM);
  return show(await resumedTeam(place, [], detachedCaller), 'only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat');
});
scene('resume.io', async (place) => {
  write(place, TEAM);
  writeFileSync(join(place.root, '.agents', 'team.state.json'), '{ not json\n');
  return show(await resumedTeam(place, []), 'is not valid JSON');
});
scene('resume.file', async (place) => show(await resumedTeam(place, []), 'no team file'));
scene('resume.team', async (place) => {
  write(place, TEAM);
  return show(await resumedTeam(place, ['other']), 'no seat named "other" is declared in acme, and no registered team has that name');
});
scene('resume.invocation', async (place) => {
  write(place, TEAM);
  return show(await resumedTeam(place, ['--all', '--json']), "can't be used together");
});

{
  async function raised(place: Place, argv: readonly string[], caller: Caller = leadSeat): Promise<Ran> {
    const io = testIo(place.root, caller);
    const code = await runRaise([...argv], io, { home: place.home, now: () => NOW, notify: () => {} });
    return { code, out: io.out, err: io.err };
  }
  scene('raise.raised', async (place) => {
    write(place, TEAM);
    recordLead(place);
    return show(await raised(place, ['release.ready', 'the release is ready']), 'delivered to the owner at once');
  });
  scene('raise.merged', async (place) => {
    write(place, TEAM);
    recordLead(place);
    await raised(place, ['release.ready', 'the release is ready']);
    return show(await raised(place, ['release.ready', 'the release is ready']), "merged into the owner's record (×2)");
  });
  scene('raise.dry-run', async (place) => {
    write(place, TEAM);
    recordLead(place);
    return show(await raised(place, ['decision.needed', 'pick a launch name', '--dry-run']), 'would deliver decision.needed');
  });
  scene('raise.capped', async (place) => {
    write(place, TEAM);
    recordLead(place);
    for (let n = 1; n <= 10; n += 1) await raised(place, ['release.ready', `release line ${String(n)}`]);
    return show(await raised(place, ['release.ready', 'one more line']), 'ten raises have reached the owner today');
  });
  scene('raise.io', async (place) => {
    write(place, TEAM);
    recordLead(place);
    // The log path is a directory, which the log reader refuses by name.
    mkdirSync(join(storePath('acme', place.root, place.home), 'events.jsonl'), { recursive: true });
    return show(await raised(place, ['release.ready', 'the release is ready']), "the event log can't be read");
  });
  scene('raise.refused', async (place) => {
    write(place, TEAM);
    recordLead(place);
    return show(
      await raised(place, ['release.ready', 'the release is ready'], other),
      "only the orchestrator's seat or a lead's raises to the owner; this call is other",
    );
  });
  scene('raise.file', async (place) => {
    const inRepo = show(await raised(place, ['release.ready', 'the release is ready']), 'no team file');
    // Outside any checkout the same failure names only the project: raise takes no `--file`.
    const outside = await raised({ ...place, root: place.base }, ['release.ready', 'the release is ready']);
    show(outside, 'not inside a git repository: run team from a project\n');
    expect(`${outside.out}${outside.err}`).not.toContain('--file');
    return inRepo;
  });
  scene('raise.usage', async (place) => show(await raised(place, []), 'a <kind> is required'));
}

async function nexted(place: Place, argv: string[] = [], caller: Caller = leadSeat): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runNext(argv, io, { home: place.home }), out: io.out, err: io.err };
}

function recordLead(place: Place, pane = 'w1:p1'): void {
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane };
  });
}

/** The registry's record of this team, holding no line for the lead: the map's row refuses it,
 *  and the file's grant is the path. */
function unlisted(place: Place): void {
  upsertTeam(place.home, teamIdOf(place.root), {
    project: 'acme',
    session: 'acme',
    root: place.root,
    roster: [{ agent: 'agt_000000000000', seat: 'worker', role: 'implementer' }],
  });
}

scene('next.none', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '[]\n');
  recordLead(place);
  return show(await nexted(place), 'nothing is takeable');
});
scene('next.released', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  recordLead(place);
  await nexted(place);
  return show(await nexted(place, ['--release']), 'released m1');
});
scene('next.taken', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  recordLead(place);
  return show(await nexted(place), 'm1  the task title');
});
scene('next.wait', async (place) => {
  write(place, `${TASKS}  cadence: 10m\n`);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '[]\n');
  recordLead(place);
  const io = testIo(place.root, leadSeat);
  const code = await runNext(['--wait'], io, { home: place.home, wait: async () => false });
  return show({ code, out: io.out, err: io.err }, 'stopped waiting');
});
scene('next.caller', async (place) => {
  write(place, TASKS);
  return show(await nexted(place, [], owner), 'this call is owner');
});
scene('next.file', async (place) => show(await nexted(place), 'no team file'));
scene('next.missing', async (place) => {
  write(place, TASKS);
  recordLead(place);
  return show(await nexted(place), 'the task file is not there');
});
scene('next.shape', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n');
  recordLead(place);
  return show(await nexted(place), 'title is required');
});
scene('next.invocation', async (place) => show(await nexted(place, ['extra']), 'unexpected'));
scene('next.not-a-repo', async (place) => show(await nexted(place), 'run team from a project\n'), false);
scene('next.paused', async (place) => {
  write(place, TASKS);
  recordLead(place);
  updateState(join(place.root, '.agents'), (state) => {
    state.pause = { by: 'owner', at: NOW.toISOString(), stops: [{ seat: 'lead' }] };
  });
  return show(await nexted(place), 'nothing new is claimed until `team resume`');
});
scene('next.swap', async (place) => {
  write(place, TASKS);
  recordLead(place);
  updateState(join(place.root, '.agents'), (state) => {
    state.swaps = {
      lead: {
        from: { cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5', display: 'Claude Opus 5.5' },
        to: { cli: 'claude-code', vendor: 'deepseek', model: 'DeepSeek Flash', version: '4.0', display: 'DeepSeek Flash 4.0', launch: 'claude --model deepseek-flash' },
        reason: 'owner',
        queuedAt: NOW.toISOString(),
        deadline: new Date(NOW.getTime() + 1800 * 1000).toISOString(),
        waitFor: "the seat's boundary (quiet, no turn, no dialog, no lease, no work drop)",
      },
    };
  });
  return show(await nexted(place), 'nothing new is claimed until it runs or `team swap cancel lead`');
});

// The broker's own rows. One credential read is stood in everywhere: the shipped wiring reads
// the owner's Keychain, which no scene may ever run. The socket is real — unix sockets under a
// temporary directory, no network — and each scene closes what it opened.
const okKey: KeyReader = async () => ({ ok: true, key: 'test-key-not-real' });
const keyRefusing = (reason: string): KeyReader => async () => ({ ok: false, reason });

async function brokered(place: Place, argv: string[] = [], sources: BrokerSources = {}, caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runBroker(argv, io, { home: place.home, ...sources }), out: io.out, err: io.err };
}

scene('broker.invocation', async (place) => show(await brokered(place, ['extra'], { keyReader: okKey }), 'unexpected'));
scene('broker.not-a-repo', async (place) => show(await brokered(place, [], { keyReader: okKey }), 'run team from a project\n'), false);
scene('broker.file', async (place) => show(await brokered(place, [], { keyReader: okKey }), 'no team file'));
scene('broker.not-owner', async (place) =>
  show(await brokered(place, [], { keyReader: okKey }, { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' }), 'only the owner runs `broker`'));
scene('broker.policy', async (place) => {
  write(place, `${LINEAR}  policy:
    omit: [title]
`);
  return show(await brokered(place, [], { keyReader: okKey }), 'tasks.policy.omit must not name id or title, the record itself');
});
scene('broker.source', async (place) => {
  write(place, TASKS);
  return show(await brokered(place, [], { keyReader: okKey }), 'tasks.source must be linear; the broker serves a tracker source');
});
scene('broker.keychain', async (place) => {
  write(place, LINEAR);
  return show(await brokered(place, [], { keyReader: keyRefusing('this platform has no such facility') }), 'no such facility');
});
scene('broker.busy', async (place) => {
  write(place, LINEAR);
  const loaded = loadTeamFile(place.root, { home: place.home });
  if (!loaded.ok) throw new Error('the fixture does not validate');
  const first = await startBroker({ root: loaded.root, team: loaded.team, read: async () => ({ kind: 'failed', message: 'unused' }), stderr: () => {} });
  if (first.kind !== 'serving') throw new Error(first.kind);
  try {
    return show(await brokered(place, [], { keyReader: okKey }), 'already answering');
  } finally {
    await first.handle.close();
  }
});
scene('broker.locked', async (place) => {
  write(place, LINEAR);
  // A start in flight holds the lock: a live pid — this process's own — is what the lock's
  // holder read judges as a start still binding, so this start waits out the lock's deadline,
  // refuses with its own sentence, and touches nothing: the lock stays, no socket is bound.
  const lock = join(place.root, '.agents', 'broker.sock.lock');
  writeFileSync(lock, `${process.pid}\n`);
  const ran = await brokered(place, [], { keyReader: okKey });
  expect(existsSync(lock)).toBe(true);
  expect(existsSync(join(place.root, '.agents', 'broker.sock'))).toBe(false);
  return show(ran, 'another start is binding');
});
scene('broker.bind', async (place) => {
  write(place, LINEAR);
  // A regular file at the socket path: never a broker, and the walk's lstat gate refuses the
  // entry before any probe — the pinned bare sentence, exit 1, the file untouched. The gate
  // exists because the read diverges: ENOTSOCK on macOS under both runtimes; CI's ubuntu
  // runner answered ECONNREFUSED (run 37778336251), the walk cleared the file and this scene
  // timed out on a refusal that never came.
  const socket = join(place.root, '.agents', 'broker.sock');
  writeFileSync(socket, 'not a socket\n');
  const ran = await brokered(place, [], { keyReader: okKey });
  expect(existsSync(socket)).toBe(true);
  return show(ran, 'could not be bound');
});
scene('broker.stopped', async (place) => {
  write(place, LINEAR);
  // The stop seam arms when the serve loop is reached; the scene ends it on the next tick, once
  // the arm's own undo exists, and the clean close removes the socket file.
  const stop = (end: () => void): (() => void) => {
    setTimeout(end, 0);
    return () => {};
  };
  const ran = await brokered(place, [], { keyReader: okKey, stop });
  expect(existsSync(join(place.root, '.agents', 'broker.sock'))).toBe(false);
  return show(ran, 'team broker: stopped');
});

async function bussed(place: Place, argv: string[] = [], sources: BusCommandSources = {}, caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runBus(argv, io, { home: place.home, reconcileIntervalMs: 0, ...sources }), out: io.out, err: io.err };
}

scene('bus.usage', async (place) => show(await bussed(place, ['extra']), 'unexpected'));
scene('bus.configuration', async (place) => show(await bussed(place), 'run team from a project\n'), false);
scene('bus.refused', async (place) =>
  show(await bussed(place, [], {}, { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' }), 'only the owner runs `bus`'));
scene('bus.started', async (place) => {
  write(place, TEAM);
  const stop = (end: () => void): (() => void) => {
    setTimeout(end, 0);
    return () => {};
  };
  const ran = await bussed(place, [], { stop });
  expect(existsSync(join(place.root, '.agents', 'bus.sock'))).toBe(false);
  return show(ran, 'team bus: answering on .agents/bus.sock');
});
scene('bus.stopped', async (place) => {
  write(place, TEAM);
  const stop = (end: () => void): (() => void) => {
    setTimeout(end, 0);
    return () => {};
  };
  const ran = await bussed(place, [], { stop });
  expect(existsSync(join(place.root, '.agents', 'bus.sock'))).toBe(false);
  return show(ran, 'team bus: stopped');
});

type FakeDaemonService = ServiceManager & { calls: string[] };

function fakeDaemonService(overrides: Partial<ServiceManager> = {}): FakeDaemonService {
  const calls: string[] = [];
  const unit = (home: string): string => join(home, 'unit.plist');
  return {
    kind: 'system-service-manager',
    unitPath: unit,
    plan: (home, program) => ({ unitPath: unit(home), program: [program.execPath, program.entry, 'daemon', 'run'] }),
    install: (home) => {
      calls.push('install');
      return { ok: true, unitPath: unit(home) };
    },
    uninstall: (home) => {
      calls.push('uninstall');
      return { ok: true, unitPath: unit(home), removed: true };
    },
    ...overrides,
    calls,
  };
}

const daemonSnapshot: DaemonHealthSnapshot = {
  pid: 42,
  uid: 501,
  since: '2026-10-20T10:00:00.000Z',
  startedBy: 'service-manager',
  version: 'test',
  heartbeatAt: '2026-10-20T10:00:05.000Z',
  stuck: [],
  features: { broker: 'absent' },
};

function daemonSources(place: Place, overrides: Partial<DaemonCommandSources> = {}): DaemonCommandSources {
  return {
    home: place.home,
    program: { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js' },
    version: 'test',
    ...overrides,
  };
}

async function daemonRan(
  place: Place,
  argv: string[],
  caller: Caller = owner,
  overrides: Partial<DaemonCommandSources> = {},
): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runDaemon(argv, io, daemonSources(place, overrides)), out: io.out, err: io.err };
}

const FAULT_SINCE = '2026-10-20T10:00:00.000Z';

/** The route id the checkout's own team file records, as `fault-watch` derives it. */
function faultRouteAt(place: Place): string {
  const loaded = loadTeamFile(place.root, { home: place.home });
  if (!loaded.ok) throw new Error(`the scene team file must load: ${loaded.errors[0]?.message ?? ''}`);
  return routeId(routeOf(loaded.root, loaded.team.project, loaded.team.session, loaded.team.seats.map((seat) => seat.name)));
}

/** A live daemon record this test process is its own pid of, carrying the one hosted watch. */
function faultDaemonRecord(place: Place, route: string, watch: Partial<HostedWatchState> | 'none' = {}): void {
  const entry: DaemonRootState = {
    root: place.root,
    team: 'acme',
    send: 'serving',
    bus: 'serving',
    why: null,
    ...(watch === 'none' ? {} : {
      watch: {
        routeId: route,
        root: place.root,
        team: 'acme',
        session: 'default',
        phase: 'running',
        startedAt: FAULT_SINCE,
        lastCycleAt: FAULT_SINCE,
        lastCycleOutcome: 'pass',
        cycles: 2,
        failures: 0,
        effects: 'blocked',
        required: true,
        why: null,
        ...watch,
      } satisfies HostedWatchState,
    }),
  };
  writeDaemonState(place.home, {
    format: 1,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    since: FAULT_SINCE,
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: FAULT_SINCE,
    socket: daemonSocketPath(place.home),
    features: { broker: 'absent' },
    stuck: [],
    roots: [entry],
  });
}

/** A fault result the daemon would write, echoing the nonce of the request it just read. */
function answerFault(place: Place, route: string, outcome: 'faulted' | 'refused', why: string): DaemonCommandSources['sleep'] {
  return async () => {
    const asked = JSON.parse(readFileSync(faultRequestPath(place.home), 'utf8')) as { nonce: string };
    writeFileSync(
      faultResultPath(place.home),
      `${JSON.stringify({
        format: 1,
        home: place.home,
        routeId: route,
        nonce: asked.nonce,
        outcome,
        why,
        at: FAULT_SINCE,
      }, null, 2)}\n`,
    );
  };
}

scene('daemon.entry-missing', async (place) => {
  write(place, TEAM);
  return show(
    await daemonRan(place, ['install'], owner, { service: fakeDaemonService(), program: null }),
    'the CLI entry cannot be found',
  );
});
scene('daemon.already-running', async (place) =>
  show(
    await daemonRan(place, ['run'], owner, {
      start: async () => ({ kind: 'already-running', pid: 42 }),
    }),
    'team daemon: already running (pid 42)',
  ));
scene('daemon.dry-run', async (place) => {
  write(place, TEAM);
  const service = fakeDaemonService();
  const ran = await daemonRan(place, ['install', '--dry-run'], owner, { service });
  expect(service.calls).toEqual([]);
  return show(ran, 'team daemon: would install');
});
scene('daemon.installed', async (place) => {
  write(place, TEAM);
  const service = fakeDaemonService();
  const ran = await daemonRan(place, ['install'], owner, { service });
  expect(service.calls).toEqual(['install']);
  return show(ran, 'team daemon: installed');
});
scene('daemon.not-owner', async (place) =>
  show(
    await daemonRan(place, ['install'], { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' }),
    'only the owner installs or removes the machine daemon',
  ));
scene('daemon.no-root', async (place) => show(await daemonRan(place, ['install'], owner, { service: fakeDaemonService() }), 'run team from a project'));
scene('daemon.run-root', async (place) =>
  show(
    await daemonRan(place, ['run', '--root', join(place.home, 'missing-checkout')], owner, {
      start: async () => {
        throw new Error('a start must not run when a named root cannot be read');
      },
    }),
    'missing-checkout',
  ));
scene('daemon.run-failed', async (place) =>
  show(
    await daemonRan(place, ['run'], owner, {
      start: async () => ({ kind: 'locked', pid: 43 }),
    }),
    'another start holds the machine lock (pid 43)',
  ));
scene('daemon.install-failed', async (place) => {
  write(place, TEAM);
  return show(
    await daemonRan(place, ['install'], owner, {
      service: fakeDaemonService({
        install: () => ({ ok: false, why: 'the system service manager refused to start the daemon', detail: null }),
      }),
    }),
    'the system service manager refused to start the daemon',
  );
});
scene('daemon.run-not-owner', async (place) =>
  show(
    await daemonRan(place, ['run'], { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' }),
    'only the owner or the system service manager runs the machine daemon',
  ));
scene('daemon.service-unavailable', async (place) =>
  show(
    await daemonRan(place, ['install'], owner, { service: null }),
    'no system service manager adapter is available on this platform yet',
  ));
scene('daemon.uninstall-failed', async (place) =>
  show(
    await daemonRan(place, ['uninstall'], owner, {
      service: fakeDaemonService({
        uninstall: () => ({ ok: false, why: 'the system service manager refused to stop the daemon', detail: null }),
      }),
    }),
    'the system service manager refused to stop the daemon',
  ));
scene('daemon.status', async (place) => show(await daemonRan(place, ['status']), 'team daemon: not running'));
scene('daemon.stopped', async (place) =>
  show(
    await daemonRan(place, ['run'], owner, {
      start: async () => ({
        kind: 'serving',
        daemon: {
          socketPath: join(place.home, 'daemon.sock'),
          roots: [],
          routes: [],
          health: () => daemonSnapshot,
          close: async () => {},
        },
      }),
      stop: (end) => {
        setTimeout(end, 0);
        return () => {};
      },
    }),
    'team daemon: stopped',
  ));
scene('daemon.uninstalled', async (place) => {
  const service = fakeDaemonService();
  const ran = await daemonRan(place, ['uninstall'], owner, { service });
  expect(service.calls).toEqual(['uninstall']);
  return show(ran, 'team daemon: uninstalled');
});
scene('daemon.usage', async (place) => show(await daemonRan(place, ['watch']), 'unknown subcommand'));
scene('daemon.fault-usage', async (place) =>
  show(await daemonRan(place, ['fault-watch', '--root', place.root, '--route', 'nope']), '32-character route id'));
scene('daemon.fault-root', async (place) =>
  show(
    await daemonRan(place, ['fault-watch', '--root', join(place.home, 'missing-checkout'), '--route', 'a'.repeat(32)]),
    'missing-checkout',
  ));
scene('daemon.fault-route', async (place) => {
  write(place, TEAM);
  return show(
    await daemonRan(place, ['fault-watch', '--root', place.root, '--route', 'f'.repeat(32)]),
    "does not name this checkout's hosted route",
  );
});
scene('daemon.fault-daemon', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  return show(await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route]), 'is not running');
});
scene('daemon.fault-watch', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route, 'none');
  return show(await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route]), 'no hosted watch in the daemon record');
});
scene('daemon.fault-watch-state', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route, { phase: 'standby', why: 'a pane watch owns this session' });
  return show(await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route]), 'stands down to a live pane watch');
});
scene('daemon.fault-dry-run', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route);
  const ran = await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route, '--dry-run']);
  expect(existsSync(faultRequestPath(place.home))).toBe(false);
  return show(ran, 'would ask the running daemon to fault the hosted watch');
});
scene('daemon.faulted', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route);
  const ran = await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route], owner, {
    sleep: answerFault(place, route, 'faulted', FAULT_WHY),
  });
  return show(ran, 'faulted the hosted watch for');
});
scene('daemon.fault-pending', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route);
  expect(
    writeFaultRequest(place.home, {
      format: 1,
      home: place.home,
      routeId: route,
      daemonPid: process.pid,
      daemonSince: FAULT_SINCE,
      why: FAULT_WHY,
      requestedAt: FAULT_SINCE,
      nonce: 'already-waiting',
    }),
  ).toEqual({ ok: true });
  return show(await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route]), 'a fault request is already waiting');
});
scene('daemon.fault-refused', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route);
  const ran = await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route], owner, {
    sleep: answerFault(place, route, 'refused', 'the fault request names another daemon home'),
  });
  return show(ran, 'refused the fault');
});
scene('daemon.fault-not-reached', async (place) => {
  write(place, TEAM);
  const route = faultRouteAt(place);
  faultDaemonRecord(place, route);
  const ran = await daemonRan(place, ['fault-watch', '--root', place.root, '--route', route], owner, { faultWaitMs: 0 });
  return show(ran, 'nothing was killed');
});
scene('next.broker', async (place) => {
  write(place, LINEAR);
  recordLead(place);
  return show(await nexted(place), 'the broker is not running');
});
scene('next.read', async (place) => {
  write(place, LINEAR);
  recordLead(place);
  const loaded = loadTeamFile(place.root, { home: place.home });
  if (!loaded.ok) throw new Error('the fixture does not validate');
  const serving = await startBroker({
    root: loaded.root,
    team: loaded.team,
    read: async () => ({ kind: 'failed', message: 'the tracker could not be read' }),
    stderr: () => {},
  });
  if (serving.kind !== 'serving') throw new Error(serving.kind);
  try {
    return show(await nexted(place), 'the broker failed this read');
  } finally {
    await serving.handle.close();
  }
});
scene('next.policy', async (place) => {
  write(place, `${LINEAR}  policy:
    omit: [title]
`);
  recordLead(place);
  return show(await nexted(place), 'tasks.policy.omit must not name id or title, the record itself');
});

async function planned(place: Place, argv: string[] = [], caller: Caller = leadSeat): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runPlan(argv, io, { home: place.home }), out: io.out, err: io.err };
}

scene('plan.none', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '[]\n');
  recordLead(place);
  return show(await planned(place), '0 tasks');
});
scene('plan.shown', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  recordLead(place);
  return show(await planned(place), '1     open   -      the task title');
});
scene('plan.caller', async (place) => {
  write(place, TASKS);
  return show(await planned(place, [], owner), 'this call is owner');
});
scene('plan.file', async (place) => show(await planned(place), 'no team file'));
scene('plan.missing', async (place) => {
  write(place, TASKS);
  recordLead(place);
  return show(await planned(place), 'the task file is not there');
});
scene('plan.shape', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n');
  recordLead(place);
  return show(await planned(place), 'title is required');
});
scene('plan.invocation', async (place) => show(await planned(place, ['extra']), 'unexpected'));
scene('plan.not-a-repo', async (place) => show(await planned(place), 'run team from a project\n'), false);
scene('plan.broker', async (place) => {
  write(place, LINEAR);
  recordLead(place);
  return show(await planned(place), 'the broker is not running');
});
scene('plan.read', async (place) => {
  write(place, LINEAR);
  recordLead(place);
  const loaded = loadTeamFile(place.root, { home: place.home });
  if (!loaded.ok) throw new Error('the fixture does not validate');
  const serving = await startBroker({
    root: loaded.root,
    team: loaded.team,
    read: async () => ({ kind: 'failed', message: 'the tracker could not be read' }),
    stderr: () => {},
  });
  if (serving.kind !== 'serving') throw new Error(serving.kind);
  try {
    return show(await planned(place), 'the broker failed this read');
  } finally {
    await serving.handle.close();
  }
});

async function queued(place: Place, argv: string[], caller: Caller = leadSeat): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runQueue(argv, io, { home: place.home }), out: io.out, err: io.err };
}

/** A live lease on `id`, written with the machine's clock: the exit scenes run in real time. */
function leaseFile(place: Place, id: string, seat = 'lead', pane = 'w1:p1'): void {
  const at = new Date().toISOString();
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  mkdirSync(join(place.root, '.agents', 'leases'), { recursive: true });
  writeFileSync(
    join(place.root, '.agents', 'leases', `${id}.json`),
    `${JSON.stringify({ format: 1, id, seat, pane, acquiredAt: at, renewedAt: at, until }, null, 2)}\n`,
  );
}

/** A queue holding `q1`, written directly: these scenes test the producer, not the add. */
function queueQ1(place: Place): void {
  writeFileSync(join(place.root, '.agents', 'queue.yaml'), '- id: "q1"\n  title: "a leased task"\n');
}

scene('queue.added', async (place) => {
  write(place, TEAM);
  recordLead(place);
  return show(await queued(place, ['add', 'a queued task', '--id', 'q1']), 'queued q1 in .agents/queue.yaml');
});
scene('queue.present', async (place) => {
  write(place, TEAM);
  recordLead(place);
  await queued(place, ['add', 'a queued task', '--id', 'q1']);
  return show(await queued(place, ['add', 'a queued task', '--id', 'q1']), 'q1 is already queued in .agents/queue.yaml');
});
scene('queue.none', async (place) => {
  write(place, TEAM);
  return show(await queued(place, ['list']), '0 tasks');
});
scene('queue.shown', async (place) => {
  write(place, TEAM);
  recordLead(place);
  await queued(place, ['add', 'a queued task', '--id', 'q1']);
  return show(await queued(place, ['list']), 'q1  a queued task');
});
scene('queue.caller', async (place) => {
  write(place, TEAM);
  return show(await queued(place, ['add', 'a queued task', '--id', 'q1'], other), 'only the owner or a seat of this team adds to the queue; this call is other');
});
scene('queue.duplicate', async (place) => {
  write(place, TEAM);
  recordLead(place);
  await queued(place, ['add', 'a queued task', '--id', 'q1']);
  return show(await queued(place, ['add', 'another queued task', '--id', 'q1']), 'q1 is already queued with a different record');
});
scene('queue.file', async (place) => show(await queued(place, ['list']), 'no team file'));
scene('queue.read', async (place) => {
  write(place, TASKS);
  return show(await queued(place, ['list']), 'the task file is not there');
});
scene('queue.source', async (place) => {
  write(place, LINEAR);
  return show(await queued(place, ['list']), 'declares a linear task source');
});
scene('queue.invocation', async (place) => show(await queued(place, ['bogus']), 'unexpected "bogus"'));
scene('queue.not-a-repo', async (place) => show(await queued(place, ['list']), 'run team from a project\n'), false);
scene('queue.ready', async (place) => {
  write(place, TEAM);
  recordLead(place);
  queueQ1(place);
  leaseFile(place, 'q1');
  return show(await queued(place, ['ready', 'q1', '--commit', 'abcdef1']), 'ready q1 at abcdef1');
});
scene('queue.install', async (place) => {
  write(place, TEAM);
  recordLead(place);
  return show(await queued(place, ['install', 'q1', '--commit', 'abcdef1'], { kind: 'owner' }), 'installed q1 at abcdef1');
});
scene('queue.lease', async (place) => {
  write(place, TEAM);
  recordLead(place);
  return show(await queued(place, ['ready', 'q1', '--commit', 'abcdef1']), 'holds no live lease');
});
scene('queue.installer', async (place) => {
  write(place, TEAM);
  recordLead(place);
  return show(await queued(place, ['install', 'q1', '--commit', 'abcdef1']), 'designates no installer');
});
scene('queue.record', async (place) => {
  write(place, TEAM);
  recordLead(place);
  queueQ1(place);
  leaseFile(place, 'q1');
  writeFileSync(join(place.root, '.agents', 'green-slices.json'), 'nope\n');
  return show(await queued(place, ['ready', 'q1', '--commit', 'abcdef1']), 'is not valid JSON');
});

/** `team send`'s fixtures: a fake seat of the fixture's own file, a sockets folder with a file
 *  at the pid the fake pane process reports, and a deliver that accepts — with `reply` set,
 *  the seat also answers at the sender's own pid path, as a session does. No path calls this
 *  deliver while SOCKET_SEND (src/send/uds.ts) is off, so `reply` stands unused until the
 *  answered scene returns with the native leg. No session is read. */
function sendHost(place: Place, over: { agents?: boolean; socket?: boolean; reply?: string; inboxGraceMs?: number } = {}): SendHost & { frames: string[] } {
  const sockets = join(place.base, 'cc-socks');
  mkdirSync(sockets, { recursive: true });
  if (over.socket !== false) writeFileSync(join(sockets, '400.sock'), '');
  // The seat's own evidence for this line: idle until the Enter, working after it.
  let working = false;
  const host: SendHost & { frames: string[] } = {
    frames: [],
    agents: () => (over.agents === false ? null : [{ name: 'lead', pane: 'w1:p1', cli: 'claude' }]),
    processInfo: () => ({ shell: 400, foreground: [] }),
    socketsDir: sockets,
    deliver: async (_socketPath, frame) => {
      host.frames.push(frame);
      if (over.reply !== undefined) {
        const back = createConnection(join(sockets, `${String(process.pid)}.sock`));
        back.on('error', () => {});
        back.on('connect', () => back.end(`${over.reply}\n`));
      }
      return { ok: true };
    },
    native: {
      typeText: () => true,
      pressEnter: () => {
        working = true;
        return true;
      },
      status: () => (working ? 'working' : 'idle'),
      wait: async () => {},
    },
    now: () => NOW,
    home: place.home,
    ...(over.inboxGraceMs === undefined ? {} : { inboxGraceMs: over.inboxGraceMs }),
  };
  return host;
}

/** The lead seat's own inbox, with a listener marker a send will take as live: this process's
 *  pid, the fixture's own seat, session and root. The folder is the drop directory `team send`
 *  writes to, so the marker sits where the leg looks for it. */
function liveInbox(place: Place, over: Partial<{ seat: string; session: string; pid: number; root: string }> = {}): string {
  const dropDir = join(place.root, '.agents', 'send-drops', 'acme', 'lead');
  mkdirSync(dropDir, { recursive: true });
  writeFileSync(join(dropDir, '.inbox-listener'), `${JSON.stringify({
    v: 1,
    seat: over.seat ?? 'lead',
    session: over.session ?? 'acme',
    root: over.root ?? place.root,
    cli: 'claude-code',
    pid: over.pid ?? process.pid,
    ts: NOW.toISOString(),
  })}\n`);
  return dropDir;
}

async function sent(place: Place, argv: string[], caller: Caller, host: SendHost): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runSend(argv, io, host);
  return { code, out: io.out, err: io.err };
}

/**
 * A synthetic home for a client invocation: the owner key, one registered floor coordinator on
 * `place.root`, one app key and one owner-signed grant. The key folder lives outside the OS temp
 * directory, because the placement rules refuse a client key under tmpdir. The scene removes it.
 */
function clientWorld(place: Place, options: { inbox?: boolean } = {}): {
  base: string;
  home: string;
  grantPath: string;
  keyPath: string;
  grantId: string;
  recipientId: string;
} {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.team-exit-client-')));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const ownerKey = keyOf(home);
  const teamId = teamIdOf(place.root);
  const agent = registerAgent(home, {
    name: 'Orchestrator',
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: teamId, seat: 'orchestrator', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  upsertTeam(home, teamId, {
    project: 'floor',
    entity: 'floor',
    session: 'acme',
    root: place.root,
    lobby: join(base, 'lobby'),
    roster: [{ agent: agent.id, seat: 'orchestrator', role: 'orchestrator', leads: true }],
    lifecycle: 'running',
  });
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, 'grok-bot');
  const written = writeClientKeyFiles(keyDir, pair);
  if (!written.ok) throw new Error(written.why);
  const grant = writeClientGrant(
    home,
    { clientId: 'grok-bot', entity: 'floor', publicKey: pair.publicKey, keyId: pair.keyId, keyDir, ...(options.inbox === true ? { inbox: true } : {}) },
    { now: NOW, key: ownerKey },
  );
  if (!grant.ok) throw new Error(grant.why);
  return {
    base,
    home,
    grantPath: grant.path,
    keyPath: join(keyDir, 'client.key'),
    grantId: grant.grant.grantId,
    recipientId: agent.id,
  };
}

/** The client's opening record: a signed client send, waiting in the grant recipient's folder. */
function plantClientRoot(place: Place, world: ReturnType<typeof clientWorld>, id: string): void {
  const session = 'acme';
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'orchestrator',
    to_id: world.recipientId,
    root: place.root,
    session,
    at: NOW.toISOString(),
    body: 'from the client — admitted by: a signed client request\n\nhello',
    from: 'client:grok-bot',
    from_id: null,
    rule: 'a signed client request',
    thread: id,
    from_client: { client_id: 'grok-bot', grant_id: world.grantId },
  };
  const dir = recordDir(place.root, session, 'orchestrator');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, id), `${JSON.stringify(signRecord(payload, world.home), null, 2)}\n`, { mode: 0o600 });
}

/** The seat's reply onto that record: a signed client-thread reply in the client's own inbox. */
function plantClientReply(place: Place, world: ReturnType<typeof clientWorld>, rootId: string, id: string): void {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'client:grok-bot',
    to_id: null,
    root: place.root,
    session: 'acme',
    at: new Date(NOW.getTime() + 1000).toISOString(),
    body: 'from the seat orchestrator — admitted by: a reply on a client thread, to the client that opened it\n\nthe answer',
    from: 'orchestrator',
    from_id: world.recipientId,
    rule: 'a reply on a client thread, to the client that opened it',
    thread: rootId,
    in_reply_to: rootId,
    to_client: { client_id: 'grok-bot', grant_id: world.grantId },
  };
  const dir = clientInboxFolder(place.root, 'acme', 'grok-bot');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, id), `${JSON.stringify(signRecord(payload, world.home), null, 2)}\n`, { mode: 0o600 });
}

async function readClient(place: Place, home: string, argv: string[], caller?: Caller): Promise<Ran> {
  const io = caller === undefined ? testIo(place.root) : testIo(place.root, caller);
  const code = await runMessages(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

async function sentClient(place: Place, home: string, argv: string[], caller: Caller = { kind: 'owner' }): Promise<Ran> {
  const io = testIo(place.root, caller);
  const host = { home, now: () => NOW, sendId: () => '99999999-9999-4999-8999-999999999999' } as unknown as SendHost;
  const code = await runSend(argv, io, host);
  return { code, out: io.out, err: io.err };
}

scene('send.client-sent', async (place) => {
  const world = clientWorld(place);
  try {
    return show(
      await sentClient(place, world.home, ['--client', world.grantPath, '--key', world.keyPath, 'orchestrator@floor', 'hello']),
      'sent: orchestrator@floor (drop ',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('send.client-refused', async (place) => {
  const world = clientWorld(place);
  try {
    return show(
      await sentClient(place, world.home, ['--client', join(world.base, 'missing.json'), '--key', world.keyPath, 'orchestrator@floor', 'hello']),
      'team send: refused: ',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('send.client-pane', async (place) => {
  const world = clientWorld(place);
  try {
    return show(
      await sentClient(place, world.home, ['--client', world.grantPath, '--key', world.keyPath, 'orchestrator@floor', 'hello'], { kind: 'seat', name: 'orchestrator', pane: 'w1:p1' }),
      'team send: refused: a client key is not used from inside a team pane',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('send.client-usage', async (place) => {
  const world = clientWorld(place);
  try {
    return show(
      await sentClient(place, world.home, ['--client', world.grantPath, 'orchestrator@floor', 'hello']),
      '--client needs --key',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

const CLIENT_ROOT = '88888888-8888-4888-8888-888888888888';
const CLIENT_REPLY = '77777777-7777-4777-8777-777777777777';

scene('messages.client-shown', async (place) => {
  const world = clientWorld(place, { inbox: true });
  try {
    plantClientRoot(place, world, CLIENT_ROOT);
    plantClientReply(place, world, CLIENT_ROOT, CLIENT_REPLY);
    return show(
      await readClient(place, world.home, ['--client', world.grantPath, '--key', world.keyPath]),
      'shown',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('messages.client-none', async (place) => {
  const world = clientWorld(place, { inbox: true });
  try {
    messageKeyOf(world.home);
    return show(
      await readClient(place, world.home, ['--client', world.grantPath, '--key', world.keyPath]),
      'nothing is waiting',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('messages.client-key', async (place) => {
  const world = clientWorld(place, { inbox: true });
  try {
    return show(
      await readClient(place, world.home, ['--client', world.grantPath, '--key', join(world.base, 'missing.key')]),
      'team messages:',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('messages.client-pane', async (place) => {
  const world = clientWorld(place, { inbox: true });
  try {
    return show(
      await readClient(place, world.home, ['--client', world.grantPath, '--key', world.keyPath], { kind: 'seat', name: 'orchestrator', pane: 'w1:p1' }),
      'team messages: refused: a client key is not used from inside a team pane',
    );
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

scene('messages.client-refused', async (place) => {
  return show(
    await readClient(place, place.home, ['--client', join(place.base, 'missing.json'), '--key', join(place.base, 'missing.key')]),
    'team messages: refused:',
  );
});

scene('messages.client-usage', async (place) => {
  return show(
    await readClient(place, place.home, ['--client', 'grant.json', '--key', 'client.key', '--limit', '0']),
    '--limit is a page bound',
  );
});

scene('reply.client-refused', async (place) => {
  const ORCH_TEAM = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  write(place, ORCH_TEAM);
  const world = clientWorld(place);
  try {
    plantClientRoot(place, world, CLIENT_ROOT);
    updateState(join(place.root, '.agents'), (state) => {
      state.sessions.acme = { seats: { orchestrator: { stage: 'ready' as const, pane: 'w1:p1' } } } as never;
    });
    const io = testIo(place.root, { kind: 'seat', name: 'orchestrator', pane: 'w1:p1', session: 'acme' });
    const code = await runReply([CLIENT_ROOT, 'the answer'], io, { home: world.home, now: () => NOW });
    return show({ code, out: io.out, err: io.err }, 'is send-only');
  } finally {
    rmSync(world.base, { recursive: true, force: true });
  }
});

const ASK_SHOW_MARKER =
  '{"v":1,"request_id":"req-ask-show-v1","question_sha256":"7fa2d11897a567998b667f4b453ac20b68a6813fde68222e583f90a5bf453b96","expires_at":"2026-10-12T18:00:00.000Z","mac":"8d53d07c074d438d6676e20b45b11ea021b54e30d36d840b48e4f7a41223cbce"}';

function askShowFiles(place: Place, marker = `${ASK_SHOW_MARKER}\n`): void {
  writeFileSync(join(place.root, 'ask.txt'), 'TeamCLI signed ask v1\n{"question":"Status?","request_id":"req-ask-show-v1"}\n');
  writeFileSync(join(place.root, 'marker.json'), marker);
  writeFileSync(join(place.root, 'key.txt'), 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI\n');
}

async function askShown(place: Place, argv: string[], now = new Date('2026-10-12T18:00:00.000Z')): Promise<Ran> {
  const io = testIo(place.root);
  const code = await runAskShow(argv, io, now);
  return { code, out: io.out, err: io.err };
}

scene('ask-show.shown', async (place) => {
  askShowFiles(place);
  return show(
    await askShown(place, ['req-ask-show-v1', '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt']),
    'Status?',
  );
}, false);
scene('ask-show.expired', async (place) => {
  askShowFiles(place);
  const past = new Date(Date.parse('2026-10-12T18:00:00.000Z') + 5_001);
  return show(
    await askShown(place, ['req-ask-show-v1', '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'], past),
    'the ask has expired',
  );
}, false);
scene('ask-show.refused', async (place) => {
  askShowFiles(place, `${ASK_SHOW_MARKER.replace(/e"}$/, 'f"}')}\n`);
  return show(
    await askShown(place, ['req-ask-show-v1', '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt']),
    'the marker does not verify',
  );
}, false);
scene('ask-show.invocation', async (place) =>
  show(await askShown(place, []), 'a request id, --ask, --marker and --key are required'), false);

scene('send.usage', async (place) => show(await sent(place, [], owner, sendHost(place)), 'a seat and a message are required'));
scene('send.configuration', async (place) =>
  show(await sent(place, ['lead', '--file', 'missing.yaml'], owner, sendHost(place)), 'lead needs a team'));
scene('send.refused', async (place) => {
  write(place, TWO);
  return show(await sent(place, ['missing', 'hello'], owner, sendHost(place)), 'it is not a declared seat');
});
scene('send.brief-memory', async (place) => {
  // The fixture's worker is stopped, which is its own refusal; the lead is open, and the
  // transport is read before the draft or any drop is touched.
  write(place, TEAM);
  const path = join(place.root, 'brief.md');
  writeFileSync(path, 'the whole brief\n');
  const wrote = writePolicySet(
    place.home,
    { level: 'team', target: place.root, teamRoot: place.root, name: 'brief-transport', value: 'memory' },
    { now: NOW },
  );
  expect(wrote.ok).toBe(true);
  return show(await sent(place, ['lead', '--brief', path], owner, sendHost(place)), 'brief-transport is memory');
});
scene('send.held', async (place) => {
  write(place, TEAM);
  // No socket file: a held message is the typed path's own refusal, and a taken frame on a
  // present socket would deliver before the pane was ever read for a dialog.
  const host = sendHost(place, { socket: false });
  host.native.paneText = () => `${'─'.repeat(30)}\n❯ draft in box\n${'─'.repeat(30)}`;
  return show(await sent(place, ['lead', 'hello'], owner, host), 'held');
});
scene('send.unreachable', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello'], owner, sendHost(place, { agents: false })), 'unreachable');
});
scene('send.stopped', async (place) => {
  write(place, TWO);
  // The dry run reports the real run's refusal: the file marks the seat stopped, and no leg is
  // walked. Nothing is written — no drop folder, no history — by either run.
  const dry = await sent(place, ['worker', 'hello', '--dry-run'], owner, sendHost(place));
  expect(dry.code).toBe(1);
  expect(`${dry.err}${dry.out}`).toContain('worker: unreachable: worker is stopped');
  const real = show(await sent(place, ['worker', 'hello'], owner, sendHost(place)), 'worker: unreachable: worker is stopped');
  expect(existsSync(join(place.root, '.agents', 'send-drops'))).toBe(false);
  expect(existsSync(historyPath('acme', place.root, place.home))).toBe(false);
  return real;
});
scene('send.not-submitted', async (place) => {
  write(place, TEAM);
  // The trigger not being taken is the typed path's refusal: the seat is idle, so the send takes
  // the drop-file route and types — and the pane never turns working.
  const host = sendHost(place, { socket: false });
  host.native.status = () => 'idle';
  return show(await sent(place, ['lead', 'hello'], owner, host), 'not-submitted');
});
scene('send.delivered', async (place) => {
  write(place, TEAM);
  // The typed leg took the trigger line: a trigger sent, and no signed receipt, so the words say
  // `sent (unconfirmed)` and never claim a read. The contract row's own meaning is unchanged.
  return show(
    await sent(place, ['lead', 'hello'], owner, sendHost(place)),
    'lead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)',
  );
});
scene('send.sent-unconfirmed', async (place) => {
  write(place, TEAM);
  // A live listener takes the message into the seat's inbox; the grace is zero, so the receipt
  // never has time to land and the leg ends `sent (unconfirmed)` — exit 0, nothing typed.
  liveInbox(place);
  return show(await sent(place, ['lead', 'hello'], owner, sendHost(place, { inboxGraceMs: 0 })), 'lead: sent (unconfirmed) (mcp-inbox, 0 ms)');
});
scene('send.queued', async (place) => {
  write(place, TEAM);
  // A daemon that answers `queued`: the receiver is busy, the signed copy is stored, and the
  // sender is answered now. The id on the line is the one the daemon will deliver under.
  const id = '55555555-5555-4555-8555-555555555555';
  const sock = join(place.base, 'daemon.sock');
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.end(`${JSON.stringify({
        v: 1,
        ok: true,
        id,
        seat: 'lead',
        outcome: 'queued',
        status: 'receiver busy',
        detail: 'lead: queued (receiver busy)',
      })}\n`);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(sock, resolve);
  });
  try {
    const host = sendHost(place);
    host.daemonSocket = sock;
    return show(await sent(place, ['lead', 'hello'], owner, host), `lead: queued (receiver busy) (typed, 0 ms; id ${id})`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
scene('send.dry-run', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello', '--dry-run'], owner, sendHost(place)), 'lead: dry-run: claude-code via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written');
});
scene('send.listed', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['--list'], owner, sendHost(place)), '  lead  -         coordinator  acme     socket');
});
scene('send.answered', async (place) => {
  write(place, TEAM);
  const sentId = '44444444-4444-4444-8444-444444444444';
  plantRecord(place.home, place.root, 'acme', 'owner', 'reply-1', 'the answer', {
    from: 'lead',
    at: NOW.toISOString(),
    thread: sentId,
    in_reply_to: sentId,
  });
  const host = sendHost(place);
  host.sendId = () => sentId;
  host.waitMs = 0;
  return show(await sent(place, ['lead', 'hello', '--wait'], owner, host), 'lead: answered\nthe answer');
});
scene('send.timeout', async (place) => {
  write(place, TEAM);
  const host = sendHost(place);
  host.waitMs = 0;
  return show(await sent(place, ['lead', 'hello', '--wait', '--timeout', '10'], owner, host), 'lead: timeout: sent, no reply on the thread within 10s; the thread stays open');
});

/** The file's lead seat, registered and rostered: `route` hands out addresses from the registry
 *  only, so its scenes give the registry the record `up` would have written. */
function registeredLead(place: Place): void {
  const id = teamIdOf(place.root);
  const lead = registerAgent(place.home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude-code --model test',
    reach: { team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(place.home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: place.root,
    lobby: lobbyDir(place.home),
    roster: [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
}

async function routed(place: Place, argv: string[], caller: Caller, host: SendHost): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runRoute(argv, io, host);
  return { code, out: io.out, err: io.err };
}

scene('route.routed', async (place) => {
  write(place, TEAM);
  registeredLead(place);
  return show(await routed(place, ['lead'], owner, sendHost(place)), 'admitted by: the owner');
});
scene('route.dry-run', async (place) => {
  write(place, TEAM);
  registeredLead(place);
  return show(await routed(place, ['lead', '--dry-run'], owner, sendHost(place)), 'append the route to');
});
scene('route.detached', async (place) => show(await routed(place, ['lead'], detachedCaller, sendHost(place)), ADMISSION));
scene('route.refused', async (place) => {
  write(place, TEAM);
  return show(await routed(place, ['missing'], owner, sendHost(place)), 'this team has no registry record yet');
});
scene('route.unrecorded', async (place) => {
  write(place, TEAM);
  registeredLead(place);
  // A file where the project's state folder would be: the ladder refuses it, so the record can
  // not be written — and a route answers nothing it can not account for.
  mkdirSync(join(place.home, '.config', 'team'), { recursive: true });
  writeFileSync(storePath('acme', place.root, place.home), '');
  return show(await routed(place, ['lead'], owner, sendHost(place)), 'the route record could not be written');
});
scene('route.configuration', async (place) => {
  const inRepo = show(await routed(place, ['lead'], owner, sendHost(place)), 'no team file');
  // Outside any checkout the same failure names only the project: route takes no `--file`.
  const outside = await routed({ ...place, root: place.base }, ['lead'], owner, sendHost(place));
  show(outside, 'not inside a git repository: run team from a project\n');
  expect(`${outside.out}${outside.err}`).not.toContain('--file');
  return inRepo;
});
scene('route.usage', async (place) => show(await routed(place, [], owner, sendHost(place)), 'a seat, a seat@team or an agent id is required'));

scene('send.recorded', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['--record', 'lead', '--channel', 'native', '--ms', '812'], owner, sendHost(place)), 'lead: recorded (native, 812 ms)');
});
scene('send.record-dry-run', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['--record', 'lead', '--channel', 'native', '--ms', '812', '--dry-run'], owner, sendHost(place)), 'lead: would record (native, 812 ms); nothing was written');
});

/** The state `up` leaves for the file's lead, on the pane `leadSeat` stands on: the handoff's
 *  sender is placed where the state records it, exactly as a plain send's caller is. */
function placeLead(place: Place): void {
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
}

/** The id the handoff prints, pinned so the scene's output is exact. */
const SEND_NATIVE_ID = '11111111-1111-4111-8111-111111111111';

/** TWO without the worker's `stopped` mark: a live claude-code seat for a claude-code sender.
 *  The team's own word names native first — a declared order is what puts that leg in the walk,
 *  since the default leaves it out — followed by the two legs a handoff falls back to. */
const LIVE_TWO = `${TWO.replace('    stopped: true\n', '')}delivery_order: [native, mcp-inbox, typed]\n`;

/** The handoff: a claude-code sender gets the pending record and the exact target, and nothing
 *  is delivered by that run. */
scene('send.native', async (place) => {
  write(place, LIVE_TWO);
  placeLead(place);
  const host = sendHost(place);
  // The recipient is the one live agent of that name, on its own pane; the socket sits at the
  // pid the fake pane process reports.
  host.agents = () => [{ name: 'worker', pane: 'w2:p1', cli: 'claude' }];
  host.newId = () => SEND_NATIVE_ID;
  const ran = await sent(place, ['worker', 'hello'], leadSeat, host);
  expect(ran.code).toBe(0);
  expect(existsSync(pendingPath('acme', place.root, place.home, SEND_NATIVE_ID))).toBe(true);
  expect(existsSync(historyPath('acme', place.root, place.home))).toBe(false);
  return show(ran, 'worker: native: nothing was sent; make the call with your own SendMessage');
});

/** The confirm: the handoff's own decision, written as the one history line, and the record
 *  cleared. */
scene('send.confirmed', async (place) => {
  write(place, LIVE_TWO);
  placeLead(place);
  const host = sendHost(place);
  host.agents = () => [{ name: 'worker', pane: 'w2:p1', cli: 'claude' }];
  host.newId = () => SEND_NATIVE_ID;
  host.native.paneText = () => `nv-${SEND_NATIVE_ID.replace(/-/g, '').slice(0, 8)}`;
  expect((await sent(place, ['worker', 'hello'], leadSeat, host)).code).toBe(0);
  const ran = await sent(place, ['--confirm', SEND_NATIVE_ID], leadSeat, host);
  expect(ran.code).toBe(0);
  const history = readHistory('acme', place.root, place.home);
  expect(history.ok && history.entries.map((entry) => [entry.outcome, entry.via, entry.ms])).toEqual([['delivered', 'native', 0]]);
  expect(existsSync(pendingPath('acme', place.root, place.home, SEND_NATIVE_ID))).toBe(false);
  return show(ran, 'worker: delivered (native, 0 ms)');
});

async function fed(place: Place, argv: string[]): Promise<Ran> {
  const io = testIo(place.root);
  const code = await runFeed(argv, io, { home: place.home, poll: async () => false });
  return { code, out: io.out, err: io.err };
}

scene('feed.ok', async (place) => {
  write(place, TEAM);
  return show(await fed(place, []), '0 events');
});
scene('feed.unreadable', async (place) => {
  write(place, TEAM);
  const log = historyPath('acme', place.root, place.home);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  symlinkSync('/etc/passwd', log);
  return show(await fed(place, []), 'the history log cannot be read: a symbolic link was found and not followed');
});
scene('feed.presence-unreadable', async (place) => {
  write(place, TEAM);
  // The message log is fine; the bus event log the presence rows come from is not, and the feed
  // refuses rather than print a timeline with a silence it cannot explain.
  const log = join(storePath('acme', place.root, place.home), 'events.jsonl');
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  symlinkSync('/etc/passwd', log);
  return show(await fed(place, []), 'the presence event log cannot be read: a symbolic link was found and not followed');
});
scene('feed.configuration', async (place) => {
  const inRepo = show(await fed(place, []), 'no team file');
  // Outside any checkout the same failure names only the project: feed takes no `--file`.
  const outside = await fed({ ...place, root: place.base }, []);
  show(outside, 'not inside a git repository: run team from a project\n');
  expect(`${outside.out}${outside.err}`).not.toContain('--file');
  return inRepo;
});
scene('feed.usage', async (place) => show(await fed(place, ['extra']), 'unexpected "extra"'));

// `team drops` reads one seat's own mailbox: the scenes place the lead on the pane the fixture
// caller runs on, and the folder is the one `team send` would write.
async function dropped(place: Place, argv: string[], caller: Caller = leadSeat): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runDrops(argv, io, { home: place.home });
  return { code, out: io.out, err: io.err };
}

scene('drops.ok', async (place) => {
  write(place, TEAM);
  placeLead(place);
  return show(await dropped(place, []), '0 drops');
});
scene('drops.file', async (place) => {
  // A checkout with no team file yet: the folder cannot be named without the session.
  placeLead(place);
  return show(await dropped(place, []), 'no team file');
});
scene('drops.refused', async (place) => {
  write(place, TEAM);
  placeLead(place);
  return show(await dropped(place, [], owner), 'only a seat of this team reads its own drops');
});
scene('drops.unreadable', async (place) => {
  write(place, TEAM);
  placeLead(place);
  const dir = join(place.root, '.agents', 'send-drops', 'acme', 'lead');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o000);
  try {
    return show(await dropped(place, []), "the drop folder can't be read");
  } finally {
    chmodSync(dir, 0o755);
  }
});
scene('drops.invocation', async (place) => {
  write(place, TEAM);
  placeLead(place);
  return show(await dropped(place, ['extra']), 'unexpected "extra"');
});
scene('drops.not-a-repo', async (place) => show(await dropped(place, []), 'not inside a git repository'), false);

// --- team mcp: a synthetic helper, bridge and front, under the scene's own temp base. The tree
// is real (modes, sizes and the config's bytes are read as the command reads them), while the
// probes that would touch the machine — the socket, the two HTTP requests, the certificate and
// the bridge process — are fixture answers. Nothing here reaches a live bridge.

const MCP_NOW = new Date('2026-10-10T12:00:00Z');
const MCP_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAXPtFj070wFMReZCEIEoqh6h0qjuWZy4l0lwzQcPVQTM=\n-----END PUBLIC KEY-----\n';

function mcpSynthetic(place: Place, over: Partial<McpSources> = {}): McpSources {
  const helper = join(place.base, 'helper');
  mkdirSync(helper, { mode: 0o755 });
  for (const dir of ['keys', 'queue', 'state']) mkdirSync(join(helper, dir), { recursive: true, mode: 0o700 });
  mkdirSync(join(helper, 'sock'), { recursive: true, mode: 0o750 });
  mkdirSync(join(helper, 'bin'), { recursive: true });
  mkdirSync(join(helper, 'app', 'src', 'connector'), { recursive: true });
  writeFileSync(join(helper, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(helper, 'app', 'src', 'connector', 'bridge-main.ts'), '// deployed\n', { mode: 0o644 });
  writeFileSync(join(helper, 'helper-config.json'), '{}\n', { mode: 0o600 });
  const lobby = join(place.home, '.config', 'team', 'lobby');
  const frame = join(lobby, 'mcp-1');
  mkdirSync(frame, { recursive: true, mode: 0o700 });
  const signer = join(frame, 'signer.sock');
  const mailbox = join(frame, 'mailbox');
  const audit = join(frame, 'audit.jsonl');
  writeFileSync(join(frame, 'bridge.json'), `${JSON.stringify({
    version: 1,
    wss_url: 'wss://bridge.example.test/connector',
    connector_token: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    queue_hmac_key: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    relay_public_keys: { 'relay-a': MCP_PUBLIC_KEY },
    seats: [{ alias: 'probe', route: 'seat-probe-1', key_id: 'seat-probe-1', public_key: MCP_PUBLIC_KEY }],
    signer_socket: signer,
    mailbox_dir: mailbox,
    audit_file: audit,
  }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(signer, '', { mode: 0o600 });
  mkdirSync(mailbox, { mode: 0o700 });
  writeFileSync(audit, '{"ts":"2026-10-10T11:59:00Z","event":"ws-open"}\n', { mode: 0o600 });
  return {
    ...realSources,
    home: () => place.home,
    helperRoot: () => helper,
    now: () => MCP_NOW,
    // The signer socket's file kind and mode, which a plain file cannot carry on the test's host.
    stat: (path) => (path === signer ? { kind: 'socket', mode: 0o660, size: 0 } : realSources.stat(path)),
    probeSocket: async () => 'ok',
    probeHttp: async () => 401,
    certExpiry: async () => ({ validTo: '2027-01-02T09:00:00Z', authorized: true }),
    processRunning: () => true,
    ...over,
  };
}

async function mcpRan(place: Place, argv: string[], over: Partial<McpSources> = {}): Promise<Ran> {
  const io = testIo(place.root, owner);
  const code = await runMcp(argv, io, mcpSynthetic(place, over));
  return { code, out: io.out, err: io.err };
}

scene('mcp.up', async (place) => show(await mcpRan(place, ['status']), 'state: up'));
scene('mcp.down', async (place) => show(await mcpRan(place, ['status'], { processRunning: () => false }), 'state: down'));
scene('mcp.not-set-up', async (place) => show(await mcpRan(place, ['status'], { listDir: () => [] }), 'state: not-set-up'));
scene('mcp.clear', async (place) => show(await mcpRan(place, ['doctor']), 'nothing missing'));
scene('mcp.missing', async (place) => show(await mcpRan(place, ['doctor'], { listDir: () => [] }), 'no bridge configuration'));
scene('mcp.invocation', async (place) => show(await mcpRan(place, []), 'a subcommand is required'));
// The server ends cleanly when its client closes stdin: no lines in, no lines out, exit 0.
scene('mcp.serve-ended', async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runMcpServe({ seat: 'lead', session: undefined }, io, {
    lines: (async function* () {
      // stdin is already closed
    })(),
    write: () => {},
  });
  return { code, out: io.out, err: io.err };
});
// A seat the team file does not declare is refused before the server serves anything.
scene('mcp.serve-refused', async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runMcpServe({ seat: 'ghost', session: undefined }, io, {
    lines: (async function* () {
      // the refusal leaves before any line is read
    })(),
    write: () => {},
  });
  return show({ code, out: io.out, err: io.err }, 'declares no seat');
});

const RELOAD_FILE = TEAM.replace(
  'launch: claude --model claude-opus-5-5\n',
  'launch: claude --model claude-opus-5-5\n    effort: high\n',
);
const RELOAD_GRANT = `${TWO.replace('    stopped: true\n', '')}grant:\n  session: acme\n  seat: lead\n  scope:\n    - reload\n`;

function recordReload(place: Place, name: string, recorded = true): void {
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats[name] = {
      stage: 'ready',
      pane: 'w1:p1',
      workspace: 'w1',
      launched: { shell: 1, cli: [2] },
      ...(recorded ? { model: 'Claude Opus', version: '5.5' } : {}),
    };
  });
}

function reloadLaunch(options: { create?: boolean; agents?: HerdrAgent[]; text?: string } = {}): Launch {
  const panes = new Map<string, string>([['w1:p1', options.text ?? IDLE]]);
  let clock = Date.parse('2026-10-14T09:00:00Z');
  let n = 0;
  return {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      if (options.create === false) return null;
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, IDLE);
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane) {
      panes.set(pane, IDLE);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes.keys()],
    agents: () => options.agents ?? [agent('lead')],
    workspacePanes: () => ['w1:p1'],
    paneText: (_session, pane) => panes.get(pane) ?? options.text ?? IDLE,
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
}

async function reloaded(place: Place, argv: string[], caller: Caller = owner, sources: Partial<ReloadSources> = {}): Promise<Ran> {
  const io = testIo(place.root, caller);
  return {
    code: await runReload(argv, io, { launch: reloadLaunch(), home: place.home, ...sources }),
    out: io.out,
    err: io.err,
  };
}

scene('reload.client-refused', async (place) => show(await reloaded(place, ['lead', '--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller), 'no client grant can verify'));
scene('reload.reloaded', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead']), 'lead reloaded');
});
scene('reload.same', async (place) => {
  write(place, TEAM);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead']), 'already running what the file declares');
});
scene('reload.absent', async (place) => {
  write(place, TEAM);
  return show(await reloaded(place, ['missing']), 'no seat of that name');
});
scene('reload.human', async (place) => {
  write(place, TWO.replace('    stopped: true\n', '    human: true\n'));
  return show(await reloaded(place, ['worker']), "worker is a human's pane");
});
scene('reload.changed', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ agents: [] }) }), 'changed before it closed');
});
scene('reload.launch', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ create: false }) }), 'did not reach ready');
});
scene('reload.not-idle', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  // An unread screen with herdr reporting neither work nor an idle seat: only herdr's idle or
  // done word lets an unread screen close, so this stays the refusal.
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ text: 'no prompt here', agents: [agent('lead', 'blocked')] }) }), 'not at an idle prompt');
});
scene('reload.not-running', async (place) => {
  write(place, TEAM);
  return show(await reloaded(place, ['lead']), 'no ready pane to close');
});
scene('reload.unrecorded', async (place) => {
  write(place, TEAM);
  recordReload(place, 'lead', false);
  return show(await reloaded(place, ['lead']), 'its launch record held no model; recorded Claude Opus 5.5 from its screen');
});
scene('reload.unsent', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ text: claudeBox('draft') }) }), 'holds unsent text');
});
scene('reload.untested', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  // The installed CLI sits outside its profile's tested range: the relaunch's ready screen may
  // be one no recogniser knows, so the seat is not closed at all.
  return show(await reloaded(place, ['lead'], owner, { version: () => '2.2.0' }), 'its ready screen may not be recognised, so nothing closed');
});
scene('reload.working', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ agents: [agent('lead', 'working')] }) }), 'is working');
});
scene('reload.run-lock', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  const held = acquireRunLock(join(place.root, '.agents'), 'acme');
  try {
    return show(await reloaded(place, ['lead']), 'another session-mutating run');
  } finally {
    if (!('held' in held)) held.release();
  }
});
scene('reload.invocation', async (place) => show(await reloaded(place, []), 'a <seat> is required'));
scene('reload.file', async (place) => show(await reloaded(place, ['lead', '--file', 'missing.yaml']), 'no team file'));
scene('reload.self', async (place) => {
  approve(place, RELOAD_GRANT);
  recordLead(place);
  return show(await reloaded(place, ['lead'], leadSeat), "does not close the caller's seat");
});
scene('reload.grant-approval', async (place) => {
  write(place, RELOAD_GRANT);
  return show(await reloaded(place, ['worker'], leadSeat), 'a grant needs a verified approval');
});
scene('reload.grant-caller', async (place) => {
  approve(place, RELOAD_GRANT);
  recordLead(place);
  return show(await reloaded(place, ['worker'], other), 'only the seat the grant names');
});
scene('reload.grant-no-pane', async (place) => {
  approve(place, RELOAD_GRANT);
  return show(await reloaded(place, ['worker'], leadSeat), 'no pane is recorded for seat lead');
});
scene('reload.grant-another-pane', async (place) => {
  approve(place, RELOAD_GRANT);
  recordLead(place, 'w2:p1');
  return show(await reloaded(place, ['worker'], leadSeat), 'the state records pane w2:p1 for seat lead');
});
scene('reload.grant-scope', async (place) => {
  approve(place, RELOAD_GRANT.replace('    - reload\n', '    - up\n'));
  recordLead(place);
  return show(await reloaded(place, ['worker'], leadSeat), 'the grant does not list `reload`');
});
scene('reload.grant-flag', async (place) => {
  approve(place, RELOAD_GRANT);
  recordLead(place);
  return show(await reloaded(place, ['worker', '--file', 'other.yaml'], leadSeat), "--file is the owner's");
});
scene('reload.grant-omitted', async (place) => {
  approve(place, TEAM);
  return show(await reloaded(place, ['lead'], other), 'the file grants nothing');
});
scene('reload.grant-file', async (place) => {
  write(place, 'format: [\n');
  return show(await reloaded(place, ['lead'], leadSeat), 'line');
});

// Outcomes that are listed and kept, and that no scene can produce. An edit the earlier checks
// have already validated reads here (add.prepared, add.locked, add.not-restored), and so do
// answer.action and up.delegate-placement. add.no-profile, register.no-profile and
// remove.no-profile joined them when grok's profile shipped: the file loader accepts exactly the
// CLIs this version knows, and every one of them now has a launch profile, so no team file can
// reach the refusals — they stand, rows and exit sites whole, for a CLI listed before its profile
// ships, which is the state grok itself was in until now.
// The no-terminal refusal names each command's own actors and places: the owner-only commands
// keep the plain sentence, and every command the map admits more widely prints its own.
const SENTENCE = 'only the owner runs this, from a terminal outside herdr';
const LEADS = 'only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane';
const OWN_TEAM = 'only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane';
const DELEGATE = 'only the owner or an approved delegate runs this, from a terminal outside herdr or its own pane';
const ADMISSION = 'only the owner or a seat the send admission admits runs this, from a terminal outside herdr or its own pane';
const ANSWER = 'only the owner or the orchestrator from its own seat runs this, from a terminal outside herdr or its own seat';
const PLACED = 'only the owner or a placed seat runs this, from a terminal outside herdr or its own pane';
const ORCH = 'only the owner, the orchestrator or the operator runs this, from a terminal outside herdr or its own seat';
scene('add.detached', async (place) => show(await added(place, ['worker'], detachedCaller, addSources(place)), DELEGATE));
scene('answer.detached', async (place) => show(await answered(place, ['lead', 'trust'], detachedCaller, answerHost(place, '')), ANSWER));
scene('broker.detached', async (place) => show(await brokered(place, [], { keyReader: okKey }, detachedCaller), SENTENCE));
scene('down.detached', async (place) => show(await down(place, [], detachedCaller, downSources()), LEADS));
scene('init.detached', async (place) => show(await initial(place, [], detachedCaller), SENTENCE));
scene('remove.detached', async (place) => show(await removed(place, ['worker'], detachedCaller, downSources()), LEADS));
scene('send.detached', async (place) => show(await sent(place, ['--list'], detachedCaller, sendHost(place)), ADMISSION));
scene('up.detached', async (place) => show(await up(place, ['--session', 'elsewhere'], detachedCaller, upSources(place)), LEADS));
scene('watch.caller', async (place) => show(await watched(place, [], detachedCaller), PLACED));
scene('worktree.detached', async (place) => show(await worktree(place, ['list'], detachedCaller), ORCH));

const ACTIVE_TWO = TWO.replace('    stopped: true\n', '');

function restartSources(place: Place, over: Partial<RestartSources> = {}): RestartSources {
  return {
    ...downSources({ home: place.home }),
    home: place.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(place.home),
    now: () => NOW,
    launch: downLaunch(),
    upLaunch: launching(IDLE),
    ...over,
  };
}

async function restarted(
  place: Place,
  argv: string[],
  caller: Caller = owner,
  over: Partial<RestartSources> = {},
): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runRestart(argv, io, restartSources(place, over));
  return { code, out: io.out, err: io.err };
}

scene('restart.usage', async (place) => show(await restarted(place, []), 'a seat name is required'));
scene('restart.client-refused', async (place) => show(await restarted(place, ['worker', '--client', 'missing-grant.json', '--key', 'missing.key'], detachedCaller), 'no client grant can verify'));
scene('restart.configuration', async (place) => show(await restarted(place, ['worker', '--file', 'missing.yaml']), 'no team file'));
scene('restart.detached', async (place) => show(await restarted(place, ['worker'], detachedCaller), LEADS));
scene('restart.caller', async (place) => {
  write(place, ACTIVE_TWO);
  return show(await restarted(place, ['worker'], other), 'only the owner or `leads` restarts a seat');
});
scene('restart.self', async (place) => {
  write(place, ACTIVE_TWO);
  recordLead(place, leadSeat.pane);
  return show(await restarted(place, ['lead'], leadSeat), 'cannot restart its own recorded pane');
});
scene('restart.temporary', async (place) => {
  write(place, ACTIVE_TWO);
  updateState(join(place.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:out.md' } };
  });
  return show(await restarted(place, ['worker-tmp-1']), 'is a temporary copy');
});
scene('restart.unknown', async (place) => {
  write(place, ACTIVE_TWO);
  return show(await restarted(place, ['missing']), 'not a signed declared seat');
});
scene('restart.lead', async (place) => {
  // The map admits the lead for `restart`; the seat caller is the lead, standing on its own
  // recorded pane, and the target the file's operator. The abandon rule refuses it there.
  write(place, ACTIVE_TWO.replace('operator: lead', 'operator: worker'));
  recordLead(place, leadSeat.pane);
  return show(await restarted(place, ['worker', '--abandon'], leadSeat), 'does not abandon the orchestrator');
});
scene('restart.signed-off', async (place) => {
  write(place, TWO);
  return show(await restarted(place, ['worker']), 'is signed off');
});
scene('restart.herdr', async (place) => {
  write(place, ACTIVE_TWO);
  return show(await restarted(place, ['worker'], owner, { sessionState: () => null }), "doesn't answer");
});
scene('restart.no-session', async (place) => {
  write(place, ACTIVE_TWO);
  return show(await restarted(place, ['worker'], owner, { sessionState: () => 'absent', sessionRunning: () => false }), 'is not running');
});
scene('restart.replaced', async (place) => {
  write(place, ACTIVE_TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.worker = {
      stage: 'ready',
      pane: 'pane-old',
      workspace: 'ws-old',
      launched: { shell: 400, cli: [401] },
    };
  });
  const upLaunch = launching(IDLE);
  upLaunch.processInfo = () => ({ shell: 400, foreground: [999] });
  return show(await restarted(place, ['worker'], owner, { upLaunch }), 'has a process in its old pane');
});
scene('restart.abandon-working', async (place) => {
  write(place, ACTIVE_TWO);
  recordLead(place, leadSeat.pane);
  return show(await restarted(place, ['worker', '--abandon'], leadSeat, {
    agents: () => [agent('worker', 'working')],
    screen: () => ({ kind: 'working' }),
  }), "a seat's --abandon leaves it");
});
scene('restart.busy', async (place) => {
  write(place, ACTIVE_TWO);
  return show(await restarted(place, ['worker'], owner, {
    agents: () => [agent('worker', 'working')],
    screen: () => ({ kind: 'working' }),
  }), 'is working; left as it is');
});
scene('restart.not-ready', async (place) => {
  approve(place, ACTIVE_TWO);
  return show(await restarted(place, ['worker'], owner, {
    doctor: doctor(place.home, { version: () => null }),
  }), 'install');
});
scene('restart.dry-run', async (place) => {
  approve(place, ACTIVE_TWO);
  return show(await restarted(place, ['worker', '--dry-run'], owner), 'dry run: nothing was run');
});
scene('restart.run-lock', async (place) => {
  approve(place, ACTIVE_TWO);
  const dir = join(place.root, '.agents');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  writeFileSync(seatLockPath(dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
  return show(await restarted(place, ['worker'], owner), 'another session-mutating run is holding');
});
scene('restart.ready', async (place) => {
  approve(place, ACTIVE_TWO);
  return show(await restarted(place, ['lead'], owner), 'restarted lead');
});

// `team register`: the record for a seat that is already running. The gate is `up`'s, run by the
// command itself; only the reads this harness has no herdr for are stood in — the session, its
// agents, a pane's processes and a pane's text.
function registerSources(place: Place, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: place.home,
    sessionState: () => 'running',
    agents: () => [],
    // A CLI in front of the pane's own shell: the identity a launch would have recorded.
    processInfo: () => ({ shell: 400, foreground: [401] }),
    // The process herdr reports is the one the seat's profile names (`claude-code`).
    foreground: () => ['claude'],
    // The address a register records for the seat: the scene runs no sockets.
    refreshAddress: () => ({ address: null }),
    paneText: () => IDLE,
    // The two sidebar writes an adoption re-applies (`register-label.test.ts` holds their
    // scenes): noops that report "done", so these scenes spawn no herdr.
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    now: () => NOW,
    ...over,
  };
}

async function registered(
  place: Place,
  argv: string[],
  caller: Caller = owner,
  over: Partial<RegisterSources> = {},
): Promise<Ran> {
  const io = testIo(place.root, caller);
  return runCompared(place, argv, (args) => runRegister(args, io, registerSources(place, over)), io);
}

/** The delegate gate's own reads, as the `up` scenes stand them in: this harness's approval store,
 *  and herdr answers a scene gives. */
const registerGate = (place: Place, over: DelegateSources = {}): Partial<RegisterSources> => gateAt(place, over);

/** The same file with a grant naming the lead seat for `up`: register's second fallback. */
const REGISTER_GRANT = `${TEAM}grant:\n  session: acme\n  seat: lead\n  scope:\n    - up\n`;

scene('register.usage', async (place) => show(await registered(place, []), 'a seat name is required'));
scene('register.file', async (place) => {
  const inRepo = show(await registered(place, ['lead']), 'no team file');
  // Outside any checkout the same failure names only the project: register takes no `--file`.
  const outside = await registered({ ...place, root: place.base }, ['lead']);
  show(outside, 'not inside a git repository: run team from a project\n');
  expect(`${outside.out}${outside.err}`).not.toContain('--file');
  return inRepo;
});
scene('register.detached', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], detachedCaller), OWN_TEAM);
});
scene('register.caller', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead', '--session', 'other'], leadSeat), "--session is the owner's");
});
scene('register.not-owner', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], other), 'only the owner or a seat of this team registers a running seat');
});
scene('register.delegate', async (place) => {
  approve(place, `${TEAM}${DELEGATES}`);
  return show(await registered(place, ['lead'], other, registerGate(place, { agents: () => [] })), 'only the owner or the approved delegate runs');
});
scene('register.grant', async (place) => {
  approve(place, REGISTER_GRANT);
  recordLead(place);
  return show(await registered(place, ['lead'], other, { agents: () => [agent('lead')] }), 'only the seat the grant names');
});
scene('register.grant-flag', async (place) => {
  approve(place, REGISTER_GRANT);
  recordLead(place);
  return show(await registered(place, ['lead', '--session', 'other'], leadSeat, { agents: () => [agent('lead')] }), 'the granted seat cannot use it');
});
scene('register.no-seat', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['missing']), 'no seat "missing"');
});
scene('register.stopped', async (place) => {
  write(place, TWO);
  return show(await registered(place, ['worker']), 'is stopped in this file');
});
scene('register.herdr', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, { sessionState: () => null }), "doesn't answer");
});
scene('register.no-session', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, { sessionState: () => 'stopped' }), 'is not running');
});
scene('register.session-file', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).launched_file = join(place.base, 'other', 'team.yaml');
  });
  return show(await registered(place, ['lead']), 'was launched from');
});
scene('register.no-agent', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, { agents: () => [] }), 'no agent named');
});
scene('register.many-agents', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, { agents: () => [agent('lead'), agent('lead')] }), 'agents named');
});
scene('register.recorded', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w9:p1' };
  });
  return show(await registered(place, ['lead'], owner, { agents: () => [agent('lead')] }), 'is already recorded on pane w9:p1');
});
scene('register.no-cli', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, {
    agents: () => [agent('lead')],
    processInfo: () => ({ shell: 400, foreground: [] }),
  }), 'holds no process in front of its shell');
});
scene('register.cli', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, {
    agents: () => [agent('lead')],
    foreground: () => ['node'],
  }), 'holds no `claude-code` process');
});
scene('register.screen', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, {
    agents: () => [agent('lead')],
    screen: () => ({ kind: 'permission' }),
  }), 'not the seat at its prompt');
});
scene('register.dry-run', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead', '--dry-run'], owner, { agents: () => [agent('lead')] }), 'would register');
});
scene('register.already', async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
  return show(await registered(place, ['lead'], owner, { agents: () => [agent('lead')] }), 'already registered — pane w1:p1');
});
scene('register.no-pane', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead', '--pane', 'w9:p9'], owner, { processInfo: () => null }), 'no pane w9:p9 in session');
});
scene('register.pane-taken', async (place) => {
  // The file declares the seat whose record holds the pane, so the record really is another
  // seat's: a record for a seat the file no longer declares holds nothing — the file is the
  // truth, and `test/state-departed-seats.test.ts` reads that side.
  write(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'w2:p2' };
  });
  return show(await registered(place, ['lead', '--pane', 'w2:p2'], owner, { agents: () => [] }), "pane w2:p2 is worker's in session");
});
scene('register.pane-named', async (place) => {
  write(place, TEAM);
  return show(
    await registered(place, ['lead', '--pane', 'w2:p2'], owner, {
      agents: () => [{ ...agent('worker'), pane: 'w2:p2' }],
    }),
    'pane w2:p2 is named worker in session',
  );
});
scene('register.ready', async (place) => {
  write(place, TEAM);
  return show(await registered(place, ['lead'], owner, { agents: () => [agent('lead')] }), 'registered — pane w1:p1; nothing was launched');
});

// Authority management shares the owner-only editor; each public wrapper owns its exits.
for (const [name, command, args, invalidArgs] of [
  ['grant', runGrant, ['lead', '--scope', 'up,down'], ['lead', '--scope', 'trust']],
  ['delegate', runDelegate, ['outside/control', '--commands', 'up,down'], ['outside/control', '--commands', 'grant']],
  ['revoke', runRevoke, ['grant'], ['delegate', 'malformed']],
] as const) {
  async function managed(place: Place, argv: readonly string[], caller: Caller = owner): Promise<Ran> {
    const io = testIo(place.root, caller);
    return { code: await command([...argv], io, { home: place.home }), out: io.out, err: io.err };
  }
  scene(`${name}.invocation`, async (place) => show(await managed(place, ['--unknown']), 'unknown option'));
  scene(`${name}.refused`, async (place) => {
    // The missing file is deliberate: caller refusal precedes its first read.
    return show(await managed(place, args, detachedCaller), 'only the owner runs this');
  });
  scene(`${name}.invalid`, async (place) => {
    write(place, TEAM);
    return show(await managed(place, invalidArgs), `team ${name}:`);
  });
  scene(`${name}.done`, async (place) => {
    const original = name === 'revoke' ? `${TEAM}grant:\n  session: acme\n  seat: lead\n  scope: [up]\n` : TEAM;
    write(place, original);
    const preview = await managed(place, [...args, '--dry-run']);
    expect(preview.code).toBe(0);
    expect(preview.out).toBe(`${name}: would change\n`);
    expect(readFileSync(place.file, 'utf8')).toBe(original);
    return show(await managed(place, args), `${name}: updated`);
  });
}

{
  async function policyRun(place: Place, argv: readonly string[], caller: Caller = owner): Promise<Ran> {
    const io = testIo(place.root, caller);
    return { code: await runPolicy([...argv], io, { home: place.home }), out: io.out, err: io.err };
  }
  scene('policy.invocation', async (place) => show(await policyRun(place, ['--unknown']), 'unknown option'));
  scene('policy.refused', async (place) => show(await policyRun(place, ['set', 'team', 'dev-mode', 'on'], detachedCaller), 'only the owner runs this'));
  scene('policy.invalid', async (place) => {
    write(place, TEAM);
    // A delay threshold above the release default is the same invalid-value exit, before writing.
    const ceiling = await policyRun(place, ['set', 'team', 'held', '900']);
    expect(ceiling.code).toBe(2);
    expect(ceiling.err).toContain('may only be shortened');
    return show(await policyRun(place, ['set', 'team', 'dev-mode', 'maybe']), 'team policy:');
  });
  scene('policy.done', async (place) => {
    write(place, TEAM);
    return show(await policyRun(place, []), 'POLICY');
  });
}

{
  async function renameRun(place: Place, argv: readonly string[], caller: Caller = owner): Promise<Ran> {
    const io = testIo(place.root, caller);
    return { code: await runRename([...argv], io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
  }
  scene('rename.invocation', async (place) => show(await renameRun(place, []), 'a seat name and a new seat name are required'));
  scene('rename.refused', async (place) => {
    write(place, TWO);
    return show(await renameRun(place, ['worker', 'lead']), 'seat "lead" is already declared');
  });
  scene('rename.invalid', async (place) => {
    write(place, TWO);
    return show(await renameRun(place, ['worker', 'Bad_Name']), 'not a valid seat name');
  });
  scene('rename.done', async (place) => {
    write(place, TWO);
    return show(await renameRun(place, ['worker', 'builder-1']), 'renamed worker -> builder-1');
  });
}


{
  const SENT = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  // The file declares the seat the planted record comes from, so a reply reaches it.
  const FILE = TWO.replace('workspace:', 'session: acme\nworkspace:');
  async function replied(place: Place, argv: readonly string[]): Promise<Ran> {
    const io = testIo(place.root, owner);
    return { code: await runReply([...argv], io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
  }
  scene('reply.replied', async (place) => {
    write(place, FILE);
    plantRecord(place.home, place.root, 'acme', 'owner', SENT, "from the file's seat worker (no registry record yet) — admitted by: a seat to its own team's orchestrator\n\nquestion", { from: 'worker', at: NOW.toISOString() });
    return show(await replied(place, [SENT, 'the answer']), 'worker: replied');
  });
  scene('reply.refused', async (place) => {
    write(place, FILE);
    messageKeyOf(place.home);
    return show(await replied(place, [SENT, 'the answer']), 'no record named');
  });
  scene('reply.configuration', async (place) => {
    write(place, 'format: [\n');
    return show(await replied(place, [SENT, 'the answer']), 'team reply:');
  });
  scene('reply.usage', async (place) => show(await replied(place, []), '<id> is required'));
}

{
  const SENT = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const FILE = TWO.replace('workspace:', 'session: acme\nworkspace:');
  async function acked(place: Place, argv: readonly string[]): Promise<Ran> {
    const io = testIo(place.root, owner);
    return { code: await runAck([...argv], io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
  }
  scene('ack.read', async (place) => {
    write(place, FILE);
    plantRecord(place.home, place.root, 'acme', 'owner', SENT, "from the file's seat worker (no registry record yet) — admitted by: a seat to its own team's orchestrator\n\nquestion", { from: 'worker', at: NOW.toISOString() });
    return show(await acked(place, [SENT]), `${SENT}: read`);
  });
  scene('ack.refused', async (place) => {
    write(place, FILE);
    messageKeyOf(place.home);
    return show(await acked(place, [SENT]), 'no record named');
  });
  scene('ack.configuration', async (place) => {
    write(place, 'format: [\n');
    return show(await acked(place, [SENT]), 'team ack:');
  });
  scene('ack.usage', async (place) => show(await acked(place, []), '<id> is required'));
}

{
  // `team swap` reads the entity's model rule from the signed entity source and owns the
  // project's queue. The rule is seeded through the same writer `team policy set` uses; the
  // queue lives in the state file beside the team file.
  const SWAP_TEAM = `format: 1
project: acme
entity: lab
coordinator: lead
operator: lead
workspace:
  mode: shared
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
    name: worker
    label: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
`;
  async function swapped(
    place: Place,
    argv: readonly string[],
    caller: Caller = owner,
    over: Partial<RestartSources> = {},
  ): Promise<Ran> {
    const io = testIo(place.root, caller);
    return {
      code: await runSwap([...argv], io, {
        home: place.home,
        now: () => NOW,
        sources: restartSources(place, over),
      }),
      out: io.out,
      err: io.err,
    };
  }
  function swapRule(place: Place, value = '*=!anthropic'): void {
    const wrote = writePolicySet(place.home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
    if (!wrote.ok) throw new Error(wrote.why);
  }
  scene('swap.listed', async (place) => {
    write(place, SWAP_TEAM);
    return show(await swapped(place, []), 'nothing queued');
  });
  scene('swap.rule', async (place) => {
    write(place, SWAP_TEAM);
    return show(await swapped(place, ['queue', 'lead']), 'declares no model rule');
  });
  scene('swap.seat', async (place) => {
    write(place, SWAP_TEAM);
    return show(await swapped(place, ['queue', 'nobody']), 'no seat "nobody"');
  });
  scene('swap.unchanged', async (place) => {
    write(place, SWAP_TEAM);
    swapRule(place);
    return show(await swapped(place, ['queue', 'worker']), 'declares a model the rule allows');
  });
  scene('swap.target', async (place) => {
    write(place, SWAP_TEAM);
    // Both vendors are refused, so the entity holds no donor the target may copy from.
    swapRule(place, '*=!anthropic+!deepseek');
    return show(await swapped(place, ['queue', 'lead']), 'no seat of the entity');
  });
  scene('swap.queued', async (place) => {
    write(place, SWAP_TEAM);
    swapRule(place);
    return show(await swapped(place, ['queue', 'lead']), 'swap queued: lead');
  });
  scene('swap.forced', async (place) => {
    approve(place, SWAP_TRUST(place));
    swapRule(place);
    await swapped(place, ['queue', 'lead']);
    const oldPane = 'w9:p1';
    let typed = '';
    let shelled = false;
    const ran = await swapped(place, ['now', 'lead'], owner, {
      agents: () => [{ ...agent('lead'), pane: oldPane }],
      launch: downLaunch({
        typeText: (_session, pane, text) => {
          if (pane === oldPane) typed = text;
          return true;
        },
        pressEnter: (_session, pane) => {
          if (pane === oldPane) shelled = true;
          return true;
        },
      }),
      screenText: (_session, pane) => (pane === oldPane ? (typed === '' ? IDLE : claudeBox(typed)) : undefined),
      foreground: (_session, pane) => (pane === oldPane && shelled ? ['zsh'] : ['claude']),
    });
    expect(ran.out).toContain('swapped: lead in w1:p1 (read-back unread)');
    return show(ran, 'swap forced: lead');
  });
  scene('swap.cancelled', async (place) => {
    write(place, SWAP_TEAM);
    swapRule(place);
    await swapped(place, ['queue', 'lead']);
    return show(await swapped(place, ['cancel', 'lead']), 'swap cancelled: lead');
  });
  scene('swap.caller', async (place) => {
    write(place, SWAP_TEAM);
    // A seat of the team that is neither the orchestrator nor the operator: the verdict names
    // no exact step, only that the call is a seat.
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p2', session: 'acme' };
    return show(await swapped(place, ['queue', 'lead'], worker), 'only the owner, the orchestrator or the operator');
  });
  scene('swap.detached', async (place) => {
    write(place, SWAP_TEAM);
    return show(await swapped(place, ['now', 'lead'], detachedCaller), 'a terminal outside herdr');
  });
  scene('swap.io', async (place) => {
    write(place, SWAP_TEAM);
    writeFileSync(join(place.root, '.agents', 'team.state.json'), '{ not json\n');
    return show(await swapped(place, ['cancel', 'lead']), 'is not valid JSON');
  });
  scene('swap.not-queued', async (place) => {
    write(place, SWAP_TEAM);
    return show(await swapped(place, ['cancel', 'lead']), 'waits on no swap');
  });
  scene('swap.invocation', async (place) => {
    write(place, SWAP_TEAM);
    return show(await swapped(place, ['queue']), 'a <seat> is required for "swap queue"');
  });
  scene('swap.file', async (place) => show(await swapped(place, []), 'no team file'));
  // The run's own outcomes. A run reads herdr before it does anything, so a scene that would
  // run a swap stands herdr in; the stop is the down path's own typing, and the fake renders
  // the exit text back so the stop reads it, then reports the shell once Enter is pressed.
  const SWAP_TRUST = (place: Place): string => SWAP_TEAM.replace(
    'workspace:\n',
    `trust:\n  - ~/.config/team/lobbies/lab\n  - ${place.root}\nworkspace:\n`,
  );
  scene('swap.herdr', async (place) => {
    write(place, SWAP_TEAM);
    swapRule(place);
    await swapped(place, ['queue', 'lead']);
    return show(
      await swapped(place, ['--run'], owner, { agents: () => null }),
      'herdr cannot be read, so no swap can be run now',
    );
  });
  scene('swap.ran', async (place) => {
    approve(place, SWAP_TRUST(place));
    swapRule(place);
    await swapped(place, ['queue', 'lead']);
    const oldPane = 'w9:p1';
    let typed = '';
    let shelled = false;
    return show(await swapped(place, ['--run'], owner, {
      agents: () => [{ ...agent('lead'), pane: oldPane }],
      launch: downLaunch({
        typeText: (_session, pane, text) => {
          if (pane === oldPane) typed = text;
          return true;
        },
        pressEnter: (_session, pane) => {
          if (pane === oldPane) shelled = true;
          return true;
        },
      }),
      screenText: (_session, pane) => (pane === oldPane ? (typed === '' ? IDLE : claudeBox(typed)) : undefined),
      foreground: (_session, pane) => (pane === oldPane && shelled ? ['zsh'] : ['claude']),
    }), 'swapped: lead in w1:p1 (read-back unread)');
  });
  scene('swap.run-failed', async (place) => {
    write(place, SWAP_TEAM);
    swapRule(place);
    await swapped(place, ['queue', 'lead']);
    // The record outlives the declaration: the file no longer declares the seat, so the run
    // reports it and removes the record rather than launching over a name it cannot find.
    write(place, SWAP_TEAM.replace('coordinator: lead\noperator: lead\n', 'coordinator: worker\noperator: worker\n').replace(LEAD, ''));
    return show(
      await swapped(place, ['--run'], owner, { agents: () => [] }),
      'is no longer declared in the team file; its queued swap was removed',
    );
  });
}

async function imported(place: Place, mode: 'migrate' | 'import', argv: string[], caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  // The registry lives under the scene's own home, never the machine's.
  const run = mode === 'migrate' ? runMigrate : runImport;
  return { code: await run(argv, io, { home: place.home, now: () => NOW }), out: io.out, err: io.err };
}
function corruptTeamRecord(place: Place): void {
  const dir = join(place.home, '.config', 'team', 'team-config');
  for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '{ not json\n');
}

scene('migrate.done', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'migrate', []), 'read back and verified');
});
scene('migrate.already-migrated', async (place) => {
  write(place, TEAM);
  await imported(place, 'migrate', ['--keep-file']);
  write(place, TEAM.replace('project: acme', 'project: acme-other'));
  return show(await imported(place, 'migrate', []), 'team import');
});
scene('migrate.detached', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'migrate', [], detachedCaller), 'migrate');
});
scene('migrate.not-owner', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'migrate', [], other), 'only the owner runs migrate');
});
scene('migrate.invalid', async (place) => {
  writeFileSync(join(place.root, '.agents', 'team.yaml'), 'format: [\n');
  return show(await imported(place, 'migrate', []), 'team.yaml');
});
scene('migrate.invocation', async (place) => show(await imported(place, 'migrate', ['extra']), 'unexpected "extra"'));
scene('migrate.registry', async (place) => {
  write(place, TEAM);
  await imported(place, 'migrate', []);
  corruptTeamRecord(place);
  return show(await imported(place, 'migrate', []), 'migrate');
});
scene('import.done', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'import', []), 'read back and verified');
});
scene('import.detached', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'import', [], detachedCaller), 'import');
});
scene('import.not-owner', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'import', [], other), 'only the owner runs import');
});
scene('import.invalid', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'import', ['missing.yaml']), 'missing.yaml');
});
scene('import.invocation', async (place) => show(await imported(place, 'import', ['a', 'b']), 'unexpected "b"'));

// The owner-seat door of import, add and up (src/client/owner-action.ts): a request recorded for
// the owner seat, and an approval id that is no request.
scene('import.approval-requested', async (place) => {
  write(place, TEAM);
  seatOwner(place.home);
  return show(await imported(place, 'import', ['--request'], other), 'owner-seat request');
});
scene('import.approval-refused', async (place) => {
  write(place, TEAM);
  return show(await imported(place, 'import', ['--approval', 'oa_nope'], other), 'is not an owner-seat request id');
});
scene('add.approval-requested', async (place) => {
  approve(place, TWO);
  seatOwner(place.home);
  return show(await added(place, ['worker', '--request'], other, addSources(place)), 'owner-seat request');
});
scene('add.approval-refused', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--approval', 'oa_nope'], other, addSources(place)), 'is not an owner-seat request id');
});
scene('up.approval-requested', async (place) => {
  approve(place, TEAM);
  seatOwner(place.home);
  return show(await up(place, ['--request'], other, upSources(place)), 'owner-seat request');
});
scene('up.approval-refused', async (place) => {
  approve(place, TEAM);
  return show(await up(place, ['--approval', 'oa_nope'], other, upSources(place)), 'is not an owner-seat request id');
});

const defensive = new Set(['migrate.round-trip', 'import.round-trip', 'add.prepared', 'add.locked', 'add.not-restored', 'add.no-profile', 'register.no-profile', 'remove.no-profile', 'answer.action', 'up.delegate-placement', 'settings.write', 'config.no-record']);

const contract = loadContract();
contract.rows.forEach((row, index) => scenePosition.set(row.id, index));
if (wanted !== null) {
  const runnable = [...wanted].filter((id) => scenes.has(id)).length;
  console.error(
    `exit-codes: selected ${String(runnable)} of ${String(scenes.size)} scenes; analyzer probes skipped (the checks against this repo still run)`,
  );
}
for (const row of contract.rows) {
  if (defensive.has(row.id)) continue;
  if (skips(row.id)) continue;
  test(row.id, async () => {
    const run = scenes.get(row.id);
    expect(run, row.id).toBeDefined();
    const place = layout(!bare.has(row.id));
    try {
      const result = await run!(place);
      expect(result.code).toBe(row.code);
    } finally {
      rmSync(place.base, { recursive: true, force: true });
    }
  });
}

// A refusal whose return sits above the dry-run return is one the dry run reaches. One
// whose return sits below it happens after the plan, and a dry run never takes that status.
function refusalIds(command: string): string[] {
  const sites = analyze().sites.filter((site) => site.command === command);
  const dry = sites.find((site) => site.ids.includes(`${command}.dry-run`));
  if (!dry) throw new Error(`${command}: no dry-run site`);
  return sites
    .filter((site) => site.line < dry.line)
    .flatMap((site) => site.ids)
    .filter((id) => {
      const row = contract.rows.find((item) => item.id === id);
      return Boolean(row && row.code !== 0 && !defensive.has(id));
    })
    .sort();
}

function refusalCore(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line
    .replace(/^! (?:up|down|add|register) would refuse: /, '')
    .replace(/^team add: refused: /, '')
    .replace(/^[^:\n]+: would refuse: /, '')
    .replace(/^team (?:up|down|add|register): /, '')
    .replace(/\/(?:private\/)?tmp\/team-exit-\w+/g, '<place>')
    .replace(/acme-[0-9a-f]{8,}/g, 'acme-<id>');
}

for (const command of ['up', 'down', 'add', 'register'] as const) {
  test(`${command}: a refused dry run exits as the real run`, async () => {
    const all = refusalIds(command);
    expect(all.length).toBeGreaterThan(0);
    // A local filter narrows which refusals this run proves; CI runs every one of them.
    const ids = all.filter((id) => !skips(id));
    if (ids.length === 0) return;
    const drySite = analyze().sites.find((site) => site.ids.includes(`${command}.dry-run`));
    expect(drySite?.codes).toEqual([0]);
    expect(drySite?.ids).toEqual([`${command}.dry-run`]);
    for (const id of ids) {
      const row = contract.rows.find((item) => item.id === id);
      if (!row) throw new Error(id);
      const run = scenes.get(id);
      expect(run, id).toBeDefined();
      const site = analyze().sites.find((item) => item.ids.includes(id));
      expect(site?.line, id).toBeLessThan(drySite?.line ?? 0);
      expect(site?.codes, id).toContain(row.code);
      const dryPlace = layout(!bare.has(id));
      const realPlace = layout(!bare.has(id));
      try {
        compareDry = true;
        const dry = await run!(dryPlace);
        compareDry = false;
        const real = await run!(realPlace);
        expect(dry.code, id).toBe(real.code);
        expect(dry.code, id).toBe(row.code);
        const shared = refusalCore(`${real.err}${real.out}`).slice(0, 80);
        expect(shared.length, id).toBeGreaterThan(0);
        if (shared === 'deny') {
          // `up`'s bare word is the one refusal with no sentence of its own to echo: a real run
          // says the word alone, and a dry run is never denied — it names the reason and the
          // owner's own command instead, which this holds to the caller the real run answered.
          const dryText = `${dry.err}${dry.out}`;
          expect(dryText, id).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
          expect(dryText, id).toContain('! to unblock: a `leads` seat runs `team up');
          continue;
        }
        expect(refusalCore(`${dry.err}${dry.out}`), id).toContain(shared);
      } finally {
        compareDry = false;
        rmSync(dryPlace.base, { recursive: true, force: true });
        rmSync(realPlace.base, { recursive: true, force: true });
      }
    }
    // Every refusal of the command runs twice, each in a fresh git checkout: `add` has taken 72s
    // to 106s on the hosted runners, so 120s left no margin and a slow runner timed it out.
  }, 300_000);
}

leadTest('every listed outcome has a run', () => {
  const ids = contract.rows.map((row) => row.id);
  expect(ids.filter((id) => !scenes.has(id) && !defensive.has(id))).toEqual([]);
  expect(scenes.size + defensive.size).toBe(ids.length);
});

leadTest('the filter names only ids the contract has', () => {
  expect(unknownScenes(wanted, contract.rows.map((row) => row.id)), 'TEAM_EXIT_IDS names an id with no contract row').toEqual([]);
});

leadTest('the exit-code check is clean', () => {
  expect(problems()).toEqual([]);
});

// The analyzer's own probes: crafted fixtures fed to the analyzer, never this repo's files. A
// filtered local run (`TEAM_EXIT_IDS`) skips them — a feature diff cannot change what they feed
// the analyzer — and CI runs every one of them. The checks above read this repo and always run.
// Each analyzer test reads the whole command tree, which took 5.3s on a slow hosted runner
// against the 5s default; 30s leaves the margin the dry-run parity tests were given.
const analyzerTest = (name: string, fn: () => void): void => {
  if (wanted === null && leadPart(part)) test(name, fn, 30_000);
};

analyzerTest('a new return that reuses a code fails the check', () => {
  const text = readFileSync(new URL('../src/commands/doctor.ts', import.meta.url), 'utf8');
  const next = text.replace('return missing ? 1 : 0;\n}', 'return missing ? 1 : 0;\n  return 1;\n}');
  const found = problems({ files: new Map([['src/commands/doctor.ts', next]]) });
  expect(found.some((line) => line.includes('src/commands/doctor.ts') && line.includes('exit site has no row'))).toBe(true);
});

function canon(rows: readonly ExitRow[]): string {
  const sorted = [...rows].sort((a, b) => a.command.localeCompare(b.command) || a.code - b.code || a.id.localeCompare(b.id));
  return `${JSON.stringify({
    format: 1,
    rows: sorted.map((row) => ({ code: row.code, command: row.command, id: row.id, meaning: row.meaning, trigger: row.trigger })),
  }, null, 2)}\n`;
}

analyzerTest('removing a row fails the check', () => {
  const rows = contract.rows.filter((row) => row.id !== 'doctor.clear');
  const found = problems({ contractText: canon(rows), page: render(rows) });
  expect(found.some((line) => line.includes('doctor.clear') && line.includes('no contract row'))).toBe(true);
});

analyzerTest('changing a returned code fails the check', () => {
  const text = readFileSync(new URL('../src/commands/doctor.ts', import.meta.url), 'utf8');
  const next = text.replace('return missing ? 1 : 0;', 'return missing ? 3 : 0;');
  const found = problems({ files: new Map([['src/commands/doctor.ts', next]]) });
  expect(found.some((line) => line.includes('src/commands/doctor.ts') && line.includes('3'))).toBe(true);
});

const UNREADABLE = "exit expression the contract can't read: return a marked literal or a covered call";

function withDoctor(body: string, before = ''): Map<string, string> {
  const text = readFileSync(new URL('../src/commands/doctor.ts', import.meta.url), 'utf8');
  const signature = 'export async function runDoctor(argv: string[], io: Io, sources: DoctorSources): Promise<number> {\n';
  return new Map([['src/commands/doctor.ts', `${before}${text.replace(signature, `${signature}${body}`)}`]]);
}

function rejects(files: Map<string, string>): boolean {
  return problems({ files }).some((line) => line.includes('src/commands/doctor.ts') && line.includes(UNREADABLE));
}

analyzerTest('an implicit arrow return fails the check', () => {
  const files = withDoctor("  const reviewGateProbe = (): 1 => 1;\n  if (argv[0] === '--gate-probe') return reviewGateProbe();\n");
  expect(rejects(files)).toBe(true);
});

analyzerTest('an identifier return fails the check', () => {
  const files = withDoctor("  const probeCode = 1;\n  if (argv[0] === '--gate-probe') return probeCode;\n");
  expect(rejects(files)).toBe(true);
});

analyzerTest('a throw in an imported helper is covered by team.command-threw', () => {
  const files = withDoctor("  if (argv[0] === '--gate-probe') gateThrow();\n", "import { gateThrow } from './gate-throw.ts';\n");
  files.set('src/commands/gate-throw.ts', "export function gateThrow(): void {\n  throw new Error('gate');\n}\n");
  expect(problems({ files })).toEqual([]);
  expect(analyze(files).coveredThrows.some((item) => item.file === 'src/commands/gate-throw.ts' && item.id === 'team.command-threw')).toBe(true);
});

analyzerTest('a plain-JS import is outside the contract: not read, and a return through it is refused', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-plain') plainSignal();\n  if (argv[0] === '--gate-plain-code') return plainCode();\n",
    "import { plainCode, plainSignal } from './plain-signal.js';\n",
  );
  const found = problems({ files });
  expect(found.some((line) => line.includes("can't read this file"))).toBe(false);
  expect(found.some((line) => line.includes(UNREADABLE))).toBe(true);
});

analyzerTest('a default-parameter call fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return probeDefault();\n",
    'function hidden(): number { return 1; }\nfunction probeDefault(code = hidden()): number { return code; }\n',
  );
  expect(rejects(files)).toBe(true);
});

analyzerTest('an awaited helper return fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return await later();\n",
    'async function later(): Promise<number> { return 1; }\n',
  );
  const found = problems({ files });
  expect(found.some((line) => line.includes('exit site has no row'))).toBe(true);
});

analyzerTest('a switch that falls through fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return switched(argv[0] ?? '');\n",
    "function switched(flag: string): number {\n  let value = 1;\n  switch (flag) {\n    case 'a':\n      value = 1;\n    default:\n      return value;\n  }\n}\n",
  );
  expect(rejects(files)).toBe(true);
});

analyzerTest('return void 0 ?? 1 fails the check', () => {
  const files = withDoctor("  if (argv[0] === '--gate-probe') return void 0 ?? 1;\n");
  expect(rejects(files)).toBe(true);
});

function namesLine(files: Map<string, string>, file: string): boolean {
  return problems({ files }).some((line) => new RegExp(`${file}:\\d+:`).test(line));
}

analyzerTest('process.exit with no argument fails the check', () => {
  const files = withDoctor("  if (argv[0] === '--gate-probe') process.exit();\n");
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

analyzerTest('a module-level process.exit fails the check', () => {
  const files = withDoctor('', "if (process.env.GATE_PROBE === '1') process.exit(17);\n");
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

analyzerTest('a default call that is not the command table fails the check', () => {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text.replace(
    'return command.default(rest, io);',
    "if (argv[0] === '--gate-probe') return ({ default: () => 17 }).default();\n  return command.default(rest, io);",
  );
  const files = new Map([['src/cli.ts', next]]);
  expect(namesLine(files, 'src/cli.ts')).toBe(true);
});

analyzerTest('a function name declared twice fails the check', () => {
  const files = withDoctor(
    "  function probeShadow(): number { return 17; }\n  if (argv[0] === '--gate-probe') return probeShadow();\n",
    'function probeShadow(): number { return runDoctor(); }\n',
  );
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

analyzerTest('a followed helper with no return fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return noReturn() as never;\n",
    'function noReturn(): never {}\n',
  );
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

const UNROOTED = "a command file whose default export the contract can't read";

function withTable(line: string, added: readonly (readonly [string, string])[] = []): Map<string, string> {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const start = text.indexOf('export const commands');
  const close = text.indexOf('\n};', start);
  const next = `${text.slice(0, close)}\n  ${line}${text.slice(close)}`;
  return new Map([['src/cli.ts', next], ...added]);
}

analyzerTest('a re-exported command fails the check', () => {
  const files = withTable(
    "probe: () => import('./commands/probe.ts'),",
    [['src/commands/probe.ts', "export { default, USAGE } from './doctor.ts';\n"]],
  );
  expect(problems({ files }).some((line) => line.includes('src/commands/probe.ts') && line.includes(UNROOTED))).toBe(true);
});

analyzerTest('a command file with no default export fails the check', () => {
  const files = withTable(
    "probeEmpty: () => import('./commands/probe-empty.ts'),",
    [['src/commands/probe-empty.ts', "export const USAGE = 'probe';\n"]],
  );
  expect(problems({ files }).some((line) => line.includes('src/commands/probe-empty.ts') && line.includes(UNROOTED))).toBe(true);
});

analyzerTest('a table entry outside src/commands fails the check', () => {
  const files = withTable("probe: () => import('./outside.ts'),");
  const found = problems({ files });
  expect(found.some((line) => line.includes('probe') && line.includes('src/outside.ts') && line.includes("an entry in the commands table whose module the gate didn't walk"))).toBe(true);
});

analyzerTest('a default export imported from another file fails the check', () => {
  const files = withTable(
    "probeAlias: () => import('./commands/probe-alias.ts'),",
    [['src/commands/probe-alias.ts', "import run from './doctor.ts';\nexport default run;\n"]],
  );
  expect(problems({ files }).some((line) => line.includes('src/commands/probe-alias.ts') && line.includes(UNROOTED))).toBe(true);
});

analyzerTest('a walked command file missing from the table fails the check', () => {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text.replace("  add: () => import('./commands/add.ts'),\n", '');
  const found = problems({ files: new Map([['src/cli.ts', next]]) });
  expect(found.some((line) => line.includes('src/commands/add.ts') && line.includes('a walked file that is in no table entry'))).toBe(true);
});

analyzerTest('a second table key for one file fails the check', () => {
  const files = withTable("probe: () => import('./commands/doctor.ts'),");
  const found = problems({ files });
  expect(found.some((line) => line.includes('doctor and probe load src/commands/doctor.ts'))).toBe(true);
});

analyzerTest('a table key that is not the module name fails the check', () => {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text.replace(
    "  doctor: () => import('./commands/doctor.ts'),\n",
    "  medic: () => import('./commands/doctor.ts'),\n",
  );
  const found = problems({ files: new Map([['src/cli.ts', next]]) });
  expect(found.some((line) => line.includes('medic loads src/commands/doctor.ts'))).toBe(true);
});

function withCli(snippet: string): Map<string, string> {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  return new Map([['src/cli.ts', `${snippet}\n${text}`]]);
}

function sharedProbe(): { files: Map<string, string>; rows: ExitRow[] } {
  const before = "import { sharedExitProbe } from '../review-shared.ts';\n";
  const body = "  if (argv[0] === '--review-shared') return sharedExitProbe();\n";
  const doctor = withDoctor(body, before);
  const statusText = readFileSync(new URL('../src/commands/status.ts', import.meta.url), 'utf8');
  const status = `${before}${statusText.replace(
    'export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {\n',
    `export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {\n${body}`,
  )}`;
  return {
    files: new Map([
      ['src/review-shared.ts', 'export function sharedExitProbe(): number {\n  // exit: doctor.review-shared\n  return 1;\n}\n'],
      ['src/commands/doctor.ts', doctor.get('src/commands/doctor.ts') ?? ''],
      ['src/commands/status.ts', status],
    ]),
    rows: [{ code: 1, command: 'doctor', id: 'doctor.review-shared', meaning: 'a shared helper', trigger: 'team doctor' }],
  };
}

function shadowedDispatcher(): Map<string, string> {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text.replace(
    '  const command = await load();\n',
    '  const command = { default: () => 1 };\n  {\n    const command = await load();\n  }\n',
  );
  return new Map([['src/cli.ts', next]]);
}

function fileWideLookup(): { files: Map<string, string>; rows: ExitRow[] } {
  const files = withDoctor(
    "  if (argv[0] === '--review-shadow') return reviewShadow();\n",
    "import { reviewShadow } from '../review-shadow.ts';\nfunction holder(): void {\n  function reviewShadow(): number {\n    // exit: doctor.review-hidden\n    return 1;\n  }\n}\n",
  );
  files.set('src/review-shadow.ts', 'export function reviewShadow(): number {\n  return 17;\n}\n');
  return {
    files,
    rows: [{ code: 1, command: 'doctor', id: 'doctor.review-hidden', meaning: 'the hidden helper', trigger: 'team doctor --review-shadow' }],
  };
}

function shadowedImport(body: string, before = ''): { files: Map<string, string>; extra: ExitRow[] } {
  const files = withDoctor(body, `import { reviewShadow } from '../review-shadow.ts';\n${before}`);
  files.set('src/review-shadow.ts', 'export function reviewShadow(): number {\n  // exit: doctor.review-shadow\n  return 1;\n}\n');
  return {
    files,
    extra: [{ code: 1, command: 'doctor', id: 'doctor.review-shadow', meaning: 'the imported helper', trigger: 'team doctor --review-shadow' }],
  };
}

function failureMoved(): Map<string, string> {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text
    .replace(
      'export function reportFailure(error: unknown, stderr: (text: string) => void): number {\n',
      'function threwCode(): number {\n  return 2;\n}\n\nexport function reportFailure(error: unknown, stderr: (text: string) => void): number {\n',
    )
    .replace('return 1; // exit: team.command-threw', 'return threwCode(); // exit: team.command-threw');
  return new Map([['src/cli.ts', next]]);
}

const form = "a commands-table entry the contract can't read";
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const medic = cli.replace(
  "  doctor: () => import('./commands/doctor.ts'),\n",
  "  medic: () => import('./commands/doctor.ts'),\n",
);
const noAdd = cli.replace("  add: () => import('./commands/add.ts'),\n", '');
const notDispatcher = cli.replace(
  'return command.default(rest, io);',
  "if (argv[0] === '--gate-probe') return ({ default: () => 17 }).default();\n  return command.default(rest, io);",
);
const unreadForms: { name: string; files: Map<string, string>; needle: string; extra?: ExitRow[] }[] = [
    { name: 'shorthand', files: withTable('shorthand,'), needle: `shorthand: ${form}` },
    { name: 'method', files: withTable("method() { return import('./commands/doctor.ts'); },"), needle: `method: ${form}` },
    { name: 'spread', files: withTable("...{ probe: () => import('./commands/doctor.ts') },"), needle: `spread: ${form}` },
    { name: 'computed key', files: withTable("['computed']: () => import('./commands/doctor.ts'),"), needle: `computed: ${form}` },
    { name: 'getter', files: withTable("get getter() { return import('./commands/doctor.ts'); },"), needle: `getter: ${form}` },
    { name: 'setter', files: withTable('set setter(_) {},'), needle: `setter: ${form}` },
    { name: 'quoted key', files: withTable("'quoted': () => import('./commands/doctor.ts'),"), needle: `quoted: ${form}` },
    { name: 'block arrow', files: withTable("block: () => { return import('./commands/doctor.ts'); },"), needle: `block: ${form}` },
    { name: 'async arrow', files: withTable("asyncArrow: async () => import('./commands/doctor.ts'),"), needle: `asyncArrow: ${form}` },
    { name: 'value is not an import arrow', files: withTable("bare: import('./commands/doctor.ts'),"), needle: `bare: ${form}` },
    {
      name: 're-exported default',
      files: withTable("probe: () => import('./commands/probe.ts'),", [['src/commands/probe.ts', "export { default, USAGE } from './doctor.ts';\n"]]),
      needle: 'src/commands/probe.ts',
    },
    {
      name: 'no default export',
      files: withTable("probeEmpty: () => import('./commands/probe-empty.ts'),", [['src/commands/probe-empty.ts', "export const USAGE = 'probe';\n"]]),
      needle: 'src/commands/probe-empty.ts',
    },
    { name: 'import outside src/commands', files: withTable("probe: () => import('./outside.ts'),"), needle: "whose module the gate didn't walk" },
    {
      name: 'default is an import',
      files: withTable("probeAlias: () => import('./commands/probe-alias.ts'),", [['src/commands/probe-alias.ts', "import run from './doctor.ts';\nexport default run;\n"]]),
      needle: 'src/commands/probe-alias.ts',
    },
    { name: 'file with no key', files: new Map([['src/cli.ts', noAdd]]), needle: 'a walked file that is in no table entry' },
    { name: 'two keys one file', files: withTable("probe: () => import('./commands/doctor.ts'),"), needle: 'doctor and probe load src/commands/doctor.ts' },
    { name: 'key is not the module name', files: new Map([['src/cli.ts', medic]]), needle: 'medic loads src/commands/doctor.ts' },
    { name: 'process.exit with no argument', files: withDoctor("  if (argv[0] === '--gate-probe') process.exit();\n"), needle: UNREADABLE },
    { name: 'module-level process.exit', files: withDoctor('', "if (process.env.GATE_PROBE === '1') process.exit(17);\n"), needle: 'exit site has no row' },
    { name: 'default call that is not the command table', files: new Map([['src/cli.ts', notDispatcher]]), needle: UNREADABLE },
    {
      name: 'function name declared twice',
      files: withDoctor(
        "  function probeShadow(): number { return 17; }\n  if (argv[0] === '--gate-probe') return probeShadow();\n",
        'function probeShadow(): number { return runDoctor(); }\n',
      ),
      needle: `probeShadow: ${UNREADABLE}`,
    },
    {
      name: 'helper with no return',
      files: withDoctor("  if (argv[0] === '--gate-probe') return noReturn() as never;\n", 'function noReturn(): never {}\n'),
      needle: UNREADABLE,
    },
    {
      name: 'shared helper row missing for the other command',
      files: sharedProbe().files,
      extra: sharedProbe().rows,
      needle: 'marked on status',
    },
    {
      name: 'conditional break',
      files: withDoctor(
        "  if (argv[0] === '--review-conditional') return reviewConditionalBreak(true)!;\n",
        'function reviewConditionalBreak(flag: boolean): number | undefined {\n  switch (flag) {\n    default:\n      if (flag) break;\n      return 1;\n  }\n}\n',
      ),
      needle: UNREADABLE,
    },
    { name: 'exitCode ||=', files: withCli('process.exitCode ||= 1;'), needle: UNREADABLE },
    { name: 'exitCode ??=', files: withCli('process.exitCode ??= 1;'), needle: UNREADABLE },
    { name: 'exitCode &&=', files: withCli('process.exitCode &&= 1;'), needle: UNREADABLE },
    { name: 'exitCode +=', files: withCli('process.exitCode += 1;'), needle: UNREADABLE },
    { name: 'exitCode ++', files: withCli('process.exitCode++;'), needle: UNREADABLE },
    { name: 'exitCode --', files: withCli('process.exitCode--;'), needle: UNREADABLE },
    { name: 'exitCode destructuring target', files: withCli('({ exitCode: process.exitCode } = { exitCode: 1 });'), needle: UNREADABLE },
    { name: 'Object.assign(process)', files: withCli('Object.assign(process, { exitCode: 1 });'), needle: UNREADABLE },
    { name: "Reflect.set exitCode", files: withCli("Reflect.set(process, 'exitCode', 1);"), needle: UNREADABLE },
    { name: 'Object.defineProperty exitCode', files: withCli("Object.defineProperty(process, 'exitCode', { value: 1 });"), needle: UNREADABLE },
    { name: "process['exitCode']", files: withCli("process['exitCode'] = 1;"), needle: UNREADABLE },
    { name: 'shadowed dispatcher', files: shadowedDispatcher(), needle: UNREADABLE },
    {
      name: 'imported name also declared in the file',
      files: fileWideLookup().files,
      extra: fileWideLookup().rows,
      needle: 'exit site has no row',
    },
    {
      name: 'callback parameter',
      ...shadowedImport(
        "  if (argv[0] === '--review-param') return callbackExit(() => 17);\n",
        'function callbackExit(reviewShadow: () => number): number {\n  return reviewShadow();\n}\n',
      ),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'default-valued parameter',
      ...shadowedImport(
        "  if (argv[0] === '--review-default') return callbackExit();\n",
        'function callbackExit(reviewShadow = () => 17): number {\n  return reviewShadow();\n}\n',
      ),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'destructured parameter',
      ...shadowedImport(
        "  if (argv[0] === '--review-destructured') return callbackExit({ reviewShadow: () => 17 });\n",
        'function callbackExit({ reviewShadow }: { reviewShadow: () => number }): number {\n  return reviewShadow();\n}\n',
      ),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'let reassigned',
      ...shadowedImport("  let reviewShadow = () => 2;\n  reviewShadow = () => 17;\n  if (argv[0] === '--review-let') return reviewShadow();\n"),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'catch variable',
      ...shadowedImport("  try {\n    throw new Error('review');\n  } catch (reviewShadow) {\n    if (argv[0] === '--review-catch') return reviewShadow();\n  }\n"),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'inner const hiding an import',
      ...shadowedImport("  const reviewShadow = () => 17;\n  if (argv[0] === '--review-const') return reviewShadow();\n"),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'nested var',
      ...shadowedImport("  if (argv[0] === '--review-nested-var') {\n    {\n      var reviewShadow = () => 17;\n    }\n    return reviewShadow();\n  }\n"),
      needle: "reviewShadow: the exit-code gate doesn't model var scoping; use let or const",
    },
    {
      name: 'top-level var',
      files: withDoctor('', 'var reviewShadow = () => 1;\n'),
      needle: "reviewShadow: the exit-code gate doesn't model var scoping; use let or const",
    },
    {
      name: 'var in a for head',
      files: withDoctor('  for (var reviewShadow = () => 17; false;) {}\n'),
      needle: "reviewShadow: the exit-code gate doesn't model var scoping; use let or const",
    },
    {
      name: 'function declared in an if',
      ...shadowedImport("  if (argv[0] === '--review-block-fn') {\n    function reviewShadow(): number {\n      return 17;\n    }\n  }\n  if (argv[0] === '--review-block-call') return reviewShadow();\n"),
      needle: `reviewShadow: ${UNREADABLE}`,
    },
    {
      name: 'local reportFailure',
      files: withDoctor(
        "  if (argv[0] === '--gate-probe') process.exitCode = reportFailure();\n",
        'function reportFailure(): number { return 17; }\n',
      ),
      needle: UNREADABLE,
    },
    { name: 'reportFailure returns a helper', files: failureMoved(), needle: 'says code 1, the site returns 2' },
];

// The unreadable-form fixtures are analyzer probes too, skipped under a filter for the reason above.
test.each(wanted === null && leadPart(part) ? unreadForms : [])('$name fails the check', (row) => {
  const found = problems(row.extra
    ? { files: row.files, contractText: canon([...contract.rows, ...row.extra]), page: render([...contract.rows, ...row.extra]) }
    : { files: row.files });
  expect(found.some((line) => line.includes(row.needle)), row.name).toBe(true);
});

// Phase 3: the same add and remove runs under `team-config.source: registry`, on a team moved into
// the scene's own registry. The edit lands in the record, the file is left as it was, and the
// machine's own registry folder is never written. Once per full run, with the whole-repo checks.
leadTest('under the registry source, add writes the new seat into the registry record', async () => {
  const place = layout(true);
  approve(place, TWO);
  const file = readFileSync(place.file, 'utf8');
  intoRegistry(place.root, place.home);
  const ran = await underRegistry(() => added(place, ['worker', '--file', place.file], owner, addSources(place, { launch: launching(IDLE) })));
  show(ran, 'ready');
  expect(ran.code).toBe(0);
  const record = storedTeam(place.root, place.home)!;
  expect(record.edited_by).toBe('add');
  expect(record.text).not.toBe(file);
  expect(readFileSync(place.file, 'utf8')).toBe(file);
  expect(realRegistryTouched()).toBe(false);
});

leadTest('under the registry source, remove takes the seat out of the registry record', async () => {
  const place = layout(true);
  approve(place, TWO);
  const file = readFileSync(place.file, 'utf8');
  intoRegistry(place.root, place.home);
  const ran = await underRegistry(() => removed(place, ['worker'], owner, downSources({ home: place.home })));
  show(ran, 'removed worker');
  expect(ran.code).toBe(0);
  const record = storedTeam(place.root, place.home)!;
  expect(record.edited_by).toBe('remove');
  expect(record.text).not.toContain('name: worker');
  expect(readFileSync(place.file, 'utf8')).toBe(file);
  expect(realRegistryTouched()).toBe(false);
});

// The owner-seat door end to end, with no owner terminal: the caller is a seat, the owner answers
// from the owner seat (the in-memory credential store stands in for Touch ID or the phone), and
// the run is admitted for exactly what was asked, once.
describe('owner-seat approval admits import, add and up for a seat', () => {
  const requestId = (ran: Ran) => /owner-seat request (oa_[0-9a-f]{24})/.exec(ran.out)?.[1] ?? '';

  test('up: request, answer, a dry run that spends nothing, the launch, and a refused replay', async () => {
    const place = layout(true);
    try {
      approve(place, TEAM);
      const store = seatOwner(place.home);
      const asked = await up(place, ['--request'], other, upSources(place, { ownerSeatStore: store }));
      expect(asked.code, asked.err).toBe(0);
      const id = requestId(asked);
      expect(asked.out).toContain(`then run: team up --approval ${id}`);
      // Before the answer: refused, in plain words.
      const early = await up(place, ['--approval', id], other, upSources(place, { ownerSeatStore: store }));
      expect(early.code).toBe(1);
      expect(early.err).toContain('has no owner-seat answer yet');
      expect(approveOwnerAction(place.home, id, 'oui', store, NOW)).toMatchObject({ ok: true });
      const dry = await up(place, ['--approval', id, '--dry-run'], other, upSources(place, { ownerSeatStore: store }));
      expect(dry.code, dry.err + dry.out).toBe(0);
      expect(dry.out).not.toContain('would refuse');
      const ran = await up(place, ['--approval', id], other, upSources(place, { ownerSeatStore: store, launch: launching(IDLE) }));
      expect(ran.code, ran.err + ran.out).toBe(0);
      expect(ran.err).toContain(`owner-seat approval ${id} (signed by mac)`);
      const again = await up(place, ['--approval', id], other, upSources(place, { ownerSeatStore: store, launch: launching(IDLE) }));
      expect(again.code).toBe(1);
      expect(again.err).toContain('single-use');
    } finally {
      rmSync(place.base, { recursive: true, force: true });
    }
  }, 120_000);

  test('up: an approval for other arguments is refused, and the seat without one is denied as before', async () => {
    const place = layout(true);
    try {
      approve(place, TEAM);
      const store = seatOwner(place.home);
      const asked = await up(place, ['--request', '--serial'], other, upSources(place, { ownerSeatStore: store }));
      const id = requestId(asked);
      expect(approveOwnerAction(place.home, id, 'oui', store, NOW)).toMatchObject({ ok: true });
      const mismatch = await up(place, ['--approval', id, '--dry-run'], other, upSources(place, { ownerSeatStore: store }));
      expect(mismatch.code).toBe(1);
      expect(mismatch.err).toContain('approved for other team-up arguments');
      const none = await up(place, ['--dry-run'], other, upSources(place, { ownerSeatStore: store }));
      expect(none.code).toBe(1);
    } finally {
      rmSync(place.base, { recursive: true, force: true });
    }
  }, 120_000);

  test('add: request, answer, the add as asked', async () => {
    const place = layout(true);
    try {
      approve(place, TWO);
      const store = seatOwner(place.home);
      const asked = await added(place, ['worker', '--request'], other, addSources(place, { ownerSeatStore: store }));
      expect(asked.code, asked.err).toBe(0);
      const id = requestId(asked);
      expect(approveOwnerAction(place.home, id, 'oui', store, NOW)).toMatchObject({ ok: true });
      const other2 = await added(place, ['helper', '--approval', id, '--dry-run'], other, addSources(place, { ownerSeatStore: store }));
      expect(other2.code).toBe(1);
      const dry = await added(place, ['worker', '--approval', id, '--dry-run'], other, addSources(place, { ownerSeatStore: store }));
      expect(dry.code, dry.err + dry.out).toBe(0);
    } finally {
      rmSync(place.base, { recursive: true, force: true });
    }
  }, 120_000);

  test('import: request, answer, the import, and a refused replay', async () => {
    const place = layout(true);
    try {
      write(place, TEAM);
      const store = seatOwner(place.home);
      const run = (argv: string[]) => {
        const io = testIo(place.root, other);
        return runImport(argv, io, { home: place.home, now: () => new Date(), ownerSeatStore: store }).then((code) => ({ code, out: io.out, err: io.err }));
      };
      const asked = await run(['--request']);
      expect(asked.code, asked.err).toBe(0);
      const id = requestId(asked);
      expect(approveOwnerAction(place.home, id, 'oui', store, NOW)).toMatchObject({ ok: true });
      const done = await run(['--approval', id]);
      expect(done.code, done.err + done.out).toBe(0);
      expect((await run(['--approval', id])).code).toBe(1);
    } finally {
      rmSync(place.base, { recursive: true, force: true });
    }
  }, 120_000);

  test('init and up in one request: one answer creates the team and starts it', async () => {
    const place = layout(true);
    try {
      const store = seatOwner(place.home);
      const init = (argv: string[]) => {
        const io = testIo(place.root, other);
        return runInit(argv, io, place.home, undefined, { loggedIn: () => true, ownerSeatStore: store }).then((code) => ({ code, out: io.out, err: io.err }));
      };
      const asked = await init(['--request', '--then-up']);
      expect(asked.code, asked.err).toBe(0);
      const id = /request_id: (oa_[0-9a-f]{24})/.exec(asked.out)?.[1] ?? '';
      expect(id).not.toBe('');
      expect(approveOwnerAction(place.home, id, 'oui', store, NOW)).toMatchObject({ ok: true });
      const made = await init(['--execute', id]);
      expect(made.code, made.err + made.out).toBe(0);
      expect(existsSync(join(place.root, '.agents', 'team.yaml'))).toBe(true);
      const dry = await up(place, ['--approval', id, '--dry-run'], other, upSources(place, { ownerSeatStore: store }));
      expect(dry.code, dry.err + dry.out).toBe(0);
      expect((await init(['--execute', id])).code).toBe(1);
    } finally {
      rmSync(place.base, { recursive: true, force: true });
    }
  }, 120_000);
});
