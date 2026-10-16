// Standing entity create-grants in `~/.config/team/grants/`: `init` and `up` admit the named
// agent under a covered path before expiry with no team-file grant, and refuse path escapes,
// other agents, and expired records.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/commands/init.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { grantsDir, readEntityCreateGrants } from '../../src/grant.ts';
import type { Terminal } from '../../src/launch/terminal.ts';
import { readState } from '../../src/state.ts';
import { storePath } from '../../src/store/store.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-16T10:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T09:59:59Z';
const EXACT_NOW = '2026-10-16T10:00:00Z';

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
  const lobby = join(home, '.config', 'team', 'lobbies', 'acme');
  return `format: 1
project: ${project}
entity: acme
operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}${SEAT('builder', 'builder-1')}${SEAT('builder', 'builder-2')}${SEAT('tester', 'tester-1')}${SEAT('tester', 'tester-2')}`;
}

const grantedAgent = { kind: 'seat', name: 'orchestrator', pane: 'lead-pane', session: 'dispatch' } as const;
const otherAgent = { kind: 'seat', name: 'builder-1', pane: 'other-pane', session: 'dispatch' } as const;
const wrongSessionAgent = { kind: 'seat', name: 'orchestrator', pane: 'lead-pane', session: 'elsewhere' } as const;

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
  const acmeCode = join(home, 'Code', 'acme');
  const acmeDocs = join(home, 'Documents', 'acme');
  mkdirSync(acmeCode, { recursive: true });
  mkdirSync(acmeDocs, { recursive: true });
  return { base, home, acmeCode, acmeDocs };
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
  test('acme grant covers ~/Code/acme and ~/Documents/acme for init and up with no team-file grant', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nsession: dispatch\nagent: orchestrator\npaths:\n  - ~/Code/acme\n  - ~/Documents/acme\nexpires: "${FUTURE}"\n`,
      );
      expect(readEntityCreateGrants(sb.home)).toEqual([
        {
          entity: 'acme',
          session: 'dispatch',
          agent: 'orchestrator',
          paths: ['~/Code/acme', '~/Documents/acme'],
          expires: FUTURE,
          runners: [],
        },
      ]);

      // 1. Under ~/Code/acme/v4: init and up succeed for the granted agent, and the five seats
      // launch concurrently with no prompt and receive their first brief.
      const v4 = join(sb.acmeCode, 'v4');
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

      const leadCaller = { kind: 'seat', name: 'orchestrator', pane: seats.orchestrator?.pane ?? 'seat-pane-1', session: 'acme-v4' } as const;
      const sendIo = testIo(v4, leadCaller);
      const sendHost: SendHost = {
        agents: () => [{ name: 'builder-1', pane: seats['builder-1']?.pane ?? 'seat-pane-2' }],
        processInfo: () => ({ shell: 1, foreground: [2] }),
        socketsDir: join(sb.base, 'socks'),
        deliver: async () => ({ ok: true }),
        native: {
          typeText: () => true,
          pressEnter: () => true,
          status: () => 'working',
          wait: async () => {},
        },
        now: () => NOW,
        home: sb.home,
        daemonSocket: join(sb.base, 'no-daemon.sock'),
      };
      mkdirSync(sendHost.socketsDir, { recursive: true });
      expect(await runSend(['builder-1', 'first brief'], sendIo, sendHost)).toBe(0);
      expect(sendIo.out).toContain('builder-1: delivered\n');

      // 2. Under ~/Documents/acme/archive: also admitted by the same acme grant.
      const archive = join(sb.acmeDocs, 'archive');
      initGitRepo(archive);
      const docsInitIo = testIo(archive, grantedAgent);
      expect(await runInit([], docsInitIo, sb.home, undefined, noLogin)).toBe(0);
      writeFileSync(join(archive, '.agents', 'team.yaml'), fiveSeatTeam('radio-archive', archive, sb.home));
      const docsUpIo = testIo(archive, grantedAgent);
      expect(await runUp(['--dry-run'], docsUpIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(0);
      expect(docsUpIo.out).toContain('builder-1');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('refuses another agent on both init and up', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nsession: dispatch\nagent: orchestrator\npaths:\n  - ~/Code/acme\n  - ~/Documents/acme\nexpires: "${FUTURE}"\n`,
      );
      const v4 = join(sb.acmeCode, 'v4');
      initGitRepo(v4);

      for (const stranger of [otherAgent, wrongSessionAgent, { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' } as const]) {
        const initIo = testIo(v4, stranger);
        expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
        expect(initIo.err).toContain('only the owner runs init');
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
      const v4 = join(sb.acmeCode, 'v4');
      initGitRepo(v4);

      for (const expires of [PAST, EXACT_NOW]) {
        writeGrant(
          sb.home,
          'acme.yaml',
          `entity: acme\nsession: dispatch\nagent: orchestrator\npaths:\n  - ~/Code/acme\n  - ~/Documents/acme\nexpires: "${expires}"\n`,
        );
        const initIo = testIo(v4, grantedAgent);
        expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
        expect(initIo.err).toContain('only the owner runs init');
        expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(false);
      }

      mkdirSync(join(v4, '.agents'), { recursive: true });
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));

      for (const expires of [PAST, EXACT_NOW]) {
        writeGrant(
          sb.home,
          'acme.yaml',
          `entity: acme\nsession: dispatch\nagent: orchestrator\npaths:\n  - ~/Code/acme\n  - ~/Documents/acme\nexpires: "${expires}"\n`,
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
      writeGrant(
        sb.home,
        'acme.yaml',
        `entity: acme\nsession: dispatch\nagent: orchestrator\npaths:\n  - ~/Code/acme\n  - ~/Documents/acme\nexpires: "${FUTURE}"\n`,
      );

      // An outside repository not covered by the grant.
      const outside = join(sb.home, 'Code', 'other-repo');
      initGitRepo(outside);

      // 1. Symlink inside ~/Code/acme pointing out to ~/Code/other-repo.
      const symlinkedRepo = join(sb.acmeCode, 'escaped-link');
      symlinkSync(outside, symlinkedRepo);

      const symInitIo = testIo(symlinkedRepo, grantedAgent);
      expect(await runInit([], symInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(symInitIo.err).toContain('only the owner runs init');
      expect(existsSync(join(outside, '.agents', 'team.yaml'))).toBe(false);

      // 2. `..` traversal in cwd (`~/Code/acme/v4/../../other-repo`).
      const v4 = join(sb.acmeCode, 'v4');
      initGitRepo(v4);
      const dotDotCwd = `${v4}/../../other-repo`;
      const dotInitIo = testIo(dotDotCwd, grantedAgent);
      expect(await runInit([], dotInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(dotInitIo.err).toContain('only the owner runs init');

      // 3. Prefix sibling (`~/Code/acme-evil`) is not under `~/Code/acme`.
      const sibling = join(sb.home, 'Code', 'acme-evil');
      initGitRepo(sibling);
      const sibInitIo = testIo(sibling, grantedAgent);
      expect(await runInit([], sibInitIo, sb.home, undefined, noLogin)).toBe(1);
      expect(sibInitIo.err).toContain('only the owner runs init');

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
        `entity: escaped\nsession: dispatch\nagent: orchestrator\npaths:\n  - ~/Code/acme/../other-repo\nexpires: "${FUTURE}"\n`,
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

  test('a record that names no paths covers nothing, and init and up name the file', async () => {
    const sb = makeSandbox();
    try {
      // Records once inferred their roots from the entity they named; nothing infers them now,
      // so a record with no `paths` admits nobody and the refusal says which file to fix.
      writeGrant(sb.home, 'acme.yaml', `entity: acme\nsession: dispatch\nagent: orchestrator\nexpires: "${FUTURE}"\n`);
      const v4 = join(sb.acmeCode, 'v4');
      initGitRepo(v4);

      // `init`, as the agent the record names: refused, and the file to fix is named.
      const initIo = testIo(v4, grantedAgent);
      expect(await runInit([], initIo, sb.home, undefined, noLogin)).toBe(1);
      expect(initIo.err).toContain('acme.yaml names no `paths`');
      expect(existsSync(join(v4, '.agents', 'team.yaml'))).toBe(false);

      // `up`, as the holder's own runner outside herdr: the same file is named in the refusal.
      mkdirSync(join(v4, '.agents'), { recursive: true });
      writeFileSync(join(v4, '.agents', 'team.yaml'), fiveSeatTeam('acme-v4', v4, sb.home));
      const runnerIo = testIo(v4, { kind: 'owner-no-tty' });
      expect(await runUp([], runnerIo, upSources(sb.home, launching(() => {}), terminal()))).toBe(1);
      expect(runnerIo.err).toContain('acme.yaml names no `paths`');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
