// `team pause` at its edges: one record in the state, the stop points it holds, the caller rule
// (the owner or the team's orchestrator, never the operator and never a human seat), and the
// refusal under a pause that stands.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Caller } from '../src/caller.ts';
import { runPause, type PauseSources } from '../src/commands/pause.ts';
import { PAUSE_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

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

/** The same team with a keeper beside the lead: the operator, which may hold but may not pause. */
const OPERATED = TEAM.replace('operator: lead\n', 'operator: keeper\n').replace(
  '  - role: implementer\n',
  `  - role: operator
    name: keeper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
`,
);

const HUMAN = TEAM.replace('    name: worker\n', '    name: worker\n    human: true\n');

const NOW = new Date('2026-10-04T09:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const ORCHESTRATOR: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };

const files: string[] = [];

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(text = TEAM): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pause-')));
  files.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
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

function recordPane(where: { root: string }, name: string, pane: string): void {
  updateState(join(where.root, '.agents'), (state) => {
    const session = (state.sessions['acme'] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane };
  });
}

function stateText(where: { root: string }): string {
  return readFileSync(join(where.root, '.agents', 'team.state.json'), 'utf8');
}

describe('the pause record', () => {
  test('one record, with a stop point for every declared seat that is not a human\'s', async () => {
    const where = place();
    updateState(join(where.root, '.agents'), (state) => {
      const session = (state.sessions['acme'] ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'w1:p1', last_active: '2026-10-04T08:59:00.000Z' };
      session.worktrees.task = { path: '/work/acme-task', branch: 'feat/task', seat: 'worker', setup: 'ok' };
    });
    const ran = await pause(['--reason', 'freeze deploys'], where);
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toContain('paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys');
    expect(ran.out).toContain('stop lead: ready, last active 2026-10-04T08:59:00.000Z');
    expect(ran.out).toContain('stop worker: branch feat/task, /work/acme-task');
    const record = readState(join(where.root, '.agents')).pause;
    expect(record).toEqual({
      by: 'owner',
      at: '2026-10-04T09:00:00.000Z',
      reason: 'freeze deploys',
      stops: [
        { seat: 'lead', stage: 'ready', last_active: '2026-10-04T08:59:00.000Z' },
        { seat: 'worker', branch: 'feat/task', path: '/work/acme-task' },
      ],
    });
    expect(readFileSync(join(where.root, '.agents', 'team.log'), 'utf8')).toContain(
      '2026-10-04T09:00:00.000Z pause [owner] paused the team: freeze deploys',
    );
  });

  test('a human seat records no stop point', async () => {
    const where = place(HUMAN);
    const ran = await pause([], where);
    expect(ran.code).toBe(0);
    expect(ran.out).not.toContain('stop worker');
    expect(readState(join(where.root, '.agents')).pause?.stops).toEqual([{ seat: 'lead' }]);
  });

  test('the orchestrator\'s seat pauses on its recorded pane, and records itself as the caller', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const ran = await pause([], where, ORCHESTRATOR);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('paused since 2026-10-04T09:00:00.000Z by lead');
    expect(readState(join(where.root, '.agents')).pause?.by).toBe('lead');
  });

  test('the operator is not the orchestrator: it may hold but not pause', async () => {
    const where = place(OPERATED);
    recordPane(where, 'keeper', 'w2:p2');
    const ran = await pause([], where, { kind: 'seat', name: 'keeper', pane: 'w2:p2', session: 'acme' });
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team pause: only the owner or the orchestrator pauses the team; this call is keeper\n');
    expect(readState(join(where.root, '.agents')).pause).toBeUndefined();
  });

  test('a second pause writes nothing and names the record in force', async () => {
    const where = place();
    await pause(['--reason', 'freeze deploys'], where);
    const before = stateText(where);
    const again = await pause([], where);
    expect(again.code).toBe(1);
    expect(again.err).toBe(
      'team pause: already paused: paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys\n',
    );
    expect(stateText(where)).toBe(before);
    const log = readFileSync(join(where.root, '.agents', 'team.log'), 'utf8');
    expect(log.split('\n').filter((line) => line.includes(' pause '))).toHaveLength(1);
  });

  test('--reason needs text', async () => {
    const where = place();
    const ran = await pause(['--reason', '  '], where);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('--reason needs text');
    expect(readState(join(where.root, '.agents')).pause).toBeUndefined();
  });

  test('--json carries the record in a team.pause v1 document', async () => {
    const where = place();
    const ran = await pause(['--reason', 'freeze deploys', '--json'], where);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      status: string;
      pause: { by: string; stops: unknown[] };
    }>(ran.out, PAUSE_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.pause', version: 1 });
    expect(doc.status).toBe('paused');
    expect(doc.pause.by).toBe('owner');
    expect(doc.pause.stops).toEqual([{ seat: 'lead' }, { seat: 'worker' }]);
  });

  test('--all pauses every registered team whose file loads, and names the one that does not', async () => {
    const where = place();
    const beta = join(files[0] as string, 'beta');
    mkdirSync(join(beta, '.agents'), { recursive: true });
    writeFileSync(join(beta, '.agents', 'team.yaml'), TEAM.replace('project: acme', 'project: beta').replace('session: acme', 'session: beta'));
    const broken = join(files[0] as string, 'zeta');
    mkdirSync(join(broken, '.agents'), { recursive: true });
    upsertTeam(where.home, teamIdOf(where.root), { project: 'acme', session: 'acme', root: where.root, roster: [] });
    upsertTeam(where.home, teamIdOf(beta), { project: 'beta', session: 'beta', root: beta, roster: [] });
    upsertTeam(where.home, teamIdOf(broken), { project: 'zeta', session: 'zeta', root: broken, roster: [] });
    const ran = await pause(['--all'], where);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('acme: paused since 2026-10-04T09:00:00.000Z by owner');
    expect(ran.out).toContain('beta: paused since 2026-10-04T09:00:00.000Z by owner');
    expect(ran.out).not.toContain('stop lead');
    expect(ran.err).toContain('team pause: zeta: ');
    expect(ran.err).toContain('left as it is');
    expect(readState(join(where.root, '.agents')).pause).toBeDefined();
    expect(readState(join(beta, '.agents')).pause).toBeDefined();
  });

  test('--all with nothing registered is a team refusal', async () => {
    const where = place();
    const ran = await pause(['--all'], where);
    expect(ran.code).toBe(2);
    expect(ran.err).toBe('team pause: no team is registered on this machine\n');
  });

  test('a seat that is not the orchestrator is refused in a JSON error document', async () => {
    const where = place(OPERATED);
    recordPane(where, 'keeper', 'w2:p2');
    const ran = await pause(['--json'], where, { kind: 'seat', name: 'keeper', pane: 'w2:p2', session: 'acme' });
    expect(ran.code).toBe(1);
    assertJsonErrorShape(ran.out, {
      id: 'pause.caller',
      messageContains: 'only the owner or the orchestrator pauses the team',
      repair: null,
    });
  });
});

// The seat form: `team pause <seat>` stops one declared seat on its own, in a `seat_pauses` map
// beside the team's `pause` record, and resolves its positional seat-first.
describe('the seat form', () => {
  test('a declared seat pauses alone, with one stop point and no team record', async () => {
    const where = place();
    recordPane(where, 'worker', 'w2:p1');
    const ran = await pause(['worker'], where);
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toContain('worker: paused since 2026-10-04T09:00:00.000Z by owner');
    expect(ran.out).toContain('stop worker: ready');
    const state = readState(join(where.root, '.agents'));
    expect(state.pause).toBeUndefined();
    expect(state.seat_pauses).toEqual({
      worker: {
        by: 'owner',
        at: '2026-10-04T09:00:00.000Z',
        stops: [{ seat: 'worker', stage: 'ready' }],
      },
    });
  });

  test('--json names the seat as the target and carries its record', async () => {
    const where = place();
    recordPane(where, 'worker', 'w2:p1');
    const ran = await pause(['--seat', 'worker', '--json'], where);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      target: string;
      value: string;
      pause: { by: string; stops: unknown[] };
    }>(ran.out, PAUSE_OUTPUT_SCHEMA);
    expect(doc.target).toBe('seat');
    expect(doc.value).toBe('worker');
    expect(doc.pause.stops).toEqual([{ seat: 'worker', stage: 'ready' }]);
  });

  test('a name that is both a declared seat and a registered team refuses, and writes nothing', async () => {
    const where = place();
    upsertTeam(where.home, teamIdOf(where.root), {
      project: 'worker', session: 'worker', root: where.root, roster: [],
    });
    const ran = await pause(['worker'], where);
    expect(ran.code).toBe(2);
    expect(ran.err).toBe(
      'team pause: "worker" names both a seat of acme and a registered team; use team pause --seat worker or team pause --team worker\n',
    );
    expect(readState(join(where.root, '.agents')).seat_pauses).toBeUndefined();
  });

  test('an unknown name, a human seat and --seat with --all all refuse, and write nothing', async () => {
    const unknown = await pause(['ghost'], place());
    expect(unknown.code).toBe(2);
    expect(unknown.err).toBe('team pause: no seat named "ghost" is declared in acme, and no registered team has that name\n');

    const human = await pause(['worker'], place(HUMAN));
    expect(human.code).toBe(2);
    expect(human.err).toBe('team pause: worker is a human seat; a pause never touches it\n');

    const where = place();
    const both = await pause(['--seat', 'worker', '--all'], where);
    expect(both.code).toBe(2);
    expect(both.err).toContain('--all and --seat can\'t be used together');
    expect(readState(join(where.root, '.agents')).seat_pauses).toBeUndefined();
  });

  test('an explicit --team stays team-wide even beside a declared seat of that name', async () => {
    const where = place();
    upsertTeam(where.home, teamIdOf(where.root), {
      project: 'acme', session: 'acme', root: where.root, roster: [],
    });
    // A registered team named like the declared seat does not shadow `--team`.
    const ran = await pause(['--team', 'acme'], where);
    expect(ran.code).toBe(0);
    const state = readState(join(where.root, '.agents'));
    expect(state.pause?.by).toBe('owner');
    expect(state.seat_pauses).toBeUndefined();
  });
});
