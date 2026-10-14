import { dirname } from 'node:path';
import { approvedFingerprints, notInForce } from './approve/approval.ts';
import { compare, describe, fingerprints } from './approve/fingerprint.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, noPaneRefusal, standingOf } from './caller.ts';
import { ORDINARY_SECTIONS } from './delegate.ts';
import { loadTeamFile } from './file/load.ts';
import type { GrantScope, LoadResult, TeamFile } from './file/types.ts';
import { validateTeamFile } from './file/validate.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { approvalStanding, approvedCopy, type Standing } from './store/store.ts';

/**
 * What `up`, `down` and `approve` ask the grant, decided and not yet done. `passed` is the grant the
 * approval in force names. `refused` is the sentence, with no newline; `id` is the exit id
 * a command records when it refuses on this verdict.
 */
export type GrantVerdict =
  | { kind: 'passed'; grant: { session: string; seat: string; scope: GrantScope[] } }
  | { kind: 'refused'; id: string; text: string };

/**
 * The reads a test replaces. Each one left out is the real read: the default team file of
 * `io.cwd` (no `--file`), the approval standing and its stored copy. Placement is `io`,
 * asked about the grant's session, and the pane is the one the state records now.
 */
export type GrantSources = {
  load?: (cwd: string) => LoadResult;
  standing?: (root: string) => Standing;
  /** Null when the approved copy cannot be read. */
  approvedCopy?: (root: string) => string | null;
};

/**
 * The audit line of a granted run, in the same shape as a delegated run's line. `up` and
 * `down` call it when the gate has passed and the run is about to have effects, and not
 * before: a dry run and a refusal write nothing. `approve` calls it in the same function as
 * the store write, after that write, and `detail` is the differences that approval sealed.
 */
export function logGranted(dir: string, seat: string, act: GrantScope, now?: Date, detail?: string): void {
  logLine(dir, 'grant', 'grant', `${seat} ${act}${detail ? `: ${detail}` : ''}`, now);
}

/**
 * Whether this caller may perform `act` under the grant the approval in force names.
 * `up`, `down` and `approve` call this. It reads the live default file and the approval again on this
 * call: no remembered copy, no `--file`, and no walk of other sessions the state holds.
 * It decides and stops. It does not print, write, or launch.
 *
 * The grant it trusts is the approved copy's. A live edit that has not been signed is a
 * difference: every act but `approve` refuses the whole difference, and `approve` refuses
 * every owner section outside `ORDINARY_SECTIONS`, `grant` included.
 */
export function grantGate(input: {
  act: GrantScope;
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'>;
  /** Approval store home. Absent: the owner's home, the same default the store uses. */
  home?: string;
  sources?: GrantSources;
}): GrantVerdict {
  const { act, io, home } = input;
  const sources = input.sources ?? {};
  const refuse = (id: string, text: string): GrantVerdict => ({ kind: 'refused', id: `grant.${id}`, text });

  const loaded = sources.load ? sources.load(io.cwd) : loadTeamFile(io.cwd, { home });
  if (!loaded.ok) {
    return refuse('file', loaded.errors[0]?.message ?? 'the team file can\'t be read');
  }

  const standing = sources.standing ? sources.standing(loaded.root) : approvalStanding(loaded.root, home);
  if (standing.kind !== 'verified') {
    return refuse('approval', `a grant needs a verified approval: ${notInForce(standing)}`);
  }

  const copy = sources.approvedCopy ? sources.approvedCopy(loaded.root) : approvedCopy(loaded.root, home);
  const approved = copy === null ? null : validated(copy);
  if (approved === null) {
    return refuse('approved-copy', 'a grant needs a readable approved copy: run `team approve`');
  }

  // The difference step. `approve` admits an ordinary difference — the roster and `rules` —
  // and refuses every other owner section, `grant` included, because `grant` is not in
  // `ORDINARY_SECTIONS`. Every other act needs the live file to be the approved one, so a
  // grant edited in the live file and not yet signed authorises nothing.
  const differences = compare(approvedFingerprints(standing.record), fingerprints(loaded.team));
  if (act === 'approve') {
    const kept = differences.filter((difference) => difference.kind === 'section' && !ORDINARY_SECTIONS.includes(difference.name));
    if (kept.length > 0) {
      return refuse('not-ordinary', `this change needs the owner: ${kept.map(describe).join('; ')}`);
    }
  } else if (differences.length > 0) {
    return refuse(
      'drift',
      `a grant needs the approved file: the file is not the approved one (${differences.map(describe).join('; ')}): run \`team approve\``,
    );
  }

  const grant = approved.grant;
  if (grant === null) return refuse('omitted', 'the approved file grants nothing');

  // The placement `add` and `remove` use for a named seat: this session, this name, the pane
  // the state records for it now. The session is the grant's, not a session the caller picks
  // and not one `judgeCallerIn` would walk to.
  const caller = callerOf(io, grant.session);
  const verdict = callerVerdict(caller, grant.seat, standingOf(dirname(loaded.path), grant.session, caller));
  if (verdict.kind === 'no-pane') return refuse('no-pane', noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse('another-pane', anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse('caller', `only the seat the grant names runs this: this call is ${describeCaller(caller)}`);
  }
  if (!grant.scope.includes(act)) return refuse('scope', `the grant does not list \`${act}\``);
  return { kind: 'passed', grant };
}

function validated(text: string): TeamFile | null {
  try {
    const result = validateTeamFile(text);
    return result.ok ? result.team : null;
  } catch {
    return null;
  }
}
