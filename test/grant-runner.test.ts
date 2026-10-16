// A create-grant's `runner`: a caller outside herdr whose parent processes include the name the
// record lists is admitted for `init` and `up` on the covered paths before expiry, and every
// refusal around it holds — a name not in the ancestry, an expired record, a record with no
// runner, a path escape, and a caller under herdr whose ancestry happens to carry the name.
// The same record admits the team's own commands — `status` and `down` for the covered team,
// and `add`/`remove` beside them — and the sentences they print without it are asserted here
// byte for byte.
// The commands are driven through the walker: the fake ancestors are injected as the real
// `callerSources`, so `callerOf`/`walkCaller` place the call exactly as they would a live one.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Process } from '../src/caller.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown } from '../src/commands/down.ts';
import { runInit } from '../src/commands/init.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { grantsDir, readEntityCreateGrants } from '../src/grant.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { LOG_FILE, readState } from '../src/state.ts';
import type { Machine } from '../src/watch/machine.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T11:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T10:59:59Z';
const EXACT_NOW = '2026-10-16T11:00:00Z';

// The record's runner: no CLI profile name and no server name, so its presence alone says
// nothing — only the record may name it. `claude` is one of the five shipped CLI names, so a
// caller under it is placed as an agent outside herdr, not as the owner.
const RUNNER = 'gemini-beacon';
const CLI_RUNNER = 'claude';

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const AMPLE: Machine = {
  loadPerCore: 0.2,
  memoryFree: 80,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};

const noLogin = { loggedIn: () => false, now: () => NOW };

/** Fake parents, nearest first, as `ps` would walk them. */
const parents = (...names: string[]): Process[] => names.map((name, i) => ({ pid: 900 - i, name }));

const OUTSIDE_HERDR = parents('zsh', RUNNER, 'launchd');
const WITHOUT_RUNNER = parents('zsh', 'launchd');
const AS_AGENT = parents('zsh', CLI_RUNNER, 'launchd');
const UNDER_HERDR = parents('zsh', RUNNER, 'herdr', 'launchd');
const OWNER = parents('zsh', 'launchd');

const SEAT = (role: string, name: string, leads = false) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${leads ? '\n    leads: true' : ''}
`;

function fiveSeatTeam(project: string, root: string, home: string): string {
  const lobby = join(home, '.config', 'team', 'lobbies', 'beacon');
  return `format: 1
project: ${project}
entity: beacon
operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}${SEAT('builder', 'builder-1')}${SEAT('builder', 'builder-2')}${SEAT('tester', 'tester-1')}${SEAT('tester', 'tester-2')}`;
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
  writeFileSync(join(dir, 'README.md'), 'project\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
}

function makeSandbox() {
  const base = realpathSync(mkdtempSync('/tmp/gr-'));
  const home = join(base, 'home');
  mkdirSync(grantsDir(home), { recursive: true });
  const code = join(home, 'Code', 'beacon');
  mkdirSync(code, { recursive: true });
  return { base, home, code };
}

function writeGrant(home: string, name: string, body: string): void {
  mkdirSync(grantsDir(home), { recursive: true });
  writeFileSync(join(grantsDir(home), name), body);
}

const recordWith = (expires: string, extra = ''): string =>
  `entity: beacon\nsession: dispatch\nagent: beacon-runner\npaths:\n  - ~/Code/beacon\nexpires: "${expires}"\n${extra}`;
const WITH_RUNNER = recordWith(FUTURE, `runner: ${RUNNER}\n`);

/** The commands driven through the walker: the fake parents are the whole caller source. */
function walkIo(cwd: string, ancestors: Process[], stdinIsTTY = false) {
  const io = testIo(cwd);
  io.stdinIsTTY = stdinIsTTY;
  io.callerSources = () => ({
    ancestors: () => ancestors,
    agents: () => null,
    paneRootPid: () => null,
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  });
  return io;
}

function launching(onLaunch: () => void): Launch & { closed: number } {
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { text: string; agent: boolean }>();
  const host = {
    closed: 0,
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `seat-pane-${n}`;
      panes.set(pane, { text: '', agent: false });
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session: string, pane: string) {
      onLaunch();
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    spawnWatch: () => 4242,
    renameAgent: () => true,
    closeWorkspace() {
      host.closed += 1;
      return true;
    },
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async (_ms: number) => {},
    now: () => NOW,
  };
  return host;
}

function terminal(): Terminal & { reads: number } {
  return {
    reads: 0,
    async key() {
      this.reads += 1;
      throw new Error('the pause read the terminal');
    },
    drain() {},
  };
}

function upSources(home: string, launch: Launch, term: Terminal, now: Date = NOW): UpSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    home,
    now: () => now,
    machine: () => AMPLE,
    terminal: () => term,
    launch,
  };
}

/** What `status` reads from outside the file: the session is not running, and no store exists. */
function statusSources(home: string): StatusSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home,
    gate: { standing: () => ({ kind: 'none' }), agents: () => [] },
  };
}

/** What `down` and `remove` read from outside the file: a running session with no agents, so a
 *  stop is the session's own and the counter is the run's whole effect. */
function stopSources(home: string, stopped: { n: number }): RemoveSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    home,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => {
        stopped.n += 1;
        return true;
      },
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

/** What `add` reads from outside the file. `sessionState` answers `null` — herdr silent — which
 *  is where a run the record admits stops: past the detached sentence and past the caller rule. */
function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => null,
    agents: () => [],
    workspaces: () => [],
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home,
    },
    machine: () => AMPLE,
    now: () => NOW,
    launch: launching(() => {}),
  };
}

/** A launching host where five seats come up and the lead's pane answers IDLE, on a virtual
 *  clock so the launch wait finishes without real time passing. */
function launchedUp() {
  let clock = NOW.getTime();
  const counts = { launches: 0, idleAt: null as number | null };
  const host = launching(() => {
    counts.launches += 1;
  });
  host.paneText = () => {
    if (counts.launches < 5) return '';
    if (counts.idleAt === null) counts.idleAt = counts.launches;
    return IDLE;
  };
  host.sleep = async (ms: number) => {
    clock += ms;
  };
  const now = () => new Date(clock);
  host.now = now;
  return { host, counts, now, sleep: host.sleep };
}

describe("a create-grant's runner outside herdr", () => {
  test('the runner in the ancestry admits init then up on a covered path before expiry', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: 'beacon',
          session: 'dispatch',
          agent: 'beacon-runner',
          paths: ['~/Code/beacon'],
          expires: FUTURE,
          runners: [RUNNER],
        },
      ]);

      const v1 = join(sb.code, 'v1');
      initGitRepo(v1);
      const initIo = walkIo(v1, OUTSIDE_HERDR);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(0);
      expect(existsSync(join(v1, '.agents', 'team.yaml'))).toBe(true);
      expect(initIo.out).toContain('a skeleton with one seat');
      // The walk really placed this run outside herdr with no terminal: the grant admitted it,
      // not the owner rule.
      expect(readFileSync(join(v1, '.agents', LOG_FILE), 'utf8')).toContain("[unplaced (it doesn't run on a terminal)]");

      writeFileSync(join(v1, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v1', v1, sb.home));

      const up = launchedUp();
      const keys = terminal();
      const upIo = walkIo(v1, OUTSIDE_HERDR);
      const upCode = await runUp([], upIo, { ...upSources(sb.home, up.host, keys), now: up.now, sleep: up.sleep });
      expect(upCode, `${upIo.err}${upIo.out}`).toBe(0);
      expect(up.counts.launches).toBeGreaterThanOrEqual(5);
      expect(keys.reads).toBe(0);
      expect(up.host.closed).toBe(0);

      const seats = readState(join(v1, '.agents')).sessions['beacon-v1']?.seats ?? {};
      for (const name of ['orchestrator', 'builder-1', 'builder-2', 'tester-1', 'tester-2']) {
        expect(seats[name]?.stage, name).toBe('ready');
      }
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('the runners list form admits a caller placed as an agent outside herdr; --restore never', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', recordWith(FUTURE, `runners:\n  - ${CLI_RUNNER}\n  - beacon-alt\n`));
      expect(readEntityCreateGrants(sb.home)[0]?.runners).toEqual([CLI_RUNNER, 'beacon-alt']);

      const v2 = join(sb.code, 'v2');
      initGitRepo(v2);

      // `--restore` is the one spelling the grant never admits, whatever the ancestry names.
      const restoreIo = walkIo(v2, AS_AGENT);
      expect(await runInit(['--restore'], restoreIo, sb.home, undefined, noLogin)).toBe(1);
      expect(restoreIo.err).toContain('only the owner runs');
      expect(existsSync(join(v2, '.agents', 'team.yaml'))).toBe(false);

      const initIo = walkIo(v2, AS_AGENT);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(0);
      expect(existsSync(join(v2, '.agents', 'team.yaml'))).toBe(true);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses a runner absent from the ancestry, an expired record, and a record with no runner', async () => {
    const sb = makeSandbox();
    try {
      const v3 = join(sb.code, 'v3');
      initGitRepo(v3);
      const refusal = 'team init: only the owner runs this, from a terminal outside herdr\n';

      // The record names a runner that is not among the ancestors.
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const absentIo = walkIo(v3, WITHOUT_RUNNER);
      expect(await runInit([], absentIo, sb.home, undefined, noLogin)).toBe(1);
      expect(absentIo.err).toBe(refusal);
      expect(existsSync(join(v3, '.agents', 'team.yaml'))).toBe(false);

      // The runner is in the ancestry, but the record has expired — at the instant of expiry too.
      for (const expires of [PAST, EXACT_NOW]) {
        writeGrant(sb.home, 'beacon.yaml', recordWith(expires, `runner: ${RUNNER}\n`));
        const expiredIo = walkIo(v3, OUTSIDE_HERDR);
        expect(await runInit([], expiredIo, sb.home, undefined, noLogin), expires).toBe(1);
        expect(expiredIo.err, expires).toBe(refusal);
        expect(existsSync(join(v3, '.agents', 'team.yaml'))).toBe(false);
      }

      // A record without a runner: today's refusal, unchanged, even with the runner named above.
      writeGrant(sb.home, 'beacon.yaml', recordWith(FUTURE));
      const plainIo = walkIo(v3, OUTSIDE_HERDR);
      expect(await runInit([], plainIo, sb.home, undefined, noLogin)).toBe(1);
      expect(plainIo.err).toBe(refusal);
      expect(existsSync(join(v3, '.agents', 'team.yaml'))).toBe(false);

      mkdirSync(join(v3, '.agents'), { recursive: true });
      writeFileSync(join(v3, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v3', v3, sb.home));

      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const absentUp = walkIo(v3, WITHOUT_RUNNER);
      expect(await runUp([], absentUp, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(absentUp.err).toContain('team up: only the owner runs this, from a terminal outside herdr');

      writeGrant(sb.home, 'beacon.yaml', recordWith(PAST, `runner: ${RUNNER}\n`));
      const expiredUp = walkIo(v3, OUTSIDE_HERDR);
      expect(await runUp([], expiredUp, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(expiredUp.err).toContain('team up: only the owner runs this, from a terminal outside herdr');

      writeGrant(sb.home, 'beacon.yaml', recordWith(FUTURE));
      const plainUp = walkIo(v3, OUTSIDE_HERDR);
      expect(await runUp([], plainUp, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(plainUp.err).toContain('team up: only the owner runs this, from a terminal outside herdr');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses a runner the record names on a path the record does not cover', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const outside = join(sb.home, 'Code', 'other-init');
      initGitRepo(outside);
      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      const linkOut = join(sb.code, 'escaped-link');
      symlinkSync(outside, linkOut);
      const linkIn = join(sb.code, 'linked-v4');
      symlinkSync(v4, linkIn);
      const sibling = join(sb.home, 'Code', 'beacon-evil');
      initGitRepo(sibling);

      // Every cwd here sits at or outside the grant's edge: a repository outside the covered
      // path, a symlink out of it, a `..` that stays inside it (`…/v4/../v4`), a symlink that
      // resolves inside it, a `..` that leaves it, and a sibling that only shares the prefix.
      const cwds = [outside, linkOut, `${v4}/../v4`, linkIn, `${v4}/../../other-init`, sibling];
      for (const cwd of cwds) {
        const io = walkIo(cwd, OUTSIDE_HERDR);
        expect(await runInit([], io, sb.home, undefined, noLogin), cwd).toBe(1);
        expect(io.err, cwd).toBe('team init: only the owner runs this, from a terminal outside herdr\n');
        expect(existsSync(join(cwd, '.agents', 'team.yaml')), cwd).toBe(false);
      }

      for (const [project, dir] of [
        ['other-init', outside],
        ['beacon-v4', v4],
        ['beacon-evil', sibling],
      ] as const) {
        mkdirSync(join(dir, '.agents'), { recursive: true });
        writeFileSync(join(dir, '.agents', 'team.yaml'), fiveSeatTeam(project, dir, sb.home));
      }

      for (const cwd of cwds) {
        const io = walkIo(cwd, OUTSIDE_HERDR);
        expect(await runUp([], io, upSources(sb.home, launching(() => {}), terminal())), cwd).toBe(1);
        expect(io.err, cwd).toContain('team up: only the owner runs this, from a terminal outside herdr');
      }
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses a caller under herdr even when the runner is in its ancestry', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const v5 = join(sb.code, 'v5');
      initGitRepo(v5);

      const initIo = walkIo(v5, UNDER_HERDR);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
      expect(initIo.err).toContain('only the owner runs init');
      expect(existsSync(join(v5, '.agents', 'team.yaml'))).toBe(false);

      mkdirSync(join(v5, '.agents'), { recursive: true });
      writeFileSync(join(v5, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v5', v5, sb.home));
      const upIo = walkIo(v5, UNDER_HERDR);
      expect(await runUp([], upIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(upIo.err).toBe('deny\n');
      expect(upIo.out).toBe('');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('the owner at a terminal is unchanged: no grant is needed', async () => {
    const sb = makeSandbox();
    try {
      const v6 = join(sb.code, 'v6');
      initGitRepo(v6);
      expect(readEntityCreateGrants(sb.home)).toEqual([]);

      const initIo = walkIo(v6, OWNER, true);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(0);
      expect(initIo.out).toContain('a skeleton with one seat');
      expect(readFileSync(join(v6, '.agents', LOG_FILE), 'utf8')).toContain('[owner]');

      writeFileSync(join(v6, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v6', v6, sb.home));
      const up = launchedUp();
      const upIo = walkIo(v6, OWNER, true);
      const upCode = await runUp([], upIo, { ...upSources(sb.home, up.host, terminal()), now: up.now, sleep: up.sleep });
      expect(upCode, `${upIo.err}${upIo.out}`).toBe(0);
      expect(up.counts.launches).toBeGreaterThanOrEqual(5);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

describe("a create-grant's runner and the team's other commands", () => {
  test('status reads a covered team for the record\'s runner, and refuses every other read', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const v7 = join(sb.code, 'v7');
      initGitRepo(v7);
      mkdirSync(join(v7, '.agents'), { recursive: true });
      writeFileSync(join(v7, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v7', v7, sb.home));

      const granted = walkIo(v7, OUTSIDE_HERDR);
      const code = await runStatus([], granted, statusSources(sb.home));
      expect(code, `${granted.err}${granted.out}`).not.toBe(2);
      expect(granted.out).toContain('team beacon-v7, session "beacon-v7"');
      expect(granted.err).not.toContain('this team is not yours to read');
      // The read alone: a granted run keeps no remembered copy the way the owner's run does.
      expect(readState(join(v7, '.agents')).last_valid).toBeUndefined();

      // A team under no granted path, for the scene below that aims a covered runner at it.
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);
      mkdirSync(join(elsewhere, '.agents'), { recursive: true });
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), fiveSeatTeam('elsewhere', elsewhere, sb.home));

      const cases: { name: string; body: string; cwd: string; ancestors: Process[] }[] = [
        { name: 'a runner the record does not name', body: WITH_RUNNER, cwd: v7, ancestors: WITHOUT_RUNNER },
        { name: 'a caller under herdr whose ancestry carries the name', body: WITH_RUNNER, cwd: v7, ancestors: UNDER_HERDR },
        { name: 'an expired record', body: recordWith(PAST, `runner: ${RUNNER}\n`), cwd: v7, ancestors: OUTSIDE_HERDR },
        { name: 'a team outside the covered path', body: WITH_RUNNER, cwd: elsewhere, ancestors: OUTSIDE_HERDR },
      ];
      for (const one of cases) {
        writeGrant(sb.home, 'beacon.yaml', one.body);
        const io = walkIo(one.cwd, one.ancestors);
        expect(await runStatus([], io, statusSources(sb.home)), one.name).toBe(2);
        expect(io.err, one.name).toBe('team status: this team is not yours to read\n');
        expect(io.out, one.name).toBe('');
      }
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down stops a covered team for the record\'s runner, and refuses every other stop', async () => {
    const sb = makeSandbox();
    try {
      const v8 = join(sb.code, 'v8');
      initGitRepo(v8);
      mkdirSync(join(v8, '.agents'), { recursive: true });
      writeFileSync(join(v8, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v8', v8, sb.home));
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);
      mkdirSync(join(elsewhere, '.agents'), { recursive: true });
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), fiveSeatTeam('elsewhere', elsewhere, sb.home));

      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const stopped = { n: 0 };
      const granted = walkIo(v8, OUTSIDE_HERDR);
      const code = await runDown([], granted, stopSources(sb.home, stopped));
      expect(code, `${granted.err}${granted.out}`).toBe(0);
      expect(stopped.n).toBe(1);
      // Both sentences this run would otherwise carry are absent — the detached one, which a
      // no-terminal caller meets before any file is read, and the placement one after it.
      expect(granted.err).not.toContain('only the owner runs this, from a terminal outside herdr');
      expect(granted.err).not.toContain('stops the team');

      const detached = 'team down: only the owner runs this, from a terminal outside herdr\n';
      const cases: { name: string; body: string; cwd: string; ancestors: Process[]; line: string }[] = [
        { name: 'a runner the record does not name', body: WITH_RUNNER, cwd: v8, ancestors: WITHOUT_RUNNER, line: detached },
        { name: 'an expired record', body: recordWith(PAST, `runner: ${RUNNER}\n`), cwd: v8, ancestors: OUTSIDE_HERDR, line: detached },
        { name: 'a team outside the covered path', body: WITH_RUNNER, cwd: elsewhere, ancestors: OUTSIDE_HERDR, line: detached },
        {
          name: 'a caller under herdr whose ancestry carries the name',
          body: WITH_RUNNER,
          cwd: v8,
          ancestors: UNDER_HERDR,
          line: 'team down: only the owner, the orchestrator or the operator stops the team; this call is unplaced (it runs under herdr, and herdr doesn\'t answer)\n',
        },
      ];
      for (const one of cases) {
        writeGrant(sb.home, 'beacon.yaml', one.body);
        const io = walkIo(one.cwd, one.ancestors);
        expect(await runDown([], io, stopSources(sb.home, stopped)), one.name).toBe(1);
        expect(io.err, one.name).toBe(one.line);
      }
      // No refused run stopped anything: the count is the one admitted run's.
      expect(stopped.n).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('add and remove reach their own work under the grant, and hold every other caller out', async () => {
    const sb = makeSandbox();
    try {
      const v9 = join(sb.code, 'v9');
      initGitRepo(v9);
      mkdirSync(join(v9, '.agents'), { recursive: true });
      writeFileSync(join(v9, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v9', v9, sb.home));
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);

      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      // The record admits the run, which goes on to its own work: a granted caller meets neither
      // the detached sentence nor the caller rule. `add` stops at its first herdr read, and
      // `remove` takes the seat out of the file — no caller sentence on either way.
      const addIo = walkIo(v9, OUTSIDE_HERDR);
      expect(await runAdd(['builder-2'], addIo, addSources(sb.home)), `${addIo.err}${addIo.out}`).toBe(1);
      expect(addIo.err).toBe('team add: herdr doesn\'t answer\n');

      const stopped = { n: 0 };
      const removeIo = walkIo(v9, OUTSIDE_HERDR);
      expect(await runRemove(['builder-2'], removeIo, stopSources(sb.home, stopped)), `${removeIo.err}${removeIo.out}`).toBe(0);
      expect(removeIo.err).not.toContain('only the owner');
      const after = readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8');
      expect(after).not.toContain('builder-2');
      expect(after).toContain('builder-1');

      // The seat is put back for the scenes below: each of them refuses before any file read,
      // so none may touch it.
      const before = fiveSeatTeam('beacon-v9', v9, sb.home);
      writeFileSync(join(v9, '.agents', 'team.yaml'), before);

      // Every caller the record does not admit keeps today's lines, unchanged.
      for (const one of [
        { name: 'a runner the record does not name', cwd: v9, ancestors: WITHOUT_RUNNER },
        { name: 'a team outside the covered path', cwd: elsewhere, ancestors: OUTSIDE_HERDR },
      ]) {
        const add = walkIo(one.cwd, one.ancestors);
        expect(await runAdd(['builder-2'], add, addSources(sb.home)), one.name).toBe(1);
        expect(add.err, one.name).toBe('team add: only the owner runs this, from a terminal outside herdr\n');
        const remove = walkIo(one.cwd, one.ancestors);
        expect(await runRemove(['builder-2'], remove, stopSources(sb.home, stopped)), one.name).toBe(1);
        expect(remove.err, one.name).toBe('team remove: only the owner runs this, from a terminal outside herdr\n');
      }

      // Under herdr the record never admits, and the caller rule says so in its own words.
      const under = walkIo(v9, UNDER_HERDR);
      expect(await runAdd(['builder-2'], under, addSources(sb.home))).toBe(1);
      expect(under.err).toBe(
        'team add: only the owner, the orchestrator or the operator runs it; this call is unplaced (it runs under herdr, and herdr doesn\'t answer)\n',
      );
      const underRemove = walkIo(v9, UNDER_HERDR);
      expect(await runRemove(['builder-2'], underRemove, stopSources(sb.home, stopped))).toBe(1);
      expect(underRemove.err).toBe(
        'team remove: only the owner, the orchestrator or the operator runs it; this call is unplaced (it runs under herdr, and herdr doesn\'t answer)\n',
      );
      // No run but the admitted removal had an effect: it stopped nothing (no live agent to
      // stop), and no refused run read far enough to write.
      expect(stopped.n).toBe(0);
      expect(readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8')).toBe(before);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

/** A record naming one seat in one session, rather than a runner by ancestry. */
const SEAT_RECORD = (expires: string): string =>
  `entity: beacon\nsession: dispatch\nagent: builder-2\npaths:\n  - ~/Code/beacon\nexpires: "${expires}"\n`;

const seatOf = (name: string, session = 'dispatch') =>
  ({ kind: 'seat', name, pane: `seat-pane-${name}`, session }) as const;

describe("a create-grant's named seat", () => {  test('the named seat is admitted on add and remove, and every other seat, session, path and an expired record is refused', async () => {
    const sb = makeSandbox();
    try {
      const v9 = join(sb.code, 'v9');
      initGitRepo(v9);
      mkdirSync(join(v9, '.agents'), { recursive: true });
      const five = fiveSeatTeam('beacon-v9', v9, sb.home);
      writeFileSync(join(v9, '.agents', 'team.yaml'), five);
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);
      mkdirSync(join(elsewhere, '.agents'), { recursive: true });
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), fiveSeatTeam('elsewhere', elsewhere, sb.home));

      writeGrant(sb.home, 'beacon.yaml', SEAT_RECORD(FUTURE));

      // The record names builder-2 in dispatch: that seat is admitted where the runner is — the
      // early ask on the cwd and the late ask on the loaded root both pass — and the run goes on
      // to its own work, with no caller sentence on either way.
      const addIo = testIo(v9, seatOf('builder-2'));
      expect(await runAdd(['builder-3'], addIo, addSources(sb.home)), `${addIo.err}${addIo.out}`).toBe(1);
      expect(addIo.err).toBe('team add: herdr doesn\'t answer\n');

      const stopped = { n: 0 };
      const removeIo = testIo(v9, seatOf('builder-2'));
      expect(await runRemove(['builder-1'], removeIo, stopSources(sb.home, stopped)), `${removeIo.err}${removeIo.out}`).toBe(0);
      expect(removeIo.err).not.toContain('only the owner');
      const after = readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8');
      expect(after).not.toContain('builder-1');
      expect(after).toContain('builder-2');
      writeFileSync(join(v9, '.agents', 'team.yaml'), five);

      // Every seat, session and path the record does not name keeps today's caller sentence.
      for (const one of [
        { name: 'another seat', who: seatOf('tester-1'), cwd: v9 },
        { name: 'the named seat in another session', who: seatOf('builder-2', 'elsewhere'), cwd: v9 },
        { name: 'a team outside the covered path', who: seatOf('builder-2'), cwd: elsewhere },
      ]) {
        const add = testIo(one.cwd, one.who);
        expect(await runAdd(['builder-3'], add, addSources(sb.home)), one.name).toBe(1);
        expect(add.err, one.name).toContain('only the owner, the orchestrator or the operator runs it');
        const remove = testIo(one.cwd, one.who);
        expect(await runRemove(['builder-1'], remove, stopSources(sb.home, stopped)), one.name).toBe(1);
        expect(remove.err, one.name).toContain('only the owner, the orchestrator or the operator runs it');
      }

      // An expired record admits nobody, the seat it names included.
      writeGrant(sb.home, 'beacon.yaml', SEAT_RECORD(PAST));
      const expired = testIo(v9, seatOf('builder-2'));
      expect(await runRemove(['builder-1'], expired, stopSources(sb.home, stopped))).toBe(1);
      expect(expired.err).toContain('only the owner, the orchestrator or the operator runs it');
      expect(readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8')).toBe(five);
      // No run but the admitted removal had an effect.
      expect(stopped.n).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('remove --keep is not granted, for the seat the record names and for its runner', async () => {
    const sb = makeSandbox();
    try {
      const v9 = join(sb.code, 'v9');
      initGitRepo(v9);
      mkdirSync(join(v9, '.agents'), { recursive: true });
      const five = fiveSeatTeam('beacon-v9', v9, sb.home);
      writeFileSync(join(v9, '.agents', 'team.yaml'), five);

      writeGrant(sb.home, 'beacon.yaml', SEAT_RECORD(FUTURE));
      const stopped = { n: 0 };
      // A non-lead `--keep` re-signs the approval, so the record does not admit it.
      const seat = testIo(v9, seatOf('builder-2'));
      expect(await runRemove(['builder-1', '--keep'], seat, stopSources(sb.home, stopped))).toBe(1);
      expect(seat.err).toContain('only the owner, the orchestrator or the operator runs it');
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      const runner = walkIo(v9, OUTSIDE_HERDR);
      expect(await runRemove(['builder-1', '--keep'], runner, stopSources(sb.home, stopped))).toBe(1);
      expect(runner.err).toBe(
        'team remove: only the owner, the orchestrator or the operator runs it; this call is unplaced (it doesn\'t run on a terminal)\n',
      );
      // A lead's `--keep` is a swap: the record is not the team file's swap grant.
      const swap = walkIo(v9, OUTSIDE_HERDR);
      expect(await runRemove(['orchestrator', '--keep'], swap, stopSources(sb.home, stopped))).toBe(1);
      expect(swap.err).toContain('swaps the orchestrator\'s or the operator\'s seat');
      // Not one of them touched the file.
      expect(readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8')).toBe(five);
      expect(stopped.n).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a lead seat is not granted on add either', async () => {
    const sb = makeSandbox();
    try {
      const v9 = join(sb.code, 'v9');
      initGitRepo(v9);
      mkdirSync(join(v9, '.agents'), { recursive: true });
      const five = fiveSeatTeam('beacon-v9', v9, sb.home);
      writeFileSync(join(v9, '.agents', 'team.yaml'), five);

      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      // The second half of a swap is the owner's: the record admits the caller for its own work,
      // never for a seat that leads.
      const add = walkIo(v9, OUTSIDE_HERDR);
      expect(await runAdd(['orchestrator'], add, addSources(sb.home))).toBe(1);
      expect(add.err).toContain('only the owner, the orchestrator or the operator runs it');
      const remove = walkIo(v9, OUTSIDE_HERDR);
      expect(await runRemove(['orchestrator'], remove, stopSources(sb.home, { n: 0 }))).toBe(1);
      expect(remove.err).toContain('only the owner removes the orchestrator\'s or the operator\'s seat');
      expect(readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8')).toBe(five);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
