// Inbox config and info/exclude. The fixture root stays unresolved, under a symlink, so a link
// above the root still publishes. The git layout is plain folders; a stand-in answers rev-parse.
import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { registerInbox } from '../src/mcp/register.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const OUTSIDE = 'synthetic outside data\n';
const KEPT_LINE = 'kept-line';
const CONFIG = '.cursor/mcp.json';
const TEAM = `format: 1
project: harbor
session: hour
operator: guide
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: guide
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
    leads: true
`;

function world(): { holder: string; root: string; file: string; real: string } {
  const holder = mkdtempSync(join(tmpdir(), 'state-write-four-'));
  const real = join(holder, 'real');
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(holder, 'via'));
  const root = join(holder, 'via', 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM, { mode: 0o600 });
  return { holder, root, file, real };
}

function discard(holder: string): void {
  discardFixtures([holder]);
}

function register(root: string, file: string) {
  return registerInbox({ cli: 'cursor', seat: 'guide', cwd: root, file });
}

function configPath(root: string): string {
  return join(root, CONFIG);
}

function plant(path: string, target: string, kind: 'live' | 'dangling'): string {
  const missing = join(dirname(target), 'missing-target');
  symlinkSync(kind === 'live' ? target : missing, path);
  return missing;
}

function kept(target: string, missing: string, link: string, kind: 'live' | 'dangling'): void {
  expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
  if (kind === 'dangling') {
    let present = true;
    try { lstatSync(missing); } catch { present = false; }
    expect(present).toBe(false);
  }
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(kind === 'live' ? target : missing);
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function servers(path: string): { kept: boolean; other: { command: string; args: string[] }; inbox: { args: string[] } } {
  const body = JSON.parse(readFileSync(path, 'utf8')) as {
    kept: boolean;
    mcpServers: { other: { command: string; args: string[] }; 'team-inbox': { args: string[] } };
  };
  return { kept: body.kept, other: body.mcpServers.other, inbox: body.mcpServers['team-inbox'] };
}

function withGit(holder: string, common: string, run: () => void): void {
  const bin = join(holder, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, 'git'), `#!/bin/sh
common="\${STATE_WRITE_GIT_COMMON:?}"
if [ "$1" = rev-parse ]; then
  if [ "$2" = --is-inside-work-tree ]; then printf 'true\\n'; exit 0; fi
  if [ "$2" = --path-format=absolute ] && [ "$3" = --git-common-dir ]; then printf '%s\\n' "$common"; exit 0; fi
  exit 1
fi
if [ "$1" = check-ignore ]; then
  target=
  for arg in "$@"; do target=$arg; done
  if [ -f "$common/info/exclude" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      trimmed=$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      if [ "$trimmed" = "$target" ]; then exit 0; fi
    done < "$common/info/exclude"
  fi
  exit 1
fi
exit 1
`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedCommon = process.env.STATE_WRITE_GIT_COMMON;
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
  process.env.STATE_WRITE_GIT_COMMON = common;
  try { run(); }
  finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedCommon === undefined) delete process.env.STATE_WRITE_GIT_COMMON;
    else process.env.STATE_WRITE_GIT_COMMON = savedCommon;
  }
}

test('a normal config publish keeps existing entries and works through a link above the root', () => {
  const { holder, root, file, real } = world();
  try {
    const path = configPath(root);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ kept: true, mcpServers: { other: { command: 'hold', args: [] } } })}\n`, { mode: 0o600 });
    expect(register(root, file)).toEqual({ ok: true });
    expect(lstatSync(path).isFile()).toBe(true);
    expect(modeOf(path)).toBe(0o600);
    expect(realpathSync(path)).toBe(join(realpathSync(real), 'repo', CONFIG));
    const written = servers(path);
    expect(written.kept).toBe(true);
    expect(written.other).toEqual({ command: 'hold', args: [] });
    expect(written.inbox.args).toContain('--seat');
    expect(written.inbox.args).toContain('guide');
    expect(written.inbox.args).toContain('--session');
    expect(written.inbox.args).toContain('hour');
  } finally {
    discard(holder);
  }
});

test('a link at the config file or its old fixed temporary is not written through', () => {
  for (const kind of ['live', 'dangling'] as const) {
    const final = world();
    try {
      const target = join(final.holder, 'outside.txt');
      writeFileSync(target, OUTSIDE, { mode: 0o600 });
      const path = configPath(final.root);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const missing = plant(path, target, kind);
      expect(register(final.root, final.file)?.ok).toBe(false);
      kept(target, missing, path, kind);
    } finally {
      discard(final.holder);
    }

    const temp = world();
    try {
      const target = join(temp.holder, 'outside.txt');
      writeFileSync(target, OUTSIDE, { mode: 0o600 });
      const path = configPath(temp.root);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const old = `${path}.team-tmp`;
      const missing = plant(old, target, kind);
      expect(register(temp.root, temp.file)).toEqual({ ok: true });
      kept(target, missing, old, kind);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(modeOf(path)).toBe(0o600);
      expect(servers(path).inbox.args).toContain('guide');
    } finally {
      discard(temp.holder);
    }
  }
});

test('info/exclude keeps existing lines and adds its line once', () => {
  const { holder, root, file } = world();
  try {
    const common = join(root, '.git');
    const exclude = join(common, 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true, mode: 0o700 });
    writeFileSync(exclude, `${KEPT_LINE}\n`, { mode: 0o600 });
    withGit(holder, common, () => {
      expect(register(root, file)).toEqual({ ok: true });
      expect(register(root, file)).toEqual({ ok: true });
    });
    const text = readFileSync(exclude, 'utf8');
    expect(text).toContain(`${KEPT_LINE}\n`);
    expect(text.split('\n').filter((line) => line.trim() === CONFIG)).toEqual([CONFIG]);
    expect(modeOf(exclude)).toBe(0o600);
    expect(servers(configPath(root)).inbox.args).toContain('guide');
  } finally {
    discard(holder);
  }
});

test('a link at info/exclude is not written through', () => {
  for (const kind of ['live', 'dangling'] as const) {
    const { holder, root, file } = world();
    try {
      const common = join(root, '.git');
      const exclude = join(common, 'info', 'exclude');
      mkdirSync(dirname(exclude), { recursive: true, mode: 0o700 });
      const target = join(holder, 'outside.txt');
      writeFileSync(target, OUTSIDE, { mode: 0o600 });
      const missing = plant(exclude, target, kind);
      withGit(holder, common, () => {
        expect(register(root, file)?.ok).toBe(false);
      });
      kept(target, missing, exclude, kind);
      let config = true;
      try { lstatSync(configPath(root)); } catch { config = false; }
      expect(config).toBe(false);
    } finally {
      discard(holder);
    }
  }
});
