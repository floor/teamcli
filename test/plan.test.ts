// `team plan`: the takeable queue, in `team next`'s order, with no claim of any kind — the bytes
// it prints are the contract's STEP/STATE/OWNER/TITLE table, and the only mark it adds is the
// STATE `overdue`, which decides nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_RUNNING } from '../src/broker/client.ts';
import { startBroker } from '../src/broker/server.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { main } from '../src/cli.ts';
import { runIssues } from '../src/commands/issues.ts';
import { runNext } from '../src/commands/next.ts';
import { runPlan, USAGE, type PlanSources } from '../src/commands/plan.ts';
import { NOT_A_REPO } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { PLAN_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

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
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const WITH = `${TEAM}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const LINEAR = `${TEAM}tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
`;

const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' };
const otherPane: Caller = { kind: 'seat', name: 'lead', pane: 'w9:p1', session: 'acme' };

let base: string;
let root: string;
let home: string;
let now = Date.parse('2026-10-08T09:00:00.000Z');

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function project(text = WITH): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-plan-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  now = Date.parse('2026-10-08T09:00:00.000Z');
}

function list(text: string): void {
  writeFileSync(join(root, '.agents', 'tasks.yaml'), text);
}

function record(): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function ready(text = WITH, tasks: string | null = '- id: m1\n  title: the task title\n'): void {
  project(text);
  if (tasks !== null) list(tasks);
  record();
}

async function run(argv: string[] = [], caller: Caller = lead, sources: PlanSources = {}, cwd = root) {
  const io = testIo(cwd, caller);
  const code = await runPlan(argv, io, { home, now: () => now, ...sources });
  return { code, out: io.out, err: io.err };
}

function leaseNames(): string[] {
  const dir = join(root, '.agents', 'leases');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

function stateBytes(): string | null {
  const path = join(root, '.agents', 'team.state.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function logBytes(): string | null {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

describe('team plan', () => {
  test('the queue is next\'s order, not issues\' file order', async () => {
    ready(
      WITH,
      '- id: m1\n  title: the first title\n- id: m2\n  title: the second title\n  priority: 1\n- id: m3\n  title: the third title\n  priority: alpha\n',
    );
    const planned = await run();
    expect(planned).toEqual({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        '  STEP  STATE  OWNER  TITLE\n' +
        '  1     open   -      the second title\n' +
        '  2     open   -      the third title\n' +
        '  3     open   -      the first title\n' +
        '3 task(s)\n',
      err: '',
    });
    const listed = testIo(root);
    expect(await runIssues([], listed, { home })).toBe(0);
    expect(listed.out).toBe(
      'team acme, session "acme"\n' +
        '  ID  STATE  ASSIGNEE  TITLE\n' +
        '  m1  open   -         the first title\n' +
        '  m2  open   -         the second title\n' +
        '  m3  open   -         the third title\n' +
        '3 issue(s)\n',
    );
    expect(planned.out).not.toBe(listed.out);
    ready(WITH, '- id: z\n  title: the z title\n- id: a\n  title: the a title\n');
    expect(await run()).toMatchObject({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        '  STEP  STATE  OWNER  TITLE\n' +
        '  1     open   -      the z title\n' +
        '  2     open   -      the a title\n' +
        '2 task(s)\n',
    });
    project(`${WITH}  fallback: id\n`);
    list('- id: z\n  title: the z title\n- id: a\n  title: the a title\n');
    record();
    expect(await run()).toMatchObject({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        '  STEP  STATE  OWNER  TITLE\n' +
        '  1     open   -      the a title\n' +
        '  2     open   -      the z title\n' +
        '2 task(s)\n',
    });
  });

  test('a deadline the clock has passed is marked, and the mark decides nothing', async () => {
    ready(
      WITH,
      '- id: past\n  title: the past title\n  deadline: 2026-01-01T00:00:00Z\n- id: future\n  title: the future title\n  deadline: 2026-12-31T00:00:00Z\n- id: soon\n  title: the unreadable title\n  deadline: soon\n- id: day\n  title: the date-only title\n  deadline: 2026-01-01\n',
    );
    expect(await run()).toEqual({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        '  STEP  STATE    OWNER  TITLE\n' +
        '  1     overdue  -      the past title\n' +
        '  2     open     -      the future title\n' +
        '  3     open     -      the unreadable title\n' +
        '  4     overdue  -      the date-only title\n' +
        '4 task(s)\n',
      err: '',
    });
    // At the deadline itself the clock has not passed it: the comparison is strictly before now.
    const at = await run([], lead, { now: () => Date.parse('2026-01-01T00:00:00.000Z') });
    expect(at.code).toBe(0);
    expect(at.out).toContain('  1     open   -      the past title\n');
    expect(at.out).toContain('  4     open   -      the date-only title\n');
    expect(at.out).not.toContain('overdue');
  });

  test('the mark is plan\'s alone: next and issues do not carry one', async () => {
    ready(WITH, '- id: past\n  title: the past title\n  deadline: 2026-01-01T00:00:00Z\n');
    const io = testIo(root, lead);
    expect(await runNext([], io, { home, now: () => now })).toBe(0);
    expect(io.out).toBe('past  the past title\n  deadline: 2026-01-01T00:00:00Z\n');
    const listed = testIo(root);
    expect(await runIssues([], listed, { home })).toBe(0);
    expect(listed.out).toBe(
      'team acme, session "acme"\n  ID    STATE  ASSIGNEE  TITLE\n  past  open   -         the past title\n1 issue(s)\n',
    );
  });

  test('a held record still appears, and nothing is written', async () => {
    ready();
    const held = testIo(root, lead);
    expect(await runNext([], held, { home, now: () => now })).toBe(0);
    expect(leaseNames()).toEqual(['m1.json']);
    const leaseBefore = readFileSync(join(root, '.agents', 'leases', 'm1.json'), 'utf8');
    const stateBefore = stateBytes();
    const logBefore = logBytes();
    const planned =
      'team acme, session "acme"\n' +
      '  STEP  STATE  OWNER  TITLE\n' +
      '  1     open   -      the task title\n' +
      '1 task(s)\n';
    const mine = await run();
    expect(mine).toEqual({ code: 0, out: planned, err: '' });
    const theirs = await run([], worker);
    expect(theirs).toEqual({ code: 0, out: planned, err: '' });
    expect(readFileSync(join(root, '.agents', 'leases', 'm1.json'), 'utf8')).toBe(leaseBefore);
    expect(leaseNames()).toEqual(['m1.json']);
    expect(stateBytes()).toBe(stateBefore);
    expect(logBytes()).toBe(logBefore);
  });

  test('an empty queue is one answer, exit 0', async () => {
    ready(WITH, '[]\n');
    expect(await run()).toEqual({ code: 0, out: 'team acme, session "acme"\n0 task(s)\n', err: '' });
    expect(leaseNames()).toEqual([]);
  });

  test('the seat gate: the owner, a seat with no pane, and the wrong pane', async () => {
    ready();
    expect(await run([], { kind: 'owner' })).toEqual({
      code: 1,
      out: '',
      err: 'team plan: only a seat of this team pulls a task; this call is owner\n',
    });
    project(WITH);
    list('- id: m1\n  title: the task title\n');
    updateState(join(root, '.agents'), (state) => {
      ((state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'w1:p1' });
    });
    expect(await run([], worker)).toEqual({ code: 1, out: '', err: `team plan: ${noPaneRefusal('worker')}\n` });
    record();
    expect(await run([], otherPane)).toEqual({
      code: 1,
      out: '',
      err: `team plan: ${anotherPaneRefusal('lead', 'w1:p1')}\n`,
    });
    expect(leaseNames()).toEqual([]);
  });

  test('a missing file, a file that is not a list, and a refused record', async () => {
    ready(WITH, null);
    expect(await run()).toEqual({ code: 1, out: '', err: 'team plan: the task file is not there\n' });
    list('id: m1\n');
    expect(await run()).toEqual({ code: 1, out: '', err: 'team plan: the task file is not a list\n' });
    list('- id: m1\n');
    expect(await run()).toEqual({ code: 1, out: '', err: 'team plan: m1 is not a task: title is required\n' });
    // A refused record is named and is not a candidate; another record still prints, exit 0.
    list('- id: m1\n- id: m2\n  title: the second title\n');
    expect(await run()).toEqual({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        '  STEP  STATE  OWNER  TITLE\n' +
        '  1     open   -      the second title\n' +
        '1 task(s)\n',
      err: 'team plan: m1 is not a task: title is required\n',
    });
  });

  test('the invocation and the folder are refused', async () => {
    ready();
    expect(await run(['extra'])).toEqual({ code: 2, out: '', err: `team plan: unexpected "extra"\n${USAGE}` });
    expect(await run(['--mine'])).toEqual({ code: 2, out: '', err: `team plan: unknown option --mine\n${USAGE}` });
    expect(await run([], lead, {}, base)).toEqual({ code: 2, out: '', err: `team plan: ${NOT_A_REPO}\n` });
  });

  test('cadence in the file changes nothing about the queue', async () => {
    ready(`${WITH}  cadence: 10m\n`);
    expect(await run()).toEqual({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        '  STEP  STATE  OWNER  TITLE\n' +
        '  1     open   -      the task title\n' +
        '1 task(s)\n',
      err: '',
    });
  });
});

describe('team plan --json', () => {
  test('--help prints the usage and exits 0, including with --json', async () => {
    ready();
    const plain = testIo(root, lead);
    expect(await main(['plan', '--help'], plain)).toBe(0);
    expect(plain.out).toBe(USAGE);
    const json = testIo(root, lead);
    expect(await main(['plan', '--json', '--help'], json)).toBe(0);
    expect(json.out).toBe(USAGE);
  });

  test('one envelope carries the queue, each task with its step, state and record', async () => {
    ready(WITH, '- id: m1\n  title: the task title\n  priority: 2\n  assignee: lead\n  deadline: 2026-01-01T00:00:00Z\n- id: m2\n  title: the open title\n');
    const planned = await run(['--json']);
    expect(planned).toMatchObject({ code: 0, err: '' });
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      project: string;
      session: string;
      tasks: Array<Record<string, unknown>>;
    }>(planned.out, PLAN_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.plan', version: 1 });
    expect(doc).toMatchObject({ format: 1, project: 'acme', session: 'acme' });
    expect(doc.tasks).toEqual([
      { step: 1, state: 'overdue', owner: 'lead', id: 'm1', title: 'the task title', priority: 2, deadline: '2026-01-01T00:00:00Z' },
      { step: 2, state: 'open', owner: null, id: 'm2', title: 'the open title' },
    ]);
    ready(WITH, '[]\n');
    const empty = await run(['--json']);
    expect(empty.code).toBe(0);
    expect(assertMatchesOutputSchema<{ tasks: unknown[] }>(empty.out, PLAN_OUTPUT_SCHEMA).tasks).toEqual([]);
  });

  test('--json writes a team.error document on stdout for every refusal', async () => {
    ready(WITH, null);
    const missing = await run(['--json']);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe('');
    expect(assertJsonErrorShape(missing.out, { id: 'plan.missing', messageContains: 'the task file is not there' }).error.repair).toBeNull();
    list('- id: m1\n');
    const shape = await run(['--json']);
    expect(shape.code).toBe(1);
    expect(shape.err).toBe('');
    assertJsonErrorShape(shape.out, { id: 'plan.shape', messageContains: 'm1 is not a task: title is required' });
    const invocation = await run(['--json', 'extra']);
    expect(invocation.code).toBe(2);
    expect(invocation.err).toBe('');
    assertJsonErrorShape(invocation.out, { id: 'plan.invocation', messageContains: 'unexpected "extra"' });
    const folder = await run(['--json'], lead, {}, base);
    expect(folder.code).toBe(2);
    expect(folder.err).toBe('');
    assertJsonErrorShape(folder.out, { id: 'plan.not-a-repo', messageContains: NOT_A_REPO });
  });
});

describe('team plan over the broker', () => {
  function teamFrom(text: string) {
    const checked = validateTeamFile(text);
    if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
    return checked.team;
  }

  test('with no broker running the plan refuses and claims nothing', async () => {
    ready(LINEAR);
    expect(await run()).toEqual({ code: 1, out: '', err: `team plan: ${NOT_RUNNING}\n` });
    expect(leaseNames()).toEqual([]);
  });

  test('a served read prints the queue with its notice, and writes nothing', async () => {
    ready(LINEAR);
    const stateBefore = stateBytes();
    const serving = await startBroker({
      root,
      team: teamFrom(LINEAR),
      read: async () => ({
        kind: 'read',
        read: { kind: 'records', records: [{ id: 'm1', title: 'the task title' }], refusals: [] },
        notice: 'the tracker holds more tasks than this read; the take still proceeds',
      }),
      stderr: () => {},
    });
    if (serving.kind !== 'serving') throw new Error(serving.kind);
    try {
      expect(await run()).toEqual({
        code: 0,
        out:
          'team acme, session "acme"\n' +
          '  STEP  STATE  OWNER  TITLE\n' +
          '  1     open   -      the task title\n' +
          '1 task(s)\n',
        err: 'team plan: the tracker holds more tasks than this read; the take still proceeds\n',
      });
    } finally {
      await serving.handle.close();
    }
    expect(leaseNames()).toEqual([]);
    expect(stateBytes()).toBe(stateBefore);
  });

  test('a broker answer that is not records is refused', async () => {
    ready(LINEAR);
    const serving = await startBroker({
      root,
      team: teamFrom(LINEAR),
      read: async () => ({ kind: 'failed', message: 'the tracker could not be read' }),
      stderr: () => {},
    });
    if (serving.kind !== 'serving') throw new Error(serving.kind);
    try {
      const refused = await run();
      expect(refused.code).toBe(1);
      expect(refused.out).toBe('');
      expect(refused.err).toBe('team plan: the broker failed this read\n');
    } finally {
      await serving.handle.close();
    }
  });
});
