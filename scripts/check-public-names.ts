#!/usr/bin/env bun
// The public tree's own names, against the policy the team file declares, plus the external
// private names and phrases the repository cannot know.
//
// `team commits check` reads commit messages and pull-request bodies; the pack guard reads the
// files a release ships. Neither reads the repository's tracked test tree, and that tree is
// public the moment it is pushed. This check reads the same declared policy over exactly what
// a clone receives — the git index — so ignored private state and untracked generated or
// vendored files are out of scope by construction. See `src/check/public-names.ts` for why
// paths are matched against every declared pattern while file text is matched against the
// internal ticket id alone.
//
// The second pass reads the external private lists, when they exist, through the same index and
// the same tracked-file set. They are machine-local and never committed. A missing default list
// is a visible skip; a list named on the command line, or one that exists but cannot be read,
// validated or parsed, is a refusal (exit 2), never a clean result.
//
//   bun scripts/check-public-names.ts [--root <dir>] [--file <team file>]
//                                     [--private-names <file>] [--private-phrases <file>]
//
// `--root` is the tree scanned, the current folder by default; it must be a git work tree.
// `--file` is the policy file, `.github/team.yaml` under the current folder by default, not
// under `--root`, so a synthetic tree can be scanned with the real project's policy.
//
// Exit 0 when the tracked tree is clean, 1 when a name matches, 2 when the check cannot run
// (an unreadable or invalid team file, an undeclared ticket-id pattern, git cannot list the
// tree, a private list that is present but unusable). A hit names the path, the line, the source
// label, the class and the entry ordinal, never the matched text or the private expression, so a
// failure never echoes the name into a public log. A clean run names how many tracked files it
// read and how many private rules ran.
import { resolve } from 'node:path';
import { fromTeamFile } from '../src/check/config.ts';
import {
  defaultPrivateListPaths,
  readPrivateList,
  scanPrivateTree,
  type PrivateSource,
} from '../src/check/private-names.ts';
import { publicNameRules, scanPublicNames } from '../src/check/public-names.ts';
import { loadTeamFile } from '../src/file/load.ts';

function exit(message: string): never {
  console.error(`public-names:check: ${message}`);
  process.exit(2);
}

if (import.meta.main) {
  let root = process.cwd();
  let file = '.github/team.yaml';
  let privateNames: string | undefined;
  let privatePhrases: string | undefined;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === '--root' ||
      argument === '--file' ||
      argument === '--private-names' ||
      argument === '--private-phrases'
    ) {
      const value = argv[index + 1];
      if (value === undefined || value === '') exit(`${argument} needs a value`);
      if (argument === '--root') root = value;
      else if (argument === '--file') file = value;
      else if (argument === '--private-names') privateNames = value;
      else privatePhrases = value;
      index += 1;
    } else {
      exit(`unknown argument ${JSON.stringify(argument)}`);
    }
  }

  const loaded = loadTeamFile(process.cwd(), { file, checkOnly: true });
  if (!loaded.ok) exit(loaded.errors.map((problem) => problem.message).join('; '));

  const built = publicNameRules(fromTeamFile(loaded.team));
  if ('problem' in built) exit(built.problem);

  const scan = scanPublicNames(resolve(root), built.rules);
  if ('problem' in scan) exit(scan.problem);

  let failed = false;
  for (const hit of scan.hits) {
    const where = hit.line > 0 ? `${hit.path}:${String(hit.line)}` : hit.path;
    const reads = hit.line > 0 ? 'it matches' : 'its name matches';
    console.error(
      `public-names:check: ${where}: ${reads} the forbidden public pattern ${JSON.stringify(hit.pattern)}`,
    );
    failed = true;
  }

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

  const summary = `${String(scan.scanned)} tracked files carry no forbidden public name`;
  if (sources.length > 0) {
    const privateScan = scanPrivateTree(resolve(root), sources);
    if ('problem' in privateScan) exit(privateScan.problem);
    for (const hit of privateScan.hits) {
      const where = hit.line > 0 ? `${hit.path}:${String(hit.line)}` : hit.path;
      const reads = hit.line > 0 ? 'it matches' : 'its name matches';
      const className = hit.className === undefined ? '' : ` class ${hit.className}`;
      console.error(
        `public-names:check: ${where}: ${reads} private ${hit.origin}${className} entry ${String(hit.ordinal)}`,
      );
      failed = true;
    }
    const skipText = skips.length === 0 ? '' : `; ${skips.join('; ')}`;
    // One summary line, so a caller that reads the check's shape stays stable; a missing
    // default list is named on that line rather than passing silently.
    console.log(
      `public-names:check: ${summary}; private scan: ${String(privateScan.rules)} rules (${String(privateScan.diffOnly)} diff-only, ${String(privateScan.duplicates)} duplicate${privateScan.duplicates === 1 ? '' : 's'})${skipText}`,
    );
  } else {
    console.log(`public-names:check: ${summary}; private scan skipped (${skips.join('; ')})`);
  }

  if (failed) process.exit(1);
}
