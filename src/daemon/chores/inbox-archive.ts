// The daemon's daily inbox archive: `team drops archive`'s moves, run by the chores child that
// hosts the root, once a day, off-peak, bounded per pass and never under load.
//
// What moves is what the command moves (acknowledged mail at once, read mail once its receipt
// is two days old), plus one rule the command does not have: mail still unread fourteen days
// after it was sent, to a seat that is stopped or retired, moves to that seat's
// `archive/<YYYY-MM>/unread/`. A running seat's unread mail is never moved, and nothing is ever
// deleted. A lookup by id still finds a moved message, and `team drops archive --unread` lists
// what was moved unread. The daemon does not mark pre-channel drops read: that is the command's
// alone, since it speaks for a seat's reading.
//
// The run belongs to the machine's local night: it starts on the first housekeeping pass inside
// the window and goes on, a bounded number of families a pass, until a pass finds nothing more.
// A pass while the load per core is above the limit does nothing and tries again on the next.
// When the day's run ends having moved anything, the team's lead gets one line saying so.
// The day, the totals and the line's state live in `<root>/.agents/send-drops/.drops-archive-run.json`.
import { createHash, randomUUID } from 'node:crypto';
import { RUNTIME_FROM, writeRuntimeNotice } from '../../send/endpoint-notice.ts';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../../file/types.ts';
import { logLine } from '../../log.ts';
import { readAgentsComplete, type Agent } from '../../registry/agents.ts';
import { teamIdOf } from '../../registry/teams.ts';
import { INBOX_ARCHIVE_RUN_FILE } from '../../send/drop-retention.ts';
import { archiveSeatInbox, listArchivedUnread, listRecoveryWork, listSeatFamilies, recoverItems, seatDropFolders } from '../../send/inbox-retention.ts';
import { isStampedPayload, readRecord, recordFile, sameFolder, stampedSettled, verifyRecord, type RecordPayload } from '../../send/record.ts';
import { DROP_ARCHIVE_UNREAD, DROP_MONTH_ARCHIVE } from '../../send/drop-folder.ts';
import { createExclusive, removeDurable } from '../../queue/durable.ts';
import { messageKeyOf, signDomain, verifyDomain, type Json } from '../../store/keys.ts';
import { readdirSync, readFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { archiveLegacySeat, legacySeatFolders } from '../../send/legacy-inbox-retention.ts';
import { heldAt } from '../../held.ts';
import type { StatusContext } from '../../send/record.ts';
import { readParsed, writeAtomic } from '../../state.ts';
import { messageKeyState } from '../../store/keys.ts';

/** The local hours the run may start or go on in: from 03:00 up to 06:00, machine time. */
export const INBOX_ARCHIVE_WINDOW = { fromHour: 3, toHour: 6 } as const;
/** The most families one pass moves, across all seats of the root. */
export const INBOX_ARCHIVE_PASS_LIMIT = 256;
/** A pass is skipped while the one-minute load per core is above this. */
export const INBOX_ARCHIVE_MAX_LOAD_PER_CORE = 3;
/** Unread mail to a stopped or retired seat moves once it is older than this. */
export const STOPPED_UNREAD_KEEP_MS = 14 * 86_400_000;
/** The most families one call looks at before the child's loop gets a turn. */
export const INBOX_ARCHIVE_SCAN_CHUNK = 64;
/** The most families one pass looks at, across all seats. */
export const INBOX_ARCHIVE_SCAN_PER_PASS = 2_048;
/** How many times the lead's line is tried in one day before it is left. */
const NOTICE_TRIES = 3;


export type InboxArchiveRun = {
  format: 1;
  /** The local day the run belongs to, YYYY-MM-DD. */
  day: string;
  done: boolean;
  /** Read or acknowledged families moved today. */
  moved: number;
  /** Unread families moved today, by seat. */
  unread: Record<string, number>;
  /** Passes skipped for load today. */
  loadSkips: number;
  /** Where each seat folder's look stopped, `<session>/<seat>` to the last id looked at. */
  cursor: Record<string, string>;
  /** The seat folders (`<session>/<seat>`) whose part-way moves were finished today. */
  recovered: string[];
  /** Where each seat folder's recovery stopped: the key of the last unit looked at. */
  recoverCursor: Record<string, string>;
  /** The seat folders (`<session>/<seat>`) fully looked at today. */
  completed: string[];
  /** The lead's line: its one id, whether it went, and how often it was tried. */
  notice?: { id: string; sent: boolean; tries: number };
};

export type InboxArchiveDeps = {
  /** One-minute load per core. */
  loadPerCore?: () => number;
  /** Sends the lead's line. Absent: the line is not sent and the state says so. */
  notify?: (input: { root: string; session: string; lead: string; body: string; id: string }) => Promise<{ ok: boolean; text: string }>;
  /** Gives the caller's loop a turn after a recovery chunk or a planning chunk. False ends the
   *  pass. */
  yieldTurn?: (after: 'recovery' | 'chunk') => Promise<boolean>;
};

export type InboxArchivePass =
  | { kind: 'outside' | 'done' | 'no-key' | 'unsafe' }
  | { kind: 'load'; perCore: number; first: boolean }
  | { kind: 'ran'; moved: number; unread: number; done: boolean; refused: string[]; notice: 'sent' | 'failed' | 'none' };

function localDay(now: Date): string {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function inWindow(now: Date): boolean {
  const hour = now.getHours();
  return hour >= INBOX_ARCHIVE_WINDOW.fromHour && hour < INBOX_ARCHIVE_WINDOW.toHour;
}

function runPath(root: string): string {
  return join(root, '.agents', 'send-drops', INBOX_ARCHIVE_RUN_FILE);
}

/** Whether `.agents` and `send-drops` are plain folders and the run file, when there, a plain
 *  file: the run file is read and written only then, never through a link. */
function runPlaceOk(root: string): boolean {
  if (heldAt(join(root, '.agents')).kind !== 'folder') return false;
  if (heldAt(join(root, '.agents', 'send-drops')).kind !== 'folder') return false;
  const held = heldAt(runPath(root)).kind;
  return held === 'file' || held === 'missing';
}

function readRun(root: string): InboxArchiveRun | null {
  if (heldAt(runPath(root)).kind !== 'file') return null;
  try {
    return readParsed(runPath(root), (text) => {
      const value = JSON.parse(text) as Partial<InboxArchiveRun> | null;
      if (value === null || typeof value !== 'object' || value.format !== 1 || typeof value.day !== 'string') return null;
      return {
        format: 1,
        day: value.day,
        done: value.done === true,
        moved: typeof value.moved === 'number' ? value.moved : 0,
        unread: value.unread !== null && typeof value.unread === 'object' ? value.unread : {},
        loadSkips: typeof value.loadSkips === 'number' ? value.loadSkips : 0,
        cursor: value.cursor !== null && typeof value.cursor === 'object' ? value.cursor : {},
        completed: Array.isArray(value.completed) ? value.completed.filter((entry): entry is string => typeof entry === 'string') : [],
        recoverCursor: value.recoverCursor !== null && typeof value.recoverCursor === 'object' ? value.recoverCursor : {},
        recovered: Array.isArray(value.recovered) ? value.recovered.filter((entry): entry is string => typeof entry === 'string') : [],
        ...(value.notice !== undefined ? { notice: value.notice } : {}),
      };
    });
  } catch {
    return null;
  }
}

/** Whether the run file now holds `run`. A file that cannot be written leaves the day's totals
 *  unsaved; the moves stand, and no line to the lead goes out on an unsaved state. */
function writeRun(root: string, run: InboxArchiveRun): boolean {
  if (!runPlaceOk(root)) return false;
  try {
    writeAtomic(runPath(root), `${JSON.stringify(run, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `seat`'s folder in `session` belongs to a seat at rest: stopped or retired, never
 * running. `agents` is the whole registry, read completely; the caller moves no unread mail when
 * it could not be. Names are compared without case, since a folder on a case-insensitive disk
 * serves every spelling. A seat any registry record of this team names as running or registered,
 * in any session, is not at rest; nor is a seat the team file marks as a person's, or `owner`.
 * A seat the current session declares is at rest only when every declaration marks it stopped or
 * the registry records it stopped in this session. A folder no declaration names (a seat that was
 * removed, or a session that was renamed) is retired.
 */
export function seatAtRest(agents: readonly Agent[], teamId: string, team: TeamFile, session: string, seat: string): boolean {
  const name = seat.toLowerCase();
  const inSession = session.toLowerCase() === team.session.toLowerCase();
  if (name === 'owner') return false;
  const declaredAny = team.seats.filter((entry) => entry.name.toLowerCase() === name);
  if (declaredAny.some((entry) => entry.human === true)) return false;
  const records = agents.filter((agent) => agent.reach.team === teamId && agent.reach.seat.toLowerCase() === name);
  if (records.some((agent) => agent.lifecycle === 'running' || agent.lifecycle === 'registered')) return false;
  if (!inSession || declaredAny.length === 0) return true;
  return declaredAny.every((entry) => entry.stopped)
    || records.some((agent) => agent.reach.session.toLowerCase() === session.toLowerCase() && agent.lifecycle === 'stopped');
}

/** Whether the seat is retired or removed (E7b decision 4): the team file no longer declares it and
 *  no registry record for it is running, registered or stopped. A stopped seat is not retired. */
export function seatRetired(agents: readonly Agent[], teamId: string, team: TeamFile, seat: string): boolean {
  const name = seat.toLowerCase();
  if (name === 'owner') return false;
  if (team.seats.some((entry) => entry.name.toLowerCase() === name)) return false;
  return !agents.some((agent) => agent.reach.team === teamId && agent.reach.seat.toLowerCase() === name
    && (agent.lifecycle === 'running' || agent.lifecycle === 'registered' || agent.lifecycle === 'stopped'));
}

/**
 * The sender's not-delivered notice for one unacknowledged stamped record about to leave a retired
 * seat's live folder (E7b decision 4), written before the move. The notice goes to the sender's
 * current route, resolved from its signed agent id (a seat name alone may now be another
 * occupant's); otherwise to the lead of the archived seat's session, naming the sender. It names
 * the message exactly (`in_reply_to`) and carries a stable id, so a notice already standing is
 * found and accepted only when it verifies as this obligation's own: the checkout's runtime record
 * to that recipient, in that session and root, answering this message. True when such a notice
 * stands; false leaves the record in place for the next pass.
 */
export function noticeBeforeMove(input: {
  home: string; root: string; session: string; seat: string; team: TeamFile; key: KeyObject; at: string;
  item: { id: string; undelivered?: { from: string; from_id: string | null } };
  agents?: readonly Agent[]; teamId?: string;
}): boolean {
  const from = input.item.undelivered?.from ?? 'unknown';
  const fromId = input.item.undelivered?.from_id ?? null;
  const agent = fromId === null || input.agents === undefined
    ? undefined
    : input.agents.find((one) => one.id === fromId && one.reach.team === input.teamId && one.lifecycle !== 'retired');
  const to = agent !== undefined ? agent.reach.seat : input.team.orchestrator;
  const session = agent !== undefined ? agent.reach.session : input.session;
  if (to === undefined || to === null || to === '') return false;
  const noticeId = undeliveredNoticeId(input.item.id);
  const notice = writeRuntimeNotice({
    home: input.home, root: input.root, session, lead: to, id: noticeId, inReplyTo: input.item.id,
    body: `not delivered: seat retired (${input.seat}). The message ${input.item.id} from ${from} was never acknowledged and is archived; list it with \`team drops archive --unread\`.`,
    at: input.at,
  });
  if (!notice.ok) return false;
  const found = notice.payload;
  return found.id === noticeId && found.to === to && found.session === session && sameFolder(found.root, input.root)
    && found.from === RUNTIME_FROM && found.in_reply_to === input.item.id;
}

/** A stable, UUID-shaped id for one message's not-delivered notice. */
export function undeliveredNoticeId(id: string): string {
  const hex = createHash('sha256').update(`not-delivered\n${id}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Whether send-drops, the session folder and the seat folder are each a plain folder, not a
 *  link: checked before the folder is used and again after every turn the loop gave away. */
function folderChainOk(root: string, session: string, seat: string): boolean {
  const base = join(root, '.agents', 'send-drops');
  for (const path of [join(root, '.agents'), base, join(base, session), join(base, session, seat)]) {
    if (heldAt(path).kind !== 'folder') return false;
  }
  return true;
}

function noticeBody(run: InboxArchiveRun): string {
  const unreadSeats = Object.entries(run.unread).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b));
  const unreadTotal = unreadSeats.reduce((sum, [, count]) => sum + count, 0);
  const parts = [`drops archive (daily, ${run.day}): moved ${String(run.moved)} read or acknowledged message(s) into archive/<YYYY-MM>/`];
  if (unreadTotal > 0) {
    parts.push(
      `and ${String(unreadTotal)} message(s) unread for over 14 days to stopped or retired seats into archive/<YYYY-MM>/unread/ (${unreadSeats.map(([seat, count]) => `${seat} ${String(count)}`).join(', ')}); list them with \`team drops archive --unread\``,
    );
  }
  return `${parts.join(' ')}. Nothing was deleted.`;
}

/**
 * One housekeeping pass of the daily run for `root`. It does nothing outside the window, after
 * the day's run is done, or while the load per core is above the limit.
 */
export async function inboxArchivePass(input: {
  root: string;
  home: string;
  team: TeamFile;
  now: Date;
  limit?: number;
  scanLimit?: number;
  deps?: InboxArchiveDeps;
}): Promise<InboxArchivePass> {
  const { root, home, team, now } = input;
  const deps = input.deps ?? {};
  const day = localDay(now);
  // A run file whose place is not plain folders, or is itself not a plain file, stops the run:
  // without it the day's state cannot be kept, and nothing moves on an unkept state.
  if (!runPlaceOk(root)) return { kind: 'unsafe' };
  const held = readRun(root);
  let run: InboxArchiveRun = held !== null && held.day === day
    ? held
    : { format: 1, day, done: false, moved: 0, unread: {}, loadSkips: 0, cursor: {}, recovered: [], recoverCursor: {}, completed: [] };
  if (run.done) {
    // The day's work is over.
    // A line that did not go is tried again, a bounded number of times.
    const notice = run.notice;
    if (notice !== undefined && !notice.sent && notice.tries < NOTICE_TRIES) {
      const sent = await sendNotice(run, root, team, deps);
      return { kind: 'ran', moved: 0, unread: 0, done: true, refused: [], notice: sent };
    }
    return { kind: 'done' };
  }
  if (!inWindow(now)) return { kind: 'outside' };
  const perCore = (deps.loadPerCore ?? defaultLoadPerCore)();
  if (perCore > INBOX_ARCHIVE_MAX_LOAD_PER_CORE) {
    run.loadSkips += 1;
    writeRun(root, run);
    return { kind: 'load', perCore, first: run.loadSkips === 1 };
  }
  const key = messageKeyState(home);
  if (key.kind !== 'key') return { kind: 'no-key' };
  const teamId = teamIdOf(root);
  let budget = input.limit ?? INBOX_ARCHIVE_PASS_LIMIT;
  let scanBudget = input.scanLimit ?? INBOX_ARCHIVE_SCAN_PER_PASS;
  let moved = 0;
  let unread = 0;
  let more = false;
  const refused: string[] = [];
  let registrySaid = false;
  const stop = async (after: 'recovery' | 'chunk'): Promise<boolean> => deps.yieldTurn !== undefined && !(await deps.yieldTurn(after));
  seats: for (const folder of seatDropFolders(root)) {
    // The lead binds a clearance's authority (E7b: the stamped planner rule asks it).
    const context: StatusContext = { to: folder.seat, root, session: folder.session, ...(team.orchestrator ? { lead: team.orchestrator } : {}) };
    const key2 = `${folder.session}/${folder.seat}`;
    // A folder fully looked at today is not looked at again until tomorrow.
    if (run.completed.includes(key2)) continue;
    const chainOk = (): boolean => folderChainOk(root, folder.session, folder.seat);
    // 1. What an earlier move left part way: listed once a pass, worked through from a cursor
    //    that moves past every unit looked at, whatever it found, so nothing starves the rest.
    if (!run.recovered.includes(key2)) {
      if (!chainOk()) {
        refused.push(`${folder.seat}: the drop folder is not a plain folder; left alone`);
        run.completed.push(key2);
        continue;
      }
      const work = listRecoveryWork(folder.dropDir);
      if (work === null) {
        refused.push(`${folder.seat}: the drop folder cannot be read`);
        run.completed.push(key2);
        continue;
      }
      const from = run.recoverCursor[key2];
      let at = from === undefined ? 0 : work.findIndex((item) => item.key > from);
      if (at < 0) at = work.length;
      while (at < work.length) {
        if (budget <= 0 || scanBudget <= 0) {
          more = true;
          break seats;
        }
        if (!chainOk()) {
          refused.push(`${folder.seat}: the drop folder changed into something that is not a plain folder; left alone`);
          run.completed.push(key2);
          continue seats;
        }
        // Every unit looked at is charged to the scan budget; a family it finishes, to the moves.
        const chunk = work.slice(at, at + Math.min(budget, scanBudget, INBOX_ARCHIVE_SCAN_CHUNK));
        const finished = recoverItems(folder.dropDir, chunk).length;
        moved += finished;
        budget -= finished;
        scanBudget -= chunk.length;
        at += chunk.length;
        run.recoverCursor[key2] = (chunk[chunk.length - 1] as { key: string }).key;
        if (await stop('recovery')) {
          more = true;
          break seats;
        }
      }
      delete run.recoverCursor[key2];
      run.recovered.push(key2);
    }
    // 2. The folder is listed once this pass; its families are looked at a chunk a call.
    if (!chainOk()) {
      refused.push(`${folder.seat}: the drop folder changed into something that is not a plain folder; left alone`);
      run.completed.push(key2);
      continue;
    }
    const families = listSeatFamilies(folder.dropDir);
    if (families === null) {
      refused.push(`${folder.seat}: the drop folder cannot be read`);
      run.completed.push(key2);
      continue;
    }
    for (;;) {
      if (budget <= 0 || scanBudget <= 0) {
        more = true;
        break seats;
      }
      // The folder is checked again after every turn the loop gave away: a folder replaced by a
      // link meanwhile is left alone.
      if (!chainOk()) {
        refused.push(`${folder.seat}: the drop folder changed into something that is not a plain folder; left alone`);
        run.completed.push(key2);
        break;
      }
      // The registry is read whole before every chunk, after the loop's last turn: a seat that
      // started meanwhile keeps its unread mail. When any of it cannot be read, no unread mail
      // moves: a record it could not read may be a running seat's.
      const agents = readAgentsComplete(home);
      if (agents === null && !registrySaid) {
        registrySaid = true;
        refused.push('the registry could not be read whole; no unread mail moved');
      }
      const atRest = agents !== null && seatAtRest(agents, teamId, team, folder.session, folder.seat);
      const retired = agents !== null && seatRetired(agents, teamId, team, folder.seat);
      const after = run.cursor[key2];
      const report = archiveSeatInbox({
        // E7b (decision 4): a retired seat's unacknowledged stamped record moves only once its
        // sender's not-delivered notice stands (written now, or found as this obligation's own).
        beforeUndelivered: (item) => noticeBeforeMove({
          home, root, session: folder.session, seat: folder.seat, team, key: key.key, at: now.toISOString(), item,
          ...(agents === null ? {} : { agents, teamId }),
        }),
        dropDir: folder.dropDir,
        seat: folder.seat,
        context,
        key: key.key,
        home,
        now,
        dryRun: false,
        options: {
          markPreChannel: false,
          unreadKeepMs: atRest ? STOPPED_UNREAD_KEEP_MS : null,
          retired,
          limit: budget,
          scanLimit: Math.min(INBOX_ARCHIVE_SCAN_CHUNK, scanBudget),
          orphans: false,
          families,
          ...(after === undefined ? {} : { after }),
        },
      });
      const unreadHere = report.move.filter((item) => item.unread === true).length;
      moved += report.move.length - unreadHere;
      unread += unreadHere;
      if (unreadHere > 0) run.unread[folder.seat] = (run.unread[folder.seat] ?? 0) + unreadHere;
      budget -= report.move.length;
      scanBudget -= Math.max(1, report.scanned ?? 0);
      if (report.refused !== null) {
        refused.push(report.refused);
        delete run.cursor[key2];
        run.completed.push(key2);
        break;
      }
      if (report.more === true && report.last !== null && report.last !== undefined) {
        run.cursor[key2] = report.last;
      } else if (report.more !== true) {
        delete run.cursor[key2];
        run.completed.push(key2);
      }
      if (await stop('chunk')) {
        more = true;
        break seats;
      }
      if (report.more !== true) break;
    }
  }
  // 3. The older `.agents/messages/<seat>` store the runtime still writes its notices into: the
  //    same rules for this team's session, after the drop folders, inside the same budgets.
  const busy: string[] = [];
  let flockMissing = false;
  if (!more) {
    legacy: for (const folder of legacySeatFolders(root)) {
      const key2 = `messages/${folder.seat}`;
      if (run.completed.includes(key2)) continue;
      for (;;) {
        if (budget <= 0 || scanBudget <= 0) {
          more = true;
          break legacy;
        }
        if (heldAt(folder.dir).kind !== 'folder') {
          refused.push(`${folder.seat}: the messages folder is not a plain folder; left alone`);
          run.completed.push(key2);
          break;
        }
        const agents = readAgentsComplete(home);
        if (agents === null && !registrySaid) {
          registrySaid = true;
          refused.push('the registry could not be read whole; no unread mail moved');
        }
        const atRest = agents !== null && seatAtRest(agents, teamId, team, team.session, folder.seat);
        const after = run.cursor[key2];
        const recoveryAfter = run.recoverCursor[key2];
        const report = archiveLegacySeat({
          root,
          session: team.session,
          seat: folder.seat,
          key: key.key,
          now,
          dryRun: false,
          options: {
            unreadKeepMs: atRest ? STOPPED_UNREAD_KEEP_MS : null,
            limit: budget,
            scanLimit: Math.min(INBOX_ARCHIVE_SCAN_CHUNK, scanBudget),
            skipRecovery: run.recovered.includes(key2),
            ...(after === undefined ? {} : { after }),
            ...(recoveryAfter === undefined ? {} : { recoveryAfter }),
          },
        });
        if (report.unbound === true) {
          // No kernel lock in this process: the store is never moved without one. Said once.
          if (!flockMissing) refused.push('flock could not be bound; the older messages store was not moved (dry run only)');
          flockMissing = true;
          run.completed.push(key2);
          continue legacy;
        }
        if (report.busy !== null) {
          // Another archiver (a manual `team drops archive`) holds this mailbox: skipped for this
          // pass, not an error; the day stays open so a later pass comes back to it.
          busy.push(folder.seat);
          more = true;
          continue legacy;
        }
        const unreadHere = report.moved.filter((item) => item.unread === true).length;
        moved += report.moved.length - unreadHere + report.finished;
        unread += unreadHere;
        if (unreadHere > 0) run.unread[folder.seat] = (run.unread[folder.seat] ?? 0) + unreadHere;
        // Every planned unit is charged, recovery included, whether it moved or was kept on a
        // second look: the plan was bounded by the budget, so the work done is.
        budget -= report.plan.move.length + report.plan.recovery.length;
        scanBudget -= Math.max(1, report.plan.scanned);
        if (report.refused !== null) {
          refused.push(report.refused);
          delete run.cursor[key2];
          run.completed.push(key2);
          break;
        }
        if (report.plan.recoveryDone) {
          delete run.recoverCursor[key2];
          if (!run.recovered.includes(key2)) run.recovered.push(key2);
        } else if (report.plan.recoveryLast !== null) {
          run.recoverCursor[key2] = report.plan.recoveryLast;
        }
        if (report.plan.more) {
          // Recovery that filled the chunk leaves the record cursor where it was: the records wait.
          if (report.plan.last !== null) run.cursor[key2] = report.plan.last;
        } else {
          delete run.cursor[key2];
          run.completed.push(key2);
        }
        if (await stop('chunk')) {
          more = true;
          break legacy;
        }
        if (!report.plan.more) break;
      }
    }
  }
  run.moved += moved;
  if (!more) run.done = true;
  const saved = writeRun(root, run);
  if (moved > 0 || unread > 0 || refused.length > 0 || busy.length > 0) {
    logLine(
      join(root, '.agents'),
      'drops archive',
      'daemon',
      `daily ${day}: moved ${String(moved)} read or acknowledged, ${String(unread)} unread to seats at rest${more ? '; more next pass' : ''}${busy.length === 0 ? '' : `; busy (another archiver): ${busy.join(', ')}`}${refused.length === 0 ? '' : `; ${refused.join('; ')}`}`,
      now,
    );
  }
  let notice: 'sent' | 'failed' | 'none' = 'none';
  const anyMoved = run.moved > 0 || Object.values(run.unread).some((count) => count > 0);
  if (saved && run.done && anyMoved) notice = await sendNotice(run, root, team, deps);
  return { kind: 'ran', moved, unread, done: run.done, refused, notice };
}

/** Sends the lead's line once. The id and the try are saved before the send, so a run file that
 *  cannot be written sends nothing, and a send that is tried again carries the same id. */
async function sendNotice(run: InboxArchiveRun, root: string, team: TeamFile, deps: InboxArchiveDeps): Promise<'sent' | 'failed' | 'none'> {
  const lead = team.orchestrator;
  if (lead === '' || deps.notify === undefined) return 'none';
  const notice = run.notice ?? { id: randomUUID(), sent: false, tries: 0 };
  run.notice = notice;
  if (notice.sent) return 'sent';
  if (notice.tries >= NOTICE_TRIES) return 'failed';
  notice.tries += 1;
  if (!writeRun(root, run)) return 'failed';
  let ok = false;
  try {
    ok = (await deps.notify({ root, session: team.session, lead, body: noticeBody(run), id: notice.id })).ok;
  } catch {
    ok = false;
  }
  notice.sent = ok;
  writeRun(root, run);
  return ok ? 'sent' : 'failed';
}

function defaultLoadPerCore(): number {
  const cores = Math.max(1, cpus().length);
  return (loadavg()[0] ?? 0) / cores;
}
