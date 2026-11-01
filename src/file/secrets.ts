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

/** A row that ends in a known prefix and any body characters: the wrap left too little of the
 *  token in this row for KEY_TOKEN to see it whole, so the next row decides. */
const ROW_END_TOKEN = new RegExp(`(^|[^A-Za-z0-9_-])((?:${PREFIX_ALTERNATION})${TOKEN_BODY}*)$`);

/** One token-body character, for asking whether a row starts with the token's continuation. */
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
 * nothing. The same patterns judge the join as judge a line — one source of truth — and only a
 * span that crosses a join is taken from it: a token (however the wrap fell inside it), a URL's
 * userinfo, a private-key header, or a random-looking word. A row that ends in a known prefix
 * with too little body to be key-shaped on its own is masked from the prefix to its end when
 * the next row begins with token characters. The row count never changes: a peek prints the
 * same number of rows it read, and a sha or UUID that spans a wrap stays readable.
 */
export function maskSecretRows(rows: readonly string[], fs: FsReader = defaultFs): string[] {
  const rowEnds: number[] = [];
  let total = 0;
  for (const row of rows) {
    total += row.length;
    rowEnds.push(total);
  }
  const spans = crossingSpans(rows.join(''), rowEnds, fs);
  if (spans.length === 0) return rows.map((row) => maskSecretsLine(row, fs));
  return rows.map((row, index) => {
    const rowStart = index === 0 ? 0 : (rowEnds[index - 1] ?? 0);
    const rowEnd = rowEnds[index] ?? 0;
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

/** The secret spans of the joined rows that cross at least one row join. */
function crossingSpans(text: string, rowEnds: readonly number[], fs: FsReader): Span[] {
  const spans: Span[] = [];
  const crosses = (start: number, end: number): boolean => rowEnds.some((boundary) => start < boundary && boundary < end);

  for (const match of text.matchAll(URL_USERINFO_URL)) {
    const start = (match.index ?? 0) + match[0].indexOf('://') + 3;
    const end = (match.index ?? 0) + match[0].length - 1;
    // The whole URL decides the wrap, not the userinfo alone: a wrap right after the scheme
    // puts the entire credential in the next row, where no line-level URL rule could see it.
    if (crosses(match.index ?? 0, (match.index ?? 0) + match[0].length)) spans.push({ start, end });
  }
  for (const match of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (crosses(start, end)) spans.push({ start, end });
  }
  for (const match of text.matchAll(KEY_TOKEN)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const end = (match.index ?? 0) + match[0].length;
    if (crosses(start, end)) spans.push({ start, end });
  }
  for (const match of text.matchAll(/(^|[\s"'=,;])([^\s"'=,;]+)/g)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const end = (match.index ?? 0) + match[0].length;
    if (crosses(start, end) && looksRandom(match[2] ?? '', fs)) spans.push({ start, end });
  }
  let rowStart = 0;
  for (const rowEnd of rowEnds) {
    if (rowEnd < text.length && TOKEN_CHARACTER.test(text[rowEnd] ?? '')) {
      const tail = ROW_END_TOKEN.exec(text.slice(rowStart, rowEnd));
      if (tail !== null) {
        const start = rowStart + (tail.index ?? 0) + (tail[1] ?? '').length;
        const head = /^[A-Za-z0-9_+=-]*/.exec(text.slice(rowEnd))?.[0] ?? '';
        spans.push({ start, end: rowEnd + head.length });
      }
    }
    rowStart = rowEnd;
  }
  return spans;
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
