// A command that only reads must not write into a project its caller has nothing to do with.
// `status --file <another project's team.yaml>` opened that file and left a new
// `.agents/team.state.json` beside it, its `last_valid` holding the file's own bytes; `watch
// --file` did the same and more (its log line, its heartbeat, its readings) — from commands
// whose own pages say "It writes nothing". Both were first held to the rule the commands that
// change a team already hold (`--file is the owner's`, decided by the walk alone, before that
// file is read); the readers are then split by what the command does with the file: `watch` writes
// state of its own, so its refusal stands, while `status` only reports, so the flag went back to
// any caller — a plain folder's own seats must carry it, for their project has no git walk to
// find the file — and the one write on its path (`currentTeam`'s `last_valid` copy) is made
// conditional on the walk instead: a run that is not the owner's writes nothing at all, beside
// the file it read or in its own project. The probes below hold the other read-and-report
// commands (`doctor`, `check`, `release check`, and the owner's `approve` and `up`; `init` takes
// no flag) to the same: nothing written beside a foreign file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { placeCaller, type Caller, type CallerSources } from '../../src/caller.ts';
import { runApprove } from '../../src/approve/command.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runInit } from '../../src/commands/init.ts';
import { runRelease } from '../../src/commands/release.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import type { Fetch } from '../../src/release/http.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { storePath, writeApproval, type Standing } from '../../src/store/store.ts';
import { testIo, type TestIo } from '../helpers.ts';

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

let base: string;
let dir: string;
let file: string;
let stateFile: string;
let home: string;
let emptyHome: string;
let fileText: string;

beforeEach(() => {
  // The world of test/commands/coordinator-session.test.ts, trimmed to what a read needs: a
  // project with a valid, approved team file and a state that records every seat, and a home
  // whose lobby exists so the file's trust entries land.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-readonly-file-')));
  dir = join(base, 'project');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  file = join(dir, '.agents', 'team.yaml');
  stateFile = join(dir, '.agents', 'team.state.json');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  home = join(base, 'home');
  emptyHome = join(base, 'home-empty');
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

// A caller placed by fake sources, as coordinator-session.test.ts places them: a seat of another
// session is the non-owner every refusal below meets.
function placed(session: string, name: string | null, pane: string): Caller {
  const row = runningAgent(name ?? '', pane);
  const sources: CallerSources = {
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => [row],
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  };
  return placeCaller(sources, session);
}

// The fake sources a real run reads for a caller under herdr, answering for the session asked
// about: a command that read a session before its refusal places a seat of it, and a command
// that read none places nobody.
function sourcesUnderHerdr(session: string, name: string, pane: string): (asked: string | undefined) => CallerSources {
  const row = runningAgent(name, pane);
  return (asked) => ({
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => (asked === session ? [row] : []),
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  });
}

// The states a flagged path stands in, one test each (coordinator-session.test.ts's set): no
// file at all, an unparsable file, a valid team file, a folder, an unreadable file. The refusal
// is the same bytes and the same exit in all five.
const FLAGGED_STATES: { name: string; setUp: (path: string) => void; seal?: (path: string) => void; open?: (path: string) => void }[] = [
  { name: 'missing', setUp: () => {} },
  { name: 'unparsable', setUp: (path) => writeFileSync(path, 'format: [\n') },
  { name: 'valid', setUp: (path) => writeFileSync(path, FILE) },
  { name: 'a folder', setUp: (path) => mkdirSync(path) },
  { name: 'unreadable', setUp: (path) => writeFileSync(path, FILE), seal: (path) => chmodSync(path, 0o000), open: (path) => chmodSync(path, 0o600) },
];

// The flagged project stands in two shapes: a plain folder (`git: false`, the default — a
// project whose owner runs `team` with `--file` because no git walk can find the file there) and
// a git project (`git: true`). `--file` resolves either way; the flagless commands need the git
// one.
function flaggedProject(stateName = 'valid', git = false): {
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
  if (git) execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
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

function statusSources(over: Partial<StatusSources> = {}): StatusSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {}, processes: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }) as Standing,
    now: () => new Date(0),
    home,
    ...over,
  };
}

function watchSources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {}, processes: {} }),
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }) as Standing,
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(0),
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
    ...over,
  };
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

const NO_FETCH: Fetch = async () => {
  throw new Error('no network in this test');
};

const FILE_OWNER = (command: string, who: string) =>
  `team ${command}: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`;

// Every run starts from the file and the state as written, so a run's writes are told from the
// bytes it started from.
type Run = { code: number; out: string; err: string; before: string; beforeState: string };

async function call(runner: (io: TestIo) => Promise<number>, caller: Caller): Promise<Run> {
  writeFileSync(file, fileText);
  writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');
  const beforeState = readFileSync(stateFile, 'utf8');
  const io = testIo(dir, caller);
  const code = await runner(io);
  return { code, out: io.out, err: io.err, before, beforeState };
}

// The runner's own io, for the runs the assertions read the output of.
async function outputOf(runner: (io: TestIo) => Promise<number>, caller?: Caller): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(dir, caller);
  const code = await runner(io);
  return { code, out: io.out, err: io.err };
}

// The rule `watch` keeps, against one state of the flagged path: the walk refuses the flag
// before the file is read — the run places nobody, because placing a caller would read a
// session — and neither project moves: the flagged project's folder listing and every file's
// bytes unchanged, the caller's own project's file, state and log unchanged too.
async function refusedBeforeRead(stateName: string): Promise<void> {
  const flagged = flaggedProject(stateName);
  try {
    const beforeListing = flagged.listing();
    const beforeBytes = flagged.bytes();
    flagged.seal();
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const before = readFileSync(file, 'utf8');
    const beforeState = readFileSync(stateFile, 'utf8');
    const io = testIo(dir);
    io.callerSources = sourcesUnderHerdr(OTHER, COORDINATOR, COORDINATOR_PANE);
    const argv = ['--file', flagged.file];
    const code = await runWatch(argv, io, watchSources());
    flagged.open();
    expect({ code, out: io.out, err: io.err }).toEqual({
      code: 1,
      out: '',
      err: FILE_OWNER('watch', 'unplaced (it runs under herdr)'),
    });
    expect(flagged.listing()).toEqual(beforeListing);
    expect(flagged.bytes()).toBe(beforeBytes);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(stateFile, 'utf8')).toBe(beforeState);
    expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
    expect(existsSync(join(flagged.root, '.agents', 'team.log'))).toBe(false);
  } finally {
    flagged.cleanup();
  }
}

describe("watch: --file is the owner's", () => {
  // The reported write, as the failing test first: a non-owner's `--file` against a valid file
  // of another project. On main `watch` answers as a reader and leaves the state file, its log
  // line, its heartbeat and its readings there; round 1 refused the flag, and round 2 keeps the
  // refusal — a watch writes state of its own, so a read is not a read.
  test("a non-owner's --file against a valid foreign file is refused, and writes nothing", async () => {
    const flagged = flaggedProject('valid');
    try {
      const beforeListing = flagged.listing();
      const run = await call((io) => runWatch(['--file', flagged.file], io, watchSources()), placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({
        code: 1,
        out: '',
        err: FILE_OWNER('watch', COORDINATOR),
      });
      expect(flagged.listing()).toEqual(beforeListing);
      expect(readFileSync(file, 'utf8')).toBe(run.before);
      expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
      expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
      expect(existsSync(join(flagged.root, '.agents', 'team.log'))).toBe(false);
    } finally {
      flagged.cleanup();
    }
  });

  // The same refusal through the sources a real run reads: decided by the walk alone, so the
  // same bytes and the same exit whatever is at the flagged path — no `no team file at …`, no
  // YAML problem, no report — and no session is read on the way (the fixture would answer for
  // its own, and nothing asks).
  for (const state of FLAGGED_STATES) {
    test(`the walk alone refuses it, before the file is read: the flagged path is ${state.name}`, async () => {
      await refusedBeforeRead(state.name);
    });
  }

  test('the owner may aim --file: the gate lets it through', async () => {
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const flagged = await outputOf((io) => runWatch(['--file', file], io, watchSources()), { kind: 'owner' });
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const plain = await outputOf((io) => runWatch([], io, watchSources()), { kind: 'owner' });
    expect(flagged).toEqual(plain);
  });
});

function unreadStatus(): StatusSources {
  return {
    ...statusSources(),
    live: () => { throw new Error('a session was read'); },
    standing: () => { throw new Error('the approval was read'); },
  };
}

// A non-owner's `--file` is refused before the file is read. The owner's run on the same file
// still prints the report and keeps the copy.
async function refusedFile(git: boolean): Promise<void> {
  const flagged = flaggedProject('valid', git);
  try {
    const beforeBytes = flagged.bytes();
    const seatIo = testIo(flagged.root, placed(OTHER, COORDINATOR, COORDINATOR_PANE));
    const missing = testIo(flagged.root, placed(OTHER, COORDINATOR, COORDINATOR_PANE));
    const seatCode = await runStatus(['--file', flagged.file], seatIo, unreadStatus());
    const missingCode = await runStatus(['--file', join(flagged.root, 'no-such.yaml')], missing, unreadStatus());
    const text = FILE_OWNER('status', COORDINATOR);
    expect({ code: seatCode, out: seatIo.out, err: seatIo.err }).toEqual({ code: 1, out: '', err: text });
    expect({ code: missingCode, out: missing.out, err: missing.err }).toEqual({ code: 1, out: '', err: text });
    expect(flagged.listing()).toEqual(['team.yaml']);
    expect(flagged.bytes()).toBe(beforeBytes);

    const ownerIo = testIo(flagged.root, { kind: 'owner' });
    const ownerCode = await runStatus(['--file', flagged.file], ownerIo, statusSources());
    expect(ownerCode).toBe(1);
    expect(ownerIo.out).toContain('team acme');
    expect(flagged.listing()).toEqual(['team.state.json', 'team.yaml']);
    const state = JSON.parse(readFileSync(join(flagged.root, '.agents', 'team.state.json'), 'utf8')) as { last_valid?: { file?: string } };
    expect(state.last_valid?.file ?? null).toBe(beforeBytes);
  } finally {
    flagged.cleanup();
  }
}

// The round-2 rule for `status`: the flag is any caller's — the report is the same for every
// caller — and the write is the owner's alone. A non-owner's run writes nothing at all, beside
// the file it read (its `last_valid` copy is not its project's to accept) or in its own project;
// the owner's run keeps the copy, as it always did. By caller, not by flag: a non-owner's bare
// run in its own project writes nothing either.
describe('status: --file reads for any caller, and writes for the owner alone', () => {
  // One flagged world, two runs against the same file: a seat's `--file` first, then the
  // owner's. The report must be the same bytes for both; only the owner's run may leave the
  // `last_valid` copy. Returns what each printed and what the world holds after each.
  async function aimed(git: boolean): Promise<{
    seat: { code: number; out: string; err: string };
    owner: { code: number; out: string; err: string };
    listingAfterSeat: string[];
    listingAfterOwner: string[];
    bytes: string | null;
    beforeBytes: string | null;
    stateAfterSeat: string | null;
    stateAfterOwner: string | null;
  }> {
    const flagged = flaggedProject('valid', git);
    try {
      const beforeBytes = flagged.bytes();
      const statePath = join(flagged.root, '.agents', 'team.state.json');
      const seatIo = testIo(flagged.root, placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      const seatCode = await runStatus(['--file', flagged.file], seatIo, statusSources());
      const listingAfterSeat = flagged.listing();
      const stateAfterSeat = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
      const ownerIo = testIo(flagged.root, { kind: 'owner' });
      const ownerCode = await runStatus(['--file', flagged.file], ownerIo, statusSources());
      return {
        seat: { code: seatCode, out: seatIo.out, err: seatIo.err },
        owner: { code: ownerCode, out: ownerIo.out, err: ownerIo.err },
        listingAfterSeat,
        listingAfterOwner: flagged.listing(),
        bytes: flagged.bytes(),
        beforeBytes,
        stateAfterSeat,
        stateAfterOwner: existsSync(statePath) ? readFileSync(statePath, 'utf8') : null,
      };
    } finally {
      flagged.cleanup();
    }
  }

  // Earlier rule, reversed by the status caller rule:
  // a non-owner's --file on a git project's file prints the same report as the owner, and that run writes nothing.
  test.skip("a non-owner's --file prints the owner's report and writes nothing — a git project's file", async () => {
    const run = await aimed(true);
    // The same report the owner would get for that file: byte for byte, exit and stderr too.
    expect(run.seat).toEqual(run.owner);
    expect(run.seat.code).toBe(1); // the report itself: differences, each with its repair
    expect(run.seat.out).toContain('team acme');
    // And the flagged project after the seat's run is untouched: no state, the bytes it held.
    expect(run.listingAfterSeat).toEqual(['team.yaml']);
    expect(run.bytes).toBe(run.beforeBytes);
    expect(run.stateAfterSeat).toBe(null);
    // The owner's run on the same world: the same report, and the copy it alone may keep.
    expect(run.listingAfterOwner).toEqual(['team.state.json', 'team.yaml']);
    const state = JSON.parse(run.stateAfterOwner ?? '{}') as { last_valid?: { file?: string } };
    expect(state.last_valid?.file ?? null).toBe(run.beforeBytes);
  });

  // Earlier rule, reversed by the status caller rule:
  // a non-owner's --file on a plain folder's file prints the same report as the owner, and that run writes nothing.
  test.skip("a non-owner's --file prints the owner's report and writes nothing — a plain folder's file", async () => {
    // The plain folder is the round-2 case itself: a project with no git walk to find the file,
    // whose own seats carry `--file` by necessity. The caller runs from the flagged root, and
    // the owner's runs there keep behaving as they did before the round (the copy included).
    const run = await aimed(false);
    expect(run.seat).toEqual(run.owner);
    expect(run.seat.out).toContain('team acme');
    expect(run.listingAfterSeat).toEqual(['team.yaml']);
    expect(run.bytes).toBe(run.beforeBytes);
    expect(run.stateAfterSeat).toBe(null);
    expect(run.listingAfterOwner).toEqual(['team.state.json', 'team.yaml']);
    const state = JSON.parse(run.stateAfterOwner ?? '{}') as { last_valid?: { file?: string } };
    expect(state.last_valid?.file ?? null).toBe(run.beforeBytes);
  });

  // Earlier rule, reversed by the status caller rule:
  // a non-owner's --file on a file the git walk does not find prints the same report as the owner, and that run writes nothing.
  test.skip("a non-owner's --file on a path the git walk does not resolve: the same split", async () => {
    // The layout a review ran: `custom/team.yaml` inside a git project — a file the walk never
    // finds, so the project's own seats reach it only with the flag, and their bare runs from the
    // pane's folder find nothing at all. The seat's flagged run reads it and writes nothing; the
    // owner's keeps the copy beside the file, in `custom/`.
    const root = mkdtempSync(join(tmpdir(), 'team-custom-'));
    try {
      mkdirSync(join(root, 'custom'));
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      const custom = join(root, 'custom', 'team.yaml');
      writeFileSync(custom, FILE);
      const bareIo = testIo(join(root, 'custom'), placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      const bareCode = await runStatus([], bareIo, statusSources());
      expect(bareCode).toBe(2);
      expect(bareIo.err).toContain('no team file');

      const seatIo = testIo(root, placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      const seatCode = await runStatus(['--file', custom], seatIo, statusSources());
      expect(readdirSync(join(root, 'custom')).sort()).toEqual(['team.yaml']);
      const ownerIo = testIo(root, { kind: 'owner' });
      const ownerCode = await runStatus(['--file', custom], ownerIo, statusSources());
      expect({ code: seatCode, out: seatIo.out, err: seatIo.err }).toEqual({ code: ownerCode, out: ownerIo.out, err: ownerIo.err });
      expect(readdirSync(join(root, 'custom')).sort()).toEqual(['team.state.json', 'team.yaml']);
      const state = JSON.parse(readFileSync(join(root, 'custom', 'team.state.json'), 'utf8')) as { last_valid?: { file?: string } };
      expect(state.last_valid?.file ?? null).toBe(FILE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Earlier rule, reversed by the status caller rule:
  // a non-owner's --file reads the last valid copy while the owner edits the file, and that read writes nothing.
  test.skip("the fallback serves a non-owner while the owner edits, and its read writes nothing", async () => {
    // The owner's run left the copy; the file breaks; a seat's `--file` reads the copy — the
    // notice, then the report — and the state's bytes do not move.
    const flagged = flaggedProject('valid', true);
    try {
      const owner = testIo(flagged.root, { kind: 'owner' });
      await runStatus(['--file', flagged.file], owner, statusSources());
      const statePath = join(flagged.root, '.agents', 'team.state.json');
      const stateBefore = readFileSync(statePath, 'utf8');
      writeFileSync(flagged.file, 'format: [\n');
      const seat = testIo(flagged.root, placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      const code = await runStatus(['--file', flagged.file], seat, statusSources());
      expect(code).toBe(1);
      expect(seat.out.split('\n')[0]).toBe('team config is invalid (line 1: "[" is not closed on its line); using the copy of 1970-01-01T00:00:00.000Z');
      expect(seat.out).toContain('team acme');
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
      expect(flagged.bytes()).toBe('format: [\n');
    } finally {
      flagged.cleanup();
    }
  });

  test("a non-owner's --file is refused before the file is read, and the owner still keeps the copy — a git project's file", async () => {
    await refusedFile(true);
  });

  test("a non-owner's --file is refused before the file is read, and the owner still keeps the copy — a plain folder's file", async () => {
    await refusedFile(false);
  });

  test("a non-owner's --file on a path the git walk does not resolve is refused before the file is read, and the owner still keeps the copy", async () => {
    const root = mkdtempSync(join(tmpdir(), 'team-custom-'));
    try {
      mkdirSync(join(root, 'custom'));
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      const custom = join(root, 'custom', 'team.yaml');
      writeFileSync(custom, FILE);
      const bareIo = testIo(join(root, 'custom'), placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      const bareCode = await runStatus([], bareIo, unreadStatus());
      expect(bareCode).toBe(2);
      expect(bareIo.err).toBe('team status: this team is not yours to read\n');
      expect(bareIo.out).toBe('');
      expect(readdirSync(join(root, 'custom')).sort()).toEqual(['team.yaml']);

      const seatIo = testIo(root, placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      const seatCode = await runStatus(['--file', custom], seatIo, unreadStatus());
      expect({ code: seatCode, out: seatIo.out, err: seatIo.err }).toEqual({
        code: 1,
        out: '',
        err: FILE_OWNER('status', COORDINATOR),
      });
      expect(readdirSync(join(root, 'custom')).sort()).toEqual(['team.yaml']);

      const ownerIo = testIo(root, { kind: 'owner' });
      const ownerCode = await runStatus(['--file', custom], ownerIo, statusSources());
      expect(ownerCode).toBe(1);
      expect(ownerIo.out).toContain('team acme');
      expect(readdirSync(join(root, 'custom')).sort()).toEqual(['team.state.json', 'team.yaml']);
      const state = JSON.parse(readFileSync(join(root, 'custom', 'team.state.json'), 'utf8')) as { last_valid?: { file?: string } };
      expect(state.last_valid?.file ?? null).toBe(FILE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a seat on its recorded pane, with no flag, is served the fallback while the owner edits, and that read writes nothing', async () => {
    const flagged = flaggedProject('valid', true);
    try {
      const owner = testIo(flagged.root, { kind: 'owner' });
      await runStatus(['--file', flagged.file], owner, statusSources());
      const statePath = join(flagged.root, '.agents', 'team.state.json');
      updateState(join(flagged.root, '.agents'), (state) => {
        const session = (state.sessions[SESSION] ??= emptySession());
        session.seats[COORDINATOR] = { stage: 'ready', pane: COORDINATOR_PANE, workspace: 'w1' };
      });
      const stateBefore = readFileSync(statePath, 'utf8');
      writeFileSync(flagged.file, 'format: [\n');
      const seat = testIo(flagged.root, placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      const code = await runStatus([], seat, statusSources());
      expect(code).toBe(1);
      expect(seat.out.split('\n')[0]).toBe('team config is invalid (line 1: "[" is not closed on its line); using the copy of 1970-01-01T00:00:00.000Z');
      expect(seat.out).toContain('team acme');
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
      expect(flagged.bytes()).toBe('format: [\n');
    } finally {
      flagged.cleanup();
    }
  });

  test("a seat's bare status in its own project: the owner's report, and nothing written", async () => {
    // The rule is by caller, not by flag: a non-owner's run writes nothing with or without
    // `--file`. Before round 2 the seat's own run refreshed `last_valid` in its own project;
    // now only the owner's does, and the copy the fallback reads is the owner's last one.
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const stateBefore = readFileSync(stateFile, 'utf8');
    const seat = await outputOf((io) => runStatus([], io, statusSources()), {
      kind: 'seat',
      name: COORDINATOR,
      pane: COORDINATOR_PANE,
      session: SESSION,
    });
    expect(seat.code).toBe(1);
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    // The owner's bare run prints the same report — and does refresh the copy, as before.
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const ownerRun = await outputOf((io) => runStatus([], io, statusSources()), { kind: 'owner' });
    expect({ code: seat.code, out: seat.out, err: seat.err }).toEqual({ code: ownerRun.code, out: ownerRun.out, err: ownerRun.err });
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).last_valid?.file).toBe(fileText);
  });
});

// `doctor` never writes — for any caller, any file. Its report differs from the owner's in one
// place only (the budget checks, which run for the owner alone); this file has no budgets, so
// the runs below print the same bytes.
describe('doctor: --file reads for any caller, and writes nothing', () => {
  function doctorHome(): DoctorSources {
    return {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => new Date(0),
      home,
    };
  }

  // One flagged world, both callers against it: doctor writes nothing for either, so the world
  // cannot move between the runs and the two reports are byte-comparable (the trust line names
  // the flagged root).
  async function doctored(git: boolean): Promise<{
    seat: { code: number; out: string; err: string };
    owner: { code: number; out: string; err: string };
    listing: string[];
    stateBytes: string | null;
  }> {
    const flagged = flaggedProject('valid', git);
    try {
      const statePath = join(flagged.root, '.agents', 'team.state.json');
      const seatIo = testIo(flagged.root, placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      const seatCode = await runDoctor(['--file', flagged.file], seatIo, doctorHome());
      const ownerIo = testIo(flagged.root, { kind: 'owner' });
      const ownerCode = await runDoctor(['--file', flagged.file], ownerIo, doctorHome());
      return {
        seat: { code: seatCode, out: seatIo.out, err: seatIo.err },
        owner: { code: ownerCode, out: ownerIo.out, err: ownerIo.err },
        listing: flagged.listing(),
        stateBytes: existsSync(statePath) ? readFileSync(statePath, 'utf8') : null,
      };
    } finally {
      flagged.cleanup();
    }
  }

  test("a non-owner's --file prints the report and writes nothing — a git project's file", async () => {
    const run = await doctored(true);
    expect(run.seat).toEqual(run.owner);
    expect(run.seat.code).toBe(0);
    expect(run.seat.out).toContain('team doctor: nothing missing');
    expect(run.listing).toEqual(['team.yaml']);
    expect(run.stateBytes).toBe(null);
  });

  test("a non-owner's --file prints the report and writes nothing — a plain folder's file", async () => {
    const run = await doctored(false);
    expect(run.seat).toEqual(run.owner);
    expect(run.seat.out).toContain('team doctor: nothing missing');
    expect(run.listing).toEqual(['team.yaml']);
    expect(run.stateBytes).toBe(null);
  });
});

// The watch the pane runs carries no flag, and a seat's `status` needs none: the refusal the
// rule adds breaks neither. `up --file` starts its watch from the project root, the line built
// by `watchCommand` (`team watch`, `--session` when the session is not "default"), and the pane
// that runs it is under herdr — a caller the walk places as unplaced, exactly the caller the
// rule must not refuse when no flag is passed.
describe('a team whose owner ran up --file', () => {
  test('the watch it starts carries no --file, and that watch runs from a pane under herdr', async () => {
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const lines: string[] = [];
    const agents = () => [runningAgent(COORDINATOR, COORDINATOR_PANE), runningAgent(OPERATOR, 'w4:p1'), runningAgent(SEAT, 'w3:p1')];
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'w9:p1', workspace: 'w9' }),
      paneRun: (_session, _pane, command) => {
        lines.push(command);
        return true;
      },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents,
      paneText: () => null,
      foreground: () => null,
      sleep: async () => {},
      now: () => new Date(0),
    };
    const code = await runUp(['--file', '.agents/team.yaml'], testIo(dir, { kind: 'owner' }), upSources({
      launch,
      agents,
      workspaces: () => [
        { id: 'w1', label: 'coordinator' },
        { id: 'w2', label: 'operator' },
        { id: 'w3', label: 'codex' },
      ],
    }));
    expect(code).toBe(0);
    const watchLine = lines.find((line) => line.includes(' watch'));
    expect(watchLine).toBeDefined();
    expect(watchLine).toContain('--session');
    expect(watchLine).not.toContain('--file');

    // The pane's own run: a caller under herdr (the walk places nobody — naming a seat would
    // read a session), no flag, the session named. The watch starts.
    const pane = await outputOf((io) => {
      io.callerSources = sourcesUnderHerdr(OTHER, COORDINATOR, COORDINATOR_PANE);
      return runWatch(['--session', SESSION], io, watchSources());
    });
    expect(pane.code, pane.out + pane.err).toBe(0);
    expect(pane.out).toContain(`watching the session "${SESSION}"`);
  });

  test("its seats' status still works in their own project: no flag, the same report the owner reads", async () => {
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const stateBefore = readFileSync(stateFile, 'utf8');
    const seat = await outputOf((io) => runStatus([], io, statusSources()), {
      kind: 'seat',
      name: COORDINATOR,
      pane: COORDINATOR_PANE,
      session: SESSION,
    });
    // Round 2: the seat's own run writes nothing either — the rule is by caller, not by flag.
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const owner = await outputOf((io) => runStatus([], io, statusSources()), { kind: 'owner' });
    expect(seat).toEqual(owner);
    expect(seat.code).toBe(1);
    // The copy the fallback reads while the owner edits is the owner's alone now; the owner's
    // run above left it, as it always did.
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { last_valid?: { file?: string } };
    expect(state.last_valid?.file).toBe(fileText);
  });
});

// Every other command that takes `--file`, held to the same rule: whatever it answers, a
// non-owner's run writes nothing beside the flagged file and nothing in its own project. The
// commands that change a team already refuse the flag before the file is read
// (coordinator-session.test.ts); these are the readers, and the owner's two.
describe('the other commands that take --file: nothing written beside a foreign file', () => {
  async function writesNothingBesideTheFlaggedFile(make: (flaggedFile: string) => (io: TestIo) => Promise<number>): Promise<void> {
    const flagged = flaggedProject('valid');
    try {
      const beforeListing = flagged.listing();
      const beforeBytes = flagged.bytes();
      const run = await call(make(flagged.file), placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      expect(flagged.listing()).toEqual(beforeListing);
      expect(flagged.bytes()).toBe(beforeBytes);
      expect(readFileSync(file, 'utf8')).toBe(run.before);
      expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
      expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
      expect(existsSync(join(flagged.root, '.agents', 'team.log'))).toBe(false);
    } finally {
      flagged.cleanup();
    }
  }

  test('doctor reads it and writes nothing', async () => {
    const sources: DoctorSources = {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      agentList: () => [],
      now: () => new Date(0),
      home,
    };
    await writesNothingBesideTheFlaggedFile((flaggedFile) => (io) => runDoctor(['--file', flaggedFile], io, sources));
  });

  test('commits check reads it and writes nothing', async () => {
    await writesNothingBesideTheFlaggedFile(
      (flaggedFile) => (io) => commits(['check', 'HEAD', '--file', flaggedFile], io, (cwd, path) => loadConfig(cwd, path, home)),
    );
  });

  test('release check reads it and writes nothing', async () => {
    await writesNothingBesideTheFlaggedFile(
      (flaggedFile) => (io) => runRelease(['check', 'acme-web@1.0.0', '--file', flaggedFile], io, NO_FETCH),
    );
  });

  test('approve: the owner gate holds before any write', async () => {
    await writesNothingBesideTheFlaggedFile(
      (flaggedFile) => (io) => runApprove(['--file', flaggedFile], io, { ask: async () => null, waiting: () => 'empty', now: () => new Date(0), home }),
    );
  });

  test('up: the owner refusal holds before any write', async () => {
    await writesNothingBesideTheFlaggedFile((flaggedFile) => (io) => runUp(['--file', flaggedFile], io, upSources()));
  });

  test('init takes no --file at all', async () => {
    await writesNothingBesideTheFlaggedFile((flaggedFile) => (io) => runInit(['--file', flaggedFile], io, emptyHome));
  });
});
