// The trace half of a seat's own state: the last thing the seat is known to have done, each
// fact read from the source that keeps it — the commit at the seat's worktree's tip, the last
// ack or message the send history holds for it, and the last tool row its pane shows. The
// labels' line follows the file and the screen (`observe.ts`); these are the traces
// `src/labels/state.ts`'s column reads beside it, `newestTraceAt()` being the instants
// comparison the tables weigh them with. Every reader answers null when its source
// cannot say — absence is not a value, and an unreadable source is never guessed at — and
// nothing here writes.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { stripSgr } from '../ansi.ts';
import { readHistory } from '../send/history.ts';
import type { SessionState } from '../state.ts';

export type SeatTrace = {
  kind: 'commit' | 'message' | 'ack' | 'tool';
  /** ISO instant: the commit's own date (`%aI`, which a rebase does not move), the send
   *  history's `ts`, or the read's own instant for a tool row — a screen carries no clock. */
  at: string;
  /** One short line: the commit's subject; the message's direction and outcome; the tool row's
   *  own words. Never a message body, and never screen text but the tool row itself. */
  what: string;
  /** A commit's short hash (`%h`). The other kinds carry none. */
  ref?: string;
};

export type TraceInput = {
  seat: { name: string; cli: string };
  session: SessionState;
  project: string;
  root: string;
  /** The home whose store holds the send history. Absent where the caller stands in for no
   *  store at all — as `status.ts`'s store-backed differences do — and the message trace is
   *  skipped rather than read from somewhere else. */
  home?: string;
  /** The seat's pane, the same read `observe.ts` takes. */
  screen?: string;
  at: Date;
};

/** The three sources together, in this order, each or none: the worktree's last commit, the
 *  send history's last ack or message, the pane's last tool row. */
export function seatTraces(input: TraceInput): SeatTrace[] {
  const out: SeatTrace[] = [];
  const worktree = seatWorktree(input.session, input.seat.name, input.root);
  const commit = worktree === null ? null : commitTrace(worktree);
  if (commit) out.push(commit);
  const message = input.home === undefined ? null : messageTrace(input.project, input.root, input.seat.name, input.home);
  if (message) out.push(message);
  const tool = toolTrace(input.seat.cli, input.screen, input.at);
  if (tool) out.push(tool);
  return out;
}

/** The newest instant among the traces and any carried-forward ISO strings beside them (a seat
 *  record's `last_active`, say), as the original string: instants, not text — a commit's `%aI`
 *  carries its own offset, so comparing the strings would misread one. An unparseable string is
 *  ignored rather than guessed at, and nothing to compare answers null. */
export function newestTraceAt(traces: SeatTrace[], ...carried: Array<string | null | undefined>): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const at of [...traces.map((trace) => trace.at), ...carried]) {
    if (at === undefined || at === null) continue;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms <= newestMs) continue;
    newest = at;
    newestMs = ms;
  }
  return newest;
}

/**
 * The worktree the seat works in, as a path: the one the seat's `temporary.task` names first
 * (`team add`'s temporary seats), else the last record whose `seat` is the name (`team worktree
 * --seat`). Records store the path relative to the project root; an absolute one is resolved
 * and returned, and a seat the state records no worktree for has none.
 */
export function seatWorktree(session: SessionState, seat: string, root: string): string | null {
  const task = session.seats[seat]?.temporary?.task;
  const named = task ? session.worktrees[task] : undefined;
  if (named) return resolve(root, named.path);
  let found: string | null = null;
  for (const tree of Object.values(session.worktrees)) {
    if (tree.seat === seat) found = resolve(root, tree.path);
  }
  return found;
}

/**
 * The worktree's last commit: its subject, its short hash, and the commit's own date — `%aI`,
 * which a rebase does not move, so a rewrite never reads as fresh work. A worktree with no
 * commits yet, or one git cannot read, has no trace.
 */
export function commitTrace(worktree: string): SeatTrace | null {
  const result = spawnSync(
    'git',
    ['-c', 'log.showSignature=false', 'log', '-1', '--format=%aI%x00%h%x00%s'],
    { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.error || result.status !== 0) return null;
  const [at, ref, subject] = result.stdout.split('\0');
  if (!at || !ref || subject === undefined) return null;
  return { kind: 'commit', at: at.trim(), what: subject.trim(), ref: ref.trim() };
}

/**
 * The last ack or message the send history holds for the seat: the newest entry of
 * `messages.jsonl` (`src/send/history.ts`) addressed to it or sent by it, in the history's own
 * words — an `answered` outcome on a message to the seat is its ack. A history that cannot be
 * read has no trace. The mailbox receipts (`.agents/messages/*.read.json`) are a later phase.
 */
export function messageTrace(project: string, root: string, seat: string, home: string): SeatTrace | null {
  const read = readHistory(project, root, home);
  if (!read.ok) return null;
  let found: SeatTrace | null = null;
  for (const entry of read.entries) {
    if (entry.from !== seat && entry.to !== seat) continue;
    if (entry.to === seat && entry.outcome === 'answered') {
      found = { kind: 'ack', at: entry.ts, what: `answered a message from ${entry.from}` };
    } else if (entry.to === seat) {
      found = { kind: 'message', at: entry.ts, what: `a message from ${entry.from} (${entry.outcome})` };
    } else {
      found = { kind: 'message', at: entry.ts, what: `a message to ${entry.to} (${entry.outcome})` };
    }
  }
  return found;
}

/**
 * The last tool row the pane shows, when the CLI's captures hold one: Claude Code prints
 * `⏺ Tool(args)` rows in its transcript (`⏺ Write(notes.txt)`, `⏺ Explore(Survey project for
 * README)` — `test/fixtures/claude-code`), and an assistant's prose row (`⏺ One, two, three…`)
 * is not one. The other CLIs' captures hold no such row, so they have no trace rather than a
 * guess. The screen carries no clock: the read's own instant stands as the trace's time.
 */
export function toolTrace(cli: string, screen: string | undefined, at: Date): SeatTrace | null {
  if (cli !== 'claude-code') return null;
  if (screen === undefined || screen === '') return null;
  let found: SeatTrace | null = null;
  for (const row of stripSgr(screen).split('\n')) {
    const hit = /^⏺ ([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/.exec(row.trim());
    if (!hit) continue;
    found = { kind: 'tool', at: at.toISOString(), what: `${hit[1]}(${hit[2]})` };
  }
  return found;
}
