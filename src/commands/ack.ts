// `team ack <id>`: marks one message record read, without printing it.
//
// The act is the same signed `read` receipt `team messages` publishes before it shows a body
// (`src/send/read-receipt.ts`): the per-id gate every reader shares. A seat that has seen a
// message out of band — a log line, a summary, a wake it already acted on — acknowledges it here,
// and the message stops waiting: `team drops`, `inbox_read` and the unread watch all read the
// receipt, so neither a wake line nor an unread report follows. `team reply` marks a message read
// by answering it; `team ack` is for a message that needs no answer.
//
// The record is found the way `team reply` finds it: by its id in the session's transport tree,
// verified against the message key, addressed to the caller, and sitting in that addressee's own
// folder. An entry at a receipt name this run did not sign is left as it is — it may record an
// exposure that already happened — and the refusal says so. A message a plain grant let a client
// write is refused: its receipt lives in a client inbox this command does not serve. A message a
// bundle grant let a client write is refused too, unless that grant's signed op list carries
// `ack`: then the seat the team places, in the one team and session the grant signs, acknowledges
// it here, under the same verified bound a reply to the same thread is admitted by.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { resolveBundleSendTarget } from '../client/bundles.ts';
import { activeClientUpGrant, clientAdmission, readClientThreadGrant, withClientGrantLock, type ClientUpGrantRecord } from '../client/records.ts';
import {
  callerVerdict,
  describeCaller,
  detachedRefusal,
  judgeCallerIn,
  standingOf,
  walkCaller,
  type Caller,
  type SeatStanding,
} from '../caller.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import type { Command, Io } from '../io.ts';
import { contextLine, hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { gateVerdict } from '../permissions/who.ts';
import { appendHistory } from '../send/history.ts';
import { parseDuration, scanAckSeat, seatClearTargetStatus } from '../send/message-archive.ts';
import { LEAD_ACK_PREFIX, recordNameOk } from '../send/record.ts';
import { publishRecordRead } from '../send/read-receipt.ts';
import { messageKeyState } from '../store/keys.ts';
import {
  findRecord,
  legacyHolds,
  MIN_ID_PREFIX_LEN,
  raiseSecurityRefusal,
  recordHits,
  samePath,
} from './reply.ts';
import { recordDir } from './messages.ts';

export const USAGE = `Usage: team ack <id> [--json]
Usage: team ack --seat <seat> --older-than <dur> [--dry-run] [--json]

Marks the message record <id> read, without printing it. The signed read
receipt is the same one team messages writes before it shows a body, so the
message stops waiting for this seat and the unread watch stops ringing it.
A message the caller answers with team reply is marked read by the answer.

The scoped form marks every record one seat's folder holds that is older
than <dur> read: the owner or a seat this team marks \`leads\` runs it, and it
never acknowledges the general seat brief, a client's record or a message a
handoff has pending. --dry-run lists what it would mark and writes nothing.

Exits 0 when the message is read or already was, 1 when the caller or the
record is refused, 2 when the invocation or the team file can't be read.
`;

export type AckHost = {
  home: string;
  now: () => Date;
};

export const realHost: AckHost = { home: homedir(), now: () => new Date() };

const ack: Command = (argv, io) => runAck(argv, io, realHost);
export default ack;

/** One refusal on the record or the caller: `ack.refused`, exit 1, always. The repair is the
 *  entry or the next step the caller can take; null when the message alone says it. */
function refused(io: Io, json: boolean, message: string, repair: string | null = null): number {
  refuse(io, json, 'ack', { id: 'ack.refused', message, repair });
  return 1; // exit: ack.refused
}

/** A team file this run cannot read. Exit 2, always. */
function configuration(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'ack', { id: 'ack.configuration', message, repair: null });
  return 2; // exit: ack.configuration
}

/** The invocation cannot be read. Exit 2, always. */
function usage(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'ack', { id: 'ack.usage', message, repair: null, usage: USAGE });
  return 2; // exit: ack.usage
}

/** The one written outcome: the `team.ack` document under `--json`, the context line and the one
 *  line otherwise. `ack.read` is this command's only written outcome — a receipt this run wrote
 *  and one another reader already wrote are both `read` — exit 0, always, from this one site. */
function written(io: Io, json: boolean, doc: Record<string, unknown>, line: string): number {
  if (json) writeJson(io, 'team.ack', doc);
  else io.stdout(line);
  return 0; // exit: ack.read
}

/** Whether argv asks for the scoped form, before the parser sees it: `--seat` and
 *  `--older-than`, in either spelling the parser accepts. */
function mentions(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function scopedAck(argv: readonly string[]): boolean {
  return mentions(argv, 'seat') || mentions(argv, 'older-than');
}

/** The scoped call's written outcome: every due record is read, or already was. */
function scopedDone(io: Io, json: boolean, doc: Record<string, unknown>, line: string): number {
  if (json) writeJson(io, 'team.ack', doc);
  else io.stdout(line);
  return 0; // exit: ack.scoped
}

/** The scoped call's partial outcome: at least one due record could not be marked read, and the
 *  others were. The failures are named on stderr; the document carries the counts. */
function scopedFailed(io: Io, json: boolean, doc: Record<string, unknown>, line: string, failures: readonly string[]): number {
  for (const failure of failures) io.stderr(`team ack: ${failure}\n`);
  if (json) writeJson(io, 'team.ack', doc);
  else io.stdout(line);
  return 1; // exit: ack.scoped-failed
}

/** The scoped call's refusal: not the owner's or a lead's, or no key to sign a receipt with. */
function scopedRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'ack', { id: 'ack.scoped-refused', message, repair: null });
  return 1; // exit: ack.scoped-refused
}

/** The relative path of one record's receipt, as the caller reads it in a repair line. */
function receiptPath(session: string, seat: string, id: string, status: 'read' | 'replied'): string {
  return join('.agents', 'send-drops', session, seat, `${id}.${status}.json`);
}

export async function runAck(argv: string[], io: Io, host: AckHost): Promise<number> {
  // Raw argv, before the parser: `--nope --json` must still answer with the structured document.
  const json = hasJsonFlag(argv);
  if (io.general !== undefined && scopedAck(argv)) return refused(io, json, 'a client acknowledgement needs an exact UUID; scoped acknowledgement is for seats and the owner');
  if (scopedAck(argv)) return await runScopedAck(argv, io, host, json);
  const args = readArgs(argv, [], ['json']);
  if (args.error) return usage(io, json, args.error);
  const id = args.rest[0];
  if (id === undefined) return usage(io, json, '<id> is required');
  if (args.rest.length > 1) return usage(io, json, `unexpected "${args.rest[1]}"`);
  if (!recordNameOk(id)) return usage(io, json, `"${id}" is not a record id`);
  if (io.general !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return refused(io, json, 'a client acknowledgement needs an exact UUID; short prefixes are for seats and the owner');
  }

  // The walk decides the one detached refusal — the owner with no terminal. It places a caller
  // under herdr as `unplaced` without reading a session, so it must never decide who may
  // acknowledge: the owner-or-seat admission is judged below, on the caller placed in the team's
  // own session, exactly as `team send` places it (src/commands/send.ts).
  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return refused(io, json, detached);

  const loaded = readTeamConfig(io.cwd, { home: host.home });
  if (!loaded.ok) {
    // `team ack` takes no `--file`, so the shared no-repository sentence must not offer one.
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, json, withoutFileOffer(message) || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const session = team.session;
  const judged = judgeCallerIn(io, dir, team);
  const standing = standingOf(dir, judged.session, judged.caller);
  // The caller the placement checks judge is the one placed in the session judged, exactly as
  // `team reply` reads it: a seat that acknowledged from its own pane is that seat, and a caller
  // of another session is not the addressee here.
  const placed = judged.caller;
  if (placed.kind !== 'owner' && placed.kind !== 'seat') {
    return refused(io, json, `only the owner or a seat of this team acknowledges a message; this call is ${describeCaller(placed)}`);
  }
  const me = placed.kind === 'seat' ? placed.name : 'owner';
  if (placed.kind === 'seat' && callerVerdict(placed, me, standing).kind !== 'ok') {
    raiseSecurityRefusal(team, root, host.home, dir, placed, 'placement', null, host.now());
    return refused(io, json, `seat ${me} is not this call on its own pane and session; this call is ${describeCaller(placed)}`);
  }

  // The id is looked up before the key is read: a name nothing holds needs no key to say so.
  const hits = recordHits(root, session, id);
  if (hits.length === 0) {
    if (legacyHolds(root, id)) {
      return refused(io, json, `the message ${id} was written by an earlier build; it is read with team messages, not acknowledged`);
    }
    if (id.length < MIN_ID_PREFIX_LEN) {
      return refused(io, json, `record prefix "${id}" is shorter than ${String(MIN_ID_PREFIX_LEN)} characters; pass at least ${String(MIN_ID_PREFIX_LEN)} characters`);
    }
    return refused(io, json, `no record named ${id} waits in this project's session "${session}"`);
  }

  const keyState = messageKeyState(host.home);
  if (keyState.kind !== 'key') return refused(io, json, 'no message key; nothing was written');
  const key = keyState.key;

  const lookup = findRecord(hits, root, session, id, me, key);
  if (lookup.kind === 'none') {
    return refused(io, json, `no record named ${id} waits in this project's session "${session}"`);
  }
  if (lookup.kind === 'legacy') {
    return refused(io, json, `the message ${id} was written by an earlier build; it is read with team messages, not acknowledged`);
  }
  if (lookup.kind === 'refused') return refused(io, json, lookup.why);
  const found = lookup.found;
  const acknowledged = found.record.payload;
  const resolvedId = acknowledged.id;

  // A record a client wrote carries the grant that opened its thread. A plain grant's read
  // belongs to the client inbox, as it always has. A bundle grant whose signed op list carries
  // `ack` admits this command for its own client's opening record, in the one team and session
  // the grant signs, addressed to the seat the team places: the same binding a reply to that
  // thread is admitted by, checked against the grant's signed client, its team and the registry.
  let clientOrigin: { grant: ClientUpGrantRecord; signature: string } | null = null;
  if (acknowledged.from_client !== undefined) {
    const origin = readClientThreadGrant(host.home, acknowledged.from_client.grant_id);
    if (!origin.ok) {
      return refused(io, json, `the record's originating grant ${acknowledged.from_client.grant_id} does not verify in the canonical store: ${origin.why}; nothing was written`);
    }
    if (origin.kind === 'grant') {
      return refused(io, json, `record ${resolvedId} was written by a client; its read belongs to the client inbox, not to this command`);
    }
    const grant = origin.grant;
    if (grant.clientId !== acknowledged.from_client.client_id) {
      return refused(io, json, `this record names client "${acknowledged.from_client.client_id}" and its grant names "${grant.clientId}"; nothing was written`);
    }
    const admitted = clientAdmission(host.home, grant.clientId, grant.entity);
    if (!admitted.ok) return refused(io, json, `${admitted.why}; nothing was written`);
    if (!grant.ops.includes('ack')) {
      return refused(io, json, `the record's bundle grant ${grant.grantId} carries ${grant.ops.join(', ') || 'no op'}, not ack; only a bundle that carries ack admits this acknowledgement; nothing was written`);
    }
    if (acknowledged.thread !== acknowledged.id) {
      return refused(io, json, `record ${resolvedId} answers another record; a client thread is the client's own opening record, and only it is acknowledged; nothing was written`);
    }
    if (acknowledged.to_id === null) {
      return refused(io, json, `record ${resolvedId} carries no to_id; the seat the bundle grant reaches cannot be matched to it; nothing was written`);
    }
    const resolved = resolveBundleSendTarget(host.home, grant, acknowledged.to);
    if (!resolved.ok) return refused(io, json, `the bundle grant's recipient cannot be resolved: ${resolved.why}; nothing was written`);
    const target = resolved.target;
    if (!samePath(target.teamRoot, root) || target.session !== session) {
      return refused(io, json, `the bundle grant's recipient lives in another checkout or session than this record; nothing was written`);
    }
    if (acknowledged.to !== target.recipientSeat || acknowledged.to_id !== target.recipientId) {
      return refused(io, json, `record ${resolvedId} is addressed to "${acknowledged.to}" (${acknowledged.to_id}), not to the recipient the bundle grant reaches, "${target.recipientSeat}" (${target.recipientId}); nothing was written`);
    }
    if (me !== target.recipientSeat) {
      return refused(io, json, `seat ${me} is not the recipient of the client thread; only ${target.recipientSeat} acknowledges it; nothing was written`);
    }
    clientOrigin = { grant, signature: origin.signature };
  }
  // A general seat brief's read is bound to the seat's current claim, and its reader verifies the
  // receipt against that binding: a plain receipt here would hold the receipt name the seat's own
  // turn-start reader needs, so the brief would never be served. Read it there, not here.
  if (isGeneralBriefRecord(acknowledged)) {
    return refused(io, json, `record ${resolvedId} is the general seat brief; it is read by the seat's own turn-start reader, not acknowledged`);
  }
  if (acknowledged.session !== session) {
    return refused(io, json, `record ${resolvedId} is bound to session "${acknowledged.session}", not to "${session}"`);
  }
  if (!samePath(acknowledged.root, root)) {
    return refused(io, json, `record ${resolvedId} is bound to another checkout`);
  }

  const at = host.now().toISOString();
  const publish = () => publishRecordRead({
    dropDir: recordDir(root, session, found.seat),
    id: resolvedId,
    to: found.seat,
    root,
    session,
    home: host.home,
    key,
    at,
    lead: team.orchestrator,
  });
  let outcome: ReturnType<typeof publishRecordRead>;
  if (clientOrigin === null) {
    outcome = publish();
  } else {
    const bundleOrigin = clientOrigin;
    // The grant was active when the binding was read; a revocation appended while this call
    // waited must be seen in the section that writes, and must refuse, exactly as a reply's is.
    // A read receipt grants nothing, so the lock covers only the re-check and the write.
    let settled: { ok: true; outcome: ReturnType<typeof publishRecordRead> } | { ok: false; why: string };
    try {
      settled = withClientGrantLock(host.home, (): { ok: true; outcome: ReturnType<typeof publishRecordRead> } | { ok: false; why: string } => {
        const active = activeClientUpGrant(host.home, bundleOrigin, host.now());
        if (!active.ok) return { ok: false, why: `the originating grant ${bundleOrigin.grant.grantId} is not active: ${active.why}; nothing was written` };
        const fresh = resolveBundleSendTarget(host.home, active.grant, acknowledged.to);
        if (!fresh.ok) return { ok: false, why: `the bundle grant's recipient can no longer be resolved: ${fresh.why}; nothing was written` };
        if (
          !samePath(fresh.target.teamRoot, root) ||
          fresh.target.session !== session ||
          fresh.target.recipientSeat !== me ||
          acknowledged.to_id !== fresh.target.recipientId
        ) {
          return { ok: false, why: 'the bundle grant\'s recipient changed while this call waited; nothing was written' };
        }
        return { ok: true, outcome: publish() };
      });
    } catch (error) {
      return refused(io, json, error instanceof Error ? `${error.message}; nothing was written` : 'the client grant lock could not be taken; nothing was written');
    }
    if (!settled.ok) return refused(io, json, settled.why);
    outcome = settled.outcome;
  }
  if (outcome.kind === 'held') {
    const where = receiptPath(session, found.seat, resolvedId, outcome.status);
    const what = outcome.entry === 'file'
      ? `the ${outcome.status} receipt name is held by a file that does not verify for this message`
      : `the ${outcome.status} receipt path is held by something that is not a file`;
    return refused(
      io,
      json,
      `${resolvedId}: not marked read: ${what}`,
      `inspect ${where}: it is left as it is, because it may record a read that already happened`,
    );
  }
  if (outcome.kind === 'unwritten') {
    if (outcome.reason === 'changed') {
      return refused(io, json, `${resolvedId}: not marked read: the read receipt name changed while it was being published; run team ack again`);
    }
    if (outcome.reason === 'write') {
      return refused(io, json, `${resolvedId}: not marked read: the read receipt could not be written; run team ack again once the receipt folder can be written`);
    }
    return refused(io, json, `${resolvedId}: not marked read: the read receipt could not be made durable; leave it in place, it already records this read`);
  }

  const summary = `${resolvedId}: read`;
  return written(io, json, {
    format: 1,
    status: 'read',
    action_summary: summary,
    project: team.project,
    session,
    record: resolvedId,
    to: found.seat,
    thread: acknowledged.thread,
    written: outcome.kind === 'published',
    at,
  }, `${contextLine(team.project, session)}\n${summary}\n`);
}

/**
 * `team ack --seat <seat> --older-than <dur>`: the lead's sweep of one seat's folder. The admission
 * is the map's `archive` row — the owner or a seat this team marks `leads`, the same caller that
 * may move a family — so the ack and the archive that follows it refuse together. The window is
 * the newest file of the family, and nothing a reader would still serve is touched: the general
 * brief, a client's record, a pending handoff and a fresh family stay. A dry run plans and writes
 * nothing.
 */
async function runScopedAck(argv: string[], io: Io, host: AckHost, json: boolean): Promise<number> {
  const args = readArgs(argv, ['seat', 'older-than'], ['json', 'dry-run']);
  if (args.error) return usage(io, json, args.error);
  if (args.rest.length > 0) return usage(io, json, `unexpected "${args.rest[0]}"`);
  const seat = args.values.seat;
  const window = args.values['older-than'];
  if (seat === undefined) return usage(io, json, '--older-than needs --seat <seat>');
  if (window === undefined) return usage(io, json, '--seat needs --older-than <dur>');
  if (!recordNameOk(seat)) return usage(io, json, `"${seat}" is not a seat name`);
  const olderThanMs = parseDuration(window);
  if (olderThanMs === null) return usage(io, json, `"${window}" is not a duration; write 90m, 12h or 7d`);
  const dry = args.flags.has('dry-run');

  const loaded = readTeamConfig(io.cwd, { home: host.home });
  if (!loaded.ok) {
    // `team ack` takes no `--file`, so the shared no-repository sentence must not offer one.
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, json, withoutFileOffer(message) || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const session = team.session;
  // A retired seat is still a seat while its own folder remembers it: the clearance is exactly
  // what a lead needs after `team down` removed the name from the file. A running seat is not a
  // target at all; the gate below refuses it once the caller is admitted, so a seat that is not a
  // lead learns nothing about another seat's lifecycle from this call.
  const target = seatClearTargetStatus({ agents: dir, session, seat, seats: team.seats });
  if (target.kind === 'unknown') {
    return usage(io, json, `"${seat}" is not a seat of this team`);
  }
  if (target.kind === 'unreadable') {
    return configuration(io, json, `the team state cannot be read, so "${seat}" cannot be known to have stopped: ${target.reason}`);
  }
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, host.home, 'archive', at, host.now);
  const judged = judgeCallerIn(io, dir, team, verdictOf);
  if (verdictOf(judged.caller, standingOf(dir, judged.session, judged.caller)).kind !== 'ok') {
    raiseSecurityRefusal(team, root, host.home, dir, judged.caller, 'admission', seat, host.now());
    return scopedRefused(
      io,
      json,
      `only the owner or a seat this team marks \`leads\` acknowledges another seat's messages; this call is ${describeCaller(judged.caller)}`,
    );
  }
  if (target.kind === 'running') {
    return scopedRefused(io, json, `seat ${seat} is running; stop or retire ${seat} before clearing its messages`);
  }
  const keyState = messageKeyState(host.home);
  if (keyState.kind !== 'key') return scopedRefused(io, json, 'no message key; nothing was written');

  // The receipt is the lead's, not the seat's: its signed `read_by` names who cleared the mail,
  // and the history line beside it says the same. Neither ever reads as the seat's own read.
  // The archive gate admits the owner or a seat, so a lead's sweep always has a name here; the
  // last arm keeps a receipt truthful rather than inventing one if that ever changes.
  const actor = judged.caller.kind === 'owner'
    ? 'owner'
    : judged.caller.kind === 'seat'
      ? judged.caller.name
      : judged.caller.kind;
  const readBy = `${LEAD_ACK_PREFIX}${actor}`;
  const now = host.now();
  const scan = scanAckSeat({ root, session, seat, key: keyState.key, olderThanMs, now, lead: team.orchestrator });
  const notDue = scan.stays.length;
  const failures: string[] = [];
  let read = 0;
  const at = now.toISOString();
  if (!dry) {
    for (const due of scan.due) {
      const outcome = publishRecordRead({
        dropDir: recordDir(root, session, seat),
        id: due.id,
        to: seat,
        root,
        session,
        home: host.home,
        key: keyState.key,
        at,
        readBy,
        lead: team.orchestrator,
      });
      if (outcome.kind === 'published') {
        read += 1;
        // The line the feed reads says who cleared it, never `delivered (read)`: the seat did
        // not read its mail, and nothing may report that it did.
        appendHistory(team.project, root, host.home, {
          ts: at,
          from: due.from,
          to: seat,
          body: due.body,
          id: due.id,
          outcome: `cleared by ${actor}`,
          thread: due.thread,
        });
      } else if (outcome.kind === 'served') {
        read += 1;
      } else if (outcome.kind === 'held') {
        const what = outcome.entry === 'file'
          ? `the ${outcome.status} receipt name is held by a file that does not verify for this message`
          : `the ${outcome.status} receipt path is held by something that is not a file`;
        failures.push(`${due.id}: not marked read: ${what}`);
      } else {
        const why = outcome.reason === 'changed'
          ? 'the read receipt name changed while it was being published'
          : outcome.reason === 'write'
            ? 'the read receipt could not be written'
            : 'the read receipt could not be made durable';
        failures.push(`${due.id}: not marked read: ${why}`);
      }
    }
  } else {
    read = scan.due.length;
  }
  const counted = `${dry ? `would mark ${String(read)} read` : `${String(read)} marked read`}, ${String(scan.already)} already read, ${String(notDue)} not due`;
  const summary = `seat ${seat}, older than ${window}: ${counted}`;
  const line = `${contextLine(team.project, session)}\n${summary}\n`;
  const doc: Record<string, unknown> = {
    format: 1,
    status: dry ? 'would-read' : failures.length > 0 ? 'failed' : 'read',
    action_summary: summary,
    project: team.project,
    session,
    seat,
    older_than: window,
    dry_run: dry,
    read,
    already_read: scan.already,
    not_due: notDue,
    failed: failures.length,
    at,
  };
  if (failures.length > 0) return scopedFailed(io, json, doc, line, failures);
  return scopedDone(io, json, doc, line);
}
