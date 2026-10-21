// Who may change a running team: the owner, or the coordinator's / operator's seat of the
// session the team file names, on the pane the state records for it. A seat of another session
// is a seat of that session — a pane merely renamed to the coordinator's name, even in the right
// session, is not the coordinator's — and a caller of the right session on the pane the state
// records behaves exactly as it did before the session and the pane were judged.
//
// The callers are placed the way the caller tests place them, through fake sources, and handed
// to each command's real run function, so the gate under test is the shipped one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { placeCaller, type Caller, type CallerSources } from '../../src/caller.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../../src/commands/answer.ts';
import { runDown, type DownSources } from '../../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { GENERAL_BRIEF_SHA256, generalBriefBody, generalBriefId } from '../../src/launch/general-brief.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, testIo, type TestIo } from '../helpers.ts';

const SESSION = 'acme-web';
const OTHER = 'other-web';
const COORDINATOR = 'claude-coordinator-acme';
const OPERATOR = 'claude-operator-acme';
const SEAT = 'codex-acme';
const COORDINATOR_PANE = 'w1:p1';

const FILE = `format: 1
project: acme
session: ${SESSION}
coordinator: ${COORDINATOR}
operator: ${OPERATOR}
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: ${COORDINATOR}
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: ${OPERATOR}
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: ${SEAT}
    label: codex
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;

const STATE = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: {
        [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE },
        [OPERATOR]: { stage: 'ready', pane: 'w4:p1' },
        [SEAT]: { stage: 'ready', pane: 'w3:p1' },
      },
      worktrees: {},
    },
  },
};

// The same state, with the implementer's seat temporary: it changes nothing about who may
// change the team.
const TEMPORARY_STATE = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: { [SEAT]: { stage: 'ready', pane: 'w3:p1', temporary: { like: COORDINATOR, until: '2026-10-06T00:00:00Z' } } },
      worktrees: {},
    },
  },
};

// The state tag v0.2.1 (4e0e311) writes, byte for byte: built by replaying its own
// `src/launch/execute.ts` patches through its own `readState`/`updateState`
// (coordinator-session.scratch/build-021-state.ts), so the field names and the extra `cli`
// and `rules` records are the release's, not a guess. It records the coordinator's pane —
// this is the state every upgrading team has.
const STATE_021 = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: {
        [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE, workspace: 'w1', cli: 'claude-code', rules: 'option' },
        [OPERATOR]: { stage: 'ready', pane: 'w2:p1', workspace: 'w2', cli: 'claude-code', rules: 'option' },
        [SEAT]: { stage: 'ready', pane: 'w3:p1', workspace: 'w3', cli: 'codex', rules: 'message' },
      },
      worktrees: {},
      watch: { pid: 4242, heartbeat: '2026-10-04T09:00:00.000Z' },
    },
  },
};

let base: string;
let dir: string;
let file: string;
let stateFile: string;
let home: string;
let emptyHome: string;
let fileText: string;

beforeEach(() => {
  // realpath: an absolute entry under the raw tmpdir names `/var`, a symbolic link, and the
  // load refuses a trust entry that lands through one.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-coordinator-session-')));
  dir = join(base, 'project');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  file = join(dir, '.agents', 'team.yaml');
  stateFile = join(dir, '.agents', 'team.state.json');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  // The approval in force `remove` needs to stop a seat and edit the file, signed over the
  // file above. `emptyHome` is a store that was never written: refusals for the commands
  // that need no approval in force. The home holds the lobby and the store, so it lives
  // beside the project, not inside it: trust may not cover the lobby and the store.
  home = join(base, 'home');
  emptyHome = join(base, 'home-empty');
  // The file every command loads here is a migrated one: its trust names the machine lobby the
  // setup slice writes (absolute, with `~`, as the migration line prints it) and the project.
  // The lobby it names must exist for the load's landing reads and the gate's mode check, so
  // the world makes it first, at 0700 as the gate requires.
  mkdirSync(lobbyDir(home), { recursive: true });
  chmodSync(lobbyDir(home), 0o700);
  fileText = `${FILE}trust:\n  - ~/.config/team/lobby\n  - ${dir}\n`;
  writeFileSync(file, fileText);
  const loaded = loadTeamFile(dir, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: fileText },
    loaded.team.seats,
    home,
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runningAgent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? '', status: 'idle', cwd: null };
}

// A caller placed by fake sources: its parent chain holds pane `pane`'s root process, and the
// session's agent list holds the pane under `name`. `session` is the session the placement is
// made in — the whole point of the cases below.
function placed(session: string | undefined, name: string | null, pane: string): Caller {
  const row = runningAgent(name ?? '', pane);
  const sources: CallerSources = {
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => [row],
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  };
  return session === undefined ? placeCaller(sources) : placeCaller(sources, session);
}

// The same fake sources, session-aware the way herdr is: the agent row is listed only when the
// command asks about `session` itself. Placed through the io seam, these are what a command
// that drops the session it judges in reads — an empty list, and a caller of nobody.
function sourcesOf(session: string, name: string, pane: string): (asked: string | undefined) => CallerSources {
  const row = runningAgent(name, pane);
  return (asked) => ({
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => (asked === session ? [row] : []),
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  });
}

// The same sources again, with every read that names a session written down in order: each agent
// list and pane root the command asks about. A run that reads a session it must not read — the
// flag's, before the refusal — leaves its name here, however its output would read.
function recordingSources(
  calls: string[],
  session: string,
  name: string,
  pane: string,
): (asked: string | undefined) => CallerSources {
  const base = sourcesOf(session, name, pane);
  return (asked) => {
    const real = base(asked);
    return {
      ...real,
      agents: () => {
        calls.push(`agents(${asked ?? 'no session'})`);
        return real.agents();
      },
      paneRootPid: (which) => {
        calls.push(`paneRoot(${which})`);
        return real.paneRootPid(which);
      },
    };
  };
}

// How a run's caller is handed to the command: placed the way the callers above are (a Caller),
// or placed through the fake sources, asked about the session the command judges in.
type Placement = Caller | { sources: (session: string | undefined) => CallerSources };

type Run = { code: number; out: string; err: string; before: string; beforeState: string };

// Every run starts from the file and the state as written: the same caller can be run twice
// against the same world, and a refusal can be checked against the bytes it started from.
async function call(
  runner: (io: TestIo) => Promise<number>,
  caller: Placement,
  options: { state?: Record<string, unknown> | null } = {},
): Promise<Run> {
  writeFileSync(file, fileText);
  const state = options.state === undefined ? (STATE as Record<string, unknown>) : options.state;
  if (state === null) rmSync(stateFile, { force: true });
  else writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');
  const beforeState = state === null ? '' : readFileSync(stateFile, 'utf8');
  const io = testIo(dir, 'sources' in caller ? undefined : caller);
  if ('sources' in caller) io.callerSources = caller.sources;
  const code = await runner(io);
  return { code, out: io.out, err: io.err, before, beforeState };
}

function addSources(): AddSources {
  return {
    home: emptyHome,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: {} as DoctorSources,
    now: () => new Date(0),
    launch: {} as Launch,
  };
}

function removeSources(over: Partial<RemoveSources> = {}): RemoveSources {
  return {
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => [],
    now: () => new Date(0),
    ...over,
  };
}

function worktreeSources(over: Partial<WorktreeSources> = {}): WorktreeSources {
  return { home: emptyHome, now: () => new Date(0), ...over };
}

function downSources(over: Partial<DownSources> = {}): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => [],
    now: () => new Date(0),
    home,
    ...over,
  };
}

function answerHost(): AnswerHost {
  return {
    version: () => null,
    agents: () => [],
    pane: () => undefined,
    sendKey: () => false,
    rename: () => false,
    foreground: () => [],
    foregroundCwd: () => null,
    list: () => [],
    status: () => null,
    type: () => false,
    enter: () => false,
    now: () => new Date(0),
    sleep: async () => {},
    home: emptyHome,
    standing: () => ({ kind: 'none' }),
  };
}

const NEVER_APPROVED = 'the file was never approved on this machine';

// This table judges the caller gate. The worktree commands now run a file with no stored
// approval — the live file is the record — so they pin a record that cannot be verified: the
// owner gets past the caller gate and meets that refusal, as this table read main doing. The
// no-record run has its own tests in test/commands/worktree.test.ts.
const worktreeRefused = (): WorktreeSources =>
  worktreeSources({ standing: () => ({ kind: 'refused', why: NEVER_APPROVED }) });

// The two refusal tails the commands share, each with the command's own name in front.
const NO_PANE = (name: string) =>
  `no pane is recorded for seat ${name} in this session: a lead stops that seat and runs \`team up\``;
const OWNER_ONLY = (who: string) => `--session is the owner's, from a terminal outside herdr; this call is ${who}`;
// The refusal for the right name, in the right session, on the wrong pane: the state records
// another pane for the seat, so that record is not this call's. No single owner command
// re-records it (round 4's runs: `up` and `add` bail on the record, `remove` is refused by the
// file's validation for the two names this can carry), so the repair named is the sequence that
// repairs every case: `team down`, then `team up` — see `the another-pane repair` below.
const ANOTHER_PANE = (name: string, pane: string) =>
  `the state records pane ${pane} for seat ${name} in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)`;

type Case = {
  name: string;
  run: (caller: Placement, argv?: string[], options?: { state?: Record<string, unknown> | null }) => Promise<Run>;
  // The refusal a caller that is not this team's sees, with the caller named as main named it.
  refusal: (who: string) => string;
  // The refusal for a caller of the right name and session the state records no pane for: the
  // cause, and the repair. For `answer` only the coordinator is ever a caller, so the operator
  // meets the ordinary refusal there instead of this line.
  noPane: (name: string) => string;
  // Whether this command's gate admits an operator seat caller: where it does, a state that
  // records no pane for that seat gives it the no-pane line; where it does not — `answer` judges
  // the coordinator alone, and the map's `down` row admits the owner and `leads` — the operator
  // meets its refusal, not for the missing pane but for being the operator.
  operatorAdmitted?: boolean;
  // Whether this command's gate admits a seat caller at all: where it does not — the map's `add`
  // row is the owner's alone in 0.5.0 — every scene below meets the ordinary refusal whatever
  // pane the caller sits on and whatever the state records, so no pane is ever the cause.
  seatAdmitted?: boolean;
  // The refusal for the seat's name in the seat's session, on any pane but the one the state
  // records for it: the recorded pane is named, and so is the repair.
  anotherPane: (name: string, pane: string) => string;
  // The refusal for a non-owner aiming `--session` elsewhere: the owner's flag alone.
  sessionOwner: (who: string) => string;
  // The refusal for a non-owner aiming `--file`: the owner's flag alone too, and the walk alone
  // decides it — before that file is read, and before anything is written beside it.
  fileOwner: (who: string) => string;
  // The owner's run: what the gate lets through, when nothing else refuses.
  owner: string;
};

const COMMANDS: Case[] = [
  {
    name: 'add',
    run: (caller, argv = [], options) => call((io) => runAdd(['probe-seat', ...argv], io, addSources()), caller, options),
    refusal: (who) => `team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is ${who}\n`,
    noPane: (name) => `team add: ${NO_PANE(name)}\n`,
    operatorAdmitted: false,
    seatAdmitted: false,
    anotherPane: (name, pane) => `team add: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team add: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team add: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    owner: '',
  },
  {
    name: 'remove',
    run: (caller, argv = [], options) => call((io) => runRemove([SEAT, ...argv], io, removeSources()), caller, options),
    refusal: (who) => `team remove: only the owner or \`leads\` removes a seat; this call is ${who}\n`,
    noPane: (name) => `team remove: ${NO_PANE(name)}\n`,
    operatorAdmitted: false,
    anotherPane: (name, pane) => `team remove: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team remove: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team remove: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    owner: '',
  },
  {
    name: 'worktree list',
    run: (caller, argv = [], options) =>
      call((io) => runWorktree(['list', ...argv], io, worktreeRefused()), caller, options),
    refusal: (who) => `team worktree: only the owner, the orchestrator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team worktree: ${NO_PANE(name)}\n`,
    anotherPane: (name, pane) => `team worktree: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team worktree: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team worktree: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'worktree new',
    run: (caller, argv = [], options) =>
      call((io) => runWorktree(['new', 'probe-task', ...argv], io, worktreeRefused()), caller, options),
    refusal: (who) => `team worktree: only the owner, the orchestrator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team worktree: ${NO_PANE(name)}\n`,
    anotherPane: (name, pane) => `team worktree: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team worktree: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team worktree: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'worktree remove',
    run: (caller, argv = [], options) =>
      call((io) => runWorktree(['remove', 'probe-task', ...argv], io, worktreeRefused()), caller, options),
    refusal: (who) => `team worktree: only the owner, the orchestrator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team worktree: ${NO_PANE(name)}\n`,
    anotherPane: (name, pane) => `team worktree: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team worktree: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team worktree: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'down',
    run: (caller, argv = [], options) => call((io) => runDown([...argv], io, downSources()), caller, options),
    refusal: (who) => `team down: only the owner or \`leads\` stops the team; this call is ${who}\n`,
    noPane: (name) => `team down: ${NO_PANE(name)}\n`,
    operatorAdmitted: false,
    anotherPane: (name, pane) => `team down: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team down: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team down: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    owner: 'team down: this call has no way to reach herdr\n',
  },
  {
    name: 'answer',
    run: (caller, argv = [], options) => call((io) => runAnswer([SEAT, 'trust', ...argv], io, answerHost()), caller, options),
    refusal: () => `${SEAT}: only the owner, or the orchestrator from its own seat, can answer\n`,
    noPane: (name) => `team answer: ${NO_PANE(name)}\n`,
    operatorAdmitted: false,
    anotherPane: (name, pane) => `team answer: ${ANOTHER_PANE(name, pane)}\n`,
    sessionOwner: (who) => `team answer: ${OWNER_ONLY(who)}\n`,
    fileOwner: (who) => `team answer: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`,
    // Answering a trust dialog is the owner's live team grant, not an approval: with the
    // fixture's no-grant home the owner meets the same policy refusal main does, and the file's
    // approval standing is no longer read for it.
    owner: `${SEAT}: use team up and [o] (dialogs.trust is off; only the owner can turn it on: team grant @team --capabilities dialogs.trust)\n`,
  },
];

const byName = (name: string): Case => {
  const found = COMMANDS.find((one) => one.name === name);
  if (!found) throw new Error(`no case named ${name}`);
  return found;
};

for (const command of COMMANDS) {
  describe(`${command.name}: who may change the team`, () => {
    test('a seat of another session is refused, named as its own session placed it', async () => {
      const run = await command.run(placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the operator of another session is refused the same way', async () => {
      const run = await command.run(placed(OTHER, OPERATOR, 'w4:p1'));
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(OPERATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a pane merely renamed, in the team\'s own session, is refused: the state records another pane', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, 'w9:p1'));
      // exit 1: <command>.another-pane, the case's own id (docs/reference/exit-codes.md). Where
      // the map admits no seat to the command at all (`add`), the renamed pane meets the ordinary
      // refusal like every other placement: no pane is ever the cause.
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({
        code: 1,
        out: '',
        err: command.seatAdmitted === false ? command.refusal(COORDINATOR) : command.anotherPane(COORDINATOR, COORDINATOR_PANE),
      });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    // The same seat, placed the way a command places its caller through the sources: the
    // record the state holds for it is the one read, and that record names another pane.
    test('the same caller placed through the sources meets the same another-pane refusal', async () => {
      const run = await command.run({ sources: sourcesOf(SESSION, COORDINATOR, 'w9:p1') });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({
        code: 1,
        out: '',
        err: command.seatAdmitted === false ? command.refusal(COORDINATOR) : command.anotherPane(COORDINATOR, COORDINATOR_PANE),
      });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the coordinator on its recorded pane is read exactly as main read it', async () => {
      const judged = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      // Handed in as a seat of its session: a caller that carries no session is refused once a
      // standing is asked for, so a readable caller names the session it stood in.
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    // The caller is placed through the fake caller sources, which answer for the session the
    // command asks them about — a command that drops the session it judges in reads an empty
    // agent list, places nobody, and this case fails.
    test('a caller placed through the sources of the team\'s own session is read as main read it', async () => {
      const judged = await command.run({ sources: sourcesOf(SESSION, COORDINATOR, COORDINATOR_PANE) });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    test('a state that records no pane refuses the coordinator: the cause and the repair', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), [], { state: null });
      // exit 1: <command>.no-pane, the case's own id (docs/reference/exit-codes.md); the map's
      // owner-only `add` row refuses a seat before any pane is read, so there the cause is the
      // rule, not the missing record.
      const err = command.seatAdmitted === false ? command.refusal(COORDINATOR) : command.noPane(COORDINATOR);
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a state that records no pane refuses the operator the same way', async () => {
      const run = await command.run(placed(SESSION, OPERATOR, 'w4:p1'), [], { state: null });
      // Where the gate does not admit an operator seat caller, it is refused for being the
      // operator, not for the missing pane: the line it meets is its ordinary refusal. The same
      // holds where no seat is admitted at all.
      const err = command.operatorAdmitted === false || command.seatAdmitted === false ? command.refusal(OPERATOR) : command.noPane(OPERATOR);
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a state that names another seat records no pane for the coordinator either', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), [], { state: TEMPORARY_STATE });
      const err = command.seatAdmitted === false ? command.refusal(COORDINATOR) : command.noPane(COORDINATOR);
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a pane the state records for another seat is no standing either', async () => {
      // The caller sits on `w3:p1`, the pane the state records for codex-acme; the name it
      // holds has no record. Another seat's pane is not this seat's.
      const run = await command.run(placed(SESSION, COORDINATOR, 'w3:p1'), [], { state: TEMPORARY_STATE });
      const err = command.seatAdmitted === false ? command.refusal(COORDINATOR) : command.noPane(COORDINATOR);
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    // The fixture is v0.2.1's own state shape (see STATE_021): if the release had not recorded
    // the pane in the field the gate reads, `judged` would be the no-pane refusal while `main`
    // passed, and the two sides would differ.
    test('a v0.2.1 state places the coordinator as main did: nothing breaks on upgrade', async () => {
      const judged = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), [], { state: STATE_021 });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION }, [], { state: STATE_021 });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    test('--session is the owner\'s: a seat aiming the check elsewhere is refused', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--session', OTHER]);
      // exit 1: <command>.session-owner, the case's own id (docs/reference/exit-codes.md).
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.sessionOwner(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    // The same refusal through the sources a real run reads: decided by the walk alone, so it
    // names no seat — placing the caller would read a session, and that is what must not happen.
    // The fixture answers the flag's session, so a run that judges with the flag before it
    // refuses records a call below and fails; `down` would also reach `currentTeam`, which
    // writes its `last_valid` into the state, and the state bytes are that regression's probe.
    test('a non-owner aiming --session is refused at once, before that session is read', async () => {
      const calls: string[] = [];
      const run = await command.run(
        { sources: recordingSources(calls, OTHER, COORDINATOR, COORDINATOR_PANE) },
        ['--session', OTHER],
      );
      // exit 1: <command>.session-owner, the case's own id (docs/reference/exit-codes.md).
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({
        code: 1,
        out: '',
        err: command.sessionOwner('unplaced (it runs under herdr)'),
      });
      // The ordered host calls that name that session: none at all.
      expect(calls).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(run.before);
      // No state write either.
      expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
      const log = join(dir, '.agents', 'team.log');
      // The refusal's own line only: `answer` writes one, the other five write none at all.
      if (command.name === 'answer') {
        const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
        expect(lines.length).toBe(1);
        expect(lines[0]!.endsWith(`answer [unplaced] ${SEAT}: refused trust: caller`)).toBe(true);
      } else {
        expect(existsSync(log)).toBe(false);
      }
    });

    test('the owner may aim --session: the gate lets it through', async () => {
      const flagged = await command.run({ kind: 'owner' }, ['--session', OTHER]);
      const plain = await command.run({ kind: 'owner' });
      expect({ code: flagged.code, out: flagged.out, err: flagged.err }).toEqual({ code: plain.code, out: plain.out, err: plain.err });
    });

    test('a temporary seat is no coordinator', async () => {
      const run = await command.run(placed(SESSION, SEAT, 'w3:p1'), [], { state: TEMPORARY_STATE });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(SEAT) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a pane without an agent is no coordinator', async () => {
      const run = await command.run(placed(SESSION, null, 'w7:p1'));
      expect(run.code).toBe(1);
      expect(run.err).toContain('it runs in pane w7:p1, whose agent has no herdr name');
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the owner is read as main read it', async () => {
      const run = await command.run({ kind: 'owner' });
      if (command.name === 'remove') {
        // The store holds an approval in force for this caller: the owner's removal runs.
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 0, out: `removed ${SEAT}\n`, err: '' });
        return;
      }
      if (command.name === 'add') {
        // probe-seat is not in the file. That refusal comes before trust or the approval record.
        expect(run.code).toBe(1);
        expect(run.out).toBe('');
        expect(run.err).toBe('team add: the file has no seat "probe-seat"\n');
        expect(run.err).not.toContain('never approved');
        expect(readFileSync(file, 'utf8')).toBe(run.before);
        return;
      }
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.owner });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the owner is unaffected by a state that records no pane', async () => {
      const run = await command.run({ kind: 'owner' }, [], { state: null });
      if (command.name === 'remove') {
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 0, out: `removed ${SEAT}\n`, err: '' });
        return;
      }
      if (command.name === 'add') {
        expect(run.code).toBe(1);
        expect(run.out).toBe('');
        expect(run.err).toBe('team add: the file has no seat "probe-seat"\n');
        expect(run.err).not.toContain('never approved');
        return;
      }
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.owner });
    });
  });
}

// `--file` is the owner's, and the walk alone decides it, for every command that takes the flag:
// the five commands, `worktree list`, `worktree new`, `worktree remove`, and the dry runs. A non-owner's flag is
// refused before that file is read, so the refusal depends on nothing stored at the flagged path
// — not its bytes, not its problems, not the session it names. The flagged project below is
// another one entirely: a run that read its file would report the file's own problem, ask the
// host about the session it names, and could leave its `last_valid` or a log line beside it. The
// refusal has none of that.

// The states a flagged path stands in, one test each: no file at all, an unparsable file, a valid
// team file, a folder, an unreadable file. The refusal is the same bytes and the same exit in all
// five. The unreadable one is sealed after its bytes are captured, and opened again before they
// are read back.
const FLAGGED_STATES: { name: string; setUp: (path: string) => void; seal?: (path: string) => void; open?: (path: string) => void }[] = [
  { name: 'missing', setUp: () => {} },
  { name: 'unparsable', setUp: (path) => writeFileSync(path, 'format: [\n') },
  { name: 'valid', setUp: (path) => writeFileSync(path, FILE) },
  { name: 'a folder', setUp: (path) => mkdirSync(path) },
  { name: 'unreadable', setUp: (path) => writeFileSync(path, FILE), seal: (path) => chmodSync(path, 0o000), open: (path) => chmodSync(path, 0o600) },
];

function flaggedProject(stateName = 'unparsable'): {
  root: string;
  file: string;
  listing: () => string[];
  bytes: () => string | null;
  seal: () => void;
  open: () => void;
  cleanup: () => void;
} {
  const state = FLAGGED_STATES.find((one) => one.name === stateName);
  if (!state) throw new Error(`no flagged state named ${stateName}`);
  const root = mkdtempSync(join(tmpdir(), 'team-flagged-'));
  mkdirSync(join(root, '.agents'));
  const flagged = join(root, '.agents', 'team.yaml');
  state.setUp(flagged);
  return {
    root,
    file: flagged,
    listing: () => readdirSync(join(root, '.agents')).sort(),
    bytes: () => {
      try {
        return readFileSync(flagged, 'utf8');
      } catch {
        return null;
      }
    },
    seal: () => state.seal?.(flagged),
    open: () => state.open?.(flagged),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// The one rule, run against one surface and one state of the flagged path: the walk refuses the
// flag before the file is read, no host call is made, and neither project moves.
async function refusedBeforeRead(surface: Case, argv: string[], stateName: string): Promise<void> {
  const flagged = flaggedProject(stateName);
  try {
    const beforeListing = flagged.listing();
    const beforeBytes = flagged.bytes();
    flagged.seal();
    const calls: string[] = [];
    const run = await surface.run(
      { sources: recordingSources(calls, OTHER, COORDINATOR, COORDINATOR_PANE) },
      ['--file', flagged.file, ...argv],
    );
    flagged.open();
    // exit 1: <command>.file-owner, the case's own id (docs/reference/exit-codes.md).
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 1,
      out: '',
      err: surface.fileOwner('unplaced (it runs under herdr)'),
    });
    // No session and no pane: the fixture would answer, and nothing asks — the state's bytes
    // never reach this run, however valid they are.
    expect(calls).toEqual([]);
    // The flagged project is untouched, whatever state its path is in.
    expect(flagged.listing()).toEqual(beforeListing);
    expect(flagged.bytes()).toBe(beforeBytes);
    // And nothing of this run's own project either: no file, no state, no log line.
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
  } finally {
    flagged.cleanup();
  }
}

for (const command of COMMANDS) {
  describe(`${command.name}: --file is the owner's`, () => {
    test('a non-owner\'s --file is refused before the file is read', async () => {
      const flagged = flaggedProject();
      try {
        const before = flagged.listing();
        const run = await command.run(placed(OTHER, COORDINATOR, COORDINATOR_PANE), ['--file', flagged.file]);
        // exit 1: <command>.file-owner, the case's own id (docs/reference/exit-codes.md).
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({
          code: 1,
          out: '',
          err: command.fileOwner(COORDINATOR),
        });
        // Not read, either: the file is unparseable, and no problem of its own is reported.
        expect(flagged.listing()).toEqual(before);
        expect(readFileSync(flagged.file, 'utf8')).toBe('format: [\n');
        // Nothing written in this run's own project: no log line even where a refusal without
        // `--file` writes one (`answer` logs its caller refusals beside the team file; `down`
        // logs nothing at all).
        expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe(run.before);
        expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
      } finally {
        rmSync(flagged.root, { recursive: true, force: true });
      }
    });

    // The same refusal through the sources a real run reads: decided by the walk alone, so no
    // session and no pane is read — the fixture answers every session a command could ask
    // about, and nothing asks.
    test('the walk alone refuses it: no session, state or file is read', async () => {
      const flagged = flaggedProject();
      try {
        const before = flagged.listing();
        const calls: string[] = [];
        const run = await command.run(
          { sources: recordingSources(calls, OTHER, COORDINATOR, COORDINATOR_PANE) },
          ['--file', flagged.file],
        );
        // exit 1: <command>.file-owner, the case's own id (docs/reference/exit-codes.md).
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({
          code: 1,
          out: '',
          err: command.fileOwner('unplaced (it runs under herdr)'),
        });
        expect(calls).toEqual([]);
        expect(flagged.listing()).toEqual(before);
        expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe(run.before);
        expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
      } finally {
        rmSync(flagged.root, { recursive: true, force: true });
      }
    });

    test('--file with --session: the file is refused first', async () => {
      const flagged = flaggedProject();
      try {
        const before = flagged.listing();
        const run = await command.run(placed(OTHER, COORDINATOR, COORDINATOR_PANE), [
          '--file',
          flagged.file,
          '--session',
          OTHER,
        ]);
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({
          code: 1,
          out: '',
          err: command.fileOwner(COORDINATOR),
        });
        expect(flagged.listing()).toEqual(before);
      } finally {
        rmSync(flagged.root, { recursive: true, force: true });
      }
    });

    test('the owner may aim --file: the gate lets it through', async () => {
      const flagged = await command.run({ kind: 'owner' }, ['--file', file]);
      const plain = await command.run({ kind: 'owner' });
      expect({ code: flagged.code, out: flagged.out, err: flagged.err }).toEqual({ code: plain.code, out: plain.out, err: plain.err });
    });

    // The same bytes and the same exit whatever is at the flagged path: a missing file, an
    // unparsable one and a valid one answer alike — no `no team file at …`, no YAML problem, no
    // host call about the session the valid one names.
    for (const state of FLAGGED_STATES) {
      test(`a non-owner's --file is refused before the file is read: the flagged path is ${state.name}`, async () => {
        await refusedBeforeRead(command, [], state.name);
      });
    }
  });
}

// The dry runs refuse the same way, and before the plan they would print: the flag is the
// walk's, not the run the plan describes.
describe('the dry runs: --file is the owner\'s', () => {
  const surfaces = [
    { label: 'add --dry-run', surface: byName('add'), argv: ['--dry-run'] },
    { label: 'down --dry-run', surface: byName('down'), argv: ['--dry-run'] },
  ];
  for (const { label, surface, argv } of surfaces) {
    for (const state of FLAGGED_STATES) {
      test(`${label}: a non-owner's --file is refused before the file is read, the flagged path ${state.name}`, async () => {
        await refusedBeforeRead(surface, argv, state.name);
      });
    }
  }
});

// The reported run, as a regression: a pane in another herdr session, renamed to the
// coordinator's name, running `team remove codex-acme`. It removes nothing, stops nothing and
// leaves both the file and the state byte-identical.
describe('the renamed pane in another session', () => {
  test('remove leaves the team file byte-identical and exits 1', async () => {
    const run = await call((io) => runRemove([SEAT], io, removeSources()), placed(OTHER, COORDINATOR, COORDINATOR_PANE));
    expect(run.code).toBe(1);
    expect(run.out).toBe('');
    expect(run.err).toBe(`team remove: only the owner or \`leads\` removes a seat; this call is ${COORDINATOR}\n`);
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });

  // The same call, aiming the check at the session that pane lives in. `--session` is the
  // owner's, so this is refused too — the binding cannot be defeated by choosing the session.
  test('remove --session <that session> removes nothing and exits 1', async () => {
    const run = await call(
      (io) => runRemove([SEAT, '--session', OTHER], io, removeSources()),
      placed(OTHER, COORDINATOR, COORDINATOR_PANE),
    );
    expect(run.code).toBe(1);
    expect(run.out).toBe('');
    expect(run.err).toBe(`team remove: ${OWNER_ONLY(COORDINATOR)}\n`);
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });
});

// The sessions the check will try are this project's own state's, one key at a time: a session
// no key of it records grants no standing — whatever a host would answer — and a state outside
// this project is never read. (The positive side, a session this project's state does record, is
// `a team run under another session` below: the same state, in this project's own `.agents`, is
// what lets that caller through.)
describe('the sessions the check lets in', () => {
  test('a session this project\'s state does not record grants no standing', async () => {
    // This project's state records `acme-web` alone; the fixture host would list the caller in
    // `other-web` if anything asked it about that session, and nothing does. The caller is not
    // placed at all, and the refusal names it without a seat's name.
    const run = await byName('remove').run({ sources: sourcesOf(OTHER, COORDINATOR, COORDINATOR_PANE) });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 1,
      out: '',
      err: byName('remove').refusal('unplaced (it runs in a herdr pane without an agent)'),
    });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('another project\'s state is never read: its session grants no standing here', async () => {
    // A second project holds a state that records this very caller's pane under `other-web`.
    // This run's project holds only `acme-web`, and the run is the refused one above, unchanged:
    // the state read is the one beside the team file being judged, never a state elsewhere.
    const elsewhere = mkdtempSync(join(tmpdir(), 'team-elsewhere-'));
    try {
      mkdirSync(join(elsewhere, '.agents'));
      writeFileSync(
        join(elsewhere, '.agents', 'team.state.json'),
        `${JSON.stringify(
          { format: 1, sessions: { [OTHER]: { seats: { [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE } }, worktrees: {} } } },
          null,
          2,
        )}\n`,
      );
      const run = await byName('remove').run({ sources: sourcesOf(OTHER, COORDINATOR, COORDINATOR_PANE) });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({
        code: 1,
        out: '',
        err: byName('remove').refusal('unplaced (it runs in a herdr pane without an agent)'),
      });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// The dry runs fail the same way as the real runs, and explain instead of refusing bare: `add`
// prints its `! add would refuse:` line and the unblocking command, and `down` prints a refusal
// the plan stage found over the plan, each exiting as the real run.
describe('a dry run of the no-pane refusal', () => {
  test('add --dry-run explains the gate\'s refusal and exits 1: the gate sits before the dry run', async () => {
    // The map's owner-only `add` row refuses a seat before any pane is read, so the state that
    // records nothing is not the cause here: the line is the caller gate's own, said beside the
    // dry answer instead of a plan.
    const run = await byName('add').run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--dry-run'], { state: null });
    expect({ code: run.code, err: run.err }).toEqual({ code: 1, err: '' });
    expect(run.out).toContain(`! add would refuse: ${byName('add').refusal(COORDINATOR).replace(/^team add: /, '').trimEnd()}`);
    expect(run.out).toContain('! to unblock:');
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('down --dry-run prints the refusal as a would-refuse line and the plan, and exits 1', async () => {
    const run = await byName('down').run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--dry-run'], { state: null });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 1,
      // The state records nothing, so the plan is the session alone: no seat is left to skip.
      out:
        `! down would refuse: ${NO_PANE(COORDINATOR)}\n` +
        `+ herdr session stop ${SESSION}\n` +
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)\n' +
        'dry run: nothing was run\n',
      err: '',
    });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('down --dry-run from a non-owner aiming --session: the refusal itself, that session unread', async () => {
    // The plan a dry run prints would be that session's, so aiming it is not the caller's to do:
    // the refusal is the walk's, before the plan is built. Nothing of the flag's session is read
    // — not the session's running state, not its agents, not its panes — so the dry run cannot
    // leak its plan either.
    const calls: string[] = [];
    const run = await call(
      (io) =>
        runDown(['--dry-run', '--session', OTHER], io, downSources({
          sessionRunning: (which) => {
            calls.push(`sessionRunning(${which})`);
            return true;
          },
          agents: (which) => {
            calls.push(`agents(${which})`);
            return [];
          },
        })),
      { sources: recordingSources(calls, OTHER, COORDINATOR, COORDINATOR_PANE) },
    );
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 1,
      out: '',
      err: `team down: ${OWNER_ONLY('unplaced (it runs under herdr)')}\n`,
    });
    expect(calls).toEqual([]);
    expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
  });
});

// The host `up` drives, counted: over a state where every seat is ready and live, and over the
// refusal of the one it can't touch, none of these may be called. The shape is
// test/commands/live.test.ts's world(), trimmed to what these two runs can reach.
function upHost(): { counts: Record<'starts' | 'creates' | 'runs' | 'renames' | 'closes', number>; launch: Launch } {
  const counts = { starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 };
  const launch: Launch = {
    sessionState: () => 'running',
    startServer() {
      counts.starts++;
      return true;
    },
    sessionUp: () => true,
    createWorkspace() {
      counts.creates++;
      return null;
    },
    paneRun() {
      counts.runs++;
      return false;
    },
    renameAgent() {
      counts.renames++;
      return false;
    },
    closeWorkspace() {
      counts.closes++;
      return false;
    },
    agentPanes: () => [],
    // Never read: no run over these worlds plans a repair, and only a repair reads this list.
    agents: () => [],
    paneText: () => null,
    foreground: () => null,
    sleep: async () => {},
    now: () => new Date(0),
  };
  return { counts, launch };
}

function upSources(over: Partial<UpSources> = {}): UpSources {
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    home,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => new Date(0),
      home,
    },
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }),
    now: () => new Date(0),
    sleep: async () => {},
    alive: () => false,
    ...over,
  };
}

const SEEDED_BRIEFS = {
  [COORDINATOR]: {
    id: generalBriefId('inc_000000000001', generalBriefBody()),
    at: '2026-10-04T09:00:00.000Z',
    incarnation: 'inc_000000000001',
    epoch: 'run_000000000001',
    sha256: GENERAL_BRIEF_SHA256,
    attempt: 0,
    stage: 'ready' as const,
  },
  [OPERATOR]: {
    id: generalBriefId('inc_000000000002', generalBriefBody()),
    at: '2026-10-04T09:00:00.000Z',
    incarnation: 'inc_000000000002',
    epoch: 'run_000000000002',
    sha256: GENERAL_BRIEF_SHA256,
    attempt: 0,
    stage: 'ready' as const,
  },
  [SEAT]: {
    id: generalBriefId('inc_000000000003', generalBriefBody()),
    at: '2026-10-04T09:00:00.000Z',
    incarnation: 'inc_000000000003',
    epoch: 'run_000000000003',
    sha256: GENERAL_BRIEF_SHA256,
    attempt: 0,
    stage: 'ready' as const,
  },
};

// The owner's one command after upgrading: a team brought up by v0.2.1 runs on, seat by seat,
// and `up` disturbs nothing — the state records every pane, the coordinator's included.
describe('up over the v0.2.1 state', () => {
  const UP_STATE_021 = {
    ...STATE_021,
    sessions: {
      [SESSION]: { ...STATE_021.sessions[SESSION], briefs: SEEDED_BRIEFS },
    },
  };

  test('every seat is left as it is, and nothing is started, closed or renamed', async () => {
    writeFileSync(stateFile, `${JSON.stringify(UP_STATE_021, null, 2)}\n`);
    const { counts, launch } = upHost();
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--file', '.agents/team.yaml'],
      io,
      upSources({
        agents: () => [
          runningAgent(COORDINATOR, COORDINATOR_PANE),
          runningAgent(OPERATOR, 'w2:p1'),
          runningAgent(SEAT, 'w3:p1'),
        ],
        workspaces: () => [{ id: 'w1', label: 'claude opus 5.5' }, { id: 'w2', label: 'gpt sol 6' }, { id: 'w3', label: 'deepseek flash v4.1' }],
        // The watch the 0.2.1 state records is alive; `up` leaves it alone too.
        alive: (pid) => pid === 4242,
        launch,
      }),
    );
    expect(code).toBe(0);
    // One final record per seat: a seat that was already ready is `ready`, and the words the
    // skip line carried are the detail under the record, on stderr. The 0.2.1 state records no
    // process identity, so each detail names the one per-seat register run that records it; the
    // seat itself is still left exactly as it is. What this test is about — nothing is started,
    // closed or renamed — is the state and `counts` below.
    expect(io.out).toBe(
      `${COORDINATOR}: ready\n` +
        `${OPERATOR}: ready\n` +
        `${SEAT}: ready\n`,
    );
    expect(io.err).toBe(
      '  already ready; left as it is; its process was never recorded: ' +
        `run team register ${COORDINATOR} to record it, nothing relaunched\n` +
        '  already ready; left as it is; its process was never recorded: ' +
        `run team register ${OPERATOR} to record it, nothing relaunched\n` +
        '  already ready; left as it is; its process was never recorded: ' +
        `run team register ${SEAT} to record it, nothing relaunched\n` +
        '0 seats repaired, 0 skipped (working), 0 refused\n',
    );
    expect(counts).toEqual({ starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 });
    expect(readFileSync(stateFile, 'utf8')).toBe(`${JSON.stringify(UP_STATE_021, null, 2)}\n`);
  });

  // The hole the refusal text stands on: while the unrecorded seat's pane is live, no owner
  // command records it — `up` refuses to touch a running team. This is the run that proves the
  // stop the repair names has to come first.
  test('a live agent the state does not record refuses up: that seat is stopped first', async () => {
    writeFileSync(stateFile, `${JSON.stringify(TEMPORARY_STATE, null, 2)}\n`);
    const { counts, launch } = upHost();
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--file', '.agents/team.yaml'],
      io,
      upSources({ agents: () => [runningAgent(COORDINATOR, COORDINATOR_PANE)], launch }),
    );
    expect(code).toBe(1);
    expect(io.err).toBe(
      `team up: session ${SESSION} has 1 agent this file's state doesn't record: \`up\` never touches a running team\n`,
    );
    expect(counts).toEqual({ starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 });
    expect(readFileSync(file, 'utf8')).toBe(fileText);
    expect(readFileSync(stateFile, 'utf8')).toBe(`${JSON.stringify(TEMPORARY_STATE, null, 2)}\n`);
  });
});

// The panes a force-close leaves behind. A non-owner's `remove` leaves its seat's pane running
// and renames the agent out of the seat's name — `<name>-left`, then `-left-2`, `-left-3`, … —
// and the base may no longer be a seat the file declares. The gate above must skip that family
// (it is nobody's unrecorded seat) while every other name still refuses, byte for byte.
describe('up and the panes a force-close leaves behind', () => {
  // The recorded world every run below shares: the state above, plus the watch record the
  // session needs — alive in the fakes, so `up` leaves it alone (the v0.2.1 run's own shape) and
  // the gate is the only thing a walked-past run can still refuse on. `extras` is what the case
  // under test adds beyond the three recorded agents.
  const WATCHED = {
    ...STATE,
    sessions: {
      [SESSION]: {
        ...STATE.sessions[SESSION],
        watch: { pid: 4242, heartbeat: '2026-10-04T09:00:00.000Z' },
        briefs: SEEDED_BRIEFS,
      },
    },
  };

  async function upOver(extras: HerdrAgent[]): Promise<{
    code: number;
    io: TestIo;
    counts: Record<'starts' | 'creates' | 'runs' | 'renames' | 'closes', number>;
  }> {
    writeFileSync(stateFile, `${JSON.stringify(WATCHED, null, 2)}\n`);
    const { counts, launch } = upHost();
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--file', '.agents/team.yaml'],
      io,
      upSources({
        agents: () => [
          runningAgent(COORDINATOR, COORDINATOR_PANE),
          runningAgent(OPERATOR, 'w4:p1'),
          runningAgent(SEAT, 'w3:p1'),
          ...extras,
        ],
        alive: (pid) => pid === 4242,
        launch,
      }),
    );
    return { code, io, counts };
  }

  test('a leftover agent (and its `-left-3` collision shape) is skipped: up goes on', async () => {
    const { code, io, counts } = await upOver([
      runningAgent('reviewer-x-left', 'w9:p1'),
      runningAgent('reviewer-x-left-3', 'w9:p2'),
    ]);
    expect(code).toBe(0);
    expect(io.out).toBe(
      `${COORDINATOR}: ready\n` +
        `${OPERATOR}: ready\n` +
        `${SEAT}: ready\n`,
    );
    expect(io.err).not.toContain("doesn't record");
    expect(counts).toEqual({ starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 });
    expect(readFileSync(stateFile, 'utf8')).toBe(`${JSON.stringify(WATCHED, null, 2)}\n`);
  });

  test('an unrecorded agent outside the family still refuses, byte for byte', async () => {
    const { code, io, counts } = await upOver([runningAgent('reviewer-x', 'w9:p1')]);
    expect(code).toBe(1);
    expect(io.err).toBe(
      `team up: session ${SESSION} has 1 agent this file's state doesn't record: \`up\` never touches a running team\n`,
    );
    expect(counts).toEqual({ starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 });
    expect(readFileSync(file, 'utf8')).toBe(fileText);
    expect(readFileSync(stateFile, 'utf8')).toBe(`${JSON.stringify(WATCHED, null, 2)}\n`);
  });

  test('a `-left-1` name is not one the mint produces: refused the same way', async () => {
    const { code, io } = await upOver([runningAgent('reviewer-x-left-1', 'w9:p1')]);
    expect(code).toBe(1);
    expect(io.err).toBe(
      `team up: session ${SESSION} has 1 agent this file's state doesn't record: \`up\` never touches a running team\n`,
    );
  });
});

// remove stops a seat and edits the file. A missing record is the live file. A legacy record
// or one the verification refused still does neither.
describe('remove and a record that is not in force', () => {
  const CASES: { name: string; sources: () => RemoveSources; why: string }[] = [
    {
      name: 'a legacy record',
      sources: () => removeSources({ standing: () => ({ kind: 'legacy' }) }),
      why: 'team remove: approved before records were signed\n',
    },
    {
      name: 'a record the verification refused',
      sources: () => removeSources({ standing: () => ({ kind: 'refused', why: 'the record does not carry a valid signature' }) }),
      why: 'team remove: the record does not carry a valid signature\n',
    },
  ];

  for (const one of CASES) {
    test(`${one.name}: refused, with the file and the state untouched`, async () => {
      const run = await call((io) => runRemove([SEAT], io, one.sources()), { kind: 'owner' });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: one.why });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
      expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    });
  }

  test('a missing record does not refuse, and the seat leaves the file', async () => {
    const run = await call((io) => runRemove([SEAT], io, removeSources({ home: emptyHome })), { kind: 'owner' });
    expect(run.err).not.toContain('never approved');
    expect(run.code).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain(`name: ${SEAT}`);
  });
});

// The idle screen a launched seat shows: what `up` reads to call it ready. Each CLI's own —
// `readScreen` classifies by the seat's CLI, so the codex seat gets the codex fixture, with its
// composer line naming the model and version the team file declares.
const IDLE = CLAUDE_IDLE;
const CODEX_IDLE = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8').replace(
  'GPT-5.6-Terra medium ·',
  'GPT-6-Sol medium ·',
);

// The codex pane with typed text, in the registered unsent capture's shape: the pane's own
// header and warning rows, the typed rows under its prompt, the box's blank frame row, then the
// footer the model is read from. A first-message seat's rules are typed into it, so every row
// below the prompt is one line of the rules.
const CODEX_UNSENT = readFileSync(new URL('../fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8').replace(
  'GPT-5.6-Terra medium ·',
  'GPT-6-Sol medium ·',
);
const CODEX_HEAD = CODEX_UNSENT.split('\n').slice(0, 14);
const CODEX_FOOT = CODEX_UNSENT.split('\n')[19] ?? '';

function codexTyped(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  return [...CODEX_HEAD, `› ${first}`, ...rest.map((line) => `  ${line}`), '', CODEX_FOOT, ''].join('\n');
}

// A herdr that starts: every workspace gets its own pane, and the panes `up` handed out are
// listed back to it with a running agent in each.
function launching(): Launch {
  let n = 0;
  let running = false;
  const panes = new Map<string, { text: string; agent: boolean; cli: string; status: string }>();
  return {
    sessionState: () => (running ? 'running' : 'absent'),
    startServer() {
      running = true;
      return true;
    },
    sessionUp: () => running,
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: IDLE, agent: false, cli: 'claude', status: 'idle' });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      const known = panes.get(pane);
      if (known) {
        known.agent = true;
        known.cli = command.includes('codex') ? 'codex' : 'claude';
        known.text = known.cli === 'codex' ? CODEX_IDLE : IDLE;
      }
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, one]) => one.agent).map(([id]) => id),
    // Never read: these runs launch into a fresh session, so no repair is ever planned.
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    // The codex seat's rules are its first message: typing shows them in its composer, and the
    // Enter that sends them leaves the pane idle and working, as the registered captures show.
    // The claude seats take their rules as a launch option, so nothing is ever typed into them.
    typeText: (_session, pane, text) => {
      const known = panes.get(pane);
      if (!known) return false;
      known.text = known.cli === 'codex' ? codexTyped(text) : IDLE;
      return true;
    },
    pressEnter: (_session, pane) => {
      const known = panes.get(pane);
      if (!known) return false;
      known.text = known.cli === 'codex' ? CODEX_IDLE : IDLE;
      known.status = 'working';
      return true;
    },
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => [panes.get(pane)?.cli ?? 'claude'],
    sleep: async () => {},
    now: () => new Date(0),
  };
}

type UpState = {
  sessions: Record<string, { seats: Record<string, { pane?: string; stage?: string }>; worktrees: Record<string, unknown> }>;
};

// A team the owner started under another session: `team up --session <name>` writes its state
// under that session — the file names one session, the team runs under another — and the seats
// `up` started must still stand in every command, with no flag. Which session a caller is
// judged in comes from the caller's own placement and the state `up` wrote for it; `--session`
// stays the owner's own.
describe('a team run under another session', () => {
  // The real `up`, in-process on a fake host (never a real herdr), under the overridden session.
  // Returns the state it wrote and the pane it recorded for the coordinator's seat.
  async function upUnderOther(): Promise<{ state: UpState; pane: string }> {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--session', OTHER],
      io,
      upSources({ sessionRunning: () => false, sessionState: () => 'absent', launch: launching() }),
    );
    if (code !== 0) throw new Error(`the up run failed: ${io.err}${io.out}`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as UpState;
    const pane = state.sessions[OTHER]?.seats[COORDINATOR]?.pane;
    if (typeof pane !== 'string') throw new Error('up recorded no pane');
    return { state, pane };
  }

  for (const command of COMMANDS) {
    // The seat `up` started, placed through the fake caller sources on the pane the state
    // records — and the same caller handed in as a seat of that session, the way main read it —
    // meet the same run.
    test(`${command.name}: the coordinator's caller of that session passes, read as main read it`, async () => {
      const { state, pane } = await upUnderOther();
      const judged = await command.run({ sources: sourcesOf(OTHER, COORDINATOR, pane) }, [], { state });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane, session: OTHER }, [], { state });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });
  }

  test('down with no flag stops the session the team actually runs under', async () => {
    const { state, pane } = await upUnderOther();
    const run = await byName('down').run({ sources: sourcesOf(OTHER, COORDINATOR, pane) }, ['--dry-run'], { state });
    expect(run.code).toBe(0);
    expect(run.out).toContain(`+ herdr session stop ${OTHER}\n`);
  });

  test('a caller on a pane the state records for no one in that session: the no-pane refusal', async () => {
    const { state, pane } = await upUnderOther();
    delete state.sessions[OTHER]?.seats[COORDINATOR];
    const run = await byName('remove').run({ sources: sourcesOf(OTHER, COORDINATOR, pane) }, [], { state });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: byName('remove').noPane(COORDINATOR) });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });

  test('a caller on another pane of that session: the another-pane refusal, and the file untouched', async () => {
    // The state records the coordinator's seat of that session on the pane `up` launched it on;
    // the caller sits elsewhere. The name and the session are right, the pane is not, and the
    // refusal names both the record and the repair.
    const { state, pane } = await upUnderOther();
    const run = await byName('remove').run({ sources: sourcesOf(OTHER, COORDINATOR, 'w9:p1') }, [], { state });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 1,
      out: '',
      err: byName('remove').anotherPane(COORDINATOR, pane),
    });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });

  test('a caller placed in the file\'s own session is refused: that state records nothing', async () => {
    const { state } = await upUnderOther();
    const run = await byName('remove').run({ sources: sourcesOf(SESSION, COORDINATOR, COORDINATOR_PANE) }, [], { state });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: byName('remove').noPane(COORDINATOR) });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('unless the file\'s own session records the pane too', async () => {
    const { state } = await upUnderOther();
    state.sessions[SESSION] = { seats: { [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE } }, worktrees: {} };
    const judged = await byName('remove').run({ sources: sourcesOf(SESSION, COORDINATOR, COORDINATOR_PANE) }, [], { state });
    const main = await byName('remove').run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION }, [], { state });
    expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    expect(judged.code).toBe(0);
  });
});

// The another-pane repair, run the way the refusal names it. The state records the coordinator's
// seat on `w1:p1`; the seat is live on another pane (`live`), gone with the recorded pane still
// there (`gone`), or gone with that pane closed too (`pane-gone`). `team up` alone repairs only
// the last (`herdr no longer shows this seat on its recorded pane; nothing closed` where the
// record can still be read), which is why the line names the sequence and not `up`: `team down`,
// then `team up` — the stop clears the session and its records, the start launches the seat again
// on a fresh pane, and the caller standing on that pane passes the gate. (The runs behind
// src/caller.ts's anotherPaneRefusal.) `no-pane` is the same world with no record at all, for
// the no-pane line: `up` refuses while the seat runs, launches it once the owner stops it.
type RepairCase = 'live' | 'gone' | 'pane-gone' | 'no-pane';

function repairWorld(kase: RepairCase): { down: DownSources; up: UpSources; stopSeat: () => void } {
  let running = true;
  const panes = new Map<string, { cli: string; live: boolean; sent: boolean }>();
  if (kase === 'live' || kase === 'no-pane') panes.set('w9:p1', { cli: 'claude', live: true, sent: false });
  if (kase !== 'no-pane') panes.set('w4:p1', { cli: 'claude', live: true, sent: false });
  if (kase === 'live' || kase === 'gone') panes.set('w1:p1', { cli: 'claude', live: false, sent: false });
  const rows = (): HerdrAgent[] =>
    [...panes]
      .filter(([, one]) => one.live)
      .map(([pane]) => runningAgent(pane === 'w9:p1' ? COORDINATOR : OPERATOR, pane));
  const down: DownSources = {
    sessionRunning: () => running,
    agents: () => rows(),
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    // The pane's box, physically: the empty box at the prompt, the typed text after a typing,
    // empty again after the one clearing key.
    screenText: (_session, pane) => claudeBox(panes.get(pane)?.sent ? '/exit' : ''),
    status: () => 'idle',
    // A stopped pane falls back to its shell, so the stop's wait sees the seat leave.
    foreground: (_session, pane) => (panes.get(pane)?.live ? [panes.get(pane)?.cli ?? 'claude'] : []),
    now: () => new Date(0),
    home,
    launch: {
      typeText: (_session, pane, text) => {
        const one = panes.get(pane);
        if (!one?.live) return false;
        one.sent = text === '/exit';
        return true;
      },
      sendKey: (_session, pane) => {
        const one = panes.get(pane);
        if (one) one.sent = false;
        return true;
      },
      pressEnter: (_session, pane) => {
        const one = panes.get(pane);
        if (!one?.sent) return false;
        one.live = false;
        return true;
      },
      agentPanes: () => [...panes].filter(([, one]) => one.live).map(([pane]) => pane),
      closeWorkspace: (_session, workspace) => {
        for (const [pane] of [...panes]) if (pane.startsWith(`${workspace}:`)) panes.delete(pane);
        return true;
      },
      stopSession: () => {
        running = false;
        return true;
      },
      deleteSession: () => {
        panes.clear();
        return true;
      },
      kill: () => false,
      sleep: async () => {},
      now: () => new Date(0),
    },
  };
  const fresh = launching();
  const launch: Launch = {
    ...fresh,
    startServer: () => {
      running = true;
      return fresh.startServer(SESSION);
    },
  };
  const up = upSources({
    sessionRunning: () => running,
    sessionState: () => (running ? 'running' : 'absent'),
    agents: () => rows(),
    workspaces: () => [],
    launch,
  });
  return {
    down,
    up,
    stopSeat: () => {
      const one = panes.get('w9:p1');
      if (one) one.live = false;
    },
  };
}

// The caller as the gate reads it after the sequence: the coordinator's seat, standing on the
// pane the state recorded for it. A dry run exits 0 either way, so the gate's reading is the
// refusal line the plan run carries.
async function gateRun(world: { down: DownSources }, pane: string): Promise<{ code: number; out: string }> {
  const io = testIo(dir, { kind: 'seat', name: COORDINATOR, pane, session: SESSION });
  return { code: await runDown(['--dry-run'], io, world.down), out: io.out };
}

describe('the another-pane repair', () => {
  for (const kase of ['live', 'gone', 'pane-gone'] as const) {
    test(`the ${kase} case: the named sequence ends with the caller passing the gate`, async () => {
      writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
      const world = repairWorld(kase);
      // Before the sequence: the caller on the pane its seat really runs on reads the refusal
      // under test — the gate that is about to be repaired.
      const before = await gateRun(world, 'w9:p1');
      expect(before.out).toContain('would refuse: the state records pane w1:p1 for seat');
      const stoppedIo = testIo(dir, { kind: 'owner' });
      expect(await runDown([], stoppedIo, world.down)).toBe(0);
      expect(stoppedIo.out).toContain(`session ${SESSION}: stopped and cleared`);
      const uppedIo = testIo(dir, { kind: 'owner' });
      expect(await runUp(['--file', '.agents/team.yaml'], uppedIo, world.up)).toBe(0);
      const recorded = (JSON.parse(readFileSync(stateFile, 'utf8')) as UpState).sessions[SESSION]?.seats[COORDINATOR]?.pane;
      if (typeof recorded !== 'string') throw new Error('the up run recorded no pane');
      // The caller that met the refusal, now on the pane the state records for it: the gate
      // passes, where before the sequence it read the another-pane refusal.
      const gate = await gateRun(world, recorded);
      expect(gate.code).toBe(0);
      expect(gate.out).not.toContain('would refuse');
    });
  }

  test('the no-pane case: up refuses while the seat runs, and records it once the owner stops it', async () => {
    writeFileSync(stateFile, `${JSON.stringify({ format: 1, sessions: {} }, null, 2)}\n`);
    const world = repairWorld('no-pane');
    // Before the repair: the caller on the pane its seat runs on reads the no-pane refusal.
    const before = await gateRun(world, 'w9:p1');
    expect(before.out).toContain('would refuse: no pane is recorded for seat');
    const refusedIo = testIo(dir, { kind: 'owner' });
    expect(await runUp(['--file', '.agents/team.yaml'], refusedIo, world.up)).toBe(1);
    expect(refusedIo.err).toContain("this file's state doesn't record: `up` never touches a running team");
    // The owner stops the seat by hand; the next up launches it and records the pane.
    world.stopSeat();
    const uppedIo = testIo(dir, { kind: 'owner' });
    expect(await runUp(['--file', '.agents/team.yaml'], uppedIo, world.up)).toBe(0);
    const recorded = (JSON.parse(readFileSync(stateFile, 'utf8')) as UpState).sessions[SESSION]?.seats[COORDINATOR]?.pane;
    if (typeof recorded !== 'string') throw new Error('the up run recorded no pane');
    const gate = await gateRun(world, recorded);
    expect(gate.code).toBe(0);
    expect(gate.out).not.toContain('would refuse');
  });
});
