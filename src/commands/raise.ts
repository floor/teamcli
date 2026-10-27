// `team raise <kind> <text>`: the lead's own line to the owner — `release.ready`, or
// `decision.needed` — delivered at once rather than read later in the watch's digest.
//
// The caller rule is the command's own: the orchestrator's seat, or a seat the team file marks
// `leads`, and nobody else. The owner is not admitted: the line is the lead's to send, and the
// owner reads it in his own mailbox. A non-lead seat is refused under rule `leads`; a lead whose
// pane the state does not record, or records elsewhere, keeps `hold`'s named repairs.
//
// One raise is one signed message record in the owner's mailbox plus one `release.ready` /
// `decision.needed` event in the log. The event carries no body: its `reason` is the one line, the
// same words the record's body holds, so the watch's own owner delivery (whose record id is
// `ownerRecordId`) finds the record and stays silent — the command rings the notice itself.
//
// Two noise guards, both read off the log and the record already written:
//
// - Merge: the same kind and line from the same seat within the hour is not a second record. The
//   existing record is rewritten as `<line> (×N)` and the command says `merged`; the count is the
//   previous body's own ` (×N)` suffix, so a merge after a lost record reads as a first delivery.
// - Cap: ten raises reach the owner per team per UTC day. An eleventh is refused, and the refusal
//   tells the caller — itself the team's one lead — that the line did not reach the owner.
//
// A merged line appends no event, so it adds no raise to the day's count. `--dry-run` reads the
// log and the record and writes nothing at all: no event, no record, no notification, no state.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { appendEvent, readEvents, type EventAppendInput, type EventPayload } from '../bus/log.ts';
import { leadSeatsOf } from '../bus/kinds.ts';
import { OWNER_MAILBOX, ownerRecordId, writeRuntimeMailboxRecord } from '../bus/owner.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerIn,
  logTag,
  noPaneRefusal,
  standingOf,
  type Caller,
  type CallerVerdict,
  type SeatStanding,
} from '../caller.ts';
import { currentTeam, rememberCurrent } from '../file/current.ts';
import { withoutFileOffer } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { contextLine, hasJsonFlag, refuse, writeJson, writeJsonError } from '../output/index.ts';
import { messageFile } from './messages.ts';
import { notify as machineNotify } from '../watch/notify.ts';

export const USAGE = `Usage: team raise <kind> <text> [--dry-run] [--json]

<kind> is release.ready or decision.needed, and <text> is the one line the owner reads.
Only the orchestrator's seat or a seat the team marks \`leads\` raises.

Exits 0 when the line is delivered or merged into one already open, 1 when it is refused or the log or the owner's record can't be written, 2 when the invocation or team file can't be read.
`;

/** The two kinds the owner is raised with, and the closed list the command accepts. */
export const RAISE_KINDS = ['release.ready', 'decision.needed'] as const;
export type RaiseKind = (typeof RAISE_KINDS)[number];

function isRaiseKind(value: string): value is RaiseKind {
  return (RAISE_KINDS as readonly string[]).includes(value);
}

/** The same kind and line from the same seat inside this window is one record, counted. */
export const MERGE_WINDOW_MS = 3_600_000;

/** Raises that reach the owner per team per UTC day; a merge adds none. */
export const RAISES_PER_DAY = 10;

/** The owner's line is one line, and the record's body holds it whole; this is the same bound the
 *  watch's own delivery clips to, so a merge's ` (×N)` suffix never pushes a record past it. */
export const MAX_RAISE_TEXT = 500;

/** What `runRaise` reads from outside, so tests can stand in for the clock and the store. */
export type RaiseSources = {
  home: string;
  now: () => Date;
  /** The machine notification the owner's delivery path raises; tests record instead. */
  notify?: (text: string) => void;
};

export const realRaiseSources: RaiseSources = {
  home: homedir(),
  now: () => new Date(),
  notify: (text) => machineNotify(text, 'Team raise'),
};

export const raise: Command = (argv, io) => runRaise(argv, io, realRaiseSources);
export default raise;

export async function runRaise(argv: string[], io: Io, sources: RaiseSources = realRaiseSources): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['dry-run', 'json']);
  if (args.error) return invocation(out, args.error, json);
  const kind = args.rest[0];
  if (kind === undefined) return invocation(out, 'a <kind> is required', json);
  if (!isRaiseKind(kind)) {
    return invocation(out, `${plainLine(kind)} is not a kind the owner is raised with: release.ready or decision.needed`, json);
  }
  const extra = args.rest[2];
  if (extra !== undefined) return invocation(out, `unexpected "${plainLine(extra)}"`, json);
  const text = plainLine(args.rest[1] ?? '').trim();
  if (text === '') return invocation(out, 'a <text> is required', json);
  if (text.length > MAX_RAISE_TEXT) {
    return invocation(out, `the <text> is one line of at most ${String(MAX_RAISE_TEXT)} characters`, json);
  }
  const dry = args.flags.has('dry-run');
  const now = sources.now();
  const current = currentTeam(io.cwd, undefined, now, sources.home, false);
  if (!current.ok) {
    // `team raise` takes no `--file`, so the no-repository refusal must not offer one.
    const messages = current.errors.map(
      (problem) => `${problem.line ? `team config line ${problem.line}: ` : ''}${withoutFileOffer(plainText(problem.message))}`,
    );
    if (json) {
      writeJsonError(out, 'raise.file', messages.join('; '), null);
    } else {
      for (const msg of messages) {
        out.stderr(`team raise: ${msg}\n`);
      }
    }
    // exit: raise.file
    return 2;
  }
  const { team, dir } = current;
  const notice = current.notice ? plainText(current.notice) : undefined;
  if (notice !== undefined && !json) out.stdout(`${notice}\n`);

  // The caller rule: a lead of this team (the orchestrator's seat, or a seat marked `leads`), on
  // the pane the state records for it. Anyone else is refused by name, and the owner too.
  const leads = leadSeatsOf(team);
  const verdictOf = (caller: Caller, at: SeatStanding): CallerVerdict => {
    if (caller.kind !== 'seat' || !leads.has(caller.name)) return { kind: 'refused' };
    return callerVerdict(caller, caller.name, at);
  };
  const { caller, session } = judgeCallerIn(io, dir, team, verdictOf);
  const verdict = verdictOf(caller, standingOf(dir, session, caller));
  if (verdict.kind !== 'ok') {
    const message = verdict.kind === 'no-pane'
      ? noPaneRefusal(verdict.name)
      : verdict.kind === 'another-pane'
        ? anotherPaneRefusal(verdict.name, verdict.recordedPane)
        : `only the orchestrator's seat or a lead's raises to the owner; this call is ${describeCaller(caller)}`;
    const rule = verdict.kind === 'no-pane' || verdict.kind === 'another-pane' ? 'unplaced' : 'leads';
    const repair = verdict.kind === 'no-pane' ? 'team up' : verdict.kind === 'another-pane' ? 'team down && team up' : null;
    if (json) {
      writeJsonError(out, 'raise.refused', message, repair, 1, rule, notice);
    } else {
      out.stderr(`team raise: ${message}\n`);
    }
    // exit: raise.refused
    return 1;
  }
  if (!dry && current.path !== undefined) rememberCurrent(dir, current.path, now);
  // The gate admitted a seat; the name is read once, here, for the record and the merge test.
  const seat = caller.kind === 'seat' ? caller.name : '';

  const read = readEvents(team.project, current.root, sources.home);
  if (!read.ok) {
    return ioRefusal(out, json, `the event log can't be read: ${read.reason}`, notice);
  }
  const raises = read.events.filter((record) => isRaiseKind(record.payload.kind));
  const recent = raises
    .filter(
      (record) =>
        record.payload.kind === kind
        && record.payload.from === seat
        && record.payload.reason === text,
    )
    .filter((record) => withinHour(record.payload.ts, now))
    .at(-1)?.payload;
  // A record that was already written is what a merge counts; one that is gone can't be merged
  // into, and this raise becomes a delivery of its own with its own event.
  const mergeable = recent !== undefined && countInRecord(current.root, ownerRecordId(recent), text) > 0
    ? recent
    : undefined;
  const day = now.toISOString().slice(0, 10);
  const today = raises.filter((record) => record.payload.ts.slice(0, 10) === day).length;

  // The cap is the team's day, merged lines included once (they are events of their own day). The
  // caller is itself the team's lead — one seat carries `leads`, and only a lead raises — so the
  // refusal is the telling: it names the cap and says the line did not reach the owner.
  if (mergeable === undefined && today >= RAISES_PER_DAY) {
    const message = `ten raises have reached the owner today; this ${kind} line was not delivered`;
    if (json) {
      writeJsonError(out, 'raise.capped', message, null, 1, undefined, notice);
    } else {
      out.stderr(`team raise: ${message}\n`);
    }
    // exit: raise.capped
    return 1;
  }

  if (dry) {
    const before = mergeable === undefined ? 0 : countInRecord(current.root, ownerRecordId(mergeable), text);
    const count = before + 1;
    const summary = mergeable === undefined
      ? `raise: would deliver ${kind} to the owner at once`
      : `raise: would merge ${kind} into the owner's record (×${String(count)})`;
    return dryRun(out, json, { summary, team, session, kind, text, at: now.toISOString(), count, notice });
  }

  const delivered: Delivered = mergeable === undefined
    ? deliverFresh({
        kind,
        text,
        team,
        root: current.root,
        home: sources.home,
        session,
        at: now.toISOString(),
        now,
        seat,
        events: read.events.map((record) => record.payload.record_id),
        ring: sources.notify,
        log: (what) => logLine(dir, 'raise', logTag(caller), what, now),
      })
    : mergeInto(mergeable, {
        kind,
        text,
        count: countInRecord(current.root, ownerRecordId(mergeable), text) + 1,
        root: current.root,
        home: sources.home,
        session,
        at: now.toISOString(),
        ring: sources.notify,
        log: (what) => logLine(dir, 'raise', logTag(caller), what, now),
      });
  if (!delivered.ok) return ioRefusal(out, json, delivered.message, notice);
  if (delivered.kind === 'merged') {
    const summary = `raise: ${kind} merged into the owner's record (×${String(delivered.count)})`;
    emit(out, json, { summary, status: 'merged', team, session, kind, text, at: now.toISOString(), record: delivered.id, count: delivered.count, notice });
    // exit: raise.merged
    return 0;
  }
  const summary = `raise: ${kind} delivered to the owner at once`;
  emit(out, json, { summary, status: 'raised', team, session, kind, text, at: now.toISOString(), record: delivered.id, count: 1, notice });
  // exit: raise.raised
  return 0;
}

type Delivered =
  | { ok: true; kind: 'raised'; id: string }
  | { ok: true; kind: 'merged'; id: string; count: number }
  | { ok: false; message: string };

/** `mergeInto` always merges; the narrower type lets its callers read the count unguarded. */
type MergedDelivery =
  | { ok: true; kind: 'merged'; id: string; count: number }
  | { ok: false; message: string };

type MergeContext = {
  kind: RaiseKind;
  text: string;
  count: number;
  root: string;
  home: string;
  session: string;
  at: string;
  ring?: (text: string) => void;
  log: (what: string) => void;
};

/** Rewrites one open record as `<line> (×N)` and says so. The record id is the event's own, so a
 *  watch replaying that event finds the record and stays silent; the words stay the command's. */
function mergeInto(prior: EventPayload, input: MergeContext): MergedDelivery {
  const id = ownerRecordId(prior);
  const written = writeRuntimeMailboxRecord({
    root: input.root,
    home: input.home,
    to: OWNER_MAILBOX,
    id,
    text: counted(input.text, input.count),
    session: input.session,
    at: input.at,
  });
  if (!written.ok) return { ok: false, message: `the owner's record can't be written: ${written.error}` };
  // A record that was there for the first delivery was already rung; one that is gone now is a
  // delivery the owner never got, and this rewrite is where it reaches him.
  if (input.count === 1) input.ring?.(input.text);
  input.log(`raised ${input.kind} to owner (merged ${String(input.count)})`);
  return { ok: true, kind: 'merged', id, count: input.count };
}

type FreshInput = {
  kind: RaiseKind;
  text: string;
  team: TeamFile;
  root: string;
  home: string;
  session: string;
  at: string;
  now: Date;
  seat: string;
  /** The record ids the retained log already holds, so a repeat past the hour gets its own. */
  events: readonly string[];
  ring?: (text: string) => void;
  log: (what: string) => void;
};

/** Appends the event and writes the record under the watch's own id for it. A concurrent raise of
 *  the same line that won the append is merged into instead, when it is inside the hour. */
function deliverFresh(input: FreshInput): Delivered {
  const base = raiseRecordId(input.kind, input.seat, input.text);
  const used = new Set(input.events);
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${String(n)}`;
  const event = (recordId: string): EventAppendInput => ({
    ts: input.at,
    kind: input.kind,
    session: input.session,
    record_id: recordId,
    from: input.seat,
    to: 'owner',
    reason: input.text,
  });
  let appended = appendEvent(input.team.project, input.root, input.home, event(id), { deduplicate: true });
  for (let attempt = 0; appended.ok && appended.duplicate && attempt < 8; attempt += 1) {
    const prior = appended.record.payload;
    if (prior.kind === input.kind && prior.from === input.seat && prior.reason === input.text && withinHour(prior.ts, input.now)) {
      const count = countInRecord(input.root, ownerRecordId(prior), input.text) + 1;
      return mergeInto(prior, {
        kind: input.kind,
        text: input.text,
        count,
        root: input.root,
        home: input.home,
        session: input.session,
        at: input.at,
        ...(input.ring === undefined ? {} : { ring: input.ring }),
        log: input.log,
      });
    }
    id = `${base}-${String(attempt + 2)}`;
    appended = appendEvent(input.team.project, input.root, input.home, event(id), { deduplicate: true });
  }
  if (!appended.ok) return { ok: false, message: `the event log can't be written: ${appended.reason}` };
  const recordId = ownerRecordId(appended.record.payload);
  // A watch cannot have read this event yet (the append is this process's own), but an earlier
  // delivery of the same id may have left the record: then the owner already has it.
  const recordedBefore = existsSync(messageFile(input.root, OWNER_MAILBOX, recordId));
  if (!recordedBefore) {
    const written = writeRuntimeMailboxRecord({
      root: input.root,
      home: input.home,
      to: OWNER_MAILBOX,
      id: recordId,
      text: input.text,
      session: input.session,
      at: input.at,
    });
    if (!written.ok) return { ok: false, message: `the owner's record can't be written: ${written.error}` };
    input.ring?.(input.text);
  }
  input.log(`raised ${input.kind} to owner`);
  return { ok: true, kind: 'raised', id: recordId };
}

type EmitInput = {
  summary: string;
  status: 'raised' | 'merged';
  team: TeamFile;
  session: string;
  kind: RaiseKind;
  text: string;
  at: string;
  record: string;
  count: number;
  notice?: string;
};

function emit(io: Io, json: boolean, input: EmitInput): void {
  if (json) {
    writeJson(io, 'team.raise', {
      format: 1,
      dry_run: false,
      status: input.status,
      action_summary: input.summary,
      project: input.team.project,
      session: input.session,
      kind: input.kind,
      text: input.text,
      route: 'owner',
      at: input.at,
      record: input.record,
      count: input.count,
      ...(input.notice !== undefined ? { notice: input.notice } : {}),
    });
    return;
  }
  io.stdout(`${contextLine(input.team.project, input.session)}\n${input.summary}\n`);
}

type DryInput = Omit<EmitInput, 'status' | 'record'>;

function dryRun(io: Io, json: boolean, input: DryInput): number {
  if (json) {
    writeJson(io, 'team.raise', {
      format: 1,
      dry_run: true,
      status: 'dry-run',
      action_summary: input.summary,
      project: input.team.project,
      session: input.session,
      kind: input.kind,
      text: input.text,
      route: 'owner',
      at: input.at,
      record: null,
      count: input.count,
      ...(input.notice !== undefined ? { notice: input.notice } : {}),
    });
  } else {
    io.stdout(`${contextLine(input.team.project, input.session)}\n${input.summary}\n`);
  }
  // exit: raise.dry-run
  return 0;
}

/** What one record already counts: the bare line is one, `<line> (×N)` is N, and anything else
 *  (a record for another line, or one that doesn't parse) counts nothing. */
function countInRecord(root: string, id: string, text: string): number {
  let raw: string;
  try {
    raw = readFileSync(messageFile(root, OWNER_MAILBOX, id), 'utf8');
  } catch {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const payload = (parsed as { payload?: unknown } | null)?.payload;
  if (!payload || typeof payload !== 'object') return 0;
  const body = (payload as { body?: unknown }).body;
  if (typeof body !== 'string') return 0;
  if (body === text) return 1;
  const prefix = `${text} (×`;
  if (!body.startsWith(prefix) || !body.endsWith(')')) return 0;
  const digits = body.slice(prefix.length, -1);
  if (!/^[1-9]\d*$/.test(digits)) return 0;
  return Number(digits);
}

function counted(text: string, count: number): string {
  return count <= 1 ? text : `${text} (×${String(count)})`;
}

function withinHour(ts: string, now: Date): boolean {
  const at = Date.parse(ts);
  return Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= MERGE_WINDOW_MS;
}

/** The event's `record_id`: per kind, seat and line, so a repeat inside the hour finds the event
 *  it merges with, and one past it takes a free numeric suffix. */
function raiseRecordId(kind: RaiseKind, seat: string, text: string): string {
  const digest = createHash('sha256').update(`${kind}\u0000${seat}\u0000${text}`).digest('hex').slice(0, 12);
  return `raise-${digest}`;
}

function ioRefusal(io: Io, json: boolean, message: string, notice?: string): number {
  if (json) {
    writeJsonError(io, 'raise.io', message, null, 1, undefined, notice);
  } else {
    io.stderr(`team raise: ${message}\n`);
  }
  // exit: raise.io
  return 1;
}

function invocation(io: Io, message: string, json: boolean): number {
  refuse(io, json, 'raise', { id: 'raise.usage', message, repair: null, usage: USAGE });
  // exit: raise.usage
  return 2;
}
