// Standing entity create-grants in `~/.config/team/grants/`: `init` and `up` admit the agent or
// team whose registry id a record names, under a covered path before expiry with no team-file
// grant, and refuse path escapes, other agents, expired records, and paths outside the roots the
// entity declares in `~/.config/team/entities.yaml`. A record that spells its holder as a name,
// seat, pane, session or runner process grants nothing. Every fixture path sits under the
// sandbox's own temp home.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/commands/init.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { declaredRoots, entitiesPath } from '../../src/entities.ts';
import { createGrantGrantee, createGrantPathProblem, grantsDir, readEntityCreateGrants } from '../../src/grant.ts';
import type { Terminal } from '../../src/launch/terminal.ts';
import { registerAgent } from '../../src/registry/agents.ts';
import { readState } from '../../src/state.ts';
import { storePath } from '../../src/store/store.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-16T10:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T09:59:59Z';
const EXACT_NOW = '2026-10-16T10:00:00Z';

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
  const lobby = join(home, '.config', 'team', 'lobbies', 'acme');
  return `format: 1
project: ${project}
session: ${project}
entity: acme
operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}${SEAT('builder', 'builder-1')}${SEAT('builder', 'builder-2')}${SEAT('tester', 'tester-1')}${SEAT('tester', 'tester-2')}# The send scenes here walk the typed trigger: the inbox is tried and skipped for want of a
# listener, then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

const grantedAgent = { kind: 'seat', name: 'orchestrator', pane: 'lead-pane', session: 'dispatch' } as const;
const otherAgent = { kind: 'seat', name: 'builder-1', pane: 'other-pane', session: 'dispatch' } as const;
const wrongSessionAgent = { kind: 'seat', name: 'orchestrator', pane: 'lead-pane', session: 'elsewhere' } as const;

const TEAM = 'aaaaaaaaaaaa';
const OTHER_TEAM = 'bbbbbbbbbbbb';

/** The identity rule every record check ends with: a registry id, nothing else. */
const RULE =
  'a create-grant names its holder by registry agent id (`agt_` …) or its team by registry team id, never by a name, a seat, a pane, a session or a runner';

/** The registry record a granted seat has: the immutable id admission matches, and the reach
 *  (team, seat, session, pane) herdr places the caller by. */
function registerSeat(
  home: string,
  seat: string,
  pane: string,
  session = 'dispatch',
  team = TEAM,
): string {
  return registerAgent(home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team, seat, session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
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
  const base = realpathSync(mkdtempSync('/tmp/eg-'));
  const home = join(base, 'home');
  mkdirSync(grantsDir(home), { recursive: true });
  const code = join(home, 'Code', 'acme');
  const lab = join(home, 'Code', 'acme-lab');
  const outside = join(home, 'Code', 'other-repo');
  mkdirSync(code, { recursive: true });
  mkdirSync(lab, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { base, home, code, lab, outside };
}

/** The owner's entities file: `<entity>:` entries with a `roots:` sequence. */
function writeEntities(home: string, body: string): void {
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(entitiesPath(home), body);
}

function writeGrant(home: string, name: string, body: string): void {
  mkdirSync(grantsDir(home), { recursive: true });
  writeFileSync(join(grantsDir(home), name), body);
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
    sleep: async () => {},
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

describe('entity create-grant in ~/.config/team/grants/', () => {
  test("a record's own paths are admitted when they sit within the entity's declared roots", async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n    - ~/Code/acme-lab\n');
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\npaths:\n  - ~/Code/acme\n  - ~/Code/acme-lab\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: 'acme',
          grantee: { kind: 'agent', id: orchestrator },
          paths: ['~/Code/acme', '~/Code/acme-lab'],
          expires: FUTURE,
        },
      ]);

      // 1. Under ~/Code/acme/v4: init and up succeed for the granted agent, and the five seats
      // launch concurrently with no prompt and receive their first brief.
      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      const initIo = testIo(v4, grantedAgent);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(0);
      expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(true);

      // Write the 5-seat team file (1 orchestrator, 2 builders, 2 testers) with no grant or delegates.
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));

      let launches = 0;
      let idleAt: number | null = null;
      let clock = NOW.getTime();
      const host = launching(() => {
        launches += 1;
      });
      host.paneText = () => {
        if (launches < 5) return '';
        if (idleAt === null) idleAt = launches;
        return IDLE;
      };
      host.sleep = async (ms) => {
        clock += ms;
      };
      host.now = () => new Date(clock);
      const keys = terminal();
      const upIo = testIo(v4, grantedAgent);
      const upCode = await runUp([], upIo, {
        ...upSources(sb.home, host, keys, new Date(clock)),
        now: () => new Date(clock),
        sleep: host.sleep,
      });
      expect(upCode, `${upIo.err}${upIo.out}`).toBe(0);
      expect(launches).toBeGreaterThanOrEqual(5);
      expect(idleAt).not.toBeNull();
      expect(idleAt!).toBeGreaterThanOrEqual(5);
      expect(keys.reads).toBe(0);
      expect(host.closed).toBe(0);
      expect(existsSync(join(storePath('acme-v4', v4, sb.home), 'approval.json'))).toBe(false);

      const seats = readState(join(v4, '.agents')).sessions['acme-v4']?.seats ?? {};
      for (const name of ['orchestrator', 'builder-1', 'builder-2', 'tester-1', 'tester-2']) {
        expect(seats[name]?.stage, name).toBe('ready');
      }

      // The owner sends the brief: an orchestrator's own-team seats are outside the reach the
      // send rules admit, and this scene is about the create-grant covering init and up.
      const sendIo = testIo(v4, { kind: 'owner' });
      // The seat takes the brief: idle until the Enter, working after it.
      let working = false;
      const sendHost: SendHost = {
        agents: () => [{ name: 'builder-1', pane: seats['builder-1']?.pane ?? 'seat-pane-2' }],
        processInfo: () => ({ shell: 1, foreground: [2] }),
        socketsDir: join(sb.base, 'socks'),
        deliver: async () => ({ ok: true }),
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
        home: sb.home,
        daemonSocket: join(sb.base, 'no-daemon.sock'),
      };
      mkdirSync(sendHost.socketsDir, { recursive: true });
      expect(await runSend(['builder-1', 'first brief'], sendIo, sendHost)).toBe(0);
      // No socket file under the host's sockets folder: a plain send is the typed trigger, and
      // the outcome names the trigger sent, never a read.
      expect(sendIo.out).toBe(
        'team acme-v4, session "acme-v4"\nbuilder-1: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
      );

      // 2. Under ~/Code/acme-lab/archive: also admitted by the same record.
      const archive = join(sb.lab, 'archive');
      initGitRepo(archive);
      const labInitIo = testIo(archive, grantedAgent);
      expect(await runInit([], labInitIo, sb.home, undefined, noLogin)).toBe(0);
      writeFileSync(join(archive, '.agents', 'team.yaml'), fiveSeatTeam('acme-archive', archive, sb.home));
      const labUpIo = testIo(archive, grantedAgent);
      expect(await runUp(['--dry-run'], labUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(0);
      expect(labUpIo.out).toContain('builder-1');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('an entity that omits paths covers the roots it declares', async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme: { roots: [~/Code/acme] }\n');
      expect(declaredRoots(sb.home).get('acme')).toEqual(['~/Code/acme']);
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: 'acme',
          grantee: { kind: 'agent', id: orchestrator },
          paths: ['~/Code/acme'],
          expires: FUTURE,
        },
      ]);

      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      expect(await runInit([], testIo(v4, grantedAgent), sb.home, undefined, noLogin)).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('an entity that declares no roots grants nothing; explicit paths still admit', async () => {
    const sb = makeSandbox();
    try {
      // No entities file at all: the record names an entity and no paths, so it covers nothing.
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(
        sb.home,
        'ghost.yaml',
        `entity: ghost\nagent: ${orchestrator}\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([]);

      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      const ghostInitIo = testIo(v4, grantedAgent);
      expect(await runInit([], ghostInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(ghostInitIo.err).toContain('only the owner runs this');
      expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(false);

      mkdirSync(join(v4, '.agents'), { recursive: true });
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));
      const ghostUpIo = testIo(v4, grantedAgent);
      expect(await runUp([], ghostUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(ghostUpIo.err).toBe('deny\n');

      // The same undeclared entity, now naming its own path: that path is the record's cover.
      writeGrant(
        sb.home,
        'ghost.yaml',
        `entity: ghost\nagent: ${orchestrator}\npaths:\n  - ~/Code/acme\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home).map((grant) => grant.paths)).toEqual([['~/Code/acme']]);
      const explicitInitIo = testIo(v4, grantedAgent);
      // The skeleton is already there from the owner's scene above, so init refuses for its own
      // reason; the record's cover is what `up` reads.
      expect(await runInit([], explicitInitIo, sb.home, undefined, noLogin)).toBe(1);
      const explicitUpIo = testIo(v4, grantedAgent);
      expect(await runUp(['--dry-run'], explicitUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(0);
      expect(explicitUpIo.out).toContain('builder-1');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test("a path outside the entity's declared roots is refused with a reason", async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n');
      const roots = declaredRoots(sb.home).get('acme') ?? [];
      expect(createGrantPathProblem('~/Code/acme/v4', roots, sb.home, 'acme')).toBeNull();
      expect(createGrantPathProblem('~/Code/other-repo', roots, sb.home, 'acme')).toBe(
        'the path "~/Code/other-repo" is outside acme\'s declared roots',
      );
      expect(createGrantPathProblem('~/Code/acme/../other-repo', roots, sb.home, 'acme')).toContain(
        'never cover',
      );
      expect(createGrantPathProblem('Code/acme', roots, sb.home, 'acme')).toContain('neither absolute nor under ~');

      // One path inside the roots and one beside them: the record keeps only the inside one.
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\npaths:\n  - ~/Code/acme\n  - ~/Code/other-repo\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home).map((grant) => grant.paths)).toEqual([['~/Code/acme']]);

      // A record that names only the outside path covers nothing: init and up both deny.
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\npaths:\n  - ~/Code/other-repo\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([]);
      const outside = join(sb.outside, 'v4');
      initGitRepo(outside);
      const outsideInitIo = testIo(outside, grantedAgent);
      expect(await runInit([], outsideInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(outsideInitIo.err).toContain('only the owner runs this');

      mkdirSync(join(outside, '.agents'), { recursive: true });
      writeFileSync(join(outside, '.agents', 'team.yaml'), fiveSeatTeam('other-repo', outside, sb.home));
      const outsideUpIo = testIo(outside, grantedAgent);
      expect(await runUp([], outsideUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(outsideUpIo.err).toBe('deny\n');

      // The engine still runs for a record inside the roots.
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\npaths:\n  - ~/Code/acme\nexpires: "${FUTURE}"\n`,
      );
      const inside = join(sb.code, 'v4');
      initGitRepo(inside);
      expect(await runInit([], testIo(inside, grantedAgent), sb.home, undefined, noLogin)).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('an unreadable entities file declares no roots', async () => {
    const sb = makeSandbox();
    try {
      expect(declaredRoots(sb.home).size).toBe(0);
      writeEntities(sb.home, 'acme: [unclosed\n');
      expect(declaredRoots(sb.home).size).toBe(0);
      writeEntities(sb.home, 'acme:\n  elsewhere: ~/Code/acme\n');
      expect(declaredRoots(sb.home).size).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses another agent on both init and up', async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n');
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      // The other seat is placed and live too, so its refusal is the id mismatch, not a missing record.
      registerSeat(sb.home, 'builder-1', 'other-pane');
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\nexpires: "${FUTURE}"\n`,
      );
      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);

      for (const stranger of [otherAgent, wrongSessionAgent, { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' } as const]) {
        const initIo = testIo(v4, stranger);
        expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
        expect(initIo.err).toContain('only the owner runs this');
        expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(false);
      }

      mkdirSync(join(v4, '.agents'), { recursive: true });
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));

      for (const stranger of [otherAgent, wrongSessionAgent]) {
        const upIo = testIo(v4, stranger);
        expect(await runUp([], upIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
        expect(upIo.err).toBe('deny\n');
        expect(upIo.out).toBe('');
      }
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses an expired grant on both init and up', async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n');
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);

      for (const expires of [PAST, EXACT_NOW]) {
        writeGrant(
          sb.home,
          'acme.yaml',
          `entity: acme\nagent: ${orchestrator}\nexpires: "${expires}"\n`,
        );
        const initIo = testIo(v4, grantedAgent);
        expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
        expect(initIo.err).toContain('only the owner runs this');
        expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(false);
      }

      mkdirSync(join(v4, '.agents'), { recursive: true });
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));

      for (const expires of [PAST, EXACT_NOW]) {
        writeGrant(
          sb.home,
          'acme.yaml',
          `entity: acme\nagent: ${orchestrator}\nexpires: "${expires}"\n`,
        );
        const upIo = testIo(v4, grantedAgent);
        expect(await runUp([], upIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
        expect(upIo.err).toBe('deny\n');
      }
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses path escape via symlink and .. traversal on both init and up', async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n');
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nagent: ${orchestrator}\npaths:\n  - ~/Code/acme\nexpires: "${FUTURE}"\n`,
      );

      // An outside repository not covered by the record.
      const outside = sb.outside;
      initGitRepo(outside);

      // 1. Symlink inside ~/Code/acme pointing out to ~/Code/other-repo.
      const symlinkedRepo = join(sb.code, 'escaped-link');
      symlinkSync(outside, symlinkedRepo);

      const symInitIo = testIo(symlinkedRepo, grantedAgent);
      expect(await runInit([], symInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(symInitIo.err).toContain('only the owner runs this');
      expect(existsSync(join(outside, '.agents', 'team.yaml'))).toBe(false);

      // 2. `..` traversal in cwd (`~/Code/acme/v4/../../other-repo`).
      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      const dotDotCwd = `${v4}/../../other-repo`;
      const dotInitIo = testIo(dotDotCwd, grantedAgent);
      expect(await runInit([], dotInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(dotInitIo.err).toContain('only the owner runs this');

      // 3. Prefix sibling (`~/Code/acme-evil`) is not under `~/Code/acme`.
      const sibling = join(sb.home, 'Code', 'acme-evil');
      initGitRepo(sibling);
      const sibInitIo = testIo(sibling, grantedAgent);
      expect(await runInit([], sibInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(sibInitIo.err).toContain('only the owner runs this');

      // Prepare team files in outside and sibling to verify `up` also denies symlink, `..`, and prefix escapes.
      mkdirSync(join(outside, '.agents'), { recursive: true });
      writeFileSync(join(outside, '.agents', 'team.yaml'), fiveSeatTeam('other-repo', outside, sb.home));
      mkdirSync(join(sibling, '.agents'), { recursive: true });
      writeFileSync(join(sibling, '.agents', 'team.yaml'), fiveSeatTeam('acme-evil', sibling, sb.home));

      for (const badCwd of [symlinkedRepo, dotDotCwd, sibling]) {
        const upIo = testIo(badCwd, grantedAgent);
        expect(await runUp([], upIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
        expect(upIo.err).toBe('deny\n');
      }

      // 4. A grant file that itself writes `..` in `paths` (`~/Code/acme/../other-repo`) is refused.
      writeGrant(
        sb.home,
        'escaped.yaml',
        `entity: escaped\nagent: ${orchestrator}\npaths:\n  - ~/Code/acme/../other-repo\nexpires: "${FUTURE}"\n`,
      );
      const escapedUpIo = testIo(outside, grantedAgent);
      expect(await runUp([], escapedUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(escapedUpIo.err).toBe('deny\n');

      // 5. A symlinked `.agents/team.yaml` inside an otherwise covered repo is refused.
      const outsideTeamYaml = join(outside, 'v4-team.yaml');
      writeFileSync(outsideTeamYaml, fiveSeatTeam('acme-v4', v4, sb.home));
      mkdirSync(join(v4, '.agents'), { recursive: true });
      symlinkSync(outsideTeamYaml, join(v4, '.agents', 'team.yaml'));
      const linkedFileUpIo = testIo(v4, grantedAgent);
      expect(await runUp([], linkedFileUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(linkedFileUpIo.err).toBe('deny\n');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a record naming anything but a registry id grants nothing, and the check says why', async () => {
    const sb = makeSandbox();
    try {
      const orchestrator = registerSeat(sb.home, 'orchestrator', 'lead-pane');
      expect(createGrantGrantee({ agent: orchestrator })).toEqual({
        ok: true,
        grantee: { kind: 'agent', id: orchestrator },
      });
      expect(createGrantGrantee({ team: TEAM })).toEqual({ ok: true, grantee: { kind: 'team', id: TEAM } });

      const refused: [Record<string, unknown>, string][] = [
        [{ agent: 'orchestrator' }, 'the record names "orchestrator" in `agent`, which is not a registry agent id'],
        [{ agent: 'dispatch/orchestrator' }, 'the record names "dispatch/orchestrator" in `agent`, which is not a registry agent id'],
        [{ team: 'acme' }, 'the record names "acme" in `team`, which is not a registry team id'],
        [{ seat: 'orchestrator' }, 'the record names a seat "orchestrator" in `seat`'],
        [{ pane: 'lead-pane' }, 'the record names a pane "lead-pane" in `pane`'],
        [{ session: 'dispatch' }, 'the record names a session "dispatch" in `session`'],
        [{ runner: 'gemini' }, 'the record names a runner process in `runner`'],
        [{ runners: ['gemini'] }, 'the record names a runner process in `runners`'],
        [{ agent: orchestrator, team: TEAM }, 'the record names both `agent` and `team`'],
        [{}, 'the record names no holder'],
      ];
      for (const [record, why] of refused) {
        const named = createGrantGrantee(record);
        expect(named.ok, JSON.stringify(record)).toBe(false);
        if (named.ok) continue;
        expect(named.why.startsWith(why), named.why).toBe(true);
        expect(named.why.endsWith(`: ${RULE}`), named.why).toBe(true);
      }

      // A record spelled any of those ways grants nothing: the caller it would once have admitted
      // is refused by both commands, and the record does not even read as a grant.
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n');
      writeGrant(
        sb.home,
        'legacy.yaml',
        `entity: acme\nagent: orchestrator\nsession: dispatch\nexpires: "${FUTURE}"\n`,
      );
      writeGrant(
        sb.home,
        'runner.yaml',
        `entity: acme\nagent: ${orchestrator}\nrunner: gemini\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([]);

      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      const initIo = testIo(v4, grantedAgent);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
      expect(initIo.err).toContain('only the owner runs this');
      expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(false);

      mkdirSync(join(v4, '.agents'), { recursive: true });
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));
      const upIo = testIo(v4, grantedAgent);
      expect(await runUp([], upIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(upIo.err).toBe('deny\n');
      expect(upIo.out).toBe('');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test("a team-id record admits a seat of that team, and no other team's seat", async () => {
    const sb = makeSandbox();
    try {
      writeEntities(sb.home, 'acme:\n  roots:\n    - ~/Code/acme\n');
      writeGrant(
        sb.home,
        'team.yaml',
        `team: ${TEAM}\npaths:\n  - ~/Code/acme\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: null,
          grantee: { kind: 'team', id: TEAM },
          paths: ['~/Code/acme'],
          expires: FUTURE,
        },
      ]);
      registerSeat(sb.home, 'orchestrator', 'lead-pane');

      const v4 = join(sb.code, 'v4');
      initGitRepo(v4);
      expect(await runInit([], testIo(v4, grantedAgent), sb.home, undefined, noLogin)).toBe(0);

      // A seat of another team is placed and live in the same home, so its refusal is the team
      // mismatch, not a missing record.
      registerSeat(sb.home, 'builder-1', 'other-pane', 'dispatch', OTHER_TEAM);
      const v5 = join(sb.code, 'v5');
      initGitRepo(v5);
      const outsiderIo = testIo(v5, otherAgent);
      expect(await runInit([], outsiderIo, sb.home, undefined, noLogin)).toBe(1);
      expect(outsiderIo.err).toContain('only the owner runs this');
      expect(existsSync(join(v5, '.agents', 'team.yaml'))).toBe(false);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
