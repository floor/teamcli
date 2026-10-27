// `team proc`: the registry of the processes a team's seats started. Every scene pins its caller:
// a run with no caller reads the real process ancestry, which a herdr seat and a CI runner read
// differently.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { verifiedOf } from '../src/approve/approval.ts';
import { runProc, type ProcSources } from '../src/commands/proc.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { currentTeam } from '../src/file/current.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { PROC_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { liveProcs, pidAlive, pruneProcs, readState, STATE_FILE, updateState, type State } from '../src/state.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';
import { testIo, type TestIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
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
  - role: builder
    name: claude-keeper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const AT = Date.parse('2026-10-04T09:00:00Z');
const LATER = Date.parse('2026-10-04T10:00:00Z');
/** The pid the fixture's processes call running. Any other number is one that is gone: every
 *  scene stands in for the reading, so no assertion depends on a pid this machine happens to have. */
const LIVE = 4243;
const GONE = 4244;

const LIVE_ONLY = (pid: number): boolean => pid === LIVE;

const bases: string[] = [];

afterEach(() => {
  for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(): { root: string; home: string; file: string; session: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-proc-')));
  bases.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  const loaded = currentTeam(root, undefined, new Date(AT), home, false);
  if (!loaded.ok) throw new Error(`the fixture file did not load: ${JSON.stringify(loaded.errors)}`);
  return { root, home, file, session: loaded.team.session };
}

function sources(where: { home: string }, clock: { at: number } = { at: AT }): ProcSources {
  return { home: where.home, now: () => new Date(clock.at), alive: LIVE_ONLY };
}

const owner = (where: { root: string }): TestIo => testIo(where.root, { kind: 'owner' });
const seat = (where: { root: string }, name: string): TestIo => testIo(where.root, { kind: 'seat', name, pane: 'w1:p1' });

/** What an action prints: the context line, then the line it always printed. */
const said = (where: { session: string }, line: string): string =>
  `team acme, session "${where.session}"\n${line}\n`;

/** The state lives beside the team file, in `.agents` — the folder `currentTeam` hands a command. */
const dirOf = (where: { root: string }): string => join(where.root, '.agents');

function procsOf(where: { root: string; session: string }): State['sessions'][string]['procs'] {
  return readState(dirOf(where)).sessions[where.session]?.procs;
}

function seed(where: { root: string; session: string }, procs: Record<string, { by: string; at: string; pid?: number; note?: string }>): void {
  updateState(dirOf(where), (state) => {
    const held = (state.sessions[where.session] ??= { seats: {}, worktrees: {} });
    held.procs = { ...(held.procs ?? {}), ...procs };
  });
}

describe('team proc add', () => {
  test('records a name for the calling seat, with the pid and the note it was given', async () => {
    const where = place();
    const io = seat(where, 'claude-keeper');
    expect(await runProc(['add', 'build', '--pid', String(LIVE), '--note', 'the release build'], io, sources(where))).toBe(0);
    expect(io.out).toBe(said(where, 'proc build: added'));
    expect(io.err).toBe('');
    expect(procsOf(where)).toEqual({
      build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE, note: 'the release build' },
    });
  });

  test('without a pid the record stands on its own, and the owner records as owner', async () => {
    const where = place();
    const io = owner(where);
    expect(await runProc(['add', 'flaky-job'], io, sources(where))).toBe(0);
    expect(procsOf(where)).toEqual({ 'flaky-job': { by: 'owner', at: new Date(AT).toISOString() } });
  });

  test('outside a repository, the no-repository refusal offers no --file: proc takes none', async () => {
    const where = place();
    const bare = join(where.root, 'outside');
    mkdirSync(bare);
    const io = testIo(bare, { kind: 'owner' });
    expect(await runProc(['add', 'build'], io, sources(where))).toBe(2);
    expect(io.err).toBe('team proc: not inside a git repository: run team from a project\n');

    const json = testIo(bare, { kind: 'owner' });
    expect(await runProc(['add', 'build', '--json'], json, sources(where))).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, {
      id: 'proc.file',
      messageContains: 'not inside a git repository: run team from a project',
    });
  });

  test('a pid that is not running is refused and nothing is written', async () => {
    const where = place();
    const io = seat(where, 'claude-keeper');
    expect(await runProc(['add', 'build', '--pid', String(GONE)], io, sources(where))).toBe(1);
    expect(io.err).toBe(`team proc: pid ${GONE} is not running\n`);
    expect(procsOf(where)).toBeUndefined();
  });

  test('the same seat replaces its own record; another seat may not take a live name', async () => {
    const where = place();
    expect(await runProc(['add', 'build', '--pid', String(LIVE)], seat(where, 'claude-keeper'), sources(where))).toBe(0);
    const theirs = seat(where, 'lead');
    expect(await runProc(['add', 'build'], theirs, sources(where, { at: LATER }))).toBe(1);
    expect(theirs.err).toBe(`team proc: "build" is claude-keeper's, live since ${new Date(AT).toISOString()}\n`);
    expect(procsOf(where)?.build?.by).toBe('claude-keeper');
    // The same seat again: its own record, so it is replaced where it stands.
    expect(await runProc(['add', 'build', '--pid', String(LIVE), '--note', 'second try'], seat(where, 'claude-keeper'), sources(where, { at: LATER }))).toBe(0);
    expect(procsOf(where)?.build).toEqual({ by: 'claude-keeper', at: new Date(LATER).toISOString(), pid: LIVE, note: 'second try' });
  });

  test('a name whose process is gone is anyone\'s to take, and the write clears every dead record', async () => {
    const where = place();
    seed(where, {
      build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: GONE },
      stale: { by: 'lead', at: new Date(AT).toISOString(), pid: GONE },
    });
    const io = seat(where, 'lead');
    expect(await runProc(['add', 'build', '--pid', String(LIVE)], io, sources(where, { at: LATER }))).toBe(0);
    expect(procsOf(where)).toEqual({ build: { by: 'lead', at: new Date(LATER).toISOString(), pid: LIVE } });
  });

  test('a caller that is no seat of this team is refused, and a name that is a path is not a name', async () => {
    const where = place();
    const stranger = testIo(where.root, { kind: 'seat', name: 'somebody-else', pane: 'w9:p1' });
    expect(await runProc(['add', 'build'], stranger, sources(where))).toBe(1);
    expect(stranger.err).toBe('team proc: only a seat of this team or the owner records a process; this call is somebody-else\n');
    const unplaced = testIo(where.root, { kind: 'unplaced', reason: 'no seat holds this pane' });
    expect(await runProc(['add', 'build'], unplaced, sources(where))).toBe(1);
    expect(unplaced.err).toContain('unplaced (no seat holds this pane)');
    const bad = seat(where, 'lead');
    expect(await runProc(['add', '../build'], bad, sources(where))).toBe(2);
    expect(bad.err).toBe('team proc: "../build" is a name, not a path: lowercase letters, digits and hyphens\n'
      + 'Usage: team proc add <name> [--pid <pid>] [--note <text>] [--json]\n'
      + '       team proc list [--json]\n'
      + '       team proc done <name> [--json]\n'
      + '\n'
      + 'Exits 0 when the process is recorded, listed, or cleared, 1 when the operation is refused, 2 when the invocation or team file can\'t be read.\n');
    expect(procsOf(where)).toBeUndefined();
  });

  test('a run with no terminal is refused before anything is read', async () => {
    const where = place();
    const io = testIo(where.root, { kind: 'owner-no-tty' });
    expect(await runProc(['add', 'build'], io, sources(where))).toBe(1);
    expect(io.err).toBe('team proc: only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane\n');
  });

  test('--json carries the action envelope under the registered schema', async () => {
    const where = place();
    const io = owner(where);
    expect(await runProc(['add', 'build', '--pid', String(LIVE), '--json'], io, sources(where))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, PROC_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.proc', version: 1 },
      format: 1,
      dry_run: false,
      status: 'added',
      action_summary: 'proc build: added',
      project: 'acme',
      session: where.session,
      target: 'build',
      value: String(LIVE),
    });
    const done = owner(where);
    expect(await runProc(['done', 'build', '--json'], done, sources(where))).toBe(0);
    const after = assertMatchesOutputSchema<Record<string, unknown>>(done.out, PROC_OUTPUT_SCHEMA);
    expect(after).toMatchObject({ status: 'done', action_summary: 'proc build: done', target: 'build', value: null });
  });

  test('--json: a refusal is the team.error document on stdout, stderr empty', async () => {
    const where = place();
    const io = owner(where);
    expect(await runProc(['add', 'build', '--pid', String(GONE), '--json'], io, sources(where))).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'proc.pid', messageContains: `pid ${GONE} is not running` });
    const bad = owner(where);
    expect(await runProc(['add', '../build', '--json'], bad, sources(where))).toBe(2);
    expect(bad.err).toBe('');
    assertJsonErrorShape(bad.out, { id: 'proc.invocation', messageContains: 'is a name, not a path' });
  });

  test('--json is read before the parser: a bad option, or --json=<value>, still writes the error document', async () => {
    const where = place();
    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const io = owner(where);
      expect(await runProc([...argv], io, sources(where))).toBe(2);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'proc.invocation', messageContains, repair: null });
    }
  });
});

describe('team proc list', () => {
  test('prints the live records in name order, and the dead one is skipped', async () => {
    const where = place();
    seed(where, {
      build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE, note: 'the release build' },
      'flaky-job': { by: 'owner', at: new Date(AT).toISOString() },
      gone: { by: 'lead', at: new Date(AT).toISOString(), pid: GONE },
    });
    const io = owner(where);
    expect(await runProc(['list'], io, sources(where))).toBe(0);
    expect(io.out).toBe(
      [
        `team acme, session "${where.session}"`,
        '  NAME       BY             SINCE                     PID   NOTE',
        `  build      claude-keeper  ${new Date(AT).toISOString()}  4243  the release build`,
        `  flaky-job  owner          ${new Date(AT).toISOString()}  -     -`,
        '2 processes',
        '',
      ].join('\n'),
    );
  });

  test('an empty registry is an empty table and a zero count', async () => {
    const where = place();
    const io = owner(where);
    expect(await runProc(['list'], io, sources(where))).toBe(0);
    expect(io.out).toBe(
      [
        `team acme, session "${where.session}"`,
        '  NAME  BY  SINCE  PID  NOTE',
        '0 processes',
        '',
      ].join('\n'),
    );
    const json = owner(where);
    expect(await runProc(['list', '--json'], json, sources(where))).toBe(0);
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(json.out, PROC_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({ procs: [], summary: { processes: 0 }, notice: null });
  });

  test('--json is the records, as they were read', async () => {
    const where = place();
    seed(where, { build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE, note: 'the release build' } });
    const io = owner(where);
    expect(await runProc(['list', '--json'], io, sources(where))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, PROC_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.proc', version: 1 },
      format: 1,
      project: 'acme',
      session: where.session,
      notice: null,
      procs: [{ name: 'build', by: 'claude-keeper', since: new Date(AT).toISOString(), pid: LIVE, note: 'the release build' }],
      summary: { processes: 1 },
    });
  });

  test('a caller the team is not theirs to read is refused in the team\'s own one sentence', async () => {
    const where = place();
    const io = testIo(where.root, { kind: 'unplaced', reason: 'no seat holds this pane' });
    expect(await runProc(['list'], io, sources(where))).toBe(2);
    expect(io.err).toBe('team proc: this team is not yours to read\n');
    const json = testIo(where.root, { kind: 'unplaced', reason: 'no seat holds this pane' });
    expect(await runProc(['list', '--json'], json, sources(where))).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, { id: 'proc.not-yours', messageContains: 'not yours to read' });
  });

  test('an extra word, and the flags of the other verbs, are invocation errors', async () => {
    const where = place();
    const io = owner(where);
    expect(await runProc(['list', 'now'], io, sources(where))).toBe(2);
    expect(io.err).toContain('team proc: unexpected "now"');
    const flagged = owner(where);
    expect(await runProc(['list', '--pid', String(LIVE)], flagged, sources(where))).toBe(2);
    expect(flagged.err).toContain('team proc: list takes no --pid or --note');
  });

  // The reading falls back to the last copy that validated, the way `team status` does. The
  // notice that says so is a document member under `--json`: stdout stays one parseable JSON
  // value, and the action envelopes carry it too.
  test('an invalid team file: the fallback notice is the notice member, never a line before the JSON', async () => {
    const where = place();
    // Remembering is what writes the copy: one read with `remember` on. The scene's own reads
    // pass `false`, like the command's.
    const remembered = currentTeam(where.root, undefined, new Date(AT), where.home, true);
    expect(remembered.ok).toBe(true);
    seed(where, { build: { by: 'owner', at: new Date(AT).toISOString() } });
    writeFileSync(where.file, TEAM.replace('format: 1', 'format: 9'));
    const notice = 'team config is invalid (line 1: format must be 1: this version of team reads no other); using the copy of 2026-10-04T09:00:00.000Z';

    const json = owner(where);
    expect(await runProc(['list', '--json'], json, sources(where))).toBe(0);
    expect(json.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(json.out, PROC_OUTPUT_SCHEMA);
    expect(doc.notice).toBe(notice);
    expect(doc).toMatchObject({ procs: [{ name: 'build' }], summary: { processes: 1 } });

    const plain = owner(where);
    expect(await runProc(['list'], plain, sources(where))).toBe(0);
    expect(plain.out.split('\n')[0]).toBe(notice);

    const added = owner(where);
    expect(await runProc(['add', 'job', '--json'], added, sources(where))).toBe(0);
    expect(added.err).toBe('');
    const addedDoc = assertMatchesOutputSchema<Record<string, unknown>>(added.out, PROC_OUTPUT_SCHEMA);
    expect(addedDoc).toMatchObject({ status: 'added', notice });

    const done = owner(where);
    expect(await runProc(['done', 'job', '--json'], done, sources(where))).toBe(0);
    expect(done.err).toBe('');
    const doneDoc = assertMatchesOutputSchema<Record<string, unknown>>(done.out, PROC_OUTPUT_SCHEMA);
    expect(doneDoc).toMatchObject({ status: 'done', notice });
  });
});

describe('team proc done', () => {
  test('the seat that recorded it clears it, and the file keeps no empty map', async () => {
    const where = place();
    seed(where, { build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE } });
    const io = seat(where, 'claude-keeper');
    expect(await runProc(['done', 'build'], io, sources(where, { at: LATER }))).toBe(0);
    expect(io.out).toBe(said(where, 'proc build: done'));
    expect(procsOf(where)).toEqual({});
  });

  test('another seat may not clear it, a lead may, and the owner may clear anything', async () => {
    const where = place();
    seed(where, { build: { by: 'lead', at: new Date(AT).toISOString(), pid: LIVE } });
    const theirs = seat(where, 'claude-keeper');
    expect(await runProc(['done', 'build'], theirs, sources(where))).toBe(1);
    expect(theirs.err).toBe('team proc: "build" is lead\'s; only lead, a lead or the owner clears it\n');
    expect(procsOf(where)?.build).toBeDefined();
    // The team's own lead tidies after a seat that is gone.
    seed(where, { build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE } });
    const lead = seat(where, 'lead');
    expect(await runProc(['done', 'build'], lead, sources(where))).toBe(0);
    // A lead tidies after a seat, never after the owner: the owner's record is the owner's.
    seed(where, { build: { by: 'owner', at: new Date(AT).toISOString(), pid: LIVE } });
    const leadOnOwner = seat(where, 'lead');
    expect(await runProc(['done', 'build'], leadOnOwner, sources(where))).toBe(1);
    expect(leadOnOwner.err).toBe('team proc: "build" is the owner\'s; only the owner clears it\n');
    const own = owner(where);
    expect(await runProc(['done', 'build'], own, sources(where))).toBe(0);
  });

  test('a name no record holds is refused, and a dead record still takes the name', async () => {
    const where = place();
    const io = seat(where, 'claude-keeper');
    expect(await runProc(['done', 'build'], io, sources(where))).toBe(1);
    expect(io.err).toBe('team proc: no process named "build"\n');
    seed(where, { build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: GONE } });
    expect(await runProc(['done', 'build'], io, sources(where))).toBe(0);
    expect(procsOf(where)).toEqual({});
  });
});

describe('the state door', () => {
  test('a record with no seat or no time is dropped, a pid of the wrong shape goes with it, and a key that is not a name', () => {
    const where = place();
    writeFileSync(join(dirOf(where), STATE_FILE), `${JSON.stringify({
      format: 1,
      sessions: {
        [where.session]: {
          seats: {},
          worktrees: {},
          procs: {
            good: { by: 'lead', at: new Date(AT).toISOString(), pid: LIVE, note: 'fine' },
            'no-seat': { at: new Date(AT).toISOString() },
            'no-time': { by: 'lead' },
            'bad-pid': { by: 'lead', at: new Date(AT).toISOString(), pid: 'many' },
            'bad-note': { by: 'lead', at: new Date(AT).toISOString(), note: { text: 'x' } },
            Bad_Key: { by: 'lead', at: new Date(AT).toISOString() },
            '../escape': { by: 'lead', at: new Date(AT).toISOString() },
          },
        },
      },
    }, null, 2)}\n`);
    expect(readState(dirOf(where)).sessions[where.session]?.procs).toEqual({
      good: { by: 'lead', at: new Date(AT).toISOString(), pid: LIVE, note: 'fine' },
      'bad-pid': { by: 'lead', at: new Date(AT).toISOString() },
      'bad-note': { by: 'lead', at: new Date(AT).toISOString() },
    });
  });

  test('a procs key that is not a map is dropped', () => {
    const where = place();
    writeFileSync(join(dirOf(where), STATE_FILE), `${JSON.stringify({
      format: 1,
      sessions: { [where.session]: { seats: {}, worktrees: {}, procs: 'build' } },
    }, null, 2)}\n`);
    expect(readState(dirOf(where)).sessions[where.session]?.procs).toBeUndefined();
  });
});

describe('liveProcs and pruneProcs', () => {
  test('a record with no pid is live; one whose pid is gone is not, and the write takes it out', () => {
    const session = {
      seats: {},
      worktrees: {},
      procs: {
        b: { by: 'lead', at: new Date(AT).toISOString(), pid: GONE },
        a: { by: 'lead', at: new Date(AT).toISOString(), pid: LIVE },
        c: { by: 'lead', at: new Date(AT).toISOString() },
      },
    };
    expect(liveProcs(session, LIVE_ONLY).map(([name]) => name)).toEqual(['a', 'c']);
    pruneProcs(session, LIVE_ONLY);
    expect(Object.keys(session.procs)).toEqual(['a', 'c']);
  });

  test('the real reading calls this process alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});

describe('team status with processes recorded', () => {
  /** The file as approved, so the reading has nothing to report but what this test seeded. */
  function statusSources(where: { root: string; home: string }): StatusSources {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture file does not validate');
    return {
      // The team as herdr shows it with both seats in their panes: a reading with no difference, so
      // what the test reads is the note alone.
      live: () => ({
        running: true,
        agents: [
          { name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
          { name: 'claude-keeper', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
        ],
        workspaces: [
          { id: 'w1', label: 'claude opus 5.5' },
          { id: 'w2', label: 'claude opus 5.5' },
        ],
        screens: {},
      }),
      branch: () => null,
      standing: () => verifiedOf(checked.team, TEAM, where.root, new Date(AT)),
      now: () => new Date(AT),
      home: where.home,
      alive: LIVE_ONLY,
    };
  }

  test('a note per live record, after the notes the reading already had, and the document carries them', async () => {
    const where = place();
    seed(where, {
      build: { by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE, note: 'the release build' },
      gone: { by: 'lead', at: new Date(AT).toISOString(), pid: GONE },
    });
    updateState(dirOf(where), (state) => {
      (state.sessions[where.session] ??= { seats: {}, worktrees: {} }).watch = { pid: 1, heartbeat: '2026-10-04T08:59:00Z' };
    });
    const io = owner(where);
    expect(await runStatus([], io, statusSources(where))).toBe(0);
    const lines = io.out.split('\n');
    expect(lines).toContain(`note: proc build: claude-keeper since ${new Date(AT).toISOString()}, pid ${LIVE}`);
    expect(io.out).not.toContain('gone');
    // The note is the last one the reading prints: everything the file and the world said comes first.
    const notes = lines.filter((line) => line.startsWith('note: '));
    expect(notes.at(-1)).toBe(`note: proc build: claude-keeper since ${new Date(AT).toISOString()}, pid ${LIVE}`);
    const json = owner(where);
    expect(await runStatus(['--json'], json, statusSources(where))).toBe(0);
    expect(JSON.parse(json.out).procs).toEqual([
      { name: 'build', by: 'claude-keeper', at: new Date(AT).toISOString(), pid: LIVE, note: 'the release build' },
    ]);
  });

  test('no records, no note and no key in the document', async () => {
    const where = place();
    // A watch that ran a minute before the reading: the one difference a healthy team would show.
    updateState(dirOf(where), (state) => {
      (state.sessions[where.session] ??= { seats: {}, worktrees: {} }).watch = { pid: 1, heartbeat: '2026-10-04T08:59:00Z' };
    });
    const io = owner(where);
    expect(await runStatus([], io, statusSources(where))).toBe(0);
    expect(io.out).not.toContain('proc ');
    const json = owner(where);
    expect(await runStatus(['--json'], json, statusSources(where))).toBe(0);
    expect('procs' in JSON.parse(json.out)).toBe(false);
  });
});
