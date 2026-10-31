// `team brief`: the two things a seat's launch-brief record needs outside a launch.
//
// `rollout` delivers this build's general seat brief to the seats a launch is not about to
// deliver it to itself. `prune` retires the calling seat's own launch-brief retry markers — the
// `<id>.pending` sidecars a held delivery left beside its record — when the retry can never be
// right: the seat's claim has moved past that delivery, or has read it. Prune applies the retry
// pass's own rules, prints what it would retire, and removes only those markers; a signed record,
// a receipt, an unread delivery and every ordinary send's marker are left untouched.
//
// A delivery is a claim in the session's state (`briefs`) and a signed record at the claim's
// expected id in the seat's drop folder, and the two are written by the same boundary every
// launch calls (`deliverBriefForAttribution`). The rollout is that boundary with no attributed
// seat and `broadcast: true`: it targets every declared seat the state records as live, plus
// every human seat. A seat that is not running is not mailed into a stopped pane's folder — its
// next launch delivers it — and a human seat is delivered and never read.
//
// The dry run is the default and writes nothing at all: it reads the claim and the record the
// claim names and prints one row per seat. A current seat is one whose claim is this build's
// brief and whose record at the claim's id verifies; `current` never means read — that is
// `team check`'s line. A stale or missing claim is delivered at the id the delivery will use; a
// name held by a file that is not this brief's, or by a link or a folder, is left untouched and
// recovered at the claim's next attempt. `--apply` runs the same boundary, reports each seat as
// it ended, and exits 0 only when every live or human seat is current afterwards.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../caller.ts';
import type { Current } from '../file/current.ts';
import { isParseError, NOT_A_REPO, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { mintBriefIncarnation } from '../launch/brief-id.ts';
import {
  GENERAL_BRIEF_FROM,
  GENERAL_BRIEF_SHA256,
  briefBindingOf,
  currentBriefClaim,
  deliverBriefForAttribution,
  generalBriefBody,
  generalBriefId,
  generalBriefRecord,
  recoverBrief,
  walkBriefDeliveries,
  type BriefDelivery,
  type CurrentBriefClaim,
} from '../launch/general-brief.ts';
import { heldAt } from '../launch/rules-file.ts';
import { currentClaimIn, inboxLive, NO_INBOX_LISTENER, receiptHeld } from '../mcp/inbox.ts';
import { hasJsonFlag, pluralCount, writeJson, writeJsonError } from '../output/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { findAgent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { clearPending, pendingDropPath, readPending } from '../send/pending.ts';
import { recordHolds, type StatusContext } from '../send/record.ts';
import { dropFolderReadable } from './drops.ts';
import { emptySession, readState, type SessionState } from '../state.ts';
import { buildIdentity, type BuildIdentity } from '../version.ts';

export const USAGE = `Usage: team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]
       team brief prune [--apply] [--json]

Delivers this build's general seat brief to every declared seat that is live
or human. The plan reads each seat's claim and the signed record the claim
names: a seat with no claim, an old build's claim or an earlier text is
delivered at the id that delivery uses, and a name held by a file that is not
this brief's, or by a link or a folder, is recovered at the claim's next
attempt without touching what is there. A human seat is delivered and never
read. A declared seat that is not running is left for its next launch. A seat
whose live inbox server records another build is reported stale and is not
written to: that server keeps the parsers it started with, and restarting the
seat's CLI host is what reloads the installed build. Without --apply the plan
is printed and nothing is written: no state, no drop, no receipt.

The launch-brief retry sidecars in the calling seat's own folder are what
\`prune\` retires: a launch delivery that a held send left a try marker for, and
whose retry can no longer be right because the seat's claim names a newer
delivery, or because the seat has read the one it names. It prints one row per
file and, without --apply, removes nothing. It never removes a signed record, a
receipt, the marker of a delivery the seat has not read, or any other send's
marker; a claim it cannot read retires nothing; and a caller that is not a seat
of this team on its recorded pane is refused.

Options:
  --apply    rollout: run the plan; each seat is reported as delivered,
             recovered or failed, and a seat already current is reported
             current. prune: remove the files the dry run listed
  --seat     rollout only: one declared seat to plan or deliver for; the
             others are left untouched
  --session  rollout only: the session to deliver in, the team file's own
             unless the owner names another
  --file     rollout only: the team file to read, the owner's alone
  --json     one document instead of the per-command lines: team.brief
             ({format, project, session, apply, seats, counts}) for rollout,
             team.brief-prune ({format, project, session, seat, apply, files,
             counts}) for prune

Exits 0 when the dry run finds every live or human seat current (brief.plan),
--apply leaves every one of them current (brief.current), prune has nothing to
retire (brief.prune-clean), or prune's --apply removes every file it listed
(brief.prune-applied); 1 when the dry run finds delivery work (brief.stale),
--apply leaves a seat stale or failed (brief.incomplete), prune's dry run lists
files to retire (brief.prune-due), prune's --apply leaves one unremoved
(brief.prune-incomplete), a caller who is not the seat's own pane asks prune
(brief.prune-refused), or a caller who is not the owner aims --file or
--session (brief.file-owner, brief.session-owner); 2 when the invocation can't
be read (brief.invocation), a caller who may not read this team asks
(brief.not-yours), or the team file can't be read (brief.file,
brief.file-invalid).
`;

export type BriefSources = {
  home: string;
  now: () => Date;
  /** The build this process runs, compared against a live inbox listener's marker. Left out
   *  (a test's sources), the plan keeps the liveness-only answer. */
  build?: () => BuildIdentity;
};

export const realSources: BriefSources = { home: homedir(), now: () => new Date(), build: () => buildIdentity() };

/** One seat's row: the action the plan takes (or, under `--apply`, the outcome), the record id
 *  it names, the short digest the console prints, and for a recovery the id left untouched. */
export type BriefRow = {
  seat: string;
  action: 'current' | 'deliver' | 'recover' | 'recovered' | 'not-running' | 'human' | 'stale-listener' | 'failed';
  /** The first twelve hex digits of the brief digest the row names, when it names one. */
  hash12: string | null;
  id: string | null;
  /** The id a recovery moves past: the name that is not this brief's. */
  from: string | null;
  reason: string | null;
  /** Whether the seat is current after the run; a not-running seat is not a target and is false. */
  current: boolean;
};

export type BriefDocument = {
  format: 1;
  project: string;
  session: string;
  apply: boolean;
  seats: BriefRow[];
  counts: {
    current: number;
    deliver: number;
    recover: number;
    not_running: number;
    human: number;
    stale_listener: number;
    failed: number;
  };
};

/** One launch-brief retry marker `prune` looked at: where it is, which delivery it names, why
 *  the retry cannot be right, and what the run did with it. */
export type BriefPruneFile = {
  path: string;
  id: string;
  from: string;
  reason: 'read' | 'superseded';
  outcome: 'would-retire' | 'retired' | 'failed';
  error: string | null;
};

export type BriefPruneDocument = {
  format: 1;
  project: string;
  session: string;
  seat: string;
  apply: boolean;
  files: BriefPruneFile[];
  counts: {
    files: number;
    retired: number;
    failed: number;
  };
};

export const brief: Command = (argv, io) => runBrief(argv, io, realSources);
export default brief;

/** The first twelve hex digits, the row's short digest. */
function short(sha256: string): string {
  return sha256.slice(0, 12);
}

function notYours(io: Io, json: boolean): number {
  const message = 'this team is not yours to read';
  if (json) writeJsonError(io, 'brief.not-yours', message, null);
  else io.stderr(`team brief: ${message}\n`);
  // exit: brief.not-yours
  return 2;
}

function invocation(io: Io, json: boolean, problem: string): number {
  if (json) writeJsonError(io, 'brief.invocation', problem, null);
  else io.stderr(`team brief: ${problem}\n${USAGE}`);
  // exit: brief.invocation
  return 2;
}

function unreadable(io: Io, json: boolean, id: 'brief.file' | 'brief.file-invalid', message: string): number {
  if (json) writeJsonError(io, id, message, null);
  else io.stderr(`team brief: ${message}\n`);
  // exit: brief.file
  // exit: brief.file-invalid
  return 2;
}

function pruneRefused(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'brief.prune-refused', message, null);
  else io.stderr(`team brief prune: ${message}\n`);
  // exit: brief.prune-refused
  return 1;
}

/** The record a delivery at one lifetime posts: the delivered body's id and the digest it
 *  carries. `at` is not compared by `recordHolds`, so a read of the name may pass any. */
function deliveredPayload(input: {
  seat: string;
  root: string;
  session: string;
  at: string;
  incarnation: string;
  attempt: number;
}) {
  return generalBriefRecord({
    to: input.seat,
    root: input.root,
    session: input.session,
    at: input.at,
    incarnation: input.incarnation,
    attempt: input.attempt,
  });
}

/**
 * Whether the seat's claim and the record it names are this build's brief, delivered: the
 * currency the rollout reports. The read is never asked for here. The expected record takes the
 * claim's own id and thread, as `team check` does, so a handover sentence an earlier delivery
 * carried does not fail a delivery the claim stands for.
 */
function currency(input: {
  seat: string;
  claim: CurrentBriefClaim | null;
  root: string;
  session: string;
  home: string;
}): boolean {
  const { claim } = input;
  if (claim === null || claim.sha256 !== GENERAL_BRIEF_SHA256) return false;
  const dropDir = join(input.root, '.agents', 'send-drops', input.session, input.seat);
  const expected = {
    ...deliveredPayload({
      seat: input.seat,
      root: input.root,
      session: input.session,
      at: claim.at,
      incarnation: claim.incarnation,
      attempt: claim.attempt,
    }),
    id: claim.id,
    thread: claim.id,
  };
  return recordHolds(join(dropDir, claim.id), expected, input.home, { body: false, to_id: false });
}

/** One seat's plan, before anything is written. `current` is the delivery currency of a live or
 *  human seat; a not-running seat is not a target at all. */
type Plan =
  | { kind: 'not-running' }
  | { kind: 'human'; current: boolean; claim: CurrentBriefClaim | null }
  | { kind: 'current'; claim: CurrentBriefClaim }
  | { kind: 'stale-listener'; reason: string }
  | { kind: 'deliver'; id: string }
  | { kind: 'recover'; from: string; id: string };

/** Whether the state records this seat as running. */
function live(state: SessionState, seat: string): boolean {
  return state.seats[seat] !== undefined;
}

/** Whether a plan leaves the seat current. */
function plannedCurrent(plan: Plan): boolean {
  if (plan.kind === 'current') return true;
  if (plan.kind === 'human') return plan.current;
  return false;
}

/**
 * The plan `deliverBriefForAttribution` would execute for one seat, read from the state and the
 * folder without writing either. The delivery's own id is derived from the lifetime the claim
 * keeps; a seat with no claim has no lifetime yet, so the id shown is the one a fresh lifetime
 * would produce — `--apply` mints the lifetime it writes and reports its id.
 */
function planSeat(input: {
  seat: { name: string; human?: boolean };
  state: SessionState;
  root: string;
  session: string;
  home: string;
  build: BuildIdentity | null;
}): Plan {
  const { seat } = input;
  const claim = currentBriefClaim(input.state.briefs?.[seat.name]);
  const due = live(input.state, seat.name) || seat.human === true;
  if (!due) return { kind: 'not-running' };
  const current = currency({ seat: seat.name, claim, root: input.root, session: input.session, home: input.home });
  if (seat.human === true) return { kind: 'human', current, claim };
  if (current) return { kind: 'current', claim: claim as CurrentBriefClaim };
  // A live inbox server started from another build cannot read the record this one signs until
  // its host reloads it. The plan names that instead of writing a drop the server would refuse.
  const inbox = inboxLive(
    join(input.root, '.agents', 'send-drops', input.session, seat.name),
    input.root,
    input.session,
    seat.name,
    input.build,
  );
  if (!inbox.live && inbox.reason !== NO_INBOX_LISTENER) {
    return { kind: 'stale-listener', reason: inbox.reason };
  }
  const body = generalBriefBody();
  // A plan row for a seat with no claim shows the id a fresh lifetime would produce; the apply
  // mints the lifetime it writes, so that row's id is the one it reported, never this one.
  const incarnation = claim?.incarnation ?? mintBriefIncarnation();
  const attempt = claim?.attempt ?? 0;
  const id = generalBriefId(incarnation, body, attempt);
  const path = join(input.root, '.agents', 'send-drops', input.session, seat.name, id);
  const held = heldAt(path);
  const holds = held.kind === 'file'
    && recordHolds(path, deliveredPayload({
      seat: seat.name,
      root: input.root,
      session: input.session,
      at: claim?.at ?? '',
      incarnation,
      attempt,
    }), input.home, { to_id: false });
  if (held.kind !== 'missing' && !holds) {
    return { kind: 'recover', from: id, id: generalBriefId(incarnation, body, attempt + 1) };
  }
  return { kind: 'deliver', id };
}

function rowOf(seat: string, plan: Plan): BriefRow {
  const hash12 = short(GENERAL_BRIEF_SHA256);
  if (plan.kind === 'not-running') {
    return { seat, action: 'not-running', hash12: null, id: null, from: null, reason: null, current: false };
  }
  if (plan.kind === 'human') {
    return {
      seat,
      action: 'human',
      hash12: plan.claim === null ? null : short(plan.claim.sha256),
      id: plan.claim?.id ?? null,
      from: null,
      reason: null,
      current: plan.current,
    };
  }
  if (plan.kind === 'current') {
    return { seat, action: 'current', hash12: short(plan.claim.sha256), id: plan.claim.id, from: null, reason: null, current: true };
  }
  if (plan.kind === 'stale-listener') {
    return { seat, action: 'stale-listener', hash12: null, id: null, from: null, reason: plan.reason, current: false };
  }
  if (plan.kind === 'recover') {
    return { seat, action: 'recover', hash12, id: plan.id, from: plan.from, reason: null, current: false };
  }
  return { seat, action: 'deliver', hash12, id: plan.id, from: null, reason: null, current: false };
}

function lineOf(row: BriefRow): string {
  switch (row.action) {
    case 'current':
      return `brief ${row.seat}: current ${row.hash12 ?? ''} ${row.id ?? ''}\n`;
    case 'deliver':
      return `deliver ${row.seat}: ${row.hash12 ?? ''} -> ${row.id ?? ''}\n`;
    case 'recover':
      return `recover ${row.seat}: the name at ${row.from ?? ''} is not this brief's; would deliver at ${row.id ?? ''}\n`;
    case 'recovered':
      return `recovered ${row.seat}: the name at ${row.from ?? ''} is not this brief's; delivered at ${row.id ?? ''}\n`;
    case 'not-running':
      return `not running ${row.seat}: delivered at its next launch\n`;
    case 'human':
      return `human ${row.seat}: delivery only\n`;
    case 'stale-listener':
      return `stale ${row.seat}: ${row.reason ?? ''}\n`;
    case 'failed':
      return `failed ${row.seat}: ${row.reason ?? ''}\n`;
  }
}

function countsOf(rows: readonly BriefRow[]): BriefDocument['counts'] {
  const counts = { current: 0, deliver: 0, recover: 0, not_running: 0, human: 0, stale_listener: 0, failed: 0 };
  for (const row of rows) {
    if (row.action === 'current') counts.current += 1;
    else if (row.action === 'deliver') counts.deliver += 1;
    else if (row.action === 'recover' || row.action === 'recovered') counts.recover += 1;
    else if (row.action === 'not-running') counts.not_running += 1;
    else if (row.action === 'human') counts.human += 1;
    else if (row.action === 'stale-listener') counts.stale_listener += 1;
    else counts.failed += 1;
  }
  return counts;
}

/**
 * The command. The gate is the read gate: the owner reads any file it names, and every other
 * caller learns nothing until the file the caller's own place finds admits it. `--apply` writes
 * only the seat's claim and its signed drop — never a pane, never a session, never herdr.
 */
export async function runBrief(argv: string[], io: Io, sources: BriefSources = realSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file', 'seat'], ['apply', 'json']);
  // The raw argv, before the parser: `--nope --json` still answers with the structured error.
  const json = hasJsonFlag(argv);
  const apply = args.flags.has('apply');
  const sub = args.rest[0];
  if (args.error !== undefined || (sub !== 'rollout' && sub !== 'prune') || args.rest.length > 1) {
    const problem = args.error
      ?? (sub === undefined ? 'a subcommand is required: rollout or prune'
        : sub !== 'rollout' && sub !== 'prune' ? `unexpected "${sub}"`
          : `unexpected "${args.rest[1] ?? ''}"`);
    return invocation(io, json, problem);
  }
  if (sub === 'prune') {
    // Prune works in the caller's own folder: a seat is not aimed, and `--file`/`--session`
    // aim another team's records, so all three are an invocation error here.
    const stray = args.values.seat !== undefined ? 'seat'
      : args.values.session !== undefined ? 'session'
        : args.values.file !== undefined ? 'file' : null;
    if (stray !== null) return invocation(io, json, `unknown option --${stray}`);
    return runBriefPrune({ io, json, apply, sources });
  }
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  // A caller who is not the owner loads the file its own place finds: the flags aim nothing
  // until the gate has answered, and a run that does not pass learns nothing of the file.
  const file = owner ? args.values.file : undefined;
  const aimedSession = owner ? args.values.session : undefined;
  const loaded = readTeamConfig(io.cwd, {
    ...(file === undefined ? {} : { file }),
    home: sources.home,
    ...(aimedSession === undefined ? {} : { session: aimedSession }),
  });
  if (!loaded.ok) {
    if (!owner) return notYours(io, json);
    const first = loaded.errors[0];
    const id = loaded.errors.some(isParseError) ? 'brief.file-invalid' : 'brief.file';
    return unreadable(io, json, id, first?.message ?? "the team file can't be read");
  }
  const dir = dirname(loaded.path);
  const current: Extract<Current, { ok: true }> = {
    ok: true,
    team: loaded.team,
    root: loaded.root,
    dir,
    warnings: loaded.warnings,
  };
  if (!owner) {
    if (!mayReadTeam(current, io, { home: sources.home })) return notYours(io, json);
    if (args.values.file !== undefined) {
      const message = fileOwnerRefusal(io, args.values.file) ?? "--file is the owner's";
      if (json) writeJsonError(io, 'brief.file-owner', message, null);
      else io.stderr(`team brief: ${message}\n`);
      // exit: brief.file-owner
      return 1;
    }
    if (args.values.session !== undefined) {
      const message = sessionOwnerRefusal(walked);
      if (json) writeJsonError(io, 'brief.session-owner', message, null);
      else io.stderr(`team brief: ${message}\n`);
      // exit: brief.session-owner
      return 1;
    }
  }
  const session = aimedSession ?? loaded.team.session;
  const { root, team } = loaded;
  // A named seat narrows the run to that seat: the others are not planned, not written and not
  // asked about, so a targeted retry never re-delivers the whole team.
  const aimedSeat = args.values.seat;
  const seats = aimedSeat === undefined ? team.seats : team.seats.filter((seat) => seat.name === aimedSeat);
  if (aimedSeat !== undefined && seats.length === 0) {
    return invocation(io, json, `the team file declares no seat ${JSON.stringify(aimedSeat)}`);
  }
  const build = sources.build?.() ?? null;
  const stateOf = (): SessionState => readState(dir).sessions[session] ?? emptySession();
  const state = stateOf();
  const before = seats.map((seat) => ({
    seat,
    plan: planSeat({ seat, state, root, session, home: sources.home, build }),
  }));
  let rows: BriefRow[];
  if (!apply) {
    rows = before.map(({ seat, plan }) => rowOf(seat.name, plan));
  } else {
    // A seat whose live listener is another build is not written to: its runtime cannot read
    // this record, and the plan already names the restart it needs.
    const deliverTo = new Set(
      before.filter(({ plan }) => plan.kind !== 'stale-listener').map(({ seat }) => seat.name),
    );
    const report = deliverBriefForAttribution({
      dir,
      root,
      session,
      home: sources.home,
      now: sources.now(),
      team: { ...team, seats: team.seats.filter((seat) => deliverTo.has(seat.name)) },
      state,
      attributed: [],
      broadcast: true,
    });
    await walkBriefDeliveries(report, { dir, home: sources.home, io });
    const ended = new Map(report.deliveries.map((delivery) => [delivery.seat, delivery]));
    const out: BriefRow[] = [];
    for (const { seat, plan } of before) {
      // A seat whose delivery was refused is reported as the failure it is, even when the plan
      // would have called it not running: "delivered at its next launch" is not true when the
      // transport refused to write.
      if ((plan.kind === 'not-running' || plan.kind === 'stale-listener') && ended.get(seat.name)?.ok !== false) {
        out.push(rowOf(seat.name, plan));
        continue;
      }
      const delivery = ended.get(seat.name);
      if (delivery === undefined) {
        out.push({ seat: seat.name, action: 'failed', hash12: null, id: null, from: null, reason: 'the delivery was not recorded', current: false });
        continue;
      }
      if (delivery.ok) {
        const hash12 = short(GENERAL_BRIEF_SHA256);
        if (plan.kind === 'human') out.push({ seat: seat.name, action: 'human', hash12, id: delivery.id, from: null, reason: null, current: true });
        else if (plan.kind === 'current') out.push({ seat: seat.name, action: 'current', hash12, id: delivery.id, from: null, reason: null, current: true });
        else out.push({ seat: seat.name, action: 'deliver', hash12, id: delivery.id, from: null, reason: null, current: true });
        continue;
      }
      if (delivery.blocked !== undefined) {
        // The boundary reported the name as held; the claim it wrote is the one to recover from.
        const claim = currentBriefClaim(stateOf().briefs?.[seat.name]);
        if (claim === null) {
          out.push({ seat: seat.name, action: 'failed', hash12: null, id: null, from: null, reason: delivery.reason, current: false });
          continue;
        }
        const recovered = recoverBrief({
          dir,
          root,
          session,
          seat: seat.name,
          home: sources.home,
          entity: team.entity,
          claim,
          toId: findAgent(sources.home, { team: teamIdOf(root), seat: seat.name })?.id ?? null,
        });
        out.push(recovered.ok
          ? {
            seat: seat.name,
            action: 'recovered',
            hash12: short(GENERAL_BRIEF_SHA256),
            id: recovered.id,
            from: recovered.recoveredFrom ?? claim.id,
            reason: null,
            current: true,
          }
          : { seat: seat.name, action: 'failed', hash12: null, id: null, from: null, reason: recovered.reason, current: false });
        continue;
      }
      out.push({ seat: seat.name, action: 'failed', hash12: null, id: null, from: null, reason: delivery.reason, current: false });
    }
    rows = out;
  }
  // The run's own answer is the state's: a seat is current only when the claim and the record
  // it names verify now, whatever this process reported along the way.
  const after = apply ? stateOf() : state;
  const currentBySeat = new Map<string, boolean>();
  let incomplete = false;
  for (const seat of seats) {
    const due = live(after, seat.name) || seat.human === true;
    if (!due) continue;
    const held = currency({ seat: seat.name, claim: currentBriefClaim(after.briefs?.[seat.name]), root, session, home: sources.home });
    currentBySeat.set(seat.name, held);
    if (!held) incomplete = true;
  }
  if (apply) {
    rows = rows.map((row) => {
      if (row.action === 'not-running' || row.action === 'stale-listener') return row;
      const held = currentBySeat.get(row.seat) === true;
      // A row that says it delivered must not stand if the state does not agree.
      if (!held && row.action !== 'failed') {
        return { ...row, action: 'failed' as const, hash12: null, id: null, from: null, reason: 'the seat is not current after the run', current: false };
      }
      return { ...row, current: held };
    });
  }
  if (json) {
    const document: BriefDocument = {
      format: 1,
      project: team.project,
      session,
      apply,
      seats: rows,
      counts: countsOf(rows),
    };
    writeJson(io, 'team.brief', document);
  } else {
    io.stdout(rows.map(lineOf).join(''));
  }
  if (apply) {
    if (incomplete) {
      // exit: brief.incomplete
      return 1;
    }
    // exit: brief.current
    return 0;
  }
  if (incomplete) {
    // exit: brief.stale
    return 1;
  }
  // exit: brief.plan
  return 0;
}

/** One prune row's line: what the run did with the marker, where it is, and why the retry can
 *  no longer be right. */
function pruneLineOf(file: BriefPruneFile): string {
  const why = file.reason === 'read'
    ? 'the delivery was read'
    : "the seat's current claim names a newer delivery";
  if (file.outcome === 'failed') return `failed ${file.path}: ${file.error ?? 'the file could not be removed'}\n`;
  if (file.outcome === 'retired') return `retired ${file.path}: ${why}\n`;
  return `would retire ${file.path}: ${why}\n`;
}

/**
 * `team brief prune`: retires the calling seat's own launch-brief retry markers, applying the
 * retry pass's own rules without typing anything. A launch marker is retired when its delivery is
 * not the seat's current claim — the claim names a newer delivery, and the seat's reader refuses
 * the old record as superseded — or when a signed receipt bound to the current claim says the
 * seat read it, which a typed marker has no leg of its own to show. A marker of the current claim
 * that is not read is never touched, and neither is any other file in the folder. The dry run is
 * the default.
 */
function runBriefPrune(input: { io: Io; json: boolean; apply: boolean; sources: BriefSources }): number {
  const { io, json, apply } = input;
  // The folder is the seat's own, resolved the way every command resolves it. Prune takes no
  // `--file`, so the shared no-repository sentence must not offer one.
  const loaded = readTeamConfig(io.cwd, { home: input.sources.home });
  if (!loaded.ok) {
    const message = loaded.errors[0]?.message ?? "the team file can't be read";
    if (message.startsWith(NOT_A_REPO)) return unreadable(io, json, 'brief.file', withoutFileOffer(message));
    if (loaded.errors.some(isParseError)) return unreadable(io, json, 'brief.file-invalid', message);
    return unreadable(io, json, 'brief.file', message);
  }
  const dir = dirname(loaded.path);
  const session = loaded.team.session;
  // A retry marker is one seat's mailbox: the caller must be that seat, placed on the pane the
  // state records for it. The owner and a delegate pane are not a seat and retire nothing.
  const { caller, shown } = judgeCallerOf(io, session);
  const named = caller.kind === 'seat' && loaded.team.seats.some((seat) => seat.name === caller.name) ? caller : null;
  if (named === null) {
    return pruneRefused(io, json, `only a seat of this team retires its own launch-brief retry markers; this call is ${describeCaller(shown)}`);
  }
  const verdict = callerVerdict(named, named.name, standingOf(dir, session, named));
  if (verdict.kind === 'no-pane') return pruneRefused(io, json, noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return pruneRefused(io, json, anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return pruneRefused(io, json, `only a seat of this team retires its own launch-brief retry markers; this call is ${describeCaller(shown)}`);
  }
  const seat = named.name;
  const dropDir = join(dir, 'send-drops', session, seat);
  if (!dropFolderReadable(dir, session, seat)) {
    return pruneRefused(io, json, 'the drop folder is not a real folder: a link or a file stands in its path');
  }
  // The retry's own two questions are asked against what the state holds now: which delivery is
  // the seat's current claim, and has a receipt bound to that claim said it was read. A claim
  // this build cannot read answers neither, so nothing is retired.
  const claim = currentClaimIn(loaded.root, session, seat);
  if (claim === null) {
    return pruneRefused(io, json, "the seat's current brief claim can't be read, so nothing was retired");
  }
  const context: StatusContext = { to: seat, root: loaded.root, session };
  const read = receiptHeld(dropDir, claim.id, context, input.sources.home, briefBindingOf(claim));
  const files: BriefPruneFile[] = [];
  for (const drop of readPending(dropDir)) {
    if (drop.from !== GENERAL_BRIEF_FROM || drop.to !== seat) continue;
    const reason = drop.id === claim.id ? (read ? 'read' as const : null) : 'superseded' as const;
    if (reason === null) continue;
    files.push({
      path: pendingDropPath(dropDir, drop.id),
      id: drop.id,
      from: drop.from,
      reason,
      outcome: apply ? 'retired' : 'would-retire',
      error: null,
    });
  }
  if (apply) {
    for (const file of files) {
      clearPending(dropDir, file.id);
      // The removal is verified: a marker that is still at its name was not removed, and the
      // run says so rather than claiming a retirement that did not happen.
      if (heldAt(file.path).kind !== 'missing') {
        file.outcome = 'failed';
        file.error = 'the file could not be removed';
      }
    }
  }
  const retired = files.filter((file) => file.outcome === 'retired').length;
  const failed = files.filter((file) => file.outcome === 'failed').length;
  if (json) {
    const document: BriefPruneDocument = {
      format: 1,
      project: loaded.team.project,
      session,
      seat,
      apply,
      files,
      counts: { files: files.length, retired, failed },
    };
    writeJson(io, 'team.brief-prune', document);
  } else {
    io.stdout(files.map(pruneLineOf).join(''));
    if (apply) {
      io.stdout(`${pluralCount(retired, 'file')} retired\n`);
      if (failed > 0) io.stdout(`${pluralCount(failed, 'file')} not removed\n`);
    } else {
      io.stdout(`${pluralCount(files.length, 'file')} to retire\n`);
    }
  }
  if (apply) {
    if (failed > 0) {
      // exit: brief.prune-incomplete
      return 1;
    }
    // exit: brief.prune-applied
    return 0;
  }
  if (files.length > 0) {
    // exit: brief.prune-due
    return 1;
  }
  // exit: brief.prune-clean
  return 0;
}
