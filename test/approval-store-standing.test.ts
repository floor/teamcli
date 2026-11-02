// What the approval store says about a root, from one verified read. `none` is a project no
// approval was ever written for on this machine, and the recorded generation is what says so:
// it is written before any record and outlives the record's removal. A project that has one is
// never `none` again — a record that was unlinked, a store that went missing, a folder that
// cannot be listed, and a path that holds a link each refuse with the one-step repair the owner
// can take. `up` inherits the refusal: a broken record stops a launch instead of authorising one,
// and a virgin team still admits.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { generationsFolder } from '../src/store/keys.ts';
import { approvalStanding, readApproval, storePath, writeApproval, type Standing } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T12:00:00Z');

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

/** A project root with its rules file, and the home beside it the store lives in. */
function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-standing-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), file(root));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

/** The owner's approval of this root, written the way `team approve` writes one: a signed record
 *  at generation 1, with the generation recorded beside the key. */
function approve(root: string, home: string): string {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const store = storePath(loaded.team.project, loaded.root, home);
  writeApproval(
    store,
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(join(root, '.agents', 'team.yaml'), 'utf8') },
    loaded.team.seats,
    home,
    NOW,
  );
  return store;
}

function standingOf(root: string, home: string): Standing {
  return approvalStanding(root, home);
}

function refusedWhy(standing: Standing): string {
  if (standing.kind !== 'refused') throw new Error(`expected refused, got ${standing.kind}`);
  return standing.why;
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const panes: string[] = [];
  const runs: { pane: string; command: string }[] = [];
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `pane-${n}`;
      panes.push(pane);
      return { pane, workspace: `workspace-${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => panes,
    agents: () => [],
    paneText: () => CLAUDE_IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return { launch, runs };
}

function sources(home: string, launch: Launch): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    doctor: doctor(home),
    launch,
    now: () => NOW,
  };
}

/** An owner's `up` in a root, with dev mode unset: the refusal or the launch it decided. */
async function up(place: { root: string; home: string }): Promise<{ code: number; launches: number; err: string }> {
  const w = world();
  const io = testIo(place.root, { kind: 'owner' });
  io.env = {};
  const code = await runUp([], io, sources(place.home, w.launch));
  return { code, launches: w.runs.length, err: io.err };
}

test('a project no approval was ever written for is none, and the read writes nothing', () => {
  const { root, home } = repo();
  expect(standingOf(root, home).kind).toBe('none');
  expect(existsSync(generationsFolder(home))).toBe(false);
  expect(existsSync(storePath('acme', root, home))).toBe(false);
});

test('a signed record is verified, and a second read leaves its bytes as they were', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const record = join(store, 'approval.json');
  const before = readFileSync(record, 'utf8');
  const first = standingOf(root, home);
  expect(first.kind).toBe('verified');
  if (first.kind === 'verified') expect(first.generation).toBe(1);
  expect(standingOf(root, home).kind).toBe('verified');
  expect(readFileSync(record, 'utf8')).toBe(before);
});

test('a recorded approval whose record was unlinked is refused, never none', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  unlinkSync(join(store, 'approval.json'));
  const why = refusedWhy(standingOf(root, home));
  expect(why).toContain('approval #1 is recorded');
  expect(why).toContain('its record is missing');
  expect(why).toContain(join(store, 'approval.json'));
});

test('a recorded approval whose store was removed is refused, never none', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  rmSync(store, { recursive: true, force: true });
  const why = refusedWhy(standingOf(root, home));
  expect(why).toContain('approval #1 is recorded');
  expect(why).toContain('its store is missing');
  expect(why).toContain(store);
});

test('a link where the record was is refused, whether or not it points at a record', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const record = join(store, 'approval.json');
  const saved = join(home, 'saved-record');
  renameSync(record, saved);
  // A link to a record that is not there, then to one that is: neither is the record.
  symlinkSync(join(home, 'no-such-record'), record);
  expect(refusedWhy(standingOf(root, home))).toContain('holds a link');
  unlinkSync(record);
  symlinkSync(saved, record);
  expect(refusedWhy(standingOf(root, home))).toContain('holds a link');
});

test('a store that is a link is refused', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const saved = `${store}-saved`;
  renameSync(store, saved);
  symlinkSync(saved, store);
  expect(refusedWhy(standingOf(root, home))).toContain('holds a link');
});

test('a store index that cannot be listed is refused, not read as a home with no approval', () => {
  const { root, home } = repo();
  approve(root, home);
  const original = fs.readdirSync;
  const spy = spyOn(fs, 'readdirSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (String(path) === join(home, '.config', 'team')) throw Object.assign(new Error('the store index cannot be read'), { code: 'EACCES' });
    return Reflect.apply(original, fs, [path, ...rest]);
  }) as unknown as typeof fs.readdirSync);
  try {
    const why = refusedWhy(standingOf(root, home));
    expect(why).toContain('approval #1 is recorded');
    expect(why).toContain('cannot be read');
  } finally {
    spy.mockRestore();
  }
});

test('a record that cannot be read is refused, with the read error named', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const record = join(store, 'approval.json');
  const original = fs.readFileSync;
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (String(path) === record) throw Object.assign(new Error('the record cannot be read'), { code: 'EACCES' });
    return Reflect.apply(original, fs, [path, ...rest]);
  }) as unknown as typeof fs.readFileSync);
  try {
    const why = refusedWhy(standingOf(root, home));
    expect(why).toContain('the approval record cannot be read');
  } finally {
    spy.mockRestore();
  }
});

test('a generation that is recorded but cannot be read is refused', () => {
  const { root, home } = repo();
  approve(root, home);
  const folder = generationsFolder(home);
  const [entry] = readdirSync(folder);
  if (entry === undefined) throw new Error('expected a recorded generation');
  writeFileSync(join(folder, entry), 'not a generation\n');
  const why = refusedWhy(standingOf(root, home));
  expect(why).toContain('generation cannot be read');
  // A refusal names the path the owner must restore, whole.
  expect(why).toContain(join(folder, entry));
});

test('a link where the generation is is refused, whether or not it points at one', () => {
  const { root, home } = repo();
  approve(root, home);
  const folder = generationsFolder(home);
  const [entry] = readdirSync(folder);
  if (entry === undefined) throw new Error('expected a recorded generation');
  const path = join(folder, entry);
  const saved = join(home, 'saved-generation.json');
  renameSync(path, saved);
  // A link to a generation that is not there, then to one that is: neither is the generation.
  symlinkSync(join(home, 'no-such-generation.json'), path);
  expect(refusedWhy(standingOf(root, home))).toContain('is a link');
  unlinkSync(path);
  symlinkSync(saved, path);
  expect(refusedWhy(standingOf(root, home))).toContain('is a link');
});

test('a generations folder that is a link is refused', () => {
  const { root, home } = repo();
  approve(root, home);
  const folder = generationsFolder(home);
  renameSync(folder, `${folder}-saved`);
  symlinkSync(`${folder}-saved`, folder);
  expect(refusedWhy(standingOf(root, home))).toContain('is a link');
});

test('a generations folder that is a file is refused, never read as no generation', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const folder = generationsFolder(home);
  renameSync(folder, `${folder}-saved`);
  writeFileSync(folder, 'a file where the generations folder was\n');
  // The store goes too: the missing store must not be able to answer for the unreadable path.
  rmSync(store, { recursive: true, force: true });
  expect(refusedWhy(standingOf(root, home))).toContain('is not a folder');
});

test('a record whose signature is refused stays refused when the record is unlinked', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const record = join(store, 'approval.json');
  const stored = JSON.parse(readFileSync(record, 'utf8')) as { signature: string };
  stored.signature = '00'.repeat(64);
  writeFileSync(record, `${JSON.stringify(stored, null, 2)}\n`);
  expect(refusedWhy(standingOf(root, home))).toContain('does not carry a valid signature');
  unlinkSync(record);
  expect(refusedWhy(standingOf(root, home))).toContain('its record is missing');
});

test('a record written before records were signed still reads as legacy', () => {
  const { root, home } = repo();
  const store = approve(root, home);
  const record = join(store, 'approval.json');
  const stored = JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>;
  const { generation: _generation, signature: _signature, ...plain } = stored;
  writeFileSync(record, `${JSON.stringify({ ...plain, format: 1 }, null, 2)}\n`);
  expect(standingOf(root, home).kind).toBe('legacy');
  // The record itself is still what the store holds: a legacy record is displayed, never judged.
  expect(readApproval(store)?.approval.format).toBe(1);
});

test('up admits a virgin team and refuses a recorded approval whose record is gone', async () => {
  const virgin = repo();
  const admitted = await up(virgin);
  expect(admitted.code, admitted.err).toBe(0);
  expect(admitted.launches).toBeGreaterThan(0);

  const broken = repo();
  const store = approve(broken.root, broken.home);
  unlinkSync(join(store, 'approval.json'));
  const stopped = await up(broken);
  expect(stopped.code).toBe(1);
  expect(stopped.launches).toBe(0);
  expect(stopped.err).toContain('its record is missing');
});
