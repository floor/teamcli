// Independent coverage of sidebar slice 4 at cb84c3f0f.
// A layout refusal says which of the three outcomes happened: nothing was written, the prior
// bytes were restored, or the write could not be rolled back. A metadata ttl above the host cap
// is clamped at every report. The watch re-reports an unchanged line only once the refresh
// interval has elapsed. Managing off writes no layout.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import type { Caller } from '../src/caller.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch } from '../src/commands/up.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { hostConfigPath, SIDEBAR_TTL_CAP_MS } from '../src/herdr.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { installKey } from '../src/store/keys.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const OWNER: Caller = { kind: 'owner' };
const ABOVE_CAP = SIDEBAR_TTL_CAP_MS + 60_000;
const KEY = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')) as never;
const FINE: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const owned: string[] = [];
let savedXdg: string | undefined;

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  for (const path of owned.splice(0)) discardFixtures([path]);
});

type World = { base: string; root: string; home: string; dir: string };

function world(): World {
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sidebar-s4-')));
  owned.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  installKey(home, KEY);
  writeFileSync(join(dir, 'team.yaml'), teamText(root));
  return { base, root, home, dir };
}

function teamText(root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobby
  - ${root}
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

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

async function approve(home: string, root: string): Promise<void> {
  const io = testIo(root, OWNER);
  io.stdinIsTTY = true;
  const code = await runApprove(['--file', '.agents/team.yaml'], io, {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(code, io.out + io.err).toBe(0);
}

function policy(home: string, root: string, name: string, value: string | number): void {
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name, value }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
}

function seedConfig(home: string, text: string): string {
  const file = hostConfigPath(home);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe('sidebar slice 4', () => {
  test('a refusal names untouched, restored, or unrestored, and only a restored refusal puts the prior bytes back', async () => {
    const { root, home } = world();
    await approve(home, root);
    const prior = 'kept = true\n';
    const dotted = 'ui.sidebar.agents.rows = [["agent"]]\n';
    const file = seedConfig(home, dotted);
    const quiet = {
      home,
      now: () => NOW,
      sessionRunning: () => true,
      agents: () => [],
      hostSessions: () => [],
      sidebarConfigText: () => readFileSync(file, 'utf8'),
      launch: {
        sessionState: () => 'running' as const,
        startServer: () => true,
        sessionUp: () => true,
        createWorkspace: () => null,
        paneRun: () => false,
        renameAgent: () => false,
        closeWorkspace: () => false,
        agentPanes: () => [],
        agents: () => [],
        paneText: () => '',
        foreground: () => [],
        sleep: async () => {},
        now: () => NOW,
      },
    };

    const untouched = testIo(root, OWNER);
    untouched.stdinIsTTY = true;
    expect(await runUp(['--no-launch', '--file', '.agents/team.yaml'], untouched, quiet)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(dotted);
    expect(untouched.err).toContain('(the config was left untouched)');

    writeFileSync(file, prior);
    const restored = testIo(root, OWNER);
    restored.stdinIsTTY = true;
    expect(
      await runUp(['--no-launch', '--file', '.agents/team.yaml'], restored, {
        ...quiet,
        sidebarConfigText: () => prior,
        launch: {
          sessionState: () => 'running',
          startServer: () => true,
          sessionUp: () => true,
          createWorkspace: () => null,
          paneRun: () => false,
          renameAgent: () => false,
          closeWorkspace: () => false,
          agentPanes: () => [],
          agents: () => [],
          paneText: () => '',
          foreground: () => [],
          sleep: async () => {},
          now: () => NOW,
          checkSidebarConfig: () => ({ ok: false, text: 'config: issues found' }),
        },
      }),
    ).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(prior);
    expect(restored.err).toContain('(the prior config was restored)');

    writeFileSync(file, prior);
    const unrestored = testIo(root, OWNER);
    unrestored.stdinIsTTY = true;
    expect(
      await runUp(['--no-launch', '--file', '.agents/team.yaml'], unrestored, {
        ...quiet,
        sidebarConfigText: () => prior,
        launch: {
          sessionState: () => 'running',
          startServer: () => true,
          sessionUp: () => true,
          createWorkspace: () => null,
          paneRun: () => false,
          renameAgent: () => false,
          closeWorkspace: () => false,
          agentPanes: () => [],
          agents: () => [],
          paneText: () => '',
          foreground: () => [],
          sleep: async () => {},
          now: () => NOW,
          checkSidebarConfig: () => {
            const aside = `${file}.aside`;
            renameSync(file, aside);
            mkdirSync(file);
            writeFileSync(join(file, 'held'), 'x');
            return { ok: false, text: 'config: issues found' };
          },
        },
      }),
    ).toBe(1);
    expect(unrestored.err).toContain('(and the prior config could not be restored)');
    expect(lstatSync(file).isDirectory()).toBe(true);
    expect(readFileSync(`${file}.aside`, 'utf8')).toContain('managed by team');
    expect(readFileSync(`${file}.aside`, 'utf8')).not.toBe(prior);
  });

  test('managing off writes no layout', async () => {
    const { root, home } = world();
    await approve(home, root);
    policy(home, root, 'workspace.sidebar.manage', 'off');
    const io = testIo(root, OWNER);
    io.stdinIsTTY = true;
    let hostReads = 0;
    expect(
      await runUp(['--dry-run', '--file', '.agents/team.yaml'], io, {
        home,
        now: () => NOW,
        sessionRunning: () => false,
        agents: () => [],
        hostSessions: () => {
          hostReads += 1;
          return [];
        },
        sidebarConfigText: () => {
          hostReads += 1;
          return '';
        },
      }),
    ).toBe(0);
    expect(hostReads).toBe(0);
    expect(existsSync(hostConfigPath(home))).toBe(false);
    expect(io.out).not.toContain('config check');
  });

  test('a ttl above the host cap is clamped at up, add, restart, reload, register, and check', async () => {
    const { root, home, dir } = world();
    await approve(home, root);
    policy(home, root, 'daemon.sidebar-ttl-ms', ABOVE_CAP);
    const ttls: { site: string; ttlMs: number | undefined }[] = [];
    const report = (site: string) => (session: string, pane: string, text: string, ttlMs?: number) => {
      ttls.push({ site, ttlMs });
      expect(session).toBe('acme');
      expect(pane.startsWith('pane-')).toBe(true);
      expect(text.length).toBeGreaterThan(0);
      return true;
    };

    let session = 'absent' as 'absent' | 'running';
    let n = 0;
    const panes = new Map<string, string>();
    const launch: Launch = {
      sessionState: () => session,
      startServer: () => {
        session = 'running';
        return true;
      },
      sessionUp: () => session === 'running',
      createWorkspace: () => {
        n += 1;
        const pane = `pane-${String(n)}`;
        panes.set(pane, CLAUDE_IDLE);
        return { pane, workspace: `space-${String(n)}` };
      },
      paneRun: () => true,
      renameAgent: () => true,
      reportDisplayAgent: report('up'),
      closeWorkspace: () => true,
      agentPanes: () => [...panes.keys()],
      agents: () =>
        [...panes.keys()].map((pane) => ({
          name: '',
          agent: 'claude',
          pane,
          workspace: 'space-1',
          status: 'idle' as const,
          cwd: root,
        })),
      paneText: (_session, pane) => panes.get(pane) ?? CLAUDE_IDLE,
      typeText: () => true,
      pressEnter: () => true,
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };
    const up = testIo(root, OWNER);
    up.stdinIsTTY = true;
    expect(
      await runUp(['--file', '.agents/team.yaml'], up, {
        home,
        now: () => NOW,
        sessionRunning: () => session === 'running',
        sessionState: () => session,
        agents: () => [],
        workspaces: () => [],
        hostSessions: () => [],
        sidebarConfigText: () => '',
        launch: { ...launch, reportDisplayAgent: report('up') },
      }),
      up.out + up.err,
    ).toBe(0);
    expect(ttls.filter((call) => call.site === 'up').length).toBeGreaterThan(0);
    expect(ttls.every((call) => call.ttlMs === SIDEBAR_TTL_CAP_MS)).toBe(true);

    const doctor = {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
    };
    const add = testIo(root, OWNER);
    add.stdinIsTTY = true;
    const addSources: AddSources = {
      home,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      doctor,
      now: () => NOW,
      launch: { ...launch, reportDisplayAgent: report('add') },
    };
    expect(await runAdd(['extra', '--like', 'worker', '--file', '.agents/team.yaml'], add, addSources), add.out + add.err).toBe(0);

    const restart = testIo(root, OWNER);
    restart.stdinIsTTY = true;
    const restartSources: RestartSources = {
      home,
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => CLAUDE_IDLE,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      sleep: async () => {},
      doctor,
      upLaunch: { ...launch, reportDisplayAgent: report('restart') },
      launch: {
        typeText: () => true,
        pressEnter: () => true,
        sendKey: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => true,
        deleteSession: () => true,
        kill: () => true,
        sleep: async () => {},
        now: () => NOW,
      },
    };
    expect(await runRestart(['worker', '--file', '.agents/team.yaml'], restart, restartSources), restart.out + restart.err).toBe(0);

    updateState(dir, (state) => {
      const held = (state.sessions.acme ??= emptySession());
      held.seats.worker = {
        stage: 'ready',
        pane: 'pane-worker',
        workspace: 'space-worker',
        cli: 'claude-code',
        rules: 'option',
        model: 'Claude Haiku',
        version: '4',
        launch_line: 'claude --model claude-haiku',
        launched: { shell: 100, cli: [101] },
      };
    });
    const reload = testIo(root, OWNER);
    reload.stdinIsTTY = true;
    const reloadSources: ReloadSources = {
      home,
      now: () => NOW,
      version: () => '2.1.288',
      launch: {
        ...launch,
        reportDisplayAgent: report('reload'),
        agents: (session) => [
          { name: 'worker', agent: 'claude', pane: 'pane-worker', workspace: 'space-worker', status: 'idle' as const, cwd: root },
          ...(launch.agents(session) ?? []),
        ],
        workspacePanes: () => ['pane-worker'],
        processInfo: () => ({ shell: 100, foreground: [101] }),
        shellBack: (_session, pane) => pane === 'pane-worker',
      },
    };
    expect(await runReload(['worker', '--file', '.agents/team.yaml'], reload, reloadSources), reload.out + reload.err).toBe(0);

    const registered: number[] = [];
    const registerSources: RegisterSources = {
      home,
      sessionState: () => 'running',
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'pane-1', workspace: 'space-1', status: 'idle', cwd: root },
      ],
      processInfo: () => ({ shell: 400, foreground: [401] }),
      foreground: () => ['claude'],
      paneText: () => CLAUDE_IDLE,
      now: () => NOW,
      renameWorkspace: () => true,
      reportDisplayAgent: (_session, _pane, _text, ttlMs) => {
        registered.push(ttlMs ?? -1);
        return true;
      },
    };
    const registeredIo = testIo(root, OWNER);
    registeredIo.stdinIsTTY = true;
    expect(await runRegister(['lead'], registeredIo, registerSources), registeredIo.out + registeredIo.err).toBe(0);
    expect(registered).toEqual([SIDEBAR_TTL_CAP_MS]);

    updateState(dir, (state) => {
      const held = (state.sessions.acme ??= emptySession());
      held.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'space-lead', cli: 'claude-code' };
    });
    const checked: number[] = [];
    const checkIo = testIo(root, OWNER);
    checkIo.stdinIsTTY = true;
    runTeamCheck({ file: '.agents/team.yaml', repair: true }, checkIo, {
      home,
      now: () => NOW,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      live: (): Live => ({
        running: true,
        agents: [
          {
            name: 'lead',
            agent: 'claude',
            pane: 'pane-lead',
            workspace: 'space-lead',
            status: 'idle',
            cwd: null,
            displayAgent: 'a line the file does not declare',
          },
        ],
        workspaces: [{ id: 'space-lead', label: 'lead' }],
        screens: { 'pane-lead': CLAUDE_IDLE },
      }),
      reportDisplayAgent: (_session, _pane, _text, ttlMs) => {
        checked.push(ttlMs ?? -1);
        return true;
      },
      renameWorkspace: () => true,
    });
    expect(checked).toEqual([SIDEBAR_TTL_CAP_MS]);

    const sites = new Set(ttls.map((call) => call.site));
    expect(sites.has('up')).toBe(true);
    expect(sites.has('add')).toBe(true);
    expect(sites.has('restart')).toBe(true);
    expect(sites.has('reload')).toBe(true);
    expect(ttls.every((call) => call.ttlMs === SIDEBAR_TTL_CAP_MS)).toBe(true);
  });

  test('the watch clamps the ttl and re-reports an unchanged line only after the refresh interval', async () => {
    const { root, home, dir } = world();
    await approve(home, root);
    policy(home, root, 'daemon.sidebar-ttl-ms', ABOVE_CAP);
    policy(home, root, 'daemon.sidebar-refresh-ms', 600_000);
    updateState(dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: {
          lead: { stage: 'ready', pane: 'pane-lead', workspace: 'space-lead', cli: 'claude-code' },
        },
      };
    });
    const start = NOW.getTime();
    let clock = start;
    const reported: { at: number; ttlMs: number | undefined }[] = [];
    const agent: HerdrAgent = {
      name: 'lead',
      agent: 'claude',
      pane: 'pane-lead',
      workspace: 'space-lead',
      status: 'working',
      cwd: root,
    };
    const live = (): Live => ({
      running: true,
      agents: [agent],
      workspaces: [{ id: 'space-lead', label: 'lead' }],
      screens: { 'pane-lead': '  main · Opus 5.5\n' },
    });
    const sources: WatchSources = {
      home,
      live: () => live(),
      machine: () => FINE,
      standing: () => approvalStanding(root, home),
      readChecks: () => [],
      screen: () => '  main · Opus 5.5\n',
      status: () => 'working',
      foreground: () => ['claude'],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async (_seconds, onTick) => {
        onTick?.();
        clock = start + 599_999;
        onTick?.();
        clock = start + 600_000;
        onTick?.();
        clock = start + 601_000;
        onTick?.();
        return false;
      },
      alive: () => false,
      pid: 4242,
      ownPane: () => 'gone',
      readMailbox: () => [],
      reportDisplayAgent: (_session, pane, _text, ttlMs) => {
        if (pane === 'pane-lead') reported.push({ at: clock - start, ttlMs });
        return true;
      },
    };
    const io = testIo(root, OWNER);
    io.stdinIsTTY = true;
    expect(await runWatch(['--file', '.agents/team.yaml'], io, sources), io.out + io.err).toBe(0);
    expect(reported.map((call) => call.at)).toEqual([0, 600_000]);
    expect(reported.every((call) => call.ttlMs === SIDEBAR_TTL_CAP_MS)).toBe(true);
  });
});
