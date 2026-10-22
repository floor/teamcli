import { homedir } from 'node:os';
import type { ApprovedCheck } from '../budgets/checks.ts';
import { renameSeat } from '../file/lines.ts';
import type { TeamFile } from '../file/types.ts';
import { defaultBudgets, defaultWatch, validateTeamFile } from '../file/validate.ts';
import {
  approvalStanding,
  LEGACY_LINE,
  storePath,
  writeApproval,
  type Approval,
  type ApprovalRecord,
  type Ceilings,
  type Standing,
} from '../store/store.ts';
import { applyTempo, type Tempo } from '../file/sections/tempo.ts';
import { parseYaml } from '../yaml.ts';
import { compare, describe, fingerprints, legacyLabelDigests, legacySeatDigests, legacyWatchDigests, OWNER_SECTIONS, type Fingerprints } from './fingerprint.ts';

/** The launch ceilings declared in the file. An approval also stores a snapshot of them. */
export function ceilingsOf(team: TeamFile): Ceilings {
  return { seats: team.limits.seats, temporary: team.limits.temporary, vendors: { ...team.limits.vendors } };
}

/** The record an approval of this file writes. `actor` is the approved delegate pane that
 *  submitted it, on a delegated approval: the approving word stays the owner's, and the
 *  submission is written beside the signature so the record names who ran it. */
export function approvalOf(
  team: TeamFile,
  root: string,
  now: Date = new Date(),
  checks: Record<string, ApprovedCheck> = {},
  actor?: string,
): Approval {
  return {
    format: 2,
    approvedAt: now.toISOString(),
    root,
    fingerprints: fingerprints(team),
    ceilings: ceilingsOf(team),
    checks,
    ...(actor !== undefined ? { actor } : {}),
  };
}

/** A standing that is not `verified`: no record, a legacy one, or one the verification refused. */
export type NotVerified = Exclude<Standing, { kind: 'verified' }>;

/**
 * The one line a command that needs an approval in force refuses on: never
 * approved, the legacy record's line, or the case the verification refused.
 */
export function notInForce(standing: NotVerified): string {
  if (standing.kind === 'none') return 'the file was never approved on this machine';
  if (standing.kind === 'legacy') return LEGACY_LINE;
  return standing.why;
}

/**
 * An approval's fingerprints, with the sections a record written before them has none for read
 * from the copy it stored: `watch` and `watch.checks` arrived after records did, and the section's
 * arrival alone is not a difference — an approval recorded before it stays valid while the section
 * is unchanged (as `watch.checks` has since #48). A copy that can't be read leaves the record as
 * it is, and the section reads as a difference.
 */
export function approvedFingerprints(record: ApprovalRecord): Fingerprints {
  const stored = record.approval.fingerprints;
  const checked = validateTeamFile(record.file);
  let sections = stored.sections;
  if (!OWNER_SECTIONS.every((name) => stored.sections[name] !== undefined) && checked.ok) {
    sections = { ...fingerprints(checked.team).sections, ...stored.sections };
  }
  // A record written before `tasks` has no fingerprint for it. The omitted section is null, so
  // the arrival baseline is that null: a file that still omits `tasks` matches, and a file that
  // adds the section differs. Filling from the current file would hide the add.
  if (checked.ok && stored.sections.tasks === undefined) {
    const omitted = fingerprints({ ...checked.team, tasks: null }).sections.tasks;
    if (omitted !== undefined) sections = { ...sections, tasks: omitted };
  }
  // A record written before `grant` has no fingerprint for it. The omitted section is null, so
  // the arrival baseline is that null: a file that still omits `grant` matches, and a file that
  // adds the section differs. Filling from the live file would hide the add.
  if (checked.ok && stored.sections.grant === undefined) {
    const omitted = fingerprints({ ...checked.team, grant: null }).sections.grant;
    if (omitted !== undefined) sections = { ...sections, grant: omitted };
  }
  // A record written before `clients` has no fingerprint for it. The omitted section is null, so
  // the arrival baseline is that null: a file that still omits `clients` matches, and a file that
  // adds the section differs.
  if (checked.ok && stored.sections.clients === undefined) {
    const omitted = fingerprints({ ...checked.team, clients: null }).sections.clients;
    if (omitted !== undefined) sections = { ...sections, clients: omitted };
  }
  // A record written before `tempo` has no fingerprint for it. The omitted section is `normal`,
  // so the arrival baseline is that word: a file that still omits it, or sets `normal`, matches,
  // and `relaxed` or `urgent` differs. Filling from the live file would hide the change.
  if (checked.ok && stored.sections.tempo === undefined) {
    const omitted = fingerprints({ ...checked.team, tempo: 'normal' }).sections.tempo;
    if (omitted !== undefined) sections = { ...sections, tempo: omitted };
  }
  // A record written before `idle_owner`, `blind_after` and `unread_after` joined `watch` — or
  // before `idle_repeat` defaulted to off — carries a digest of the section as it read then. The
  // arrival alone is not an edit: a stored digest in one of the earlier shapes is adopted as the
  // current one, so a later edit is judged against the section as it reads now.
  if (checked.ok) {
    const legacy = legacyWatchDigests(checked.team, !wroteKey(record.file, 'watch', 'idle_first'));
    if (stored.sections['watch'] !== undefined && legacy.includes(stored.sections['watch'])) {
      const currentWatch = fingerprints(checked.team).sections['watch'];
      if (currentWatch && sections['watch'] !== currentWatch) {
        sections = { ...sections, watch: currentWatch };
      }
    }
  }
  const seats = checked.ok ? adoptLegacyDigests(stored.seats, checked.team) : stored.seats;
  if (sections === stored.sections && seats === stored.seats) return stored;
  return { sections, seats };
}

/**
 * Whether the approved copy writes `section.key` at the top level. The parsed team cannot tell a
 * default from a written value; the record's copy of the text can, and the digest a record
 * stored was computed from that text.
 */
function wroteKey(text: string, section: string, key: string): boolean {
  try {
    const root = parseYaml(text);
    if (root.kind !== 'map') return false;
    const entry = root.entries.find((one) => one.key === section);
    if (entry === undefined || entry.value.kind !== 'map') return false;
    return entry.value.entries.some((one) => one.key === key);
  } catch {
    return false;
  }
}

/**
 * A record from before `parked` and `stopped` were in the digest, or from when
 * an omitted label was the seat's name, still names the seat as it was
 * approved, read from the stored copy. A digest already in the new shape is
 * left alone, so a later edit of the file is not adopted from a stale copy.
 * A copy that can't be read is left alone.
 */function adoptLegacyDigests(stored: Record<string, string>, team: TeamFile): Record<string, string> {
  const current = fingerprints(team).seats;
  const legacyFlags = legacySeatDigests(team);
  const legacyLabels = legacyLabelDigests(team);
  let changed = false;
  const next = { ...stored };
  for (const [name, previous] of Object.entries(stored)) {
    const adopted = current[name];
    const old =
      previous === legacyFlags[name] ||
      previous === legacyLabels.named[name] ||
      previous === legacyLabels.namedWithoutFlags[name];
    if (adopted !== undefined && old && previous !== adopted) {
      next[name] = adopted;
      changed = true;
    }
  }
  return changed ? next : stored;
}

/**
 * `remove --keep` and `add` write `stopped` and nothing else. The new digest is
 * recorded only when putting `stopped` back to its approved value makes the
 * seat match the approval. A launch line or a `parked` flag edited beside the
 * mark stays drift. A stored copy that can't be read records nothing. The
 * amendment re-signs the whole record, so it moves the generation — every
 * signing `team` performs does; a process holding the key could re-sign at the
 * same number instead, which nothing `team` shows would differ from.
 */
export function recordSeatDigestOf(standing: Standing, team: TeamFile, root: string, name: string, home: string = homedir()): void {
  if (standing.kind !== 'verified') return;
  const store = storePath(team.project, root, home);
  const record = standing.record;
  if (!validateTeamFile(record.file).ok) return;
  const approved = approvedFingerprints(record).seats[name];
  const digest = fingerprints(team).seats[name];
  if (approved === undefined || digest === undefined || record.approval.fingerprints.seats[name] === digest) return;
  const withStopped = (stopped: boolean) => fingerprints({
    ...team,
    seats: team.seats.map((seat) => (seat.name === name ? { ...seat, stopped } : seat)),
  }).seats[name];
  if (withStopped(true) !== approved && withStopped(false) !== approved) return;
  writeApproval(store, {
    approval: {
      ...record.approval,
      fingerprints: {
        ...record.approval.fingerprints,
        seats: { ...record.approval.fingerprints.seats, [name]: digest },
      },
    },
    file: record.file,
  }, [], home);
}

/** `recordSeatDigest` as a command uses it: the caller's own standing, read once. */
export function recordSeatDigest(team: TeamFile, root: string, name: string, home: string = homedir()): void {
  recordSeatDigestOf(approvalStanding(root, home), team, root, name, home);
}

/**
 * Carries the approved record across `team rename` by applying the rename to `record.file`
 * and moving a seat or lead section digest only when the live file matches the renamed record.
 */
export function recordSeatRenameOf(
  standing: Standing,
  team: TeamFile,
  root: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
  home: string = homedir(),
): void {
  if (standing.kind !== 'verified' || renames.length === 0) return;
  const store = storePath(team.project, root, home);
  const record = standing.record;
  if (!validateTeamFile(record.file).ok) return;
  let renamedRecordFile = record.file;
  for (const { from, to } of renames) {
    renamedRecordFile = renameSeat(renamedRecordFile, from, to);
  }
  const renamedRecord = validateTeamFile(renamedRecordFile);
  if (!renamedRecord.ok) return;
  const approved = approvedFingerprints(record);
  const expectedAfter = fingerprints(renamedRecord.team);
  const live = fingerprints(team);

  const nextSeats = { ...record.approval.fingerprints.seats };
  for (const { from, to } of renames) {
    const after = expectedAfter.seats[to];
    if (approved.seats[from] !== undefined && after !== undefined && live.seats[to] === after) {
      delete nextSeats[from];
      nextSeats[to] = after;
    }
  }

  const nextSections = { ...record.approval.fingerprints.sections };
  for (const section of ['orchestrator', 'operator', 'grant'] as const) {
    const after = expectedAfter.sections[section];
    if (
      record.approval.fingerprints.sections[section] !== undefined &&
      after !== undefined &&
      live.sections[section] === after
    ) {
      nextSections[section] = after;
    }
  }

  writeApproval(
    store,
    {
      approval: {
        ...record.approval,
        fingerprints: {
          sections: nextSections,
          seats: nextSeats,
        },
      },
      file: renamedRecordFile,
    },
    [],
    home,
  );
}

/** The differences of a file against one verified snapshot: the caller's own standing, read once. */
export function approvalDifferencesOf(
  standing: Extract<Standing, { kind: 'verified' }>,
  team: TeamFile,
): string[] {
  return compare(approvedFingerprints(standing.record), fingerprints(team)).map(describe);
}

/**
 * What in the file the owner has not approved on this machine, one line per
 * difference. Empty when the file matches the last approval; null when no verified
 * approval is in force for this root — never approved, or a record that does
 * not verify. A file runs only when this is empty.
 */
export function approvalDifferences(team: TeamFile, root: string, home: string = homedir()): string[] | null {
  const standing = approvalStanding(root, home);
  return standing.kind === 'verified' ? approvalDifferencesOf(standing, team) : null;
}

/**
 * The watch values in force. The live file is the record: a verified standing runs the watch
 * section as the file writes it, tempo included, and a file that changed since the last
 * approval is not held back. A standing that is not verified — never approved, legacy, or a
 * record the verification refused — runs the defaults.
 */
export function watchInForceOf(standing: Standing, team: TeamFile): TeamFile['watch'] {
  if (standing.kind !== 'verified') return defaultWatch();
  return applyTempo(team.watch, team.tempo);
}

/**
 * The budget values in force. The live file is the record: a verified standing runs the
 * `budgets` section as the file writes it. A standing that is not verified runs the defaults —
 * no accounts — so nothing counts before the first approval, exactly as before.
 */
export function budgetsInForceOf(standing: Standing, team: TeamFile): TeamFile['budgets'] {
  if (standing.kind !== 'verified') return defaultBudgets();
  return team.budgets;
}

/** The wrappers a standalone caller uses: each does its own one read, then derives. */
export function watchInForce(team: TeamFile, root: string, home: string = homedir()): TeamFile['watch'] {
  return watchInForceOf(approvalStanding(root, home), team);
}

export function budgetsInForce(team: TeamFile, root: string, home: string = homedir()): TeamFile['budgets'] {
  return budgetsInForceOf(approvalStanding(root, home), team);
}

/**
 * What a command needs to know about the approval in one answer: the
 * differences when a verified record is in force, or the reason there are
 * none. `none` is not a reason — nothing was ever approved, and the caller
 * says so in its own words.
 */
export function approvalCase(standing: Standing, team: TeamFile): { differences: string[] | null; reason: string | null } {
  if (standing.kind === 'verified') return { differences: approvalDifferencesOf(standing, team), reason: null };
  if (standing.kind === 'none') return { differences: null, reason: null };
  if (standing.kind === 'legacy') return { differences: null, reason: LEGACY_LINE };
  return { differences: null, reason: standing.why };
}

/**
 * A verified standing for a file, without touching any store: the record an
 * approval of it would leave. For tests and scratch homes, where writing a
 * real signed record would be ceremony; nothing verifies it afterwards, so it
 * must never leave a test.
 */
export function verifiedOf(
  team: TeamFile,
  file: string,
  root: string,
  now: Date = new Date(),
): Extract<Standing, { kind: 'verified' }> {
  return { kind: 'verified', record: { approval: approvalOf(team, root, now), file }, generation: 1, signedAt: now.toISOString() };
}
