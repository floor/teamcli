// Registry-id create-grant admission: a record that names an agent's registry id (`agt_` …) or its
// team's registry team id admits only the caller whose own registry record carries that id, placed
// in its pane by herdr. A record that names a name, a seat, a pane, a session or a runner process
// grants nothing, and a caller outside herdr has no registry record, so no record admits it.
// The records admit `init`, `up`, `status`, `down`, `add` and `remove` for the covered paths before
// expiry, and every larger rule around them holds: a path escape, another seat, another team, an
// expired record, `--restore`, and a lead seat's swap.
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
import { registerAgent, type AgentLifecycle } from '../src/registry/agents.ts';
import { LOG_FILE, readState } from '../src/state.ts';
import type { Machine } from '../src/watch/machine.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T11:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T10:59:59Z';
const EXACT_NOW = '2026-10-16T11:00:00Z';

const TEAM = 'aaaaaaaaaaaa';
const OTHER_TEAM = 'bbbbbbbbbbbb';

const IDLE = CLAUDE_IDLE;
const AMPLE: Machine = {
  loadPerCore: 0.2,
  memoryFree: 80,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};

const noLogin = { loggedIn: () => false, now: () => NOW };

/** Fake parents, nearest first, as `ps` would walk them: a run at no terminal and no agent. */
const parents = (...names: string[]): Process[] => names.map((name, i) => ({ pid: 900 - i, name }));
const NO_TTY = parents('zsh', 'launchd');
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

// These tests are about grants, so the team names its session: with the session omitted and an
// entity set, the session follows the entity (`<entity>-<project>`), and every expectation here
// reads the session under the project's own name.
function fiveSeatTeam(project: string, root: string, home: string): string {
  const lobby = join(home, '.config', 'team', 'lobbies', 'beacon');
  return `format: 1
project: ${project}
entity: beacon
session: ${project}
operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}${SEAT('builder', 'builder-1')}${SEAT('builder', 'builder-2')}${SEAT('tester', 'tester-1')}${SEAT('tester', 'tester-2')}`;
}

const grantedSeat = { kind: 'seat', name: 'orchestrator', pane: 'lead-pane', session: 'dispatch' } as const;
const otherSeat = { kind: 'seat', name: 'builder-1', pane: 'builder-pane', session: 'dispatch' } as const;

/** The registry record a seat has: the immutable id admission matches, and the reach (team, seat,
 *  session, pane) herdr places the caller by. */
function registerSeat(
  home: string,
  seat: string,
  pane: string,
  session = 'dispatch',
  team = TEAM,
  lifecycle: AgentLifecycle = 'running',
): string {
  return registerAgent(home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team, seat, session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle,
    by: 'owner',
  }).id;
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
  const base = realpathSync(mkdtempSync('/tmp/gri-'));
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

/** A record naming one registry agent id, covering the path the sandbox's projects sit under. */
const agentRecord = (agentId: string, expires: string): string =>
  `entity: beacon\nagent: ${agentId}\npaths:\n  - ~/Code/beacon\nexpires: "${expires}"\n`;

/** A record naming one registry team id. */
const teamRecord = (teamId: string, expires: string): string =>
  `team: ${teamId}\npaths:\n  - ~/Code/beacon\nexpires: "${expires}"\n`;

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
 *  is where a run the record admits stops: past the caller rule. */
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

describe("a create-grant's registry id", () => {
  test("the record's agent id admits init then up on a covered path before expiry", async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: 'beacon',
          grantee: { kind: 'agent', id: orchestrator },
          paths: ['~/Code/beacon'],
          expires: FUTURE,
        },
      ]);

      const v1 = join(sb.code, 'v1');
      initGitRepo(v1);
      const initIo = testIo(v1, grantedSeat);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(0);
      expect(existsSync(join(v1, '.agents', 'team.yaml'))).toBe(true);
      expect(initIo.out).toContain('a skeleton with one seat');
      // The run was placed as the registered seat, not the owner: the grant admitted it.
      expect(readFileSync(join(v1, '.agents', LOG_FILE), 'utf8')).toContain('init [orchestrator]');

      writeFileSync(join(v1, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v1', v1, sb.home));

      const up = launchedUp();
      const keys = terminal();
      const upIo = testIo(v1, grantedSeat);
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

  test('--restore is never granted, an expired record admits nobody, and a spelled holder grants nothing', async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      const v2 = join(sb.code, 'v2');
      initGitRepo(v2);

      // `--restore` is the one spelling the grant never admits, whatever record names the caller.
      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
      const restoreIo = testIo(v2, grantedSeat);
      expect(await runInit(['--restore'], restoreIo, sb.home, undefined, noLogin)).toBe(1);
      expect(restoreIo.err).toContain('only the owner runs');
      expect(existsSync(join(v2, '.agents', 'team.yaml'))).toBe(false);

      // An expired record — at the instant of expiry too.
      for (const expires of [PAST, EXACT_NOW]) {
        writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, expires));
        const expiredIo = testIo(v2, grantedSeat);
        expect(await runInit([], expiredIo, sb.home, undefined, noLogin), expires).toBe(1);
        expect(expiredIo.err).toContain('only the owner runs this');
        expect(existsSync(join(v2, '.agents', 'team.yaml'))).toBe(false);
      }

      // A name, a session or a runner process in place of the registry id: the record does not
      // even read as a grant, so the caller it once named is refused.
      for (const body of [
        `entity: beacon\nagent: orchestrator\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`,
        `entity: beacon\nagent: ${orchestrator}\nsession: dispatch\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`,
        `entity: beacon\nagent: ${orchestrator}\nrunner: gemini\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`,
      ]) {
        writeGrant(sb.home, 'beacon.yaml', body);
        expect(readEntityCreateGrants(sb.home), body).toEqual([]);
        const spelledIo = testIo(v2, grantedSeat);
        expect(await runInit([], spelledIo, sb.home, undefined, noLogin), body).toBe(1);
        expect(spelledIo.err, body).toContain('only the owner runs this');
      }

      // A caller outside herdr has no registry record: with a valid record standing, it is refused.
      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
      const detachedIo = walkIo(v2, NO_TTY);
      expect(await runInit([], detachedIo, sb.home, undefined, noLogin)).toBe(1);
      expect(detachedIo.err).toBe('team init: only the owner runs this, from a terminal outside herdr\n');
      expect(existsSync(join(v2, '.agents', 'team.yaml'))).toBe(false);

      // Another seat, registered and placed but with its own id, is refused by both commands.
      registerSeat(sb.home, 'builder-1', 'builder-pane');
      const otherInitIo = testIo(v2, otherSeat);
      expect(await runInit([], otherInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(otherInitIo.err).toBe(
        'team init: only the owner runs this, from a terminal outside herdr; this call is builder-1\n',
      );

      mkdirSync(join(v2, '.agents'), { recursive: true });
      writeFileSync(join(v2, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v2', v2, sb.home));
      const otherUpIo = testIo(v2, otherSeat);
      expect(await runUp([], otherUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(otherUpIo.err).toBe('deny\n');
      expect(otherUpIo.out).toBe('');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a record whose lifecycle is not running admits nobody', async () => {
    const sb = makeSandbox();
    try {
      // The seat's own record, on the pane and in the session the caller stands in, but
      // stopped: only a running seat acts as its own record, as send's identity rule holds.
      const stopped = registerSeat(sb.home, 'orchestrator', 'lead-pane', 'dispatch', TEAM, 'stopped');
      writeGrant(sb.home, 'beacon.yaml', agentRecord(stopped, FUTURE));
      const v3 = join(sb.code, 'v3');
      initGitRepo(v3);
      const stoppedIo = testIo(v3, grantedSeat);
      expect(await runInit([], stoppedIo, sb.home, undefined, noLogin)).toBe(1);
      expect(stoppedIo.err).toContain('only the owner runs this');
      expect(existsSync(join(v3, '.agents', 'team.yaml'))).toBe(false);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses a granted caller on a path the record does not cover', async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
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
        const io = testIo(cwd, grantedSeat);
        expect(await runInit([], io, sb.home, undefined, noLogin), cwd).toBe(1);
        expect(io.err, cwd).toContain('only the owner runs this');
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
        const io = testIo(cwd, grantedSeat);
        expect(await runUp([], io, upSources(sb.home, launching(() => {}), terminal())), cwd).toBe(1);
        expect(io.err, cwd).toBe('deny\n');
      }
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

  test("status and down reach the covered team for the record's seat, and refuse every other caller", async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      registerSeat(sb.home, 'builder-1', 'builder-pane');
      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
      const v7 = join(sb.code, 'v7');
      initGitRepo(v7);
      mkdirSync(join(v7, '.agents'), { recursive: true });
      writeFileSync(join(v7, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v7', v7, sb.home));

      const granted = testIo(v7, grantedSeat);
      const code = await runStatus([], granted, statusSources(sb.home));
      expect(code, `${granted.err}${granted.out}`).not.toBe(2);
      expect(granted.out).toContain('team beacon-v7, session "beacon-v7"');
      expect(granted.err).not.toContain('this team is not yours to read');
      // The read alone: a granted run keeps no remembered copy the way the owner's run does.
      expect(readState(join(v7, '.agents')).last_valid).toBeUndefined();

      // A team under no granted path, for the scene below that aims the covered seat at it.
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);
      mkdirSync(join(elsewhere, '.agents'), { recursive: true });
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), fiveSeatTeam('elsewhere', elsewhere, sb.home));

      const cases: { name: string; body: string; cwd: string; who: typeof grantedSeat | typeof otherSeat }[] = [
        { name: 'another seat', body: agentRecord(orchestrator, FUTURE), cwd: v7, who: otherSeat },
        { name: 'an expired record', body: agentRecord(orchestrator, PAST), cwd: v7, who: grantedSeat },
        { name: 'a team outside the covered path', body: agentRecord(orchestrator, FUTURE), cwd: elsewhere, who: grantedSeat },
      ];
      for (const one of cases) {
        writeGrant(sb.home, 'beacon.yaml', one.body);
        const io = testIo(one.cwd, one.who);
        expect(await runStatus([], io, statusSources(sb.home)), one.name).toBe(2);
        expect(io.err, one.name).toBe('team status: this team is not yours to read\n');
        expect(io.out, one.name).toBe('');
      }
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test("down stops a covered team for the record's seat, and refuses every other stop", async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      registerSeat(sb.home, 'builder-1', 'builder-pane');
      const v8 = join(sb.code, 'v8');
      initGitRepo(v8);
      mkdirSync(join(v8, '.agents'), { recursive: true });
      writeFileSync(join(v8, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v8', v8, sb.home));
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);
      mkdirSync(join(elsewhere, '.agents'), { recursive: true });
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), fiveSeatTeam('elsewhere', elsewhere, sb.home));

      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
      const stopped = { n: 0 };
      const granted = testIo(v8, grantedSeat);
      const code = await runDown([], granted, stopSources(sb.home, stopped));
      expect(code, `${granted.err}${granted.out}`).toBe(0);
      expect(stopped.n).toBe(1);
      // Both sentences this run would otherwise carry are absent — the detached one and the
      // caller rule.
      expect(granted.err).not.toContain('only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane');
      expect(granted.err).not.toContain('stops the team');

      const cases: { name: string; body: string; cwd: string; who: typeof grantedSeat | typeof otherSeat }[] = [
        { name: 'another seat', body: agentRecord(orchestrator, FUTURE), cwd: v8, who: otherSeat },
        { name: 'an expired record', body: agentRecord(orchestrator, PAST), cwd: v8, who: grantedSeat },
        { name: 'a team outside the covered path', body: agentRecord(orchestrator, FUTURE), cwd: elsewhere, who: grantedSeat },
      ];
      for (const one of cases) {
        writeGrant(sb.home, 'beacon.yaml', one.body);
        const io = testIo(one.cwd, one.who);
        expect(await runDown([], io, stopSources(sb.home, stopped)), one.name).toBe(1);
        expect(io.err, one.name).toContain('only the owner or `leads` stops the team');
      }
      // No refused run stopped anything: the count is the one admitted run's.
      expect(stopped.n).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test("add and remove reach their own work for the record's seat, and hold every other caller out", async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      const builder = registerSeat(sb.home, 'builder-1', 'builder-pane');
      const v9 = join(sb.code, 'v9');
      initGitRepo(v9);
      mkdirSync(join(v9, '.agents'), { recursive: true });
      const five = fiveSeatTeam('beacon-v9', v9, sb.home);
      writeFileSync(join(v9, '.agents', 'team.yaml'), five);
      const elsewhere = join(sb.home, 'Code', 'elsewhere');
      initGitRepo(elsewhere);
      // A team of its own, so the run reaches the caller rule rather than a missing file.
      mkdirSync(join(elsewhere, '.agents'), { recursive: true });
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), fiveSeatTeam('beacon-elsewhere', elsewhere, sb.home));

      writeGrant(sb.home, 'beacon.yaml', agentRecord(orchestrator, FUTURE));
      // The record admits the run, which goes on to its own work: a granted caller meets neither
      // the detached sentence nor the caller rule. `add` stops at its first herdr read, and
      // `remove` takes the seat out of the file — no caller sentence on either way.
      const addIo = testIo(v9, grantedSeat);
      expect(await runAdd(['builder-2'], addIo, addSources(sb.home)), `${addIo.err}${addIo.out}`).toBe(1);
      expect(addIo.err).toBe('team add: herdr doesn\'t answer\n');

      const stopped = { n: 0 };
      const removeIo = testIo(v9, grantedSeat);
      expect(await runRemove(['builder-1'], removeIo, stopSources(sb.home, stopped)), `${removeIo.err}${removeIo.out}`).toBe(0);
      expect(removeIo.err).not.toContain('only the owner');
      const after = readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8');
      expect(after).not.toContain('builder-1');
      expect(after).toContain('builder-2');

      // The seat is put back for the scenes below: each of them refuses before any file read,
      // so none may touch it.
      const before = fiveSeatTeam('beacon-v9', v9, sb.home);
      writeFileSync(join(v9, '.agents', 'team.yaml'), before);

      // Every caller the record does not admit keeps today's lines, unchanged.
      for (const one of [
        { name: 'another seat', cwd: v9, who: otherSeat },
        { name: 'a team outside the covered path', cwd: elsewhere, who: grantedSeat },
      ]) {
        const add = testIo(one.cwd, one.who);
        expect(await runAdd(['builder-2'], add, addSources(sb.home)), `${one.name}: ${add.err}${add.out}`).toBe(1);
        expect(add.err, one.name).toContain('only the owner or a standing grant (delegate) runs this');
        const remove = testIo(one.cwd, one.who);
        expect(await runRemove(['builder-2'], remove, stopSources(sb.home, stopped)), one.name).toBe(1);
        expect(remove.err, one.name).toContain('only the owner or `leads` removes a seat');
      }

      // A lead seat's work is the owner's: the record admits the caller for its own work only.
      const leadAdd = testIo(v9, grantedSeat);
      expect(await runAdd(['orchestrator'], leadAdd, addSources(sb.home))).toBe(1);
      expect(leadAdd.err).toContain('only the owner or a standing grant (delegate) runs this');
      // A lead's `--keep` is a swap, and the record's own seat can't swap itself.
      const leadRemove = testIo(v9, grantedSeat);
      expect(await runRemove(['orchestrator', '--keep'], leadRemove, stopSources(sb.home, stopped))).toBe(1);
      expect(leadRemove.err).toContain("can't swap its own seat");
      // Nor does the record let another seat swap a lead: that is the file's `grant` alone.
      writeGrant(sb.home, 'beacon.yaml', agentRecord(builder, FUTURE));
      const builderRemove = testIo(v9, otherSeat);
      expect(await runRemove(['orchestrator', '--keep'], builderRemove, stopSources(sb.home, stopped))).toBe(1);
      expect(builderRemove.err).toContain("swaps the orchestrator's or the operator's seat");
      // No run but the admitted removal had an effect.
      expect(stopped.n).toBe(0);
      expect(readFileSync(join(v9, '.agents', 'team.yaml'), 'utf8')).toBe(before);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test("a team-id record admits a seat of that team, and no other team's seat", async () => {
    const sb = makeSandbox();
    try {
      registerSeat(sb.home, 'orchestrator', 'lead-pane', 'dispatch', TEAM);
      registerSeat(sb.home, 'builder-1', 'builder-pane', 'dispatch', OTHER_TEAM);
      writeGrant(sb.home, 'beacon.yaml', teamRecord(TEAM, FUTURE));
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: null,
          grantee: { kind: 'team', id: TEAM },
          paths: ['~/Code/beacon'],
          expires: FUTURE,
        },
      ]);

      const v10 = join(sb.code, 'v10');
      initGitRepo(v10);
      mkdirSync(join(v10, '.agents'), { recursive: true });
      writeFileSync(join(v10, '.agents', 'team.yaml'), fiveSeatTeam('beacon-v10', v10, sb.home));

      const granted = testIo(v10, grantedSeat);
      expect(await runStatus([], granted, statusSources(sb.home)), `${granted.err}${granted.out}`).not.toBe(2);
      expect(granted.out).toContain('team beacon-v10, session "beacon-v10"');

      // The other team's seat is placed and live in the same home, so its refusal is the team
      // mismatch, not a missing record.
      const outsider = testIo(v10, otherSeat);
      expect(await runStatus([], outsider, statusSources(sb.home))).toBe(2);
      expect(outsider.err).toBe('team status: this team is not yours to read\n');

      // A team spelled by name is not an id: the record grants nothing.
      writeGrant(
        sb.home,
        'named.yaml',
        `team: beacon\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: null,
          grantee: { kind: 'team', id: TEAM },
          paths: ['~/Code/beacon'],
          expires: FUTURE,
        },
      ]);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
