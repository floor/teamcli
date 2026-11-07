// Independent scenes: grok-command-deny per-seat placement. A grok-command-deny policy places native deny words before a grok prompt,
// and a Cursor seat's own .cursor/cli.json gains the same denies by a merge. Synthetic folders only.
// Aimed at ef4ca579f. This file is not sharded.
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { grokCommandDenyLine, grokCommandDenyNotes, writeCursorCommandDeny } from '../src/launch/grok-command-deny.ts';
import { grokCommandDenyArgs } from '../src/settings/grok-command-deny.ts';
import { ownStartFolderProblem, type OwnStartFolderInput } from '../src/worktree/place.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const PROMPT = 'grok -- "a prompt"';
const KEPT = {
  editor: 'kept',
  permissions: { allow: ['Shell(ls)'], deny: ['Shell(rm)'] },
};

type Folders = {
  base: string;
  project: string;
  home: string;
  lobby: string;
  cursor: string;
  other: string;
};

function folders(): Folders {
  const base = fixtureBase('deny-place-');
  const made: Folders = {
    base,
    project: join(base, 'project'),
    home: join(base, 'home'),
    lobby: join(base, 'lobby'),
    cursor: join(base, 'cursor-seat'),
    other: join(base, 'other-seat'),
  };
  for (const folder of [made.project, made.home, made.lobby, made.cursor, made.other]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  return made;
}

function drop(made: Folders): void {
  discardFixtures([made.base], { roots: [dirname(made.base)] });
}

function place(made: Folders, cwd: string, seat: string): OwnStartFolderInput {
  return {
    cli: 'cursor',
    seat,
    cwd,
    root: made.project,
    home: made.home,
    lobby: made.lobby,
    peers: [{ name: seat === 'cursor-seat' ? 'other-seat' : 'cursor-seat', cli: 'cursor', cwd: seat === 'cursor-seat' ? made.other : made.cursor }],
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function configAt(folder: string): { permissions?: { deny?: string[]; allow?: string[] }; editor?: string } {
  return JSON.parse(readFileSync(join(folder, '.cursor', 'cli.json'), 'utf8')) as {
    permissions?: { deny?: string[]; allow?: string[] };
    editor?: string;
  };
}

function notesFor(made: Folders, mode: 'git' | 'git-and-tests'): string[] {
  return grokCommandDenyNotes(mode, [{ name: 'cursor-seat', cli: 'cursor', model: 'grok-2' }], {
    'cursor-seat': { start_cwd: made.cursor },
  }, undefined, (seat, folder) => ownStartFolderProblem({
    cli: seat.cli,
    seat: seat.name,
    cwd: folder,
    root: made.project,
    home: made.home,
    lobby: made.lobby,
    peers: [{ name: 'other-seat', cli: 'cursor', cwd: made.other }],
  }));
}

test('policy off changes no settings and no argv', () => {
  const made = folders();
  try {
    const cursorFile = join(made.cursor, '.cursor', 'cli.json');
    const otherFile = join(made.other, '.cursor', 'cli.json');
    writeJson(cursorFile, KEPT);
    writeJson(otherFile, { permissions: { deny: ['Shell(ls)'] } });
    const beforeCursor = readFileSync(cursorFile);
    const beforeOther = readFileSync(otherFile);
    expect(writeCursorCommandDeny('off', place(made, made.cursor, 'cursor-seat'))).toEqual({ ok: true });
    expect(readFileSync(cursorFile)).toEqual(beforeCursor);
    expect(readFileSync(otherFile)).toEqual(beforeOther);
    expect(grokCommandDenyArgs('off')).toEqual([]);
    expect(grokCommandDenyLine('off', PROMPT)).toEqual({ ok: true, line: PROMPT });
    expect(grokCommandDenyNotes('off', [{ name: 'cursor-seat', cli: 'cursor', model: 'grok-2' }], {})).toEqual([]);
  } finally {
    drop(made);
  }
});

test('git denies git on a grok command before the prompt and merges Shell(git) into that seat folder', () => {
  const made = folders();
  try {
    const otherFile = join(made.other, '.cursor', 'cli.json');
    writeJson(join(made.cursor, '.cursor', 'cli.json'), KEPT);
    writeJson(otherFile, { permissions: { deny: ['Shell(ls)'] } });
    const beforeOther = readFileSync(otherFile);
    expect(writeCursorCommandDeny('git', place(made, made.cursor, 'cursor-seat'))).toEqual({ ok: true });
    const config = configAt(made.cursor);
    expect(config.editor).toBe('kept');
    expect(config.permissions?.allow).toEqual(['Shell(ls)']);
    expect(config.permissions?.deny).toEqual(['Shell(rm)', 'Shell(git)']);
    expect(readFileSync(otherFile)).toEqual(beforeOther);

    const placed = grokCommandDenyLine('git', PROMPT);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const delimiter = placed.line.indexOf(' -- ');
    expect(placed.line.indexOf('--deny')).toBeGreaterThanOrEqual(0);
    expect(placed.line.indexOf('--deny')).toBeLessThan(delimiter);
    expect(placed.line.slice(0, delimiter)).toContain('Bash(git)');
    expect(placed.line.slice(0, delimiter)).toContain('Bash(git *)');
    expect(placed.line.slice(0, delimiter)).not.toContain('bun test');
    expect(placed.line.slice(delimiter)).toContain('a prompt');
  } finally {
    drop(made);
  }
});

test('git-and-tests also denies bun test', () => {
  const made = folders();
  try {
    writeJson(join(made.cursor, '.cursor', 'cli.json'), KEPT);
    expect(writeCursorCommandDeny('git-and-tests', place(made, made.cursor, 'cursor-seat'))).toEqual({ ok: true });
    expect(configAt(made.cursor).permissions?.deny).toEqual(['Shell(rm)', 'Shell(git)', 'Shell(bun test)']);
    expect(notesFor(made, 'git-and-tests')).toEqual([]);
    const placed = grokCommandDenyLine('git-and-tests', PROMPT);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const delimiter = placed.line.indexOf(' -- ');
    expect(placed.line.slice(0, delimiter)).toContain('Bash(bun test)');
    expect(placed.line.slice(0, delimiter)).toContain('Bash(bun test *)');
    expect(placed.line.slice(delimiter)).toContain('a prompt');
  } finally {
    drop(made);
  }
});

test('a symlinked config is refused and a hardlinked config is refused', () => {
  const made = folders();
  try {
    const original = `${JSON.stringify(KEPT, null, 2)}\n`;
    const cursorDir = join(made.cursor, '.cursor');
    mkdirSync(cursorDir, { mode: 0o700 });
    const target = join(made.cursor, 'target.json');
    writeFileSync(target, original);
    symlinkSync(target, join(cursorDir, 'cli.json'));
    const linked = writeCursorCommandDeny('git', place(made, made.cursor, 'cursor-seat'));
    expect(linked.ok).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(original);

    const otherDir = join(made.other, '.cursor');
    mkdirSync(otherDir, { mode: 0o700 });
    const file = join(otherDir, 'cli.json');
    const side = join(made.other, 'side.json');
    writeFileSync(file, original);
    linkSync(file, side);
    const hard = writeCursorCommandDeny('git', place(made, made.other, 'other-seat'));
    expect(hard.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readFileSync(side, 'utf8')).toBe(original);
  } finally {
    drop(made);
  }
});

test('team check reports a Cursor file that drifted from the generated rules', () => {
  const made = folders();
  try {
    writeJson(join(made.cursor, '.cursor', 'cli.json'), KEPT);
    expect(writeCursorCommandDeny('git', place(made, made.cursor, 'cursor-seat'))).toEqual({ ok: true });
    const path = join(made.cursor, '.cursor', 'cli.json');
    const drifted = configAt(made.cursor);
    drifted.permissions = { ...drifted.permissions, deny: ['Shell(rm)'] };
    writeFileSync(path, `${JSON.stringify(drifted, null, 2)}\n`);
    expect(notesFor(made, 'git')).toEqual([
      `cursor-seat: grok-command-deny git: ${path} is unreadable or lacks permissions.deny Shell(git)`,
    ]);
  } finally {
    drop(made);
  }
});
