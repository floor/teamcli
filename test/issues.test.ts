import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedFingerprints } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { commands, main } from '../src/cli.ts';
import { runIssues, USAGE } from '../src/commands/issues.ts';
import { ISSUES_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { taskPathStaysInside } from '../src/file/sections/tasks.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession } from '../src/state.ts';
import type { TaskAdapter } from '../src/tasks/adapter.ts';
import { newMemory, pass, ringText } from '../src/watch/pass.ts';
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
`;

const WITH = `${TEAM}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const CONTEXT = 'team acme, session "acme"\n';

// The contract's issues table: headers, one row per record, the closing count.
const TABLE = '  ID  STATE  ASSIGNEE  TITLE\n';
const OPEN_M1 = '  m1  open   -         the task title\n';
const ONE_OPEN = `${CONTEXT}${TABLE}${OPEN_M1}1 issue\n`;
const ONE_BLOCKED = `${CONTEXT}  ID  STATE    ASSIGNEE  TITLE\n  m1  blocked  -         the task title\n1 issue\n`;

let base: string;
let root: string;
let home: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function project(text = WITH): void {
  base = mkdtempSync(join(tmpdir(), 'team-issues-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

function list(text: string): void {
  writeFileSync(join(root, '.agents', 'tasks.yaml'), text);
}

async function run(argv: string[] = [], registry?: Record<string, TaskAdapter>) {
  const io = testIo(root);
  const code = await runIssues(argv, io, { home, ...(registry ? { registry } : {}) });
  return { code, out: io.out, err: io.err };
}

describe('team issues', () => {
  test('a list prints id and title, and a later priority stays below an unprioritised record', async () => {
    project();
    list('- id: m1\n  title: the task title\n');
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });
    list('- id: m1\n  title: the task title\n- id: m2\n  title: another title\n  priority: 1\n');
    expect(await run()).toEqual({
      code: 0,
      out: `${CONTEXT}${TABLE}${OPEN_M1}  m2  open   -         another title\n2 issues\n`,
      err: '',
    });
  });

  test('a folder that is not a checkout reads the team root it holds', async () => {
    project();
    // The team root is this folder itself: no checkout names it, and the listing writes nothing.
    mkdirSync(join(base, 'plain'), { recursive: true });
    const plain = realpathSync(join(base, 'plain'));
    mkdirSync(join(plain, '.agents'), { recursive: true });
    writeFileSync(join(plain, '.agents', 'team.yaml'), WITH);
    writeFileSync(join(plain, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
    const io = testIo(plain);
    expect(await runIssues([], io, { home })).toBe(0);
    expect(io.out).toBe(ONE_OPEN);
    expect(io.err).toBe('');
  });

  test('tasks validates, and a file without it still validates', () => {
    expect(validateTeamFile(WITH).ok).toBe(true);
    const bare = validateTeamFile(TEAM);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.team.tasks).toBeNull();
  });

  test('a record without a title is refused and its sibling still prints', async () => {
    project();
    list('- id: m1\n- id: m2\n  title: another title\n');
    expect(await run()).toEqual({
      code: 1,
      out: `${CONTEXT}${TABLE}  m2  open   -         another title\n1 issue\n`,
      err: 'team issues: m1 is not a task: title is required\n',
    });
  });

  test('an omitted field is not printed', async () => {
    project();
    list('- id: m1\n  title: the task title\n');
    const listed = await run();
    expect(listed.out).toBe(ONE_OPEN);
    for (const word of ['priority', 'assignee', 'milestone', 'deadline', 'blocked-by', 'repos', 'needs', 'description']) {
      expect(listed.out).not.toContain(word);
    }
  });

  test('blocked-by marks the record blocked and does not drop it', async () => {
    project();
    list('- id: m1\n  title: the task title\n  blocked-by: [m0]\n- id: m2\n  title: another title\n');
    const listed = await run();
    expect(listed.code).toBe(0);
    expect(listed.out).toBe(
      `${CONTEXT}  ID  STATE    ASSIGNEE  TITLE\n  m1  blocked  -         the task title\n  m2  open     -         another title\n2 issues\n`,
    );
  });

  test('a broker source is refused by name, and the task file is not read', async () => {
    // A linear source without its block: the validator names both halves it needs.
    const text = WITH.replace('source: file', 'source: linear');
    const checked = validateTeamFile(text);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      const messages = checked.errors.map((error) => error.message);
      expect(messages).toContain('tasks.linear.project is required');
      expect(messages).toContain('tasks.linear.keychainService is required');
    }
    project(text);
    list('- id: m1\n  title: the task title\n');
    const ran = await run();
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team issues: tasks.linear.project is required\n');
    expect(ran.out).toBe('');

    // A full broker source validates — and this command still lists no broker source: the read
    // lives behind the socket, the seat gate and the policy, none of which this command has.
    const linear = `${TEAM}tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
`;
    project(linear);
    list('- id: m1\n  title: the task title\n');
    const broker = await run();
    expect(broker.code).toBe(1);
    expect(broker.err).toBe('team issues: team issues lists the file the owner committed; a broker source is read by team next\n');
    expect(broker.out).toBe('');
  });

  test('an empty list, a missing file, and a file with no task source', async () => {
    project();
    list('[]\n');
    expect(await run()).toEqual({ code: 0, out: `${CONTEXT}0 issues\n`, err: '' });
    rmSync(join(root, '.agents', 'tasks.yaml'));
    expect(await run()).toEqual({ code: 1, out: '', err: 'team issues: the task file is not there\n' });
    // A team that declares no source lists its own local queue: an absent one reads empty.
    project(TEAM);
    expect(await run()).toEqual({ code: 0, out: `${CONTEXT}0 issues\n`, err: '' });
  });

  test('repos and needs mark the record blocked; --json carries both and judges neither', async () => {
    project();
    list('- id: m1\n  title: the task title\n  repos: [other]\n  needs: [review]\n');
    expect(await run()).toEqual({ code: 0, out: ONE_BLOCKED, err: '' });
    const listed = await run(['--json']);
    expect(listed).toMatchObject({ code: 0, err: '' });
    const doc = assertMatchesOutputSchema<{ issues: Array<Record<string, unknown>> }>(listed.out, ISSUES_OUTPUT_SCHEMA);
    expect(doc.issues[0]).toMatchObject({ id: 'm1', state: 'blocked', repos: ['other'], needs: ['review'], assignee: null });
  });

  test('team plan is a command of this build, and the owner is refused', async () => {
    expect(commands.issues).toBeDefined();
    expect(commands.next).toBeDefined();
    expect('plan' in commands).toBe(true);
    project();
    const plan = testIo(root, { kind: 'owner' });
    expect(await main(['plan'], plan)).toBe(1);
    expect(plan.err.startsWith('team plan: only a seat of this team pulls a task')).toBe(true);
  });

  test('a listing creates no key, and a pass with no mailbox record does not ring', () => {
    project();
    list('- id: m1\n  title: the task title\n');
    return run().then((listed) => {
      expect(listed.code).toBe(0);
      expect(existsSync(join(home, '.config', 'team-key'))).toBe(false);
      expect(ringText('lead', 'acme')).toBe('Team: run team drops --read --seat lead --session acme');
      const checked = validateTeamFile(TEAM);
      if (!checked.ok) throw new Error('the fixture does not validate');
      const result = pass({
        team: checked.team,
        state: emptySession(),
        live: { running: false, agents: [], workspaces: [], screens: {} },
        machine: { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null },
        now: Date.parse('2026-10-08T09:00:00Z'),
        memory: newMemory(),
        watch: checked.team.watch,
        mailbox: [],
      });
      expect(result.ring).toBeNull();
      expect(result.mailboxNote).toBeNull();
      expect(JSON.stringify(result)).not.toContain('team issues');
    });
  });

  test('a stub adapter registered on the seam prints its records, and an unregistered source is refused', async () => {
    project();
    list('- id: m1\n  title: the task title\n');
    let read = false;
    const stub: TaskAdapter = {
      name: 'file',
      read: () => {
        read = true;
        return { kind: 'records', records: [{ id: 's1', title: 'from the stub' }], refusals: [] };
      },
    };
    expect(await run([], { file: stub })).toEqual({
      code: 0,
      out: `${CONTEXT}${TABLE}  s1  open   -         from the stub\n1 issue\n`,
      err: '',
    });
    expect(read).toBe(true);
    const missed = await run([], {});
    expect(missed).toEqual({ code: 1, out: '', err: 'team issues: tasks.source must be file\n' });
  });

  test('a record that fails its id is named by its place in the file', async () => {
    project();
    list('- title: the task title\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: record 1 is not a task: id is required\n',
    });
  });

  test('a single-line field refuses a carriage return, and a description keeps one', async () => {
    project();
    list('- id: m1\n  title: "first\\rsecond"\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: title must be a single line\n',
    });
    list('- id: m1\n  title: "first\\nsecond"\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: title must be a single line\n',
    });
    list('- id: m1\n  title: the task title\n');
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });
    const fields: Array<[string, string]> = [
      ['assignee: "a\\rb"', 'assignee must be text'],
      ['milestone: "a\\rb"', 'milestone must be text'],
      ['deadline: "a\\rb"', 'deadline must be text'],
      ['priority: "a\\rb"', 'priority is not text or a number'],
      ['repos: ["a\\rb"]', 'repos is not a list of names'],
      ['needs: ["a\\rb"]', 'needs is not a list of names'],
    ];
    for (const [field, reason] of fields) {
      list(`- id: m1\n  title: the task title\n  ${field}\n`);
      expect(await run()).toEqual({ code: 1, out: '', err: `team issues: m1 is not a task: ${reason}\n` });
    }
    list('- id: m1\n  title: the task title\n  description: "first\\rsecond"\n');
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });
  });

  test('a description may contain newlines, and one trailing newline is not an extra line', async () => {
    project();
    list('- id: m1\n  title: the task title\n  description: "first\\nsecond"\n');
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });
    // The value a `|` block denotes, including its closing newline.
    list('- id: m1\n  title: the task title\n  description: "first\\nsecond\\n"\n');
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });
    list('- id: m1\n  title: the task title\n  description: "first\\n\\nsecond"\n');
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });
    list(`- id: m1\n  title: the task title\n  description: "${'a'.repeat(3999)}\\n"\n`);
    expect((await run()).code).toBe(0);
    list(`- id: m1\n  title: the task title\n  description: "${'a'.repeat(4000)}\\n"\n`);
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: description is over 4000 characters\n',
    });
    list('- id: m1\n  title: the task title\n  description: ""\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: description must be text\n',
    });
  });

  test('a name that starts with .. stays inside the checkout, and a real escape does not', async () => {
    project();
    mkdirSync(join(root, '..tasks'));
    writeFileSync(join(root, '..tasks', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
    const direct = `${TEAM}tasks:\n  source: file\n  path: ..tasks/tasks.yaml\n`;
    expect(validateTeamFile(direct, { root }).ok).toBe(true);
    expect(taskPathStaysInside('..tasks/tasks.yaml', root)).toBe(true);
    writeFileSync(join(root, '.agents', 'team.yaml'), direct);
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });

    symlinkSync(join(root, '..tasks'), join(root, 'via'));
    const via = `${TEAM}tasks:\n  source: file\n  path: via/tasks.yaml\n`;
    expect(validateTeamFile(via, { root }).ok).toBe(true);
    writeFileSync(join(root, '.agents', 'team.yaml'), via);
    expect(await run()).toEqual({ code: 0, out: ONE_OPEN, err: '' });

    for (const path of ['../outside.yaml', '/tmp/outside.yaml', 'foo\\bar.yaml', '~/x', 'a\0b']) {
      expect(taskPathStaysInside(path, root)).toBe(false);
      const result = validateTeamFile(`${TEAM}tasks:\n  source: file\n  path: ${path}\n`, { root });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.message)).toContain('tasks.path must stay inside the checkout');
    }

    const elsewhere = mkdtempSync(join(tmpdir(), 'team-issues-out-'));
    writeFileSync(join(elsewhere, 'tasks.yaml'), '- id: m1\n  title: the task title\n');
    symlinkSync(elsewhere, join(root, 'linked'));
    const linked = `${TEAM}tasks:\n  source: file\n  path: linked/tasks.yaml\n`;
    const outside = validateTeamFile(linked, { root });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.errors.map((error) => error.message)).toContain('tasks.path must stay inside the checkout');
    writeFileSync(join(root, '.agents', 'team.yaml'), linked);
    expect(await run()).toEqual({ code: 1, out: '', err: 'team issues: tasks.path must stay inside the checkout\n' });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test('--help prints the usage and exits 0, including with --json', async () => {
    project();
    const plain = testIo(root, { kind: 'owner' });
    expect(await main(['issues', '--help'], plain)).toBe(0);
    expect(plain.out).toBe(USAGE);
    const json = testIo(root, { kind: 'owner' });
    expect(await main(['issues', '--json', '--help'], json)).toBe(0);
    expect(json.out).toBe(USAGE);
  });

  test('--json prints one envelope whose issue rows are the table, with the whole record', async () => {
    project();
    list('- id: m1\n  title: the task title\n  priority: 2\n  assignee: lead\n  deadline: 2026-12-31T00:00:00Z\n');
    const listed = await run(['--json']);
    expect(listed).toMatchObject({ code: 0, err: '' });
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      project: string;
      session: string;
      issues: Array<Record<string, unknown>>;
    }>(listed.out, ISSUES_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.issues', version: 1 });
    expect(doc).toMatchObject({ format: 1, project: 'acme', session: 'acme' });
    expect(doc.issues).toEqual([
      {
        id: 'm1',
        title: 'the task title',
        state: 'open',
        assignee: 'lead',
        priority: 2,
        deadline: '2026-12-31T00:00:00Z',
      },
    ]);
    list('[]\n');
    const empty = await run(['--json']);
    expect(empty.code).toBe(0);
    expect(assertMatchesOutputSchema<{ issues: unknown[] }>(empty.out, ISSUES_OUTPUT_SCHEMA).issues).toEqual([]);
  });

  test('--json writes a team.error document on stdout for every refusal', async () => {
    project(WITH);
    const missing = await run(['--json']);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe('');
    expect(assertJsonErrorShape(missing.out, { id: 'issues.missing', messageContains: 'the task file is not there' }).error.repair).toBeNull();
    list('- id: m1\n');
    const shape = await run(['--json']);
    expect(shape.code).toBe(1);
    expect(shape.err).toBe('');
    assertJsonErrorShape(shape.out, { id: 'issues.shape', messageContains: 'm1 is not a task: title is required' });
    const invocation = await run(['--json', 'extra']);
    expect(invocation.code).toBe(2);
    expect(invocation.err).toBe('');
    assertJsonErrorShape(invocation.out, { id: 'issues.invocation', messageContains: 'unexpected "extra"' });
    // The raw argv is scanned before the parser runs: an unknown option ahead of `--json`, or a
    // `--json=<value>` the parser refuses, still writes the error document and leaves stderr empty.
    const nope = await run(['--nope', '--json']);
    expect(nope.code).toBe(2);
    expect(nope.err).toBe('');
    assertJsonErrorShape(nope.out, { id: 'issues.invocation', messageContains: 'unknown option --nope' });
    const inline = await run(['--json=1']);
    expect(inline.code).toBe(2);
    expect(inline.err).toBe('');
    assertJsonErrorShape(inline.out, { id: 'issues.invocation', messageContains: 'unknown option --json' });
  });

  test('outside a repository, the refusal offers no --file: issues takes none', async () => {
    project();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const plain = testIo(outside);
    expect(await runIssues([], plain, { home })).toBe(2);
    expect(plain.err).toBe('team issues: not inside a git repository: run team from a project\n');

    const json = testIo(outside);
    expect(await runIssues(['--json'], json, { home })).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, {
      id: 'issues.not-a-repo',
      messageContains: 'not inside a git repository: run team from a project',
    });
    expect(json.out).not.toContain('--file');
  });

  test('an old approval adopts an omitted tasks section, and adding one differs', () => {
    const bare = validateTeamFile(TEAM);
    const added = validateTeamFile(WITH);
    if (!bare.ok || !added.ok) throw new Error('the fixtures do not validate');
    const stored = fingerprints(bare.team);
    delete stored.sections.tasks;
    const stillOmitted = approvedFingerprints({ approval: { fingerprints: stored }, file: TEAM } as never);
    expect(fingerprints(bare.team).sections.tasks).toBe(stillOmitted.sections.tasks);
    const gained = approvedFingerprints({ approval: { fingerprints: { ...stored, sections: { ...stored.sections } } }, file: WITH } as never);
    expect(gained.sections.tasks).not.toBe(fingerprints(added.team).sections.tasks);
  });
});
