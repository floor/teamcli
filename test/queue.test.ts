// `team queue add|list`: the local queue a team reads when its file declares no task source.
// The add is atomic and validated through the file adapter; a declared file keeps its own path,
// a declared broker source has no local queue, and a listing claims nothing.
//
// `team queue ready|install`: the green-slice producer. A seat records a finished commit ready
// for the task its own live lease holds; the owner, or the one seat the file designates with an
// approval in force, records the install. The installer is the verified caller, never an
// argument, and no merge, clock or version comparison stands in for the install record.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { runQueue, USAGE } from '../src/commands/queue.ts';
import { entitiesPath } from '../src/entities.ts';
import { loadTeamFile, NOT_A_REPO_NO_FILE } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { GREEN_SLICE_OUTPUT_SCHEMA, QUEUE_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { pendingGreenSlices, type GreenSliceEvent } from '../src/tasks/green-slices.ts';
import { fileSourceOf, readFileSource } from '../src/tasks/queue.ts';
import {
  installSlice,
  readySlice,
  readSliceWords,
  type SliceInput,
} from '../src/tasks/slice-handler.ts';
import { version } from '../src/version.ts';
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
const stranger: Caller = { kind: 'seat', name: 'stranger', pane: 'w3:p1', session: 'acme' };
const owner = { kind: 'owner' } as const;
/** The clock every lease and journal record is judged against, so an `until` is not a race. */
const NOW = Date.parse('2026-10-20T10:00:00.000Z');

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

async function run(
  argv: string[],
  caller: Caller = lead,
  cwd = root,
  now: number = NOW,
  env: Record<string, string | undefined> = {},
) {
  const io = testIo(cwd, caller);
  io.env = env;
  const code = await runQueue(argv, io, { home, now: () => now });
  return { code, out: io.out, err: io.err };
}

/** A live lease on `id`, held by `seat` on `pane` unless the scene says otherwise. */
function lease(id: string, seat = 'lead', pane = 'w1:p1', until = new Date(NOW + 60_000).toISOString()): void {
  mkdirSync(join(root, '.agents', 'leases'), { recursive: true });
  const at = new Date(NOW - 60_000).toISOString();
  writeFileSync(
    join(root, '.agents', 'leases', `${id}.json`),
    `${JSON.stringify({ format: 1, id, seat, pane, acquiredAt: at, renewedAt: at, until }, null, 2)}\n`,
  );
}

function journalPath(): string {
  return join(root, '.agents', 'green-slices.json');
}

function journal(): { format: 1; events: GreenSliceEvent[] } | null {
  return existsSync(journalPath()) ? JSON.parse(readFileSync(journalPath(), 'utf8')) : null;
}

function writeJournal(events: unknown[]): void {
  writeFileSync(journalPath(), `${JSON.stringify({ format: 1, events }, null, 2)}\n`);
}

/** The approval an owner's `team approve` of exactly the file on disk leaves on this machine. */
function approve(): void {
  const text = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, new Date(NOW)), file: text },
    loaded.team.seats,
    home,
  );
}

/** The audit lines the commands wrote beside the team file. */
function logOf(): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** A governing `dev-mode` at the team level, or the failure that kept it from being written.
 *  The target is the root the command loads (git's realpath), not the fixture's raw tmpdir. */
function governDevMode(value: 'on' | 'off'): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const written = writePolicySet(
    home,
    { level: 'team', target: loaded.root, teamRoot: loaded.root, name: 'dev-mode', value },
    { now: new Date(NOW) },
  );
  if (!written.ok) throw new Error(written.why);
}

function writeTeam(text: string): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
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
      [['add', 'a title', '--id', 'q1', '--commit', 'abcdef1'], '--commit is not used by queue add'],
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

describe('team queue ready', () => {
  /** A queue holding `q1`, a recorded lead and worker, and the lead's live lease on `q1`. */
  function set(): void {
    ready();
    writeQueue('- id: "q1"\n  title: "a leased task"\n');
    lease('q1');
  }

  test('a seat records the green commit of the task its own lease holds', async () => {
    set();
    const recorded = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(recorded).toEqual({
      code: 0,
      out: `team acme, session "acme"\nready q1 at abcdef1 (${version()}) for lead\n`,
      err: '',
    });
    expect(journal()).toEqual({
      format: 1,
      events: [
        { kind: 'ready', task: 'q1', seat: 'lead', commit: 'abcdef1', version: version(), at: new Date(NOW).toISOString() },
      ],
    });
  });

  test('the same task, commit and version again is held, and the journal is not rewritten', async () => {
    set();
    await run(['ready', 'q1', '--commit', 'abcdef1']);
    const before = readFileSync(journalPath(), 'utf8');
    const again = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(again.code).toBe(0);
    expect(again.out).toBe(`team acme, session "acme"\nq1 at abcdef1 (${version()}) is already recorded ready for lead\n`);
    expect(readFileSync(journalPath(), 'utf8')).toBe(before);
  });

  test('no live lease, or a lease of another task, is refused', async () => {
    ready();
    writeQueue('- id: "q1"\n  title: "a leased task"\n');
    const none = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('seat lead holds no live lease');
    lease('q2');
    const other = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(other.code).toBe(1);
    expect(other.err).toContain('seat lead holds a live lease of q2, not q1');
    expect(journal()).toBeNull();
  });

  test('an expired lease is no lease', async () => {
    ready();
    writeQueue('- id: "q1"\n  title: "a leased task"\n');
    lease('q1', 'lead', 'w1:p1', new Date(NOW - 1).toISOString());
    const refused = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('seat lead holds no live lease');
  });

  test('the owner and a seat of another team record no seat\'s slice', async () => {
    set();
    const byOwner = await run(['ready', 'q1', '--commit', 'abcdef1'], owner);
    expect(byOwner.code).toBe(1);
    expect(byOwner.err).toContain('only a seat of this team records a green slice ready; this call is owner');
    const byStranger = await run(['ready', 'q1', '--commit', 'abcdef1'], stranger);
    expect(byStranger.code).toBe(1);
    expect(byStranger.err).toContain('only a seat of this team records a green slice ready; this call is stranger');
    const elsewhere = await run(['ready', 'q1', '--commit', 'abcdef1'], otherPane);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(anotherPaneRefusal('lead', 'w1:p1'));
  });

  test('a seat the state records no pane for is refused with the repair', async () => {
    project();
    writeQueue('- id: "q1"\n  title: "a leased task"\n');
    lease('q1');
    const noPane = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(noPane.code).toBe(1);
    expect(noPane.err).toContain(noPaneRefusal('lead'));
  });

  test('the task must be in the queue the seat works from', async () => {
    project();
    record();
    lease('q1');
    const missing = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('the queue has no task "q1"');
    expect(journal()).toBeNull();
  });

  test('a malformed commit or version is the invocation\'s refusal', async () => {
    set();
    const cases: [string[], string][] = [
      [['ready', 'q1', '--commit', 'ABCDEF1'], 'is not a commit'],
      [['ready', 'q1', '--commit', 'abc'], 'is not a commit'],
      [['ready', 'q1', '--commit', 'abcdef1', '--version', 'bad/version'], 'is not a version'],
      [['ready', 'q1'], '--commit is required'],
      [['ready', 'q1', '--commit', 'abcdef1', '--id', 'q1'], '--id is not used by queue ready'],
      [['ready'], 'a task is required'],
    ];
    for (const [argv, message] of cases) {
      const refused = await run(argv);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain(message);
    }
    expect(journal()).toBeNull();
  });

  test('--version names the build the seat ran', async () => {
    set();
    const recorded = await run(['ready', 'q1', '--commit', 'abcdef1', '--version', '0.6.0-rc.1']);
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain('ready q1 at abcdef1 (0.6.0-rc.1) for lead');
    expect(journal()?.events[0]).toMatchObject({ version: '0.6.0-rc.1' });
  });

  test('a journal that is not JSON is refused, not swallowed', async () => {
    set();
    writeFileSync(journalPath(), 'not json\n');
    const refused = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`${journalPath()} is not valid JSON; move it aside and run the command again`);
    expect(readFileSync(journalPath(), 'utf8')).toBe('not json\n');
  });

  test('the journal\'s cap refusal propagates with its own sentence', async () => {
    set();
    writeJournal(
      Array.from({ length: 256 }, (_, index) => ({
        kind: 'ready',
        task: `held-${index}`,
        seat: 'lead',
        commit: 'abcdef1',
        version: '0.5.3',
        at: new Date(NOW - 60_000).toISOString(),
      })),
    );
    const refused = await run(['ready', 'q1', '--commit', 'abcdef1']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('holds 256 pending green slices');
  });

  test('--json documents the record and the held fact under one schema', async () => {
    set();
    const recorded = await run(['ready', 'q1', '--commit', 'abcdef1', '--json']);
    expect(recorded.code).toBe(0);
    expect(recorded.err).toBe('');
    const doc = assertMatchesOutputSchema<{ action: string; status: string; event: Record<string, unknown> }>(
      recorded.out,
      GREEN_SLICE_OUTPUT_SCHEMA,
    );
    expect(doc).toMatchObject({
      format: 1,
      project: 'acme',
      session: 'acme',
      action: 'ready',
      status: 'recorded',
      event: { kind: 'ready', task: 'q1', seat: 'lead', commit: 'abcdef1', version: version() },
    });
    const held = await run(['ready', 'q1', '--commit', 'abcdef1', '--json']);
    expect(assertMatchesOutputSchema<{ status: string }>(held.out, GREEN_SLICE_OUTPUT_SCHEMA).status).toBe('held');
  });
});

describe('team queue install', () => {
  /** A queue holding `q1`, the lead's live lease and the seat's ready record for it. */
  async function prepared(text = TEAM): Promise<void> {
    ready(text);
    writeQueue('- id: "q1"\n  title: "a leased task"\n');
    lease('q1');
    const recorded = await run(['ready', 'q1', '--commit', 'abcdef1']);
    if (recorded.code !== 0) throw new Error(recorded.err);
  }

  test('the owner records the install, and it covers the ready', async () => {
    await prepared();
    const installed = await run(['install', 'q1', '--commit', 'abcdef1'], owner);
    expect(installed).toEqual({
      code: 0,
      out: `team acme, session "acme"\ninstalled q1 at abcdef1 (${version()}) by owner\n`,
      err: '',
    });
    expect(pendingGreenSlices(join(root, '.agents'))).toEqual([]);
    expect(journal()?.events.map((event) => event.kind)).toEqual(['ready', 'install']);
  });

  test('a seat the file does not designate cannot install', async () => {
    await prepared();
    const refused = await run(['install', 'q1', '--commit', 'abcdef1'], worker);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the team file designates no installer: only the owner records an install');
    expect(journal()?.events.map((event) => event.kind)).toEqual(['ready']);
  });

  test('the designated seat records it, and installedBy is the verified caller', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    approve();
    const installed = await run(['install', 'q1', '--commit', 'abcdef1', '--json'], worker);
    expect(installed.code).toBe(0);
    const doc = assertMatchesOutputSchema<{ action: string; event: Record<string, unknown> }>(
      installed.out,
      GREEN_SLICE_OUTPUT_SCHEMA,
    );
    expect(doc).toMatchObject({ action: 'install', event: { kind: 'install', installedBy: 'worker', task: 'q1' } });
    expect(journal()?.events.at(-1)).toMatchObject({ kind: 'install', installedBy: 'worker' });
  });

  test('no flag names the installer: the argument parser refuses one', async () => {
    await prepared();
    const refused = await run(['install', 'q1', '--commit', 'abcdef1', '--installed-by', 'worker'], worker);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('unknown option --installed-by');
  });

  test('an unapproved designation admits nobody but the owner', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    const byWorker = await run(['install', 'q1', '--commit', 'abcdef1'], worker);
    expect(byWorker.code).toBe(1);
    expect(byWorker.err).toContain('the installer designation is not the approved one');
    const byOwner = await run(['install', 'q1', '--commit', 'abcdef1'], owner);
    expect(byOwner.code).toBe(0);
    expect(journal()?.events.at(-1)).toMatchObject({ kind: 'install', installedBy: 'owner' });
  });

  test('a designation the owner approved and then changed is unapproved', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    approve();
    writeTeam(`${TEAM}installer: lead\n`);
    const byNew = await run(['install', 'q1', '--commit', 'abcdef1'], lead);
    expect(byNew.code).toBe(1);
    expect(byNew.err).toContain('the installer designation is not the approved one');
    const byOld = await run(['install', 'q1', '--commit', 'abcdef1'], worker);
    expect(byOld.code).toBe(1);
    expect(byOld.err).toContain('only the owner or lead, the designated installer, records an install; this call is seat worker');
  });

  test('another unapproved edit does not withdraw an approved designation', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    approve();
    writeTeam(`${TEAM}installer: worker\nrules:\n  - Run the tests your change touches.\n`);
    const installed = await run(['install', 'q1', '--commit', 'abcdef1'], worker);
    expect(installed.code).toBe(0);
  });

  test('dev mode on admits the declared, placed installer while the designation is unapproved, and audits the caller', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    governDevMode('on');
    const installed = await run(['install', 'q1', '--commit', 'abcdef1'], worker);
    expect(installed.code).toBe(0);
    expect(journal()?.events.at(-1)).toMatchObject({ kind: 'install', installedBy: 'worker' });
    expect(logOf()).toContain('queue install [worker] warning: the installer designation is not the approved one');
    expect(logOf()).toContain('dev mode continues (dev-mode on at team level); admitted as installer');
  });

  test('dev mode off keeps the unapproved refusal even with the variable set, and writes no audit line', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    governDevMode('off');
    const refused = await run(['install', 'q1', '--commit', 'abcdef1'], worker, root, NOW, { TEAMCLI_DEV_MODE: '1' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the installer designation is not the approved one');
    expect(journal()?.events.map((event) => event.kind)).toEqual(['ready']);
    expect(logOf()).toBe('');
  });

  test('an unreadable dev-mode policy chain fails closed, even with the variable set', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    governDevMode('on');
    writeFileSync(entitiesPath(home), 'floor: [unclosed\n');
    const refused = await run(['install', 'q1', '--commit', 'abcdef1'], worker, root, NOW, { TEAMCLI_DEV_MODE: '1' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the installer designation is not the approved one');
    expect(journal()?.events.map((event) => event.kind)).toEqual(['ready']);
    expect(logOf()).toBe('');
  });

  test('dev mode admits only the declared installer on its recorded pane', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    governDevMode('on');
    const byLead = await run(['install', 'q1', '--commit', 'abcdef1'], lead);
    expect(byLead.code).toBe(1);
    expect(byLead.err).toContain('only the owner or worker, the designated installer, records an install; this call is seat lead');
    const elsewhere = await run(
      ['install', 'q1', '--commit', 'abcdef1'],
      { kind: 'seat', name: 'worker', pane: 'w9:p1', session: 'acme' },
    );
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(anotherPaneRefusal('worker', 'w2:p1'));
    expect(journal()?.events.map((event) => event.kind)).toEqual(['ready']);
    expect(logOf()).toBe('');
  });

  test('the designated seat must stand on the pane the state records', async () => {
    await prepared(`${TEAM}installer: worker\n`);
    approve();
    const byOtherSeat = await run(['install', 'q1', '--commit', 'abcdef1'], lead);
    expect(byOtherSeat.code).toBe(1);
    expect(byOtherSeat.err).toContain('only the owner or worker, the designated installer, records an install; this call is seat lead');
    const elsewhere = await run(
      ['install', 'q1', '--commit', 'abcdef1'],
      { kind: 'seat', name: 'worker', pane: 'w9:p1', session: 'acme' },
    );
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(anotherPaneRefusal('worker', 'w2:p1'));
  });

  test('an install already recorded is held, and the version is part of the fact', async () => {
    await prepared();
    await run(['install', 'q1', '--commit', 'abcdef1'], owner);
    const before = readFileSync(journalPath(), 'utf8');
    const again = await run(['install', 'q1', '--commit', 'abcdef1'], owner);
    expect(again.code).toBe(0);
    expect(again.out).toBe(`team acme, session "acme"\nq1 at abcdef1 (${version()}) is already recorded installed by owner\n`);
    expect(readFileSync(journalPath(), 'utf8')).toBe(before);
    const otherVersion = await run(['install', 'q1', '--commit', 'abcdef1', '--version', '0.6.0'], owner);
    expect(otherVersion.code).toBe(0);
    expect(journal()?.events.filter((event) => event.kind === 'install')).toHaveLength(2);
  });

  test('a malformed journal is the record refusal here too', async () => {
    await prepared();
    writeFileSync(journalPath(), '[]\n');
    const refused = await run(['install', 'q1', '--commit', 'abcdef1'], owner);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('is not a green-slice journal of format 1');
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

describe('the daemon-facing slice boundary', () => {
  const LINEAR_REFUSAL =
    'the team file declares a linear task source; there is no local queue, and the tracker is never written';

  function teamOf(): TeamFile {
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    return loaded.team;
  }

  /** The queue, a live lease of `q1` for the lead, and the panes the state records. */
  function prepared(text = TEAM): void {
    ready(text);
    writeQueue('- id: "q1"\n  title: "a leased task"\n');
    lease('q1');
  }

  /** A request as a host parses it from JSON: untyped, so it may carry more than the boundary
   *  reads, and the boundary must read only the three words. */
  function payload(fields: Record<string, unknown>): Parameters<typeof readSliceWords>[0] {
    return fields as Parameters<typeof readSliceWords>[0];
  }

  test('readSliceWords keeps only the three words, and defaults the version', () => {
    const read = readSliceWords(
      payload({
        task: 'q1',
        commit: 'abcdef1',
        defaultVersion: version(),
        caller: { kind: 'owner' },
        installedBy: 'owner',
        seat: 'lead',
      }),
    );
    expect(read).toEqual({ ok: true, words: { task: 'q1', commit: 'abcdef1', version: version() } });
    if (read.ok) expect(Object.keys(read.words).sort()).toEqual(['commit', 'task', 'version']);
  });

  test('readSliceWords refuses a malformed word with the sentence the CLI prints', () => {
    const base = { task: 'q1', commit: 'abcdef1', defaultVersion: '0.5.0' };
    expect(readSliceWords(payload({ task: 'q1', defaultVersion: '0.5.0' }))).toEqual({
      ok: false,
      message: '--commit is required',
      usage: true,
    });
    expect(readSliceWords(payload({ commit: 'abcdef1', defaultVersion: '0.5.0' }))).toEqual({
      ok: false,
      message: 'a task is required',
      usage: true,
    });
    expect(readSliceWords(payload({ ...base, task: 'bad id' }))).toEqual({
      ok: false,
      message: '"bad id" is not a task id: use letters, digits, dot, dash or underscore, starting with a letter or digit',
      usage: false,
    });
    expect(readSliceWords(payload({ ...base, commit: 'ABCDEF1' }))).toEqual({
      ok: false,
      message: '"ABCDEF1" is not a commit: use 7 to 40 lowercase hex digits',
      usage: false,
    });
    expect(readSliceWords(payload({ ...base, version: 'has space' }))).toEqual({
      ok: false,
      message: '"has space" is not a version: use letters, digits, dot, dash, plus or underscore',
      usage: false,
    });
  });

  test('the payload caller is not identity: the placement the host passes records', () => {
    prepared();
    // The extra fields are what an untrusted request could claim; the boundary reads none.
    const input = {
      task: 'q1',
      commit: 'abcdef1',
      version: version(),
      caller: lead,
      described: 'lead',
      now: NOW,
      seat: 'worker',
      installedBy: 'owner',
      kind: 'owner',
    } as unknown as SliceInput;
    const result = readySlice(teamOf(), root, input);
    expect(result).toMatchObject({
      ok: true,
      status: 'recorded',
      event: { kind: 'ready', task: 'q1', seat: 'lead', commit: 'abcdef1', version: version() },
    });
    expect(journal()?.events).toHaveLength(1);
    expect(journal()?.events[0]).toMatchObject({ kind: 'ready', seat: 'lead' });
  });

  test('a seat with no session cannot be placed, and admits nothing', () => {
    prepared();
    const placed = { kind: 'seat', name: 'lead', pane: 'w1:p1' } as const;
    const result = readySlice(teamOf(), root, {
      task: 'q1',
      commit: 'abcdef1',
      version: version(),
      caller: placed,
      described: 'lead',
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      refusal: { id: 'queue.caller', message: 'only a seat of this team records a green slice ready; this call is lead' },
    });
    expect(journal()).toBeNull();
  });

  test('an approved designated seat installs, and installedBy is the host caller', () => {
    prepared(`${TEAM}installer: worker\n`);
    approve();
    const input = {
      task: 'q1',
      commit: 'abcdef1',
      version: version(),
      caller: worker,
      described: 'worker',
      now: NOW,
      // A payload cannot name the installer.
      installedBy: 'owner',
      seat: 'lead',
    } as unknown as SliceInput;
    const result = installSlice(teamOf(), root, home, input);
    expect(result).toMatchObject({
      ok: true,
      status: 'recorded',
      event: { kind: 'install', task: 'q1', commit: 'abcdef1', installedBy: 'worker' },
    });
    expect(journal()?.events.at(-1)).toMatchObject({ kind: 'install', installedBy: 'worker' });
  });

  test('the host door reads dev mode from its environment and admits the live installer section', () => {
    prepared(`${TEAM}installer: worker\n`);
    const result = installSlice(teamOf(), root, home, {
      task: 'q1',
      commit: 'abcdef1',
      version: version(),
      caller: worker,
      described: 'worker',
      now: NOW,
      env: { TEAMCLI_DEV_MODE: '1' },
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'recorded',
      event: { kind: 'install', task: 'q1', commit: 'abcdef1', installedBy: 'worker' },
    });
    expect(logOf()).toContain('queue install [worker]');
    expect(logOf()).toContain('dev mode continues');
  });

  test('a linear source is refused before any caller is judged', () => {
    project(LINEAR);
    const result = readySlice(teamOf(), root, {
      task: 'q1',
      commit: 'abcdef1',
      version: version(),
      caller: { kind: 'unplaced', reason: 'no terminal' },
      described: 'unplaced (no terminal)',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, refusal: { id: 'queue.source', message: LINEAR_REFUSAL } });
    const installed = installSlice(teamOf(), root, home, {
      task: 'q1',
      commit: 'abcdef1',
      version: version(),
      caller: { kind: 'unplaced', reason: 'no terminal' },
      described: 'unplaced (no terminal)',
      now: NOW,
    });
    expect(installed).toEqual({ ok: false, refusal: { id: 'queue.source', message: LINEAR_REFUSAL } });
  });
});
