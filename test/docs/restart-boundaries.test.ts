// The restart page and its design note, held to the command that ships. The page's caller rows,
// its busy enumeration and its output rows are pinned as written; each refusal they state is
// pinned to the line that prints it; and the members of the busy enumeration no other test
// drives — the exit question, the unrecognised screen with the owner's way out, the blocked
// prompt without --abandon — run through runRestart itself, beside the refusals the page stakes
// that no scene covers: the flags the owner alone may aim, an ordinary seat's call, the self
// check that reads the pane and not the name, and the owner's --abandon closing a working seat.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import { runRestart, type RestartSources } from '../../src/commands/restart.ts';
import type { Launch } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { claudeBox, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-16T04:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

const PAGE = '../../docs/commands/restart.md';
const SRC = '../../src/commands/restart.ts';

// The page's caller table, its busy enumeration, and the two flags it reserves to the owner.
const OWNER_ROW = 'run it, from a terminal outside herdr; `--session` and `--file` are the owner\'s own';
const NO_TERMINAL_ROW =
  'nothing: ``team restart: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane``';
const LEAD_ROW =
  'never its own recorded pane, never `--abandon` on the orchestrator\'s or the operator\'s seat, and never `--abandon` on a `working` seat';
const BUSY_ENUMERATION =
  'working, blocked at a prompt, at its own exit question, or holding unsent text';
const FILE_FLAG = 'deprecated: a legacy team file to read instead of the team\'s registry record; the owner\'s alone';
const SESSION_FLAG = 'the herdr session, instead of `team.session`; the owner\'s alone';
const RESTARTED_ROW = 'team restart: restarted <seat>; pane <old-pane> -> <new-pane>';
const DRY_ROW = 'the stop line and the launch plan';
const REFUSED_ROW = '`team restart: <reason>` | 1';
const USAGE_ROW = '`team restart: <problem>` and the usage | 2';
const POINTER = 'Design and behaviour: [docs/design/restart.md](../design/restart.md).';

// The source that decides each: the busy sentences (including the two the page paraphrases — the
// exit question and the unrecognised screen), the caller refusal, the detached and flag wiring,
// and the self check that reads the recorded pane, not the caller's name.
const SRC_LEFT_WORKING = "working: 'is working; left as it is',";
const SRC_LEFT_BLOCKED = "blocked: 'is blocked at a prompt, which team never answers; left as it is',";
const SRC_LEFT_UNKNOWN = "unknown: 'shows a screen the profile does not recognise; left as it is',";
const SRC_LEFT_UNSENT = "unsent: 'holds unsent text in its input box; left as it is',";
const SRC_EXIT_QUESTION = 'sits at its own exit question; left as it is (team restart ${name} --abandon closes it)';
const SRC_OWNER_WAY = '(team restart ${name} --abandon closes its workspace without typing)';
// The source text escapes the backticks inside its template literal, so the pin does too.
const SRC_CALLER = 'only the owner or \\`leads\\` restarts a seat; this call is ';
const SRC_DETACHED_WIRING = "const detached = detachedRefusal(walked, { who: 'the owner or a `leads` seat'";
const SRC_FLAG_WIRING = 'const flagRefusal = fileOwnerRefusal(io, args.values.file)';
const SRC_SELF_PANE = 'caller.name === name || (recordedSeat?.pane !== undefined && caller.pane === recordedSeat.pane)';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
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

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ScreenKind = 'idle' | 'working' | 'permission' | 'exit question' | 'unknown';

function makeWorld(workerScreen: ScreenKind = 'idle', workerStatus?: string): {
  root: string;
  file: string;
  dir: string;
  sources: RestartSources;
  did: { typed: string[]; closed: string[]; runs: string[] };
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restart-bnd-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, TEAM_YAML.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`));

  const did = { typed: [] as string[], closed: [] as string[], runs: [] as string[] };
  let workerAlive = true;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: root },
    ];
    if (workerAlive) {
      list.push({
        name: 'worker',
        agent: 'claude-code',
        pane: 'pane-old',
        workspace: 'ws-old',
        status: workerStatus ?? (workerScreen === 'working' ? 'working' : 'idle'),
        cwd: root,
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name ?? '', agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle', cwd: root });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      return true;
    },
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => currentAgents().map((a) => a.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === 'ws-old') workerAlive = false;
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      const pane = 'pane-new';
      const workspace = 'ws-new';
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      newPanes.get(pane)!.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      newPanes.get(pane)!.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => currentAgents().map((a) => a.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((a) => ({ id: a.workspace })),
    alive: () => true,
    screen: () => ({ kind: workerScreen }),
    screenText: () => claudeBox(''),
    status: () => workerStatus ?? (workerScreen === 'working' ? 'working' : 'idle'),
    foreground: () => ['claude'],
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { root, file, dir, sources, did };
}

function record(dir: string, seats: Record<string, string>): void {
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    for (const [name, pane] of Object.entries(seats)) session.seats[name] = { stage: 'ready', pane, workspace: `ws-${name}` };
  });
}

describe('the restart page, held to its command', () => {
  test('the caller rows, the busy enumeration and the output rows stand as written', () => {
    const page = prose(PAGE);
    expect(page.includes(OWNER_ROW), 'the owner row lost its outside-herdr terminal and own flags').toBe(true);
    expect(page.includes(NO_TERMINAL_ROW), 'the no-terminal row lost its fixed sentence').toBe(true);
    expect(page.includes(LEAD_ROW), 'the lead row lost its three nevers').toBe(true);
    expect(page.includes(BUSY_ENUMERATION), 'the intro lost its busy enumeration').toBe(true);
    expect(page.includes(FILE_FLAG), 'the --file row lost the owner\'s alone').toBe(true);
    expect(page.includes(SESSION_FLAG), 'the --session row lost the owner\'s alone').toBe(true);
    expect(page.includes(RESTARTED_ROW), 'the output table lost the restarted line').toBe(true);
    expect(page.includes(DRY_ROW), 'the output table lost the dry-run row').toBe(true);
    expect(page.includes(REFUSED_ROW), 'the output table lost the refusal row and its exit').toBe(true);
    expect(page.includes(USAGE_ROW), 'the output table lost the usage row and its exit').toBe(true);
    expect(page.includes(POINTER), 'the page lost its design-note pointer').toBe(true);
  });

  test('every sentence the page paraphrases is printed by the line it names', () => {
    const src = raw(SRC);
    expect(src.includes(SRC_LEFT_WORKING), 'the working sentence moved').toBe(true);
    expect(src.includes(SRC_LEFT_BLOCKED), 'the blocked-at-a-prompt sentence moved').toBe(true);
    expect(src.includes(SRC_LEFT_UNKNOWN), 'the unrecognised-screen sentence moved').toBe(true);
    expect(src.includes(SRC_LEFT_UNSENT), 'the unsent sentence moved').toBe(true);
    expect(src.includes(SRC_EXIT_QUESTION), 'the exit-question sentence moved').toBe(true);
    expect(src.includes(SRC_OWNER_WAY), 'the owner\'s --abandon way out moved').toBe(true);
    expect(src.includes(SRC_CALLER), 'the caller refusal sentence moved').toBe(true);
    expect(src.includes(SRC_DETACHED_WIRING), 'the detached check no longer runs off the walk').toBe(true);
    expect(src.includes(SRC_FLAG_WIRING), 'the flag refusals are no longer wired before the file is read').toBe(true);
    expect(src.includes(SRC_SELF_PANE), 'the self check no longer reads the recorded pane').toBe(true);
  });

  test('the refusals the page stakes, through the command: no terminal, an ordinary seat, owner-only flags, self pane', async () => {
    // A run with no terminal: the fixed sentence, before any file is read (the folder has none).
    const bare = makeWorld();
    const ioDetached = testIo(bare.root, { kind: 'owner-no-tty' });
    expect(await runRestart(['worker'], ioDetached, bare.sources)).toBe(1);
    expect(ioDetached.err).toBe('team restart: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane\n');
    expect(ioDetached.out).toBe('');

    // An ordinary seat of the team may not restart another seat: the map's `restart` row admits
    // the owner and the team's `leads`, and the seat holds no `leads`.
    const world = makeWorld();
    record(world.dir, { worker: 'pane-old' });
    const workerCaller = { kind: 'seat', name: 'worker', pane: 'pane-old', session: 'acme' } as const;
    const ioWorker = testIo(world.root, workerCaller);
    expect(await runRestart(['lead'], ioWorker, world.sources)).toBe(1);
    expect(ioWorker.err).toBe('team restart: only the owner or `leads` restarts a seat; this call is worker\n');
    expect(ioWorker.out).toBe('');

    // A lead on its recorded pane may not aim --file or --session: refused before the path is
    // read, so a missing path and the real file answer with the same bytes.
    record(world.dir, { lead: 'pane-lead', worker: 'pane-old' });
    const leadCaller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' } as const;
    const ioFileMissing = testIo(world.root, leadCaller);
    expect(await runRestart(['worker', '--file', join(world.root, 'no-such.yaml')], ioFileMissing, world.sources)).toBe(1);
    expect(ioFileMissing.err).toBe(`team restart: --file is the owner's, from a terminal outside herdr; this call is lead\n`);
    const ioFilePresent = testIo(world.root, leadCaller);
    expect(await runRestart(['worker', '--file', world.file], ioFilePresent, world.sources)).toBe(1);
    expect(ioFilePresent.err).toBe(ioFileMissing.err);
    const ioSession = testIo(world.root, leadCaller);
    expect(await runRestart(['worker', '--session', 'acme'], ioSession, world.sources)).toBe(1);
    expect(ioSession.err).toBe(`team restart: --session is the owner's, from a terminal outside herdr; this call is lead\n`);

    // The self check reads the recorded pane, not the caller's name: the lead, standing on the
    // target seat's recorded pane, is refused as a self restart.
    record(world.dir, { lead: 'pane-old', worker: 'pane-old' });
    const leadOnWorkerPane = { kind: 'seat', name: 'lead', pane: 'pane-old', session: 'acme' } as const;
    const ioSelfPane = testIo(world.root, leadOnWorkerPane);
    expect(await runRestart(['worker'], ioSelfPane, world.sources)).toBe(1);
    expect(ioSelfPane.err).toBe('team restart: the lead cannot restart its own recorded pane; another `leads` seat (or the owner) restarts it\n');
    expect(world.did.closed).toEqual([]);
  });

  test('the busy enumeration members no other scene drives, and the owner\'s --abandon on a working seat', async () => {
    // At its own exit question: left as it is, with the --abandon that closes it named.
    const exitQ = makeWorld('exit question');
    record(exitQ.dir, { worker: 'pane-old' });
    const ioExitQ = testIo(exitQ.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioExitQ, exitQ.sources)).toBe(1);
    expect(ioExitQ.err).toBe('team restart: worker sits at its own exit question; left as it is (team restart worker --abandon closes it)\n');
    expect(exitQ.did.closed).toEqual([]);

    // Blocked at a prompt without --abandon: never answered, left as it is.
    const blocked = makeWorld('permission');
    record(blocked.dir, { worker: 'pane-old' });
    const ioBlocked = testIo(blocked.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioBlocked, blocked.sources)).toBe(1);
    expect(ioBlocked.err).toBe('team restart: worker is blocked at a prompt, which team never answers; left as it is\n');
    expect(blocked.did.closed).toEqual([]);

    // A screen the profile does not recognise is advice when herdr itself reports the seat
    // idle: the workspace is closed without typing and the seat restarts. Only herdr's own
    // busy word keeps the refusal.
    const unknown = makeWorld('unknown');
    record(unknown.dir, { worker: 'pane-old' });
    const ioUnknown = testIo(unknown.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioUnknown, unknown.sources)).toBe(0);
    expect(unknown.did.typed).toEqual([]);
    expect(unknown.did.closed).toEqual(['ws-old']);
    expect(ioUnknown.out).toContain('worker: input box: not read (the screen is not recognised)\n');
    expect(ioUnknown.out).toContain('worker: screen: not recognised; herdr reports it idle; the workspace is closed without typing into it\n');
    expect(ioUnknown.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');

    // The same unread screen with herdr reporting a turn: the refusal stands, and the owner's
    // way out is named.
    const unknownWorking = makeWorld('unknown', 'working');
    record(unknownWorking.dir, { worker: 'pane-old' });
    const ioUnknownWorking = testIo(unknownWorking.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioUnknownWorking, unknownWorking.sources)).toBe(1);
    expect(ioUnknownWorking.err).toBe('team restart: worker shows a screen the profile does not recognise; left as it is (team restart worker --abandon closes its workspace without typing)\n');
    expect(unknownWorking.did.closed).toEqual([]);

    // The owner's --abandon on a working seat closes it without typing and restarts it. The
    // launch command itself is not "typing into the pane": only closeUnasked skips the pane.
    const working = makeWorld('working', 'working');
    record(working.dir, { worker: 'pane-old' });
    const ioWorking = testIo(working.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--abandon'], ioWorking, working.sources)).toBe(0);
    expect(working.did.typed).toEqual([]);
    expect(working.did.closed).toEqual(['ws-old']);
    expect(working.did.runs.join(' ')).toContain('claude --model claude-opus-5-5');
    expect(ioWorking.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readFileSync(working.file, 'utf8')).toBe(TEAM_YAML.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${working.root}\nworkspace:\n`));
  });
});
