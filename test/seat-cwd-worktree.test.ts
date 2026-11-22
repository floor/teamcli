// A seat cwd at the worktree recorded for that seat loads without a trust entry, and launch
// uses it. The same path recorded for another seat, and a path with no record, refuse only
// that seat. An absolute path or "~" still fails the file. Synthetic folders only.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import type { WorktreeState } from '../src/state.ts';
import { seatCwdRefusal, seatStart } from '../src/worktree/place.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const SENTENCE = 'seat "reviewer-4": cwd ';

type World = {
  base: string;
  root: string;
  home: string;
  lobby: string;
  own: string;
  other: string;
};

function world(): World {
  const base = fixtureBase('seat-cwd-worktree-');
  const root = join(base, 'checkout', 'repo');
  const home = join(base, 'home');
  const lobby = join(home, '.config', 'team', 'lobby');
  const own = join(base, 'worktrees', 'reviewer-4');
  const other = join(base, 'worktrees', 'unrecorded');
  for (const folder of [root, home, lobby, own, other]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  return { base, root, home, lobby, own, other };
}

function discard(held: World): void {
  discardFixtures([held.base], { roots: [dirname(held.base)] });
}

function file(held: World, cwd: string): string {
  return `format: 1
project: fixture
session: morning
coordinator: lead
operator: lead
lobby: ${held.lobby}
workspace:
  mode: shared
trust:
  - ${held.lobby}
  - ${held.root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: example
    model: Example
    version: "1"
    launch: claude
  - role: reviewer
    name: reviewer-4
    cli: cursor
    vendor: example
    model: Example
    version: "1"
    launch: cursor-agent
    cwd: ${cwd}
`;
}

function load(held: World, cwd: string): TeamFile {
  const path = join(held.root, '.agents', 'team.yaml');
  mkdirSync(dirname(path), { mode: 0o700 });
  writeFileSync(path, file(held, cwd), { mode: 0o600 });
  const loaded = loadTeamFile(held.root, { file: path, home: held.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

function seat(team: TeamFile, name: string): Seat {
  const found = team.seats.find((one) => one.name === name);
  if (found === undefined) throw new Error(`no seat ${name}`);
  return found;
}

function record(path: string, owner: string): WorktreeState {
  return { path, branch: 'fix/reviewer-4', setup: 'ok', seat: owner };
}

test('a cwd at the worktree recorded for that seat validates, and launch uses it', () => {
  const held = world();
  try {
    const cwd = relative(held.root, held.own);
    const team = load(held, cwd);
    const cursor = seat(team, 'reviewer-4');
    expect(team.seats.map((one) => one.name)).toEqual(['lead', 'reviewer-4']);
    expect(cursor).toMatchObject({ cwd, cwdOutside: true });
    expect(seat(team, 'lead').cwdOutside).toBeUndefined();
    // The record's path is the folder itself, not the relative spelling in the file.
    expect(seatCwdRefusal(cursor, { task: record(held.own, 'reviewer-4') }, held.root)).toBeNull();
    expect(seatCwdRefusal(cursor, { task: record(cwd, 'reviewer-4') }, held.root)).toBeNull();
    // A task key equal to the seat, with no seat field, is not that seat's record.
    const unnamed = { path: held.own, branch: 'fix/reviewer-4', setup: 'ok' as const };
    expect(seatCwdRefusal(cursor, { 'reviewer-4': unnamed }, held.root)).toBe(
      `${SENTENCE}"${cwd}" is outside the project and matches no trust path`,
    );
    expect(seatStart(team, cursor, held.root, held.home)).toEqual({ cwd });
  } finally {
    discard(held);
  }
});

test('the same path recorded for another seat is refused for this seat', () => {
  const held = world();
  try {
    const cwd = relative(held.root, held.own);
    const cursor = seat(load(held, cwd), 'reviewer-4');
    const why = seatCwdRefusal(cursor, { task: record(held.own, 'lead') }, held.root);
    expect(why).toBe(`${SENTENCE}"${cwd}" is outside the project and matches no trust path`);
  } finally {
    discard(held);
  }
});

test('an unrecorded outside path refuses that seat and the other seat still loads', () => {
  const held = world();
  try {
    const cwd = relative(held.root, held.other);
    const team = load(held, cwd);
    expect(team.seats.map((one) => one.name)).toEqual(['lead', 'reviewer-4']);
    expect(seatCwdRefusal(seat(team, 'lead'), {}, held.root)).toBeNull();
    const why = seatCwdRefusal(seat(team, 'reviewer-4'), {}, held.root);
    expect(why).toBe(`${SENTENCE}"${cwd}" is outside the project and matches no trust path`);
    // A path that only looks like a worktree, with a record of some other folder, is not accepted.
    const elsewhere = record(held.own, 'reviewer-4');
    expect(seatCwdRefusal(seat(team, 'reviewer-4'), { task: elsewhere }, held.root)).toBe(why);
  } finally {
    discard(held);
  }
});

test('a reader outside the team accepts a cwd that its own root resolves under trust', () => {
  const held = world();
  try {
    const cwd = relative(held.root, held.own);
    const text = file(held, cwd).replace(
      `  - ${held.root}\n`,
      `  - ${held.root}\n  - ${join(held.base, 'worktrees')}\n`,
    );
    const path = join(held.root, '.agents', 'team.yaml');
    mkdirSync(dirname(path), { mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    const fromTeam = loadTeamFile(held.root, { file: path, home: held.home });
    if (!fromTeam.ok) throw new Error(JSON.stringify(fromTeam.errors));
    expect(seat(fromTeam.team, 'reviewer-4').cwdOutside).toBeUndefined();
    expect(seat(fromTeam.team, 'lead').cwdOutside).toBeUndefined();
    // The same text, with no team root, resolves the cwd from this process's folder and misses the trust path.
    const fromReader = validateTeamFile(text, { home: held.home });
    if (!fromReader.ok) throw new Error(JSON.stringify(fromReader.errors));
    expect(seat(fromReader.team, 'reviewer-4').cwdOutside).toBe(true);
  } finally {
    discard(held);
  }
});

test('a recorded worktree inside the protected checkout starts, and an unrecorded path does not', () => {
  const held = world();
  try {
    const cwd = '.agents/worktrees/fixture-task';
    mkdirSync(join(held.root, cwd), { recursive: true, mode: 0o700 });
    const text = file(held, cwd).replace('cli: cursor', 'cli: grok').replace('launch: cursor-agent', 'launch: grok').replace(
      'workspace:\n  mode: shared\n',
      'workspace:\n  mode: shared\n  protected: [.] \n',
    );
    const path = join(held.root, '.agents', 'team.yaml');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    const loaded = loadTeamFile(held.root, { file: path, home: held.home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const grok = seat(loaded.team, 'reviewer-4');
    const recorded = { seats: {}, worktrees: { 'fixture-task': record(cwd, 'reviewer-4') } };
    expect(seatStart(loaded.team, grok, held.root, held.home, undefined, undefined, recorded)).toEqual({ cwd });
    const refused = seatStart(loaded.team, grok, held.root, held.home);
    expect('problem' in refused).toBe(true);
    if ('problem' in refused) expect(refused.problem).toContain('protected checkout');
  } finally {
    discard(held);
  }
});

test('an absolute cwd or a home cwd is still refused', () => {
  const held = world();
  try {
    const absolute = validateTeamFile(file(held, '/srv/acme'), { home: held.home, root: held.root });
    const home = validateTeamFile(file(held, '~/Code/acme'), { home: held.home, root: held.root });
    expect(absolute.ok).toBe(false);
    expect(home.ok).toBe(false);
    if (!absolute.ok) expect(absolute.errors.map((problem) => problem.message).join('\n')).toMatch(/cwd must be relative/);
    if (!home.ok) expect(home.errors.map((problem) => problem.message).join('\n')).toMatch(/cwd must be relative/);
  } finally {
    discard(held);
  }
});
