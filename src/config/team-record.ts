// The team's record as `team config get|set|unset` addresses it: a dotted path into the parsed
// team (`watch.unread_after`, `seats.lead.model`, `seats.0.cli`), and the YAML text written back.
// A segment under a list picks the item whose `name` is that segment, or the item at that index.
//
// Values are written back as block YAML in the subset src/yaml.ts reads; a written text is always
// parsed again and validated by the team-file validator before it is stored, so nothing here has
// to be trusted to be right — only to be readable.
//
// A set or unset rewrites only the lines it changes: the key's line keeps the comment beside it,
// a comment beside or inside a value the change removes stays as a comment line where it was, and
// every other line is kept byte for byte. A record shape the line editor cannot address falls back
// to the regenerated text, whose value is the same but whose comments are not kept;
// `editedRecordText` says which text it returned, and the command warns when it is the regenerated
// one. `team config edit` edits the text itself.

import { parseYaml, stripComment, toValue, type YamlEntry, type YamlNode, type YamlValue } from '../yaml.ts';

export type RecordPath = string[];

/** Names every object inherits from its prototype chain. At a map a path segment is a key, and a
 *  record never holds these three as its own, so a walk through one would reach a shared object.
 *  Under a list the same segment selects an item by its name, which the schema allows — a seat
 *  may be named `constructor`, and a path that names it is an ordinary item selector. */
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePath(raw: string): RecordPath | string {
  if (raw === '' || raw.startsWith('.') || raw.endsWith('.') || raw.includes('..')) return `"${raw}" is not a path: write dotted keys, like watch.unread_after or seats.lead.model`;
  return raw.split('.');
}

type Container = { [key: string]: YamlValue } | YamlValue[];

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** The index a segment names in a list: the item named so, else a decimal index. */
function indexIn(list: YamlValue[], segment: string): number {
  const named = list.findIndex((item) => isMap(item) && item.name === segment);
  if (named >= 0) return named;
  if (/^(0|[1-9][0-9]*)$/.test(segment)) {
    const at = Number(segment);
    return at < list.length ? at : -1;
  }
  return -1;
}

/** The reserved name `path` would address where its map does not own it, or null. The walk
 *  follows `withValue`'s: under a list a segment selects an item by name or index, never a key.
 *  At a map an existing own key is walked whatever its spelling — a dynamic map may hold an
 *  account or rule named `constructor`, which the schema allows — and a reserved name the map
 *  does not own is refused before it is made: the record never holds one as its own key, and
 *  making it would address the property every object inherits instead of the record. */
export function reservedKeyIn(root: YamlValue, path: RecordPath): string | null {
  if (path.length === 0 || !isMap(root)) return null;
  let at: YamlValue = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    if (Array.isArray(at)) {
      const n = indexIn(at, segment);
      if (n < 0) return null;
      at = at[n] as YamlValue;
      continue;
    }
    if (!isMap(at)) return null;
    if (!Object.prototype.hasOwnProperty.call(at, segment)) {
      if (RESERVED_SEGMENTS.has(segment)) return segment;
      // A section a set will make; the rest of the path addresses a fresh map's keys.
      at = {};
      continue;
    }
    at = at[segment] as YamlValue;
  }
  const last = path[path.length - 1] as string;
  if (!isMap(at)) return null;
  return RESERVED_SEGMENTS.has(last) && !Object.prototype.hasOwnProperty.call(at, last) ? last : null;
}

export function getAt(root: YamlValue, path: RecordPath): { found: true; value: YamlValue } | { found: false } {
  let at: YamlValue = root;
  for (const segment of path) {
    if (Array.isArray(at)) {
      const i = indexIn(at, segment);
      if (i < 0) return { found: false };
      at = at[i] as YamlValue;
    } else if (isMap(at) && Object.prototype.hasOwnProperty.call(at, segment)) {
      at = at[segment] as YamlValue;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: at };
}

/** Sets (or, with `value` undefined, removes) the value at `path` in a copy of `root`. Missing
 *  maps on the way are made; a list item must exist. Returns a reason when the path cannot be. */
export function withValue(root: YamlValue, path: RecordPath, value: YamlValue | undefined): { ok: true; root: YamlValue; changed: boolean } | { ok: false; why: string } {
  const reserved = reservedKeyIn(root, path);
  if (reserved !== null) return { ok: false, why: `"${reserved}" cannot be addressed: every object inherits that name, and the record does not hold it as its own key` };
  const copy = structuredClone(root) as YamlValue;
  if (!isMap(copy)) return { ok: false, why: 'the record is not a map' };
  let at: Container = copy;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const where = path.slice(0, i + 1).join('.');
    if (Array.isArray(at)) {
      const n = indexIn(at, segment);
      if (n < 0) return { ok: false, why: `${path.slice(0, i).join('.')} has no item named "${segment}"` };
      const next = at[n];
      if (next === null || typeof next !== 'object') return { ok: false, why: `${where} is a value, not a section` };
      at = next as Container;
    } else {
      // Own keys only, as `getAt` reads them: a name the record does not hold is a section to
      // make, never an inherited object to walk into and write through.
      let next = Object.prototype.hasOwnProperty.call(at, segment) ? at[segment] : undefined;
      if (next === undefined) {
        if (value === undefined) return { ok: true, root: copy, changed: false };
        next = {};
        at[segment] = next;
      }
      if (next === null || typeof next !== 'object') return { ok: false, why: `${where} is a value, not a section` };
      at = next as Container;
    }
  }
  const last = path[path.length - 1] as string;
  if (Array.isArray(at)) {
    const n = indexIn(at, last);
    if (n < 0) return value === undefined ? { ok: true, root: copy, changed: false } : { ok: false, why: `${path.slice(0, -1).join('.')} has no item named "${last}"` };
    if (value === undefined) at.splice(n, 1);
    else at[n] = value;
    return { ok: true, root: copy, changed: true };
  }
  if (value === undefined) {
    if (!Object.prototype.hasOwnProperty.call(at, last)) return { ok: true, root: copy, changed: false };
    delete at[last];
    return { ok: true, root: copy, changed: true };
  }
  const before = at[last];
  at[last] = value;
  return { ok: true, root: copy, changed: JSON.stringify(before) !== JSON.stringify(value) };
}

/** A value typed on the command line, read as a YAML scalar or one-line flow value. */
export function parseValue(raw: string): YamlValue {
  try {
    const parsed = toValue(parseYaml(`value: ${raw}\n`));
    if (isMap(parsed) && 'value' in parsed) return parsed.value as YamlValue;
  } catch {
    // Not YAML: the text itself.
  }
  return raw;
}

const PLAIN = /^[A-Za-z_./@~][A-Za-z0-9_./@~+-]*( [A-Za-z0-9_./@~+-]+)*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;
// A value with its unit (30%, 10m, 500MB) stays plain: the validator reads a measure only unquoted.
const MEASURE = /^[0-9]+(\.[0-9]+)?(%|ms|s|m|h|d|KB|MB|GB|TB)$/;

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value !== 'string') return String(value);
  return (PLAIN.test(value) && !RESERVED.test(value)) || MEASURE.test(value) ? value : JSON.stringify(value);
}

function key(name: string): string {
  const bare = /^[A-Za-z_./@~][A-Za-z0-9_./@~+-]*$/.test(name) && !RESERVED.test(name);
  return bare ? name : JSON.stringify(name);
}

function emptyOrScalar(value: YamlValue): string | null {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : null;
  if (isMap(value)) return Object.keys(value).length === 0 ? '{}' : null;
  return scalar(value);
}

function emit(value: YamlValue, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      const inline = emptyOrScalar(item);
      if (inline !== null) {
        out.push(`${pad}- ${inline}`);
      } else if (isMap(item)) {
        const lines: string[] = [];
        emit(item, indent + 2, lines);
        out.push(`${pad}- ${(lines[0] as string).slice(indent + 2)}`, ...lines.slice(1));
      } else {
        out.push(`${pad}-`);
        emit(item, indent + 2, out);
      }
    }
    return;
  }
  if (isMap(value)) {
    for (const [name, item] of Object.entries(value)) {
      const inline = emptyOrScalar(item);
      if (inline !== null) {
        out.push(`${pad}${key(name)}: ${inline}`);
      } else {
        out.push(`${pad}${key(name)}:`);
        emit(item, Array.isArray(item) ? indent + 2 : indent + 2, out);
      }
    }
    return;
  }
  out.push(`${pad}${scalar(value)}`);
}

/** The record as block YAML text. */
export function recordText(value: YamlValue): string {
  const out: string[] = [];
  emit(value, 0, out);
  return `${out.join('\n')}\n`;
}

/** A value as `team config get` prints it: a scalar plain, a section as YAML. */
export function shownValue(value: YamlValue): string {
  const inline = emptyOrScalar(value);
  if (inline !== null) return typeof value === 'string' ? `${value}\n` : `${inline}\n`;
  return recordText(value);
}

// The comment-keeping line editor a set and unset write through. It changes the lines of the
// addressed entry (or list item) and keeps every other line as it was, so a comment above, below
// or beside the changed key stays where the owner wrote it. `stripComment` is the parser's own,
// so the comment it cuts begins exactly where the parser would have cut it.

type RawLine = { body: string; term: string };

type Holder =
  | { kind: 'root' }
  | { kind: 'entry'; entry: YamlEntry }
  | { kind: 'item'; item: YamlNode };

/** One change to the text: replace lines `start`..`end` (1-based, inclusive) with `lines`, or
 *  insert `lines` after line `at` (`0` before the first line). Line numbers are the parsed
 *  record's, before any change, so a plan's changes are applied from the last line up. */
type Op =
  | { kind: 'replace'; start: number; end: number; lines: string[] }
  | { kind: 'insert'; at: number; lines: string[] };

/** The text's physical lines, each with its own terminator (`''` on a last line without one). */
function rawLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    const crlf = i > start && text[i - 1] === '\r';
    out.push({ body: text.slice(start, crlf ? i - 1 : i), term: crlf ? '\r\n' : '\n' });
    start = i + 1;
  }
  if (start < text.length) out.push({ body: text.slice(start), term: '' });
  return out;
}

function indentOf(body: string): number {
  return body.length - body.trimStart().length;
}

/** The last line a node's own text occupies. */
function lastLine(node: YamlNode): number {
  if (node.kind === 'scalar') return node.line;
  if (node.kind === 'seq') return Math.max(node.line, ...node.items.map(lastLine));
  return Math.max(node.line, ...node.entries.map((entry) => Math.max(entry.line, lastLine(entry.value))));
}

/** The index just past the `:` that ends the key of a line that parsed as an entry; `-1` when
 *  the line has none. A dash prefix (`- name: lead`) is part of the key's text here. */
function afterColon(text: string): number {
  let at = 0;
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0] as string;
    at = 1;
    for (;;) {
      if (at >= text.length) return -1;
      const c = text[at] as string;
      if (quote === '"' && c === '\\') {
        at += 2;
        continue;
      }
      if (c === quote) {
        if (quote === "'" && text[at + 1] === "'") {
          at += 2;
          continue;
        }
        at += 1;
        break;
      }
      at += 1;
    }
  }
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i + 1;
  }
  return -1;
}

/** An entry line split into its padding, its key (`- name:` and all) and the bytes after the
 *  key's text: the spaces and the comment beside the key, kept exactly as written. */
function entryLineParts(raw: RawLine[], entry: YamlEntry): { pad: string; prefix: string; tail: string } | null {
  const body = raw[entry.line - 1]?.body;
  if (body === undefined) return null;
  const indent = indentOf(body);
  const rest = body.slice(indent);
  const visible = stripComment(rest, entry.line).trimEnd();
  const colon = afterColon(visible);
  if (colon < 0) return null;
  return { pad: ' '.repeat(indent), prefix: visible.slice(0, colon), tail: rest.slice(visible.length) };
}

/** The comment a line carries, from its `#` on; `null` when it has none. */
function commentOf(body: string, n: number): { indent: number; comment: string } | null {
  const visible = stripComment(body, n);
  if (visible.length === body.length) return null;
  return { indent: indentOf(body), comment: body.slice(visible.length) };
}

/** The comments written on lines `start`..`end`, each as a standalone comment line at the
 *  indentation of the line it came from. A set or unset that removes lines leaves the owner's
 *  comments where those lines were, so the bytes survive the change that took the values. */
function keptCommentLines(raw: RawLine[], start: number, end: number): string[] {
  const out: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const body = raw[n - 1]?.body;
    if (body === undefined) continue;
    const found = commentOf(body, n);
    if (found !== null) out.push(' '.repeat(found.indent) + found.comment);
  }
  return out;
}

function replaceEntryOp(raw: RawLine[], entry: YamlEntry, value: YamlValue): Op | null {
  const parts = entryLineParts(raw, entry);
  if (parts === null) return null;
  const end = lastLine(entry.value);
  const kept = keptCommentLines(raw, entry.line + 1, end);
  const inline = emptyOrScalar(value);
  if (inline !== null) {
    return { kind: 'replace', start: entry.line, end, lines: [`${parts.pad}${parts.prefix} ${inline}${parts.tail}`, ...kept] };
  }
  const block: string[] = [];
  emit(value, parts.pad.length + 2, block);
  return { kind: 'replace', start: entry.line, end, lines: [`${parts.pad}${parts.prefix}${parts.tail}`, ...block, ...kept] };
}

/** The line holding a list item's `-` marker: its node's own line when the item starts there,
 *  else the bare `-` just above the item's block (blank and comment lines skipped). */
function itemStartLine(raw: RawLine[], item: YamlNode): number | null {
  const body = raw[item.line - 1]?.body ?? '';
  const rest = body.slice(indentOf(body));
  if (rest === '-' || rest.startsWith('- ')) return item.line;
  for (let n = item.line - 1; n >= 1; n -= 1) {
    const line = raw[n - 1];
    if (line === undefined) return null;
    const text = line.body.slice(indentOf(line.body));
    const visible = stripComment(text, n).trim();
    if (visible === '') continue;
    return visible === '-' ? n : null;
  }
  return null;
}

/** Whether a list item's value is a `{ }` or `[ ]` collection on the item's own line. */
function itemIsFlow(raw: RawLine[], item: YamlNode): boolean {
  const body = raw[item.line - 1]?.body ?? '';
  const rest = body.slice(indentOf(body));
  if (!(rest === '-' || rest.startsWith('- '))) return false;
  const after = rest.slice(1).trimStart();
  return after.startsWith('{') || after.startsWith('[');
}

function replaceItemOp(raw: RawLine[], item: YamlNode, start: number, value: YamlValue): Op | null {
  const body = raw[start - 1]?.body;
  if (body === undefined) return null;
  const indent = indentOf(body);
  const rest = body.slice(indent);
  const visible = stripComment(rest, start).trimEnd();
  const tail = rest.slice(visible.length);
  const pad = ' '.repeat(indent);
  const end = lastLine(item);
  const kept = keptCommentLines(raw, start + 1, end);
  const inline = emptyOrScalar(value);
  if (inline !== null) return { kind: 'replace', start, end, lines: [`${pad}- ${inline}${tail}`, ...kept] };
  const block: string[] = [];
  emit(value, indent + 2, block);
  return { kind: 'replace', start, end, lines: [`${pad}-${tail}`, ...block, ...kept] };
}

/** The index a path segment names in a list: the item whose `name` is that segment, else a
 *  decimal index, as `withValue` reads it. */
function nodeIndex(items: YamlNode[], segment: string): number {
  const named = items.findIndex(
    (item) => item.kind === 'map' && item.entries.some((entry) => entry.key === 'name' && entry.value.kind === 'scalar' && entry.value.value === segment),
  );
  if (named >= 0) return named;
  if (/^(0|[1-9][0-9]*)$/.test(segment)) {
    const at = Number(segment);
    return at < items.length ? at : -1;
  }
  return -1;
}

/** The indentation of a map's own entries; an item map's keys align after its `-`. */
function mapIndent(raw: RawLine[], map: YamlNode): number {
  const first = map.kind === 'map' ? map.entries[0] : undefined;
  if (first === undefined) return 0;
  const body = raw[first.line - 1]?.body ?? '';
  const indent = indentOf(body);
  const rest = body.slice(indent);
  if (rest === '-' || rest.startsWith('- ')) {
    const after = rest.slice(1);
    return indent + 1 + (after.length - after.trimStart().length);
  }
  return indent;
}

/** A key the map does not have yet, written as a new entry after the map's last one. */
function insertEntryOp(raw: RawLine[], map: YamlNode, key: string, value: YamlValue): Op | null {
  if (map.kind !== 'map' || map.entries.length === 0) return null;
  const at = lastLine((map.entries[map.entries.length - 1] as YamlEntry).value);
  const lines: string[] = [];
  emit({ [key]: value }, mapIndent(raw, map), lines);
  return { kind: 'insert', at, lines };
}

/** An entry's key line made to hold `{}` or `[]`; the entry's own `-` prefix and comment keep
 *  their place. Used when removing the last key (or item) of a section leaves it empty. */
function emptyEntryLine(raw: RawLine[], entry: YamlEntry, empty: '{}' | '[]'): string | null {
  const parts = entryLineParts(raw, entry);
  if (parts === null) return null;
  return `${parts.pad}${parts.prefix} ${empty}${parts.tail}`;
}

/** Removing the only entry (or item) of a section: the section's holder is made to hold an
 *  empty `{}` or `[]` rather than nothing, which would parse as null; it is `[]` when the
 *  section was a list. The removed lines' comments stay as comment lines where they were. */
function emptiedOps(raw: RawLine[], holder: Holder, span: { start: number; end: number }): Op[] | null {
  if (holder.kind === 'root') return null;
  if (holder.kind === 'entry') {
    const empty = holder.entry.value.kind === 'seq' ? '[]' : '{}';
    const line = emptyEntryLine(raw, holder.entry, empty);
    if (line === null) return null;
    return [
      { kind: 'replace', start: holder.entry.line, end: holder.entry.line, lines: [line] },
      { kind: 'replace', start: span.start, end: span.end, lines: keptCommentLines(raw, span.start, span.end) },
    ];
  }
  const start = itemStartLine(raw, holder.item);
  if (start === null) return null;
  const body = raw[start - 1]?.body ?? '';
  const indent = indentOf(body);
  const rest = body.slice(indent);
  const visible = stripComment(rest, start).trimEnd();
  const tail = rest.slice(visible.length);
  const empty = holder.item.kind === 'seq' ? '[]' : '{}';
  const line = `${' '.repeat(indent)}- ${empty}${tail}`;
  if (start === span.start) {
    return [{ kind: 'replace', start, end: span.end, lines: [line, ...keptCommentLines(raw, span.start + 1, span.end)] }];
  }
  return [
    { kind: 'replace', start, end: start, lines: [line] },
    { kind: 'replace', start: span.start, end: span.end, lines: keptCommentLines(raw, span.start, span.end) },
  ];
}

/** An entry removed from a map, or a list item removed from a sequence. */
function removeEntryOps(raw: RawLine[], container: YamlNode, holder: Holder, entry: YamlEntry): Op[] | null {
  const end = lastLine(entry.value);
  if (container.kind === 'map' && container.entries.length === 1) return emptiedOps(raw, holder, { start: entry.line, end });
  const body = raw[entry.line - 1]?.body ?? '';
  const indent = indentOf(body);
  const rest = body.slice(indent);
  if (rest === '-' || rest.startsWith('- ')) {
    // The map's first key shares its list item's `-` line: the dash stays, the key goes.
    const visible = stripComment(rest, entry.line).trimEnd();
    return [{ kind: 'replace', start: entry.line, end, lines: [`${' '.repeat(indent)}-${rest.slice(visible.length)}`, ...keptCommentLines(raw, entry.line + 1, end)] }];
  }
  return [{ kind: 'replace', start: entry.line, end, lines: keptCommentLines(raw, entry.line, end) }];
}

function nest(path: RecordPath, value: YamlValue): YamlValue {
  let out: YamlValue = value;
  for (let i = path.length - 1; i >= 0; i -= 1) out = { [path[i] as string]: out };
  return out;
}

/** The changes that write `value` through `path`, or `null` for a shape the line editor cannot
 *  address (the caller regenerates the text then). A one-line `{ }` or `[ ]` on the way is
 *  rewritten whole, from its new value in `root`, since no line inside it can be reached. */
function planEdit(text: string, path: RecordPath, value: YamlValue | undefined, root: YamlValue): Op[] | null {
  const parsed = parseYaml(text);
  if (parsed.kind !== 'map') return null;
  const raw = rawLines(text.startsWith('﻿') ? text.slice(1) : text);
  let container: YamlNode = parsed;
  let holder: Holder = { kind: 'root' };
  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i] as string;
    const last = i === path.length - 1;
    if (container.kind === 'map') {
      const entry: YamlEntry | undefined = container.entries.find((one: YamlEntry) => one.key === segment);
      if (last) {
        if (value === undefined) {
          if (entry === undefined) return [];
          return removeEntryOps(raw, container, holder, entry);
        }
        if (entry === undefined) {
          const op = insertEntryOp(raw, container, segment, value);
          return op === null ? null : [op];
        }
        const op = replaceEntryOp(raw, entry, value);
        return op === null ? null : [op];
      }
      if (entry === undefined) {
        if (value === undefined) return [];
        const op = insertEntryOp(raw, container, segment, nest(path.slice(i + 1), value));
        return op === null ? null : [op];
      }
      const child: YamlNode = entry.value;
      if (child.kind === 'scalar') return null;
      if (child.line === entry.line) {
        const next = getAt(root, path.slice(0, i + 1));
        if (!next.found) return null;
        const op = replaceEntryOp(raw, entry, next.value);
        return op === null ? null : [op];
      }
      container = child;
      holder = { kind: 'entry', entry };
    } else if (container.kind === 'seq') {
      const at = nodeIndex(container.items, segment);
      if (at < 0) return last && value === undefined ? [] : null;
      const item = container.items[at] as YamlNode;
      const start = itemStartLine(raw, item);
      if (last) {
        if (value === undefined) {
          if (start === null) return null;
          if (container.items.length === 1) return emptiedOps(raw, holder, { start, end: lastLine(item) });
          return [{ kind: 'replace', start, end: lastLine(item), lines: [] }];
        }
        const op = start === null ? null : replaceItemOp(raw, item, start, value);
        return op === null ? null : [op];
      }
      if (item.kind === 'scalar') return null;
      if (itemIsFlow(raw, item)) {
        if (start === null) return null;
        const next = getAt(root, path.slice(0, i + 1));
        if (!next.found) return null;
        const op = replaceItemOp(raw, item, start, next.value);
        return op === null ? null : [op];
      }
      container = item;
      holder = { kind: 'item', item };
    } else {
      return null;
    }
  }
  return null;
}

/** Applies a plan's changes from the last line up, so every line number stays the parsed one. */
function applyOps(text: string, ops: Op[]): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const source = text.slice(bom.length);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawLines(source);
  const at = (op: Op): number => (op.kind === 'replace' ? op.start : op.at);
  const ordered = [...ops].sort((a, b) => at(b) - at(a));
  for (const op of ordered) {
    if (op.kind === 'replace') {
      const removed = lines.slice(op.start - 1, op.end);
      if (removed.length === 0) continue;
      const end = removed[removed.length - 1] as RawLine;
      const segments = op.lines.map((body, index) => ({ body, term: index === op.lines.length - 1 ? end.term : newline }));
      lines.splice(op.start - 1, removed.length, ...segments);
      continue;
    }
    if (op.lines.length === 0) continue;
    const segments = op.lines.map((body) => ({ body, term: newline }));
    if (op.at <= 0) {
      lines.unshift(...segments);
      continue;
    }
    const previous = lines[op.at - 1];
    if (previous === undefined) continue;
    if (previous.term === '') {
      previous.term = newline;
      (segments[segments.length - 1] as RawLine).term = '';
    }
    lines.splice(op.at, 0, ...segments);
  }
  return bom + lines.map((line) => line.body + line.term).join('');
}

/** Every comment a text carries, from each `#` to the end of its line, in the order carried. */
function commentsOf(text: string): string[] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const raw = rawLines(source);
  const out: string[] = [];
  for (let n = 1; n <= raw.length; n += 1) {
    const found = commentOf((raw[n - 1] as RawLine).body, n);
    if (found !== null) out.push(found.comment);
  }
  return out;
}

/** Whether `after` still carries every comment `before` carried, as many times. */
function keepsComments(before: string[], after: string[]): boolean {
  const left = new Map<string, number>();
  for (const comment of after) left.set(comment, (left.get(comment) ?? 0) + 1);
  for (const comment of before) {
    const count = left.get(comment) ?? 0;
    if (count === 0) return false;
    left.set(comment, count - 1);
  }
  return true;
}

/** The record's text with the value at `path` set (or, with `value` undefined, removed).
 *  `kept` is true when the change was made line by line and every comment the text carried is
 *  still there; false when the text was regenerated whole — the same value, its comments lost. */
export function editedRecordText(text: string, path: RecordPath, value: YamlValue | undefined, root: YamlValue): { text: string; kept: boolean } {
  try {
    const ops = planEdit(text, path, value, root);
    if (ops !== null) {
      const next = applyOps(text, ops);
      if (JSON.stringify(toValue(parseYaml(next))) === JSON.stringify(root) && keepsComments(commentsOf(text), commentsOf(next))) {
        return { text: next, kept: true };
      }
    }
  } catch {
    // A record this editor cannot read line by line: regenerate it below.
  }
  return { text: recordText(root), kept: false };
}
