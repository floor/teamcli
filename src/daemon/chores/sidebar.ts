import { traceChildStep } from '../../diagnostics/child-steps.ts';
// The sidebar display-agent refresh as one of the chores child's passes.
//
// Since the terminal host's metadata carries a TTL, a seat's display line (model and effort)
// reported once at launch lapses unless re-reported before the window closes. An interactive
// watch repaints on model or effort change, and its ~5 s sweep refreshes while it runs, but a
// quiet seat or a root without a watch needs a periodic backstop.
//
// Reads and reports are awaited, bounded display work. The child defers this pass until its
// hosted watch completes its first cycle; a slow host skips the remaining display work. A root configured with
// `daemon.chores: inline` is skipped here with a note naming it.
//
// Before reporting a seat's declared `displayAgent(seat)`, the pass reads the pane's current
// display line from the workspace pane list (the read-back guard):
// - Absent (never reported or expired) -> report `displayAgent(seat)` with `--ttl-ms`.
// - Present and equal -> re-report `displayAgent(seat)` with `--ttl-ms`, extending the window.
// - Present and different -> a live observation from the screen stands; skip the seat and note it.
import { join } from 'node:path';
import { DEFAULT_CHILD_TIMEOUT_MS } from '../../child.ts';
import { displayAgent } from '../../file/sections/seats.ts';
import { readTeamConfig } from '../../file/team-config.ts';
import type { TeamFile } from '../../file/types.ts';
import {
  reportDisplayAgentAsync,
  sessionPaneDisplaysAsync,
  sessionRunningAsync,
  type HerdrReadOptions,
  workspaceList,
  workspacePaneDisplays,
  type WorkspacePaneDisplay,
} from '../../herdr.ts';
import { sidebarPolicy } from '../../settings/sidebar-policy.ts';
import { readState, type SeatState } from '../../state.ts';
import type { ChoresPass } from './child.ts';
import { choresPolicyFor } from './policy.ts';
import type { ChoresChildConfig } from './protocol.ts';

export type SidebarPassSources = {
  /** The production read: all pane displays in the named session, once per refresh pass. */
  sessionPanes?: (session: string, options: HerdrReadOptions) => Promise<WorkspacePaneDisplay[] | null>;
  /** Awaited metadata report; the production adapter force-ends the read child at its deadline. */
  reportDisplayAsync?: (pane: string, text: string, session: string, ttlMs: number, options: HerdrReadOptions) => Promise<boolean>;
  /** Whether the session runs: false when stopped, null when the host did not answer. With an
   *  injected `sessionPanes` and no reader here, the read answers null (unknown). */
  sessionRunning?: (session: string, options: HerdrReadOptions) => Promise<boolean | null>;
  /** Monotonic clock seam for budget scenes. */
  clock?: () => number;
  /** Reads the current display line for a pane: `undefined` when absent or expired, `null` when
   *  the terminal host refused or could not be reached. When omitted, reads `workspacePanes`. */
  paneDisplay?: (session: string, pane: string, workspace?: string) => string | undefined | null;
  /** Lists the panes and their display lines in a workspace, or `null` when the host refused. */
  workspacePanes?: (workspace: string, session?: string) => WorkspacePaneDisplay[] | null;
  /** Lists the workspaces in a session when a seat record carries no workspace id. */
  workspaces?: (session?: string) => readonly { id: string }[] | null;
  /** Reports a pane's display line with `--ttl-ms`. False when the terminal host refused. */
  reportDisplay?: (pane: string, text: string, session: string, ttlMs: number) => boolean;
  /** Reads the session's recorded seats from state. */
  readSeats?: (stateDir: string, session: string) => Record<string, SeatState>;
  /** Reads the root's team file when the route token did not carry one. */
  readTeam?: (root: string, home: string) => { ok: true; team: TeamFile } | { ok: false; error: string };
};

function defaultReadSeats(stateDir: string, session: string): Record<string, SeatState> {
  return readState(stateDir).sessions[session]?.seats ?? {};
}

function defaultReadTeam(
  root: string,
  home: string,
): { ok: true; team: TeamFile } | { ok: false; error: string } {
  const loaded = readTeamConfig(root, { home });
  if (loaded.ok) return { ok: true, team: loaded.team };
  const reason = loaded.errors.map((item) => item.message).join('; ') || 'team file could not be read';
  return { ok: false, error: reason };
}

/**
 * Builds the per-root sidebar metadata refresh pass for a chores child. Each seat with a
 * recorded pane is refreshed at `daemon.sidebar-refresh-ms` cadence; a seat whose host call
 * refuses is noted and left due so the next pass retries it.
 */
/** The sidebar refresh's first wait after the terminal host did not answer, and its ceiling. */
export const SIDEBAR_BACKOFF_FIRST_MS = 30_000;
export const SIDEBAR_BACKOFF_MAX_MS = 10 * 60_000;
/** The re-check wait while the root's session is stopped: the first backoff wait, never doubled. */
export const SIDEBAR_STOPPED_POLL_MS = SIDEBAR_BACKOFF_FIRST_MS;

export function createSidebarPass(
  config: ChoresChildConfig,
  sources: SidebarPassSources = {},
): ChoresPass {
  const lastRefreshedAt = new Map<string, number>();
  /** Per root: while the terminal host does not answer the display read, the refresh backs off
   *  (30 s, doubling to 10 min) instead of asking again every beat; an answer clears it. */
  const hostBackoff = new Map<string, { until: number; waitMs: number }>();
  const readWorkspacePanes = sources.workspacePanes ?? workspacePaneDisplays;
  const readWorkspaces = sources.workspaces ?? workspaceList;
  const report = sources.reportDisplayAsync ?? sources.reportDisplay ?? reportDisplayAgentAsync;
  const sessionPanes = sources.sessionPanes ?? sessionPaneDisplaysAsync;
  const sessionRunning = sources.sessionRunning
    ?? (sources.sessionPanes === undefined ? sessionRunningAsync : async () => null);
  // The old injected read seams keep their synthetic scenes; production uses only the session read.
  const injectedWorkspaceReader = sources.paneDisplay !== undefined || sources.workspacePanes !== undefined || sources.workspaces !== undefined;
  const clock = sources.clock ?? (() => performance.now());
  const readSeats = sources.readSeats ?? defaultReadSeats;
  const readTeam = sources.readTeam ?? defaultReadTeam;

  return async ({ route, at, slices }) => {
    if (slices.stopping()) return [];
    // Lead decision 2026-11-11 05:53Z: optional display work gets the existing chores slice,
    // and each call is also bounded by DEFAULT_CHILD_TIMEOUT_MS, never a new policy limit.
    const deadline = clock() + slices.sliceMs;
    const bounded = async <T>(operation: (options: HerdrReadOptions) => T | Promise<T>): Promise<T | null> => {
      const remaining = Math.floor(Math.min(DEFAULT_CHILD_TIMEOUT_MS, deadline - clock()));
      if (slices.stopping() || remaining <= 0) return null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining);
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => operation({ timeoutMs: remaining, signal: controller.signal })), expired,
        ]);
      } catch { return null; }
      finally { if (timer !== undefined) clearTimeout(timer); }
    };

    let team: TeamFile;
    if (route.teamFile !== undefined) {
      team = route.teamFile;
    } else {
      const loaded = readTeam(route.root, config.home);
      if (!loaded.ok) return [`sidebar refresh: ${loaded.error}`];
      team = loaded.team;
    }

    const choresPolicy = choresPolicyFor(team, route.root, config.home, at);
    if (choresPolicy.mode === 'inline') {
      return [`sidebar refresh: skipped for ${route.root} (daemon.chores is inline)`];
    }

    const policy = sidebarPolicy({
      home: config.home,
      root: route.root,
      team,
      now: at,
    });

    const stateDir = route.stateDir ?? join(route.root, '.agents');
    let seats: Record<string, SeatState>;
    try {
      seats = readSeats(stateDir, route.session);
    } catch (error) {
      return [
        `sidebar refresh: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }

    const nowMs = at.getTime();
    const due = team.seats.flatMap((seat) => {
      const recorded = seats[seat.name];
      const pane = recorded?.pane;
      if (typeof pane !== 'string' || pane === '') return [];
      const key = `${route.root}\0${seat.name}`;
      const last = lastRefreshedAt.get(key);
      if (last !== undefined && nowMs - last < policy.refreshMs) return [];
      return [{ seat, pane, workspace: recorded?.workspace, key }];
    });
    if (due.length === 0) return [];
    const backoff = hostBackoff.get(route.root);
    if (backoff !== undefined && nowMs < backoff.until) return [];

    const allPanes = injectedWorkspaceReader ? undefined : await traceChildStep(
      'sidebar session pane-list', () => bounded((options) => sessionPanes(route.session, options)),
    );
    if (allPanes === null) {
      // A session that is simply not running (after a machine restart, until the owner attaches
      // it) is not a slow host: re-check on the first wait, never doubling, so the lines are
      // painted within one wait of the attach rather than up to ten minutes later.
      const running = await traceChildStep(
        'sidebar session state', () => bounded((options) => sessionRunning(route.session, options)),
      );
      if (running === false) {
        hostBackoff.set(route.root, { until: nowMs + SIDEBAR_STOPPED_POLL_MS, waitMs: 0 });
        return backoff === undefined
          ? [`sidebar refresh: the session "${route.session}" is not running; the lines are painted once it is attached`]
          : [];
      }
      const waitMs = Math.min(SIDEBAR_BACKOFF_MAX_MS, backoff === undefined || backoff.waitMs === 0 ? SIDEBAR_BACKOFF_FIRST_MS : backoff.waitMs * 2);
      hostBackoff.set(route.root, { until: nowMs + waitMs, waitMs });
      // Said once per stretch: a backing-off refresh is quiet until the host answers again.
      return backoff === undefined
        ? [`sidebar refresh: skipped; the terminal host did not answer within the display slice (next try in ${String(Math.round(waitMs / 1000))} s, backing off)`]
        : [];
    }
    hostBackoff.delete(route.root);

    const workspaceCache = new Map<string, WorkspacePaneDisplay[] | null>();
    let listedWorkspaces: readonly { id: string }[] | null | undefined;
    const readFromWorkspaces = (
      session: string,
      pane: string,
      workspace?: string,
    ): string | undefined | null => {
      const readOne = (ws: string): WorkspacePaneDisplay[] | null => {
        if (workspaceCache.has(ws)) return workspaceCache.get(ws) ?? null;
        const listed = traceChildStep('sidebar pane-list', () => readWorkspacePanes(ws, session));
        workspaceCache.set(ws, listed);
        return listed;
      };
      if (typeof workspace === 'string' && workspace !== '') {
        const panes = readOne(workspace);
        if (panes === null) return null;
        return panes.find((entry) => entry.pane === pane)?.displayAgent;
      }
      for (const cached of workspaceCache.values()) {
        if (cached === null) continue;
        const found = cached.find((entry) => entry.pane === pane);
        if (found !== undefined) return found.displayAgent;
      }
      if (listedWorkspaces === undefined) {
        listedWorkspaces = traceChildStep('sidebar workspace-list', () => readWorkspaces(session));
      }
      if (listedWorkspaces === null) return null;
      for (const ws of listedWorkspaces) {
        const panes = readOne(ws.id);
        if (panes === null) return null;
        const found = panes.find((entry) => entry.pane === pane);
        if (found !== undefined) return found.displayAgent;
      }
      return undefined;
    };

    const readPaneDisplay = sources.paneDisplay ?? (allPanes !== undefined
      ? (_session: string, pane: string) => allPanes.find((entry) => entry.pane === pane)?.displayAgent
      : readFromWorkspaces);
    const notes: string[] = [];

    for (let index = 0; index < due.length; index += 1) {
      if (slices.stopping() || clock() >= deadline) return notes;
      const item = due[index];
      if (item === undefined) continue;
      const { seat, pane, workspace, key } = item;
      const expected = displayAgent(seat);

      let current: string | undefined | null;
      let readError: string | null = null;
      try {
        current = readPaneDisplay(route.session, pane, workspace);
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
        current = null;
      }

      if (current === null) {
        notes.push(
          `sidebar refresh: ${seat.name} (${pane}): ${readError ?? 'the terminal host did not answer for the workspace panes'}`,
        );
      } else if (current !== undefined && current !== expected) {
        notes.push(
          `sidebar refresh: ${seat.name} (${pane}): skipped; live display "${current}" differs from declared "${expected}"`,
        );
        lastRefreshedAt.set(key, nowMs);
      } else {
        let reported = false;
        let reportError: string | null = null;
        try {
          reported = (await traceChildStep('sidebar metadata-report', () => bounded((options) => report(pane, expected, route.session, policy.ttlMs, options)))) ?? false;
        } catch (error) {
          reportError = error instanceof Error ? error.message : String(error);
          reported = false;
        }
        if (reported) {
          lastRefreshedAt.set(key, nowMs);
        } else {
          notes.push(
            `sidebar refresh: ${seat.name} (${pane}): ${reportError ?? 'display was not reported'}`,
          );
        }
      }

      if (index + 1 < due.length) {
        if (slices.stopping()) return notes;
        if (!(await slices.yield()) || slices.stopping()) return notes;
      }
    }

    return notes;
  };
}
