// A parser for the YAML subset a team file is written in: block maps and sequences, flow maps
// and sequences on one line, plain and quoted scalars, comments. Anything else is refused with
// its line number, since this reads a file that runs commands.

export type YamlScalar = string | number | boolean | null;

export type YamlNode =
  | { kind: 'scalar'; line: number; value: YamlScalar; quoted: boolean; raw: string }
  | { kind: 'seq'; line: number; items: YamlNode[] }
  | { kind: 'map'; line: number; entries: YamlEntry[] };

export type YamlEntry = { key: string; line: number; value: YamlNode };

export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.name = 'YamlError';
    this.line = line;
  }
}

type Line = { n: number; indent: number; text: string };

export function parseYaml(text: string): YamlNode {
  const lines = readLines(text);
  if (!lines.length) throw new YamlError(1, 'the file is empty');
  const state = { lines, at: 0 };
  const first = lines[0] as Line;
  if (first.indent !== 0) throw new YamlError(first.n, 'the first line must not be indented');
  const node = parseBlock(state, 0);
  const rest = state.lines[state.at];
  if (rest) throw new YamlError(rest.n, 'unexpected indentation');
  return node;
}

export function toValue(node: YamlNode): YamlValue {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map(toValue);
  const out: { [key: string]: YamlValue } = {};
  for (const entry of node.entries) out[entry.key] = toValue(entry.value);
  return out;
}

function readLines(text: string): Line[] {
  const lines: Line[] = [];
  const source = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < source.length; i++) {
    const n = i + 1;
    const full = source[i] as string;
    const indent = full.length - full.trimStart().length;
    if (full.slice(0, indent).includes('\t')) throw new YamlError(n, 'a tab in the indentation: use spaces');
    const body = stripComment(full.slice(indent), n).trimEnd();
    if (!body) continue;
    if (body === '---' || body === '...' || body.startsWith('--- ')) {
      throw new YamlError(n, 'document markers are not supported: one document per file');
    }
    if (body.startsWith('%')) throw new YamlError(n, 'directives are not supported');
    lines.push({ n, indent, text: body });
  }
  return lines;
}

// A comment starts at a `#` that begins the line or follows a space, outside quotes.
/** The line's text without its comment. Exported for the editors that rewrite a line and keep
 *  the comment they cut, byte for byte, beside what changed. */
export function stripComment(text: string, n: number): string {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = '';
      }
    } else if ((c === '"' || c === "'") && startsScalar(text, i)) quote = c;
    else if (c === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i);
  }
  if (quote) throw new YamlError(n, 'a quoted string is not closed on its line');
  return text;
}

// A quote opens a string only where a scalar can start; inside a plain scalar it is a character.
function startsScalar(text: string, i: number): boolean {
  const before = text.slice(0, i).trimEnd();
  return before === '' || /[:,\[{-]$/.test(before);
}

type State = { lines: Line[]; at: number };

function parseBlock(state: State, indent: number): YamlNode {
  const line = state.lines[state.at] as Line;
  return isItem(line.text) ? parseSeq(state, indent) : parseMap(state, indent);
}

function isItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function parseMap(state: State, indent: number): YamlNode {
  const start = state.lines[state.at] as Line;
  const entries: YamlEntry[] = [];
  const seen = new Set<string>();
  for (;;) {
    const line = state.lines[state.at];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(line.n, 'unexpected indentation');
    if (isItem(line.text)) throw new YamlError(line.n, 'a list item where a key was expected');
    const split = splitKey(line.text, line.n);
    if (!split) throw new YamlError(line.n, `expected "key: value", found "${clip(line.text)}"`);
    refuseKeyName(split.key, line.n);
    if (seen.has(split.key)) throw new YamlError(line.n, `duplicate key "${split.key}"`);
    seen.add(split.key);
    state.at++;
    entries.push({ key: split.key, line: line.n, value: valueAfterKey(state, indent, split.rest, line.n) });
  }
  return { kind: 'map', line: start.n, entries };
}

/** A map key becomes a property of the object the reader builds, so the one name that would set
 *  that object's prototype instead of adding a key is refused here: a text could otherwise write
 *  a value that every later read through the map sees but no entry lists. The other two names
 *  every object inherits (`constructor`, `prototype`) make ordinary own properties, so they stay. */
function refuseKeyName(key: string, n: number): void {
  if (key === '__proto__') throw new YamlError(n, 'a map key may not be "__proto__"');
}

function valueAfterKey(state: State, indent: number, rest: string, n: number): YamlNode {
  if (rest) return parseInline(rest, n);
  const next = state.lines[state.at];
  if (next && next.indent > indent) return parseBlock(state, next.indent);
  // A list may sit at its key's own indentation.
  if (next && next.indent === indent && isItem(next.text)) return parseSeq(state, indent);
  return { kind: 'scalar', line: n, value: null, quoted: false, raw: '' };
}

function parseSeq(state: State, indent: number): YamlNode {
  const start = state.lines[state.at] as Line;
  const items: YamlNode[] = [];
  for (;;) {
    const line = state.lines[state.at];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(line.n, 'unexpected indentation');
    if (!isItem(line.text)) break;
    const after = line.text.slice(1);
    const rest = after.trimStart();
    if (!rest) {
      state.at++;
      const next = state.lines[state.at];
      if (next && next.indent > indent) items.push(parseBlock(state, next.indent));
      else items.push({ kind: 'scalar', line: line.n, value: null, quoted: false, raw: '' });
    } else if (isItem(rest)) {
      throw new YamlError(line.n, 'a list directly inside a list item is not supported');
    } else if (splitKey(rest, line.n)) {
      // "- key: value" opens a map whose keys align with the first one.
      const inner = indent + 1 + (after.length - rest.length);
      state.lines[state.at] = { n: line.n, indent: inner, text: rest };
      items.push(parseMap(state, inner));
    } else {
      state.at++;
      items.push(parseInline(rest, line.n));
    }
  }
  return { kind: 'seq', line: start.n, items };
}

// Splits "key: rest" or "key:". Returns null when the text is not a map entry.
function splitKey(text: string, n: number): { key: string; rest: string } | null {
  const c = text[0];
  if (c === '"' || c === "'") {
    const read = readQuoted(text, 0, n);
    const tail = text.slice(read.end);
    if (tail === ':') return { key: read.value, rest: '' };
    if (tail.startsWith(': ')) return { key: read.value, rest: tail.slice(2).trim() };
    return null;
  }
  if (c === '{' || c === '[') return null;
  if (c === '?' && (text.length === 1 || text[1] === ' ')) throw new YamlError(n, 'complex keys ("? ") are not supported');
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':') continue;
    if (i === text.length - 1) return checkKey(text.slice(0, i), '', n);
    if (text[i + 1] === ' ') return checkKey(text.slice(0, i), text.slice(i + 2).trim(), n);
  }
  return null;
}

function checkKey(key: string, rest: string, n: number): { key: string; rest: string } {
  const trimmed = key.trimEnd();
  if (!trimmed) throw new YamlError(n, 'an empty key');
  refuseIndicator(trimmed, n);
  return { key: trimmed, rest };
}

function parseInline(text: string, n: number): YamlNode {
  const c = text[0];
  // "a: b: c" and "a: - x" are not values in YAML; a full parser refuses them too.
  if (c !== '"' && c !== "'" && c !== '{' && c !== '[') {
    if (/: |:$/.test(text)) throw new YamlError(n, 'a value that contains ": " must be quoted');
    if (isItem(text)) throw new YamlError(n, 'a list can\'t start on its key\'s line: put each "- item" on a line of its own');
  }
  if (c === '{' || c === '[') {
    const read = readFlow(text, 0, n);
    if (text.slice(read.end).trim()) throw new YamlError(n, `unexpected text after "${c === '{' ? '}' : ']'}"`);
    return read.node;
  }
  if (c === '"' || c === "'") {
    const read = readQuoted(text, 0, n);
    if (text.slice(read.end).trim()) throw new YamlError(n, 'unexpected text after a quoted string');
    return { kind: 'scalar', line: n, value: read.value, quoted: true, raw: text.slice(0, read.end) };
  }
  return plain(text, n);
}

function plain(text: string, n: number): YamlNode {
  refuseIndicator(text, n);
  return { kind: 'scalar', line: n, value: resolve(text), quoted: false, raw: text };
}

function refuseIndicator(text: string, n: number): void {
  const c = text[0];
  if (c === '&') throw new YamlError(n, 'anchors ("&") are not supported');
  if (c === '*') throw new YamlError(n, 'aliases ("*") are not supported: quote a value that starts with "*"');
  if (c === '!') throw new YamlError(n, 'tags ("!") are not supported');
  if (c === '|' || c === '>') throw new YamlError(n, 'block scalars ("|", ">") are not supported: write the value on one line');
  if (c === '@' || c === '`' || c === '%') throw new YamlError(n, `a value can't start with "${c}": quote it`);
  if (text === '<<') throw new YamlError(n, 'merge keys ("<<") are not supported');
}

// YAML 1.2 core schema.
function resolve(text: string): YamlScalar {
  if (text === '~' || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ',
};

function readQuoted(text: string, at: number, n: number): { value: string; end: number } {
  const quote = text[at];
  let out = '';
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i] as string;
    if (quote === "'") {
      if (c !== "'") out += c;
      else if (text[i + 1] === "'") { out += "'"; i++; }
      else return { value: out, end: i + 1 };
    } else if (c === '"') {
      return { value: out, end: i + 1 };
    } else if (c === '\\') {
      const e = text[++i];
      const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (width) {
        const hex = text.slice(i + 1, i + 1 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new YamlError(n, `a bad "\\${e}" escape`);
        out += String.fromCodePoint(parseInt(hex, 16));
        i += width;
      } else if (e !== undefined && e in ESCAPES) out += ESCAPES[e];
      else throw new YamlError(n, `an unknown escape "\\${e ?? ''}" in a double-quoted string`);
    } else out += c;
  }
  throw new YamlError(n, 'a quoted string is not closed on its line');
}

function readFlow(text: string, at: number, n: number): { node: YamlNode; end: number } {
  const open = text[at];
  const close = open === '{' ? '}' : ']';
  const entries: YamlEntry[] = [];
  const items: YamlNode[] = [];
  const seen = new Set<string>();
  let i = skipSpaces(text, at + 1);
  for (;;) {
    if (i >= text.length) throw new YamlError(n, `"${open}" is not closed on its line`);
    if (text[i] === close) {
      const node: YamlNode = open === '{' ? { kind: 'map', line: n, entries } : { kind: 'seq', line: n, items };
      return { node, end: i + 1 };
    }
    if (open === '{') {
      const key = readFlowScalar(text, i, n, true);
      if (key.node.kind !== 'scalar') throw new YamlError(n, 'a key in "{ }" must be a plain or quoted word');
      i = skipSpaces(text, key.end);
      if (text[i] !== ':') throw new YamlError(n, 'expected "key: value" inside "{ }"');
      const name = key.node.quoted ? String(key.node.value) : key.node.raw;
      refuseKeyName(name, n);
      if (seen.has(name)) throw new YamlError(n, `duplicate key "${name}"`);
      seen.add(name);
      i = skipSpaces(text, i + 1);
      const value = readFlowScalar(text, i, n, false);
      entries.push({ key: name, line: n, value: value.node });
      i = skipSpaces(text, value.end);
    } else {
      const value = readFlowScalar(text, i, n, false);
      items.push(value.node);
      i = skipSpaces(text, value.end);
    }
    if (text[i] === ',') i = skipSpaces(text, i + 1);
    else if (text[i] !== close) throw new YamlError(n, `expected "," or "${close}"`);
  }
}

function readFlowScalar(text: string, at: number, n: number, key: boolean): { node: YamlNode; end: number } {
  const c = text[at];
  if (c === '{' || c === '[') {
    if (key) throw new YamlError(n, 'a key in "{ }" must be a plain or quoted word');
    return readFlow(text, at, n);
  }
  if (c === '"' || c === "'") {
    const read = readQuoted(text, at, n);
    return { node: { kind: 'scalar', line: n, value: read.value, quoted: true, raw: text.slice(at, read.end) }, end: read.end };
  }
  let end = at;
  while (end < text.length) {
    const d = text[end];
    if (d === ',' || d === ']' || d === '}' || d === '[' || d === '{') break;
    if (d === ':' && (key || text[end + 1] === ' ' || end + 1 === text.length)) {
      if (!key) throw new YamlError(n, 'a ": " inside a plain value in "[ ]" or "{ }": quote it');
      break;
    }
    end++;
  }
  const raw = text.slice(at, end).trim();
  if (!raw) throw new YamlError(n, 'an empty value inside "[ ]" or "{ }"');
  return { node: plain(raw, n), end };
}

function skipSpaces(text: string, at: number): number {
  let i = at;
  while (text[i] === ' ') i++;
  return i;
}

function clip(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
