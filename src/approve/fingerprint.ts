import { createHash } from 'node:crypto';
import { SECTIONS } from '../file/sections/index.ts';

/**
 * The sections only the owner changes. An edit to any of them needs a new
 * approval before the file runs. Generated from the section modules, in their
 * list's order — the order feeds the approval digest, so the list keeps it:
 * `watch` last with `watch.checks`, the line inside it, after it.
 */
export const OWNER_SECTIONS: readonly string[] = SECTIONS.filter((section) => section.owner).map((section) => section.name);

/** One owner section, read from the file; the two watch sections sit inside `watch`, not at the top. */
function sectionOf(team: Approvable, name: string): unknown {
  if (name === 'watch.checks') return (team.watch as { checks?: unknown } | undefined)?.checks ?? [];
  if (name === 'watch') {
    const watch = team.watch as Record<string, unknown> | null | undefined;
    if (watch === null || watch === undefined) return undefined;
    const rest = { ...watch };
    delete rest.checks;
    return rest;
  }
  return team[name];
}

/**
 * Seat fields that change without a new approval: where the seat sits in the
 * file, how its entry is written (`count: 3` becoming `count: 2`, or
 * explicit seats, when one is taken out), and `labelWritten`, which only records
 * that the file wrote `label:`. `parked` and `stopped` stay in the
 * digest: a seat that can edit the file must not silence itself. `remove --keep`
 * and `add` record the new digest with the edit.
 */
const SEAT_FREE_FIELDS = new Set(['line', 'declared', 'count', 'instance', 'labelWritten']);

/** The free set from before `parked` and `stopped` joined the digest. */
const LEGACY_SEAT_FREE_FIELDS = new Set(['parked', 'stopped', 'line', 'declared', 'count', 'instance', 'labelWritten']);

/** A validated team file, as far as an approval reads it. */
export type Approvable = Record<string, unknown> & {
  seats: readonly (Record<string, unknown> & { name: string })[];
};

export interface Fingerprints {
  sections: Record<string, string>;
  /** By seat name, after `count` is expanded. */
  seats: Record<string, string>;
}

/** JSON with every object's keys in order, so equal values give equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** A fingerprint of each owner-only section and of each seat. */
export function fingerprints(team: Approvable): Fingerprints {
  const sections: Record<string, string> = {};
  for (const section of OWNER_SECTIONS) sections[section] = digest(sectionOf(team, section));

  const seats: Record<string, string> = {};
  for (const seat of team.seats) seats[seat.name] = seatDigest(seat, SEAT_FREE_FIELDS);
  return { sections, seats };
}

/**
 * Seat digests as a record written before `parked` and `stopped` were part of
 * them. An approval from then still matches a file that has not changed.
 */
export function legacySeatDigests(team: Approvable): Record<string, string> {
  const seats: Record<string, string> = {};
  for (const seat of team.seats) seats[seat.name] = seatDigest(seat, LEGACY_SEAT_FREE_FIELDS);
  return seats;
}

/**
 * Seat digests as a record written when an omitted label was the seat's name.
 * `v0.1.2` hashed `parked` and `stopped`; `v0.1.1` left them out. A written
 * label hashes the same title in every shape, so these equal a stored digest
 * only where the title was the name.
 */
export function legacyLabelDigests(team: Approvable): { named: Record<string, string>; namedWithoutFlags: Record<string, string> } {
  const named: Record<string, string> = {};
  const namedWithoutFlags: Record<string, string> = {};
  for (const seat of team.seats) {
    const titled = { ...seat, label: seat.name };
    named[seat.name] = seatDigest(titled, SEAT_FREE_FIELDS);
    namedWithoutFlags[seat.name] = seatDigest(titled, LEGACY_SEAT_FREE_FIELDS);
  }
  return { named, namedWithoutFlags };
}

/**
 * A watch section digest as computed before `idle_repeat` defaulted to off — when the key was
 * not set in the file, its value was filled in as 1200 seconds — and before `idle_owner`,
 * `blind_after` and `unread_after` joined the section. `omittedIdleFirst` says the approved text
 * wrote no `idle_first`, so the reader then took the ten minutes the section shipped.
 */
export function legacyWatchDigest(team: Approvable, omittedIdleFirst = false): string | null {
  const watch = team.watch as Record<string, unknown> | null | undefined;
  if (!watch || watch.idleRepeat !== undefined) return null;
  const rest: Record<string, unknown> = { ...watch, idleRepeat: 1200 };
  delete rest.checks;
  delete rest.idleOwner;
  delete rest.blindAfter;
  delete rest.unreadAfter;
  if (omittedIdleFirst && rest.idleFirst === 300) rest.idleFirst = 600;
  return digest(rest);
}

/**
 * Every earlier spelling of the `watch` digest a record may carry: the shape without
 * `idle_owner`, `blind_after` and `unread_after`; the 0.5.0–0.5.2 shape, which kept
 * `idle_owner` and `blind_after` and omitted only `unread_after`; each with or without the
 * `idle_repeat` fill-in, and, when the file wrote no `idle_first`, with the ten-minute default
 * it shipped then. A stored digest equal to one of these was not edited by the arrival — it is
 * adopted as the current one.
 */
export function legacyWatchDigests(team: Approvable, omittedIdleFirst: boolean): string[] {
  const watch = team.watch as Record<string, unknown> | null | undefined;
  if (!watch) return [];
  const without = (...keys: string[]): Record<string, unknown> => {
    const rest = { ...watch };
    for (const key of keys) delete rest[key];
    return rest;
  };
  const shapes = [
    without('checks', 'idleOwner', 'blindAfter', 'unreadAfter'),
    without('checks', 'unreadAfter'),
  ];
  const out = new Set<string>();
  for (const rest of shapes) {
    // A file that wrote no `idle_first` may predate the 300-second default or come from the
    // 0.5.0-0.5.2 line that already shipped it: the stored digest names the default of its
    // own era, so both readings are earlier spellings of the same section.
    const variants = [rest];
    if (omittedIdleFirst && rest.idleFirst === 300) variants.push({ ...rest, idleFirst: 600 });
    for (const shape of variants) {
      out.add(digest(shape));
      if (shape.idleRepeat === undefined) out.add(digest({ ...shape, idleRepeat: 1200 }));
    }
  }
  return [...out];
}

function seatDigest(seat: Record<string, unknown>, free: Set<string>): string {
  const fields = Object.fromEntries(Object.entries(seat).filter(([key]) => !free.has(key)));
  return digest(fields);
}

/**
 * The session a team was approved under, when the only reason it moved is the default: the file
 * names an entity, its session resolves to `<entity>-<project>`, and the approval recorded the
 * old default, the project name alone. Null otherwise.
 */
export function sessionDefaultMove(approvedDigest: string | undefined, team: Approvable): { from: string; to: string } | null {
  const { project, entity, session } = team as { project?: unknown; entity?: unknown; session?: unknown };
  if (typeof project !== 'string' || typeof entity !== 'string' || !entity) return null;
  if (session !== `${entity}-${project}`) return null;
  if (approvedDigest !== digest(sectionOf(team, 'session')) && approvedDigest === digest(project)) return { from: project, to: session };
  return null;
}

export type Difference =
  { kind: 'section'; name: string; moved?: { from: string; to: string } } | { kind: 'seat-changed'; name: string } | { kind: 'seat-new'; name: string };

/**
 * What in the file the owner has not approved. The file passes when every
 * section matches and every seat in it matches an approved seat: a seat taken
 * out needs no new approval. Parking or stopping one does.
 */
export function compare(approved: Fingerprints, current: Fingerprints, team?: Approvable): Difference[] {
  const differences: Difference[] = [];
  for (const name of OWNER_SECTIONS) {
    // A record with no fingerprint for a section is read by `approvedFingerprints`, from the copy
    // it stored. What reaches here without one is a record whose copy is gone: it turned nothing
    // off, so `watch.checks` reads as the empty list, and a missing `watch` is a difference.
    const before = approved.sections[name] ?? (name === 'watch.checks' ? digest([]) : undefined);
    if (before !== current.sections[name]) {
      const moved = name === 'session' && team ? sessionDefaultMove(before, team) : null;
      differences.push(moved ? { kind: 'section', name, moved } : { kind: 'section', name });
    }
  }
  for (const [name, fingerprint] of Object.entries(current.seats)) {
    if (!Object.hasOwn(approved.seats, name)) differences.push({ kind: 'seat-new', name });
    else if (approved.seats[name] !== fingerprint) differences.push({ kind: 'seat-changed', name });
  }
  return differences;
}

/**
 * The line `describe` prints when `watch.checks` itself is the difference. `pass` does not read
 * it. The list in force is what turns checks off: while the edit is unapproved, the approved
 * list stays in force, so nothing new is turned off and an approved-off check stays off.
 */
export const WATCH_CHECKS_CHANGED = '`watch.checks` changed';

/** One line per difference, as `status`, `doctor` and the refusals print it. */
export function describe(difference: Difference): string {
  if (difference.kind === 'section' && difference.moved) {
    const { from, to } = difference.moved;
    return `\`session\` changed: "${from}" -> "${to}", the new default session (<entity>-<project>); approve the file again, or set \`session: ${from}\` to keep the old one`;
  }
  if (difference.kind === 'section') return `\`${difference.name}\` changed`;
  if (difference.kind === 'seat-new') return `seat ${difference.name} is not in the last approval`;
  return `seat ${difference.name} changed`;
}

/**
 * The seat a difference line names, when it names one — the inverse of `describe`, kept beside it
 * so the two can't drift. `pass` reads it to keep a seat the owner has not approved out of the
 * readings fold; `null` for a section difference.
 */
export function seatNamed(line: string): string | null {
  const match = /^seat (.+) (?:changed|is not in the last approval)$/.exec(line);
  return match?.[1] ?? null;
}
