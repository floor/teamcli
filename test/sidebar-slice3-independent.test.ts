// Independent coverage of sidebar slice 3 at 8e44b3ac5. Manage off never reads the terminal
// host and plans no step. A splice or config-check refusal keeps the prior config bytes and
// starts no server or seat, in serial and in parallel. One session's reload failure names that
// session and leaves the rest of the launch going. The reload store stays under the machine
// folder. A second up, once the config and every running session already witness the layout,
// is skipped.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import type { Caller } from '../src/caller.ts';
import { runUp, type Launch } from '../src/commands/up.ts';
import {
  DEFAULT_SIDEBAR_ROWS,
  applySidebarLayout,
  hostConfigPath,
  spliceSidebarRows,
} from '../src/herdr.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type UpSeat } from '../src/launch/plan.ts';
import { sidebarConfigText } from '../src/launch/sidebar-step.ts';
import { sidebarRowsWord, writePolicySet } from '../src/policy/index.ts';
import { readSidebarReloads, recordSidebarReloads, sidebarReloadsFile } from '../src/registry/sidebar-reloads.ts';
import { noteTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, 'fixtures/example.yaml'), 'utf8');
const KEY = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/key.json'), 'utf8')) as never;
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-11-04T10:00:00.000Z');
const SKIP = "the terminal host's sidebar already reads this layout and every running session of this entity's teams holds a record at it; nothing to do";

const SEAT: UpSeat = {
  name: 'codex-acme',
  cli: 'codex',
  launch: 'codex -m gpt-6-sol',
  cwd: '/tmp/acme-web',
  label: 'codex-acme · implementer',
  repairLine: 'team restart codex-acme',
  stopped: false,
  rules: 'Follow the team rules.',
};

let base = '';
let root = '';
let siblingRoot = '';
let home = '';
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sidebar-s3-')));
  root = join(base, 'acme-web');
  siblingRoot = join(base, 'acme-api');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(siblingRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  installKey(home, KEY);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  discardFixtures([base], { roots: [tmpdir()] });
  base = '';
});

function writeEntityFile(): void {
  const header = 'format: 1\nproject: acme-web\nentity: acme-corp';
  const text = EXAMPLE.replace(/^format: 1\nproject: acme-web\n/, `${header}\n`).replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobbies/acme-corp\n  - ${root}\n  - ${join(base, 'worktrees')}\n\nworkspace:`,
  );
  writeFileSync(join(root, '.agents/team.yaml'), text);
}

async function approveCurrentFile(): Promise<void> {
  const io = testIo(root, OWNER);
  const code = await runApprove(['--file', '.agents/team.yaml'], io, {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(code).toBe(0);
}

function registerTeams(): void {
  noteTeam(home, root, { project: 'acme-web', entity: 'acme-corp', session: 'acme-web', lobby: null }, 'running', 'owner');
  noteTeam(home, siblingRoot, { project: 'acme-api', entity: 'acme-corp', session: 'acme-api', lobby: null }, 'running', 'owner');
}

function hostOf(events: string[], apply: Host['applySidebar'], reload?: Host['reloadSidebar']): Host {
  return {
    startServer(session) {
      events.push(`server:${session}`);
      return true;
    },
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      events.push(`create:${label}`);
      return { pane: 'p1', workspace: 'w1' };
    },
    paneRun(session, pane) {
      events.push(`run:${session}:${pane}`);
      return true;
    },
    typeLine: () => true,
    deliverRules: async () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => ['p1'],
    agentList: () => [],
    classify: () => 'idle',
    paneText: () => '',
    foreground: () => ['codex'],
    shellBack: () => false,
    sleep: async () => {},
    now: () => NOW.getTime(),
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: () => {},
    progress: () => {},
    final: () => {},
    detail: () => {},
    cliVersion: () => 'codex-cli 0.0.0',
    log: () => {},
    ...(apply === undefined ? {} : { applySidebar: apply }),
    ...(reload === undefined ? {} : { reloadSidebar: reload }),
  };
}

function planWithSidebar(sessions: readonly string[]) {
  return upPlan({
    root,
    session: 'acme-web',
    sessionRunning: false,
    seats: [SEAT],
    watchLabel: 'Watch · acme-web',
    watchAlive: true,
    sidebar: { rows: DEFAULT_SIDEBAR_ROWS, indicators: 'symbols', sessions },
  });
}

describe('sidebar slice 3', () => {
  test('manage off reads no host and plans no sidebar step', async () => {
    writeEntityFile();
    await approveCurrentFile();
    registerTeams();
    expect(writePolicySet(home, {
      level: 'team',
      target: root,
      teamRoot: root,
      name: 'workspace.sidebar.manage',
      value: 'off',
    }, { now: NOW }).ok).toBe(true);

    let hostReads = 0;
    const io = testIo(root, OWNER);
    const code = await runUp(['--dry-run', '--file', '.agents/team.yaml'], io, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      now: () => NOW,
      hostSessions: () => {
        hostReads += 1;
        return [{ name: 'acme-api', running: true }];
      },
      sidebarConfigText: () => {
        hostReads += 1;
        return '';
      },
    });

    expect(code).toBe(0);
    expect(hostReads).toBe(0);
    expect(io.out).not.toContain('config check');
    expect(io.out).not.toContain('reload-config');
    expect(io.out).not.toContain('skip sidebar');
  });

  test.each([
    { kind: 'splice', concurrency: 1 },
    { kind: 'splice', concurrency: 4 },
    { kind: 'check', concurrency: 1 },
    { kind: 'check', concurrency: 4 },
  ] as const)('a $kind refusal keeps the prior config bytes and starts nothing (concurrency $concurrency)', async ({ kind, concurrency }) => {
    const prior = kind === 'splice'
      ? 'ui.sidebar.agents.rows = [["agent"]]\n'
      : 'owner = "kept"\n';
    const config = hostConfigPath(home);
    mkdirSync(join(config, '..'), { recursive: true });
    writeFileSync(config, prior);
    let checks = 0;
    let reloads = 0;
    const events: string[] = [];
    const said: string[] = [];
    const host = hostOf(
      events,
      (rows, indicators) => applySidebarLayout(home, rows, indicators, [], {
        checkConfig: () => {
          checks += 1;
          return { ok: false, text: 'config check refused the layout' };
        },
        reload: () => {
          reloads += 1;
          return { applied: true, text: 'applied' };
        },
      }),
      (session) => {
        events.push(`reload:${session}`);
        return { applied: true, text: 'applied' };
      },
    );
    host.say = (line) => said.push(line);

    const report = await executePlan(planWithSidebar(['acme-api']), 'acme-web', host, { concurrency });

    expect(readFileSync(config, 'utf8')).toBe(prior);
    expect(report.held).toBe(true);
    expect(events).toEqual([]);
    expect(reloads).toBe(0);
    if (kind === 'splice') expect(checks).toBe(0);
    else expect(checks).toBe(1);
    expect(said.join('')).toContain("the terminal host's sidebar layout was refused");
    expect(said.join('')).not.toContain('server');
  });

  test('one session reload failure names that session, records the other, and lets the launch continue', async () => {
    const xdg = join(base, 'xdg-config');
    mkdirSync(xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    const events: string[] = [];
    const said: string[] = [];
    const host = hostOf(events, () => ({ kind: 'applied', reloaded: [], failed: [] }), (session) => {
      events.push(`reload:${session}`);
      if (session === 'acme-api') return { applied: false, text: 'socket did not answer' };
      return { applied: true, text: 'applied' };
    });
    host.say = (line) => said.push(line);
    host.recordSidebarReload = (session, rows, indicators) => {
      recordSidebarReloads(home, [{
        session,
        record: { rows: sidebarRowsWord(rows), indicators, at: NOW.toISOString() },
      }]);
    };

    const plan = upPlan({
      root,
      session: 'acme-web',
      sessionRunning: false,
      seats: [],
      watchLabel: 'Watch · acme-web',
      watchAlive: true,
      sidebar: {
        rows: DEFAULT_SIDEBAR_ROWS,
        indicators: 'symbols',
        sessions: ['acme-api', 'acme-web-alt'],
      },
    });
    const report = await executePlan(plan, 'acme-web', host, { concurrency: 2 });

    expect(report.held).toBe(false);
    expect(events).toContain('reload:acme-api');
    expect(events).toContain('reload:acme-web-alt');
    expect(events).toContain('server:acme-web');
    expect(said).toEqual(['sidebar: session acme-api: its sidebar config did not reload: socket did not answer\n']);
    expect(sidebarReloadsFile(home)).toBe(join(home, '.config', 'team', 'sidebar-reloads.yaml'));
    expect(readSidebarReloads(home)).toEqual({
      'acme-web-alt': {
        rows: sidebarRowsWord(DEFAULT_SIDEBAR_ROWS),
        indicators: 'symbols',
        at: NOW.toISOString(),
      },
    });
    expect(existsSync(join(xdg, 'sidebar-reloads.yaml'))).toBe(false);
    expect(existsSync(join(root, 'sidebar-reloads.yaml'))).toBe(false);
    expect(existsSync(join(xdg, 'herdr', 'sidebar-reloads.yaml'))).toBe(false);
  });

  test('a second up is skipped once the config and every running session already hold the layout', async () => {
    writeEntityFile();
    await approveCurrentFile();
    registerTeams();
    const spliced = spliceSidebarRows('', DEFAULT_SIDEBAR_ROWS, 'symbols');
    expect(spliced.ok).toBe(true);
    if (!spliced.ok) return;
    const config = hostConfigPath(home);
    mkdirSync(join(config, '..'), { recursive: true });
    writeFileSync(config, spliced.text);

    const sources = {
      sessionRunning: () => false,
      agents: () => [],
      home,
      now: () => NOW,
      hostSessions: () => [
        { name: 'acme-web', running: true },
        { name: 'acme-api', running: true },
      ],
      sidebarConfigText: (dir: string) => sidebarConfigText(dir),
      launch: {
        sessionState: () => 'running',
        startServer: () => true,
        sessionUp: () => true,
        createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
        paneRun: () => true,
        renameAgent: () => true,
        closeWorkspace: () => true,
        agentPanes: () => [],
        agents: () => [],
        paneText: () => '',
        foreground: () => [],
        shellBack: () => false,
        sleep: async () => {},
        now: () => NOW,
      } satisfies Launch,
    };

    const first = testIo(root, OWNER);
    expect(await runUp(['--dry-run', '--file', '.agents/team.yaml'], first, sources)).toBe(0);
    expect(first.out).toContain('herdr --session acme-api server reload-config');
    expect(first.out).not.toContain('skip sidebar');

    recordSidebarReloads(home, [{
      session: 'acme-api',
      record: {
        rows: sidebarRowsWord(DEFAULT_SIDEBAR_ROWS),
        indicators: 'symbols',
        at: NOW.toISOString(),
      },
    }]);
    const second = testIo(root, OWNER);
    expect(await runUp(['--dry-run', '--file', '.agents/team.yaml'], second, sources)).toBe(0);
    expect(second.out).toContain(`skip sidebar: ${SKIP}`);
    expect(second.out).not.toContain('reload-config');
    expect(second.out).not.toContain('config check');
    expect(readFileSync(config, 'utf8')).toBe(spliced.text);
  });
});
