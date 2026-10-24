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
// exposure that already happened — and the refusal says so. A message a client wrote is refused:
// its receipt lives in a client inbox this command does not serve.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import {
  callerOf,
  callerVerdict,
  describeCaller,
  detachedRefusal,
  judgeCallerIn,
  standingOf,
} from '../caller.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import type { Command, Io } from '../io.ts';
import { contextLine, hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { recordNameOk } from '../send/record.ts';
import { publishRecordRead } from '../send/read-receipt.ts';
import { messageKeyState } from '../store/keys.ts';
import {
  findRecord,
  legacyHolds,
  raiseSecurityRefusal,
  recordHits,
  samePath,
} from './reply.ts';
import { recordDir } from './messages.ts';

export const USAGE = `Usage: team ack <id> [--json]

Marks the message record <id> read, without printing it. The signed read
receipt is the same one team messages writes before it shows a body, so the
message stops waiting for this seat and the unread watch stops ringing it.
A message the caller answers with team reply is marked read by the answer.

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

/** The relative path of one record's receipt, as the caller reads it in a repair line. */
function receiptPath(session: string, seat: string, id: string, status: 'read' | 'replied'): string {
  return join('.agents', 'send-drops', session, seat, `${id}.${status}.json`);
}

export async function runAck(argv: string[], io: Io, host: AckHost): Promise<number> {
  // Raw argv, before the parser: `--nope --json` must still answer with the structured document.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['json']);
  if (args.error) return usage(io, json, args.error);
  const id = args.rest[0];
  if (id === undefined) return usage(io, json, '<id> is required');
  if (args.rest.length > 1) return usage(io, json, `unexpected "${args.rest[1]}"`);
  if (!recordNameOk(id)) return usage(io, json, `"${id}" is not a record id`);

  const caller = callerOf(io);
  const detached = detachedRefusal(caller, { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return refused(io, json, detached);
  if (caller.kind !== 'owner' && caller.kind !== 'seat') {
    return refused(io, json, `only the owner or a seat of this team acknowledges a message; this call is ${describeCaller(caller)}`);
  }

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
  const me = placed.kind === 'seat' ? placed.name : caller.kind === 'seat' ? caller.name : 'owner';
  if (caller.kind === 'seat' && (placed.kind !== 'seat' || callerVerdict(placed, me, standing).kind !== 'ok')) {
    raiseSecurityRefusal(team, root, host.home, dir, placed, 'placement', null, host.now());
    return refused(io, json, `seat ${me} is not this call on its own pane and session; this call is ${describeCaller(placed)}`);
  }

  // The id is looked up before the key is read: a name nothing holds needs no key to say so.
  const hits = recordHits(root, session, id);
  if (hits.length === 0) {
    if (legacyHolds(root, id)) {
      return refused(io, json, `the message ${id} was written by an earlier build; it is read with team messages, not acknowledged`);
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

  // A record a client wrote is addressed to a client, and its read receipt is the client inbox's:
  // this command serves only the seat folders of its own session.
  if (acknowledged.from_client !== undefined) {
    return refused(io, json, `record ${id} was written by a client; its read belongs to the client inbox, not to this command`);
  }
  // A general seat brief's read is bound to the seat's current claim, and its reader verifies the
  // receipt against that binding: a plain receipt here would hold the receipt name the seat's own
  // turn-start reader needs, so the brief would never be served. Read it there, not here.
  if (isGeneralBriefRecord(acknowledged)) {
    return refused(io, json, `record ${id} is the general seat brief; it is read by the seat's own turn-start reader, not acknowledged`);
  }
  if (acknowledged.session !== session) {
    return refused(io, json, `record ${id} is bound to session "${acknowledged.session}", not to "${session}"`);
  }
  if (!samePath(acknowledged.root, root)) {
    return refused(io, json, `record ${id} is bound to another checkout`);
  }

  const at = host.now().toISOString();
  const outcome = publishRecordRead({
    dropDir: recordDir(root, session, found.seat),
    id,
    to: found.seat,
    root,
    session,
    home: host.home,
    key,
    at,
  });
  if (outcome.kind === 'held') {
    const where = receiptPath(session, found.seat, id, outcome.status);
    const what = outcome.entry === 'file'
      ? `the ${outcome.status} receipt name is held by a file that does not verify for this message`
      : `the ${outcome.status} receipt path is held by something that is not a file`;
    return refused(
      io,
      json,
      `${id}: not marked read: ${what}`,
      `inspect ${where}: it is left as it is, because it may record a read that already happened`,
    );
  }
  if (outcome.kind === 'unwritten') {
    if (outcome.reason === 'changed') {
      return refused(io, json, `${id}: not marked read: the read receipt name changed while it was being published; run team ack again`);
    }
    if (outcome.reason === 'write') {
      return refused(io, json, `${id}: not marked read: the read receipt could not be written; run team ack again once the receipt folder can be written`);
    }
    return refused(io, json, `${id}: not marked read: the read receipt could not be made durable; leave it in place, it already records this read`);
  }

  const summary = `${id}: read`;
  return written(io, json, {
    format: 1,
    status: 'read',
    action_summary: summary,
    project: team.project,
    session,
    record: id,
    to: found.seat,
    thread: acknowledged.thread,
    written: outcome.kind === 'published',
    at,
  }, `${contextLine(team.project, session)}\n${summary}\n`);
}
