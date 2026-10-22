// Independent acceptance for Floor's 2026-10-22 addition to the 0.5.5 quota lane: a pause that
// names one seat. Written red-first at source 2f056c6b1871006453dd6e37122cf6ff924c02e1, where the
// command knows only the team-wide pause; every scene that asks for the seat form is red there.
//
// The contract pinned here is builder-4's answer of 2026-10-22, in its own words:
//   syntax   `team pause <seat>` resolves a declared seat of the current folder first;
//            `--seat <name>` is the explicit form and `--team <name>` the explicit team-wide
//            form; a name that is both a declared seat and a registered team is refused, exit 2,
//            with the two explicit forms named; an unknown name refuses, exit 2.
//   records  one top-level `seat_pauses` map; a seat's record is `{ by, at, reason?, stops }`
//            with exactly that seat's stop point, independent of the team's `pause` record.
//   next     the paused seat claims nothing: exit 1, `next.paused`, the seat named and the
//            `team resume <seat>` repair; another seat keeps claiming.
//   lease    no pause touches a held lease: `team next --release` still unlinks the seat's own.
//   resume   `team resume <seat>` clears only the seat's record; a standing team pause is left
//            standing and named; a team-wide resume leaves seat records in place.
//   caller   unchanged: the owner, or the team's own orchestrator on its recorded pane.
//
// The public commands are called as a caller calls them; the state is read from its file, which
// is where the contract says the map lives. The frames of `acceptance.test.ts` are not involved.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runNext, type NextSources } from '../../src/commands/next.ts';
import { runPause, type PauseSources } from '../../src/commands/pause.ts';
import { runResume, type ResumeSources } from '../../src/commands/resume.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';
import { assertJsonErrorShape } from '../helpers/output.ts';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
tasks:
  source: file
  path: .agents/tasks.yaml
`;

/** A second project registered under the name the current folder gives a seat. */
const OTHER = TEAM.replace('project: acme\n', 'project: worker\n').replace('session: acme\n', 'session: worker\n');

const NOW = new Date('2026-10-04T09:00:00Z');
const AT = '2026-10-04T09:00:00.000Z';
const OWNER: Caller = { kind: 'owner' };
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const WORKER: Caller = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' };

const files: string[] = [];

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(text = TEAM, name = 'acme'): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-pause-')));
  files.push(base);
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
  return root;
}

function place(text = TEAM): { root: string; home: string } {
  const root = project(text);
  const home = join(root, '..', 'home');
  mkdirSync(home);
  return { root, home };
}

async function pause(
  argv: string[],
  where: { root: string; home: string },
  caller: Caller = OWNER,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where.root, caller);
  const code = await runPause(argv, io, { home: where.home, now: () => NOW } satisfies PauseSources);
  return { code, out: io.out, err: io.err };
}

async function resume(
  argv: string[],
  where: { root: string; home: string },
  caller: Caller = OWNER,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where.root, caller);
  const code = await runResume(argv, io, { home: where.home, now: () => NOW } satisfies ResumeSources);
  return { code, out: io.out, err: io.err };
}

async function next(
  argv: string[],
  where: { root: string; home: string },
  caller: Caller = LEAD,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where.root, caller);
  const code = await runNext(argv, io, { home: where.home, now: () => NOW.getTime() } satisfies NextSources);
  return { code, out: io.out, err: io.err };
}

/** The state as its file holds it, so a key the running build does not know is still visible. */
function stateOf(where: { root: string }): Record<string, unknown> | undefined {
  const path = join(where.root, '.agents', 'team.state.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function seatPause(where: { root: string }, seat: string): Record<string, unknown> | undefined {
  const map = stateOf(where)?.seat_pauses as Record<string, Record<string, unknown>> | undefined;
  return map?.[seat];
}

function lease(where: { root: string }): Record<string, unknown> | undefined {
  const path = join(where.root, '.agents', 'leases', 'm1.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('the seat form of team pause', () => {
  test('a declared seat name pauses that seat alone, with its one stop point', async () => {
    const where = place();
    const ran = await pause(['worker'], where);
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toContain(`worker: paused since ${AT} by owner`);
    expect(ran.out).toContain('stop worker: ready');
    expect(seatPause(where, 'worker')).toEqual({
      by: 'owner',
      at: AT,
      stops: [{ seat: 'worker', stage: 'ready' }],
    });
    expect(stateOf(where)?.pause).toBeUndefined();
    expect(seatPause(where, 'lead')).toBeUndefined();
  });

  test('--seat is the explicit form and writes the same record', async () => {
    const where = place();
    const ran = await pause(['--seat', 'worker'], where);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(`worker: paused since ${AT} by owner`);
    expect(seatPause(where, 'worker')?.at).toBe(AT);
    expect(stateOf(where)?.pause).toBeUndefined();
  });

  test('--team is the explicit team-wide form, even beside a declared seat of that name', async () => {
    const where = place();
    upsertTeam(where.home, teamIdOf(where.root), { project: 'acme', session: 'acme', root: where.root, roster: [] });
    const ran = await pause(['--team', 'acme'], where);
    expect(ran.code).toBe(0);
    expect(stateOf(where)?.pause).toMatchObject({ by: 'owner', at: AT });
    expect(seatPause(where, 'worker')).toBeUndefined();
  });

  test('a name that is both a declared seat and a registered team refuses, exit 2, and writes nothing', async () => {
    const where = place();
    const other = project(OTHER, 'worker');
    upsertTeam(where.home, teamIdOf(other), { project: 'worker', session: 'worker', root: other, roster: [] });
    const ran = await pause(['worker'], where);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain(
      `"worker" names both a seat of acme and a registered team; use team pause --seat worker or team pause --team worker`,
    );
    expect(stateOf(where)?.pause).toBeUndefined();
    expect(seatPause(where, 'worker')).toBeUndefined();
  });

  test('an unknown name refuses, exit 2, and writes nothing', async () => {
    const where = place();
    const ran = await pause(['ghost'], where);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain(
      `no seat named "ghost" is declared in acme, and no registered team has that name`,
    );
    expect(stateOf(where)?.pause).toBeUndefined();
    expect(seatPause(where, 'ghost')).toBeUndefined();
  });

  test('--seat with --all is refused and writes nothing', async () => {
    const where = place();
    const ran = await pause(['--seat', 'worker', '--all'], where);
    expect(ran.code).toBe(2);
    expect(stateOf(where)?.pause).toBeUndefined();
    expect(seatPause(where, 'worker')).toBeUndefined();
  });

  test('a second pause of the same seat refuses, naming the standing record', async () => {
    const where = place();
    expect((await pause(['worker'], where)).code).toBe(0);
    const again = await pause(['worker', '--json'], where);
    expect(again.code).toBe(1);
    assertJsonErrorShape(again.out, {
      id: 'pause.paused',
      messageContains: `already paused: worker (paused since ${AT} by owner)`,
      repair: 'team resume worker',
    });
  });

  test('the caller rule is unchanged: a seat does not pause itself, and the orchestrator may pause another seat', async () => {
    const denied = await pause(['worker'], place(), WORKER);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('only the owner or the orchestrator pauses the team');

    const where = place();
    const ran = await pause(['worker'], where, LEAD);
    expect(ran.code).toBe(0);
    expect(typeof seatPause(where, 'worker')?.by).toBe('string');
    expect(seatPause(where, 'worker')?.by).not.toBe('');
  });

  test('JSON names the seat as the target and carries the record', async () => {
    const where = place();
    const ran = await pause(['worker', '--json'], where);
    expect(ran.code).toBe(0);
    const doc = JSON.parse(ran.out) as Record<string, unknown>;
    expect(doc.schema).toEqual({ name: 'team.pause', version: 1 });
    expect(doc.target).toBe('seat');
    expect(doc.value).toBe('worker');
    expect(doc.pause).toMatchObject({ by: 'owner', at: AT, stops: [{ seat: 'worker', stage: 'ready' }] });
  });
});

describe('the seat record beside the team record', () => {
  test('a seat may be paused while the team is paused, and the two records are independent', async () => {
    const where = place();
    expect((await pause([], where)).code).toBe(0);
    const seat = await pause(['worker'], where);
    expect(seat.code).toBe(0);
    expect(seat.out).toContain(`worker: paused since ${AT} by owner`);
    expect(stateOf(where)?.pause).toBeDefined();
    expect(seatPause(where, 'worker')?.at).toBe(AT);

    // The seat resumes alone; the team's pause stays and is named.
    const resumed = await resume(['worker'], where);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain(`resumed worker (paused since ${AT} by owner)`);
    expect(stateOf(where)?.pause).toBeDefined();
    expect(seatPause(where, 'worker')).toBeUndefined();

    // The team resumes alone; nothing of the seat is left to clear.
    expect((await resume([], where)).code).toBe(0);
    expect(stateOf(where)?.pause).toBeUndefined();
  });

  test('a team-wide resume leaves a seat pause standing, and the next seat check clears it', async () => {
    const where = place();
    expect((await pause(['worker'], where)).code).toBe(0);
    expect((await pause([], where)).code).toBe(0);
    expect((await resume([], where)).code).toBe(0);
    expect(seatPause(where, 'worker')?.at).toBe(AT);
    expect(stateOf(where)?.pause).toBeUndefined();

    const resumed = await resume(['worker'], where);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain(`resumed worker (paused since ${AT} by owner)`);
    expect(seatPause(where, 'worker')).toBeUndefined();
  });

  test('resuming a seat with no own record under a team pause names the team', async () => {
    const where = place();
    expect((await pause([], where)).code).toBe(0);
    const ran = await resume(['worker', '--json'], where);
    expect(ran.code).toBe(1);
    assertJsonErrorShape(ran.out, {
      id: 'resume.not-paused',
      messageContains: 'the team is paused, not the seat; team resume clears the team',
      repair: 'team resume',
    });
    expect(stateOf(where)?.pause).toBeDefined();
    expect(seatPause(where, 'worker')).toBeUndefined();
  });

  test('resuming a seat with no pause at all keeps the existing not-paused refusal', async () => {
    const where = place();
    const ran = await resume(['worker', '--json'], where);
    expect(ran.code).toBe(1);
    assertJsonErrorShape(ran.out, {
      id: 'resume.not-paused',
      messageContains: 'not paused',
      repair: 'team pause worker',
    });
    expect(seatPause(where, 'worker')).toBeUndefined();
  });
});

describe('the paused seat in the queue', () => {
  test('the paused seat claims nothing while another seat keeps claiming', async () => {
    const where = place();
    expect((await pause(['worker'], where)).code).toBe(0);

    const refused = await next(['--json'], where, WORKER);
    expect(refused.code).toBe(1);
    assertJsonErrorShape(refused.out, {
      id: 'next.paused',
      messageContains: `the seat is paused (paused since ${AT} by owner)`,
      repair: 'team resume worker',
    });
    expect(lease(where)).toBeUndefined();

    const claimed = await next(['--json'], where, LEAD);
    expect(claimed.code).toBe(0);
    expect(lease(where)).toMatchObject({ id: 'm1', seat: 'lead' });
  });

  test('a held lease survives the pause and --release still lets the seat go', async () => {
    const where = place();
    expect((await next(['--json'], where, WORKER)).code).toBe(0);
    expect(lease(where)).toMatchObject({ id: 'm1', seat: 'worker' });

    expect((await pause(['worker'], where)).code).toBe(0);
    expect(lease(where)).toMatchObject({ id: 'm1', seat: 'worker' });

    const released = await next(['--release'], where, WORKER);
    expect(released.code).toBe(0);
    expect(lease(where)).toBeUndefined();
    expect(seatPause(where, 'worker')?.at).toBe(AT);

    // Resume restores the seat's claim.
    expect((await resume(['worker'], where)).code).toBe(0);
    expect((await next(['--json'], where, WORKER)).code).toBe(0);
    expect(lease(where)).toMatchObject({ id: 'm1', seat: 'worker' });
  });
});
