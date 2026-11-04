// `team trace <id>`: one message's story, as the receiving team's event log records it. Every step
// a send, the bus or the watch took for the id is a signed event filed under the message id and a
// step's own tail (`<id>:staged`, `<id>:leg.tried:<route>`, `<id>:webhook.posted`, `<id>:read`,
// `<id>:wake.retried:<try>:<via>`), so a trace is a filtered read of one verified log — no second
// store and no summary the log does not hold. The row order is the log's own sequence and the
// DELTA cell is the quiet time since the step above it, which is how a walk's cost and a watch's
// retry delay are read without guessing.
//
// The log is the receiving team's: the steps are filed in their store beside the bus's own
// `message.arrived`, so the trace runs in that team's checkout. A sender reading its own line's id
// from another checkout sees only the steps that checkout's store holds, and the command says so
// by printing what it found rather than what it expected.
//
// It reads: no event is appended, no file is written, and the run asks for no terminal and no
// pane. Authorization is the map's (`trace` is a seat-record row, like the Runtime's read
// surfaces); the command itself reads the team file and the log.

import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { EVENT_RECORD_ID, readEventsMatching, type EventPayload } from '../bus/log.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { contextLine, hasJsonFlag, pluralCount, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team trace <id> [--json]

Prints the signed steps the receiving team's event log holds for one message id, in the order
they were written: when the record was staged, each leg the walk tried with its route and
outcome, the sender's webhook post, the bus's arrival, the seat's delivered/read/replied
receipts, and the watch's retries. DELTA is the quiet time from the step above it.

The steps are filed in the receiving team's store, so run it in that team's checkout. A full
step id (\`<id>:staged\`) prints that one step; the bare message id prints the whole story.
\`team send\` prints the id on its closing line, so the line a sender quotes is the trace's key.

Options:
  --json           one team.trace document ({format, project, session, id, steps, summary,
                   unverified}) instead of the context line and table

Exits 0 when the trace is printed, 1 when the log holds no step under that id or the log can't be
read, 2 when the invocation or team file can't be read.
`;

/** What the run may read besides the checkout it stands in. */
export type TraceSources = { home: string };

export const realSources: TraceSources = { home: homedir() };

/** One step of the story, as the table and the document word it. */
type TraceStep = {
  payload: EventPayload;
  delta: number | null;
};

const trace: Command = (argv, io) => runTrace(argv, io, realSources);
export default trace;

export async function runTrace(argv: string[], io: Io, sources: TraceSources = realSources): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  // The raw argv, not the parser's flag set: `--nope --json` and `--json=1` must still answer
  // with the structured error document.
  const json = hasJsonFlag(argv);
  if (args.error) return usage(io, args.error, json);
  const id = args.rest[0];
  if (!id) return usage(io, 'a message id is required', json);
  if (args.rest.length > 1) return usage(io, 'trace reads one message id and takes nothing else', json);
  if (!EVENT_RECORD_ID.test(id)) {
    return usage(io, `"${id}" is not a message id: a trace key is the message id, or the id with a step tail`, json);
  }

  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    // `team trace` takes no `--file`, so the no-repository refusal must not offer one.
    const message = loaded.errors
      .map((problem) => (problem.line ? `line ${problem.line}: ${withoutFileOffer(problem.message)}` : withoutFileOffer(problem.message)))
      .join('; ');
    return configuration(io, message || 'the team file cannot be read', json);
  }
  const { team, root } = loaded;

  // The record id is the key: the bare id is the arrival, and every step's id is the message id
  // plus its own tail. Both match, and a full step id matches only its own step. The sealed
  // segments' signed indexes answer the filter, so only the steps' own lines are read.
  const read = readEventsMatching(team.project, root, sources.home, (entry) =>
    entry.record_id === id || entry.record_id.startsWith(`${id}:`),
  );
  if (!read.ok) return unreadable(io, read.reason, json);

  const found = read.events.map((record) => record.payload).sort((a, b) => a.seq - b.seq);
  const steps: TraceStep[] = found.map((payload, index) => {
    const previous = index === 0 ? null : found[index - 1] as EventPayload;
    return { payload, delta: previous === null ? null : deltaOf(previous, payload) };
  });

  const context = contextLine(team.project, team.session);
  if (steps.length === 0) {
    if (json) writeJson(io, 'team.trace', document(team.project, team.session, id, steps, read.unverified));
    else {
      io.stdout(`${context}\n${pluralCount(0, 'step')}\n`);
      io.stderr(`team trace: no step is filed under ${id} in this team's event log\n`);
    }
    // exit: trace.empty
    return 1;
  }

  if (json) {
    writeJson(io, 'team.trace', document(team.project, team.session, id, steps, read.unverified));
  } else {
    io.stdout(`${context}\n`);
    if (read.unverified > 0) {
      io.stderr(`team trace: skipped ${pluralCount(read.unverified, 'unverified record')} in the log\n`);
    }
    const lines = renderTable({
      headers: ['TIME', 'STEP', 'VIA', 'OUTCOME', 'MS', 'DELTA', 'NOTE'],
      rows: steps.map((step) => rowOf(step)),
      style: ttyStyle(io, { json: false }),
    });
    io.stdout(`${lines.join('\n')}\n${pluralCount(steps.length, 'step')}\n`);
  }
  return 0; // exit: trace.shown
}

/** The quiet time between two steps, in whole milliseconds: the log's own instants, never a
 *  clock read now. A negative value is kept — a step stamped before the one above it is a clock
 *  disagreement a reader should see, not one this command smooths away. */
function deltaOf(previous: EventPayload, current: EventPayload): number {
  return Math.round(Date.parse(current.ts) - Date.parse(previous.ts));
}

/** `HH:MM:SS.mmm` in UTC, from the instant the record carries: the same clock the deltas use,
 *  whatever offset the record's own timestamp was written with. */
function timeOf(ts: string): string {
  const at = Date.parse(ts);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(11, 23) : ts;
}

function deltaText(delta: number | null): string {
  if (delta === null) return '-';
  if (delta === 0) return '0 ms';
  return delta > 0 ? `+${String(delta)} ms` : `${String(delta)} ms`;
}

/** One row: the step's own fields, never a word the event does not carry. */
function rowOf(step: TraceStep): string[] {
  const payload = step.payload;
  return [
    timeOf(payload.ts),
    payload.kind,
    payload.via ?? '-',
    payload.outcome ?? '-',
    payload.ms === undefined ? '-' : String(payload.ms),
    deltaText(step.delta),
    payload.reason ?? '-',
  ];
}

/** The one `--json` document. Absent optional fields stay absent, as feed's events do, so a
 *  reader can tell a step that carried no route from one that printed `-` in the table. */
function document(
  project: string,
  session: string,
  id: string,
  steps: readonly TraceStep[],
  unverified: number,
): Record<string, unknown> {
  return {
    format: 1 as const,
    project,
    session,
    id,
    steps: steps.map((step) => {
      const payload = step.payload;
      return {
        seq: payload.seq,
        ts: payload.ts,
        kind: payload.kind,
        record_id: payload.record_id,
        ...(payload.from === undefined ? {} : { from: payload.from }),
        ...(payload.to === undefined ? {} : { to: payload.to }),
        ...(payload.seat === undefined ? {} : { seat: payload.seat }),
        ...(payload.thread === undefined ? {} : { thread: payload.thread }),
        ...(payload.via === undefined ? {} : { via: payload.via }),
        ...(payload.outcome === undefined ? {} : { outcome: payload.outcome }),
        ...(payload.ms === undefined ? {} : { ms: payload.ms }),
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        delta_ms: step.delta,
      };
    }),
    summary: pluralCount(steps.length, 'step'),
    unverified,
  };
}

function usage(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'trace.usage', message, null);
  else io.stderr(`team trace: ${message}\n${USAGE}`);
  return 2; // exit: trace.usage
}

function configuration(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'trace.configuration', message, null);
  else io.stderr(`team trace: ${message}\n`);
  return 2; // exit: trace.configuration
}

function unreadable(io: Io, reason: string, json: boolean): number {
  const message = `the event log cannot be read: ${reason}`;
  if (json) writeJsonError(io, 'trace.unreadable', message, null);
  else io.stderr(`team trace: ${message}\n`);
  return 1; // exit: trace.unreadable
}
