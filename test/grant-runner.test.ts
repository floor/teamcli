// A create-grant's `runner`: a caller outside herdr whose parent processes include the name the
// record lists is admitted for `init` and `up` on the covered paths before expiry, and every
// refusal around it holds — a name not in the ancestry, an expired record, a record with no
// runner, a path escape, and a caller under herdr whose ancestry happens to carry the name.
// The commands are driven through the walker: the fake ancestors are injected as the real
// `callerSources`, so `callerOf`/`walkCaller` place the call exactly as they would a live one.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Process } from '../src/caller.ts';
import { runInit } from '../src/commands/init.ts';
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
