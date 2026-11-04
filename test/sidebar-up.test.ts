import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import type { Caller } from '../src/caller.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { DEFAULT_SIDEBAR_ROWS, hostConfigPath, spliceSidebarRows } from '../src/herdr.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { formatPlan, upPlan, type UpSeat } from '../src/launch/plan.ts';
import { sidebarConfigText, sidebarStepOf } from '../src/launch/sidebar-step.ts';
import { sidebarRowsWord, writePolicySet } from '../src/policy/index.ts';
import {
  readSidebarReloads,
  recordSidebarReloads,
  sidebarReloadsFile,
  SidebarReloadsError,
} from '../src/registry/sidebar-reloads.ts';
import { noteTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, 'fixtures/example.yaml'), 'utf8');
const KEY = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/key.json'), 'utf8'));
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-11-04T10:00:00.000Z');
const SELF_ENTRY = realpathSync(join(import.meta.dir, '../src/cli.ts'));

let base = '';
let root = '';
let siblingRoot = '';
let strangerRoot = '';
let home = '';
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sidebar-up-')));
  root = join(base, 'acme-web');
  siblingRoot = join(base, 'acme-api');
  strangerRoot = join(base, 'other-org');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(siblingRoot, '.agents'), { recursive: true });
  mkdirSync(join(strangerRoot, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  installKey(home, KEY);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (base) rmSync(base, { recursive: true, force: true });
});

function writeEntityFile(entity = 'acme-corp'): void {
  const header = `format: 1\nproject: acme-web\nentity: ${entity}`;
  const text = EXAMPLE.replace(/^format: 1\nproject: acme-web\n/, `${header}\n`).replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobbies/${entity}\n  - ${root}\n  - ${join(base, 'worktrees')}\n\nworkspace:`,
  );
  writeFileSync(join(root, '.agents/team.yaml'), text);
}

function readCurrentTeam(): TeamFile {
  const validated = validateTeamFile(readFileSync(join(root, '.agents/team.yaml'), 'utf8'));
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
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

function registerSampleTeams(): void {
  noteTeam(
    home,
    root,
    {
      project: 'acme-web',
      entity: 'acme-corp',
      session: 'acme-web',
      lobby: null,
      aliasSession: 'acme-web-alt',
    },
    'running',
    'owner',
  );
  noteTeam(
    home,
    siblingRoot,
    {
      project: 'acme-api',
      entity: 'acme-corp',
      session: 'acme-api',
      lobby: null,
    },
    'running',
    'owner',
  );
  noteTeam(
    home,
    strangerRoot,
    {
      project: 'other-org',
      entity: 'other-entity',
      session: 'other-session',
      lobby: null,
    },
    'running',
    'owner',
  );
}

describe('sidebar reload record store', () => {
  test('missing file reads as empty; records merge and round-trip with colons and slashes preserved', () => {
    expect(readSidebarReloads(home)).toEqual({});

    recordSidebarReloads(home, [
      {
        session: 'acme-api',
        record: {
          rows: 'state_icon,workspace / state_text,agent',
          indicators: 'symbols',
          at: '2026-11-04T10:00:00.000Z',
        },
      },
    ]);
    recordSidebarReloads(home, [
      {
        session: 'acme-web-alt',
        record: {
          rows: 'state_icon,workspace / state_text,agent',
          indicators: 'dots',
          at: '2026-11-04T10:05:00.000Z',
        },
      },
    ]);

    expect(readSidebarReloads(home)).toEqual({
      'acme-api': {
        rows: 'state_icon,workspace / state_text,agent',
        indicators: 'symbols',
        at: '2026-11-04T10:00:00.000Z',
      },
      'acme-web-alt': {
        rows: 'state_icon,workspace / state_text,agent',
        indicators: 'dots',
        at: '2026-11-04T10:05:00.000Z',
      },
    });
  });

  test('corrupt or non-map reload file throws SidebarReloadsError naming the path', () => {
    const path = sidebarReloadsFile(home);
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(path, 'reloads:\n  acme-api: [unclosed\n');
    expect(() => readSidebarReloads(home)).toThrow(SidebarReloadsError);
    expect(() => readSidebarReloads(home)).toThrow(path);
  });
});

describe('sidebar step planning and dry-run', () => {
  test('appears under manage: true before server and seats, filters to running entity sessions minus the target session, and prints in --dry-run', async () => {
    writeEntityFile();
    await approveCurrentFile();
    registerSampleTeams();
    expect(
      writePolicySet(
        home,
        {
          level: 'team',
          target: root,
          teamRoot: root,
          name: 'workspace.sidebar.rows',
          value: [['state_icon', 'workspace'], ['state_text', 'agent']],
        },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(
      writePolicySet(
        home,
        {
          level: 'team',
          target: root,
          teamRoot: root,
          name: 'workspace.sidebar.status_indicators',
          value: 'dots',
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    const io = testIo(root, OWNER);
    const code = await runUp(['--dry-run', '--file', '.agents/team.yaml'], io, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      now: () => NOW,
      hostSessions: () => [
        // The session this launch starts: never reloaded (reads config at start).
        { name: 'acme-web', running: true },
        // Sibling team session of the same entity (running): reloaded.
        { name: 'acme-api', running: true },
        // Alias session in this team's lobbies map (running): reloaded.
        { name: 'acme-web-alt', running: true },
        // Stopped session of the same entity: never reloaded.
        { name: 'acme-stopped', running: false },
        // Running session of another entity: never reloaded.
        { name: 'other-session', running: true },
        // Running session not in any registered team: never reloaded.
        { name: 'scratch-session', running: true },
      ],
      sidebarConfigText: () => '',
    });

    expect(code).toBe(0);
    expect(io.out).toContain(
      '+ herdr config check\n    (after writing the marked sidebar block — rows state_icon,workspace;state_text,agent; indicators dots)\n',
    );
    expect(io.out).toContain(
      '+ herdr --session acme-api server reload-config\n    (the sidebar layout onto the running session; recorded when it applies)\n',
    );
    expect(io.out).toContain(
      '+ herdr --session acme-web-alt server reload-config\n    (the sidebar layout onto the running session; recorded when it applies)\n',
    );
    expect(io.out).not.toContain('herdr --session acme-web server reload-config');
    expect(io.out).not.toContain('other-session');
    expect(io.out).not.toContain('scratch-session');

    // Order: sidebar check and reloads appear before the server start and before any workspace create.
    const checkAt = io.out.indexOf('+ herdr config check');
    const reloadAt = io.out.indexOf('+ herdr --session acme-api server reload-config');
    const serverAt = io.out.indexOf('+ env -i ');
    const createAt = io.out.indexOf('workspace create');
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(reloadAt).toBeGreaterThan(checkAt);
    expect(serverAt).toBeGreaterThan(reloadAt);
    expect(createAt).toBeGreaterThan(serverAt);
  });

  test('never appears when workspace.sidebar.manage resolves false', async () => {
    writeEntityFile();
    await approveCurrentFile();
    registerSampleTeams();
    expect(
      writePolicySet(
        home,
        {
          level: 'team',
          target: root,
          teamRoot: root,
          name: 'workspace.sidebar.manage',
          value: 'off',
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    const team = readCurrentTeam();
    const step = sidebarStepOf({
      home,
      root,
      session: 'acme-web',
      team,
      now: NOW,
      hostSessions: () => [{ name: 'acme-api', running: true }],
      configText: () => '',
    });
    expect(step).toBeNull();

    const io = testIo(root, OWNER);
    const code = await runUp(['--dry-run', '--file', '.agents/team.yaml'], io, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      now: () => NOW,
      hostSessions: () => [{ name: 'acme-api', running: true }],
      sidebarConfigText: () => '',
    });
    expect(code).toBe(0);
    expect(io.out).not.toContain('herdr config check');
    expect(io.out).not.toContain('reload-config');
    expect(io.out).not.toContain('sidebar:');
  });

  test('is skipped when the config reads equal on both keys and every running session holds a current reload record', () => {
    writeEntityFile();
    registerSampleTeams();
    const team = readCurrentTeam();
    const spliced = spliceSidebarRows('', DEFAULT_SIDEBAR_ROWS, 'symbols');
    expect(spliced.ok).toBe(true);
    if (!spliced.ok) return;

    // Without a reload record for the running sibling session, the step still runs.
    const withoutRecord = sidebarStepOf({
      home,
      root,
      session: 'acme-web',
      team,
      now: NOW,
      hostSessions: () => [{ name: 'acme-api', running: true }],
      configText: () => spliced.text,
    });
    expect(withoutRecord?.skip).toBeUndefined();

    // With a record at different indicators, the step still runs.
    recordSidebarReloads(home, [
      {
        session: 'acme-api',
        record: {
          rows: sidebarRowsWord(DEFAULT_SIDEBAR_ROWS),
          indicators: 'dots',
          at: NOW.toISOString(),
        },
      },
    ]);
    const staleRecord = sidebarStepOf({
      home,
      root,
      session: 'acme-web',
      team,
      now: NOW,
      hostSessions: () => [{ name: 'acme-api', running: true }],
      configText: () => spliced.text,
    });
    expect(staleRecord?.skip).toBeUndefined();

    // Once the running session holds a record at the current pair, the step is skipped and printed as skipped.
    recordSidebarReloads(home, [
      {
        session: 'acme-api',
        record: {
          rows: sidebarRowsWord(DEFAULT_SIDEBAR_ROWS),
          indicators: 'symbols',
          at: NOW.toISOString(),
        },
      },
    ]);
    const skipped = sidebarStepOf({
      home,
      root,
      session: 'acme-web',
      team,
      now: NOW,
      hostSessions: () => [{ name: 'acme-api', running: true }],
      configText: () => spliced.text,
    });
    expect(skipped?.skip).toBe(
      "the terminal host's sidebar already reads this layout and every running session of this entity's teams holds a record at it; nothing to do",
    );

    const plan = upPlan({
      root,
      session: 'acme-web',
      sessionRunning: true,
      seats: [],
      watchLabel: 'Watch · acme-web',
      watchAlive: true,
      sidebar: skipped!,
    });
    expect(formatPlan(plan)).toContain(
      "  skip sidebar: the terminal host's sidebar already reads this layout and every running session of this entity's teams holds a record at it; nothing to do\n",
    );
  });
});

describe('sidebar step execution', () => {
  const sampleSeat: UpSeat = {
    name: 'codex-acme',
    cli: 'codex',
    launch: 'codex -m gpt-6-sol',
    cwd: '/tmp/acme-web',
    label: 'codex-acme · implementer',
    repairLine: 'team restart codex-acme',
    stopped: false,
    rules: 'Follow the team rules.',
  };

  function fakeHost(overrides: Partial<Host> = {}): {
    host: Host;
    said: string[];
    logged: string[];
    events: string[];
  } {
    const said: string[] = [];
    const logged: string[] = [];
    const events: string[] = [];
    const host: Host = {
      startServer(session) {
        events.push(`server:${session}`);
        return true;
      },
      sessionUp: () => true,
      createWorkspace(session, _cwd, label) {
        events.push(`create:${session}:${label}`);
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
      agentList: () => [{ name: 'codex-acme', agent: 'codex', pane: 'p1', workspace: 'w1', status: 'idle', cwd: '/tmp/acme-web' }],
      classify: () => 'idle',
      paneText: () => 'gpt-6-sol',
      foreground: () => ['codex'],
      shellBack: () => false,
      sleep: async () => {},
      now: () => NOW.getTime(),
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => said.push(line),
      progress: () => {},
      final: () => {},
      detail: () => {},
      cliVersion: () => 'codex-cli 0.161.0',
      log: (who, what) => logged.push(`${who}: ${what}`),
      ...overrides,
    };
    return { host, said, logged, events };
  }

  test.each([1, 4])(
    'a splice or config-check refusal fails and aborts the plan before the server or any seat starts (concurrency %i)',
    async (concurrency) => {
      const plan = upPlan({
        root,
        session: 'acme-web',
        sessionRunning: false,
        seats: [sampleSeat],
        watchLabel: 'Watch · acme-web',
        watchAlive: true,
        sidebar: {
          rows: DEFAULT_SIDEBAR_ROWS,
          indicators: 'symbols',
          sessions: ['acme-api'],
        },
      });
      const { host, said, logged, events } = fakeHost({
        applySidebar: () => ({
          kind: 'refused',
          reason: 'the sidebar rows key is set as a dotted key at line 2; edit it by hand',
          restored: false,
        }),
        reloadSidebar: (session) => {
          events.push(`reload:${session}`);
          return { applied: true, text: 'applied' };
        },
      });

      const report = await executePlan(plan, 'acme-web', host, { concurrency });
      expect(report.held).toBe(true);
      expect(events).toEqual([]);
      expect(said).toEqual([
        "sidebar: the terminal host's sidebar layout was refused: the sidebar rows key is set as a dotted key at line 2; edit it by hand (and the prior config could not be restored)\n",
      ]);
      expect(logged).toEqual([
        "sidebar: the terminal host's sidebar layout was refused: the sidebar rows key is set as a dotted key at line 2; edit it by hand (and the prior config could not be restored)",
      ]);
    },
  );

  test('reloads every running session of the entity, records applied reloads, and names a single session failure without failing anything else', async () => {
    const plan = upPlan({
      root,
      session: 'acme-web',
      sessionRunning: true,
      seats: [],
      watchLabel: 'Watch · acme-web',
      watchAlive: true,
      sidebar: {
        rows: DEFAULT_SIDEBAR_ROWS,
        indicators: 'symbols',
        sessions: ['acme-api', 'acme-web-alt'],
      },
    });

    const reloadedSessions: string[] = [];
    const { host, said, logged } = fakeHost({
      applySidebar: () => ({ kind: 'applied', reloaded: [], failed: [] }),
      reloadSidebar: (session) => {
        reloadedSessions.push(session);
        if (session === 'acme-api') return { applied: false, text: 'socket did not answer' };
        return { applied: true, text: 'applied' };
      },
      recordSidebarReload: (session, rows, indicators) => {
        recordSidebarReloads(home, [
          {
            session,
            record: {
              rows: sidebarRowsWord(rows),
              indicators,
              at: NOW.toISOString(),
            },
          },
        ]);
      },
    });

    const report = await executePlan(plan, 'acme-web', host, { concurrency: 2 });
    expect(report.held).toBe(false);
    expect(reloadedSessions).toEqual(['acme-api', 'acme-web-alt']);
    expect(said).toEqual([
      'sidebar: session acme-api: its sidebar config did not reload: socket did not answer\n',
    ]);
    expect(logged).toEqual([
      'sidebar: session acme-api: its sidebar config did not reload: socket did not answer',
    ]);
    expect(readSidebarReloads(home)).toEqual({
      'acme-web-alt': {
        rows: sidebarRowsWord(DEFAULT_SIDEBAR_ROWS),
        indicators: 'symbols',
        at: NOW.toISOString(),
      },
    });
  });

  test('an unreadable reload record file degrades to a sidebar note and does not fail the launch', async () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(sidebarReloadsFile(home), 'reloads: [corrupt\n');

    const plan = upPlan({
      root,
      session: 'acme-web',
      sessionRunning: true,
      seats: [],
      watchLabel: 'Watch · acme-web',
      watchAlive: true,
      sidebar: {
        rows: DEFAULT_SIDEBAR_ROWS,
        indicators: 'symbols',
        sessions: ['acme-api'],
      },
    });

    const { host, said, logged } = fakeHost({
      applySidebar: () => ({ kind: 'applied', reloaded: [], failed: [] }),
      reloadSidebar: () => ({ applied: true, text: 'applied' }),
      recordSidebarReload: (session, rows, indicators) => {
        recordSidebarReloads(home, [
          {
            session,
            record: {
              rows: sidebarRowsWord(rows),
              indicators,
              at: NOW.toISOString(),
            },
          },
        ]);
      },
    });

    const report = await executePlan(plan, 'acme-web', host, { concurrency: 1 });
    expect(report.held).toBe(false);
    expect(said[0]).toContain('sidebar: session acme-api: its sidebar reload was not recorded:');
    expect(logged[0]).toContain('sidebar: session acme-api: its sidebar reload was not recorded:');
  });

  test('live runUp writes the host config, reloads running entity sessions, records applied reloads, and aborts before seats on a splice refusal', async () => {
    writeEntityFile();
    await approveCurrentFile();
    registerSampleTeams();
    expect(
      writePolicySet(
        home,
        {
          level: 'team',
          target: root,
          teamRoot: root,
          name: 'workspace.sidebar.rows',
          value: [['state_icon', 'workspace', 'tab'], ['state_text', 'agent']],
        },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(
      writePolicySet(
        home,
        {
          level: 'team',
          target: root,
          teamRoot: root,
          name: 'workspace.sidebar.status_indicators',
          value: 'symbols',
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    const codexIdle = readFileSync(join(import.meta.dir, 'fixtures/codex/0.157.0/idle.txt'), 'utf8').replaceAll(
      'GPT-5.6-Terra',
      'GPT-6-Sol',
    );
    const reloaded: string[] = [];
    const created: string[] = [];
    const panes = new Map<string, string>();
    const baseLaunch = (overrides: Partial<Launch> = {}): Launch => ({
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => {
        created.push(label);
        const pane = `w${String(created.length)}:p1`;
        panes.set(pane, label === 'codex-acme · implementer' ? codexIdle : CLAUDE_IDLE);
        return { pane, workspace: `w${String(created.length)}` };
      },
      paneRun: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [...panes.keys()],
      agents: () => [],
      paneText: (_session, pane) => panes.get(pane) ?? CLAUDE_IDLE,
      foreground: () => ['claude', 'codex'],
      shellBack: () => false,
      checkSidebarConfig: () => ({ ok: true, text: 'config: ok' }),
      reloadSidebar: (session) => {
        reloaded.push(session);
        return { applied: true, text: 'applied' };
      },
      sleep: async () => {},
      now: () => NOW,
      ...overrides,
    });

    const baseSources = (launchOverrides: Partial<Launch> = {}): UpSources => ({
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      home,
      now: () => NOW,
      sleep: async () => {},
      alive: () => true,
      doctor: {
        version: (bin) =>
          bin === 'claude' ? '2.1.288 (Claude Code)' : bin === 'codex' ? 'codex-cli 0.157.0' : '0.9.5',
        herdrVersion: () => '0.7.1',
        sessionRunning: () => true,
        loggedIn: () => true,
        onPath: () => true,
        now: () => NOW,
        home,
      },
      hostSessions: () => [
        { name: 'acme-web', running: true },
        { name: 'acme-api', running: true },
        { name: 'acme-web-alt', running: true },
        { name: 'other-session', running: true },
      ],
      sidebarConfigText: (h) => sidebarConfigText(h),
      launch: baseLaunch(launchOverrides),
    });

    const io = testIo(root, OWNER);
    const code = await runUp(['--file', '.agents/team.yaml'], io, baseSources());
    expect(code).toBe(0);
    expect(reloaded).toEqual(['acme-api', 'acme-web-alt']);
    expect(readFileSync(hostConfigPath(home), 'utf8')).toBe(
      [
        '[ui.sidebar.agents] # managed by team',
        'rows = [["state_icon", "workspace", "tab"], ["state_text", "agent"]]',
        '',
        '[ui]',
        'status_indicators = "symbols" # managed by team',
        '',
      ].join('\n'),
    );
    expect(readSidebarReloads(home)).toEqual({
      'acme-api': {
        rows: 'state_icon,workspace,tab;state_text,agent',
        indicators: 'symbols',
        at: NOW.toISOString(),
      },
      'acme-web-alt': {
        rows: 'state_icon,workspace,tab;state_text,agent',
        indicators: 'symbols',
        at: NOW.toISOString(),
      },
    });

    // Now write a dotted key into config.toml so the splice refuses, and verify runUp aborts before creating any workspace.
    reloaded.length = 0;
    created.length = 0;
    writeFileSync(hostConfigPath(home), 'ui.sidebar.agents.rows = [["agent"]]\n');
    const refusedIo = testIo(root, OWNER);
    const refusedCode = await runUp(['--no-launch', '--file', '.agents/team.yaml'], refusedIo, baseSources());
    expect(refusedCode).toBe(1);
    expect(reloaded).toEqual([]);
    expect(created).toEqual([]);
    expect(refusedIo.err).toContain(
      "sidebar: the terminal host's sidebar layout was refused: the sidebar rows key is set as a dotted key at line 1; edit it by hand",
    );
  });
});
