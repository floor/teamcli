import { homedir } from 'node:os';
import type { ApprovedCheck } from '../budgets/checks.ts';
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
import { compare, describe, fingerprints, legacyLabelDigests, legacySeatDigests, legacyWatchDigest, OWNER_SECTIONS, type Fingerprints } from './fingerprint.ts';

/** The ceilings an approval fixes: `up` and `add` read them from the record, never from the file. */
export function ceilingsOf(team: TeamFile): Ceilings {
  return { seats: team.limits.seats, temporary: team.limits.temporary, vendors: { ...team.limits.vendors } };
}

/** The record an approval of this file writes. */
export function approvalOf(
  team: TeamFile,
  root: string,
  now: Date = new Date(),
  checks: Record<string, ApprovedCheck> = {},
): Approval {
  return {
    format: 2,
    approvedAt: now.toISOString(),
    root,
    fingerprints: fingerprints(team),
    ceilings: ceilingsOf(team),
    checks,
  };
}

/** A standing that is not `verified`: no record, a legacy one, or one the verification refused. */
export type NotVerified = Exclude<Standing, { kind: 'verified' }>;

/**
 * The one line a command that needs an approval in force refuses on: never
 * approved, the legacy record's one-line repair, or the case the verification
 * refused. Each names the owner's single step.
 */
export function notInForce(standing: NotVerified): string {
  if (standing.kind === 'none') return 'the file was never approved on this machine: run `team approve`';
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
  if (checked.ok && checked.team.watch.idleRepeat === undefined) {
    const legacy = legacyWatchDigest(checked.team);
    if (legacy && stored.sections['watch'] === legacy) {
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
 * A record from before `parked` and `stopped` were in the digest, or from when
 * an omitted label was the seat's name, still names the seat as it was
 * approved, read from the stored copy. A digest already in the new shape is
 * left alone, so a later edit of the file is not adopted from a stale copy.
 * A copy that can't be read is left alone.
 */
function adoptLegacyDigests(stored: Record<string, string>, team: TeamFile): Record<string, string> {
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

/** The differences of a file against one verified snapshot: the caller's own standing, read once. */
export function approvalDifferencesOf(
  standing: Extract<Standing, { kind: 'verified' }>,
  team: TeamFile,
): string[] {
  return compare(approvedFingerprints(standing.record), fingerprints(team)).map(describe);
}

/**
 * What in the file the owner has not approved on this machine, one line per
 * difference. Empty when the file is the approved one; null when no verified
 * approval is in force for this root — never approved, or a record that does
 * not verify. A file runs only when this is empty.
 */
export function approvalDifferences(team: TeamFile, root: string, home: string = homedir()): string[] | null {
  const standing = approvalStanding(root, home);
  return standing.kind === 'verified' ? approvalDifferencesOf(standing, team) : null;
}

/**
 * The watch values in force. The watch section is the owner's, so what a file sets takes effect
 * only once the owner has approved it: a file never approved runs with the defaults, and a file
 * whose `watch` section differs from the approved one runs with the values of the approved copy.
 * An edit to a threshold changes nothing until `approve`.
 *
 * `watch.checks` is the finer line inside that section. Whenever its digest differs, the checks
 * in force are the approved copy's — or none, when that copy can't be read — even when the
 * timings themselves are unchanged and the rest of the section is the file's.
 */
export function watchInForceOf(standing: Standing, team: TeamFile): TeamFile['watch'] {
  if (standing.kind !== 'verified') return defaultWatch();
  const record = standing.record;
  const differences = compare(approvedFingerprints(record), fingerprints(team));
  const timingsDiffer = differences.some((difference) => difference.kind === 'section' && difference.name === 'watch');
  const checksDiffer = differences.some((difference) => difference.kind === 'section' && difference.name === 'watch.checks');
  if (!timingsDiffer && !checksDiffer) return team.watch;
  const copy = validateTeamFile(record.file);
  const approved = copy.ok ? copy.team.watch : defaultWatch();
  if (!timingsDiffer) return { ...team.watch, checks: approved.checks };
  return approved;
}

/**
 * The budget values in force. The `budgets` section is the owner's like the watch's, so what a
 * file sets takes effect only once the owner has approved it: a file never approved runs with the
 * defaults — no accounts — and a file whose `budgets` section differs from the approved one runs
 * with the values of the approved copy, accounts included. An unapproved edit — a reserve lowered,
 * a mark dropped, `check_every` stretched, an account taken out — silences nothing and unblocks
 * nothing until `approve`.
 */
export function budgetsInForceOf(standing: Standing, team: TeamFile): TeamFile['budgets'] {
  if (standing.kind !== 'verified') return defaultBudgets();
  const record = standing.record;
  if (approvedFingerprints(record).sections['budgets'] === fingerprints(team).sections['budgets']) return team.budgets;
  const copy = validateTeamFile(record.file);
  return copy.ok ? copy.team.budgets : defaultBudgets();
}

/**
 * The one team file in force: a verified standing's stored copy, validated, whole — never the
 * live file, and never a field of the live file merged in: a quiet fingerprint is not a reason to
 * skip that copy. Null when the stored copy can't be read, whatever the fingerprints say: there is
 * no value to work from. A standing that isn't verified hands the live file back: nothing is
 * approved, and the file's own names are the only ones there are. Every reader that shows a name
 * in force reads it from this object — `usage`'s binding of a stored reading and the project name
 * it prints — so a name only the live file writes is never taken for an approved one. `project`
 * is part of that rule: it is not an owner section, so a rename leaves the approval verified, and
 * a reader that shows the name the owner agreed to must take it from this object, never from the
 * live file (the second lab's route, closed in `projectUsage`). The worktree subcommands are
 * the one exception, and say so themselves (`worktreeTeamInForceOf` below).
 */
export function teamInForceOf(standing: Standing, team: TeamFile): TeamFile | null {
  if (standing.kind !== 'verified') return team;
  const copy = validateTeamFile(standing.record.file);
  return copy.ok ? copy.team : null;
}

/**
 * The team file the worktree subcommands read, and whether the live file has drifted from it.
 * Every owner section is the copy in force's; `project` is the live file's — that field is not an
 * owner section, so a rename is not drift, and `{repo}` stays the name the file has now (the merge
 * lives here, not in `teamInForceOf`: only these subcommands read a name the owner has not
 * approved, and their gate admits the owner, the orchestrator and the operator alone). `differs` is a
 * separate question: the live file compared with the approved copy in both directions, so a
 * section or a seat that was added, removed or changed prints the note. Null when the stored copy
 * can't be read — there is no value to work from, and the command refuses. A standing that isn't
 * verified hands the live file back with `differs: false` — the caller's gate refuses before it
 * reads any of it.
 */
export function worktreeTeamInForceOf(standing: Standing, team: TeamFile): { team: TeamFile; differs: boolean } | null {
  const inForce = teamInForceOf(standing, team);
  if (inForce === null) return null;
  const merged = standing.kind === 'verified' ? { ...inForce, project: team.project } : inForce;
  return { team: merged, differs: standing.kind === 'verified' && ownerDrift(inForce, team) };
}

/** An owner section or a seat added, removed or changed between the approved copy and the live file. */
function ownerDrift(approved: TeamFile, live: TeamFile): boolean {
  const approvedPrint = fingerprints(approved);
  const livePrint = fingerprints(live);
  // `compare` reports a seat added to its second file, not one taken out of it, so both orders.
  return compare(approvedPrint, livePrint).length > 0 || compare(livePrint, approvedPrint).length > 0;
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
