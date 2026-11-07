// Independent scenes: team start must not follow a link when it writes its state.
// A symlink, a hardlink, a directory, or a linked .agents folder is refused, and the
// outside bytes stay as planted. A plain folder still receives the state. Synthetic
// folders and stubbed callbacks only.
import { existsSync, lstatSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { runStart } from '../src/commands/start.ts';
import type { Io } from '../src/io.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const OUTSIDE = 'synthetic outside data\n';

type Place = { base: string; home: string; root: string; outside: string };

function place(): Place {
  const base = fixtureBase('start-state-');
  const home = join(base, 'home');
  const root = join(base, 'project');
  const outside = join(base, 'outside.txt');
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.config', 'team', 'teams.yaml'), 'teams: {}\n');
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(outside, OUTSIDE);
  return { base, home, root, outside };
}

function drop(base: string): void {
  discardFixtures([base], { roots: [dirname(base)] });
}

async function start(root: string, home: string): Promise<number> {
  const io: Io = {
    cwd: root,
    env: {},
    stdinIsTTY: true,
    caller: { kind: 'owner' },
    stdout: () => {},
    stderr: () => {},
  };
  return runStart([], io, {
    home,
    now: () => 0,
    loggedIn: (cli) => cli === 'codex' || cli === 'claude-code',
    notifyRoot: () => {},
    daemonRunning: () => false,
    init: async () => 1,
    up: async () => 1,
    check: () => false,
    ready: () => ({ lead: false, builder: false }),
    send: async () => ({ ok: false, id: null, arrived: false, read: false, working: false, claimedTask: null }),
  });
}

test('a symlink at the state file is refused and the outside file stays byte-identical', async () => {
  const made = place();
  try {
    mkdirSync(join(made.root, '.agents'), { mode: 0o700 });
    const state = join(made.root, '.agents', 'start.json');
    symlinkSync(made.outside, state);
    expect(await start(made.root, made.home)).not.toBe(0);
    expect(lstatSync(state).isSymbolicLink()).toBe(true);
    expect(readFileSync(made.outside, 'utf8')).toBe(OUTSIDE);
  } finally {
    drop(made.base);
  }
});

test('a hardlink at the state file is refused and the outside file stays byte-identical', async () => {
  const made = place();
  try {
    mkdirSync(join(made.root, '.agents'), { mode: 0o700 });
    const state = join(made.root, '.agents', 'start.json');
    linkSync(made.outside, state);
    expect(await start(made.root, made.home)).not.toBe(0);
    expect(lstatSync(state).isSymbolicLink()).toBe(false);
    expect(lstatSync(state).nlink).toBeGreaterThan(1);
    expect(readFileSync(made.outside, 'utf8')).toBe(OUTSIDE);
  } finally {
    drop(made.base);
  }
});

test('a directory at the state file is refused and the outside file stays byte-identical', async () => {
  const made = place();
  try {
    const state = join(made.root, '.agents', 'start.json');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    expect(await start(made.root, made.home)).not.toBe(0);
    expect(lstatSync(state).isDirectory()).toBe(true);
    expect(readdirSync(state)).toEqual([]);
    expect(readFileSync(made.outside, 'utf8')).toBe(OUTSIDE);
  } finally {
    drop(made.base);
  }
});

test('a symlink at .agents is refused and the outside folder stays byte-identical', async () => {
  const made = place();
  try {
    const elsewhere = join(made.base, 'elsewhere');
    const marker = join(elsewhere, 'marker.txt');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(marker, OUTSIDE);
    symlinkSync(elsewhere, join(made.root, '.agents'));
    expect(await start(made.root, made.home)).not.toBe(0);
    expect(lstatSync(join(made.root, '.agents')).isSymbolicLink()).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(OUTSIDE);
    expect(existsSync(join(elsewhere, 'start.json'))).toBe(false);
    expect(existsSync(join(elsewhere, 'team.yaml'))).toBe(false);
  } finally {
    drop(made.base);
  }
});

test('a normal first start writes its state', async () => {
  const made = place();
  try {
    await start(made.root, made.home);
    const state = join(made.root, '.agents', 'start.json');
    expect(lstatSync(state).isFile()).toBe(true);
    const parsed = JSON.parse(readFileSync(state, 'utf8')) as { detect?: boolean };
    expect(parsed.detect).toBe(true);
    expect(readFileSync(made.outside, 'utf8')).toBe(OUTSIDE);
  } finally {
    drop(made.base);
  }
});
