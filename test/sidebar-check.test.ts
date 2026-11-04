import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck, type CheckSidebarSources } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  DEFAULT_SIDEBAR_ROWS,
  hostConfigPath,
  renderSidebarTomlBlock,
  setCaptureExec,
  setHerdrRun,
  SIDEBAR_TTL_CAP_MS,
} from '../src/herdr.ts';
import { sidebarRowsWord, writePolicySet } from '../src/policy/index.ts';
import { readSidebarReloads, recordSidebarReloads } from '../src/registry/sidebar-reloads.ts';
import { upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T12:00:00Z');

const TEAM_YAML = `format: 1
entity: acme
project: acme-app
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true

  - role: implementer
    name: worker-stopped
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

const parsedTeam = validateTeamFile(TEAM_YAML);
if (!parsedTeam.ok) throw new Error(JSON.stringify(parsedTeam.errors));
const LEAD_SEAT = parsedTeam.team.seats[0]!;
const LEAD_TITLE = workspaceLabel(LEAD_SEAT);
const LEAD_DISPLAY = displayAgent(LEAD_SEAT);
const DEFAULT_ROWS_WORD = sidebarRowsWord(DEFAULT_SIDEBAR_ROWS);
const DEFAULT_TOML_BLOCK = renderSidebarTomlBlock(DEFAULT_SIDEBAR_ROWS, 'symbols');

const tempDirs: string[] = [];
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  setCaptureExec(null);
  setHerdrRun(null);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupWorld(options?: { writeValidConfig?: boolean; recordCurrentReload?: boolean }): {
  root: string;
  home: string;
} {
  delete process.env.XDG_CONFIG_HOME;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sidebar-check-')));
  tempDirs.push(base);
  const root = join(base, 'acme-app');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions['acme-acme-app'] ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats['worker-stopped'] = { stage: 'ready', pane: 'pane-stopped', workspace: 'ws-stopped' };
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
  });

  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: 'acme-acme-app',
    seats: ['lead', 'worker-stopped'],
    home,
    at: NOW.toISOString(),
  });

  if (options?.writeValidConfig !== false) {
    const cfgPath = hostConfigPath(home);
    mkdirSync(join(cfgPath, '..'), { recursive: true });
    writeFileSync(cfgPath, `${DEFAULT_TOML_BLOCK}\n`, { mode: 0o600 });
  }

  if (options?.recordCurrentReload !== false) {
    recordSidebarReloads(home, [
      {
        session: 'acme-acme-app',
        record: { rows: DEFAULT_ROWS_WORD, indicators: 'symbols', at: NOW.toISOString() },
      },
    ]);
  }

  return { root, home };
}

function buildLive(display: string | undefined = LEAD_DISPLAY): Live {
  return {
    running: true,
    agents: [
      {
        name: 'lead',
        agent: 'claude',
        pane: 'pane-lead',
        workspace: 'ws-lead',
        status: 'idle',
        cwd: null,
        ...(display === undefined ? {} : { displayAgent: display }),
      },
    ],
    workspaces: [{ id: 'ws-lead', label: LEAD_TITLE }],
    screens: { 'pane-lead': CLAUDE_IDLE },
  };
}

function runCheck(
  root: string,
  home: string,
  options: {
    repair?: boolean;
    json?: boolean;
    caller?: Parameters<typeof testIo>[1];
    live?: Live;
    sidebar?: CheckSidebarSources;
    rawSidebar?: CheckSidebarSources;
    reportDisplayAgent?: (session: string, pane: string, text: string, ttlMs?: number) => boolean;
  } = {},
): { code: number; out: string; stdout: string; stderr: string } {
  const io = testIo(root, options.caller ?? { kind: 'owner' });
  const liveSession = options.live ?? buildLive();
  const code = runTeamCheck(
    {
      ...(options.caller === undefined ? { file: '.agents/team.yaml' } : {}),
      ...(options.repair === true ? { repair: true } : {}),
      ...(options.json === true ? { json: true } : {}),
    },
    io,
    {
      live: () => liveSession,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      gate: {
        sessionRunning: () => true,
        agents: () => liveSession.agents,
      },
      ...(options.reportDisplayAgent === undefined ? {} : { reportDisplayAgent: options.reportDisplayAgent }),
      sidebar:
        options.rawSidebar ?? {
          sessions: () => [{ name: 'acme-acme-app', running: true }],
          paneDisplays: () => [{ pane: 'pane-lead', workspace: 'ws-lead', displayAgent: LEAD_DISPLAY }],
          ...(options.sidebar ?? {}),
        },
    },
  );
  return { code, out: `${io.out}${io.err}`, stdout: io.out, stderr: io.err };
}

describe('sidebar check and --repair (Test 9)', () => {
  test('reports a config without the agent token in any row with "line 2 has nowhere to live" and the resolved template', () => {
    const { root, home } = setupWorld({ writeValidConfig: false });
    const cfgPath = hostConfigPath(home);
    mkdirSync(join(cfgPath, '..'), { recursive: true });
    writeFileSync(
      cfgPath,
      [
        '[ui]',
        'status_indicators = "symbols"',
        '',
        '[ui.sidebar.agents]',
        'rows = [',
        '  ["state_icon", "workspace"],',
        '  ["state_text"],',
        ']',
        '',
      ].join('\n'),
    );

    const { code, out } = runCheck(root, home);
    expect(code).toBe(1);
    expect(out).toContain('line 2 has nowhere to live');
    expect(out).toContain(DEFAULT_ROWS_WORD);
  });

  test('reports status_indicators other than the resolved value (symbols by default, dots when configured)', () => {
    const { root, home } = setupWorld({ writeValidConfig: false });
    const cfgPath = hostConfigPath(home);
    mkdirSync(join(cfgPath, '..'), { recursive: true });
    writeFileSync(cfgPath, `${ renderSidebarTomlBlock(DEFAULT_SIDEBAR_ROWS, 'dots') }\n`);

    const defaultCheck = runCheck(root, home);
    expect(defaultCheck.code).toBe(1);
    expect(defaultCheck.out).toContain('status_indicators is "dots"; the resolved value is "symbols"');

    // Now configure workspace.sidebar.status_indicators = dots at entity level while config has symbols.
    const written = writePolicySet(
      home,
      { level: 'entity', target: 'acme', name: 'workspace.sidebar.status_indicators', value: 'dots' },
      { now: NOW },
    );
    if (!written.ok) throw new Error(written.why);
    writeFileSync(cfgPath, `${ renderSidebarTomlBlock(DEFAULT_SIDEBAR_ROWS, 'symbols') }\n`);
    recordSidebarReloads(home, [
      {
        session: 'acme-acme-app',
        record: { rows: DEFAULT_ROWS_WORD, indicators: 'dots', at: NOW.toISOString() },
      },
    ]);

    const configuredCheck = runCheck(root, home);
    expect(configuredCheck.code).toBe(1);
    expect(configuredCheck.out).toContain('status_indicators is "symbols"; the resolved value is "dots"');
  });

  test('per running session: names missing or older reload records (including hand-reloaded), skips current, stopped, and another entity\'s sessions', () => {
    const { root, home } = setupWorld({ recordCurrentReload: false });

    // Register this entity's sibling sessions/lobbies and another entity's session in the team registry.
    upsertTeam(home, 'sibling123456', {
      project: 'acme-sibling',
      entity: 'acme',
      session: 'session-older-rows',
      root: join(root, '..', 'acme-sibling'),
      lobbies: {
        'session-older-rows': '/tmp/lobby-older-rows',
        'session-older-indicators': '/tmp/lobby-older-indicators',
        'session-current': '/tmp/lobby-current',
        'session-stopped': '/tmp/lobby-stopped',
      },
    });
    upsertTeam(home, 'other12345678', {
      project: 'globex-app',
      entity: 'globex',
      session: 'globex-registered-session',
      root: join(root, '..', 'globex-app'),
    });

    // Record one session at an older layout, one at the current pair, and two sessions belonging to
    // another entity in the machine-wide reload file (one registered under globex, one only in the reload file).
    recordSidebarReloads(home, [
      {
        session: 'session-older-rows',
        record: { rows: 'workspace;agent', indicators: 'symbols', at: NOW.toISOString() },
      },
      {
        session: 'session-older-indicators',
        record: { rows: DEFAULT_ROWS_WORD, indicators: 'dots', at: NOW.toISOString() },
      },
      {
        session: 'session-current',
        record: { rows: DEFAULT_ROWS_WORD, indicators: 'symbols', at: NOW.toISOString() },
      },
      {
        session: 'globex-registered-session',
        record: { rows: 'workspace;agent', indicators: 'dots', at: NOW.toISOString() },
      },
      {
        session: 'globex-reload-only-session',
        record: { rows: 'workspace;agent', indicators: 'dots', at: NOW.toISOString() },
      },
    ]);

    const { code, out } = runCheck(root, home, {
      sidebar: {
        sessions: () => [
          { name: 'acme-acme-app', running: true },
          { name: 'session-older-rows', running: true },
          { name: 'session-older-indicators', running: true },
          { name: 'session-current', running: true },
          { name: 'session-stopped', running: false },
          { name: 'globex-registered-session', running: true },
          { name: 'globex-reload-only-session', running: true },
        ],
      },
    });

    expect(code).toBe(1);
    // Running session with no reload record (or reloaded by hand outside TeamCLI): named with presumption wording.
    expect(out).toContain('session "acme-acme-app": no TeamCLI reload recorded at the current layout');
    expect(out).toContain(
      "the terminal host's live sidebar layout cannot be read back, so a running session is presumed to hold an older layout until TeamCLI records a reload (even if reloaded by hand)",
    );
    // Running sessions recorded at an older rows or indicators: named.
    expect(out).toContain('session "session-older-rows": no TeamCLI reload recorded at the current layout');
    expect(out).toContain('recorded rows "workspace;agent", status_indicators "symbols"');
    expect(out).toContain('session "session-older-indicators": no TeamCLI reload recorded at the current layout');
    expect(out).toContain(`recorded rows "${DEFAULT_ROWS_WORD}", status_indicators "dots"`);
    // Session recorded at the current pair is not named.
    expect(out).not.toContain('session "session-current"');
    // Session that is not running is never named.
    expect(out).not.toContain('session "session-stopped"');
    // Another entity's running session in the machine-wide reload file is neither named nor reloaded.
    expect(out).not.toContain('globex-registered-session');
    expect(out).not.toContain('globex-reload-only-session');

    const reloaded: string[] = [];
    const repaired = runCheck(root, home, {
      repair: true,
      sidebar: {
        sessions: () => [
          { name: 'acme-acme-app', running: true },
          { name: 'session-older-rows', running: true },
          { name: 'session-older-indicators', running: true },
          { name: 'session-current', running: true },
          { name: 'session-stopped', running: false },
          { name: 'globex-registered-session', running: true },
          { name: 'globex-reload-only-session', running: true },
        ],
        checkConfig: () => ({ ok: true, text: 'config: ok' }),
        reloadSession: (session) => {
          reloaded.push(session);
          return { applied: true, text: 'applied' };
        },
      },
    });
    expect(repaired.code).toBe(0);
    expect(reloaded).toEqual(['acme-acme-app', 'session-older-indicators', 'session-older-rows']);
    expect(reloaded).not.toContain('globex-registered-session');
    expect(reloaded).not.toContain('globex-reload-only-session');
  });

  test('under workspace.sidebar.manage: false, team check prints the exact TOML block and does not write the config without --repair', () => {
    const { root, home } = setupWorld({ writeValidConfig: false });
    const policyRes = writePolicySet(
      home,
      { level: 'entity', target: 'acme', name: 'workspace.sidebar.manage', value: 'off' },
      { now: NOW },
    );
    if (!policyRes.ok) throw new Error(policyRes.why);

    const cfgPath = hostConfigPath(home);
    expect(existsSync(cfgPath)).toBe(false);

    const { code, stdout } = runCheck(root, home);
    expect(code).toBe(1);
    expect(stdout).toContain(DEFAULT_TOML_BLOCK);
    expect(existsSync(cfgPath)).toBe(false);
  });

  test('a running seat whose pane has no display_agent field in pane list --workspace is named as missing or expired; a stopped seat is never named', () => {
    const { root, home } = setupWorld();
    const queriedWorkspaces: string[] = [];

    const { code, out } = runCheck(root, home, {
      live: buildLive(undefined),
      sidebar: {
        paneDisplays: (_session, workspace) => {
          queriedWorkspaces.push(workspace);
          return [
            { pane: 'pane-lead', workspace: 'ws-lead' },
            { pane: 'pane-stopped', workspace: 'ws-stopped' },
          ];
        },
      },
    });

    expect(code).toBe(1);
    expect(queriedWorkspaces).toEqual(['ws-lead']);
    expect(out).toContain(
      `difference: lead: its sidebar display line is missing or expired; the file's line is "${LEAD_DISPLAY}"`,
    );
    expect(out).not.toContain('worker-stopped');
  });

  test('--repair re-applies the config (under manage: true and manage: false), reloads running sessions, records the reload, and re-reports displayAgent(seat) with --ttl-ms', () => {
    for (const manageValue of ['on', 'off'] as const) {
      const { root, home } = setupWorld({ writeValidConfig: false, recordCurrentReload: false });
      const manageWritten = writePolicySet(
        home,
        { level: 'entity', target: 'acme', name: 'workspace.sidebar.manage', value: manageValue },
        { now: NOW },
      );
      if (!manageWritten.ok) throw new Error(manageWritten.why);
      const ttlWritten = writePolicySet(
        home,
        { level: 'entity', target: 'acme', name: 'daemon.sidebar-ttl-ms', value: 7_200_000 },
        { now: NOW },
      );
      if (!ttlWritten.ok) throw new Error(ttlWritten.why);

      const reloadedCalls: string[] = [];
      const displayReports: Array<{ session: string; pane: string; text: string; ttlMs: number | undefined }> = [];

      const { code, out } = runCheck(root, home, {
        repair: true,
        live: buildLive(undefined),
        reportDisplayAgent: (session, pane, text, ttlMs) => {
          displayReports.push({ session, pane, text, ttlMs });
          return true;
        },
        sidebar: {
          sessions: () => [
            { name: 'acme-acme-app', running: true },
            { name: 'dormant-session', running: false },
          ],
          paneDisplays: () => [{ pane: 'pane-lead', workspace: 'ws-lead' }],
          checkConfig: () => ({ ok: true, text: 'config: ok' }),
          reloadSession: (session) => {
            reloadedCalls.push(session);
            return { applied: true, text: 'applied' };
          },
        },
      });

      expect(code).toBe(0);
      expect(out).toContain(
        `repaired: the terminal host's sidebar config is set to rows "${DEFAULT_ROWS_WORD}" and status_indicators "symbols"`,
      );
      expect(out).toContain(
        `repaired: session "acme-acme-app": reloaded the terminal host's sidebar config (rows "${DEFAULT_ROWS_WORD}", status_indicators "symbols")`,
      );
      expect(out).toContain('repaired: lead:');
      expect(out).toContain(`is set back to "${LEAD_DISPLAY}"`);
      expect(out).toContain('no differences');

      const cfgText = readFileSync(hostConfigPath(home), 'utf8');
      expect(cfgText).toContain('status_indicators = "symbols" # managed by team');
      expect(cfgText).toContain('[ui.sidebar.agents] # managed by team');

      expect(reloadedCalls).toEqual(['acme-acme-app']);
      const recordedReloads = readSidebarReloads(home);
      expect(recordedReloads['acme-acme-app']).toEqual({
        rows: DEFAULT_ROWS_WORD,
        indicators: 'symbols',
        at: NOW.toISOString(),
      });

      expect(displayReports).toEqual([
        {
          session: 'acme-acme-app',
          pane: 'pane-lead',
          text: LEAD_DISPLAY,
          ttlMs: Math.min(2 * 3_600_000, SIDEBAR_TTL_CAP_MS),
        },
      ]);
    }
  });

  test('a host refusal on config validation, session reload, or display report leaves the difference standing and is named', () => {
    // 1. Host config validation refusal rolls back the file, names the refusal, and leaves config + reload differences standing.
    const world1 = setupWorld({ writeValidConfig: false, recordCurrentReload: false });
    const cfgPath1 = hostConfigPath(world1.home);
    mkdirSync(join(cfgPath1, '..'), { recursive: true });
    const priorBytes = '# original owner config\n';
    writeFileSync(cfgPath1, priorBytes, { mode: 0o600 });

    const refusedConfig = runCheck(world1.root, world1.home, {
      repair: true,
      sidebar: {
        sessions: () => [{ name: 'acme-acme-app', running: true }],
        checkConfig: () => ({ ok: false, text: 'invalid sidebar table' }),
      },
    });
    expect(refusedConfig.code).toBe(1);
    expect(refusedConfig.out).toContain(
      "sidebar: the terminal host's config was not updated (invalid sidebar table)",
    );
    expect(refusedConfig.out).toContain('line 2 has nowhere to live');
    expect(readFileSync(cfgPath1, 'utf8')).toBe(priorBytes);

    // 2. Host reload refusal on a running session names the refusal and leaves the session difference + display difference standing.
    const world2 = setupWorld({ writeValidConfig: true, recordCurrentReload: false });
    const refusedReloadAndDisplay = runCheck(world2.root, world2.home, {
      repair: true,
      live: buildLive(undefined),
      reportDisplayAgent: () => false,
      sidebar: {
        sessions: () => [{ name: 'acme-acme-app', running: true }],
        paneDisplays: () => [{ pane: 'pane-lead', workspace: 'ws-lead' }],
        reloadSession: () => ({ applied: false, text: 'reload socket refused' }),
      },
    });
    expect(refusedReloadAndDisplay.code).toBe(1);
    expect(refusedReloadAndDisplay.out).toContain(
      'session "acme-acme-app": sidebar config reload was refused (reload socket refused)',
    );
    expect(refusedReloadAndDisplay.out).toContain('lead: its display was not reported');
    expect(refusedReloadAndDisplay.out).toContain(
      'difference: session "acme-acme-app": no TeamCLI reload recorded at the current layout',
    );
    expect(refusedReloadAndDisplay.out).toContain(
      `difference: lead: its sidebar display line is missing or expired; the file's line is "${LEAD_DISPLAY}"`,
    );
  });

  test('both repairs are gated on the owner\'s --repair alone', () => {
    const { root, home } = setupWorld({ writeValidConfig: false, recordCurrentReload: false });
    const cfgPath = hostConfigPath(home);

    const nonOwner = runCheck(root, home, {
      repair: true,
      caller: {
        kind: 'seat',
        name: 'lead',
        pane: 'pane-lead',
        session: 'acme-acme-app',
      },
      live: buildLive(undefined),
      sidebar: {
        paneDisplays: () => [{ pane: 'pane-lead', workspace: 'ws-lead' }],
      },
    });

    expect(nonOwner.code).toBe(1);
    expect(nonOwner.stderr).toContain("team check: --repair is the owner's");
    expect(existsSync(cfgPath)).toBe(false);
    expect(readSidebarReloads(home)).toEqual({});
  });

  test('an omitted host method on the sidebar seam calls the adapter, never a fake ok', () => {
    const { root, home } = setupWorld({ writeValidConfig: false, recordCurrentReload: false });
    const cfgPath = hostConfigPath(home);
    mkdirSync(join(cfgPath, '..'), { recursive: true });
    const priorBytes = '# owner config before repair\n';
    writeFileSync(cfgPath, priorBytes, { mode: 0o600 });

    const captureCalls: string[][] = [];
    const runCalls: { args: string[]; session?: string }[] = [];
    let configCheckOk = false;

    setCaptureExec((args) => {
      captureCalls.push(args);
      if (args[0] === 'session' && args[1] === 'list') {
        return JSON.stringify({ sessions: [{ name: 'acme-acme-app', running: true }] });
      }
      if (args[0] === 'config' && args[1] === 'check') {
        if (!configCheckOk) {
          const err = new Error('config check failed') as Error & { stdout?: string };
          err.stdout = 'config: issues found (adapter rejected config)';
          throw err;
        }
        return 'config: ok\n';
      }
      if (args.includes('reload-config')) {
        return JSON.stringify({ error: { message: 'adapter reload refused' } });
      }
      if (args.includes('report-metadata')) {
        return JSON.stringify({ error: { message: 'adapter metadata refused' } });
      }
      return '';
    });

    setHerdrRun((args, session) => {
      runCalls.push({ args, ...(session === undefined ? {} : { session }) });
      if (args[0] === 'pane' && args[1] === 'list') {
        return { panes: [{ pane_id: 'pane-lead', workspace_id: 'ws-lead' }] };
      }
      if (args[0] === 'server' && args[1] === 'reload-config') {
        return { status: 'failed', diagnostics: ['adapter reload refused'] };
      }
      return null;
    });

    // 1. With sidebar: {} (checkConfig, reloadSession, sessions, paneDisplays all omitted),
    //    --repair calls the adapter's config check, sees its refusal (never a fake ok), and rolls back.
    const first = runCheck(root, home, {
      repair: true,
      live: buildLive(undefined),
      rawSidebar: {},
    });
    expect(first.code).toBe(1);
    expect(captureCalls.some((c) => c[0] === 'config' && c[1] === 'check')).toBe(true);
    expect(captureCalls.some((c) => c[0] === 'session' && c[1] === 'list')).toBe(true);
    expect(runCalls.some((c) => c.args[0] === 'pane' && c.args[1] === 'list')).toBe(true);
    expect(first.out).toContain("sidebar: the terminal host's config was not updated");
    expect(readFileSync(cfgPath, 'utf8')).toBe(priorBytes);

    // 2. When config check succeeds on the adapter but reload-config refuses on the adapter,
    //    --repair with sidebar: {} calls the adapter's reload-config and reports the refusal (never a fake ok).
    configCheckOk = true;
    const second = runCheck(root, home, {
      repair: true,
      live: buildLive(undefined),
      rawSidebar: {},
    });
    expect(second.code).toBe(1);
    expect(
      runCalls.some((c) => c.args[0] === 'server' && c.args[1] === 'reload-config' && c.session === 'acme-acme-app'),
    ).toBe(true);
    expect(second.out).toContain('session "acme-acme-app": sidebar config reload was refused');
    expect(second.out).toContain('adapter reload refused');
    expect(second.out).toContain('difference: session "acme-acme-app": no TeamCLI reload recorded at the current layout');
    expect(second.out).toContain(
      `difference: lead: its sidebar display line is missing or expired; the file's line is "${LEAD_DISPLAY}"`,
    );
  });
});
