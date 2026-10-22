#!/usr/bin/env bun
// The public tree's own names, against the policy the team file declares.
//
// `team commits check` reads commit messages and pull-request bodies; the pack guard reads the
// files a release ships. Neither reads the repository's tracked test tree, and that tree is
// public the moment it is pushed. This check reads the same declared policy over exactly what
// a clone receives — the git index — so ignored private state and untracked generated or
// vendored files are out of scope by construction. See `src/check/public-names.ts` for why
// paths are matched against every declared pattern while file text is matched against the
// internal ticket id alone.
//
//   bun scripts/check-public-names.ts [--root <dir>] [--file <team file>]
//
// `--root` is the tree scanned, the current folder by default; it must be a git work tree.
// `--file` is the policy file, `.github/team.yaml` under the current folder by default, not
// under `--root`, so a synthetic tree can be scanned with the real project's policy.
//
// Exit 0 when the tracked tree is clean, 1 when a name matches, 2 when the check cannot run
// (an unreadable or invalid team file, an undeclared ticket-id pattern, git cannot list the
// tree, a tracked file cannot be read). A hit names the path, the line and the declared
// pattern source, never the matched text, so a failure never echoes the name into a public
// log. A clean run names how many tracked files it read.
import { resolve } from 'node:path';
import { fromTeamFile } from '../src/check/config.ts';
import { publicNameRules, scanPublicNames } from '../src/check/public-names.ts';
import { loadTeamFile } from '../src/file/load.ts';

function exit(message: string): never {
  console.error(`public-names:check: ${message}`);
  process.exit(2);
}

if (import.meta.main) {
  let root = process.cwd();
  let file = '.github/team.yaml';
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--file') {
      const value = argv[index + 1];
      if (value === undefined || value === '') exit(`${argument} needs a value`);
      if (argument === '--root') root = value;
      else file = value;
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

  for (const hit of scan.hits) {
    const where = hit.line > 0 ? `${hit.path}:${String(hit.line)}` : hit.path;
    const reads = hit.line > 0 ? 'it matches' : 'its name matches';
    console.error(
      `public-names:check: ${where}: ${reads} the forbidden public pattern ${JSON.stringify(hit.pattern)}`,
    );
  }
  if (scan.hits.length > 0) process.exit(1);
  console.log(`public-names:check: ${String(scan.scanned)} tracked files carry no forbidden public name`);
}
