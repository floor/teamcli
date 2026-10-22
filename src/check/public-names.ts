// The public tree's own names: the files `team commits check` and the pack guard cannot see.
//
// `team commits check` reads commit messages and pull-request bodies. The pack guard reads the
// files a release ships. Neither reads the repository's tracked test tree, which is public the
// moment it is pushed: an internal ticket id in a test comment, a `describe` title, or a file
// name is published with the tree. This module reads the policy the team file already declares
// and answers for that tree.
//
// Scope is the git index (`git ls-files`), so it covers exactly what a clone receives: ignored
// private state never enters it, and untracked generated or vendored files are out of scope by
// construction. Every tracked file is read: the test tree is where the gap was, but a name that
// cannot appear in a public test file cannot appear in a public documentation file either.
//
// A path is matched against every pattern `team check` applies (the built-in defaults, the
// file's `forbidden`, and, for a public project, its `forbidden_public`), case-insensitively:
// the declared expressions are written for message text, where case is part of the leak, but a
// file name that differs only in case publishes the same name.
//
// A file's text is matched against the internal ticket-id pattern only. That is the one class
// with no legitimate public use anywhere, and the release's tarball guard already refuses it in
// shipped files. The other public patterns are grammar-bound to a message: public tests
// synthesize pane ids, session names and forbidden trailers as their data, so reading them as
// content would flag the tests that prove the policy rather than a leak.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forbiddenPatterns, type CheckConfig } from './config.ts';

/** Where a rule reads: a tracked path, or a tracked file's text. */
export type PublicNameScope = 'path' | 'content';

export interface PublicNameRule {
  /** The declared pattern, byte for byte. */
  source: string;
  scope: PublicNameScope;
  /** True for a path rule: the same name in another case publishes the same name. */
  caseInsensitive: boolean;
}

export interface PublicNameHit {
  /** The tracked path, relative to the scanned tree's root. */
  path: string;
  /** The 1-based line of a content hit; 0 for a path hit. */
  line: number;
  /** The declared source of the rule that matched, never the matched text. */
  pattern: string;
}

export type PublicNameScan = { hits: PublicNameHit[]; scanned: number } | { problem: string };

/**
 * The one pattern with no legitimate public content: an internal ticket id. The declared file
 * must carry it, so this check cannot silently pass while the policy stopped naming it.
 */
export const INTERNAL_TRACKER = '\\bFLO-[0-9]+\\b';

/**
 * The rules the team file declares: every pattern `team check` applies to a path, and the
 * internal ticket id for content. A pattern that is not a regular expression, or a file that
 * stopped declaring the ticket id, is a problem: a check that cannot build its rules must not
 * report the tree clean.
 */
export function publicNameRules(config: CheckConfig): { rules: PublicNameRule[] } | { problem: string } {
  let sources: string[];
  try {
    sources = forbiddenPatterns(config).map((pattern) => pattern.source);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  if (!sources.includes(INTERNAL_TRACKER)) {
    return { problem: `the team file declares no internal ticket-id pattern (${INTERNAL_TRACKER})` };
  }
  return {
    rules: [
      ...sources.map((source): PublicNameRule => ({ source, scope: 'path', caseInsensitive: true })),
      { source: INTERNAL_TRACKER, scope: 'content', caseInsensitive: false },
    ],
  };
}

/** Every tracked file under `root`, or the reason the index could not be read. */
function trackedFiles(root: string): { files: string[] } | { problem: string } {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  if (listed.error !== undefined) {
    return { problem: `cannot list the tracked files of ${root}: ${listed.error.message}` };
  }
  if (listed.status !== 0) {
    const detail = listed.stderr.trim();
    return {
      problem: `cannot list the tracked files of ${root}: ${detail === '' ? `git exited ${String(listed.status)}` : detail}`,
    };
  }
  return { files: listed.stdout.split('\0').filter(Boolean) };
}

/**
 * Reads every tracked path under `root` for a rule hit. A file that cannot be read is a
 * problem, not a pass: a check that could not look must not report the tree clean.
 */
export function scanPublicNames(root: string, rules: readonly PublicNameRule[]): PublicNameScan {
  let compiled: { source: string; scope: PublicNameScope; regex: RegExp }[];
  try {
    compiled = rules.map((rule) => ({
      source: rule.source,
      scope: rule.scope,
      regex: new RegExp(rule.source, rule.caseInsensitive ? 'i' : ''),
    }));
  } catch (error) {
    return { problem: `a rule is not a regular expression: ${(error as Error).message}` };
  }
  const tracked = trackedFiles(root);
  if ('problem' in tracked) return tracked;
  const pathRules = compiled.filter((rule) => rule.scope === 'path');
  const contentRules = compiled.filter((rule) => rule.scope === 'content');
  const hits: PublicNameHit[] = [];
  for (const path of tracked.files) {
    for (const rule of pathRules) {
      if (rule.regex.test(path)) hits.push({ path, line: 0, pattern: rule.source });
    }
    if (contentRules.length === 0) continue;
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      return { problem: `cannot read ${path}: ${(error as Error).message}` };
    }
    for (const [index, line] of text.split('\n').entries()) {
      for (const rule of contentRules) {
        if (rule.regex.test(line)) hits.push({ path, line: index + 1, pattern: rule.source });
      }
    }
  }
  return { hits, scanned: tracked.files.length };
}
