// Independent scenes: what a codex launch line
// hands the CLI itself, measured as argv by a FAKE codex — a plain script that logs every
// argument it receives; the real codex is never run. Every shape is executed end-to-end: the
// command the launcher builds runs under bash with the fake first on PATH, and the scenes
// read the argv back. Plain, quoted and nested (a zsh -lc script) lines must land every added
// option BEFORE the CLI's own '--' and the rules line LAST, with the line's own words kept
// whole; a decodable ANSI-C delimiter still splits; and a line whose unread part could spell
// the delimiter — an unclosed quote hiding '--', a backslash, or an ANSI-C opener — is refused,
// so no argv exists at all.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommandOrRefusal } from '../src/profiles/profile.ts';

const PROFILE = profileFor('codex')!;
const RULES = 'Read the rules file before your first answer (pair 5e1d0a9c).';
/** The words the profile adds to a line that sets none of them itself. */
const ADDED = ['-a', 'never', '-s', 'danger-full-access', '--no-alt-screen', '-c', 'features.mcp_oauth_refresh_coordination=false'];

const roots: string[] = [];
/** A folder holding a fake codex that logs its argv, one argument per line. */
function fakeCodex(): { bin: string; log: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'codex-argv-')));
  roots.push(root);
  const bin = join(root, 'bin');
  const log = join(root, 'argv.log');
  mkdirSync(bin);
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${log}'; done\n`);
  chmodSync(fake, 0o755);
  return { bin, log };
}

/** The probe runs under bash, the shell these ANSI-C scenes were measured on. */
function probeShell(): string {
  return existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';
}

/** The host zsh, when one resolves. The nested scene names that shell; a host without it skips that scene only. */
function resolvedZsh(): string | null {
  const out = spawnSync(probeShell(), ['-c', 'command -v zsh'], { encoding: 'utf8' });
  const found = out.stdout.trim();
  if (out.status !== 0 || !found.startsWith('/') || !existsSync(found)) return null;
  return found;
}

/** The launcher's command, run as a pane would run it; the fake codex's argv. */
function argvOf(launch: string, extraDir?: string): string[] | null {
  const { bin, log } = fakeCodex();
  const built = launchCommandOrRefusal(PROFILE, launch, 'Rules.', undefined, undefined, undefined, undefined, RULES);
  expect(built.refusal).toBeUndefined();
  const path = extraDir === undefined ? `${bin}:/usr/bin:/bin` : `${bin}:${extraDir}:/usr/bin:/bin`;
  const out = spawnSync(probeShell(), ['-c', built.command], { env: { PATH: path, HOME: join(bin, '..') }, encoding: 'utf8' });
  expect(out.status).toBe(0);
  if (!existsSync(log)) return null;
  return readFileSync(log, 'utf8').replace(/\n$/, '').split('\n');
}

function launches(launch: string, expected: string[], extraDir?: string): void {
  const argv = argvOf(launch, extraDir)!;
  expect(argv).toEqual(expected);
  const delimiter = argv.indexOf('--');
  expect(delimiter).toBeGreaterThan(0);
  // Every added option is before the CLI's own delimiter, as one block ending at it...
  expect(argv.slice(delimiter - ADDED.length, delimiter)).toEqual(ADDED);
  // ...and the rules line is the last word the CLI receives.
  expect(argv[argv.length - 1]).toBe(RULES);
}

test('a plain line: options before the CLI\'s own --, own tail kept, rules last', () => {
  launches('codex --skip-git-repo-check -- sum the quarterly report', [
    '--skip-git-repo-check', ...ADDED, '--', 'sum', 'the', 'quarterly', 'report', RULES,
  ]);
});

test('a quoted line: quoted words arrive whole, options still before the --', () => {
  launches(`codex '--skip-git-repo-check' 'two words' -- 'a quoted task'`, [
    '--skip-git-repo-check', 'two words', ...ADDED, '--', 'a quoted task', RULES,
  ]);
});

const zsh = resolvedZsh();

test.skipIf(zsh === null)('a nested script line, when zsh resolves: the additions ride inside the script the CLI reads', () => {
  launches(`zsh -lc 'codex --skip-git-repo-check -- a nested task'`, [
    '--skip-git-repo-check', ...ADDED, '--', 'a', 'nested', 'task', RULES,
  ], dirname(zsh!));
});

test('a decodable ANSI-C delimiter still splits: the options stand before it', () => {
  launches(`codex exec $'--' plain task`, [
    'exec', ...ADDED, '--', 'plain', 'task', RULES,
  ]);
});

test('an unread part that could spell the delimiter is refused, never launched', () => {
  const shapes = [
    `codex exec 'unclosed quote -- inside`, // an unclosed quote hiding the delimiter
    'codex exec "unclosed back\\slash', // an unclosed quote with an escape in the unread part
    `codex exec $'unclosed ansi word`, // an ANSI-C opener in the unread part
    `codex exec $'ansi \\x1b escape'`, // a closed ANSI-C word holding an escape: unreadable
  ];
  for (const launch of shapes) {
    const built = launchCommandOrRefusal(PROFILE, launch, 'Rules.', undefined, undefined, undefined, undefined, RULES);
    expect(built.refusal).toContain('delimiter');
    expect(built.command).toBe('');
  }
});
