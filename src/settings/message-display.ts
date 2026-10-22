// The `message-display` policy's words: the header a wake line opens with, and the one sentence a
// typed wake appends so its seat knows where to read the signed record.
//
// The line is display, never transport: the signed record is what a seat reads, and every field
// here is data. A sender writes the summary (`team send --subject`); when none is written the
// first content line stands in, with the attribution header peeled off. Everything is neutralised
// to one printable line before it is put in front of a person or an agent, and the whole typed
// line stays inside the measured pane width (100 characters), keeping the read hint whole.
//
// The vocabulary lives here so the catalogue can parse a value without importing the resolver
// back into itself, the same split `sender-line` keeps.

/** The shipped template: sender, address, summary. */
export const MESSAGE_DISPLAY_DEFAULT = 'Message from {name} ({seat}@{team}): {summary}';

/** The fixed sentence an agent seat's typed wake ends with. The template cannot remove it. */
export const MESSAGE_READ_HINT = 'Read it with: team drops --read.';

/** The longest rendered typed line; the hint is kept whole and the header is cut to fit. */
export const MESSAGE_LINE_MAX = 100;

/** The longest one field may be before the whole line is measured. */
export const MESSAGE_FIELD_MAX = 100;

/** The summary is the body's first content line, cut here after line-safety sanitisation. */
export const MESSAGE_SUMMARY_MAX = 80;

/** What stands between the rendered header and the fixed hint. */
export const MESSAGE_HINT_SEPARATOR = ' ';

/** The only slots a template may carry; everything else is literal text. */
export const MESSAGE_DISPLAY_PLACEHOLDERS = ['name', 'seat', 'team', 'subject', 'summary', 'age', 'id'] as const;

export type MessageDisplayField = (typeof MESSAGE_DISPLAY_PLACEHOLDERS)[number];

/** The placeholders in the words a refusal names them with. */
export const MESSAGE_DISPLAY_SLOTS = MESSAGE_DISPLAY_PLACEHOLDERS.map((slot) => `{${slot}}`).join(', ');

/** One wake's values before sanitisation. */
export type MessageDisplayFields = {
  /** The sender's readable name (nickname, seat, or the address, by the project's word). */
  name: string;
  /** The sender's seat name. */
  seat: string;
  /** The sender's team, by its project name. */
  team: string;
  /** The sender-written subject, when the record carries one. */
  subject?: string;
  /** The summary already chosen from the subject or the body's first content line. */
  summary: string;
  /** The message's age, already formatted (`0s`, `3m`). */
  age: string;
  /** The message's id. */
  id: string;
};

const KNOWN_SLOT = /\{(name|seat|team|subject|summary|age|id)\}/g;

/** An ANSI escape: a CSI sequence, an OSC string, or a lone ESC and the byte it introduces. */
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-_])/;
const ANSI = new RegExp(ANSI_PATTERN.source, 'g');

/** Every character that would end a line or act on the terminal. */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL = new RegExp(CONTROL_PATTERN.source, 'g');

/** One printable line: escapes and controls become spaces, whitespace collapses, edges trim. */
export function printableLine(value: string): string {
  return value
    .replace(ANSI, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A field as it may stand in the line: one printable line, capped with an ellipsis. */
export function sanitizeMessageField(value: string | undefined, max = MESSAGE_FIELD_MAX): string {
  const line = printableLine(value ?? '');
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The message text under a record's attribution header: `from … — admitted by: …`, and the
 *  rules text a `prepend` profile puts above it, are display scaffolding, never the message. */
export function messageContentOf(body: string): string {
  const header = /(?:^|\n)from [^\n]* — admitted by: [^\n]*\n\n/;
  const found = header.exec(body);
  if (found !== null) return body.slice(found.index + found[0].length);
  // A body whose header is at the very start and followed by one newline: keep the old shape
  // readable too, since a record written before this version may carry it.
  const one = /(?:^|\n)from [^\n]* — admitted by: [^\n]*\n/;
  const first = one.exec(body);
  if (first !== null) return body.slice(first.index + first[0].length);
  return body;
}

/**
 * The summary: the body's first non-empty content line under the attribution header, sanitised
 * for line safety and cut at `MESSAGE_SUMMARY_MAX`. The words are the sender's, never rewritten.
 */
export function messageSummaryOf(body: string): string {
  const content = messageContentOf(body);
  const line = content.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '') ?? '';
  return sanitizeMessageField(line, MESSAGE_SUMMARY_MAX);
}

/** A compact age: `0s`, `42s`, `3m`, `2h`, `1d`. Negative and unreadable values read `0s`. */
export function messageAgeText(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

/** Whether a template's braces all name one fixed slot; the first unknown slot is returned. */
function unknownSlot(template: string): string | null {
  const rest = template.replace(KNOWN_SLOT, '');
  const braces = /\{[^{}]*\}/.exec(rest);
  if (braces !== null) return braces[0];
  if (rest.includes('{') || rest.includes('}')) return rest.slice(rest.search(/[{}]/));
  return null;
}

/**
 * Parses a `message-display` value: `true` (or `on`) for the shipped template, or a trimmed
 * one-line template using only the fixed slots. Unknown placeholders are refused and named.
 */
export function parseMessageDisplayValue(raw: unknown): string | null {
  if (raw === true) return MESSAGE_DISPLAY_DEFAULT;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text === 'on') return text === 'on' ? MESSAGE_DISPLAY_DEFAULT : null;
  if (text === 'off' || text === 'false') return null;
  if (/[\r\n]/.test(text) || CONTROL_PATTERN.test(text) || ANSI_PATTERN.test(text)) return null;
  if (unknownSlot(text) !== null) return null;
  return text;
}

/** Why a raw value is not a `message-display` value, in the words `team policy set` refuses. */
export function messageDisplayValueProblem(raw: unknown): string | null {
  if (parseMessageDisplayValue(raw) !== null) return null;
  if (raw === false) return 'the message display is a floor: a wake always opens with it, so it cannot be turned off';
  if (typeof raw !== 'string') {
    return `the message display must be a one-line template using ${MESSAGE_DISPLAY_SLOTS}`;
  }
  const text = raw.trim();
  if (text === 'off' || text === 'false') {
    return 'the message display is a floor: a wake always opens with it, so it cannot be turned off';
  }
  if (text === '' || /[\r\n]/.test(text)) return 'the message display template must be one non-empty line';
  if (CONTROL_PATTERN.test(text) || ANSI_PATTERN.test(text)) {
    return 'the message display template must be printable text with no control characters or escapes';
  }
  const slot = unknownSlot(text);
  if (slot !== null) {
    return `unknown placeholder ${slot} in the message display; it may use only ${MESSAGE_DISPLAY_SLOTS}`;
  }
  return `the message display must be a one-line template using ${MESSAGE_DISPLAY_SLOTS}`;
}

/**
 * The header, with every field neutralised and substituted in one pass: a value never becomes a
 * placeholder, because the replacement is a function over the original template, not a second
 * search of the result. The header alone is capped at `MESSAGE_LINE_MAX`.
 */
export function renderMessageDisplay(template: string, fields: MessageDisplayFields): string {
  const seat = sanitizeMessageField(fields.seat);
  const name = sanitizeMessageField(fields.name) || seat;
  const team = sanitizeMessageField(fields.team);
  // A header with no sender, seat or team at all is no header: the caller falls back rather than
  // printing a hollow `Message from  ()`.
  if (name === '' && seat === '' && team === '') return '';
  const values: Record<MessageDisplayField, string> = {
    name,
    seat,
    team,
    subject: sanitizeMessageField(fields.subject, MESSAGE_SUMMARY_MAX),
    summary: sanitizeMessageField(fields.summary, MESSAGE_SUMMARY_MAX),
    age: sanitizeMessageField(fields.age, 32),
    id: sanitizeMessageField(fields.id),
  };
  const rendered = template.replace(KNOWN_SLOT, (_whole, slot: MessageDisplayField) => values[slot]);
  return sanitizeMessageField(rendered, MESSAGE_LINE_MAX);
}

/**
 * A typed wake line: the rendered header, then the fixed hint for an agent seat. The hint is
 * never cut or replaced; the header gives way to it. Null when no line can carry both.
 */
export function composeMessageLine(header: string, hint: string | null, max = MESSAGE_LINE_MAX): string | null {
  if (hint === null) {
    return header === '' ? null : sanitizeMessageField(header, max);
  }
  const suffix = `${MESSAGE_HINT_SEPARATOR}${hint}`;
  if (suffix.length >= max) return null;
  const room = max - suffix.length;
  const head = sanitizeMessageField(header, room);
  if (head === '') return null;
  return `${head}${suffix}`;
}

/** The rendered header and, for an agent seat, the fixed hint; null when it cannot fit. */
export function messageLineFor(
  template: string,
  fields: MessageDisplayFields,
  options: { hint: boolean },
): string | null {
  return composeMessageLine(renderMessageDisplay(template, fields), options.hint ? MESSAGE_READ_HINT : null);
}
