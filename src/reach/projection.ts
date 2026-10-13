// The reach projection: the machine-readable form of the team file's per-seat `reach` grants
// (the seat auto-discovery seam; docs/projects/teamcli/mcp/seat-auto-discovery.md in the docs
// tree, briefs/autodiscovery-flo821-seam.md in teamcli). `up`, `add` and `remove` regenerate it
// at `<lobby>/reach-roster.json` after their own file write; the bridge and the seat-shuttle
// daemon read it, and both refuse anything malformed and keep the last good file. So this writer
// must never emit a document a reader would refuse: every default is validated here, before the
// write, and a document with one bad seat is not written at all.
//
// The projection is one file per lobby, and the lobby is one per machine — so it describes the
// grant of the team whose `up` (or `add`/`remove`) ran last, not a union over teams. A second
// team that grants reach on the same machine's lobby takes the projection over when it next
// runs; a machine with one reach-serving team (the live setup) is the setup this serves.
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { lobbyDir } from '../lobby/gate.ts';
import type { TeamFile } from '../file/types.ts';
import { FRONTS, REACH_ALIAS, REACH_MAX_SEATS, REACH_ROSTER_FILE, REACH_ROSTER_TEMP, REACH_ROUTE } from './rules.ts';

export type ProjectionSeat = { alias: string; route: string; key_id: string; guard_dir: string; reach: string[] };
export type Projection = { version: 1; seats: ProjectionSeat[] };
export type ProjectionReport = { written: boolean; reason: string | null; path: string; seats: number };

/**
 * The projection of one validated team file. The invariant, pinned by test/seat-reach.test.ts:
 * **a seat is projected only when its `reach.to` includes a front the tool knows** — absent
 * `reach`, or a grant whose fronts are all unknown, projects nothing: no roster entry, no front
 * entry, no shuttle lane. The parse refuses a `reach.to` outside FRONTS, so inside the tool this
 * holds by construction; the check stays here so a future parser change cannot start emitting
 * front-less seats, which a reader would refuse and every lane would be kept for nobody.
 */
export function projectionOf(team: TeamFile, home: string): Projection {
  const seats: ProjectionSeat[] = [];
  for (const seat of team.seats) {
    const reach = seat.reach;
    if (!reach || !reach.to.some((front) => (FRONTS as readonly string[]).includes(front))) continue;
    const alias = (reach.alias ?? seat.name).toLowerCase();
    const route = reach.route ?? alias;
    const keyId = reach.keyId ?? `seat-${alias}-1`;
    const guardDir = reach.guardDir ?? join(lobbyDir(home), `guard-floor-${alias}`);
    const bad: string[] = [];
    if (!REACH_ALIAS.test(alias)) bad.push(`alias "${alias}"`);
    if (!REACH_ROUTE.test(route)) bad.push(`route "${route}"`);
    if (!REACH_ROUTE.test(keyId)) bad.push(`key_id "${keyId}"`);
    if (!isAbsolute(guardDir)) bad.push(`guard_dir "${guardDir}"`);
    if (bad.length) throw new Error(`invalid reach seat "${seat.name}": ${bad.join(', ')}`);
    if (seats.length === REACH_MAX_SEATS) throw new Error(`reach: the projection holds at most ${REACH_MAX_SEATS} seats`);
    seats.push({ alias, route, key_id: keyId, guard_dir: guardDir, reach: [...reach.to] });
  }
  return { version: 1, seats };
}

/**
 * Regenerate `<lobby>/reach-roster.json` from a validated team file, atomically through the
 * declared temporary. Never throws and never creates the lobby — a missing or non-`0700` lobby
 * is a skip with a reason (an `up` has already succeeded when this runs; a projection problem
 * must not turn it into a refusal). Unchanged content is a skip with no reason: the file
 * matters, not the write. An empty `seats` list is a real projection — it revokes every seat.
 */
export function writeReachProjection(team: TeamFile, home: string): ProjectionReport {
  const lobby = lobbyDir(home);
  const path = join(lobby, REACH_ROSTER_FILE);
  let stat;
  try {
    stat = lstatSync(lobby);
  } catch {
    return { written: false, reason: `no lobby at ${lobby}`, path, seats: 0 };
  }
  if (!stat.isDirectory()) {
    return { written: false, reason: `the lobby ${lobby} is not a folder`, path, seats: 0 };
  }
  const mode = stat.mode & 0o7777;
  if (mode !== 0o700) {
    return { written: false, reason: `the lobby ${lobby} has mode 0${mode.toString(8)}, not 0700`, path, seats: 0 };
  }
  let projection: Projection;
  try {
    projection = projectionOf(team, home);
  } catch (err) {
    return { written: false, reason: (err as Error).message, path, seats: 0 };
  }
  const text = `${JSON.stringify(projection, null, 2)}\n`;
  try {
    if (readFileSync(path, 'utf8') === text) return { written: false, reason: null, path, seats: projection.seats.length };
  } catch {
    // No file yet, or one this user cannot read — the write below replaces it either way.
  }
  const temp = join(lobby, REACH_ROSTER_TEMP);
  try {
    // Cleared first so the fresh file gets mode 0600 whatever a crashed write left behind; a
    // symlink is removed as the link it is, and the rename below replaces one at `path` too.
    rmSync(temp, { force: true });
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    return { written: false, reason: `the projection was not written: ${(err as Error).message}`, path, seats: projection.seats.length };
  }
  return { written: true, reason: null, path, seats: projection.seats.length };
}

/** The one line `up`, `add` and `remove` log for a report — `null` when there is nothing to
 *  say (the projection was already current). */
export function reachProjectionNote(report: ProjectionReport): string | null {
  if (report.written) return `reach projection: ${report.seats} seat${report.seats === 1 ? '' : 's'}`;
  if (report.reason === null) return null;
  return `reach projection not written: ${report.reason}`;
}
