import { defaultFs, type FsReader, type FsStats } from '../lobby/gate.ts';
import type { YamlNode } from '../yaml.ts';
import type { Problem } from './types.ts';

// A team file never holds a credential. A value with a known key prefix, a private key or a URL
// with credentials refuses the file. A long random-looking string only warns: channel ids and
// slugs look like one. An absolute path that is a real directory is a location, not a value —
// a machine's temp path is long, dotless and absolute — but the shape alone silences nothing:
// a credential in path clothing (`/x/sk-…`) is not a directory, and it keeps its token shape.
export const KEY_PREFIXES = [
  'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-',
  'AKIA', 'ASIA', 'AIza', 'lin_api_', 'npm_', 'shpat_', 'dckr_pat_',
];

/** The characters a prefixed credential's body is written in. */
const TOKEN_BODY = '[A-Za-z0-9_+=-]';

/** The prefix list as a regular-expression alternation, longest first. */
const PREFIX_ALTERNATION = [...KEY_PREFIXES].sort((a, b) => b.length - a.length).map(escapePattern).join('|');

/**
 * The one set of credential shapes both readers judge by: the team-file check and the screen
 * masker build every pattern from this source, so the two cannot drift. A value the check refuses
 * is a value a peek never prints, and a token the masker masks is one the check refuses.
 */
const SECRET_SHAPES = {
  /**
   * One key-shaped token wherever it sits: a known prefix followed by at least sixteen body
   * characters, with a non-token character (or the line's start) before it. Framing around a
   * token — a backtick, a bracket, a colon, an equals sign, a comma — is a boundary, not part of
   * the word; a prefix shape inside a longer word (`risk-…`) is not a token.
   */
  keyToken: `(^|[^A-Za-z0-9_-])((?:${PREFIX_ALTERNATION})${TOKEN_BODY}{16,})`,
  /**
   * A URL's userinfo — a user, and the password when one is written — captured with the scheme
   * that precedes it. A user with no password is userinfo too, so the password is optional; the
   * masker keeps the scheme and masks the rest, and the check refuses the value.
   */
  urlUserinfo: '([a-z][a-z0-9+.-]*:\\/\\/)[^\\s\\/:@]+(?::[^\\s/@]+)?@',
  /**
   * A private-key header. A screen can wrap the header's words and drop the space between them,
   * so whitespace between them is any run here; the check reads the same shape in a value.
   */
  privateKey: '-----BEGIN[\\sA-Z]*?PRIVATE\\s*KEY-----',
} as const;

/** A fresh pattern from the one set. A pattern with `g` carries a last index between reads, and
 *  every reader starts at its own beginning. */
function secretPattern(shape: keyof typeof SECRET_SHAPES, flags = ''): RegExp {
  return new RegExp(SECRET_SHAPES[shape], flags);
}

/**
 * A team file's values, judged by the same shapes the screen masker masks. A credential keeps
 * its token shape through whatever punctuation frames it, so a framed key is refused exactly as
 * a bare one is.
 */
export function findSecrets(root: YamlNode, fs: FsReader = defaultFs): { refused: Problem[]; warned: Problem[] } {
  const refused: Problem[] = [];
  const warned: Problem[] = [];
  walk(root, (value, line, field) => {
    if (keyRefused(value, field, fs)) {
      refused.push({ line, message: 'a value shaped like a key or token: a team file never holds a credential' });
      return;
    }
    if (secretPattern('privateKey').test(value)) {
      refused.push({ line, message: 'a private key: a team file never holds a credential' });
    } else if (secretPattern('urlUserinfo', 'i').test(value)) {
      refused.push({ line, message: 'a URL with credentials: a team file never holds a credential' });
    } else if (value.split(/\s+/).some((word) => looksRandom(word, fs))) {
      warned.push({ line, message: 'a long random-looking value: check it is not a credential' });
    }
  });
  return { refused, warned };
}

/**
 * True when a key-shaped token in the value is a credential rather than a location. The check and
 * the masker share one token shape, but they do not owe the same verdict: a refusal blocks a real
 * file, so a legitimate path must not be refused for a shape inside it. A token after a `/` is
 * written as part of a path: a trust line keeps the warning it has always given, and a real
 * absolute directory is a location; every other token is a credential, however punctuation
 * frames it.
 */
function keyRefused(value: string, field: readonly string[], fs: FsReader): boolean {
  for (const match of value.matchAll(secretPattern('keyToken', 'g'))) {
    const separator = match[1] ?? '';
    const tokenStart = (match.index ?? 0) + separator.length;
    if (separator !== '/') return true;
    const word = wordAround(value, tokenStart);
    // A trust line keeps the earlier verdict it has always had: a warning, never a refusal, for
    // a token written as part of a path there.
    if (field[0] === 'trust') continue;
    // A location the file itself names is exempt: the whole value is one absolute path under a
    // path-valued field, and it resolves to this user's real directory with no symbolic link in
    // any component. A launch line, a command and free text are never locations, however a path
    // shape sits in them.
    if (locationPath(value, word, field, fs)) continue;
    return true;
  }
  return false;
}

/**
 * The schema's path-valued fields: a value here is a location the file names, not free text. A
 * launch line, a command or any other value is never in this list, however path-shaped it looks.
 */
const PATH_FIELDS: readonly (readonly string[])[] = [
  ['lobby'],
  ['workspace', 'path'],
  ['workspace', 'protected'],
  ['seats', 'reach', 'guard_dir'],
  ['watch', 'queue_dir'],
];

/** Whether a value sits under a field the team-file schema types as a path. */
function pathField(field: readonly string[]): boolean {
  return PATH_FIELDS.some((path) => path.length === field.length && path.every((key, at) => key === field[at]));
}

/**
 * Whether a key-shaped token is part of a location rather than a credential. The exemption is
 * closed: the whole scalar is exactly that one absolute path — no other words, no punctuation —
 * under a path-valued field, and the path is a directory this user owns whose every component is
 * a real name, never a symbolic link. A path with a link anywhere in it could name a folder other
 * than the one the file writes, so it keeps the token's shape.
 */
function locationPath(value: string, word: string, field: readonly string[], fs: FsReader): boolean {
  if (value !== word) return false;
  if (!pathField(field)) return false;
  if (!word.startsWith('/')) return false;
  return realDirectory(fs, word);
}

/**
 * Whether the path names a directory this user owns, with no symbolic link in any component.
 * Every prefix is lstatted and never followed: following an intermediate link is exactly how a
 * path-shaped value would reach a folder the file does not appear to name.
 */
function realDirectory(fs: FsReader, path: string): boolean {
  const mine = process.getuid?.() ?? 0;
  let walked = '';
  let last: FsStats | null = null;
  for (const part of path.split('/')) {
    if (part === '') continue;
    walked += `/${part}`;
    let stats: FsStats;
    try {
      stats = fs.lstat(walked);
    } catch {
      return false;
    }
    if (stats.isSymbolicLink()) return false;
    last = stats;
  }
  if (last === null) return false;
  return last.isDirectory() && last.uid === mine;
}

/** The whitespace-delimited word around a position: a path is judged whole, as the random rule reads it. */
function wordAround(value: string, position: number): string {
  let start = position;
  while (start > 0 && !/\s/.test(value.charAt(start - 1))) start -= 1;
  let end = position;
  while (end < value.length && !/\s/.test(value.charAt(end))) end += 1;
  return value.slice(start, end);
}

/** Every URL on a line, with its userinfo: the masker rewrites each match to `scheme[masked]@`. */
const URL_USERINFO_URL = secretPattern('urlUserinfo', 'gi');

/** One key-shaped token wherever it sits, for a line's replacement scan. */
const KEY_TOKEN = secretPattern('keyToken', 'g');

/** A private-key header on a line. */
const PRIVATE_KEY = secretPattern('privateKey', 'g');

/** One token-body character: the characters a prefixed credential is written in. */
const TOKEN_CHARACTER = /[A-Za-z0-9_+=-]/;

type Span = { start: number; end: number };

/** A literal for a regular expression: a prefix is matched as written, not as a pattern. */
function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** No line needs more than a couple of passes; the bound only stops a pathological loop. */
const MAX_MASK_PASSES = 4;

/**
 * The same judgement `findSecrets` makes, applied to a line of a seat's screen: every token shaped
 * like a key, every private-key header, every URL's userinfo and every random-looking word becomes
 * `[masked]`. The judgement is shared — a value the team-file check refuses or warns about is a
 * value a peek never prints — and both readers take their tokens from one set of shapes, so a
 * prefix framed by a backtick, a bracket or a colon is a token to each of them. The randomness rule
 * is shared as it is, including its limits: `looksRandom` measures the entropy of the characters
 * present, so a hex commit id cannot clear its threshold and a UUID usually does not either.
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
  let masked = line.replace(URL_USERINFO_URL, '$1[masked]@');
  masked = masked.replace(PRIVATE_KEY, '[masked]');
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
 * on, the whitespace a word wrap removes included. If any reading finds a token, every row it touches
 * is masked on that row; masking an ordinary word the reading also touched is the safe error. The
 * row count never changes: a peek prints the same number of rows it read; a UUID that spans a wrap
 * stays readable, and a long hex run is masked only where a row join falls inside it, so a sha
 * complete on its row stays readable.
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
 * continues on the next row too; a header whole on its row needs no neighbour. Whitespace
 * between the marker words may be a space or a tab, in any run. Masking a neighbour an ordinary
 * row shares is the safe error.
 */
function headerMarkerRows(rows: readonly string[]): Set<number> {
  const masked = new Set<number>();
  rows.forEach((row, index) => {
    const startHalf = row.includes('-----BEGIN');
    const endHalf = /PRIVATE\s*KEY-----/.test(row);
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
  // The whitespace between marker words can be the one a wrap removes, or a tab the screen
  // carries where the header has a space: the joined pattern accepts no whitespace or any run,
  // so the marker words themselves are contiguous in the joined reading whatever the split.
  for (const match of text.matchAll(PRIVATE_KEY)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (crosses(start, end)) spans.push({ start, end });
  }
  // The end line's marker words can wrap anywhere too, and the row halves rule only reaches the
  // marker's own row and one neighbour: a wrap inside `-----END` two rows above the end half
  // would leave the first piece. The joined reading has no spaces to lose inside the marker
  // words, so it matches the end line over any split and any whitespace run.
  for (const match of text.matchAll(/-----END[\sA-Z]*?PRIVATE\s*KEY-----/g)) {
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
  // A pure-hex run is judged on the whole joined run, not on each reading of it: it is a
  // wrapped hex credential only when a row join falls inside the run. A run complete on its row
  // (the character after the join is not hex) looks like a commit id and stays readable, exactly
  // as the line rule leaves it.
  for (let runStart = 0; runStart < text.length;) {
    if (!/[0-9a-fA-F]/.test(text.charAt(runStart))) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < text.length && /[0-9a-fA-F]/.test(text.charAt(runEnd))) runEnd += 1;
    if (looksHexSecret(text.slice(runStart, runEnd)) && joins.some((boundary) => boundary > runStart && boundary < runEnd)) {
      spans.push({ start: runStart, end: runEnd });
    }
    runStart = runEnd;
  }
  // A randomness judgement is made on every reading of the run: the run itself, and every piece
  // of it between two of its boundaries — a row start and a row end are both boundaries, and a
  // wrap can join an ordinary word to the front of a credential. The run alone can fail a
  // judgement the credential's own piece passes. A match masks that piece: it is bounded by the
  // same boundaries the judgement used, so no part of the reading is left behind. A join that
  // ends a hex run complete on its row does not make one word of the run and the next row's
  // word: no reading crosses that join, so a readable sha does not drag its neighbour into a
  // judgement.
  for (const match of text.matchAll(/(^|[\s"'=,;])([^\s"'=,;]+)/g)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const end = (match.index ?? 0) + match[0].length;
    if (!crosses(start, end)) continue;
    const boundaries = [start, ...joins.filter((boundary) => boundary > start && boundary < end), end];
    const complete = joins.filter((boundary) =>
      boundary > start && boundary < end && completeHexBoundary(text, joins, boundary),
    );
    for (let from = 0; from < boundaries.length - 1; from += 1) {
      for (let to = from + 1; to < boundaries.length; to += 1) {
        const pieceStart = boundaries[from] ?? 0;
        const pieceEnd = boundaries[to] ?? 0;
        if (complete.some((boundary) => pieceStart < boundary && boundary < pieceEnd)) continue;
        const piece = text.slice(pieceStart, pieceEnd);
        // A base64 word's `=` padding is a separator to the word scan, so it falls outside the
        // match; it is part of the credential and is masked with it.
        let maskedEnd = pieceEnd;
        while (text.charAt(maskedEnd) === '=') maskedEnd += 1;
        if (looksRandom(piece, fs)) spans.push({ start: pieceStart, end: maskedEnd });
      }
    }
  }
  return spans;
}

/**
 * True when the join ends a pure-hex run that is complete on its row: at least 32 hex characters
 * reach the join with no row boundary inside them, and the character after the join is not hex.
 * A sha cut mid-run still has a join inside the run, so it is judged as the wrapped run it is.
 */
function completeHexBoundary(text: string, joins: readonly number[], boundary: number): boolean {
  if (/[0-9a-fA-F]/.test(text.charAt(boundary))) return false;
  let start = boundary;
  while (start > 0 && /[0-9a-fA-F]/.test(text.charAt(start - 1))) start -= 1;
  if (!looksHexSecret(text.slice(start, boundary))) return false;
  return !joins.some((join) => join > start && join < boundary);
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

/** A value under its field path, so a rule can tell a trust line from any other value. */
function walk(node: YamlNode, visit: (value: string, line: number, field: readonly string[]) => void, field: readonly string[] = []): void {
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string') visit(node.value, node.line, field);
  } else if (node.kind === 'seq') {
    for (const item of node.items) walk(item, visit, field);
  } else {
    for (const entry of node.entries) walk(entry.value, visit, [...field, entry.key]);
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
 * hex credential can never clear `looksRandom`'s threshold. A screen masks such a run only where
 * a row join falls inside it: a wrap cannot tell a cut run from a secret, while a run complete
 * on its row looks like a commit id and is shown, as the line rule shows it.
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
