// One run per row of contract/exit-codes.json. Each trigger is a temporary directory and the
// injectable stand-ins the other command tests use: no herdr session, no user-level store.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { startBroker } from '../src/broker/server.ts';
import { saveReadings, type Seen } from '../src/budgets/readings.ts';
import type { Caller } from '../src/caller.ts';
import type { CheckSources } from '../src/check/team.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runAskShow } from '../src/commands/ask-show.ts';
import { runApprove, type ApproveSources, type Waiting } from '../src/approve/command.ts';
import { runBroker, type BrokerSources } from '../src/commands/broker.ts';
import { check, loadConfig, type LoadConfig } from '../src/commands/check.ts';
import { commits } from '../src/commands/commits.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runFeed } from '../src/commands/feed.ts';
import { realSources, runMcp, type McpSources } from '../src/commands/mcp.ts';
import { runInit } from '../src/commands/init.ts';
import { historyPath } from '../src/send/history.ts';
import { plantMessage, runMessages, type MessagePayload } from '../src/commands/messages.ts';
import { runIssues } from '../src/commands/issues.ts';
import { runList, type ListSources } from '../src/commands/list.ts';
import { runLock } from '../src/commands/lock.ts';
import { runUnlock } from '../src/commands/unlock.ts';
import { runTempo } from '../src/commands/tempo.ts';
import { runNext } from '../src/commands/next.ts';
import { runPlan } from '../src/commands/plan.ts';
import { pr } from '../src/commands/pr.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runSeats, type SeatsSources } from '../src/commands/seats.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runUsage } from '../src/commands/usage.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { runWorktree, type WorktreeSources } from '../src/commands/worktree.ts';
import { main, reportFailure, version } from '../src/cli.ts';
import { delegateGate, type DelegateSources } from '../src/delegate.ts';
import { listFolder } from '../src/file/landing.ts';
import { findRoot, loadTeamFile } from '../src/file/load.ts';
import { grantGate, type GrantSources } from '../src/grant.ts';
import { defaultFs, lobbyDir } from '../src/lobby/gate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { acquireRunLock } from '../src/launch/run-lock.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lockDirectory, type LockIdentity, type LockSources } from '../src/lock/machine.ts';
import type { Key, Terminal } from '../src/launch/terminal.ts';
import { overridesPath } from '../src/profiles/overrides.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { keyOf, MESSAGE_DOMAIN, messageKeyOf, signDomain } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { analyze, loadContract, problems, render, type ExitRow } from '../scripts/exit-codes.ts';
import { runRelease } from '../src/commands/release.ts';
import type { KeyReader } from '../src/release/keychain.ts';
import { fakeFetch, fixture, happy, json, URLS, type Answers } from './release/world.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const owner = { kind: 'owner' } as const;
const detachedCaller = { kind: 'owner-no-tty' } as const;
const other = { kind: 'seat', name: 'other', pane: 'w9:p1' } as const;
const leadSeat = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const hot: Machine = { ...fine, loadPerCore: 9 };
const quiet: Live = { running: false, agents: [], workspaces: [], screens: {} };
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

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
${LEAD}`;

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
    spawnWatch(command) {
      return paneOk(command) ? 4242 : null;
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
scene('add.temporary-unexpected', async (place) => show(await added(place, ['extra', '--temporary'], owner, addSources(place)), 'unexpected'));
scene('add.temporary-flags', async (place) => show(await added(place, ['worker', '--like', 'lead'], owner, addSources(place)), '--like, --until and --worktree'));
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
  return show(await added(place, ['worker'], other, addSources(place)), 'only the owner, the orchestrator or the operator');
});
scene('add.no-pane', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker'], leadSeat, addSources(place)), 'no pane is recorded for seat lead');
});
scene('add.session-owner', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--session', 'other'], leadSeat, addSources(place)), "--session is the owner's");
});
scene('add.another-pane', async (place) => {
  write(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w2:p1' };
  });
  return show(await added(place, ['worker'], leadSeat, addSources(place)), 'the state records pane w2:p1 for seat lead');
});
scene('add.default-session', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--session', 'default', '--file', place.file], owner, addSources(place)), 'can\'t be "default"');
});
scene('add.never-approved', async (place) => {
  write(place, TWO);
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, {
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified: run `team approve` once' }),
  })), 'cannot be verified');
});
scene('add.differs', async (place) => {
  approve(place, TWO);
  write(place, TWO.replace('label: worker', 'label: renamed'));
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place)), 'not the approved one');
});
scene('add.approved-copy', async (place) => {
  approve(place, TWO);
  const standing = approvalStanding(place.root, place.home);
  if (standing.kind !== 'verified') throw new Error(standing.kind);
  const broken = { ...standing, record: { ...standing.record, file: 'nope: [[[' } };
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { standing: () => broken })), "approved copy can't be read");
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
scene('add.no-like', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['--temporary', '--like', 'missing', '--until', 'result:out.md', '--file', place.file], owner, addSources(place)), 'no seat "missing"');
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
  const standing = approvalStanding(place.root, place.home);
  if (standing.kind !== 'verified') throw new Error(standing.kind);
  const approval = { ...standing.record.approval, ceilings: { ...standing.record.approval.ceilings, seats: 0 } };
  const capped = { ...standing, record: { ...standing.record, approval } };
  return show(await added(place, ['worker', '--file', place.file], owner, addSources(place, { standing: () => capped })), 'allows 0 seats');
});
scene('add.dry-run', async (place) => {
  approve(place, TWO);
  return show(await added(place, ['worker', '--dry-run', '--file', place.file], owner, addSources(place)), 'dry run: nothing was run');
});
scene('add.override-owner', async (place) => {
  approve(place, TWO);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead' };
  });
  return show(await added(place, ['worker', '--model', 'claude-sonnet-5-5'], { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' }, addSources(place)), "--model and --effort on a declared seat are the owner's");
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
  ['delegate-approved-copy', 'delegation needs a readable approved copy: run `team approve`', 'readable approved copy'],
  ['delegate-drift', 'delegation needs the approved file: the file is not the approved one (seat worker changed): run `team approve`', 'not the approved one'],
  ['delegate-evidence', "delegation cannot verify its placement or seats: herdr doesn't answer", 'placement or seats'],
  ['delegate-placement', 'the approved delegate must be an external non-seat pane', 'non-seat pane'],
  ['delegate', 'only the owner, the orchestrator, the operator or the approved delegate runs it; this call is pilot', 'or the approved delegate runs it'],
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
  })), 'cannot change the file or the approval');
});

async function checked(place: Place, argv: string[], caller: Caller, sources: CheckSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await check(argv, io, loader(place), sources), out: io.out, err: io.err };
}

function checkSources(live: Live | null, standing: Standing = { kind: 'none' }): CheckSources {
  return { live: () => live, branch: () => 'main', standing: () => standing, now: () => NOW };
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
  approve(place, TEAM);
  const matched: Live = {
    running: true,
    agents: [agent('lead')],
    workspaces: [{ id: 'w1', label: 'lead' }],
    // The lead's own pane, readable: a quiet seat on a screen no profile reads is a
    // difference the check reports, so a healthy team's pane says what it is.
    screens: { 'w1:p1': IDLE },
  };
  return show(await checked(place, [], owner, checkSources(matched, approvalStanding(place.root, place.home))), 'team check: nothing wrong');
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

scene('conformance-adapter.finished', async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const proc = Bun.spawn(['bun', 'src/cli.ts', 'conformance-adapter'], {
    cwd: repo, stdin: new TextEncoder().encode('not json\n'), stdout: 'pipe', stderr: 'pipe',
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  return show({ code, out, err: await new Response(proc.stderr).text() }, 'the line is not JSON');
});

scene('doctor.invocation', async (place) => {
  const io = testIo(place.root, owner);
  return show({ code: await runDoctor(['extra'], io, doctor(place.home)), out: io.out, err: io.err }, 'unexpected');
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
  return show(await down(place, [], other, downSources({ sessionRunning: () => true, agents: () => [] })), 'only the owner, the orchestrator or the operator');
});
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
  const text = 'only the owner, the orchestrator, the operator or the approved delegate stops the team; this call is other';
  const ran = await down(place, [], other, delegated('down.delegate', text));
  if (compareDry) expect(ran.out).toContain(`! down would refuse: ${text}\n`);
  else expect(ran.err).toBe(`team down: ${text}\n`);
  return ran;
});
scene('down.delegate-approval', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-approval', 'delegation needs a verified approval: no approval is in force')), 'delegation needs a verified approval');
});
scene('down.delegate-approved-copy', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-approved-copy', 'delegation needs a readable approved copy: run `team approve`')), 'readable approved copy');
});
scene('down.delegate-command', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-command', 'the approved delegate hook/w2:p9 may not run `down`; its approved commands are up')), 'its approved commands are up');
});
scene('down.delegate-drift', async (place) => {
  write(place, DELEGATED);
  return show(await down(place, [], other, delegated('down.delegate-drift', 'delegation needs the approved file: the file is not the approved one (seats: a seat was added): run `team approve`')), 'is not the approved one');
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
scene('down.grant-approved-copy', async (place) => {
  approve(place, GRANTED);
  recordLead(place, 'w1:p1');
  return show(await down(place, [], leadSeat, grantDown(place, { approvedCopy: () => null })), 'a grant needs a readable approved copy');
});
scene('down.grant-drift', async (place) => {
  approve(place, GRANTED);
  write(place, readFileSync(place.file, 'utf8').replace('label: lead', 'label: renamed'));
  recordLead(place, 'w1:p1');
  return show(await down(place, [], leadSeat, grantDown(place)), 'a grant needs the approved file');
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
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified: run `team approve` once' }),
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
    record.file = `${String(record.file)}\n`;
  });
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('lead')], home: place.home,
  })), 'valid signature');
});
scene('down.approved-copy', async (place) => {
  approve(place, TEAM);
  const standing = approvalStanding(place.root, place.home);
  if (standing.kind !== 'verified') throw new Error(standing.kind);
  const broken = { ...standing, record: { ...standing.record, file: 'nope: [[[' } };
  return show(await down(place, [], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('lead')], home: place.home, standing: () => broken,
  })), 'cannot be read');
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
scene('init.wrote', async (place) => show(await initial(place, []), 'Wrote'));
scene('init.restored', async (place) => {
  approve(place, TEAM);
  rmSync(place.file);
  return show(await initial(place, ['--restore']), 'Restored');
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
  return show(await removed(place, ['worker'], other, downSources({ home: place.home })), 'only the owner, the orchestrator or the operator');
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
scene('remove.unverified', async (place) => {
  approve(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.extra = { stage: 'ready' };
  });
  return show(await removed(place, ['extra'], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('extra')], home: place.home,
  })), 'not an approved seat');
});
scene('remove.ambiguous', async (place) => {
  approve(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true,
    agents: () => [agent('worker'), { ...agent('worker'), pane: 'w2:p1' }],
    home: place.home,
  })), 'more than one agent of this name');
});
scene('remove.approved-copy', async (place) => {
  approve(place, TWO);
  const standing = approvalStanding(place.root, place.home);
  if (standing.kind !== 'verified') throw new Error(standing.kind);
  const broken = { ...standing, record: { ...standing.record, file: 'nope: [[[' } };
  return show(await removed(place, ['worker'], owner, downSources({
    sessionRunning: () => true, agents: () => [agent('worker')], home: place.home, standing: () => broken,
  })), 'cannot be read');
});
scene('remove.never-approved', async (place) => {
  write(place, TWO);
  return show(await removed(place, ['worker'], owner, downSources({
    home: place.home,
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified: run `team approve` once' }),
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
  ['delegate-approved-copy', 'delegation needs a readable approved copy: run `team approve`', 'readable approved copy'],
  ['delegate-drift', 'delegation needs the approved file: the file is not the approved one (seat worker changed): run `team approve`', 'not the approved one'],
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
  return show(await status(place, [], statusSources(matched, standing)), '0 difference');
});
scene('status.difference', async (place) => {
  write(place, TEAM);
  return show(await status(place, [], statusSources(quiet)), 'is in the file and is not running');
});
scene('status.file-owner', async (place) => show(await status(place, ['--file', '.agents/team.yaml'], statusSources(quiet), other), "--file is the owner's"));
scene('status.session-owner', async (place) => show(await status(place, ['--session', 'team'], statusSources(quiet), other), "--session is the owner's"));
scene('status.not-yours', async (place) => {
  // A caller that does not pass learns nothing, even when the target does not load: the answer is
  // the one fixed sentence, byte for byte, on stderr, and nothing else anywhere.
  const ran = await status(place, [], { ...statusSources(quiet), home: place.home, gate: { standing: () => ({ kind: 'none' }) } }, other);
  expect(ran.err).toBe('team status: this team is not yours to read\n');
  expect(ran.out).toBe('');
  return ran;
});

async function seats(place: Place, argv: string[], sources: SeatsSources, caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runSeats(argv, io, sources), out: io.out, err: io.err };
}

scene('seats.invocation', async (place) => show(await seats(place, ['extra'], statusSources(quiet)), 'unexpected'));
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
    standing: () => ({ kind: 'refused', why: 'the record cannot be verified: run `team approve` once' }),
  })), 'cannot be verified');
});
scene('up.differs', async (place) => {
  approve(place, TEAM);
  write(place, TEAM.replace('label: lead', 'label: renamed'));
  return show(await up(place, ['--file', place.file], owner, upSources(place)), 'not the approved one');
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
scene('up.delegate-approved-copy', async (place) => {
  approve(place, `${TEAM}${DELEGATES}`);
  return show(await up(place, ['--file', place.file], other, upSources(place, gateAt(place, { approvedCopy: () => null }))), 'deny');
});
scene('up.delegate-drift', async (place) => {
  approve(place, `${TEAM}${DELEGATES}`);
  write(place, `${TEAM.replace('label: lead', 'label: renamed')}${DELEGATES}`);
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
scene('up.grant-approved-copy', async (place) => {
  approve(place, GRANTED);
  return show(await up(place, [], leadSeat, upSources(place, grantRead({ approvedCopy: () => null }))), 'deny');
});
scene('up.grant-drift', async (place) => {
  approve(place, GRANTED);
  write(place, readFileSync(place.file, 'utf8').replace('label: lead', 'label: renamed'));
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
  updateState(place.root, (state) => {
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
scene('watch.stopped', async (place) => {
  write(place, TEAM);
  return show(await watched(place, [], owner), 'stopped');
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
scene('list.empty', async (place) => show(await listed(place, [], noTeam), 'no running sessions'), false);
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
  return show(await worktree(place, ['new', 'task']), 'never approved');
});
scene('worktree.approved-copy', async (place) => {
  approve(place, worktreeText());
  // The file differs from the approval, and the copy the record stored is one this version
  // can't read: there is no approved value to run with.
  write(place, worktreeText({ limit: 4 }));
  const standing = approvalStanding(place.root, place.home);
  if (standing.kind !== 'verified') throw new Error(standing.kind);
  const broken = { ...standing, record: { ...standing.record, file: 'nope: [[[' } };
  return show(
    await worktree(place, ['new', 'task', '--kind', 'fix'], owner, { ...worktreeSources(place), standing: () => broken }),
    "approved copy can't be read",
  );
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
  return show(await worktree(place, ['new', 'select-width', '--kind', 'fix']), 'outside the approved trust');
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
scene('worktree.seat-unapproved', async (place) => {
  approve(place, worktreeText());
  write(place, `${worktreeText()}  - role: implementer
    name: added-later
    label: later
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  return show(await worktree(place, ['new', 'task', '--kind', 'fix', '--seat', 'added-later']), 'is not in the approved file');
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
  return show(await worktree(place, ['list']), '0 open, limit');
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

scene('team.help', async (place) => show(await entry(['--help'], testIo(place.root, owner)), 'Usage:'));
scene('team.no-command', async (place) => show(await entry([], testIo(place.root, owner)), 'Usage:'));
scene('team.version', async (place) => show(await entry(['--version'], testIo(place.root, owner)), version()));
scene('team.unknown', async (place) => show(await entry(['nosuch'], testIo(place.root, owner)), 'unknown command'));
scene('team.command-help', async (place) => show(await entry(['status', '--help'], testIo(place.root, owner)), 'Usage: team status'));
scene('team.command-threw', async (place) => {
  const root = join(place.base, 'a b');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  return show(await entry(['init'], testIo(root, owner)), 'team:');
});

const CURSOR_TRUST = readFileSync(new URL('./fixtures/cursor/2026.10.01/trust.txt', import.meta.url), 'utf8');
const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');

function cursorTeam(lobby: string, dialogs: 'owner' | 'coordinator', root: string): string {
  const section = dialogs === 'coordinator' ? 'dialogs:\n  trust: coordinator\n' : '';
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
${section}trust:
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
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  return show(await answered(place, ['lead', 'trust'], other, answerHost(place, '')), 'only the owner');
});
scene('answer.file-owner', async (place) => {
  write(place, TWO);
  return show(await answered(place, ['lead', 'trust', '--file', '.agents/team.yaml'], other, answerHost(place, '')), "--file is the owner's");
});
scene('answer.no-pane', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  return show(await answered(place, ['lead', 'trust'], leadSeat, answerHost(place, '')), 'no pane is recorded for seat lead');
});
scene('answer.session-owner', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  return show(await answered(place, ['lead', 'trust', '--session', 'other'], leadSeat, answerHost(place, '')), "--session is the owner's");
});
scene('answer.another-pane', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w2:p1' };
  });
  return show(await answered(place, ['lead', 'trust'], leadSeat, answerHost(place, '')), 'the state records pane w2:p1 for seat lead');
});
scene('answer.policy', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'owner', place.root));
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, '')), 'use team up and [o]');
});
scene('answer.process', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
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
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { extra: { stage: 'ready', pane: 'w9:p1' } }, worktrees: {} };
  });
  return show(await answered(place, ['extra', 'trust', '--file', place.file], owner, answerHost(place, '')), 'not an approved seat');
});
scene('answer.ambiguous', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
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
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  const host = answerHost(place, '');
  host.agents = () => [];
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, host), 'not a live seat');
});
scene('answer.version', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, CURSOR_TRUST, { version: '2026.10.02' })), 'no trust answer');
});
scene('answer.screen', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
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
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  const screen = CURSOR_TRUST.replace('[a] Trust this workspace', '[a] Trust this workspacX').replace('<untrusted-directory>', lobby);
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, screen)), 'not the trust dialog');
});
scene('answer.folder', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root).replace(`trust:\n  - ${lobby}\n  - ${place.root}`, 'trust:\n  - .'));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  const screen = CURSOR_TRUST.replace('<untrusted-directory>', lobby);
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, screen)), 'not an exact trust entry');
});
scene('answer.recovery', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'trust-sent-recovery', classification: 'trust' } } }, worktrees: {} };
  });
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, 'not a dialog\n')), 'recovery required');
});
scene('answer.ready', async (place) => {
  const lobby = lobbyDir(place.home);
  mkdirSync(lobby, { recursive: true });
  approve(place, cursorTeam(lobby, 'coordinator', place.root));
  updateState(dirname(place.file), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'waiting-owner', classification: 'trust' } } }, worktrees: {} };
  });
  const screen = CURSOR_TRUST.replace('<untrusted-directory>', lobby);
  return show(await answered(place, ['lead', 'trust', '--file', place.file], owner, answerHost(place, screen)), 'trust answered; ready');
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
scene('messages.not-a-repo', async (place) => show(await messaged(place), 'not inside a git repository'), false);

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
  return show(await issued(place), 'nothing is waiting');
});
scene('issues.shown', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  return show(await issued(place), 'm1  the task title');
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
scene('issues.not-a-repo', async (place) => show(await issued(place), 'not inside a git repository'), false);

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

async function tempo(place: Place, argv: string[], caller: Caller = owner): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runTempo(argv, io, { home: place.home }), out: io.out, err: io.err };
}

scene('tempo.set', async (place) => {
  write(place, TEAM);
  return show(await tempo(place, ['urgent']), 'it takes effect when the file is approved');
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
scene('tempo.not-a-repo', async (place) => show(await tempo(place, ['urgent']), 'not inside a git repository'), false);
scene('tempo.file', async (place) => show(await tempo(place, ['urgent']), 'no team file'));

async function nexted(place: Place, argv: string[] = [], caller: Caller = leadSeat): Promise<Ran> {
  const io = testIo(place.root, caller);
  return { code: await runNext(argv, io, { home: place.home }), out: io.out, err: io.err };
}

function recordLead(place: Place, pane = 'w1:p1'): void {
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane };
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
scene('next.not-a-repo', async (place) => show(await nexted(place), 'not inside a git repository'), false);

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
scene('broker.not-a-repo', async (place) => show(await brokered(place, [], { keyReader: okKey }), 'not inside a git repository'), false);
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
  return show(await planned(place), 'nothing is takeable');
});
scene('plan.shown', async (place) => {
  write(place, TASKS);
  writeFileSync(join(place.root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  recordLead(place);
  return show(await planned(place), 'm1  the task title');
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
scene('plan.not-a-repo', async (place) => show(await planned(place), 'not inside a git repository'), false);
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

/** `team send`'s fixtures: a fake seat of the fixture's own file, a sockets folder with a file
 *  at the pid the fake pane process reports, and a deliver that accepts — with `reply` set,
 *  the seat also answers at the sender's own pid path, as a session does. No session is read. */
function sendHost(place: Place, over: { agents?: boolean; socket?: boolean; reply?: string } = {}): SendHost & { frames: string[] } {
  const sockets = join(place.base, 'cc-socks');
  mkdirSync(sockets, { recursive: true });
  if (over.socket !== false) writeFileSync(join(sockets, '400.sock'), '');
  const host: SendHost & { frames: string[] } = {
    frames: [],
    agents: () => (over.agents === false ? null : [{ name: 'lead', pane: 'w1:p1' }]),
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
      pressEnter: () => true,
      status: () => 'working',
      wait: async () => {},
    },
    now: () => NOW,
    home: place.home,
  };
  return host;
}

async function sent(place: Place, argv: string[], caller: Caller, host: SendHost): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runSend(argv, io, host);
  return { code, out: io.out, err: io.err };
}

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
  show(await sent(place, ['lead', '--file', 'missing.yaml'], owner, sendHost(place)), 'no team file'));
scene('send.refused', async (place) => {
  write(place, TWO);
  return show(await sent(place, ['missing', 'hello'], owner, sendHost(place)), 'it is not a declared seat');
});
scene('send.held', async (place) => {
  write(place, TEAM);
  const host = sendHost(place);
  host.native.paneText = () => `${'─'.repeat(30)}\n❯ draft in box\n${'─'.repeat(30)}`;
  return show(await sent(place, ['lead', 'hello'], owner, host), 'held');
});
scene('send.unreachable', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello'], owner, sendHost(place, { agents: false })), 'unreachable');
});
scene('send.delivered', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello'], owner, sendHost(place)), 'lead: delivered');
});
scene('send.dry-run', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello', '--dry-run'], owner, sendHost(place)), 'lead: dry-run: claude-code via a 0600 drop file and one trigger line; nothing was written');
});
scene('send.answered', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello', '--wait'], owner, sendHost(place, { reply: 'pong' })), 'lead: answered\npong');
});
scene('send.timeout', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['lead', 'hello', '--wait', '--timeout', '1'], owner, sendHost(place)), 'timeout: sent, no reply within 1s');
});
scene('send.listed', async (place) => {
  write(place, TEAM);
  return show(await sent(place, ['--list'], owner, sendHost(place)), 'lead  claude-code');
});

async function fed(place: Place, argv: string[]): Promise<Ran> {
  const io = testIo(place.root);
  const code = await runFeed(argv, io, { home: place.home, poll: async () => false });
  return { code, out: io.out, err: io.err };
}

scene('feed.ok', async (place) => {
  write(place, TEAM);
  return show(await fed(place, []), '(no messages)');
});
scene('feed.unreadable', async (place) => {
  write(place, TEAM);
  const log = historyPath('acme', place.root, place.home);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  symlinkSync('/etc/passwd', log);
  return show(await fed(place, []), 'the history log cannot be read: a symbolic link was found and not followed');
});
scene('feed.configuration', async (place) => show(await fed(place, []), 'no team file'));
scene('feed.usage', async (place) => show(await fed(place, ['extra']), 'unexpected "extra"'));

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
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ text: 'no prompt here' }) }), 'not at an idle prompt');
});
scene('reload.not-running', async (place) => {
  write(place, TEAM);
  return show(await reloaded(place, ['lead']), 'no ready pane to close');
});
scene('reload.unrecorded', async (place) => {
  write(place, TEAM);
  recordReload(place, 'lead', false);
  return show(await reloaded(place, ['lead']), 'were not recorded at launch');
});
scene('reload.unsent', async (place) => {
  write(place, RELOAD_FILE);
  recordReload(place, 'lead');
  return show(await reloaded(place, ['lead'], owner, { launch: reloadLaunch({ text: claudeBox('draft') }) }), 'holds unsent text');
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
scene('reload.grant-approved-copy', async (place) => {
  approve(place, RELOAD_GRANT);
  return show(await reloaded(place, ['worker'], leadSeat, { grantGate: (input) => grantGate({ ...input, sources: { approvedCopy: () => null } }) }), 'a grant needs a readable approved copy');
});
scene('reload.grant-drift', async (place) => {
  approve(place, RELOAD_GRANT);
  write(place, readFileSync(place.file, 'utf8').replace('label: lead', 'label: renamed'));
  return show(await reloaded(place, ['worker'], leadSeat), 'a grant needs the approved file');
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
  return show(await reloaded(place, ['lead'], leadSeat), 'the approved file grants nothing');
});
scene('reload.grant-file', async (place) => {
  write(place, 'format: [\n');
  return show(await reloaded(place, ['lead'], leadSeat), 'line');
});

// Outcomes that are listed and kept, and that no scene can produce. An edit the earlier checks
// have already validated reads here (add.prepared, add.locked, add.not-restored), and so do
// answer.action and up.delegate-placement. add.no-profile and
// remove.no-profile joined them when grok's profile shipped: the file loader accepts exactly the
// CLIs this version knows, and every one of them now has a launch profile, so no team file can
// reach the refusals — they stand, rows and exit sites whole, for a CLI listed before its profile
// ships, which is the state grok itself was in until now.
const SENTENCE = 'only the owner runs this, from a terminal outside herdr';
scene('add.detached', async (place) => show(await added(place, ['worker'], detachedCaller, addSources(place)), SENTENCE));
scene('answer.detached', async (place) => show(await answered(place, ['lead', 'trust'], detachedCaller, answerHost(place, '')), SENTENCE));
scene('broker.detached', async (place) => show(await brokered(place, [], { keyReader: okKey }, detachedCaller), SENTENCE));
scene('down.detached', async (place) => show(await down(place, [], detachedCaller, downSources()), SENTENCE));
scene('init.detached', async (place) => show(await initial(place, [], detachedCaller), SENTENCE));
scene('remove.detached', async (place) => show(await removed(place, ['worker'], detachedCaller, downSources()), SENTENCE));
scene('send.detached', async (place) => show(await sent(place, ['--list'], detachedCaller, sendHost(place)), SENTENCE));
scene('up.detached', async (place) => show(await up(place, ['--session', 'elsewhere'], detachedCaller, upSources(place)), SENTENCE));
scene('watch.caller', async (place) => show(await watched(place, [], detachedCaller), SENTENCE));
scene('worktree.detached', async (place) => show(await worktree(place, ['list'], detachedCaller), SENTENCE));

const defensive = new Set(['add.prepared', 'add.locked', 'add.not-restored', 'add.no-profile', 'remove.no-profile', 'answer.action', 'up.delegate-placement']);

const contract = loadContract();
for (const row of contract.rows) {
  if (defensive.has(row.id)) continue;
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
    .replace(/^! (?:up|down|add) would refuse: /, '')
    .replace(/^team add: refused: /, '')
    .replace(/^[^:\n]+: would refuse: /, '')
    .replace(/^team (?:up|down|add): /, '')
    .replace(/\/(?:private\/)?tmp\/team-exit-\w+/g, '<place>')
    .replace(/acme-[0-9a-f]{8,}/g, 'acme-<id>');
}

for (const command of ['up', 'down', 'add'] as const) {
  test(`${command}: a refused dry run exits as the real run`, async () => {
    const ids = refusalIds(command);
    expect(ids.length).toBeGreaterThan(0);
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
        expect(refusalCore(`${dry.err}${dry.out}`), id).toContain(shared);
      } finally {
        compareDry = false;
        rmSync(dryPlace.base, { recursive: true, force: true });
        rmSync(realPlace.base, { recursive: true, force: true });
      }
    }
  }, 120_000);
}

test('every listed outcome has a run', () => {
  const ids = contract.rows.map((row) => row.id);
  expect(ids.filter((id) => !scenes.has(id) && !defensive.has(id))).toEqual([]);
  expect(scenes.size + defensive.size).toBe(ids.length);
});

test('the exit-code check is clean', () => {
  expect(problems()).toEqual([]);
});

test('a new return that reuses a code fails the check', () => {
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

test('removing a row fails the check', () => {
  const rows = contract.rows.filter((row) => row.id !== 'doctor.clear');
  const found = problems({ contractText: canon(rows), page: render(rows) });
  expect(found.some((line) => line.includes('doctor.clear') && line.includes('no contract row'))).toBe(true);
});

test('changing a returned code fails the check', () => {
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

test('an implicit arrow return fails the check', () => {
  const files = withDoctor("  const reviewGateProbe = (): 1 => 1;\n  if (argv[0] === '--gate-probe') return reviewGateProbe();\n");
  expect(rejects(files)).toBe(true);
});

test('an identifier return fails the check', () => {
  const files = withDoctor("  const probeCode = 1;\n  if (argv[0] === '--gate-probe') return probeCode;\n");
  expect(rejects(files)).toBe(true);
});

test('a throw in an imported helper is covered by team.command-threw', () => {
  const files = withDoctor("  if (argv[0] === '--gate-probe') gateThrow();\n", "import { gateThrow } from './gate-throw.ts';\n");
  files.set('src/commands/gate-throw.ts', "export function gateThrow(): void {\n  throw new Error('gate');\n}\n");
  expect(problems({ files })).toEqual([]);
  expect(analyze(files).coveredThrows.some((item) => item.file === 'src/commands/gate-throw.ts' && item.id === 'team.command-threw')).toBe(true);
});

test('a default-parameter call fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return probeDefault();\n",
    'function hidden(): number { return 1; }\nfunction probeDefault(code = hidden()): number { return code; }\n',
  );
  expect(rejects(files)).toBe(true);
});

test('an awaited helper return fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return await later();\n",
    'async function later(): Promise<number> { return 1; }\n',
  );
  const found = problems({ files });
  expect(found.some((line) => line.includes('exit site has no row'))).toBe(true);
});

test('a switch that falls through fails the check', () => {
  const files = withDoctor(
    "  if (argv[0] === '--gate-probe') return switched(argv[0] ?? '');\n",
    "function switched(flag: string): number {\n  let value = 1;\n  switch (flag) {\n    case 'a':\n      value = 1;\n    default:\n      return value;\n  }\n}\n",
  );
  expect(rejects(files)).toBe(true);
});

test('return void 0 ?? 1 fails the check', () => {
  const files = withDoctor("  if (argv[0] === '--gate-probe') return void 0 ?? 1;\n");
  expect(rejects(files)).toBe(true);
});

function namesLine(files: Map<string, string>, file: string): boolean {
  return problems({ files }).some((line) => new RegExp(`${file}:\\d+:`).test(line));
}

test('process.exit with no argument fails the check', () => {
  const files = withDoctor("  if (argv[0] === '--gate-probe') process.exit();\n");
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

test('a module-level process.exit fails the check', () => {
  const files = withDoctor('', "if (process.env.GATE_PROBE === '1') process.exit(17);\n");
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

test('a default call that is not the command table fails the check', () => {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text.replace(
    'return command.default(rest, io);',
    "if (argv[0] === '--gate-probe') return ({ default: () => 17 }).default();\n  return command.default(rest, io);",
  );
  const files = new Map([['src/cli.ts', next]]);
  expect(namesLine(files, 'src/cli.ts')).toBe(true);
});

test('a function name declared twice fails the check', () => {
  const files = withDoctor(
    "  function probeShadow(): number { return 17; }\n  if (argv[0] === '--gate-probe') return probeShadow();\n",
    'function probeShadow(): number { return runDoctor(); }\n',
  );
  expect(namesLine(files, 'src/commands/doctor.ts')).toBe(true);
});

test('a followed helper with no return fails the check', () => {
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

test('a re-exported command fails the check', () => {
  const files = withTable(
    "probe: () => import('./commands/probe.ts'),",
    [['src/commands/probe.ts', "export { default, USAGE } from './doctor.ts';\n"]],
  );
  expect(problems({ files }).some((line) => line.includes('src/commands/probe.ts') && line.includes(UNROOTED))).toBe(true);
});

test('a command file with no default export fails the check', () => {
  const files = withTable(
    "probeEmpty: () => import('./commands/probe-empty.ts'),",
    [['src/commands/probe-empty.ts', "export const USAGE = 'probe';\n"]],
  );
  expect(problems({ files }).some((line) => line.includes('src/commands/probe-empty.ts') && line.includes(UNROOTED))).toBe(true);
});

test('a table entry outside src/commands fails the check', () => {
  const files = withTable("probe: () => import('./outside.ts'),");
  const found = problems({ files });
  expect(found.some((line) => line.includes('probe') && line.includes('src/outside.ts') && line.includes("an entry in the commands table whose module the gate didn't walk"))).toBe(true);
});

test('a default export imported from another file fails the check', () => {
  const files = withTable(
    "probeAlias: () => import('./commands/probe-alias.ts'),",
    [['src/commands/probe-alias.ts', "import run from './doctor.ts';\nexport default run;\n"]],
  );
  expect(problems({ files }).some((line) => line.includes('src/commands/probe-alias.ts') && line.includes(UNROOTED))).toBe(true);
});

test('a walked command file missing from the table fails the check', () => {
  const text = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const next = text.replace("  add: () => import('./commands/add.ts'),\n", '');
  const found = problems({ files: new Map([['src/cli.ts', next]]) });
  expect(found.some((line) => line.includes('src/commands/add.ts') && line.includes('a walked file that is in no table entry'))).toBe(true);
});

test('a second table key for one file fails the check', () => {
  const files = withTable("probe: () => import('./commands/doctor.ts'),");
  const found = problems({ files });
  expect(found.some((line) => line.includes('doctor and probe load src/commands/doctor.ts'))).toBe(true);
});

test('a table key that is not the module name fails the check', () => {
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

test.each(unreadForms)('$name fails the check', (row) => {
  const found = problems(row.extra
    ? { files: row.files, contractText: canon([...contract.rows, ...row.extra]), page: render([...contract.rows, ...row.extra]) }
    : { files: row.files });
  expect(found.some((line) => line.includes(row.needle)), row.name).toBe(true);
});
