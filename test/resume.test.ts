// `team resume` at its edges: it clears the record `team pause` wrote, prints the stop points it
// held, refuses when no pause stands, and keeps pause's caller rule.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Caller } from '../src/caller.ts';
import { runPause, type PauseSources } from '../src/commands/pause.ts';
import { runResume, type ResumeSources } from '../src/commands/resume.ts';
import { RESUME_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

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
`;

const NOW = new Date('2026-10-04T09:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const ORCHESTRATOR: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };

const files: string[] = [];

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(text = TEAM): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-resume-')));
  files.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  return { root, home };
}

async function pause(
  where: { root: string; home: string },
  caller: Caller = OWNER,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where.root, caller);
  const code = await runPause(['--reason', 'freeze deploys'], io, {
    home: where.home,
    now: () => NOW,
  } satisfies PauseSources);
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

function recordPane(where: { root: string }, name: string, pane: string): void {
  updateState(join(where.root, '.agents'), (state) => {
    const session = (state.sessions['acme'] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane };
  });
}

describe('resuming', () => {
  test('it clears the record, prints the stop points it held, and logs the resume', async () => {
    const where = place();
    await pause(where);
    const ran = await resume([], where);
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toBe(
      'resumed acme (paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys)\nstop lead: no record\nstop worker: no record\n',
    );
    expect(readState(join(where.root, '.agents')).pause).toBeUndefined();
    expect(readFileSync(join(where.root, '.agents', 'team.log'), 'utf8')).toContain(
      '2026-10-04T09:00:00.000Z resume [owner] resumed the team; paused since 2026-10-04T09:00:00.000Z by owner',
    );
  });

  test('the orchestrator\'s seat resumes on its recorded pane', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    await pause(where);
    const ran = await resume([], where, ORCHESTRATOR);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('resumed acme (');
    expect(readState(join(where.root, '.agents')).pause).toBeUndefined();
  });

  test('with no pause it is refused and changes nothing', async () => {
    const where = place();
    const ran = await resume([], where);
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team resume: not paused\n');
    expect(readState(join(where.root, '.agents')).pause).toBeUndefined();
  });

  test('a hand-edited record that is not what pause writes reads as no pause', async () => {
    const where = place();
    writeFileSync(
      join(where.root, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, pause: { by: 7, at: 'yesterday', stops: [] }, sessions: {} }, null, 2)}\n`,
    );
    const ran = await resume([], where);
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team resume: not paused\n');
  });

  test('--json carries the record it removed in a team.resume v1 document', async () => {
    const where = place();
    await pause(where);
    const ran = await resume(['--json'], where);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      status: string;
      resumed: { by: string; at: string; stops: unknown[] };
    }>(ran.out, RESUME_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.resume', version: 1 });
    expect(doc.status).toBe('resumed');
    expect(doc.resumed.by).toBe('owner');
    expect(doc.resumed.at).toBe('2026-10-04T09:00:00.000Z');
    expect(doc.resumed.stops).toEqual([{ seat: 'lead' }, { seat: 'worker' }]);
  });

  test('--all resumes the paused teams and names the ones with no pause', async () => {
    const where = place();
    const other = join(files[0] as string, 'beta');
    mkdirSync(join(other, '.agents'), { recursive: true });
    writeFileSync(join(other, '.agents', 'team.yaml'), TEAM.replace('project: acme', 'project: beta').replace('session: acme', 'session: beta'));
    upsertTeam(where.home, teamIdOf(where.root), { project: 'acme', session: 'acme', root: where.root, roster: [] });
    upsertTeam(where.home, teamIdOf(other), { project: 'beta', session: 'beta', root: other, roster: [] });
    await pause(where);
    const ran = await resume(['--all'], where);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('resumed acme (paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys)');
    expect(ran.err).toBe('team resume: not paused: beta\n');
    expect(readState(join(where.root, '.agents')).pause).toBeUndefined();
  });

  test('a seat that is not the orchestrator is refused', async () => {
    const where = place();
    recordPane(where, 'worker', 'w2:p2');
    await pause(where);
    const ran = await resume([], where, { kind: 'seat', name: 'worker', pane: 'w2:p2', session: 'acme' });
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team resume: only the owner or the orchestrator resumes the team; this call is worker\n');
    expect(readState(join(where.root, '.agents')).pause).toBeDefined();
  });
});

// The seat form: a seat's own record clears alone, beside a standing team pause or without one.
describe('the seat form', () => {
  async function pauseSeat(seat: string, where: { root: string; home: string }): Promise<void> {
    const io = testIo(where.root, OWNER);
    const code = await runPause([seat], io, { home: where.home, now: () => NOW } satisfies PauseSources);
    if (code !== 0) throw new Error(io.err);
  }

  test('a seat resume clears only that seat and names the team pause it leaves standing', async () => {
    const where = place();
    recordPane(where, 'worker', 'w2:p1');
    await pauseSeat('worker', where);
    await pause(where);
    const ran = await resume(['worker'], where);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('resumed worker (paused since 2026-10-04T09:00:00.000Z by owner)');
    expect(ran.out).toContain('stop worker: ready');
    const state = readState(join(where.root, '.agents'));
    expect(state.pause).toBeDefined();
    expect(state.seat_pauses).toBeUndefined();
  });

  test('a team resume leaves the seat record standing and prints it as still paused', async () => {
    const where = place();
    recordPane(where, 'worker', 'w2:p1');
    await pauseSeat('worker', where);
    await pause(where);
    const ran = await resume([], where);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('resumed acme (paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys)');
    expect(ran.out).toContain('still paused: worker (paused since 2026-10-04T09:00:00.000Z by owner)');
    const state = readState(join(where.root, '.agents'));
    expect(state.pause).toBeUndefined();
    expect(state.seat_pauses?.worker?.at).toBe('2026-10-04T09:00:00.000Z');
  });

  test('a seat JSON resume names the seat as the target and lists the standing team pause', async () => {
    const where = place();
    await pauseSeat('worker', where);
    await pause(where);
    const ran = await resume(['worker', '--json'], where);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<{ target: string; value: string; resumed: { by: string } }>(ran.out, RESUME_OUTPUT_SCHEMA);
    expect(doc.target).toBe('seat');
    expect(doc.value).toBe('worker');
    expect(doc.resumed.by).toBe('owner');
  });

  test('a name that is both a declared seat and a registered team refuses, and points at resume', async () => {
    const where = place();
    const other = join(files[0] as string, 'worker');
    mkdirSync(join(other, '.agents'), { recursive: true });
    writeFileSync(
      join(other, '.agents', 'team.yaml'),
      TEAM.replace('project: acme', 'project: worker').replace('session: acme', 'session: worker'),
    );
    upsertTeam(where.home, teamIdOf(other), { project: 'worker', session: 'worker', root: other, roster: [] });
    const ran = await resume(['worker'], where);
    expect(ran.code).toBe(2);
    expect(ran.err).toBe(
      'team resume: "worker" names both a seat of acme and a registered team; use team resume --seat worker or team resume --team worker\n',
    );
    expect(readState(join(where.root, '.agents')).seat_pauses).toBeUndefined();
  });

  test('a seat with no own record under a team pause names the team; with no pause at all it is not paused', async () => {
    const paused = place();
    await pause(paused);
    const underTeam = await resume(['worker', '--json'], paused);
    expect(underTeam.code).toBe(1);
    expect(underTeam.out).toContain('the team is paused, not the seat; team resume clears the team');
    expect(readState(join(paused.root, '.agents')).pause).toBeDefined();

    const clear = place();
    const none = await resume(['worker', '--json'], clear);
    expect(none.code).toBe(1);
    expect(none.out).toContain('not paused: worker');
    expect(none.out).toContain('team pause worker');
  });
});
