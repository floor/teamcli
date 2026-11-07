#!/usr/bin/env bun
// The pre-push half of the external private-name gate: every added line of the diff against a
// base, and every line of every commit message since that base, read with the diff scope, plus
// the commit-message policy that `team commits check` enforces in CI (forbidden tracker/public
// patterns on every commit message, and the `Agent` signature trailer on every non-merge,
// non-human commit).
//
// It shares the engine and grammar with `scripts/check-public-names.ts`: POSIX extended regular
// expressions executed by `git grep -E`, the pattern list on standard input, a strict subset that
// refuses ambiguous escapes, and diagnostics that name the source, class and ordinal only. The
// corpus location is printed as `path:line` for an added line and `commit:<sha>:<line>` for a
// commit-message line; the matched text is never printed.
//
//   bun scripts/check-private-diff.ts (--base <rev> | --release) [--root <dir>] [--file <team file>]
//                                     [--private-names <file>] [--private-phrases <file>]
//
// `--release` scans `origin/main..HEAD` (the range CI checks), while lane gates pass `--base <rev>`.
// Exit 0 clean (or both default lists absent, a visible skip), 1 hits, 2 cannot run.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenPatterns, fromTeamFile, type CheckConfig } from '../src/check/config.ts';
import { checkSignature, findForbidden, splitLines } from '../src/check/message.ts';
import {
  defaultPrivateListPaths,
  privateDiffCorpus,
  readPrivateList,
  scanPrivateLines,
  type PrivateSource,
} from '../src/check/private-names.ts';
import { INTERNAL_TRACKER } from '../src/check/public-names.ts';
import { loadTeamFile } from '../src/file/load.ts';

const GIT_CONFIG = ['log.showSignature=false', 'i18n.logOutputEncoding=UTF-8', 'trailer.separators=:'].flatMap(
  (setting) => ['-c', setting],
);

const TRAILER_LINE = /^[A-Za-z0-9-]+\s*:\s*\S/;

// This commit-message-only rule catches numbered role IDs and named review-role IDs.
// It does not replace the private-names prepush scan, which still covers personal and
// persona names. Ordinary role words and hyphenated descriptions remain valid.
const NUMBERED_ROLE_TOKEN = /(^|[^A-Za-z0-9_])(?:builder|operator|tester)-[0-9]+(?=$|[^A-Za-z0-9_])/i;
const NAMED_REVIEW_TOKEN = /(^|[^A-Za-z0-9_])reviewer-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=$|[^A-Za-z0-9_])/gi;
const REVIEW_PROSE_SUFFIXES = new Set(['requested', 'approved', 'side']);

function namesInternalSeat(line: string): boolean {
  if (NUMBERED_ROLE_TOKEN.test(line)) return true;
  return [...line.matchAll(NAMED_REVIEW_TOKEN)]
    .some((match) => !REVIEW_PROSE_SUFFIXES.has(match[2]!.toLowerCase()));
}

function exit(message: string): never {
  console.error(`private-diff:check: ${message}`);
  process.exit(2);
}

function messageAfterHeaders(object: string): string | null {
  let start = 0;
  while (start < object.length) {
    const end = object.indexOf('\n', start);
    if (end === -1) return null;
    if (end === start) return object.slice(end + 1);
    start = end + 1;
  }
  return null;
}

function trailersFromLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1] !== '') start -= 1;
  const paragraph = lines.slice(start, end);
  if (paragraph.length === 0 || !paragraph.every((line) => TRAILER_LINE.test(line))) return [];
  return [...paragraph];
}

function checkCommitMessages(
  root: string,
  base: string,
  config: CheckConfig,
): { hits: string[] } | { problem: string } {
  let patterns: ReturnType<typeof forbiddenPatterns>;
  try {
    patterns = forbiddenPatterns(config);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  if (!patterns.some((pattern) => pattern.source === INTERNAL_TRACKER)) {
    return { problem: `the team file declares no internal ticket-id pattern (${INTERNAL_TRACKER})` };
  }
  const humans = new Set(config.humans.map((email) => email.toLowerCase()));
  const revisions = [`${base}..HEAD`];
  if (config.since !== undefined && !config.since.startsWith('-')) {
    const resolved = spawnSync(
      'git',
      ['-C', root, ...GIT_CONFIG, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${config.since}^{commit}`],
      { encoding: 'utf8' },
    );
    if (resolved.status === 0 && resolved.stdout.trim() !== '') {
      revisions.push(`^${resolved.stdout.trim()}`);
    }
  }

  const logged = spawnSync(
    'git',
    [
      '-C',
      root,
      ...GIT_CONFIG,
      'log',
      '--no-color',
      '--format=tformat:%H%x00%P%x00%ae%x00%(trailers)%x00',
      '--end-of-options',
      ...revisions,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (logged.error !== undefined || logged.status !== 0) return { problem: `cannot read the commits since ${base}` };

  const hits: string[] = [];
  const fields = logged.stdout.split('\0');
  for (let index = 0; index + 4 <= fields.length; index += 4) {
    const hash = fields[index]!.trim();
    if (hash === '') continue;
    const parents = fields[index + 1]!.split(' ').filter(Boolean);
    const authorEmail = fields[index + 2]!;
    const rawTrailers = fields[index + 3]!.split('\n').filter((line) => line.trim() !== '');

    const body = spawnSync('git', ['-C', root, 'cat-file', 'commit', hash], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (body.error !== undefined || body.status !== 0) return { problem: `cannot read a commit message since ${base}` };
    const message = messageAfterHeaders(body.stdout);
    if (message === null) return { problem: `cannot read a commit message since ${base}` };

    const lines = splitLines(message.replace(/\0/g, ''));
    const trailers = message.includes('\0') ? trailersFromLines(lines) : rawTrailers;

    for (const [index, line] of lines.entries()) {
      if (namesInternalSeat(line)) {
        hits.push(`commit:${hash}:${String(index + 1)}: commit message names an internal seat`);
      }
    }

    for (const finding of findForbidden(lines, patterns)) {
      const pattern = finding.message.replace(/^forbidden pattern /, '');
      hits.push(`commit:${hash}:${String(finding.line ?? 1)}: it matches the forbidden pattern ${JSON.stringify(pattern)}`);
    }

    const exempt = (config.commits.exemptMerge && parents.length > 1) || humans.has(authorEmail.toLowerCase());
    if (!exempt) {
      for (const finding of checkSignature({ lines, rule: config.commits, ledger: config.ledger, trailers })) {
        const where = finding.line === undefined ? `commit:${hash}` : `commit:${hash}:${String(finding.line)}`;
        const detail =
          finding.kind === 'signature-in-prose'
            ? 'the signature shares its paragraph with prose, so git reads no trailer block: put it in a paragraph of its own, with trailers only'
            : finding.message;
        hits.push(`${where}: ${detail}`);
      }
    }
  }
  return { hits };
}

if (import.meta.main) {
  let root = process.cwd();
  let base: string | undefined;
  let release = false;
  let file: string | undefined;
  let privateNames: string | undefined;
  let privatePhrases: string | undefined;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') {
      release = true;
    } else if (
      argument === '--root' ||
      argument === '--base' ||
      argument === '--file' ||
      argument === '--private-names' ||
      argument === '--private-phrases'
    ) {
      const value = argv[index + 1];
      if (value === undefined || value === '') exit(`${argument} needs a value`);
      if (argument === '--root') root = value;
      else if (argument === '--base') base = value;
      else if (argument === '--file') file = value;
      else if (argument === '--private-names') privateNames = value;
      else privatePhrases = value;
      index += 1;
    } else {
      exit(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (release && base !== undefined) exit('--base and --release cannot be used together');
  const resolvedBase = release ? 'origin/main' : base;
  if (resolvedBase === undefined) exit('--base needs a value (or pass --release)');

  const defaultFile = existsSync(resolve(process.cwd(), '.github/team.yaml'))
    ? '.github/team.yaml'
    : fileURLToPath(new URL('../.github/team.yaml', import.meta.url));
  const loaded = loadTeamFile(process.cwd(), { file: file ?? defaultFile, checkOnly: true });
  if (!loaded.ok) exit(loaded.errors.map((problem) => problem.message).join('; '));
  const config = fromTeamFile(loaded.team);

  const defaults = defaultPrivateListPaths();
  const sources: PrivateSource[] = [];
  const skips: string[] = [];
  const wanted: { label: string; path: string; required: boolean }[] = [
    { label: 'names', path: privateNames ?? defaults.names, required: privateNames !== undefined },
    { label: 'phrases', path: privatePhrases ?? defaults.phrases, required: privatePhrases !== undefined },
  ];
  for (const item of wanted) {
    const read = readPrivateList(item.path, item.label, { required: item.required });
    if ('problem' in read) exit(read.problem);
    if ('missing' in read) {
      skips.push(`${item.label} private list not present at ${read.path}`);
      continue;
    }
    sources.push(read.source);
  }

  const resolvedRoot = resolve(root);
  const built = privateDiffCorpus(resolvedRoot, resolvedBase);
  if ('problem' in built) exit(built.problem);
  const commitsCheck = checkCommitMessages(resolvedRoot, resolvedBase, config);
  if ('problem' in commitsCheck) exit(commitsCheck.problem);

  let failed = false;
  for (const hit of commitsCheck.hits) {
    console.error(`private-diff:check: ${hit}`);
    failed = true;
  }

  if (sources.length === 0) {
    console.log(`private-diff:check: skipped (${skips.join('; ')})`);
    process.exit(failed ? 1 : 0);
  }

  const scan = scanPrivateLines(built.corpus.lines, sources);
  if ('problem' in scan) exit(scan.problem);

  for (const hit of scan.hits) {
    const where = built.corpus.where[hit.line - 1] ?? `line ${String(hit.line)}`;
    const className = hit.className === undefined ? '' : ` class ${hit.className}`;
    console.error(`private-diff:check: ${where}: it matches private ${hit.origin}${className} entry ${String(hit.ordinal)}`);
    failed = true;
  }

  const skipText = skips.length === 0 ? '' : `; ${skips.join('; ')}`;
  console.log(
    `private-diff:check: ${String(built.corpus.lines.length)} added or commit-message lines carry no private name; private scan: ${String(scan.rules)} rules (${String(scan.diffOnly)} diff-only, ${String(scan.duplicates)} duplicate${scan.duplicates === 1 ? '' : 's'})${skipText}`,
  );
  if (failed) process.exit(1);
}
