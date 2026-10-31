#!/usr/bin/env bun
// The pre-push half of the external private-name gate: every added line of the diff against a
// base, and every line of every commit message since that base, read with the diff scope.
//
// It shares the engine and grammar with `scripts/check-public-names.ts`: POSIX extended regular
// expressions executed by `git grep -E`, the pattern list on standard input, a strict subset that
// refuses ambiguous escapes, and diagnostics that name the source, class and ordinal only. The
// corpus location is printed as `path:line` for an added line and `commit:<sha>:<line>` for a
// commit-message line; the matched text is never printed.
//
//   bun scripts/check-private-diff.ts --base <rev> [--root <dir>]
//                                     [--private-names <file>] [--private-phrases <file>]
//
// Exit 0 clean (or both default lists absent, a visible skip), 1 hits, 2 cannot run.
import { resolve } from 'node:path';
import {
  defaultPrivateListPaths,
  privateDiffCorpus,
  readPrivateList,
  scanPrivateLines,
  type PrivateSource,
} from '../src/check/private-names.ts';

function exit(message: string): never {
  console.error(`private-diff:check: ${message}`);
  process.exit(2);
}

if (import.meta.main) {
  let root = process.cwd();
  let base: string | undefined;
  let privateNames: string | undefined;
  let privatePhrases: string | undefined;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === '--root' ||
      argument === '--base' ||
      argument === '--private-names' ||
      argument === '--private-phrases'
    ) {
      const value = argv[index + 1];
      if (value === undefined || value === '') exit(`${argument} needs a value`);
      if (argument === '--root') root = value;
      else if (argument === '--base') base = value;
      else if (argument === '--private-names') privateNames = value;
      else privatePhrases = value;
      index += 1;
    } else {
      exit(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (base === undefined) exit('--base needs a value');

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

  if (sources.length === 0) {
    console.log(`private-diff:check: skipped (${skips.join('; ')})`);
    process.exit(0);
  }

  const built = privateDiffCorpus(resolve(root), base);
  if ('problem' in built) exit(built.problem);
  const scan = scanPrivateLines(built.corpus.lines, sources);
  if ('problem' in scan) exit(scan.problem);

  for (const hit of scan.hits) {
    const where = built.corpus.where[hit.line - 1] ?? `line ${String(hit.line)}`;
    const className = hit.className === undefined ? '' : ` class ${hit.className}`;
    console.error(`private-diff:check: ${where}: it matches private ${hit.origin}${className} entry ${String(hit.ordinal)}`);
  }

  const skipText = skips.length === 0 ? '' : `; ${skips.join('; ')}`;
  console.log(
    `private-diff:check: ${String(built.corpus.lines.length)} added or commit-message lines carry no private name; private scan: ${String(scan.rules)} rules (${String(scan.diffOnly)} diff-only, ${String(scan.duplicates)} duplicate${scan.duplicates === 1 ? '' : 's'})${skipText}`,
  );
  if (scan.hits.length > 0) process.exit(1);
}
