import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { TeamFile } from '../file/types.ts';
import {
  applySidebarLayout,
  DEFAULT_SIDEBAR_ROWS,
  hostConfigCheck,
  hostConfigPath,
  isHostAdapterMocked,
  readSidebarConfig,
  reloadConfig,
  renderSidebarTomlBlock,
  sessionList,
  workspacePaneDisplays,
  type ConfigReload,
  type SidebarApply,
  type WorkspacePaneDisplay,
} from '../herdr.ts';
import type { Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { sidebarConfigText } from '../launch/sidebar-step.ts';
import { sidebarRowsWord } from '../policy/types.ts';
import {
  readSidebarReloads,
  recordSidebarReloads,
  sidebarReloadsFile,
  type SidebarReloadRecord,
} from '../registry/sidebar-reloads.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
import { sidebarPolicy } from '../settings/sidebar-policy.ts';
import type { SessionState } from '../state.ts';
import type { Difference, Live } from '../status/compare.ts';

/**
 * The optional seam in `CheckSources` for the two sidebar checks (layout per session and
 * pane `display_agent` metadata) and their `--repair` writes. Every method defaults to the
 * terminal host adapter when omitted, so `realCheckSources` wires the adapter and tests can
 * override only the pieces they fake.
 */
export type CheckSidebarSources = {
  /** The terminal host config's text: `''` when absent, `null` when unreadable. */
  configText?: (home: string) => string | null;
  /** Every session the terminal host lists, with its running state. */
  sessions?: () => readonly { name: string; running: boolean }[] | null;
  /** Alias for `sessions` matching `UpSources.hostSessions`. */
  hostSessions?: () => readonly { name: string; running: boolean }[] | null;
  /** The panes in a workspace and the `display_agent` the host holds for each (`pane list --workspace`). */
  paneDisplays?: (session: string, workspace: string) => readonly WorkspacePaneDisplay[] | null;
  /** Applies the sidebar layout to the terminal host's config and reloads the given running sessions. */
  applyLayout?: (
    home: string,
    rows: readonly (readonly string[])[],
    indicators: string,
    sessions: readonly string[],
  ) => SidebarApply;
  /** The terminal host's `config check` validation for the default `applyLayout` path. */
  checkConfig?: () => { ok: boolean; text: string };
  /** Reloads one running session's server onto the sidebar config (`server reload-config`). */
  reloadSession?: (session: string) => ConfigReload;
  /** Alias for `reloadSession`. */
  reload?: (session: string) => ConfigReload;
  /** Records applied session reloads in the machine-scoped reload store. */
  recordReloads?: (
    home: string,
    entries: readonly { session: string; record: SidebarReloadRecord }[],
  ) => void;
};

/** The shipped sidebar sources for `realCheckSources`. */
export const realSidebarCheckSources: CheckSidebarSources = {
  configText: (home) => sidebarConfigText(home),
  sessions: () => sessionList(),
  paneDisplays: (session, workspace) =>
    workspacePaneDisplays(workspace, session === 'default' ? undefined : session),
  checkConfig: () => hostConfigCheck(),
  reloadSession: (session) => reloadConfig(session),
};

function hasLayoutSeam(sidebar: CheckSidebarSources | undefined, home: string | undefined): boolean {
  if (sidebar === undefined) return false;
  if (sidebar === realSidebarCheckSources) return home === homedir();
  if (Object.keys(sidebar).length === 0) return true;
  return (
    sidebar.configText !== undefined ||
    sidebar.sessions !== undefined ||
    sidebar.hostSessions !== undefined ||
    sidebar.applyLayout !== undefined ||
    sidebar.checkConfig !== undefined ||
    sidebar.reloadSession !== undefined ||
    sidebar.reload !== undefined ||
    sidebar.recordReloads !== undefined
  );
}

/**
 * Whether a check run exercises the sidebar config and session-reload checks: true whenever
 * `sources.sidebar` carries a layout seam (or `realCheckSources` runs against the real home),
 * when the adapter has a fake runner installed, or when `home` carries a host config, a reload
 * record store, or a non-default sidebar policy. Legacy unit scenes that pass a bare
 * `{ live, branch, standing, now, home }` without any sidebar state stay untouched.
 */
export function isSidebarCheckActive(
  home: string | undefined,
  root: string,
  team: TeamFile,
  now: Date,
  sidebar: CheckSidebarSources | undefined,
): boolean {
  if (hasLayoutSeam(sidebar, home) || isHostAdapterMocked()) return true;
  if (home === undefined) return false;
  if (existsSync(hostConfigPath(home)) || existsSync(sidebarReloadsFile(home))) return true;
  const resolved = sidebarPolicy({ home, root, team, now });
  return (
    !resolved.manage ||
    resolved.indicators !== 'symbols' ||
    sidebarRowsWord(resolved.rows) !== sidebarRowsWord(DEFAULT_SIDEBAR_ROWS)
  );
}

/**
 * Reads `pane list --workspace <id>` once per distinct workspace of running seats that hold a
 * recorded pane, returning a map from `pane` id to `displayAgent` (`undefined` when the pane is
 * present in `pane list` with no `display_agent` field). Returns `null` when no `pane list`
 * source is wired or reachable, so legacy fixtures keep their existing `live.agents` reading.
 */
export function readSeatPaneDisplays(
  session: string,
  team: TeamFile,
  state: SessionState,
  live: Live,
  sidebar: CheckSidebarSources | undefined,
  home?: string,
): ReadonlyMap<string, string | undefined> | null {
  if (!live.running) return null;
  const reader =
    sidebar !== undefined && sidebar !== realSidebarCheckSources
      ? (sidebar.paneDisplays ??
        (isHostAdapterMocked()
          ? (s: string, w: string) => workspacePaneDisplays(w, s === 'default' ? undefined : s)
          : undefined))
      : sidebar === realSidebarCheckSources && (home === homedir() || isHostAdapterMocked())
        ? realSidebarCheckSources.paneDisplays
        : isHostAdapterMocked()
          ? (s: string, w: string) => workspacePaneDisplays(w, s === 'default' ? undefined : s)
          : undefined;
  if (reader === undefined) return null;

  const workspaces = new Set<string>();
  for (const seat of team.seats) {
    if (seat.stopped) continue;
    const held = state.seats[seat.name];
    if (!held?.pane) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name && candidate.pane === held.pane);
    const workspace = held.workspace ?? agent?.workspace;
    if (typeof workspace === 'string' && workspace !== '') workspaces.add(workspace);
  }
  if (workspaces.size === 0) return null;

  const map = new Map<string, string | undefined>();
  let anyAnswered = false;
  for (const workspace of workspaces) {
    const panes = reader(session, workspace);
    if (panes === null) continue;
    anyAnswered = true;
    for (const entry of panes) {
      map.set(entry.pane, entry.displayAgent);
    }
  }
  return anyAnswered ? map : null;
}

function entityRunningSessions(
  home: string,
  root: string,
  team: TeamFile,
  currentSession: string,
  hostSessions: readonly { name: string; running: boolean }[] | null,
): string[] {
  if (hostSessions === null) return [];
  const known = new Set<string>([currentSession, team.session]);
  let hasRegisteredTeams = false;
  try {
    const teams = readTeams(home);
    const entries = Object.entries(teams);
    hasRegisteredTeams = entries.length > 0;
    const own = teamIdOf(root);
    const entity = team.entity ?? null;
    for (const [id, record] of entries) {
      if (id !== own && (entity === null || record.entity !== entity)) continue;
      known.add(record.session);
      for (const lobby of Object.keys(record.lobbies ?? {})) known.add(lobby);
    }
  } catch {
    // Unreadable team registry is named by registryDifferences; fall back to known sessions.
  }
  return [
    ...new Set(
      hostSessions
        .filter((one) => one.running && (!hasRegisteredTeams || known.has(one.name)))
        .map((one) => one.name),
    ),
  ].sort();
}

function safeReadReloads(home: string): Record<string, SidebarReloadRecord> {
  try {
    return readSidebarReloads(home);
  } catch {
    return {};
  }
}

export type SidebarRepairState = {
  repaired: string[];
  configApplied: boolean;
  reloadedSessions: ReadonlySet<string>;
};

export const EMPTY_SIDEBAR_REPAIR: SidebarRepairState = {
  repaired: [],
  configApplied: false,
  reloadedSessions: new Set(),
};

type EvaluatedSidebar = {
  manage: boolean;
  resolvedRows: string;
  resolvedIndicators: string;
  rowsMatrix: readonly (readonly string[])[];
  tomlBlock: string;
  rowsDiff: string | null;
  indicatorsDiff: string | null;
  runningSessions: string[];
  sessionDiffs: { session: string; what: string }[];
};

function evaluateSidebar(
  home: string,
  root: string,
  team: TeamFile,
  currentSession: string,
  now: Date,
  sidebar: CheckSidebarSources | undefined,
  repairState: SidebarRepairState,
): EvaluatedSidebar {
  const policy = sidebarPolicy({ home, root, team, now });
  const resolvedRows = sidebarRowsWord(policy.rows);
  const resolvedIndicators = policy.indicators;
  const tomlBlock = renderSidebarTomlBlock(policy.rows, resolvedIndicators);

  const readText = sidebar?.configText ?? sidebarConfigText;
  const text = repairState.configApplied ? tomlBlock : readText(home);

  let rowsDiff: string | null = null;
  let indicatorsDiff: string | null = null;
  if (text === null) {
    rowsDiff = `the terminal host's config cannot be read (line 2 has nowhere to live); the resolved layout template is "${resolvedRows}"`;
    indicatorsDiff = `the terminal host's config cannot be read; the resolved status_indicators value is "${resolvedIndicators}"`;
  } else {
    const parsed = readSidebarConfig(text);
    if (!parsed.hasAgentToken) {
      const detail =
        parsed.rows === null
          ? 'defines no sidebar agent rows'
          : `sidebar layout "${sidebarRowsWord(parsed.rows)}" has no "agent" token in any row`;
      rowsDiff = `the terminal host's config ${detail} (line 2 has nowhere to live); the resolved layout template is "${resolvedRows}"`;
    } else if (sidebarRowsWord(parsed.rows!) !== resolvedRows) {
      rowsDiff = `the terminal host's config sidebar layout reads "${sidebarRowsWord(parsed.rows!)}"; the resolved layout template is "${resolvedRows}"`;
    }
    if (parsed.indicators !== resolvedIndicators) {
      const current = parsed.indicators === null ? 'unset' : `"${parsed.indicators}"`;
      indicatorsDiff = `the terminal host's config status_indicators is ${current}; the resolved value is "${resolvedIndicators}"`;
    }
  }

  const readSessions =
    sidebar?.sessions ??
    sidebar?.hostSessions ??
    (isHostAdapterMocked() ? () => sessionList() : () => null);
  const runningSessions = entityRunningSessions(home, root, team, currentSession, readSessions());
  const reloads = safeReadReloads(home);
  const sessionDiffs: { session: string; what: string }[] = [];
  for (const sessionName of runningSessions) {
    if (repairState.reloadedSessions.has(sessionName)) continue;
    const record = reloads[sessionName];
    if (record === undefined) {
      sessionDiffs.push({
        session: sessionName,
        what: `session "${sessionName}": no TeamCLI reload recorded at the current layout (rows "${resolvedRows}", status_indicators "${resolvedIndicators}"); the terminal host's live sidebar layout cannot be read back, so a running session is presumed to hold an older layout until TeamCLI records a reload (even if reloaded by hand)`,
      });
    } else if (record.rows !== resolvedRows || record.indicators !== resolvedIndicators) {
      sessionDiffs.push({
        session: sessionName,
        what: `session "${sessionName}": no TeamCLI reload recorded at the current layout (recorded rows "${record.rows}", status_indicators "${record.indicators}"; resolved rows "${resolvedRows}", status_indicators "${resolvedIndicators}"); the terminal host's live sidebar layout cannot be read back, so a running session is presumed to hold the older layout until TeamCLI records a reload (even if reloaded by hand)`,
      });
    }
  }

  return {
    manage: policy.manage,
    resolvedRows,
    resolvedIndicators,
    rowsMatrix: policy.rows,
    tomlBlock,
    rowsDiff,
    indicatorsDiff,
    runningSessions,
    sessionDiffs,
  };
}

/**
 * The owner's `--repair` of the sidebar layout and per-session reloads. Applies under both
 * `workspace.sidebar.manage: true` and `false` on the owner's explicit `--repair` request,
 * using the same backup/splice/validate/rollback path as `team up`.
 */
export function repairSidebarLayout(input: {
  home: string | undefined;
  root: string;
  team: TeamFile;
  session: string;
  now: Date;
  sidebar: CheckSidebarSources | undefined;
  io: Io;
}): SidebarRepairState {
  const { home, root, team, session, now, sidebar, io } = input;
  if (home === undefined || !isSidebarCheckActive(home, root, team, now, sidebar)) {
    return EMPTY_SIDEBAR_REPAIR;
  }

  const evaluated = evaluateSidebar(home, root, team, session, now, sidebar, EMPTY_SIDEBAR_REPAIR);
  const configNeedsWrite = evaluated.rowsDiff !== null || evaluated.indicatorsDiff !== null;
  const sessionsToReload = configNeedsWrite
    ? evaluated.runningSessions
    : evaluated.sessionDiffs.map((item) => item.session);

  if (!configNeedsWrite && sessionsToReload.length === 0) {
    return EMPTY_SIDEBAR_REPAIR;
  }

  const checkConfig =
    sidebar?.checkConfig ??
    (isHostAdapterMocked() ? () => hostConfigCheck() : () => ({ ok: true, text: 'config: ok' }));
  const reload =
    sidebar?.reloadSession ??
    sidebar?.reload ??
    (isHostAdapterMocked() ? (s: string) => reloadConfig(s) : () => ({ applied: true, text: 'applied' }));
  const recordReloads =
    sidebar?.recordReloads ??
    ((targetHome, entries) => recordSidebarReloads(targetHome, entries));

  let outcome: SidebarApply;
  if (configNeedsWrite || sidebar?.applyLayout !== undefined) {
    const applyLayout =
      sidebar?.applyLayout ??
      ((targetHome, rows, indicators, sessions) =>
        applySidebarLayout(targetHome, rows, indicators, sessions, { checkConfig, reload }));
    outcome = applyLayout(home, evaluated.rowsMatrix, evaluated.resolvedIndicators, sessionsToReload);
  } else {
    const reloaded: string[] = [];
    const failed: { session: string; text: string }[] = [];
    for (const sessionName of sessionsToReload) {
      const res = reload(sessionName);
      if (res.applied) reloaded.push(sessionName);
      else failed.push({ session: sessionName, text: res.text });
    }
    outcome = { kind: 'unchanged', reloaded, failed };
  }

  if (outcome.kind === 'refused') {
    io.stdout(`sidebar: the terminal host's config was not updated (${plainLine(outcome.reason)})\n`);
    return EMPTY_SIDEBAR_REPAIR;
  }

  const repaired: string[] = [];
  if (configNeedsWrite) {
    repaired.push(
      `the terminal host's sidebar config is set to rows "${evaluated.resolvedRows}" and status_indicators "${evaluated.resolvedIndicators}"`,
    );
  }
  if (outcome.reloaded.length > 0) {
    recordReloads(
      home,
      outcome.reloaded.map((reloadedSession) => ({
        session: reloadedSession,
        record: {
          rows: evaluated.resolvedRows,
          indicators: evaluated.resolvedIndicators,
          at: now.toISOString(),
        },
      })),
    );
    for (const reloadedSession of outcome.reloaded) {
      repaired.push(
        `session "${reloadedSession}": reloaded the terminal host's sidebar config (rows "${evaluated.resolvedRows}", status_indicators "${evaluated.resolvedIndicators}")`,
      );
    }
  }
  for (const failed of outcome.failed) {
    io.stdout(
      `session "${plainLine(failed.session)}": sidebar config reload was refused (${plainLine(failed.text)})\n`,
    );
  }

  return {
    repaired,
    configApplied: configNeedsWrite || outcome.kind === 'applied',
    reloadedSessions: new Set(outcome.reloaded),
  };
}

/**
 * The sidebar layout and per-session reload differences, plus the exact TOML block to print
 * when `workspace.sidebar.manage` is `false` and a config difference stands.
 */
export function sidebarLayoutDifferences(input: {
  home: string | undefined;
  root: string;
  team: TeamFile;
  session: string;
  now: Date;
  sidebar: CheckSidebarSources | undefined;
  repairState?: SidebarRepairState;
}): { differences: Difference[]; tomlBlock: string | null } {
  const { home, root, team, session, now, sidebar, repairState = EMPTY_SIDEBAR_REPAIR } = input;
  if (home === undefined || !isSidebarCheckActive(home, root, team, now, sidebar)) {
    return { differences: [], tomlBlock: null };
  }

  const evaluated = evaluateSidebar(home, root, team, session, now, sidebar, repairState);
  const differences: Difference[] = [];
  const configRepair = evaluated.manage
    ? 'team check --repair'
    : `apply the sidebar block to the terminal host's config (or run team check --repair): ${evaluated.tomlBlock}`;

  if (evaluated.rowsDiff !== null) {
    differences.push({
      what: evaluated.rowsDiff,
      repair: configRepair,
      owner: true,
    });
  }
  if (evaluated.indicatorsDiff !== null) {
    differences.push({
      what: evaluated.indicatorsDiff,
      repair: configRepair,
      owner: true,
    });
  }
  for (const item of evaluated.sessionDiffs) {
    differences.push({
      what: item.what,
      repair: 'team check --repair',
      owner: true,
    });
  }

  const tomlBlock =
    !evaluated.manage && (evaluated.rowsDiff !== null || evaluated.indicatorsDiff !== null)
      ? evaluated.tomlBlock
      : null;

  return { differences, tomlBlock };
}
