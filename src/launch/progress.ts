// One progress record per seat, and the writer that draws it.
//
// `up` and `add` work one seat at a time, and a seat's line is the run's whole account of it:
// `<seat>: launching`, rewritten in place while the seat advances, until its one final record.
// On a terminal the line is drawn before the seat's workspace is created and rewritten with a
// carriage return and a clear to the end of the line — never a cursor move to another line — and
// the final record ends with a newline. A redirected stdout receives only the final records, one
// newline-terminated line per seat, in file order: no provisional text, no carriage return, no
// escape sequence. Everything else a run says — refusals, notes, the timeout's last reading, what
// the owner does next — is on stderr, after the record it belongs to.
//
// The record is the unit the pause builds on: a pause at a dialog is a `waiting for owner`
// record, and `waiting` draws it provisionally while the prompt is open — replaced in place when
// the classification changes, and left without a newline, so the seat still ends with exactly one
// final record.
//
// The writer cleans every string it writes — one physical line per field and per detail line
// (`plainLine`: the one cleaning with the line breaks folded) — and it is the boundary between
// whatever a caller built — a seat name, a live stage word, a reason read off a screen — and the
// terminal. `cleanRecord` is that cleaning for a whole record, so a caller can clean once and
// hand the same words to the log and the writer both.

import { plainLine } from './plain.ts';
import type { Screen } from '../watch/screen.ts';

/** The classifications a record can name, in the one closed list every reader validates against.
 *  `login` is reserved: no profile produces it today. */
export const CLASSIFICATIONS = [
  'trust',
  'permission',
  'question',
  'provider error',
  'rate limit',
  'vendor notice',
  'login',
  'unknown',
  'unsent',
  'timeout',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/** A classification from outside the program — the state file is the one place one enters —
 *  validated against the closed list: one of that list, or `unknown` for anything else. */
export function cleanClassification(value: unknown): Classification {
  return typeof value === 'string' && (CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as Classification)
    : 'unknown';
}

/** A screen kind as the classification a record keeps, for the kinds a classification can hold.
 *  The record's closed list has no exit question — the stop's own line and the seat's report
 *  carry that reading — so a screen read as one is recorded as the question it is, the word it
 *  would have had before the kind existed. */
export function classificationOf(kind: Exclude<Screen['kind'], 'idle' | 'working'>): Classification {
  return kind === 'exit question' ? 'question' : kind;
}

/** The provisional states a line is drawn in, in the order a seat can pass them. The words a
 *  person watching the terminal sees. */
export type ProgressState = 'launching' | 'waiting for its prompt' | 'naming' | 'sending its rules';

/** A seat's final record. `waiting for owner` is carried for completeness (the log accepts it);
 *  a run settles a waiting seat one way or another, so `final` never prints it: the provisional
 *  `waiting` line is the shape it takes while a prompt is open. */
export type FinalRecord =
  | { kind: 'ready' }
  | { kind: 'left out'; reason: string }
  | { kind: 'waiting for owner'; classification: Classification };

/** The record as a line, without its newline. */
export function recordText(seat: string, record: FinalRecord): string {
  if (record.kind === 'ready') return `${seat}: ready`;
  if (record.kind === 'left out') return `${seat}: left out: ${record.reason}`;
  return `${seat}: waiting for owner (${record.classification})`;
}

/** What the log keeps for a record: the record's own words after the seat's name. */
export function recordWhat(record: FinalRecord): string {
  if (record.kind === 'ready') return 'ready';
  if (record.kind === 'left out') return `left out: ${record.reason}`;
  return `waiting for owner (${record.classification})`;
}

export type ProgressSink = {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdout is a terminal: only then is a provisional line drawn. */
  isTTY: boolean;
};

export type Progress = {
  /** The seat's line, first drawn before its workspace is created and rewritten as it advances.
   *  On a redirected stdout this writes nothing at all. */
  progress(seat: string, state: ProgressState): void;
  /** The seat's waiting record while a prompt is open — provisional like `progress`, drawn on
   *  the seat's own line, and rewritten when the prompt returns with another classification.
   *  It is not a final record: the seat's one final record still comes from `final`. */
  waiting(seat: string, classification: string): void;
  /** One line of the owner's prompt, on the next line of the terminal. It is written to stderr,
   *  so a redirected stdout carries the final records and nothing else, prompts or not. */
  prompt(line: string): void;
  /** The seat's one final record — the newline-terminated line. */
  final(seat: string, record: FinalRecord): void;
  /** One detail line: one writer call per line, cleaned line by line, never passed through. */
  detail(line: string): void;
};

/** A field as a record says it: one physical line — a run of line feeds in whatever a caller
 *  built becomes one space, so a field can never open a second physical line — and `unknown`
 *  when the cleaning leaves nothing readable. */
function field(text: string): string {
  const folded = plainLine(text);
  return folded.trim() === '' ? 'unknown' : folded;
}

/** The record's fields cleaned once, with the same function the writer uses: what `up` and `add`
 *  hand to the log and to the writer both, so the log line and the terminal line are the same
 *  cleaned words. */
export function cleanRecord(record: FinalRecord): FinalRecord {
  if (record.kind === 'left out') return { kind: 'left out', reason: field(record.reason) };
  if (record.kind === 'waiting for owner') {
    return { kind: 'waiting for owner', classification: field(record.classification) as Classification };
  }
  return record;
}

/** The writer `up` and `add` hand their host. One per run. */
export function progressWriter(sink: ProgressSink): Progress {
  // The writer is the boundary: whatever a caller hands it, the seat, the stage word, the reason,
  // the classification and every detail line are cleaned here (`plainLine`, the one cleaning the
  // pane excerpts are built on, with the line breaks folded), so no escape sequence, carriage
  // return, bidi override or line feed a caller slipped in can reach the terminal, a pipe, or a
  // log that copies the record. A field the cleaning leaves with nothing readable is said as
  // `unknown`: the one line per seat survives a caller that said nothing readable, and the word
  // is the one these records already use for a reading this version cannot make.
  return {
    progress(seat, state) {
      // Redirected: the final records only. Nothing provisional ever reaches a pipe.
      if (!sink.isTTY) return;
      sink.stdout(`\r\x1b[K${field(seat)}: ${field(state)}`);
    },
    waiting(seat, classification) {
      if (!sink.isTTY) return;
      sink.stdout(`\r\x1b[K${field(seat)}: waiting for owner (${field(classification)})`);
    },
    prompt(line) {
      // The seat's waiting record has no newline yet; the prompt starts its own line.
      const text = plainLine(line);
      sink.stderr(sink.isTTY ? `\n${text}\n` : `${text}\n`);
    },
    final(seat, record) {
      const text = recordText(field(seat), cleanRecord(record));
      sink.stdout(sink.isTTY ? `\r\x1b[K${text}\n` : `${text}\n`);
    },
    detail(line) {
      const text = plainLine(line);
      if (text.trim() === '') return;
      sink.stderr(`${text}\n`);
    },
  };
}
