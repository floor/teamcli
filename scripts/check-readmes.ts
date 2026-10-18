#!/usr/bin/env bun
// The two READMEs, against the build they describe.
//
// The rule
// --------
// **The opening sentence.** The first line under the title of README.md, the
// first line under the title of npm-readme.md, and package.json's `description`
// are one sentence; packages/teamcli/package.json carries the same description
// only when it has one. The caller also passes the build's own first line —
// `team --help`'s, which src/cli.ts reads from that same description — and it is
// held to the same sentence, so the places cannot drift apart. The check fails
// when any place holds the placeholder
// `OPENING SENTENCE PENDING: THE OWNER'S CHOICE` (how the owner marks a sentence
// not chosen yet; it must never ship), and when the places differ from one
// another.
//
// **The version claims.** A version literal claims to be the version of this
// build when it stands in one of these places, and only there:
//
//   - a `Status:` line, naming the status's version ("Status: 0.1, early");
//   - a sentence beginning `Version x.y` ("Version 0.1 runs teams in herdr");
//   - the comment beside `team --version` in an example ("team --version # 0.2.1").
//
// Every claim must name package.json's version: exact for an x.y.z claim, the
// major.minor for a Status: or Version sentence naming x.y. During a release
// candidate its prerelease (`0.5.0-rc.4`) is part of that exact claim: the
// candidate's READMEs describe the candidate. Older and newer both fail: the
// READMEs describe the build in this tree, and the release pull request
// moves package.json's version and the example lines together. A claim whose
// line carries a past marker (since, before, earlier, older, prior, until,
// previously, upgraded from, upgrading from) is a sentence about the past, and
// is not read. A version anywhere else is not a claim: a model version in a YAML
// example, a CLI version a profile is tested with, a tag in a command
// ("git tag v0.2.0"), a link to an upgrade note, or any other line inside a code
// fence than a `team --version` example.
//
//   bun scripts/check-readmes.ts [root]
//
// Exit 0 when the READMEs are current, 1 when a check fails, 2 when a file cannot
// be read (a check that cannot read the files must not report them clean).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpText } from '../src/cli.ts';

export type Failure = { file: string; message: string };

const PLACEHOLDER = "OPENING SENTENCE PENDING: THE OWNER'S CHOICE";

/** A line carrying one of these is about the past, and its versions are history. */
const PAST = /\b(since|before|earlier|older|prior|until|previously|upgraded from|upgrading from)\b/i;

const STATUS_CLAIM = /\bStatus:\s*\**\s*(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/i;
const VERSION_SENTENCE = /(?:^|\*\*)\s*Version\s+(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/;
const VERSION_EXAMPLE = /\bteam --version\b/;
const VERSION_COMMENT = /#\s*v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\b/;

type Claim = { line: number; version: string };

function read(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch (error) {
    throw new Error(`${file} cannot be read: ${(error as Error).message}`);
  }
}

function manifest(root: string, file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${file} cannot be read: ${(error as Error).message}`);
  }
}

/** The first line under the first `# ` title, or undefined when there is none. */
export function openingLine(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const title = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (title === -1) return undefined;
  return lines.slice(title + 1).find((line) => line.trim() !== '')?.trim();
}

function claimsOf(markdown: string): Claim[] {
  const claims: Claim[] = [];
  let fenced = false;
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (PAST.test(line)) return;
    if (VERSION_EXAMPLE.test(line)) {
      const comment = VERSION_COMMENT.exec(line);
      if (comment?.[1] !== undefined) claims.push({ line: index + 1, version: comment[1] });
      return;
    }
    if (fenced) return;
    for (const pattern of [STATUS_CLAIM, VERSION_SENTENCE]) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) claims.push({ line: index + 1, version: match[1] });
    }
  });
  return claims;
}

/** An x.y claim names the major.minor; an x.y.z claim the exact version, prerelease included. */
function names(claim: string, version: string): boolean {
  const exact = (claim.split('-')[0] ?? '').split('.').length === 3;
  const wanted = exact ? version : (version.split('-')[0] ?? '').split('.').slice(0, 2).join('.');
  return claim === wanted;
}

/** The first line of `team --help`, exactly as this build prints it. */
export function helpOpeningLine(): string {
  return helpText().split('\n')[0] ?? '';
}

export function checkReadmes(root: string, help: string): Failure[] {
  const failures: Failure[] = [];
  const pkg = manifest(root, 'package.json');
  const version = typeof pkg.version === 'string' ? pkg.version : '';
  if (version === '') failures.push({ file: 'package.json', message: 'it has no version' });

  const places: { file: string; sentence: string | undefined }[] = [
    { file: 'README.md', sentence: openingLine(read(root, 'README.md')) },
    { file: 'npm-readme.md', sentence: openingLine(read(root, 'npm-readme.md')) },
    { file: 'package.json', sentence: typeof pkg.description === 'string' ? pkg.description : undefined },
  ];
  const launcher = 'packages/teamcli/package.json';
  if (existsSync(join(root, launcher))) {
    const description = manifest(root, launcher).description;
    if (typeof description === 'string') places.push({ file: launcher, sentence: description });
  }
  places.push({ file: 'team --help', sentence: help });

  const first = places[0] as { file: string; sentence: string | undefined };
  for (const place of places) {
    if (place.sentence === undefined) {
      failures.push({
        file: place.file,
        message: place.file.endsWith('.json') ? 'it has no description' : 'it has no opening sentence under the title',
      });
    } else if (place.sentence === PLACEHOLDER) {
      failures.push({ file: place.file, message: `the opening sentence is still the placeholder \`${PLACEHOLDER}\`` });
    } else if (place.sentence !== first.sentence) {
      failures.push({
        file: place.file,
        message: `the opening sentence is not ${first.file}'s: \`${place.sentence}\` is not \`${String(first.sentence)}\``,
      });
    }
  }

  for (const file of ['README.md', 'npm-readme.md']) {
    for (const claim of claimsOf(read(root, file))) {
      if (!names(claim.version, version)) {
        failures.push({
          file,
          message: `line ${String(claim.line)} claims ${claim.version}, and package.json's version is ${version}`,
        });
      }
    }
  }

  return failures;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  let failures: Failure[];
  try {
    failures = checkReadmes(root, helpOpeningLine());
  } catch (error) {
    console.error(`readmes:check: ${(error as Error).message}`);
    process.exit(2);
  }
  for (const failure of failures) console.error(`readmes:check: ${failure.file}: ${failure.message}`);
  if (failures.length > 0) {
    console.error(`readmes:check: ${String(failures.length)} problem${failures.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
  console.log('readmes:check: the opening sentence and every version claim are current');
}
