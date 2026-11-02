// Fails when the packed tarball carries an internal ticket reference or no
// source stamp, or when the wrapper package that publishes it is not at the
// same release.
//
// A tarball is public the moment it is published, so nothing in it may name an
// internal ticket. Every member is read; a hit names the file, never the
// reference, so a failure cannot put one into public CI logs. The tarball must
// also carry `package/package.json` `gitHead`, the full SHA of the commit it
// was built from (`scripts/pack.ts` writes it); when an expected commit is
// given — the second argument, or GITHUB_SHA when set — the stamp must equal
// it. An extraction or read error exits 2 — a check that cannot read the
// tarball must not report it clean.
//
// The tarball is the `team` package itself; `packages/teamcli` is the wrapper
// that publishes it, and npm pins a dependency to an exact version. A wrapper
// left one release behind hands every installed `@teamcli/cli` the previous
// `team`, so its `version` and its `dependencies.team` must both equal the
// packed `version` exactly. The wrapper is read from the checkout, not the
// tarball (the root `files` list excludes it), defaulting to the manifest
// beside this script.
//
//   bun scripts/check-pack.ts <tarball> [expected-source-sha] [--wrapper <path>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const INTERNAL_ID = /FLO-[0-9]+/;

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

const positionals: string[] = [];
let wrapperPath = join(import.meta.dir, '..', 'packages', 'teamcli', 'package.json');
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] as string;
  if (arg === '--wrapper') {
    const value = args[index + 1];
    if (value === undefined) {
      exit('usage: bun scripts/check-pack.ts <tarball> [expected-source-sha] [--wrapper <path>]', 2);
    }
    wrapperPath = value;
    index += 1;
  } else {
    positionals.push(arg);
  }
}

const tarball = positionals[0];
const expected = positionals[1] ?? process.env.GITHUB_SHA;
if (tarball === undefined) {
  exit('usage: bun scripts/check-pack.ts <tarball> [expected-source-sha] [--wrapper <path>]', 2);
}

const root = mkdtempSync(join(tmpdir(), 'team-check-pack-'));
const hits: string[] = [];
let problem: string | undefined;
let stampProblem: string | undefined;
let wrapperProblem: string | undefined;
let wrapperCode: number = 1;

/** The wrapper's `version` and its `dependencies.team`, both at `packed`, or why not. */
function checkWrapper(packed: string): void {
  let manifest: { version?: unknown; dependencies?: { team?: unknown } };
  try {
    manifest = JSON.parse(readFileSync(wrapperPath, 'utf8')) as typeof manifest;
  } catch (error) {
    wrapperCode = 2;
    wrapperProblem = `cannot read the wrapper ${wrapperPath}: ${(error as Error).message}`;
    return;
  }
  if (manifest.version !== packed) {
    wrapperProblem = `the wrapper ${wrapperPath} is version ${String(manifest.version)}, not the packed ${packed}`;
    return;
  }
  const dependency = manifest.dependencies?.team;
  if (typeof dependency !== 'string') {
    wrapperProblem = `the wrapper ${wrapperPath} names no dependencies.team dependency`;
    return;
  }
  if (dependency !== packed) {
    wrapperProblem = `the wrapper ${wrapperPath} depends on team ${dependency}, not the packed ${packed}`;
  }
}

try {
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', root]);
  if (tar.error !== undefined) {
    problem = `cannot extract ${tarball}: ${tar.error.message}`;
  } else if (tar.status !== 0) {
    const detail = tar.stderr.toString().trim();
    problem = `cannot extract ${tarball}: ${detail === '' ? `tar exited ${String(tar.status)}` : detail}`;
  } else {
    let manifest: { gitHead?: unknown; version?: unknown };
    try {
      manifest = JSON.parse(readFileSync(join(root, 'package', 'package.json'), 'utf8')) as { gitHead?: unknown; version?: unknown };
    } catch (error) {
      manifest = {};
      problem = `cannot read package/package.json: ${(error as Error).message}`;
    }
    if (problem === undefined) {
      if (typeof manifest.gitHead !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.gitHead)) {
        stampProblem = 'the tarball carries no source stamp (package/package.json gitHead)';
      } else if (expected !== undefined && expected !== '' && manifest.gitHead !== expected) {
        stampProblem = `the tarball's source stamp ${manifest.gitHead} is not the expected commit ${expected}`;
      }
    }
    if (problem === undefined) {
      if (typeof manifest.version !== 'string' || manifest.version === '') {
        problem = 'cannot read the packed version (package/package.json version)';
      } else {
        checkWrapper(manifest.version);
      }
    }
    if (problem === undefined) {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path);
          } else if (INTERNAL_ID.test(readFileSync(path, 'utf8'))) {
            hits.push(relative(root, path));
          }
        }
      };
      walk(root);
    }
  }
} catch (error) {
  problem = (error as Error).message;
}

rmSync(root, { recursive: true, force: true });

if (problem !== undefined) {
  exit(`check-pack: ${problem}`, 2);
}
if (stampProblem !== undefined) {
  exit(`check-pack: ${stampProblem}`, 1);
}
if (wrapperProblem !== undefined) {
  exit(`check-pack: ${wrapperProblem}`, wrapperCode);
}
if (hits.length > 0) {
  exit(`The tarball carries an internal ticket reference:\n${hits.join('\n')}`, 1);
}

console.log('check-pack: the tarball carries a source stamp and no internal ticket reference, and the wrapper at its version depends on team at exactly that version');
