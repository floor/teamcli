// Adversarial coverage for the no-terminal placement's refusals: the placement is the real
// walk — the caller's ancestor chain, its environment and its stdin — never a caller built by
// hand, because the scenes that matter are the ones a detached process can build for itself:
// it left its seat's pane (every herdr spelling cleared, re-parented past the CLI that started
// it), or it kept its terminal's chain and only cut its stdin (a nohup-style run). Each
// owner-gated command refuses that placement with the one sentence, before it reads a flagged
// file, asks a session, matches the owner token, or stops anything; the owner at a terminal —
// its output redirected or not — still passes; and the callers the walk places otherwise keep
// the sentences they always had.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { approveFingerprint, upFingerprint } from '../src/approve/owner-token.ts';
import { DETACHED_REFUSAL, placeCaller, type CallerSources, type Process } from '../src/caller.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import { runBroker, type BrokerSources } from '../src/commands/broker.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runInit } from '../src/commands/init.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { runWorktree, type WorktreeSources } from '../src/commands/worktree.ts';
import { brokerSocket } from '../src/broker/protocol.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');

// A team file with one claude seat and no grant and no delegates: nothing but the caller gate
// can decide the runs below, so a pass or a refusal is that gate's alone. The trust paths are
// absolute and the record is approved, so no other refusal can mask the gate's decision.
let TEXT = '';

// The chains the walk reads. TERMINAL is a person's own terminal outside herdr; ORPHANED is a
// process whose parent is gone (the double-fork of a setsid-style escape: no herdr server, no
// CLI, above it — the placement a seat's detached child earns by re-parenting); UNDER_A_CLI is
// the same escape without the re-parenting, the seat's CLI still an ancestor.
const TERMINAL: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }, { pid: 30, name: 'Terminal' }];
const ORPHANED: Process[] = [{ pid: 90, name: 'zsh' }, { pid: 1, name: 'launchd' }];
const UNDER_A_CLI: Process[] = [{ pid: 90, name: 'zsh' }, { pid: 80, name: 'claude' }, { pid: 1, name: 'launchd' }];

let base: string;
let root: string;
let home: string;
let lobby: string;
let file: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'ignore', env: gitEnv() });
}

function checked(text: string): TeamFile {
  const result = validateTeamFile(text, { home, root });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-tty-bounds-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  file = join(root, '.agents', 'team.yaml');
  TEXT = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
rules:
  - Keep every change on a branch.
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, TEXT);
  git('init', '-q', '-b', 'main');
  // The approval an owner's `team approve` of exactly this text leaves on this machine, so the
  // runs below decide on the caller alone.
  const team = checked(TEXT);
  writeApproval(storePath(team.project, root, home), { approval: approvalOf(team, root, NOW), file: TEXT }, team.seats, home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The sources of a scene: the caller's ancestor chain, its environment and its stdin, as the
 *  real walk reads them. herdr is never asked — none of these chains runs under it — and the
 *  reads throw if a command ever tries, so a scene cannot quietly read a session to place its
 *  caller. */
function scene(
  chain: Process[],
  over: { env?: Record<string, string | undefined>; stdinIsTTY?: boolean } = {},
): CallerSources {
  return {
    ancestors: () => chain,
    agents: () => { throw new Error('the walk asked herdr for a session'); },
    paneRootPid: () => { throw new Error('the walk asked herdr for a pane root'); },
    env: over.env ?? {},
    stdinIsTTY: over.stdinIsTTY ?? false,
  };
}

function sceneIo(
  chain: Process[],
  over: { env?: Record<string, string | undefined>; stdinIsTTY?: boolean } = {},
): ReturnType<typeof testIo> {
  const io = testIo(root);
  const sources = scene(chain, over);
  io.callerSources = () => sources;
  return io;
}

// A detached seat's child, herdr's spellings cleared from its environment; a nohup-style run
// from the person's own terminal, stdin cut, output redirected; a terminal with stdin attached.
const leftItsPane = () => sceneIo(ORPHANED);
const nohupFromTerminal = () => sceneIo(TERMINAL);
const atATerminal = () => sceneIo(TERMINAL, { stdinIsTTY: true });

/** Every source a command would read past its refusal, thrown at: a scene that survives to
 *  read anything fails loudly instead of passing over a quiet fixture. */
const boom = (what: string) => () => { throw new Error(`past the refusal: ${what}`); };
const boomPane = (): never => { throw new Error('this scene touches no pane'); };

describe('the walk places the detached scenes', () => {
  test('a run that left its seat\'s pane, herdr\'s variables cleared and no terminal, is the no-terminal placement', () => {
    expect(placeCaller(scene(ORPHANED))).toEqual({ kind: 'owner-no-tty' });
  });

  test('a nohup-style run from the terminal\'s own chain, stdin cut, is the no-terminal placement too', () => {
    expect(placeCaller(scene(TERMINAL))).toEqual({ kind: 'owner-no-tty' });
  });

  test('the same chain with stdin attached is the owner, output redirected or not', () => {
    expect(placeCaller(scene(TERMINAL, { stdinIsTTY: true }))).toEqual({ kind: 'owner' });
  });
});

describe('every owner-gated command refuses the run with no terminal, through the walk', () => {
  function recordingLaunch(): { launch: Launch; created: () => number } {
    let made = 0;
    const launch: Launch = {
      sessionState: () => 'absent',
      startServer: () => true,
      sessionUp: () => false,
      createWorkspace() {
        made += 1;
        return { pane: `made-${made}`, workspace: `ws-${made}` };
      },
      paneRun: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents: () => [],
      paneText: () => claudeBox(''),
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };
    return { launch, created: () => made };
  }

  function upSources(over: Partial<UpSources> = {}): UpSources {
    return { sessionRunning: () => false, agents: () => [], home, now: () => NOW, ...over };
  }

  test('up refuses a run that left its pane, and launches nothing', async () => {
    const { launch, created } = recordingLaunch();
    const io = leftItsPane();
    const code = await runUp([], io, upSources({ launch }));
    expect(code).toBe(1);
    expect(io.err).toBe(`team up: ${DETACHED_REFUSAL}\n`);
    expect(created()).toBe(0);
  });

  test('up refuses a nohup-style run from the terminal\'s own chain the same way', async () => {
    const { launch, created } = recordingLaunch();
    const io = nohupFromTerminal();
    const code = await runUp([], io, upSources({ launch }));
    expect(code).toBe(1);
    expect(io.err).toBe(`team up: ${DETACHED_REFUSAL}\n`);
    expect(created()).toBe(0);
  });

  test('up --dry-run names the same sentence above its plan', async () => {
    const io = leftItsPane();
    const code = await runUp(['--dry-run'], io, upSources());
    expect(code).toBe(1);
    expect(io.out).toContain(`! up would refuse: ${DETACHED_REFUSAL}\n`);
  });

  test('up refuses the aimed flags before the flagged file or the named session is read', async () => {
    const { launch, created } = recordingLaunch();
    const missing = join(base, 'no-such', 'team.yaml');
    for (const argv of [['--session', 'elsewhere'], ['--file', missing]]) {
      const io = leftItsPane();
      const code = await runUp(argv, io, upSources({ launch }));
      expect(code).toBe(1);
      expect(io.err).toBe(`team up: ${DETACHED_REFUSAL}\n`);
      expect(existsSync(missing)).toBe(false);
    }
    expect(created()).toBe(0);
  });

  test('a matching owner token does not buy the launch: the run with no terminal is refused before the token is matched', async () => {
    const team = checked(TEXT);
    const standing = {
      kind: 'verified',
      generation: 1,
      signedAt: NOW.toISOString(),
      record: { approval: approvalOf(team, root, NOW), file: TEXT, generation: 1, signature: 'test' },
    } as const;
    const token = upFingerprint(fingerprints(team), 1);
    const { launch, created } = recordingLaunch();
    const dry = leftItsPane();
    dry.env = { TEAM_OWNER_APPROVAL: token };
    const dryCode = await runUp(['--dry-run'], dry, upSources({ launch, standing: () => standing }));
    expect(dryCode).toBe(1);
    expect(dry.out).toContain(`! up would refuse: ${DETACHED_REFUSAL}\n`);
    const real = leftItsPane();
    real.env = { TEAM_OWNER_APPROVAL: token };
    const code = await runUp([], real, upSources({ launch, standing: () => standing }));
    expect(code).toBe(1);
    expect(real.err).toBe(`team up: ${DETACHED_REFUSAL}\n`);
    expect(created()).toBe(0);
  });

  function downSources(): { sources: DownSources; stopped: () => string[] } {
    const stopped: string[] = [];
    const launch: DownLaunch = {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace(_session, workspace) {
        stopped.push(workspace);
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: DownSources = {
      sessionRunning: () => true,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => 'idle',
      foreground: () => ['zsh'],
      now: () => NOW,
      home,
      launch,
    };
    return { sources, stopped: () => stopped };
  }

  test('down refuses the run, a dry run included, and stops nothing', async () => {
    for (const argv of [[], ['--dry-run']]) {
      const { sources, stopped } = downSources();
      const io = leftItsPane();
      const code = await runDown(argv, io, sources);
      expect(code).toBe(1);
      expect(io.err).toBe(`team down: ${DETACHED_REFUSAL}\n`);
      expect(stopped()).toEqual([]);
    }
  });

  test('down --file is refused before the flagged file is read', async () => {
    const { sources } = downSources();
    const io = nohupFromTerminal();
    const code = await runDown(['--file', join(base, 'no-such.yaml')], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${DETACHED_REFUSAL}\n`);
  });

  const throwingDoctor: DoctorSources = {
    version: boom('the CLI version'),
    onPath: boom('the PATH'),
    loggedIn: boom('the login'),
    herdrVersion: boom('herdr'),
    sessionRunning: boom('the session'),
    now: boom('the clock'),
    home: '',
  };

  const throwingAdd: AddSources = {
    home: '',
    sessionState: boom('the session state'),
    agents: boom('the agent list'),
    workspaces: boom('the workspaces'),
    doctor: throwingDoctor,
    now: boom('the clock'),
    launch: {
      sessionState: boom('the session state'),
      startServer: boom('the server'),
      sessionUp: boom('the session'),
      createWorkspace: boom('a workspace'),
      paneRun: boom('a pane'),
      renameAgent: boom('a rename'),
      closeWorkspace: boom('a close'),
      agentPanes: boom('the panes'),
      agents: boom('the agents'),
      paneText: boom('a pane'),
      foreground: boom('a foreground'),
      sleep: async () => { throw new Error('past the refusal: a sleep'); },
      now: boom('the clock'),
    },
  };

  test('add refuses the run before anything is read: no seat, a flagged file, a named session', async () => {
    for (const argv of [['worker'], ['worker', '--file', join(base, 'no-such.yaml')], ['worker', '--session', 'elsewhere']]) {
      const io = leftItsPane();
      const code = await runAdd(argv, io, throwingAdd);
      expect(code).toBe(1);
      expect(io.err).toBe(`team add: ${DETACHED_REFUSAL}\n`);
    }
  });

  const throwingRemove: RemoveSources = {
    // No create-grant admits a run with no terminal, so the refusal is answered before any read:
    // the record store is not even opened, and every machine read past the refusal throws.
    home: '',
    sessionRunning: boom('the session'),
    agents: boom('the agent list'),
    alive: boom('a pid'),
    screen: boom('a screen'),
    screenText: boom('a screen'),
    status: boom('a status'),
    foreground: boom('a foreground'),
    now: boom('the clock'),
  };

  test('remove refuses the run before the team is read', async () => {
    const io = leftItsPane();
    const code = await runRemove(['worker'], io, throwingRemove);
    expect(code).toBe(1);
    expect(io.err).toBe(`team remove: ${DETACHED_REFUSAL}\n`);
  });

  const throwingWorktree: WorktreeSources = { home: '', now: boom('the clock') };

  test('worktree refuses the run on every subcommand', async () => {
    for (const argv of [['list'], ['new', 'task']]) {
      const io = leftItsPane();
      const code = await runWorktree(argv, io, throwingWorktree);
      expect(code).toBe(1);
      expect(io.err).toBe(`team worktree: ${DETACHED_REFUSAL}\n`);
    }
  });

  const throwingAnswer: AnswerHost = {
    version: boom('the CLI version'),
    agents: boom('the agent list'),
    pane: boom('a pane'),
    sendKey: boom('a key'),
    rename: boom('a rename'),
    foreground: boom('a foreground'),
    foregroundCwd: boom('a cwd'),
    list: boom('a folder'),
    status: boom('a status'),
    type: boom('a typing'),
    enter: boom('an enter'),
    now: boom('the clock'),
    sleep: async () => { throw new Error('past the refusal: a sleep'); },
    home: '',
    standing: boom('the store'),
  };

  test('answer refuses the run before a dialog is read or a key sent', async () => {
    const io = leftItsPane();
    const code = await runAnswer(['lead', 'trust'], io, throwingAnswer);
    expect(code).toBe(1);
    expect(io.err).toBe(`team answer: ${DETACHED_REFUSAL}\n`);
  });

  const throwingSend: SendHost = {
    agents: boom('the agent list'),
    processInfo: boom('a pane'),
    socketsDir: 'no-sockets',
    deliver: async () => { throw new Error('past the refusal: a delivery'); },
    native: {
      typeText: boom('a typing'),
      pressEnter: boom('an enter'),
      status: boom('a status'),
      wait: async () => { throw new Error('past the refusal: a wait'); },
      paneText: boom('a pane'),
    },
    now: boom('the clock'),
    home: '',
  };

  test('send refuses the run before --list prints the roster, and before a seat is looked up', async () => {
    for (const argv of [['--list'], ['lead', 'hello']]) {
      const io = leftItsPane();
      const code = await runSend(argv, io, throwingSend);
      expect(code).toBe(1);
      expect(io.err).toBe(`team send: ${DETACHED_REFUSAL}\n`);
      expect(io.out).toBe('');
    }
  });

  const throwingWatch: WatchSources = {
    live: boom('the live read'),
    machine: boom('the machine'),
    standing: boom('the store'),
    readChecks: boom('the checks'),
    screen: boom('a screen'),
    status: boom('a status'),
    foreground: boom('a foreground'),
    typeText: boom('a typing'),
    pressEnter: boom('an enter'),
    sleep: async () => { throw new Error('past the refusal: a sleep'); },
    notify: boom('a notice'),
    now: boom('the clock'),
    wait: async () => { throw new Error('past the refusal: a wait'); },
    alive: boom('a pid'),
    pid: 0,
  };

  test('watch refuses the run before the team file or the state is read', async () => {
    const io = leftItsPane();
    const code = await runWatch([], io, throwingWatch);
    expect(code).toBe(1);
    expect(io.err).toBe(`team watch: ${DETACHED_REFUSAL}\n`);
  });

  test('broker refuses the run before the credential is read and the socket is bound', async () => {
    let read = false;
    const sources: BrokerSources = {
      home,
      keyReader: async () => {
        read = true;
        return { ok: false, reason: 'the run is not interactive' };
      },
      fetch: async () => { throw new Error('past the refusal: a fetch'); },
    };
    const io = leftItsPane();
    const code = await runBroker([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team broker: ${DETACHED_REFUSAL}\n`);
    expect(read).toBe(false);
    expect(existsSync(brokerSocket(root))).toBe(false);
  });

  test('init refuses the run before the repository is read', async () => {
    const io = leftItsPane();
    const code = await runInit([], io, home, boom('the store'), { loggedIn: boom('the login') });
    expect(code).toBe(1);
    expect(io.err).toBe(`team init: ${DETACHED_REFUSAL}\n`);
  });

  test('approve refuses the run even with a matching owner token, and signs nothing', async () => {
    const team = checked(TEXT);
    writeApproval(storePath(team.project, root, home), { approval: approvalOf(team, root, NOW), file: TEXT }, team.seats, home);
    const candidate = TEXT.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(file, candidate);
    const store = storePath(checked(candidate).project, root, home);
    const before = readApproval(store);
    const never = async () => { throw new Error('past the refusal: a question'); };
    const sources: ApproveSources = { ask: never, waiting: () => { throw new Error('past the refusal: the terminal'); }, now: () => NOW, home };
    const io = leftItsPane();
    io.env = { TEAM_OWNER_APPROVAL: approveFingerprint(checked(candidate)) };
    const code = await runApprove([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team approve: ${DETACHED_REFUSAL}\n`);
    expect(readApproval(store)).toEqual(before);
    expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
  });

  const throwingStatus: StatusSources = {
    live: boom('the live read'),
    branch: boom('a branch'),
    standing: boom('the store'),
    now: () => NOW,
    home: '',
    gate: { standing: boom('the store'), agents: boom('the agent list') },
  };

  test('status --file and --session are refused before the flagged file or session is read', async () => {
    for (const argv of [['--file', join(base, 'no-such.yaml')], ['--session', 'elsewhere']]) {
      const io = leftItsPane();
      const code = await runStatus(argv, io, throwingStatus);
      expect(code).toBe(1);
      expect(io.err).toBe(`team status: ${DETACHED_REFUSAL}\n`);
    }
  });
});

/** The status sources of a quiet world: a session nothing runs in, the store this fixture
 *  approved. */
function quietStatus(): StatusSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => null,
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
    gate: { standing: (at) => approvalStanding(at, home), agents: () => [] },
  };
}

describe('the owner at a terminal outside herdr still passes', () => {
  test('up launches: the gate holds only the run with no terminal', async () => {
    let made = 0;
    const panes: string[] = [];
    const launch: Launch = {
      sessionState: () => 'absent',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace() {
        made += 1;
        panes.push(`made-${made}`);
        return { pane: `made-${made}`, workspace: `ws-${made}` };
      },
      paneRun: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [...panes],
      agents: () => [],
      paneText: () => claudeBox(''),
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };
    const io = atATerminal();
    const code = await runUp([], io, { sessionRunning: () => false, agents: () => [], home, now: () => NOW, launch });
    expect(code).toBe(0);
    expect(made).toBeGreaterThan(0);
    expect(io.out).toContain('lead: ready');
    expect(io.out + io.err).not.toContain(DETACHED_REFUSAL);
    expect(io.out + io.err).not.toContain('only the owner runs');
  });

  test('up --dry-run reaches its plan with no refusal', async () => {
    const io = atATerminal();
    const code = await runUp(['--dry-run'], io, { sessionRunning: () => false, agents: () => [], home, now: () => NOW });
    expect(code).toBe(0);
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(io.out + io.err).not.toContain(DETACHED_REFUSAL);
  });

  test('status --file reads the flagged file', async () => {
    const io = atATerminal();
    const code = await runStatus(['--file', file], io, quietStatus());
    expect(code).not.toBe(2);
    expect(io.out).toContain('session "acme-web"');
    expect(io.err).not.toContain(DETACHED_REFUSAL);
  });

  test('send --list prints the roster', async () => {
    const host: SendHost = {
      agents: () => [],
      processInfo: () => null,
      socketsDir: join(base, 'socks'),
      deliver: async () => { throw new Error('the owner\'s --list delivers nothing'); },
      native: {
        typeText: boomPane,
        pressEnter: boomPane,
        status: boomPane,
        wait: async () => { throw new Error('the owner\'s --list waits for nothing'); },
        paneText: boomPane,
      },
      now: () => NOW,
      home,
    };
    const io = atATerminal();
    const code = await runSend(['--list'], io, host);
    expect(code).toBe(0);
    // Each row carries the project its team sits in: no registry names this team, so the project
    // its own file writes.
    expect(io.out).toContain('  SEAT  NICKNAME  ROLE         PROJECT  REACH\n');
    expect(io.out).toContain('  lead  -         coordinator  acme     socket\n');
    expect(io.out).toContain('1 seat\n');
  });
});

describe('the one sentence is the no-terminal placement\'s alone', () => {
  test('a run that kept AGENT_UNATTENDED is refused in its own words, not the one sentence', async () => {
    const io = sceneIo(ORPHANED, { env: { AGENT_UNATTENDED: '1' } });
    const code = await runUp(['--dry-run'], io, { sessionRunning: () => false, agents: () => [], home, now: () => NOW });
    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
    expect(io.out).toContain('! to unblock: the owner runs `team up` from this folder, at a terminal outside herdr\n');
    expect(io.out).toEndWith('dry run: nothing was run\n');
    expect(io.out + io.err).not.toContain(DETACHED_REFUSAL);
  });

  test('a run whose seat\'s CLI is still an ancestor is refused in its own words, not the one sentence', async () => {
    const io = sceneIo(UNDER_A_CLI);
    const code = await runUp(['--dry-run'], io, { sessionRunning: () => false, agents: () => [], home, now: () => NOW });
    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
    expect(io.out).toContain('! to unblock: the owner runs `team up` from this folder, at a terminal outside herdr\n');
    expect(io.out).toEndWith('dry run: nothing was run\n');
    expect(io.out + io.err).not.toContain(DETACHED_REFUSAL);
  });

  test('a plain status, no flag aimed, keeps its own sentence', async () => {
    const io = leftItsPane();
    const code = await runStatus([], io, quietStatus());
    expect(code).toBe(2);
    expect(io.err).toBe('team status: this team is not yours to read\n');
  });
});
