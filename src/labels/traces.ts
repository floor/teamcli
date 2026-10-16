// The trace half of a seat's own state: the last thing the seat is known to have done, each
// fact read from the source that keeps it — the commit at the seat's worktree's tip, the last
// ack or message the send history holds for it, and the last tool row its pane shows. Only a
// commit, an ack and a message carry their own instant: a tool row carries none, because a
// screen carries no clock — it is kept for display and is never weighed as recency. The
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

export type SeatTrace =
  | {
      kind: 'commit';
      /** The commit's own date (`%aI`, which a rebase does not move), ISO 8601. */
      at: string;
      /** The commit's subject. */
      what: string;
      /** The commit's short hash (`%h`). */
      ref?: string;
    }
  | {
      kind: 'message' | 'ack';
      /** The send history's own `ts`, ISO 8601. */
      at: string;
      /** The message's direction and outcome. Never a message body. */
      what: string;
    }
  | {
      /** A tool row, with no instant of its own: a screen carries no clock, so its age is
       *  unknown — kept for display, never weighed as recency (`newestTraceAt` skips it). */
      kind: 'tool';
      /** The row's own words — never screen text but the row itself. */
      what: string;
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
  const tool = toolTrace(input.seat.cli, input.screen);
  if (tool) out.push(tool);
  return out;
}

/** The newest instant among the traces that carry one — a tool row carries none, so it is
 *  skipped — and any carried-forward ISO strings beside them (a seat record's `last_active`,
 *  say), as the original string: instants, not text — a commit's `%aI` carries its own offset,
 *  so comparing the strings would misread one. An unparseable string is ignored rather than
 *  guessed at, and nothing to compare answers null. */
export function newestTraceAt(traces: SeatTrace[], ...carried: Array<string | null | undefined>): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const at of [...traces.map((trace) => (trace.kind === 'tool' ? undefined : trace.at)), ...carried]) {
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
 * is not one. Antigravity prints `● Tool(args)` (1.2.16: `Read`, `Bash`, `Create`, `Edit`) and
 * `● Ran (args)` (1.3.5), either with a ` (ctrl+o to expand)` hint that is trimmed off — both
 * in `test/fixtures/antigravity`, whose permission dialogs echo the row without the marker and
 * stay unread. The other CLIs' captures hold no such row, so they have no trace rather than a
 * guess. The screen carries no clock, so the trace carries none: a row sits in the scrollback
 * long after the work it shows, and weighing it as fresh would read an idle seat as working.
 */
export function toolTrace(cli: string, screen: string | undefined): SeatTrace | null {
  if (cli !== 'claude-code' && cli !== 'antigravity') return null;
  if (screen === undefined || screen === '') return null;
  let found: SeatTrace | null = null;
  for (const row of stripSgr(screen).split('\n')) {
    const what = toolRow(cli, row.trim());
    if (what !== null) found = { kind: 'tool', what };
  }
  return found;
}

/** One trimmed screen line's tool row as its own words, or null: the shape gate that keeps
 *  prose — a bullet that merely holds parentheses — out of the trace. */
function toolRow(cli: string, line: string): string | null {
  if (cli === 'claude-code') {
    const hit = /^⏺ ([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/.exec(line);
    return hit === null ? null : `${hit[1]}(${hit[2]})`;
  }
  const named = /^● ([A-Za-z][A-Za-z0-9_]*)\((.*?)\)(?: \(ctrl\+o to expand\))?$/.exec(line);
  if (named !== null) return `${named[1]}(${named[2]})`;
  const ran = /^● Ran \((.*?)\)(?: \(ctrl\+o to expand\))?$/.exec(line);
  return ran === null ? null : `Ran(${ran[1]})`;
}
