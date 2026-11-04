// The sidebar display-agent refresh as one of the chores child's passes.
//
// Since the terminal host's metadata carries a TTL, a seat's display line (model and effort)
// reported once at launch lapses unless re-reported before the window closes. An interactive
// watch repaints on model or effort change, and its ~5 s sweep refreshes while it runs, but a
// quiet seat or a root without a watch needs a periodic backstop.
//
// Each report shells out synchronously to the terminal host, so this pass runs only inside the
// supervised chores child — never on the daemon's main loop. A root configured with
// `daemon.chores: inline` is skipped here with a note naming it.
//
// Before reporting a seat's declared `displayAgent(seat)`, the pass reads the pane's current
// display line from the workspace pane list (the read-back guard):
// - Absent (never reported or expired) -> report `displayAgent(seat)` with `--ttl-ms`.
// - Present and equal -> re-report `displayAgent(seat)` with `--ttl-ms`, extending the window.
// - Present and different -> a live observation from the screen stands; skip the seat and note it.
import { join } from 'node:path';
import { displayAgent } from '../../file/sections/seats.ts';
import { readTeamConfig } from '../../file/team-config.ts';
import type { TeamFile } from '../../file/types.ts';
import {
  reportDisplayAgent,
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
export function createSidebarPass(
  config: ChoresChildConfig,
  sources: SidebarPassSources = {},
): ChoresPass {
  const lastRefreshedAt = new Map<string, number>();
  const readWorkspacePanes = sources.workspacePanes ?? workspacePaneDisplays;
  const readWorkspaces = sources.workspaces ?? workspaceList;
  const report =
    sources.reportDisplay
    ?? ((pane: string, text: string, session: string, ttlMs: number) =>
      reportDisplayAgent(pane, text, session, ttlMs));
  const readSeats = sources.readSeats ?? defaultReadSeats;
  const readTeam = sources.readTeam ?? defaultReadTeam;

  return async ({ route, at, slices }) => {
    if (slices.stopping()) return [];

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

    const workspaceCache = new Map<string, WorkspacePaneDisplay[] | null>();
    let listedWorkspaces: readonly { id: string }[] | null | undefined;
    const readFromWorkspaces = (
      session: string,
      pane: string,
      workspace?: string,
    ): string | undefined | null => {
      const readOne = (ws: string): WorkspacePaneDisplay[] | null => {
        if (workspaceCache.has(ws)) return workspaceCache.get(ws) ?? null;
        const listed = readWorkspacePanes(ws, session);
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
        listedWorkspaces = readWorkspaces(session);
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

    const readPaneDisplay = sources.paneDisplay ?? readFromWorkspaces;
    const notes: string[] = [];

    for (let index = 0; index < due.length; index += 1) {
      if (slices.stopping()) return notes;
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
          reported = report(pane, expected, route.session, policy.ttlMs);
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
