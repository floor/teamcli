// The sidebar step a launch plans before any seat starts (the sidebar-metadata design of
// 2026-11-04). Where `workspace.sidebar.manage` resolves on, the launch writes the resolved
// rows and status indicators into the terminal host's config and reloads every running session
// of the entity's teams onto it; where it resolves off, no step exists at all. This module
// decides what that step is — the layout, the sessions to reload, or that there is nothing to
// do — without running anything, so a dry run and a real run share one answer.
//
// The host exposes no way to read a session's live layout back, so "already in force" is
// witnessed two ways: the config file reads equal on both keys (`spliceSidebarRows` with
// `changed: false`), and every session the step would reload holds a record at the current pair
// (`sidebar-reloads.yaml`). Anything short of both witnesses is a step, never an assumption.

import { readFileSync } from 'node:fs';
import { hostConfigPath, spliceSidebarRows } from '../herdr.ts';
import { readSidebarReloads, type SidebarReloadRecord } from '../registry/sidebar-reloads.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
import { sidebarRowsWord } from '../policy/types.ts';
import { sidebarPolicy, type SidebarIndicator } from '../settings/sidebar-policy.ts';
import type { TeamFile } from '../file/types.ts';

/** What the step builder reads from outside, so tests stand in for all of it. */
export type SidebarStepInput = {
  home: string;
  root: string;
  /** The session this run is about to start or reuse: it reads the config when it starts, so it
   *  is never reloaded — a reload would reach a server that is about to be replaced anyway. */
  session: string;
  team: TeamFile | null;
  now: Date;
  /** The terminal host's sessions with their running state; null when the list cannot be read —
   *  then no session is reloaded, and the write still lands, so check names the difference. */
  hostSessions(): readonly { name: string; running: boolean }[] | null;
  /** The host config's text: '' for an absent file, null when it cannot be read (a config this
   *  run cannot read is not one it may claim is already equal). */
  configText(): string | null;
};

/** The sidebar step a launch performs. `skip` names why there is nothing to do; the sessions are
 *  the running ones the layout reloads into, each its own plan step. */
export type SidebarStep = {
  rows: readonly (readonly string[])[];
  indicators: SidebarIndicator;
  sessions: readonly string[];
  skip?: string;
};

/** The session names the entity's registered teams use: this team by its own root, and every
 *  team of the same entity — the entity shares one sidebar across its teams. A team with no
 *  entity declared shares nothing but itself. Null when the registry cannot be read: then no
 *  session is reloaded, and the write still lands. */
function entitySessions(home: string, root: string, entity: string | null): Set<string> | null {
  let teams: ReturnType<typeof readTeams>;
  try {
    teams = readTeams(home);
  } catch {
    return null;
  }
  const own = teamIdOf(root);
  const names = new Set<string>();
  for (const [id, record] of Object.entries(teams)) {
    if (id !== own && (entity === null || record.entity !== entity)) continue;
    names.add(record.session);
    for (const lobby of Object.keys(record.lobbies ?? {})) names.add(lobby);
  }
  return names;
}

/** What the sidebar step is, or null when `workspace.sidebar.manage` resolves off and the launch
 *  never touches the host's config. Reads only: the policy chain, the registry, the record
 *  store, the host's session list and its config text. */
export function sidebarStepOf(input: SidebarStepInput): SidebarStep | null {
  const policy = sidebarPolicy({ home: input.home, root: input.root, team: input.team, now: input.now });
  if (!policy.manage) return null;

  const registered = entitySessions(input.home, input.root, input.team?.entity ?? null);
  const running = input.hostSessions();
  const sessions = registered === null || running === null
    ? []
    : [...new Set(running.filter((one) => one.running && one.name !== input.session && registered.has(one.name)))]
        .map((one) => one.name)
        .sort();

  // Already in force: the config reads equal on both keys, and every session this step would
  // reload holds a record at exactly this pair. An unreadable record file reads as no records —
  // never as proof — so its sessions reload again, which the host answers idempotently.
  const word = sidebarRowsWord(policy.rows);
  const text = input.configText();
  let skip: string | undefined;
  if (text !== null && running !== null && registered !== null) {
    const spliced = spliceSidebarRows(text, policy.rows, policy.indicators);
    let records: Record<string, SidebarReloadRecord> = {};
    try {
      records = readSidebarReloads(input.home);
    } catch {
      records = {};
    }
    const current = (session: string): boolean => {
      const record = records[session];
      return record !== undefined && record.rows === word && record.indicators === policy.indicators;
    };
    if (spliced.ok && !spliced.changed && sessions.every(current)) {
      skip = `the terminal host's sidebar already reads this layout and every running session of this entity's teams holds a record at it; nothing to do`;
    }
  }

  return {
    rows: policy.rows,
    indicators: policy.indicators,
    sessions,
    ...(skip === undefined ? {} : { skip }),
  };
}

/** The host config's text for the step builder: '' for an absent file, null for any other read
 *  failure. Exported so `up` and any later caller share one reading of an unreadable config. */
export function sidebarConfigText(home: string): string | null {
  try {
    return readFileSync(hostConfigPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return null;
  }
}
