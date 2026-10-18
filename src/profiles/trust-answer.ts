import { stripSgr } from '../ansi.ts';
import { YamlError, type YamlEntry, type YamlNode } from '../yaml.ts';
import { TRUST_CAPTURES } from './trust-captures.ts';
/** How a trust dialog shows the one folder it will trust. */
export type Extract = {
  after: string;
  before: string | null;
  untilBlank: boolean;
  join: boolean;
  box: boolean;
  refuseLine: string | null;
  /** With join: the continuation column the capture draws. */
  indent: number | null;
  /** With join: the column the capture's first wrapped row fills exactly. */
  wrap: number | null;
};

/**
 * One trust-answer record. Enabled only by `capture` naming the registered capture its
 * predicate, label and extractor were taken from — the manifest's whole path, so a
 * basename cannot stand for a different layout. Codex additionally needs
 * `lobbyEvidence`, a capture of the folder-only layout in the real lobby: the folder
 * question alone cannot show that the answer will trust the lobby. The bytes are one
 * hex byte.
 */
export type TrustRecord = {
  from: string;
  to: string;
  label: string;
  mark: string | null;
  footer: string | null;
  action: string;
  capture: string;
  lobbyEvidence: string | null;
  extract: Extract;
};

const KEYS = ['1', 'a', 'enter'] as const;

/**
 * A version as a whole number series: `2026.10.01` is [2026, 10, 1]. Null for any text
 * with a suffix, a pre-release tag, build metadata or other decoration — `2026.10.01-beta.1`
 * is not `2026.10.01`.
 */
export function wholeVersion(text: string): number[] | null {
  const match = /^\d+(?:\.\d+)*$/.exec(text.trim());
  return match ? match[0].split('.').map(Number) : null;
}

function versionOrder(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * True when a printed version is one the record lists. An exact record matches the printed
 * text byte for byte, so a build suffix must be spelled in the record exactly as the CLI
 * prints it; a closed range compares whole versions with no suffix on either side. A
 * decorated or unparsable version is outside any range.
 */
export function versionMatches(record: Pick<TrustRecord, 'from' | 'to'>, printed: string): boolean {
  if (record.from === record.to) return printed === record.from;
  const version = wholeVersion(printed);
  const from = wholeVersion(record.from);
  const to = wholeVersion(record.to);
  if (!version || !from || !to) return false;
  return versionOrder(version, from) >= 0 && versionOrder(version, to) <= 0;
}

/** The herdr key name for one recorded byte, or null when this version does not send it. */
export function keyOf(action: string): (typeof KEYS)[number] | null {
  if (!/^[0-9a-fA-F]{2}$/.test(action)) return null;
  const byte = Number.parseInt(action, 16);
  if (byte === 0x31) return '1';
  if (byte === 0x61) return 'a';
  if (byte === 0x0d) return 'enter';
  return null;
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}

function text(entry: YamlEntry, key: string): string {
  const node = entry.value;
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') {
    fail(entry.line, `"${key}" must be a non-empty string`);
  }
  return node.value;
}

function flag(entry: YamlEntry | undefined, key: string): boolean {
  if (!entry) return false;
  const node = entry.value;
  if (node.kind === 'scalar' && typeof node.value === 'boolean' && !node.quoted) return node.value;
  fail(node.line, `"${key}" must be true or false`);
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

/** The records a profile lists, or none. A profile that omits the key answers nothing. */
export function trustAnswers(entry: YamlEntry | undefined): TrustRecord[] {
  if (!entry) return [];
  const node = entry.value;
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"trust_answer" must be a non-empty list');
  return node.items.map((item) => recordOf(item));
}

function recordOf(node: YamlNode): TrustRecord {
  const entries = mapping(node, 'a trust answer');
  only(entries, ['from', 'to', 'label', 'mark', 'footer', 'action', 'capture', 'lobby_evidence', 'extract']);
  const action = text(required(entries, 'action', node.line), 'action');
  if (!/^[0-9a-fA-F]{2}$/.test(action)) fail(required(entries, 'action', node.line).line, '"action" must be one hex byte');
  const capture = text(required(entries, 'capture', node.line), 'capture');
  if (!capture.includes('/')) fail(required(entries, 'capture', node.line).line, '"capture" must be the manifest path, not a basename');
  const evidence = optional(entries, 'lobby_evidence');
  return {
    from: text(required(entries, 'from', node.line), 'from'),
    to: text(required(entries, 'to', node.line), 'to'),
    label: text(required(entries, 'label', node.line), 'label'),
    mark: optional(entries, 'mark') ? text(optional(entries, 'mark') as YamlEntry, 'mark') : null,
    footer: optional(entries, 'footer') ? text(optional(entries, 'footer') as YamlEntry, 'footer') : null,
    action,
    capture,
    lobbyEvidence: evidence ? text(evidence, 'lobby_evidence') : null,
    extract: extractOf(required(entries, 'extract', node.line).value),
  };
}

/** A whole, non-negative number, printed plainly. */
function whole(entry: YamlEntry | undefined, key: string): number | null {
  if (!entry) return null;
  const node = entry.value;
  if (node.kind !== 'scalar' || typeof node.value !== 'number' || !Number.isInteger(node.value) || node.value < 0) {
    fail(node.line, `"${key}" must be a whole, non-negative number`);
  }
  return node.value;
}

function extractOf(node: YamlNode): Extract {
  const entries = mapping(node, 'extract');
  only(entries, ['after', 'before', 'until_blank', 'join', 'box', 'refuse_line', 'indent', 'wrap']);
  const before = optional(entries, 'before');
  const until = flag(optional(entries, 'until_blank'), 'until_blank');
  if (!before && !until) fail(node.line, 'extract needs before or until_blank');
  const join = flag(optional(entries, 'join'), 'join');
  const indent = whole(optional(entries, 'indent'), 'indent');
  const wrap = whole(optional(entries, 'wrap'), 'wrap');
  if (join && (indent === null || wrap === null)) fail(node.line, 'extract with join needs indent and wrap');
  if (!join && (indent !== null || wrap !== null)) fail(node.line, 'indent and wrap only apply to a joined extract');
  return {
    after: text(required(entries, 'after', node.line), 'after'),
    before: before ? text(before, 'before') : null,
    untilBlank: until,
    join,
    box: flag(optional(entries, 'box'), 'box'),
    refuseLine: optional(entries, 'refuse_line') ? text(optional(entries, 'refuse_line') as YamlEntry, 'refuse_line') : null,
    indent,
    wrap,
  };
}

function plain(line: string, box: boolean): string {
  const text = line.replace(/\s+$/g, '');
  if (!box) return text.trim();
  return text.replace(/[│╭╮╰╯┌┐└┘─]/g, '').trim();
}

/** The row as it is drawn: trailing spaces and, in a box, the border come off; the indent stays. */
function drawn(line: string, box: boolean): string {
  const text = line.replace(/\s+$/g, '');
  return box ? text.replace(/[│╭╮╰╯┌┐└┘─]/g, '') : text;
}

/** The one folder the dialog shows, or null when it does not show exactly one. */
export function extractFolder(extract: Extract, screen: string): string | null {
  const lines = stripSgr(screen).split('\n');
  if (extract.refuseLine && lines.some((line) => line.includes(extract.refuseLine as string))) return null;
  const start = lines.findIndex((line) => plain(line, extract.box).includes(extract.after));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  let taken: string[];
  if (extract.before) {
    const end = rest.findIndex((line) => plain(line, extract.box).includes(extract.before as string));
    if (end < 0) return null;
    taken = rest.slice(0, end);
  } else {
    const end = rest.findIndex((line) => plain(line, extract.box) === '');
    taken = end < 0 ? rest : rest.slice(0, end);
  }
  if (extract.join) return joinRows(taken, extract);
  const paths = taken.map((line) => plain(line, extract.box)).filter((line) => line !== '');
  return paths.length === 1 ? (paths[0] as string) : null;
}

/**
 * The path a wrapped folder question draws, joined only when the rows prove they are one
 * wrapped path — every row consecutive (no blank between them) inside the question's own
 * rows, the first filling the wrap column exactly, and every later row starting at the
 * capture's continuation indent with content after it and no wider than the wrap. The
 * one-row layout of the same question has no continuation to prove; it is taken when it
 * starts at the same indent. A run that fails any of this is refused rather than joined:
 * two unrelated rows can hold the two halves of a lobby path without ever being one.
 */
function joinRows(taken: string[], extract: Extract): string | null {
  const indent = ' '.repeat(extract.indent as number);
  const wrap = extract.wrap as number;
  const rows: string[] = [];
  for (const line of taken) {
    const text = drawn(line, extract.box);
    if (text.trim() === '') return null;
    rows.push(text);
  }
  const first = rows[0];
  if (first === undefined || !first.startsWith(indent) || first.trim() === '') return null;
  if (rows.length === 1) return first.trim();
  if (first.length !== wrap) return null;
  for (const row of rows.slice(1)) {
    if (!row.startsWith(indent) || row.trim() === '' || row.length > wrap) return null;
  }
  return rows.map((row) => row.trim()).join('');
}

/** The recorded label is on screen, marked when the record says so, with its footer. */
export function labelMatches(record: TrustRecord, screen: string): boolean {
  const lines = stripSgr(screen).split('\n');
  const hit = lines.some((line) => {
    const at = line.indexOf(record.label);
    if (at < 0) return false;
    return record.mark === null || line.slice(0, at).includes(record.mark);
  });
  if (!hit) return false;
  const footer = record.footer;
  return footer === null || lines.some((line) => line.includes(footer));
}

let captures: Set<string> | null = null;

/**
 * The registered captures, keyed by their whole manifest path — never by basename. Embedded at
 * build time (src/profiles/trust-captures.ts, generated from the manifest): the package ships
 * dist/ only, so reading test/fixtures/conformance.json at runtime would fail when installed.
 */
function captureNames(): Set<string> {
  captures ??= new Set(TRUST_CAPTURES);
  return captures;
}

/** Whether `name` is a whole manifest path this CLI has a capture registered at. */
function registered(cli: string, name: string): boolean {
  return captureNames().has(`${cli} ${name}`);
}

/**
 * True when the record's own capture is registered and, for Codex, when its lobby evidence
 * is too. A record for another CLI carrying lobby evidence is not eligible: only Codex's
 * folder question needs the lobby capture to say what its answer will trust.
 */
export function isEligible(cli: string, record: TrustRecord): boolean {
  if (!registered(cli, record.capture)) return false;
  if (cli === 'codex') return record.lobbyEvidence !== null && registered(cli, record.lobbyEvidence);
  return record.lobbyEvidence === null;
}
