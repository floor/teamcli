// `team fallback`: the send fallback store's one housekeeping act. `prune` lists the store's
// finished episodes — a message delivered, a refusal published after every live route failed,
// and a walk still trying whose last fact is older than the receiver's signed
// `event-retention-days` — and, with `--apply`, retires them: the marker and its attempt ledger
// move to the store's archive, the publication ledger stays for replay dedup, the key-lock folder
// goes, and stale lock folders whose owner is gone are reclaimed. Nothing here invents a state:
// the classification is the marker's own, and the retention word is read from the receiver's
// signed chain, never a release default. A chain that cannot be read refuses the run instead of
// retiring on a guess, and a store with nothing finished exits 0 without writing.
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner, type Caller } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { hasJsonFlag, pluralCount, refuse, renderTable, ttyStyle, writeJson } from '../output/index.ts';
import { EVENT_THRESHOLD_POLICIES } from '../policy/events.ts';
import {
  planRetirement,
  reclaimFallbackLocks,
  retireFinished,
  type EscalationContext,
  type FallbackRetention,
  type FinishedKind,
  type RetirementCandidate,
  type RetirementReport,
} from '../send/fallback-events.ts';

export const USAGE = `Usage: team fallback prune [--apply] [--json]

Lists one line per finished fallback episode in this project's state store: the message, the seat
it was addressed to, how the episode ended (delivered, refused, expired), its age, and what
\`prune\` would do with it.

A delivered episode and a refused one — every live route failed and the escalation went out — are
retired as soon as a pass sees them. An expired episode, a walk still trying, is retired once its
last attempt is at least the receiver's signed \`event-retention-days\` old; inside that window it
is listed and left. Retiring moves the marker and its attempt ledger into the store's archive,
keeps the publication ledger beside the store (replay dedup outlives the episode), and removes the
episode's key-lock folder. Lock folders whose owner is gone are reclaimed in the same pass; a live
or young one is left.

\`--apply\` retires every listed episode it may retire; without it nothing is written. It is the
owner's, from a terminal rather than a seat's pane.

Exits 0 when the dry run finds nothing to retire or \`--apply\` retires every episode it listed, 1
when the dry run finds episodes to retire, \`--apply\` is aimed by a caller who is not the owner, the
retention word cannot be read, or an episode cannot be retired, 2 when the invocation or the team
configuration can't be read.
`;

export type FallbackSources = {
  home: string;
  now(): Date;
};

export const realFallbackSources: FallbackSources = { home: homedir(), now: () => new Date() };

export const fallback: Command = (argv, io) => runFallback(argv, io, realFallbackSources);
export default fallback;

/** One listed episode, as the plan read it. */
export type FallbackRow = RetirementCandidate;

export type FallbackJson = {
  format: 1;
  apply: boolean;
  project: string;
  root: string;
  episodes: {
    message_id: string;
    seat: string;
    team: string;
    state: FinishedKind;
    age_seconds: number;
    action: 'retire' | 'none';
    until: string | null;
    archive: string | null;
  }[];
  retention: { seconds: number | null; refusal: string | null } | null;
  locks: { reclaimed: number; kept: number } | null;
  counts: {
    listed: number;
    delivered: number;
    refused: number;
    expired: number;
    to_retire: number;
    retired: number;
    failed: number;
    waiting: number;
    deferred: number;
    reclaimed: number;
    kept_locks: number;
  };
};

export async function runFallback(
  argv: string[],
  io: Io,
  sources: FallbackSources = realFallbackSources,
): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['apply', 'json']);
  const verb = args.rest[0];
  const extra = args.rest[1];
  const problem = args.error
    ?? (verb === undefined
      ? 'a subcommand is required (prune)'
      : verb !== 'prune'
        ? `unknown subcommand "${verb}"`
        : extra !== undefined
          ? `unexpected "${extra}"`
          : null);
  if (problem !== null) {
    refuse(out, json, 'fallback', { id: 'fallback.invocation', message: problem, repair: null, usage: USAGE });
    // exit: fallback.invocation
    return 2;
  }
  const apply = args.flags.has('apply');

  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const first = loaded.errors[0];
    const said =
      first !== undefined && isNoRepository(first)
        ? withoutFileOffer(first.message)
        : first?.message ?? "the team file can't be read";
    refuse(out, json, 'fallback', { id: 'fallback.configuration', message: said, repair: null });
    // exit: fallback.configuration
    return 2;
  }
  const ctx: EscalationContext = { team: loaded.team, root: loaded.root, home: sources.home, now: sources.now };

  if (apply) {
    const refusal = applyProblem(callerOf(out));
    if (refusal !== null) {
      refuse(out, json, 'fallback', { id: 'fallback.owner', message: refusal, repair: null });
      // exit: fallback.owner
      return 1;
    }
  }

  const at = sources.now();
  const plan = planRetirement(ctx, { at });
  // A word that cannot be read refuses the run: a dry run that listed expired episodes as "none"
  // and an apply that silently retired nothing expired would both hide a broken chain behind a
  // clean exit.
  if (plan.retention !== null && plan.retention.seconds === null) {
    refuse(out, json, 'fallback', {
      id: 'fallback.policy',
      message: `the event retention word (${EVENT_THRESHOLD_POLICIES.retention_days}) could not be read: ${plan.retention.refusal ?? 'no word resolved'}`,
      repair: null,
    });
    // exit: fallback.policy
    return 1;
  }

  let report: RetirementReport | null = null;
  let locks: { reclaimed: number; kept: number; scanned: number } | null = null;
  if (apply) {
    report = retireFinished(ctx, { at, lockWaitMs: 5000 });
    locks = reclaimFallbackLocks(ctx, {});
  }

  const rows = plan.candidates;
  const toRetire = rows.filter((row) => row.eligible).length;
  const retired = report?.retired.length ?? 0;
  const failed = report?.refused.length ?? 0;

  if (!json) {
    const style = ttyStyle(io, { json: false });
    const lines = [summaryLine(rows, toRetire, apply, retired, failed)];
    if (rows.length > 0) {
      lines.push(...renderTable({
        headers: ['EPISODE', 'SEAT', 'STATE', 'AGE', 'ACTION'],
        rows: rows.map((row) => [
          row.messageId,
          row.recipient.seat,
          row.kind,
          formatAge(row.ageSeconds),
          row.eligible ? 'retire' : 'none',
        ]),
        style,
      }));
    }
    io.stdout(`${lines.join('\n')}\n`);
  } else {
    const payload: FallbackJson = {
      format: 1,
      apply,
      project: loaded.team.project,
      root: loaded.root,
      episodes: rows.map((row) => ({
        message_id: row.messageId,
        seat: row.recipient.seat,
        team: row.recipient.team,
        state: row.kind,
        age_seconds: row.ageSeconds,
        action: row.eligible ? 'retire' : 'none',
        until: row.until,
        archive: report?.retired.find((entry) => entry.messageId === row.messageId)?.archive ?? null,
      })),
      retention: retentionJson(plan.retention),
      locks: locks === null ? null : { reclaimed: locks.reclaimed, kept: locks.kept },
      counts: {
        listed: rows.length,
        delivered: rows.filter((row) => row.kind === 'delivered').length,
        refused: rows.filter((row) => row.kind === 'refused').length,
        expired: rows.filter((row) => row.kind === 'expired').length,
        to_retire: toRetire,
        retired,
        failed,
        waiting: report?.waiting.length ?? rows.filter((row) => !row.eligible).length,
        deferred: report?.deferred.length ?? 0,
        reclaimed: locks?.reclaimed ?? 0,
        kept_locks: locks?.kept ?? 0,
      },
    };
    writeJson(io, 'team.fallback', payload);
  }

  if (!apply) {
    if (toRetire === 0) {
      // exit: fallback.plan
      return 0;
    }
    // exit: fallback.stale
    return 1;
  }
  if (failed > 0) {
    // exit: fallback.incomplete
    return 1;
  }
  // exit: fallback.retired
  return 0;
}

/** Why `--apply` cannot run for this caller, or null when it can: the owner, at a terminal. */
function applyProblem(caller: Caller): string | null {
  const detached = detachedRefusal(caller);
  if (detached !== undefined) return detached;
  if (!isOwner(caller)) return `--apply is the owner's; ${describeCaller(caller)} is not the owner`;
  return null;
}

function retentionJson(word: FallbackRetention | null): FallbackJson['retention'] {
  if (word === null) return null;
  return { seconds: word.seconds, refusal: word.refusal };
}

function summaryLine(
  rows: readonly FallbackRow[],
  toRetire: number,
  apply: boolean,
  retired: number,
  failed: number,
): string {
  if (rows.length === 0) return "no finished fallback episode stands in this project's state store";
  const total = pluralCount(rows.length, 'finished fallback episode');
  if (!apply) {
    return `${total}: ${toRetire === 0 ? 'none to retire' : `${pluralCount(toRetire, 'episode')} to retire`}`;
  }
  if (failed > 0) return `${total}: ${pluralCount(retired, 'episode')} retired, ${pluralCount(failed, 'episode')} could not be retired`;
  return `${total}: ${toRetire === 0 ? 'none to retire' : `${pluralCount(retired, 'episode')} retired`}`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86_400))}d`;
}
