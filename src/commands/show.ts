// `team show <id>`: prints the full rendered body of one message record in the caller's own
// mailbox and marks it read with the same signed read receipt `team messages` and `team ack`
// publish (`src/send/read-receipt.ts`).
//
// When a seat opts into `compact_delivery: true`, its cross-session socket frame carries only the
// compact sender header, the first content line of the message body, and the footer:
//   `↩ team show <id> · team reply <id> · team ack <id>`
// Running `team show <id>` (by full id or unique >=8-character prefix) reads the verified record
// from the caller's own mailbox, publishes `<id>.read.json` before printing so the unread watch
// does not re-wake it, and prints the compact sender header, the full multi-line body, and the
// reply/ack footer:
//   `↩ team reply <id> "…" · team ack <id>`
// Re-running `team show <id>` on an already-read or already-replied record in the caller's own
// mailbox still prints the full message idempotently.
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
import type { Command, Io } from '../io.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { existingRecordIdsIn, readerLine, shortIdPrefix } from '../send/frame.ts';
import { publishRecordRead } from '../send/read-receipt.ts';
import { recordNameOk } from '../send/record.ts';
import { attributedBody } from '../send/sender-claim.ts';
import { messageKeyState } from '../store/keys.ts';
import { recordDir } from './messages.ts';
import {
  findRecord,
  legacyHolds,
  MIN_ID_PREFIX_LEN,
  raiseSecurityRefusal,
  recordHits,
  samePath,
} from './reply.ts';

export const USAGE = `Usage: team show <id> [--json]

Prints the full message record <id> (or a unique prefix of at least 8
characters) from the caller's own mailbox with its compact sender header and
reply/ack footer, and marks the message read with the same signed read receipt
\`team messages\` and \`team ack\` write. Re-running \`team show <id>\` on a message
that was already read or replied to in the caller's own mailbox still displays
it.

Exits 0 when the message is shown, 1 when the caller or the record is refused,
2 when the invocation or the team file can't be read.
`;

export type ShowHost = {
  home: string;
  now: () => Date;
};

export const realHost: ShowHost = { home: homedir(), now: () => new Date() };

const show: Command = (argv, io) => runShow(argv, io, realHost);
export default show;

/** One refusal on the record or the caller: `show.refused`, exit 1, always. */
function refused(io: Io, json: boolean, message: string, repair: string | null = null): number {
  refuse(io, json, 'show', { id: 'show.refused', message, repair });
  return 1; // exit: show.refused
}

/** A team file this run cannot read. Exit 2, always. */
function configuration(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'show', { id: 'show.configuration', message, repair: null });
  return 2; // exit: show.configuration
}

/** The invocation cannot be read. Exit 2, always. */
function usage(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'show', { id: 'show.usage', message, repair: null, usage: USAGE });
  return 2; // exit: show.usage
}

/** The one shown outcome: the `team.show` document under `--json`, the rendered message otherwise. */
function shownOut(io: Io, json: boolean, doc: Record<string, unknown>, text: string): number {
  if (json) writeJson(io, 'team.show', doc);
  else io.stdout(text);
  return 0; // exit: show.shown
}

/** The relative path of one record's receipt, as the caller reads it in a repair line. */
function receiptPath(session: string, seat: string, id: string, status: 'read' | 'replied'): string {
  return join('.agents', 'send-drops', session, seat, `${id}.${status}.json`);
}

export async function runShow(argv: string[], io: Io, host: ShowHost): Promise<number> {
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['json']);
  if (args.error) return usage(io, json, args.error);
  const id = args.rest[0];
  if (id === undefined) return usage(io, json, '<id> is required');
  if (args.rest.length > 1) return usage(io, json, `unexpected "${args.rest[1]}"`);
  if (!recordNameOk(id)) return usage(io, json, `"${id}" is not a record id`);

  const caller = callerOf(io);
  const detached = detachedRefusal(caller, {
    who: 'the owner or a seat of this team',
    where: 'a terminal outside herdr or its own pane',
  });
  if (detached !== undefined) return refused(io, json, detached);
  if (caller.kind !== 'owner' && caller.kind !== 'seat') {
    return refused(
      io,
      json,
      `only the owner or a seat of this team shows a message; this call is ${describeCaller(caller)}`,
    );
  }

  const loaded = readTeamConfig(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors
      .map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message))
      .join('; ');
    return configuration(io, json, withoutFileOffer(message) || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const session = team.session;
  const judged = judgeCallerIn(io, dir, team);
  const standing = standingOf(dir, judged.session, judged.caller);
  const placed = judged.caller;
  const me = placed.kind === 'seat' ? placed.name : caller.kind === 'seat' ? caller.name : 'owner';
  if (caller.kind === 'seat' && (placed.kind !== 'seat' || callerVerdict(placed, me, standing).kind !== 'ok')) {
    raiseSecurityRefusal(team, root, host.home, dir, placed, 'placement', null, host.now());
    return refused(
      io,
      json,
      `seat ${me} is not this call on its own pane and session; this call is ${describeCaller(placed)}`,
    );
  }

  const hits = recordHits(root, session, id);
  if (hits.length === 0) {
    if (legacyHolds(root, id)) {
      return refused(
        io,
        json,
        `the message ${id} was written by an earlier build; it is read with team messages, not shown with team show`,
      );
    }
    if (id.length < MIN_ID_PREFIX_LEN) {
      return refused(
        io,
        json,
        `record prefix "${id}" is shorter than ${String(MIN_ID_PREFIX_LEN)} characters; pass at least ${String(MIN_ID_PREFIX_LEN)} characters`,
      );
    }
    return refused(io, json, `no record named ${id} waits in this project's session "${session}"`);
  }

  const keyState = messageKeyState(host.home);
  if (keyState.kind !== 'key') return refused(io, json, 'no message key; nothing was read');
  const key = keyState.key;

  const lookup = findRecord(hits, root, session, id, me, key);
  if (lookup.kind === 'none') {
    return refused(io, json, `no record named ${id} waits in this project's session "${session}"`);
  }
  if (lookup.kind === 'legacy') {
    return refused(
      io,
      json,
      `the message ${id} was written by an earlier build; it is read with team messages, not shown with team show`,
    );
  }
  if (lookup.kind === 'refused') return refused(io, json, lookup.why);
  const found = lookup.found;
  const shown = found.record.payload;
  const resolvedId = shown.id;

  if (isGeneralBriefRecord(shown)) {
    return refused(
      io,
      json,
      `record ${resolvedId} is the general seat brief; it is read by the seat's own turn-start reader, not shown here`,
    );
  }
  if (shown.session !== session) {
    return refused(io, json, `record ${resolvedId} is bound to session "${shown.session}", not to "${session}"`);
  }
  if (!samePath(shown.root, root)) {
    return refused(io, json, `record ${resolvedId} is bound to another checkout`);
  }

  const dropDir = recordDir(root, session, found.seat);
  const at = host.now().toISOString();
  const outcome = publishRecordRead({
    dropDir,
    id: resolvedId,
    to: found.seat,
    root,
    session,
    home: host.home,
    key,
    at,
    lead: loaded.team.orchestrator,
  });
  if (outcome.kind === 'held') {
    const where = receiptPath(session, found.seat, resolvedId, outcome.status);
    const what =
      outcome.entry === 'file'
        ? `the ${outcome.status} receipt name is held by a file that does not verify for this message`
        : `the ${outcome.status} receipt path is held by something that is not a file`;
    return refused(
      io,
      json,
      `${resolvedId}: not shown: ${what}`,
      `inspect ${where}: it is left as it is, because it may record a read that already happened`,
    );
  }
  if (outcome.kind === 'unwritten') {
    if (outcome.reason === 'changed') {
      return refused(
        io,
        json,
        `${resolvedId}: not shown: the read receipt name changed while it was being published; run team show again`,
      );
    }
    if (outcome.reason === 'write') {
      return refused(
        io,
        json,
        `${resolvedId}: not shown: the read receipt could not be written; run team show again once the receipt folder can be written`,
      );
    }
    return refused(
      io,
      json,
      `${resolvedId}: not shown: the read receipt could not be made durable; leave it in place, it already records this read`,
    );
  }

  const existingIds = existingRecordIdsIn(dropDir);
  const prefix = shortIdPrefix(resolvedId, existingIds);
  const renderedBody = attributedBody(shown.body, shown.from, {
    record: shown,
    home: host.home,
    root,
    rule: shown.rule,
  }).replace(/\n+$/, '');
  const footer = readerLine(resolvedId, existingIds);
  const content = `${renderedBody}\n\n${footer}`;

  return shownOut(
    io,
    json,
    {
      format: 1,
      id: resolvedId,
      prefix,
      project: team.project,
      session,
      seat: found.seat,
      from: shown.from,
      from_id: shown.from_id,
      rule: shown.rule,
      at: shown.at,
      written: outcome.kind === 'published',
      content,
    },
    `${content}\n`,
  );
}
