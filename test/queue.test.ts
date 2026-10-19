// `team queue add|list`: the local queue a team reads when its file declares no task source.
// The add is atomic and validated through the file adapter; a declared file keeps its own path,
// a declared broker source has no local queue, and a listing claims nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { runQueue, USAGE } from '../src/commands/queue.ts';
import { loadTeamFile, NOT_A_REPO_NO_FILE } from '../src/file/load.ts';
import { QUEUE_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { emptySession, updateState } from '../src/state.ts';
import { fileSourceOf, readFileSource } from '../src/tasks/queue.ts';
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
const otherPane: Caller = { kind: 'seat', name: 'lead', pane: 'w9:p1', session: 'acme' };
const stranger: Caller = { kind: 'seat', name: 'stranger', pane: 'w3:p1', session: 'acme' };
const owner = { kind: 'owner' } as const;

let base: string;
let root: string;
let home: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function project(text = TEAM): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-queue-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

function record(): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function ready(text = TEAM): void {
  project(text);
  record();
}

function queueFile(): string {
  return join(root, '.agents', 'queue.yaml');
}

function queueBytes(): string | null {
  return existsSync(queueFile()) ? readFileSync(queueFile(), 'utf8') : null;
}

function writeQueue(text: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(queueFile(), text);
}

async function run(argv: string[], caller: Caller = lead, cwd = root) {
  const io = testIo(cwd, caller);
  const code = await runQueue(argv, io, { home });
  return { code, out: io.out, err: io.err };
}

describe('team queue add', () => {
  test('a team with no task source queues into .agents/queue.yaml', async () => {
    ready();
    const added = await run(['add', 'a queued task', '--id', 'q1', '--priority', '2', '--assignee', 'lead']);
    expect(added).toEqual({
      code: 0,
      out: 'team acme, session "acme"\nqueued q1 in .agents/queue.yaml\n',
      err: '',
    });
    expect(queueBytes()).toBe('- id: "q1"\n  title: "a queued task"\n  priority: 2\n  assignee: "lead"\n');
  });

  test('the same record again is present, and nothing is rewritten', async () => {
    ready();
    await run(['add', 'a queued task', '--id', 'q1']);
    const before = queueBytes();
    const again = await run(['add', 'a queued task', '--id', 'q1']);
    expect(again).toEqual({
      code: 0,
      out: 'team acme, session "acme"\nq1 is already queued in .agents/queue.yaml\n',
      err: '',
    });
    expect(queueBytes()).toBe(before);
  });

  test('the same id with another record is refused and the file is left alone', async () => {
    ready();
    await run(['add', 'a queued task', '--id', 'q1']);
    const before = queueBytes();
    const duplicate = await run(['add', 'another queued task', '--id', 'q1']);
    expect(duplicate.code).toBe(1);
    expect(duplicate.err).toContain('q1 is already queued with a different record; edit .agents/queue.yaml or choose another id');
    expect(queueBytes()).toBe(before);
  });

  test('a declared file source is written at its own path', async () => {
    ready(WITH);
    writeFileSync(join(root, '.agents', 'tasks.yaml'), '[]\n');
    const added = await run(['add', 'a declared task', '--id', 'd1']);
    expect(added.code).toBe(0);
    expect(added.out).toContain('queued d1 in .agents/tasks.yaml');
    expect(queueBytes()).toBeNull();
    expect(readFileSync(join(root, '.agents', 'tasks.yaml'), 'utf8')).toBe('- id: "d1"\n  title: "a declared task"\n');
  });

  test('a missing declared file stays missing', async () => {
    ready(WITH);
    const added = await run(['add', 'a declared task', '--id', 'd1']);
    expect(added.code).toBe(1);
    expect(added.err).toContain('the task file is not there');
    expect(existsSync(join(root, '.agents', 'tasks.yaml'))).toBe(false);
  });

  test('a team with a linear source has no local queue and no tracker write', async () => {
    ready(LINEAR);
    for (const argv of [['add', 'a queued task', '--id', 'q1'], ['list']]) {
      const refused = await run(argv);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('the team file declares a linear task source; there is no local queue, and the tracker is never written');
    }
    expect(queueBytes()).toBeNull();
  });

  test('a flow list that is not [] is refused rather than replaced', async () => {
    ready();
    writeQueue('[q0, q1]\n');
    const before = queueBytes();
    const refused = await run(['add', 'a queued task', '--id', 'q1']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the queue file is not a list');
    expect(queueBytes()).toBe(before);
  });

  test('a refused record beside the queue is reported and the add still lands', async () => {
    ready();
    writeQueue('- id: m1\n  title: the broken record\n  mystery: x\n');
    const added = await run(['add', 'a queued task', '--id', 'q1']);
    expect(added.code).toBe(0);
    expect(added.out).toContain('queued q1 in .agents/queue.yaml');
    expect(added.err).toContain('team queue: m1 is not a task: unknown field "mystery"');
    expect(queueBytes()).toBe(
      '- id: m1\n  title: the broken record\n  mystery: x\n- id: "q1"\n  title: "a queued task"\n',
    );
  });

  test('bad arguments are refused before any write', async () => {
    ready();
    const cases: [string[], string][] = [
      [['add'], 'a title is required'],
      [['add', 'a title'], '--id is required'],
      [['add', 'a title', '--id', '-bad'], 'is not a task id'],
      [['add', 'a title', '--id', 'q1', '--assignee', 'ghost'], 'assignee "ghost" is not a seat of this team'],
      [['add', 'a title', '--id', 'q1', '--priority', 'a\nb'], '--priority must be one line of text or a number'],
      [['add', 'a title', '--id', 'q1', 'extra'], 'unexpected "extra"'],
    ];
    for (const [argv, message] of cases) {
      const refused = await run(argv);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain(message);
    }
    expect(queueBytes()).toBeNull();
  });

  test('the invocation and its usage print for a missing word', async () => {
    ready();
    const refused = await run([]);
    expect(refused.code).toBe(2);
    expect(refused.err).toBe(`team queue: a word is required\n${USAGE}`);
  });

  test('the owner adds, and a seat must stand on the pane the state records', async () => {
    project();
    expect((await run(['add', 'owner task', '--id', 'o1'], owner)).code).toBe(0);
    const noPane = await run(['add', 'a task', '--id', 't1'], { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });
    expect(noPane.code).toBe(1);
    expect(noPane.err).toContain(noPaneRefusal('worker'));
    record();
    const elsewhere = await run(['add', 'a task', '--id', 't1'], otherPane);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(anotherPaneRefusal('lead', 'w1:p1'));
    const unknown = await run(['add', 'a task', '--id', 't1'], stranger);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('only the owner or a seat of this team adds to the queue; this call is stranger');
  });
});

describe('team queue list', () => {
  test('a queue that is not there yet is an empty list, not a missing source', async () => {
    ready();
    const listed = await run(['list']);
    expect(listed).toEqual({ code: 0, out: 'team acme, session "acme"\n0 tasks\n', err: '' });
  });

  test('the listing is the queue in file order, with the block printer', async () => {
    ready();
    await run(['add', 'the first task', '--id', 'q1', '--priority', 'high']);
    await run(['add', 'the second task', '--id', 'q2', '--assignee', 'worker']);
    const listed = await run(['list']);
    expect(listed).toEqual({
      code: 0,
      out:
        'team acme, session "acme"\n' +
        'q1  the first task\n' +
        '  priority: high\n' +
        '\n' +
        'q2  the second task\n' +
        '  assignee: worker\n' +
        '2 tasks\n',
      err: '',
    });
  });

  test('a queue of refusals only is refused, and the reason is named', async () => {
    ready();
    writeQueue('- id: m1\n  title: the broken record\n  mystery: x\n');
    const listed = await run(['list']);
    expect(listed.code).toBe(1);
    expect(listed.err).toContain('m1 is not a task: unknown field "mystery"');
  });

  test('list takes no valued option and no second word', async () => {
    ready();
    const flag = await run(['list', '--id', 'q1']);
    expect(flag.code).toBe(2);
    expect(flag.err).toContain('--id is not used by queue list');
    const extra = await run(['list', 'extra']);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('unexpected "extra"');
  });

  test('--json documents the queue and the add, under one schema', async () => {
    ready();
    const added = await run(['add', 'a queued task', '--id', 'q1', '--priority', '1', '--assignee', 'lead', '--json']);
    expect(added.code).toBe(0);
    expect(added.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      format: number;
      project: string;
      session: string;
      source: string;
      path: string;
      status?: string;
      task?: { id: string; title: string; assignee: string | null; priority?: string | number };
      tasks: unknown[];
    }>(added.out, QUEUE_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      format: 1,
      project: 'acme',
      session: 'acme',
      source: 'local',
      path: '.agents/queue.yaml',
      status: 'added',
      task: { id: 'q1', title: 'a queued task', assignee: 'lead', priority: 1 },
    });
    const listed = await run(['list', '--json']);
    const shown = assertMatchesOutputSchema<{ status?: string; tasks: unknown[] }>(listed.out, QUEUE_OUTPUT_SCHEMA);
    expect(shown.status).toBeUndefined();
    expect(shown.tasks).toEqual([{ id: 'q1', title: 'a queued task', assignee: 'lead', priority: 1 }]);
    const refused = await run(['add', 'another', '--id', 'q1', '--json']);
    assertJsonErrorShape(refused.out, { id: 'queue.duplicate', messageContains: 'q1 is already queued with a different record' });
  });

  test('the queue refuses a folder that is neither a checkout nor a team root', async () => {
    project();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'team-queue-plain-')));
    try {
      const refused = await run(['list'], lead, outside);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain(NOT_A_REPO_NO_FILE);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('the file source helper', () => {
  function load(): ReturnType<typeof loadTeamFile> {
    return loadTeamFile(root, { home });
  }

  test('no tasks section is the local queue; a file section is its own path; linear is null', () => {
    project(TEAM);
    const none = load();
    if (!none.ok) throw new Error(JSON.stringify(none.errors));
    expect(fileSourceOf(none.team)).toEqual({ path: '.agents/queue.yaml', local: true });
    project(WITH);
    const file = load();
    if (!file.ok) throw new Error(JSON.stringify(file.errors));
    expect(fileSourceOf(file.team)).toEqual({ path: '.agents/tasks.yaml', local: false });
    project(LINEAR);
    const linear = load();
    if (!linear.ok) throw new Error(JSON.stringify(linear.errors));
    expect(fileSourceOf(linear.team)).toBeNull();
  });

  test('a local missing file reads empty; a declared missing file stays missing', () => {
    project(TEAM);
    expect(readFileSource(root, { path: '.agents/queue.yaml', local: true })).toEqual({ kind: 'records', records: [], refusals: [] });
    expect(readFileSource(root, { path: '.agents/tasks.yaml', local: false })).toEqual({ kind: 'missing' });
  });
});
