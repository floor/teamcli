// The daemon's daily inbox archive: `team drops archive`'s moves, run by the chores child that
// hosts the root, once a day, off-peak, bounded per pass and never under load.
//
// What moves is what the command moves (acknowledged mail at once, read mail once its receipt
// is seven days old), plus one rule the command does not have: mail still unread fourteen days
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
import { randomUUID } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../../file/types.ts';
import { logLine } from '../../log.ts';
import { readAgents } from '../../registry/agents.ts';
import { teamIdOf } from '../../registry/teams.ts';
import { INBOX_ARCHIVE_RUN_FILE } from '../../send/drop-retention.ts';
import { archiveSeatInbox, seatDropFolders } from '../../send/inbox-retention.ts';
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
  /** The lead's line: its one id, whether it went, and how often it was tried. */
  notice?: { id: string; sent: boolean; tries: number };
};

export type InboxArchiveDeps = {
  /** One-minute load per core. */
  loadPerCore?: () => number;
  /** Sends the lead's line. Absent: the line is not sent and the state says so. */
  notify?: (input: { root: string; session: string; lead: string; body: string; id: string }) => Promise<{ ok: boolean; text: string }>;
  /** Gives the caller's loop a turn between seats. False ends the pass. */
  yieldTurn?: () => Promise<boolean>;
};

export type InboxArchivePass =
  | { kind: 'outside' | 'done' | 'no-key' }
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

function readRun(root: string): InboxArchiveRun | null {
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
        ...(value.notice !== undefined ? { notice: value.notice } : {}),
      };
    });
  } catch {
    return null;
  }
}

function writeRun(root: string, run: InboxArchiveRun): void {
  try {
    writeAtomic(runPath(root), `${JSON.stringify(run, null, 2)}\n`);
  } catch {
    // A run file that cannot be written leaves the day's totals unsaved; the moves stand, and the
    // next pass reads what is there.
  }
}

/**
 * Whether `seat`'s folder in `session` belongs to a seat at rest: stopped or retired, never
 * running. A seat the registry records as running or registered is not at rest, whatever the
 * team file says. A declared seat is at rest only when the team file marks it stopped or the
 * registry records it stopped. A seat the team file does not declare (another session's folder,
 * or a seat that was removed) is retired unless the registry still records it live. A person's
 * seat is never at rest here.
 */
export function seatAtRest(home: string, teamId: string, team: TeamFile, session: string, seat: string): boolean {
  if (seat === 'owner') return false;
  let records: ReturnType<typeof readAgents>;
  try {
    records = readAgents(home).filter((agent) => agent.reach.team === teamId && agent.reach.seat === seat && agent.reach.session === session);
  } catch {
    return false;
  }
  if (records.some((agent) => agent.lifecycle === 'running' || agent.lifecycle === 'registered')) return false;
  const declared = session === team.session ? team.seats.find((entry) => entry.name === seat) : undefined;
  if (declared === undefined) return true;
  if (declared.human === true) return false;
  return declared.stopped || records.some((agent) => agent.lifecycle === 'stopped');
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
  deps?: InboxArchiveDeps;
}): Promise<InboxArchivePass> {
  const { root, home, team, now } = input;
  const deps = input.deps ?? {};
  const day = localDay(now);
  const held = readRun(root);
  let run: InboxArchiveRun = held !== null && held.day === day
    ? held
    : { format: 1, day, done: false, moved: 0, unread: {}, loadSkips: 0 };
  if (run.done) {
    // The day's work is over. A line that did not go is tried again, a bounded number of times.
    const notice = run.notice;
    if (notice !== undefined && !notice.sent && notice.tries < NOTICE_TRIES) {
      const sent = await sendNotice(run, root, team, deps);
      writeRun(root, run);
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
  let moved = 0;
  let unread = 0;
  let more = false;
  const refused: string[] = [];
  for (const folder of seatDropFolders(root)) {
    if (budget <= 0) {
      more = true;
      break;
    }
    const atRest = seatAtRest(home, teamId, team, folder.session, folder.seat);
    const context: StatusContext = { to: folder.seat, root, session: folder.session };
    const report = archiveSeatInbox({
      dropDir: folder.dropDir,
      seat: folder.seat,
      context,
      key: key.key,
      home,
      now,
      dryRun: false,
      options: { markPreChannel: false, unreadKeepMs: atRest ? STOPPED_UNREAD_KEEP_MS : null, limit: budget },
    });
    const unreadHere = report.move.filter((item) => item.unread === true).length;
    moved += report.move.length - unreadHere;
    unread += unreadHere;
    if (unreadHere > 0) run.unread[folder.seat] = (run.unread[folder.seat] ?? 0) + unreadHere;
    budget -= report.move.length;
    if (report.more === true) more = true;
    if (report.refused !== null) refused.push(report.refused);
    if (deps.yieldTurn !== undefined && !(await deps.yieldTurn())) {
      more = true;
      break;
    }
  }
  run.moved += moved;
  if (!more) run.done = true;
  if (moved > 0 || unread > 0 || refused.length > 0) {
    logLine(
      join(root, '.agents'),
      'drops archive',
      'daemon',
      `daily ${day}: moved ${String(moved)} read or acknowledged, ${String(unread)} unread to seats at rest${more ? '; more next pass' : ''}${refused.length === 0 ? '' : `; ${refused.join('; ')}`}`,
      now,
    );
  }
  let notice: 'sent' | 'failed' | 'none' = 'none';
  const anyMoved = run.moved > 0 || Object.values(run.unread).some((count) => count > 0);
  if (run.done && anyMoved) notice = await sendNotice(run, root, team, deps);
  writeRun(root, run);
  return { kind: 'ran', moved, unread, done: run.done, refused, notice };
}

async function sendNotice(run: InboxArchiveRun, root: string, team: TeamFile, deps: InboxArchiveDeps): Promise<'sent' | 'failed' | 'none'> {
  const lead = team.orchestrator;
  if (lead === '' || deps.notify === undefined) return 'none';
  const notice = run.notice ?? { id: randomUUID(), sent: false, tries: 0 };
  run.notice = notice;
  if (notice.sent) return 'sent';
  notice.tries += 1;
  try {
    const sent = await deps.notify({ root, session: team.session, lead, body: noticeBody(run), id: notice.id });
    notice.sent = sent.ok;
    return sent.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

function defaultLoadPerCore(): number {
  const cores = Math.max(1, cpus().length);
  return (loadavg()[0] ?? 0) / cores;
}
