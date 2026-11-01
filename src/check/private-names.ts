// External private names and phrases for the tracked public tree.
//
// The team file declares the public policy; `src/check/public-names.ts` answers for that policy
// over the index. This module answers a second question the repository cannot answer from tracked
// state: does the tree carry a name or phrase from an external private list? The lists live outside
// the repository, are never committed, and are read only when the caller supplies their paths (or
// when the default machine paths exist).
//
// The engine is the one the project documents: POSIX extended regular expressions, executed by
// `git grep -E` with the pattern list on standard input. A pattern is never placed in argv, so a
// process listing cannot publish it, and no matched text is ever returned or printed. The supported
// grammar is deliberately smaller than every host's regex library: a backslash before an ASCII
// letter or digit (a word-boundary, whitespace, digit or backreference escape), lookaround and
// backreferences are rejected, because the engine on different hosts does not agree on them. A
// word boundary is written as an explicit alternation, and whitespace as a POSIX bracket
// expression such as `[[:space:]]`. An invalid entry is reported by origin, class and ordinal
// only; the pattern text, its length, a hash and the engine's stderr never reach the caller.
//
// The tracked set comes from `git ls-files`; the content pass runs `git grep` over the working
// tree of those tracked files, so an edited but unstaged file is read as the text that `git add`
// would stage. A tracked path containing a newline is refused, because the path pass maps a hit
// back through a one-path-per-line list.
//
// A source is one file. A class header sets the scope for the entries that follow it. A
// non-comment `prepush-only:<regex>` entry is always diff-only. Identical strings across sources
// are normalized once: the first occurrence supplies the origin, the effective scope is the
// intersection of every occurrence's scope, and the duplicate count is reported. Intersection is
// what keeps a diff-only class c entry from becoming a tracked-tree rule through source order.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a private entry reads: a tracked path, a tracked file's text, or the pre-push diff. */
export type PrivateScope = 'path' | 'content' | 'diff';

export const PRIVATE_SCOPES: readonly PrivateScope[] = ['path', 'content', 'diff'];

/** The non-comment line prefix that marks a diff-only entry in either source. */
export const PREPUSH_PREFIX = 'prepush-only:';

export interface PrivateEntry {
  /** The expression as written in the source. Never print this field. */
  source: string;
  scope: readonly PrivateScope[];
  /** The source label, for example `names` or `phrases`. */
  origin: string;
  /** The class letter from the most recent class header, when the source uses one. */
  className?: string;
  /** The 1-based entry ordinal within the source, counting prepush-only entries. */
  ordinal: number;
  /** The 1-based line in the source file. */
  line: number;
}

export interface PrivateSource {
  label: string;
  path: string;
  entries: PrivateEntry[];
}

export type PrivateListRead =
  | { source: PrivateSource }
  | { missing: true; path: string }
  | { problem: string };

/** One effective rule after cross-source normalization. Never print `source`. */
export interface PrivateRule {
  source: string;
  scope: readonly PrivateScope[];
  occurrences: PrivateEntry[];
}

export interface PrivateRuleSet {
  rules: PrivateRule[];
  duplicates: number;
  diffOnly: number;
}

/** A hit names where and which entry, never the matched text. */
export interface PrivateHit {
  origin: string;
  className?: string;
  ordinal: number;
  path: string;
  /** The 1-based content line; 0 for a path hit. */
  line: number;
}

export interface PrivateLineHit {
  origin: string;
  className?: string;
  ordinal: number;
  /** The 1-based line in the supplied text. */
  line: number;
}

export type PrivateTreeScan =
  | { hits: PrivateHit[]; scanned: number; rules: number; duplicates: number; diffOnly: number }
  | { problem: string };

export type PrivateLineScan =
  | { hits: PrivateLineHit[]; rules: number; duplicates: number; diffOnly: number }
  | { problem: string };

/** The default machine paths for the two external sources. */
export function defaultPrivateListPaths(): { names: string; phrases: string } {
  const base = join(homedir(), '.config', 'team');
  return {
    names: join(base, 'private-names.txt'),
    phrases: join(base, 'private-phrases-prepush.txt'),
  };
}

/** True when the source text uses a construct the authoritative engine does not promise. */
function unsupportedConstruct(source: string): boolean {
  if (source.includes('(?') || source.includes('(?<')) return true;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\\') continue;
    const next = source[index + 1];
    if (next !== undefined && /[A-Za-z0-9]/.test(next)) return true;
    index += 1; // a backslash escapes the next character, whatever it is
  }
  return false;
}

function parseScopes(text: string): PrivateScope[] | null {
  const pieces = text.split(',').map((piece) => piece.trim());
  if (pieces.length === 0 || pieces.some((piece) => !PRIVATE_SCOPES.includes(piece as PrivateScope))) {
    return null;
  }
  return [...new Set(pieces)] as PrivateScope[];
}

/**
 * Reads one external source. A missing file is `missing` when `required` is false (the caller
 * decides whether a visible skip is acceptable), and a problem when it is true. An existing file
 * must be a regular file with no group or other permission bits, or the check refuses rather than
 * scanning a list another account can read. An existing file with no entries is a problem: a
 * configured list that cannot look must not report the tree clean.
 */
export function readPrivateList(
  path: string,
  label: string,
  options: { required?: boolean } = {},
): PrivateListRead {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return options.required === true ? { problem: `private list not present: ${path}` } : { missing: true, path };
    }
    return { problem: `cannot read private list: ${path}` };
  }
  if (!stat.isFile()) return { problem: `private list is not a regular file: ${path}` };
  if ((stat.mode & 0o077) !== 0) {
    return { problem: `private list is readable by group or other (mode ${(stat.mode & 0o777).toString(8)}): ${path}` };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { problem: `cannot read private list: ${path}` };
  }
  const entries: PrivateEntry[] = [];
  let className: string | undefined;
  let scope: PrivateScope[] = [...PRIVATE_SCOPES];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      if (!line.startsWith('# class:')) continue;
      const header = line.match(/^#\s*class:\s*([a-z])(?:\s+(.*))?$/);
      if (header === null) return { problem: `${label} line ${String(index + 1)}: malformed class header` };
      className = header[1];
      const description = header[2] ?? '';
      const scopeMatch = description.match(/;\s*scope=([a-z,]+)\s*$/);
      if (scopeMatch === null) {
        if (description.includes('scope=')) {
          return { problem: `${label} class ${className}: malformed scope` };
        }
        scope = [...PRIVATE_SCOPES];
      } else {
        const parsed = parseScopes(scopeMatch[1]!);
        if (parsed === null) return { problem: `${label} class ${className}: unknown scope` };
        scope = parsed;
      }
      continue;
    }
    const prepush = line.startsWith(PREPUSH_PREFIX);
    const source = prepush ? line.slice(PREPUSH_PREFIX.length).trim() : line;
    if (source === '') {
      return { problem: `${label} line ${String(index + 1)}: empty private entry` };
    }
    if (unsupportedConstruct(source)) {
      return {
        problem: `private entry uses an unsupported construct: ${label}${className === undefined ? '' : ` class ${className}`} entry ${String(entries.length + 1)}`,
      };
    }
    entries.push({
      source,
      scope: prepush ? ['diff'] : [...scope],
      origin: label,
      ...(className === undefined ? {} : { className }),
      ordinal: entries.length + 1,
      line: index + 1,
    });
  }
  if (entries.length === 0) return { problem: `private list has no entries: ${path}` };
  return { source: { label, path, entries } };
}

/**
 * Normalizes identical strings across sources. The first occurrence supplies origin and class;
 * the effective scope is the intersection of every occurrence's scope. Disjoint scopes are a
 * problem rather than a silent drop: the list's intent cannot be recovered by guessing.
 */
export function normalizePrivateRules(sources: readonly PrivateSource[]): PrivateRuleSet | { problem: string } {
  const bySource = new Map<string, PrivateRule>();
  let total = 0;
  for (const source of sources) {
    for (const entry of source.entries) {
      total += 1;
      const existing = bySource.get(entry.source);
      if (existing === undefined) {
        bySource.set(entry.source, { source: entry.source, scope: [...entry.scope], occurrences: [entry] });
        continue;
      }
      const narrowed = existing.scope.filter((item) => entry.scope.includes(item));
      if (narrowed.length === 0) {
        return {
          problem: `private entry scopes do not intersect: ${entry.origin}${entry.className === undefined ? '' : ` class ${entry.className}`} entry ${String(entry.ordinal)}`,
        };
      }
      existing.scope = narrowed;
      existing.occurrences.push(entry);
    }
  }
  const rules = [...bySource.values()];
  return {
    rules,
    duplicates: total - rules.length,
    diffOnly: rules.filter((rule) => !rule.scope.includes('path') && !rule.scope.includes('content')).length,
  };
}

interface Scratch {
  path: string;
  problem?: string;
}

/** A commitless repository whose only files are public scratch data. */
function scratchRepository(): Scratch {
  let path: string;
  try {
    path = mkdtempSync(join(tmpdir(), 'team-private-'));
  } catch {
    return { path: '', problem: 'cannot create the private scan scratch folder' };
  }
  const init = spawnSync('git', ['init', '--quiet', path], { encoding: 'utf8' });
  if (init.status !== 0) return { path, problem: 'cannot initialize the private scan scratch repository' };
  return { path };
}

function addScratch(path: string, files: readonly string[]): boolean {
  const added = spawnSync('git', ['-C', path, 'add', '--', ...files], { encoding: 'utf8' });
  return added.status === 0;
}

/** Runs the authoritative engine with the pattern on standard input; stderr is never forwarded. */
function grep(repo: string, pattern: string, pathspec: string): { status: number; stdout: string } {
  const run = spawnSync('git', ['-C', repo, 'grep', '--no-color', '-z', '-n', '-I', '-E', '-f', '-', '--', pathspec], {
    input: `${pattern}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status ?? -1, stdout: run.stdout ?? '' };
}

/** Validates every rule through the same engine; a failure names only origin, class and ordinal. */
function validate(rules: readonly PrivateRule[], scratch: string): { problem: string } | null {
  for (const rule of rules) {
    const run = grep(scratch, rule.source, 'empty.txt');
    if (run.status !== 0 && run.status !== 1) {
      const first = rule.occurrences[0]!;
      return {
        problem: `invalid private entry: ${first.origin}${first.className === undefined ? '' : ` class ${first.className}`} entry ${String(first.ordinal)}`,
      };
    }
  }
  return null;
}

function trackedFiles(root: string): { files: string[] } | { problem: string } {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.error !== undefined || listed.status !== 0) return { problem: `cannot list the tracked files of ${root}` };
  return { files: listed.stdout.split('\0').filter(Boolean) };
}

/** Reads git grep's NUL-delimited records: path NUL line NUL text newline. Text is discarded. */
function records(stdout: string): { records: { path: string; line: number }[] } | { problem: string } {
  const out: { path: string; line: number }[] = [];
  let rest = stdout;
  while (rest.length > 0) {
    const pathEnd = rest.indexOf('\0');
    if (pathEnd < 0) return { problem: 'the private scan returned an unparseable record' };
    const path = rest.slice(0, pathEnd);
    rest = rest.slice(pathEnd + 1);
    const lineEnd = rest.indexOf('\0');
    if (lineEnd < 0) return { problem: 'the private scan returned an unparseable record' };
    const line = Number(rest.slice(0, lineEnd));
    rest = rest.slice(lineEnd + 1);
    const textEnd = rest.indexOf('\n');
    if (textEnd < 0) return { problem: 'the private scan returned an unparseable record' };
    rest = rest.slice(textEnd + 1);
    if (path === '' || !Number.isInteger(line)) {
      return { problem: 'the private scan returned an unparseable record' };
    }
    out.push({ path, line });
  }
  return { records: out };
}

/**
 * Scans the tracked tree for both path and content scopes. Diff-only rules are counted and
 * skipped. The scan validates every rule first, including diff-only rules, so a broken entry in a
 * source never hides behind a scope that this pass does not read.
 */
export function scanPrivateTree(root: string, sources: readonly PrivateSource[]): PrivateTreeScan {
  const normalized = normalizePrivateRules(sources);
  if ('problem' in normalized) return normalized;
  const tracked = trackedFiles(root);
  if ('problem' in tracked) return tracked;
  // The path scan maps a hit's line in paths.txt back to the tracked file at that position, so
  // one path per line must hold. A newline in a tracked path would shift every later mapping.
  if (normalized.rules.some((rule) => rule.scope.includes('path')) && tracked.files.some((file) => file.includes('\n'))) {
    return { problem: 'a tracked path contains a newline, so the private path scan cannot map its results' };
  }
  if (normalized.rules.length === 0) {
    return { hits: [], scanned: tracked.files.length, rules: 0, duplicates: 0, diffOnly: 0 };
  }
  const scratch = scratchRepository();
  if (scratch.problem !== undefined) {
    if (scratch.path !== '') rmSync(scratch.path, { recursive: true, force: true });
    return { problem: scratch.problem };
  }
  try {
    writeFileSync(join(scratch.path, 'empty.txt'), '', { mode: 0o600 });
    writeFileSync(join(scratch.path, 'paths.txt'), tracked.files.join('\n') + '\n', { mode: 0o600 });
    if (!addScratch(scratch.path, ['empty.txt', 'paths.txt'])) {
      return { problem: 'cannot stage the private scan scratch repository' };
    }
    const invalid = validate(normalized.rules, scratch.path);
    if (invalid !== null) return invalid;

    const hits: PrivateHit[] = [];
    for (const rule of normalized.rules) {
      const first = rule.occurrences[0]!;
      if (rule.scope.includes('path')) {
        const run = grep(scratch.path, rule.source, 'paths.txt');
        if (run.status !== 0 && run.status !== 1) return { problem: 'the private path scan could not run' };
        if (run.status === 0) {
          const parsed = records(run.stdout);
          if ('problem' in parsed) return parsed;
          for (const record of parsed.records) {
            if (record.path !== 'paths.txt') return { problem: 'the private path scan returned an unknown record' };
            const path = tracked.files[record.line - 1];
            if (path === undefined) return { problem: 'the private path scan returned an unknown record' };
            hits.push({
              origin: first.origin,
              ...(first.className === undefined ? {} : { className: first.className }),
              ordinal: first.ordinal,
              path,
              line: 0,
            });
          }
        }
      }
      if (rule.scope.includes('content')) {
        const run = grep(root, rule.source, '.');
        if (run.status !== 0 && run.status !== 1) return { problem: 'the private content scan could not run' };
        if (run.status === 0) {
          const parsed = records(run.stdout);
          if ('problem' in parsed) return parsed;
          for (const record of parsed.records) {
            hits.push({
              origin: first.origin,
              ...(first.className === undefined ? {} : { className: first.className }),
              ordinal: first.ordinal,
              path: record.path,
              line: record.line,
            });
          }
        }
      }
    }
    return {
      hits,
      scanned: tracked.files.length,
      rules: normalized.rules.length,
      duplicates: normalized.duplicates,
      diffOnly: normalized.diffOnly,
    };
  } finally {
    rmSync(scratch.path, { recursive: true, force: true });
  }
}

/** The text a pre-push scan reads, with one location label per line for a redacted hit. */
export interface PrivateCorpus {
  lines: string[];
  /** `path:line` for an added diff line, `commit:<sha>:<line>` for a commit-message line. */
  where: string[];
}

/** One C-quoted diff path, decoded to the bytes git encoded, or null on an unknown escape. */
function unquoteDiffPath(text: string): string | null {
  const parts: Buffer[] = [];
  let run = '';
  const flush = (): void => {
    if (run !== '') {
      parts.push(Buffer.from(run, 'utf8'));
      run = '';
    }
  };
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character !== '\\') {
      run += character;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) return null;
    index += 1;
    if (simple[escape] !== undefined) {
      flush();
      parts.push(Buffer.from([simple[escape]!]));
      continue;
    }
    if (escape < '0' || escape > '7') return null;
    let digits = escape;
    while (digits.length < 3) {
      const next = text[index + 1];
      if (next === undefined || next < '0' || next > '7') break;
      index += 1;
      digits += next;
    }
    flush();
    parts.push(Buffer.from([Number.parseInt(digits, 8) & 0xff]));
  }
  flush();
  return Buffer.concat(parts).toString('utf8');
}

/**
 * The new-side path of one `+++ ` header. Git appends one tab to an unquoted path that contains
 * a space, and C-quotes a path with a control or non-UTF-8 byte; both forms are read back to the
 * tracked path here.
 */
function newPathFromHeader(payload: string): { path: string | null } | { problem: string } {
  if (payload === '/dev/null') return { path: null };
  let text: string;
  if (payload.startsWith('"')) {
    if (payload.length < 2 || !payload.endsWith('"')) return { problem: 'cannot parse a diff path' };
    const decoded = unquoteDiffPath(payload.slice(1, -1));
    if (decoded === null) return { problem: 'cannot parse a diff path' };
    text = decoded;
  } else {
    text = payload.endsWith('\t') ? payload.slice(0, -1) : payload;
  }
  if (!text.startsWith('b/')) return { problem: 'cannot parse a diff path' };
  const path = text.slice(2);
  if (path === '') return { problem: 'cannot parse a diff path' };
  return { path };
}

/** A location label stays on one line: a newline or carriage return in a path is escaped. */
function labelPath(path: string): string {
  return path.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/**
 * Builds the pre-push corpus: every added line of the diff against `base`, then every line of
 * every commit message on `base..HEAD`. Removed lines are not read; a line that stays unchanged
 * is not added. No matched text is retained beyond the corpus itself, which lives in a scratch
 * folder owned by the caller.
 *
 * The diff is read as hunks, not as loose lines: a hunk header declares how many old and new
 * lines follow, and exactly those lines are consumed, so added content can never be mistaken for
 * a file header and a path is never derived from anything but a `+++ ` header. Renames are turned
 * into a deletion and an addition (`--no-renames`) so the new side always carries a full path.
 */
export function privateDiffCorpus(root: string, base: string): { corpus: PrivateCorpus } | { problem: string } {
  const diff = spawnSync(
    'git',
    ['-C', root, 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', base, '--'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (diff.error !== undefined || diff.status !== 0) return { problem: `cannot read the diff against ${base}` };
  const lines: string[] = [];
  const where: string[] = [];
  // undefined until this file's +++ header, null when its new side is /dev/null.
  let path: string | null | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.stdout.split('\n')) {
    if (inHunk) {
      if (raw === '\\ No newline at end of file') continue;
      if (oldLeft > 0 && raw.startsWith('-')) {
        oldLeft -= 1;
      } else if (newLeft > 0 && raw.startsWith('+')) {
        if (path !== null && path !== undefined) {
          lines.push(raw.slice(1));
          where.push(`${labelPath(path)}:${String(newLine)}`);
        }
        newLeft -= 1;
        newLine += 1;
      } else if (oldLeft > 0 && newLeft > 0 && raw.startsWith(' ')) {
        oldLeft -= 1;
        newLeft -= 1;
        newLine += 1;
      } else {
        return { problem: 'cannot parse a diff hunk' };
      }
      inHunk = oldLeft > 0 || newLeft > 0;
      continue;
    }
    if (raw.startsWith('diff --git ')) {
      path = undefined;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const header = newPathFromHeader(raw.slice(4));
      if ('problem' in header) return header;
      path = header.path;
      continue;
    }
    const hunk = raw.match(/^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/);
    if (hunk !== null) {
      if (path === undefined) return { problem: 'cannot parse a diff hunk' };
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      newLine = Number(hunk[3]);
      inHunk = oldLeft > 0 || newLeft > 0;
      continue;
    }
  }
  if (inHunk) return { problem: 'cannot parse a diff hunk' };

  const commits = spawnSync('git', ['-C', root, 'log', '--format=%H', `${base}..HEAD`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (commits.error !== undefined || commits.status !== 0) return { problem: `cannot read the commits since ${base}` };
  for (const sha of commits.stdout.split('\n').filter(Boolean)) {
    const body = spawnSync('git', ['-C', root, 'log', '-1', '--format=%B', sha], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (body.error !== undefined || body.status !== 0) return { problem: `cannot read a commit message since ${base}` };
    const message = body.stdout.replace(/\n$/, '');
    for (const [index, text] of message.split('\n').entries()) {
      lines.push(text);
      where.push(`commit:${sha}:${String(index + 1)}`);
    }
  }
  return { corpus: { lines, where } };
}

/**
 * Scans supplied pre-push text (added lines, commit messages, pull-request bodies) with the diff
 * scope. Used by the pre-push gate; the same validation and no-argv rule apply.
 */
export function scanPrivateLines(lines: readonly string[], sources: readonly PrivateSource[]): PrivateLineScan {
  const normalized = normalizePrivateRules(sources);
  if ('problem' in normalized) return normalized;
  const scratch = scratchRepository();
  if (scratch.problem !== undefined) {
    if (scratch.path !== '') rmSync(scratch.path, { recursive: true, force: true });
    return { problem: scratch.problem };
  }
  try {
    writeFileSync(join(scratch.path, 'empty.txt'), '', { mode: 0o600 });
    // `git grep -I` reads one NUL anywhere in a file as a binary marker and skips that file whole,
    // so a single NUL-bearing line would hide every other line. The bytes are removed instead: the
    // line stays text, its number is unchanged, and a name split by a NUL reads as the name it spells.
    const corpus = lines.map((line) => line.replace(/\0/g, ''));
    writeFileSync(join(scratch.path, 'lines.txt'), corpus.length === 0 ? '' : `${corpus.join('\n')}\n`, { mode: 0o600 });
    if (!addScratch(scratch.path, ['empty.txt', 'lines.txt'])) {
      return { problem: 'cannot stage the private diff scratch repository' };
    }
    const invalid = validate(normalized.rules, scratch.path);
    if (invalid !== null) return invalid;
    const hits: PrivateLineHit[] = [];
    for (const rule of normalized.rules) {
      if (!rule.scope.includes('diff')) continue;
      const first = rule.occurrences[0]!;
      const run = grep(scratch.path, rule.source, 'lines.txt');
      if (run.status !== 0 && run.status !== 1) return { problem: 'the private diff scan could not run' };
      if (run.status !== 0) continue;
      const parsed = records(run.stdout);
      if ('problem' in parsed) return parsed;
      for (const record of parsed.records) {
        if (record.path !== 'lines.txt') return { problem: 'the private diff scan returned an unknown record' };
        hits.push({
          origin: first.origin,
          ...(first.className === undefined ? {} : { className: first.className }),
          ordinal: first.ordinal,
          line: record.line,
        });
      }
    }
    return {
      hits,
      rules: normalized.rules.length,
      duplicates: normalized.duplicates,
      diffOnly: normalized.diffOnly,
    };
  } finally {
    rmSync(scratch.path, { recursive: true, force: true });
  }
}
