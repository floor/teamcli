// Fails when the packed tarball carries an internal ticket reference or no
// source stamp.
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
//   bun scripts/check-pack.ts <tarball> [expected-source-sha]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const INTERNAL_ID = /FLO-[0-9]+/;

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

const tarball = process.argv[2];
const expected = process.argv[3] ?? process.env.GITHUB_SHA;
if (!tarball) {
  exit('usage: bun scripts/check-pack.ts <tarball> [expected-source-sha]', 2);
}

const root = mkdtempSync(join(tmpdir(), 'team-check-pack-'));
const hits: string[] = [];
let problem: string | undefined;
let stampProblem: string | undefined;

try {
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', root]);
  if (tar.error !== undefined) {
    problem = `cannot extract ${tarball}: ${tar.error.message}`;
  } else if (tar.status !== 0) {
    const detail = tar.stderr.toString().trim();
    problem = `cannot extract ${tarball}: ${detail === '' ? `tar exited ${String(tar.status)}` : detail}`;
  } else {
    let manifest: { gitHead?: unknown };
    try {
      manifest = JSON.parse(readFileSync(join(root, 'package', 'package.json'), 'utf8')) as { gitHead?: unknown };
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
if (hits.length > 0) {
  exit(`The tarball carries an internal ticket reference:\n${hits.join('\n')}`, 1);
}

console.log('check-pack: the tarball carries a source stamp and no internal ticket reference');
