import { defaultFs, type FsReader } from '../lobby/gate.ts';
import type { YamlNode } from '../yaml.ts';
import type { Problem } from './types.ts';

// A team file never holds a credential. A value with a known key prefix, a private key or a URL
// with credentials refuses the file. A long random-looking string only warns: channel ids and
// slugs look like one. An absolute path that is a real directory is a location, not a value —
// a machine's temp path is long, dotless and absolute — but the shape alone silences nothing:
// a credential in path clothing (`/x/sk-…`) is not a directory, so it still warns.
export const KEY_PREFIXES = [
  'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-',
  'AKIA', 'ASIA', 'AIza', 'lin_api_', 'npm_', 'shpat_', 'dckr_pat_',
];

export function findSecrets(root: YamlNode, fs: FsReader = defaultFs): { refused: Problem[]; warned: Problem[] } {
  const refused: Problem[] = [];
  const warned: Problem[] = [];
  walk(root, (value, line) => {
    for (const word of value.split(/[\s"'=,;]+/)) {
      if (isKeyShaped(word)) {
        refused.push({ line, message: 'a value shaped like a key or token: a team file never holds a credential' });
        return;
      }
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      refused.push({ line, message: 'a private key: a team file never holds a credential' });
    } else if (URL_CREDENTIALS.test(value)) {
      refused.push({ line, message: 'a URL with credentials: a team file never holds a credential' });
    } else if (value.split(/\s+/).some((word) => looksRandom(word, fs))) {
      warned.push({ line, message: 'a long random-looking value: check it is not a credential' });
    }
  });
  return { refused, warned };
}

const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
/** The masker's URL rule is wider than the team-file check's: userinfo with only a user is a
 *  credential too, so the password is optional here and every URL on the line is masked. */
const URL_USERINFO_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+(?::[^\s/@]+)?@/gi;
const URL_USERINFO = /[^\s/:@]+(?::[^\s/@]+)?@$/;

/** The characters a prefixed credential's body is written in. */
const TOKEN_BODY = '[A-Za-z0-9_+=-]';

/** The prefix list as a regular-expression alternation, longest first. */
const PREFIX_ALTERNATION = [...KEY_PREFIXES].sort((a, b) => b.length - a.length).map(escapePattern).join('|');

/**
 * One key-shaped token wherever it sits: a known prefix followed by at least sixteen body
 * characters, with a non-token character (or the line's start) before it. Framing around a token
 * — a backtick, a bracket, a colon, an equals sign, a comma — is a boundary, not part of the
 * word; a prefix shape inside a longer word (`risk-…`) is not a token.
 */
const KEY_TOKEN = new RegExp(`(^|[^A-Za-z0-9_-])((?:${PREFIX_ALTERNATION})${TOKEN_BODY}{16,})`, 'g');

/** One token-body character: the characters a prefixed credential is written in. */
const TOKEN_CHARACTER = /[A-Za-z0-9_+=-]/;

type Span = { start: number; end: number };

/** A literal for a regular expression: a prefix is matched as written, not as a pattern. */
function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isKeyShaped(word: string): boolean {
  return KEY_PREFIXES.some((prefix) => word.startsWith(prefix) && word.length >= prefix.length + 16);
}

/** No line needs more than a couple of passes; the bound only stops a pathological loop. */
const MAX_MASK_PASSES = 4;

/**
 * The same judgement `findSecrets` makes, applied to a line of a seat's screen: every token shaped
 * like a key, every private-key header, every URL's userinfo and every random-looking word becomes
 * `[masked]`. The judgement is shared — a value the team-file check refuses or warns about is a
 * value a peek never prints — and the token scan is deliberately stricter: a screen wraps a token
 * in whatever punctuation the program printed, so the prefix is matched wherever it sits, while
 * the team-file check still splits a value into words. The randomness rule is shared as it is,
 * including its limits: `looksRandom` measures the entropy of the characters present, so a hex
 * commit id cannot clear its threshold and a UUID usually does not either.
 *
 * Every pattern is global — a line can carry more than one URL or token — and the output is
 * re-scanned until a pass changes nothing, so no known prefix or userinfo URL survives it.
 */
export function maskSecretsLine(line: string, fs: FsReader = defaultFs): string {
  let masked = line;
  for (let pass = 0; pass < MAX_MASK_PASSES; pass += 1) {
    const before = masked;
    masked = maskOnce(masked, fs);
    if (masked === before) break;
  }
  return masked;
}

function maskOnce(line: string, fs: FsReader): string {
  let masked = line.replace(URL_USERINFO_URL, (match) => match.replace(URL_USERINFO, '[masked]@'));
  masked = masked.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[masked]');
  masked = masked.replace(KEY_TOKEN, (_whole, separator: string) => `${separator}[masked]`);
  masked = replaceWords(masked, (word) => looksRandom(word, fs));
  return masked;
}

/**
 * Masks a screen: every row is masked as a line, and a credential the terminal wrapped over
 * two or more rows is masked on both sides of each join, so joining the printed rows recovers
 * nothing. A terminal pads a row out to its width, so the join is read without the padding: each
 * row is taken between the whitespace that surrounds its own text, and those texts are joined.
 * A row start and a row end are then token boundaries, exactly as a line start and end are —
 * the screen cannot tell a wrap from a real line break — and the same patterns judge the join as
 * judge a line (one source of truth). Only a span that crosses a join is taken from it: a token
 * (however the wrap fell inside it, even inside its prefix), a URL's userinfo, a private-key
 * header, or a random-looking word. A randomness judgement is made on the run and on every piece
 * of it between two of its boundaries — a wrap can join an ordinary word to a credential's front,
 * so the run alone may fail a judgement the credential's own piece passes. A private-key header is
 * judged by halves too: a row holding a start or an end marker is masked with the row it continues
 * on, the space a word wrap removes included. If any reading finds a token, every row it touches
 * is masked on that row; masking an ordinary word the reading also touched is the safe error. The
 * row count never changes: a peek prints the same number of rows it read; a UUID that spans a wrap
 * stays readable, while a wrapped long hex run is masked because it cannot be told from a secret.
 */
export function maskSecretRows(rows: readonly string[], fs: FsReader = defaultFs): string[] {
  // The screen without its padding, and where each character of it sits among the printed rows.
  const rowStarts: number[] = [];
  let printed = 0;
  for (const row of rows) {
    rowStarts.push(printed);
    printed += row.length;
  }
  const originals: number[] = [];
  const joins: number[] = [];
  let text = '';
  rows.forEach((row, index) => {
    const start = row.length - row.trimStart().length;
    const end = Math.max(start, row.trimEnd().length);
    for (let column = start; column < end; column += 1) {
      originals.push((rowStarts[index] ?? 0) + column);
      text += row[column] ?? '';
    }
    joins.push(text.length);
  });
  const spans: Span[] = [];
  for (const span of crossingSpans(text, joins, fs)) {
    const start = originals[span.start];
    const end = originals[span.end - 1];
    if (start !== undefined && end !== undefined) spans.push({ start, end: end + 1 });
  }
  const headerRows = headerMarkerRows(rows);
  if (spans.length === 0) {
    return rows.map((row, index) => (headerRows.has(index) ? '[masked]' : maskSecretsLine(row, fs)));
  }
  return rows.map((row, index) => {
    if (headerRows.has(index)) return '[masked]';
    const rowStart = rowStarts[index] ?? 0;
    const rowEnd = rowStart + row.length;
    const fragments: Span[] = [];
    for (const span of spans) {
      const start = Math.max(span.start, rowStart) - rowStart;
      const end = Math.min(span.end, rowEnd) - rowStart;
      if (start < end) fragments.push({ start, end });
    }
    if (fragments.length === 0) return maskSecretsLine(row, fs);
    fragments.sort((a, b) => a.start - b.start);
    const merged: Span[] = [];
    for (const fragment of fragments) {
      const last = merged[merged.length - 1];
      if (last !== undefined && fragment.start <= last.end) last.end = Math.max(last.end, fragment.end);
      else merged.push({ ...fragment });
    }
    let rebuilt = '';
    let cursor = 0;
    for (const fragment of merged) {
      rebuilt += `${row.slice(cursor, fragment.start)}[masked]`;
      cursor = fragment.end;
    }
    return maskSecretsLine(`${rebuilt}${row.slice(cursor)}`, fs);
  });
}

/**
 * Rows a private-key header marker touches. A wrap can fall at a space, and trimming a row
 * removes it, so neither the joined header nor one row alone holds the whole marker. A row
 * holding a start marker without its end half continues on the next row; a row holding the end
 * half without its start continues from the previous one; an end marker without its end half
 * continues on the next row too; a header whole on its row needs no neighbour. Masking a
 * neighbour an ordinary row shares is the safe error.
 */
function headerMarkerRows(rows: readonly string[]): Set<number> {
  const masked = new Set<number>();
  rows.forEach((row, index) => {
    const startHalf = row.includes('-----BEGIN');
    const endHalf = row.includes('PRIVATE KEY-----');
    const endMarker = row.includes('-----END');
    if (!startHalf && !endHalf && !endMarker) return;
    masked.add(index);
    if (((startHalf || endMarker) && !endHalf) && index + 1 < rows.length) masked.add(index + 1);
    if (endHalf && !startHalf && index > 0) masked.add(index - 1);
  });
  return masked;
}

/** The secret spans of the screen read without its padding that cross at least one row join. */
function crossingSpans(text: string, joins: readonly number[], fs: FsReader): Span[] {
  const spans: Span[] = [];
  const crosses = (start: number, end: number): boolean => joins.some((boundary) => start < boundary && boundary < end);

  for (const match of text.matchAll(URL_USERINFO_URL)) {
    const start = (match.index ?? 0) + match[0].indexOf('://') + 3;
    const end = (match.index ?? 0) + match[0].length - 1;
    // The whole URL decides the wrap, not the userinfo alone: a wrap right after the scheme
    // puts the entire credential in the next row, where no line-level URL rule could see it.
    if (crosses(match.index ?? 0, (match.index ?? 0) + match[0].length)) spans.push({ start, end });
  }
  // The space after a marker word can be the one a wrap removes, so the joined pattern lets it
  // go: the marker words themselves are contiguous in the joined reading whatever the split.
  for (const match of text.matchAll(/-----BEGIN[A-Z ]*PRIVATE[ ]?KEY-----/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (crosses(start, end)) spans.push({ start, end });
  }
  // The end line's marker words can wrap anywhere too, and the row halves rule only reaches the
  // marker's own row and one neighbour: a wrap inside `-----END` two rows above the end half
  // would leave the first piece. The joined reading has no spaces to lose inside the marker
  // words, so it matches the end line over any split.
  for (const match of text.matchAll(/-----END[A-Z ]*PRIVATE[ ]?KEY-----/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (crosses(start, end)) spans.push({ start, end });
  }
  // A token is judged inside a token-character run that crosses a join: the wrap may have fallen
  // anywhere inside the token, the prefix itself included, and the join is a boundary even when
  // the joined characters read as one longer word. The run's whole tail is the body the reading
  // cannot bound, so the span reaches the run's end.
  for (let runStart = 0; runStart < text.length;) {
    if (!TOKEN_CHARACTER.test(text.charAt(runStart))) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < text.length && TOKEN_CHARACTER.test(text.charAt(runEnd))) runEnd += 1;
    if (joins.some((boundary) => boundary > runStart && boundary < runEnd)) {
      for (let start = runStart; start < runEnd; start += 1) {
        if (prefixWithBody(text, start, runEnd)) {
          spans.push({ start, end: runEnd });
          break;
        }
      }
    }
    runStart = runEnd;
  }
  // A randomness judgement is made on every reading of the run: the run itself, and every piece
  // of it between two of its boundaries — a row start and a row end are both boundaries, and a
  // wrap can join an ordinary word to the front of a credential. The run alone can fail a
  // judgement the credential's own piece passes. A match masks that piece: it is bounded by the
  // same boundaries the judgement used, so no part of the reading is left behind.
  for (const match of text.matchAll(/(^|[\s"'=,;])([^\s"'=,;]+)/g)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const end = (match.index ?? 0) + match[0].length;
    if (!crosses(start, end)) continue;
    const boundaries = [start, ...joins.filter((boundary) => boundary > start && boundary < end), end];
    for (let from = 0; from < boundaries.length - 1; from += 1) {
      for (let to = from + 1; to < boundaries.length; to += 1) {
        const pieceStart = boundaries[from] ?? 0;
        const pieceEnd = boundaries[to] ?? 0;
        const piece = text.slice(pieceStart, pieceEnd);
        // A base64 word's `=` padding is a separator to the word scan, so it falls outside the
        // match; it is part of the credential and is masked with it.
        let maskedEnd = pieceEnd;
        while (text.charAt(maskedEnd) === '=') maskedEnd += 1;
        if (looksRandom(piece, fs) || looksHexSecret(piece)) spans.push({ start: pieceStart, end: maskedEnd });
      }
    }
  }
  return spans;
}

/** True when a known prefix starts here and at least sixteen body characters remain in the run. */
function prefixWithBody(text: string, start: number, runEnd: number): boolean {
  return KEY_PREFIXES.some((prefix) => runEnd - start - prefix.length >= 16 && text.startsWith(prefix, start));
}

/** Replaces the words `shaped` accepts, keeping each separator exactly as it was. */
function replaceWords(line: string, shaped: (word: string) => boolean): string {
  return line.replace(/(^|[\s"'=,;])([^\s"'=,;]+)/g, (whole, separator: string, word: string) =>
    shaped(word) ? `${separator}[masked]` : whole,
  );
}

function walk(node: YamlNode, visit: (value: string, line: number) => void): void {
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string') visit(node.value, node.line);
  } else if (node.kind === 'seq') {
    for (const item of node.items) walk(item, visit);
  } else {
    for (const entry of node.entries) walk(entry.value, visit);
  }
}

function looksRandom(word: string, fs: FsReader): boolean {
  if (word.length < 32 || (isAbsolutePath(word) && isDirectory(fs, word)) || !/^[A-Za-z0-9+/_=-]+$/.test(word)) return false;
  const counts = new Map<string, number>();
  for (const c of word) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) entropy -= (count / word.length) * Math.log2(count / word.length);
  return entropy > 4;
}

/**
 * A plain hex run as long as a key. A hex alphabet caps entropy at four bits per character, so a
 * hex credential can never clear `looksRandom`'s threshold; a wrapped screen cannot tell it from
 * a hash, so it is masked there. The line rule keeps a single-row sha readable.
 */
function looksHexSecret(word: string): boolean {
  return word.length >= 32 && /^[0-9a-fA-F]+$/.test(word);
}

/**
 * Two or more path segments, starting at the root. The shape alone exempts nothing: it only names
 * the words worth an lstat, and only a real directory is a location rather than a value.
 */
function isAbsolutePath(word: string): boolean {
  return /^\/[^/]+\//.test(word);
}

/** Fail closed: only a successful lstat that says directory exempts. Absence, a file, any error warns. */
function isDirectory(fs: FsReader, word: string): boolean {
  try {
    return fs.lstat(word).isDirectory();
  } catch {
    return false;
  }
}
