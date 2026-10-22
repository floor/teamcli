// `team drops`: what is waiting in the calling seat's own drop folder.
//
// A drop is a message file another seat's `team send` wrote under
// `.agents/send-drops/<session>/<seat>/`, and the file is the message: nothing in this build
// deletes one. The receiving seat reads what is there with `team drops`, and a Claude Code
// Monitor reads each file as it lands with `team drops --follow`. A send of this version writes
// a signed record (`src/send/record.ts`) whose payload names the sender; a file a previous build
// wrote is still a drop, and its first line names the sender. A `<id>.read.json` receipt beside
// it — the sidecar the seat's inbox server writes when it hands the drop over, the same name the
// record spine gives a read receipt — means the drop was read, and it is not listed.
//
// `team drops --read` is the same folder, served to the launch's turn-start hook: the launch
// names the seat and session, the newest waiting records are verified and receipted through the
// inbox's own read (`readMessage`), and only then are their bodies printed. A file an earlier
// build wrote is plain text no key can verify: it is skipped and counted, never served, and the
// signed records around it are read as usual. The hook takes no placed caller.
import { type KeyObject } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../caller.ts';
import { loadTeamFile, NOT_A_REPO, withoutFileOffer } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { briefBindingOf, currentBriefClaim, GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../launch/general-brief.ts';
import { heldAt } from '../launch/rules-file.ts';
import { currentClaimIn, listUnread, readMessage, type BriefRead } from '../mcp/inbox.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readState } from '../state.ts';
import {
  contextLine,
  hasJsonFlag,
  pluralCount,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
} from '../output/index.ts';
import { namingFor, senderDisplayName, type SenderNaming } from '../send/names.ts';
import { isRead, signedRecordOf, verifyRecord, type StatusContext } from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

export const USAGE = `Usage: team drops [--follow] [--json]
       team drops --read --seat <seat> [--session <session>] [--epoch <run_id>]

Lists the drop files waiting in the calling seat's own drop folder,
.agents/send-drops/<session>/<seat>: one row each, with the sender the message
record names — or, in a file an earlier build wrote, its first line — and the
file's absolute path. A drop that has an <id>.read.json receipt beside it
is read, and is not listed.

Options:
  --follow   print one line per drop file that appears while it runs,
             \`from <sender> — <path>\`, each line as it lands; Ctrl-C stops it
             with exit 0. Drops already on disk when it starts are not printed.
  --json     one team.drops document ({format, project, session, seat, drops, counts});
             it and --follow can't be used together
  --read     hand the seat's waiting messages to a turn: each record is
             verified with the message key, its signed <id>.read.json receipt
             is written before its body is printed, and at most ten bodies are
             read a run, newest first. A plain-text file an earlier build wrote
             is not a signed record: it is skipped and counted, never served,
             and the records around it are still read. A signed record an
             earlier build wrote under an \`unread-<uuid>\` runtime-report name is
             served and receipted like any other record. The seat and session are
             the launch's, as with \`team mcp serve\`: --seat is required and
             --session, when given, must be the team file's. A record the
             launch wrote is served only as the seat's current general brief;
             an earlier delivery is skipped, never shown. The launch's
             turn-start hook runs this, so it takes no placed caller.
  --seat     the seat whose folder --read serves
  --session  the launch's session, which must be the team file's own
  --epoch    the runtime epoch the launch started this reader under; when
             given, only a brief delivered under that epoch is served

Exits 0 when the folder is read, 1 when the caller is not a placed seat of this
team, the team file can't be read, or the drop folder can't be read or a
waiting message cannot be read, 2 when the invocation can't be read or this
folder is neither a checkout nor a team root.
`;

/** One waiting drop: its file name (the send's id), the sender the message record names (or, in
 *  a file an earlier build wrote, its first line), when the file landed, and its absolute path.
 *  `from` is null when there is no sender to read: the file is still a drop, and its sender is
 *  simply unknown. */
export type DropRow = {
  id: string;
  from: string | null;
  /** The sender's registry id when the drop is a signed record; the table resolves it to the
   *  project's readable name. A raw drop has no id, and its first line is already a headline. */
  from_id: string | null;
  received: string;
  path: string;
};

export type DropsSources = {
  home: string;
  /**
   * Called between `--follow` polls. Returns `true` to perform another read pass,
   * or `false` to stop following and exit 0.
   */
  poll?: (tick: number) => Promise<boolean>;
};

function defaultPoll(): Promise<boolean> {
  return new Promise((resolvePoll) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      clearTimeout(timer);
      resolvePoll(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolvePoll(true);
    }, 250);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export const realSources: DropsSources = { home: homedir(), poll: () => defaultPoll() };

/** How many bodies one `--read` hands over. The newest are read first: a bounded batch keeps a
 *  turn from carrying an unbounded folder, and the newest mail is the mail the turn is for.
 *  Whatever is left waits for the next turn. A plain-text drop an earlier build wrote, a record
 *  that is otherwise malformed, or an earlier delivery of the general seat brief is not a body
 *  and does not use one of the ten. */
export const DROP_READ_BATCH = 10;

/** Whether every step down to the seat's drop folder is a real folder of this user's. A step
 *  that is missing is no fault — no send has written yet, and the read is empty; anything else
 *  at a step (a link, a file) refuses the read rather than reading through it. */
function dropFolderReadable(dir: string, session: string, seat: string): boolean {
  const ours = (held: { uid: number }): boolean => process.getuid === undefined || held.uid === process.getuid();
  const agents = heldAt(dir);
  if (agents.kind !== 'folder' || !ours(agents)) return false;
  let at = dir;
  for (const part of ['send-drops', session, seat]) {
    at = join(at, part);
    const held = heldAt(at);
    if (held.kind === 'missing') return true;
    if (held.kind !== 'folder' || !ours(held)) return false;
  }
  return true;
}

export const drops: Command = (argv, io) => runDrops(argv, io, realSources);
export default drops;

const ADMITTED = ' — admitted by: ';

/**
 * The sender a drop's first line names, in the forms `team send` writes (`senderHeader`):
 * `the owner`, `the file's seat <name> (no registry record yet)`, or the sender's readable name —
 * the project's `sender_name` word decides it, and the registry id stays in the record — each
 * followed by ` — admitted by: <rule>`. A drop an older build wrote can still name the agent as
 * `<agent id> (<name>, <seat>@<team>)`, and that form is read too. A line in no known form is
 * read as whatever stands between `from ` and the admission, and an empty one is null.
 */
export function senderOf(header: string): string | null {
  if (!header.startsWith('from ')) return null;
  const cut = header.indexOf(ADMITTED);
  const lead = (cut === -1 ? header : header.slice(0, cut)).slice('from '.length).trim();
  if (lead === 'the owner') return 'the owner';
  const fileSeat = /^the file's seat (\S+) \(no registry record yet\)$/.exec(lead);
  if (fileSeat) return fileSeat[1] ?? null;
  const registered = /^\S+ \((.+), [^,()]+@[^()]+\)$/.exec(lead);
  if (registered) return registered[1] ?? null;
  return lead === '' ? null : lead;
}

/** The file's text as JSON, or undefined when it is not JSON at all (an older raw drop). */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether the file at `path` is a drop an earlier build wrote: plain text, not JSON at all. This
 * version can never serve one — it is unsigned, and nothing in it can be verified — so `--read`
 * skips it and counts it, and the signed records around it are still read. Only a regular file of
 * this user's is read: a link, a FIFO or another user's file is not classified here and keeps the
 * refusal the record reader gave it.
 */
function legacyDropAt(path: string): boolean {
  const held = heldAt(path);
  if (held.kind !== 'file' || (process.getuid !== undefined && held.uid !== process.getuid())) return false;
  try {
    return parsedJson(readFileSync(path, 'utf8')) === undefined;
  } catch {
    return false;
  }
}

export type DropListing = { kind: 'ok'; rows: DropRow[] } | { kind: 'unreadable'; reason: string };

/**
 * The unread drops in one seat's folder, oldest first. A name with a dot in it is a sidecar
 * (`<id>.pending`, `<id>.taken`, `<id>.<hex>.tmp`, `<id>.read.json`), never a drop; a symlink or a
 * directory whose name is plain is not a drop either. A drop is read only when the receipt beside
 * it is the signed status receipt the inbox and `team messages` write and the receipt module
 * verifies — a file at that name that was not signed by the message key leaves the drop waiting.
 * Without a key and context nothing can be proven, so every drop is listed. A folder that does not
 * exist is an empty one: no send has written here yet. With a context, a listing omits a delivery
 * of the general seat brief that cannot be served: the current claim's superseded ids are skipped
 * by name, and a launch record whose digest or incarnation is not the claim's is not shown — an
 * earlier brief is not waiting mail. A receipt at the current claim's own id counts only when it
 * binds that claim, so a read of another delivery never hides the delivery the claim names.
 */
export function listDrops(dropDir: string, key?: KeyObject, context?: StatusContext): DropListing {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'ok', rows: [] };
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const rows: DropRow[] = [];
  // The claim this listing serves under. Without a context there is none, and every drop is
  // listed — the same "nothing can be proven" rule the receipt read follows above.
  const claim = context === undefined ? null : currentClaimIn(context.root, context.session, context.to);
  const superseded = new Set(claim?.superseded ?? []);
  for (const name of names) {
    if (name.includes('.')) continue;
    if (superseded.has(name)) continue;
    const path = join(dropDir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // A verified read receipt means the drop was handed over: it is read, and this reading is
    // done with it. The receipt is the signed `<id>.read.json` the inbox and `team messages` write;
    // a file there that the message key did not sign proves nothing and leaves the drop waiting.
    // At the current claim's id the receipt must bind that claim too: a read of an earlier
    // delivery does not count for this one.
    const binding = claim !== null && name === claim.id ? briefBindingOf(claim) : undefined;
    if (key !== undefined && context !== undefined && isRead(dropDir, name, context, key, binding)) continue;
    let from: string | null = null;
    let fromId: string | null = null;
    let launch: { sha256: string | undefined; incarnation: string | undefined } | null = null;
    try {
      const text = readFileSync(path, 'utf8');
      const record = signedRecordOf(parsedJson(text));
      if (record !== null) {
        // The record names its sender in the payload. The key that verified it is the message
        // key; when the folder is read with no key at all, the payload is still what is shown —
        // a record that fails the key it was checked with leaves the sender unknown.
        if (key === undefined || verifyRecord(record, key)) {
          from = record.payload.from;
          fromId = record.payload.from_id;
          if (record.payload.from === GENERAL_BRIEF_FROM && record.payload.rule === GENERAL_BRIEF_RULE) {
            launch = { sha256: record.payload.brief_sha256, incarnation: record.payload.incarnation };
          }
        }
      } else {
        from = senderOf(text.split('\n', 1)[0] ?? '');
      }
    } catch {
      // The file is still a drop; its sender is unknown.
    }
    // A launch record the current claim does not name cannot be served: it is an earlier
    // delivery, or an old build's record carrying none of the fields a claim binds.
    if (key !== undefined && context !== undefined && launch !== null
      && (claim === null || launch.sha256 !== claim.sha256 || launch.incarnation !== claim.incarnation)) {
      continue;
    }
    rows.push({ id: name, from, from_id: fromId, received: stat.mtime.toISOString(), path });
  }
  return {
    kind: 'ok',
    rows: rows.sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id)),
  };
}

/** The row's sender as the project's `sender_name` asks for. A record's `from` is the seat, and
 *  its registry id lets the name resolve; a raw drop's first line is already a headline. */
function readableFrom(row: DropRow, naming: SenderNaming): string | null {
  return row.from === null ? null : senderDisplayName({ seat: row.from, id: row.from_id }, naming);
}

/** `from <sender> — <path>`, the one line `--follow` prints per new drop. */
function followLine(row: DropRow, naming: SenderNaming): string {
  return `from ${readableFrom(row, naming) ?? 'unknown'} — ${row.path}\n`;
}

/** The folder was read: the listing printed, or the turn's records were handed over. One exit,
 *  `drops.ok`, whether the caller was a placed seat or the launch's own read. */
function readOk(): number {
  // exit: drops.ok
  return 0;
}

/** The refusal every caller that is not a placed seat of this team gets. */
function refuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'drops.refused', message, null);
  else io.stderr(`team drops: ${message}\n`);
  // exit: drops.refused
  return 1;
}

/**
 * Reads the caller's own drop folder: the caller must be a seat of this team on the pane the
 * state records for it, and the folder is the one its messages land in. `--json` prints the
 * listing as one document; `--follow` prints each file that appears while it runs, and never
 * the ones already there, so a Monitor starts quiet.
 */
export async function runDrops(argv: string[], io: Io, sources: DropsSources = realSources): Promise<number> {
  const args = readArgs(argv, ['seat', 'session', 'epoch'], ['follow', 'json', 'read']);
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  const follow = args.flags.has('follow');
  const read = args.flags.has('read');
  // A launch option names a seat without the reading that serves one: no `--read` uses it, so it
  // is an invocation error rather than a silent no-op.
  const stray = !read && args.values.seat !== undefined
    ? 'seat'
    : !read && args.values.session !== undefined
      ? 'session'
      : !read && args.values.epoch !== undefined ? 'epoch' : null;
  const epoch = args.values.epoch;
  const badEpoch = read && epoch !== undefined && !isBriefEpoch(epoch);
  if (args.error || args.rest.length || (follow && json) || (read && (follow || json || args.values.seat === undefined)) || stray !== null || badEpoch) {
    const problem = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0] ?? ''}"`
        : stray !== null ? `unknown option --${stray}`
          : badEpoch ? `--epoch ${JSON.stringify(epoch)} is not a runtime epoch`
            : read
              ? (follow ? '--read and --follow cannot be used together'
                : json ? '--read and --json cannot be used together'
                  : '--read needs --seat <seat>')
              : "--follow and --json can't be used together");
    if (json) {
      writeJsonError(io, 'drops.invocation', problem, null);
    } else {
      io.stderr(`team drops: ${problem}\n${USAGE}`);
    }
    // exit: drops.invocation
    return 2;
  }
  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team drops` takes no
  // `--file`, so the shared sentence must not offer one — and any other unreadable file keeps its
  // own exit.
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors[0]?.message ?? "the team file can't be read";
    if (message.startsWith(NOT_A_REPO)) {
      const shown = withoutFileOffer(message);
      if (json) {
        writeJsonError(io, 'drops.not-a-repo', shown, null);
      } else {
        io.stderr(`team drops: ${shown}\n`);
      }
      // exit: drops.not-a-repo
      return 2;
    }
    if (json) {
      writeJsonError(io, 'drops.file', message, null);
    } else {
      io.stderr(`team drops: ${message}\n`);
    }
    // exit: drops.file
    return 1;
  }
  const dir = dirname(loaded.path);
  const session = loaded.team.session;
  if (read) {
    // A launch's own invocation, as `team mcp serve` is: the seat and session are the launch
    // line's, never a tool argument's, and the read serves exactly one folder. No placed caller
    // is asked for — a CLI's turn-start hook runs outside any pane.
    const readSession = args.values.session ?? session;
    if (readSession !== session) {
      return refuse(io, json, `the team's session is ${JSON.stringify(session)}, not ${JSON.stringify(readSession)}`);
    }
    const seatName = args.values.seat as string;
    if (!loaded.team.seats.some((one) => one.name === seatName)) {
      return refuse(io, json, `the team file declares no seat ${JSON.stringify(seatName)}`);
    }
    if (!dropFolderReadable(dir, readSession, seatName)) {
      return refuse(io, json, 'the drop folder is not a real folder: a link or a file stands in its path');
    }
    const dropDir = join(dir, 'send-drops', readSession, seatName);
    const context: StatusContext = { to: seatName, root: loaded.root, session: readSession };
    // The launch's own brief is served under the claim the seat's state holds now. A reader the
    // launch started under an epoch serves only a brief delivered under that same runtime; a
    // manual read has none and binds the claim it serves.
    const claimOf = () => {
      try {
        return currentBriefClaim(readState(dir).sessions[readSession]?.briefs?.[seatName]);
      } catch {
        return null;
      }
    };
    const brief: BriefRead = { claim: claimOf, ...(epoch === undefined ? {} : { epoch }) };
    const waiting = listUnread(dropDir, context, sources.home);
    const bodies: string[] = [];
    let superseded = 0;
    let legacy = 0;
    let refusal: string | null = null;
    // Newest first: the turn reads what has just landed, and the tail of a backlog waits for the
    // next turn. A file that is not a signed record never uses one of the ten: a plain-text drop
    // an earlier build wrote is counted and skipped, and the signed records around it are read.
    for (const message of [...waiting].reverse()) {
      if (bodies.length >= DROP_READ_BATCH) break;
      const got = readMessage({ dropDir, root: loaded.root, seat: seatName, session: readSession }, message.id, sources.home, brief);
      if (got.ok) {
        bodies.push(got.body);
      } else if (got.served !== undefined) {
        // Another reader won the receipt name and served this message: there is no body for this
        // run. It is not a refusal and does not use one of the ten; the message has left the
        // unread list.
      } else if (got.superseded === true) {
        // An earlier delivery of the general seat brief: not a body, not a refusal, and it does
        // not use one of the ten this run hands over.
        superseded += 1;
      } else if (got.refusal !== undefined && got.refusal.rule === 'shape' && legacyDropAt(got.refusal.path)) {
        // A drop an earlier build wrote is plain text no key can verify. Refusing the turn over
        // old mail would wedge the hook, and serving it would accept an unsigned body: it is
        // skipped, counted, and reported once below — never shown, never receipted.
        legacy += 1;
      } else {
        if (got.refusal !== undefined) {
          // The owner hears the rule and the object — the record's id, its seat and its path —
          // and never the record's content.
          raiseRefusalEvent({
            project: loaded.team.project,
            root: loaded.root,
            home: sources.home,
            session: readSession,
            kind: 'record.invalid',
            rule: got.refusal.rule,
            object: { id: got.refusal.id, seat: got.refusal.seat, path: got.refusal.path },
          });
        }
        refusal ??= got.reason;
      }
    }
    if (bodies.length > 0) io.stdout(`${bodies.join('\n\n')}\n`);
    if (legacy > 0) {
      // Old drops are reported by count: a file no key can verify is never served, and its
      // content never reaches the turn.
      io.stderr(`team drops: ${String(legacy)} drop(s) are not signed records and are not served\n`);
    }
    if (bodies.length === 0 && refusal !== null) {
      // A message is waiting and none could be verified and receipted: the read leaves no
      // unproven body behind, and says why. With at least one body printed the run served the
      // turn; the rest wait for the next. The refusal is the folder's own: the same exit the
      // listing answers with, marked once by `refuse`.
      return refuse(io, json, refusal);
    }
    if (bodies.length === 0 && superseded > 0) {
      // Nothing this run can serve: every waiting launch record is an earlier delivery. The read
      // is done with them, and a turn that ran the hook should not look like one with mail.
      io.stderr(`team drops: ${String(superseded)} drop(s) carry an earlier general seat brief and are not served\n`);
    }
    return readOk();
  }
  const { caller, shown } = judgeCallerOf(io, session);
  const named = caller.kind === 'seat' && loaded.team.seats.some((seat) => seat.name === caller.name) ? caller : null;
  if (named === null) {
    return refuse(io, json, `only a seat of this team reads its own drops; this call is ${describeCaller(shown)}`);
  }
  const verdict = callerVerdict(named, named.name, standingOf(dir, session, named));
  if (verdict.kind === 'no-pane') return refuse(io, json, noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse(io, json, anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse(io, json, `only a seat of this team reads its own drops; this call is ${describeCaller(shown)}`);
  }
  const seat = named.name;
  const dropDir = join(dir, 'send-drops', session, seat);
  const keyState = messageKeyState(sources.home);
  const key = keyState.kind === 'key' ? keyState.key : undefined;
  const context: StatusContext = { to: seat, root: loaded.root, session };
  // The FROM column and `--follow`'s line carry the project's readable sender name; `--json`
  // keeps each row's own `from`.
  const naming = namingFor({ home: sources.home, root: loaded.root, viewerTeam: teamIdOf(loaded.root), seat, file: loaded.team });
  const first = listDrops(dropDir, key, context);
  let unreadable: string | null = first.kind === 'unreadable' ? first.reason : null;
  const rows = first.kind === 'ok' ? first.rows : [];
  if (follow) {
    const poll = sources.poll ?? (() => defaultPoll());
    // The drops already there are waiting, not new: a Monitor starts quiet and prints only what
    // lands while it runs.
    const seen = new Set(rows.map((row) => row.id));
    let tick = 0;
    while (await poll(tick++)) {
      const next = listDrops(dropDir, key, context);
      if (next.kind === 'unreadable') {
        unreadable = next.reason;
        break;
      }
      for (const row of next.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        io.stdout(followLine(row, naming));
      }
    }
  }
  if (unreadable !== null) {
    const message = `the drop folder can't be read: ${unreadable}`;
    if (json) {
      writeJsonError(io, 'drops.unreadable', message, null);
    } else {
      io.stderr(`team drops: ${message}\n`);
    }
    // exit: drops.unreadable
    return 1;
  }
  if (!follow) {
    if (json) {
      writeJson(io, 'team.drops', {
        format: 1 as const,
        project: loaded.team.project,
        session,
        seat,
        drops: rows.map((row) => ({ from: row.from, received: row.received, path: row.path })),
        counts: { drops: rows.length },
      });
    } else {
      const lines = [
        contextLine(loaded.team.project, session),
        ...renderTable({
          headers: ['FROM', 'PATH'],
          rows: rows.map((row) => [readableFrom(row, naming) ?? 'unknown', row.path]),
          indent: '  ',
          style: ttyStyle(io),
        }),
        '',
        pluralCount(rows.length, 'drop'),
      ];
      io.stdout(`${lines.join('\n')}\n`);
    }
  }
  return readOk();
}
