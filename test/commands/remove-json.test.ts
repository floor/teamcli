// The `--json` document of `team remove`: one `team.remove` envelope on stdout, stderr empty, the
// status saying what the run did and the closing line as the summary; a refusal as the
// `team.error` document named by the contract row. The harness is the one remove.test.ts uses: a
// two-seat file, the approval written in force, herdr answered by closures.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { REMOVE_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { Screen } from '../../src/watch/screen.ts';
import { claudeBox, testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const owner = { kind: 'owner' as const };

let dir: string;
let file: string;
let home: string;
let clock: number;

function world(screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources;
  typed: string[];
  closed: string[];
  agents: HerdrAgent[];
} {
  const typed: string[] = [];
  const closed: string[] = [];
  let sent = false;
  let box: string | undefined = claudeBox('');
  const agents: HerdrAgent[] = [];
  clock = 0;
  const launch: DownLaunch = {
    typeText: (_session, _pane, text) => { typed.push(text); box = claudeBox(text); return true; },
    sendKey: () => { box = claudeBox(''); return true; },
    pressEnter: () => { sent = true; return true; },
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const sources: RemoveSources = {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    screenText: () => box,
    status: () => status,
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    launch,
    foreground: () => (sent ? [] : ['claude']),
  };
  return { sources, typed, closed, agents };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-remove-json-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, FILE);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  home = join(dir, 'home');
  const loaded = loadTeamFile(dir);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: FILE },
    loaded.team.seats,
    home,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('team remove --json', () => {
  test('a removed seat is one team.remove document closing on its summary', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--json'], io, made.sources)).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      dry_run: boolean;
      status: string;
      action_summary: string;
      project: string | null;
      session: string | null;
      seat: string;
      notes: string[];
    }>(io.out, REMOVE_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.remove', version: 1 });
    expect(doc.dry_run).toBe(false);
    expect(doc.status).toBe('removed');
    expect(doc.action_summary).toBe('removed worker');
    expect(doc.project).toBe('acme');
    expect(doc.session).toBe('acme');
    expect(doc.seat).toBe('worker');
    // The working lines the stop printed are the document's notes, not its stdout.
    expect(doc.notes).toContain('worker: stopped');
    expect(made.typed).toEqual(['/exit']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('--keep says kept, and the file keeps the seat stopped', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--keep', '--json'], io, made.sources)).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{ status: string; action_summary: string; seat: string }>(io.out, REMOVE_OUTPUT_SCHEMA);
    expect(doc.status).toBe('kept');
    expect(doc.action_summary).toBe('stopped worker');
    expect(doc.seat).toBe('worker');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a working seat is the remove.busy document, and nothing is typed', async () => {
    const made = world({ kind: 'idle' }, 'working');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'working', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--json'], io, made.sources)).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'remove.busy', messageContains: 'is working' });
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a name the team does not hold is the remove.no-seat document', async () => {
    const made = world();
    const io = testIo(dir, owner);
    expect(await runRemove(['stray', '--json'], io, made.sources)).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'remove.no-seat', messageContains: 'no seat' });
  });

  test('a bad invocation is the remove.invocation document and exit 2', async () => {
    const made = world();
    const io = testIo(dir, owner);
    expect(await runRemove(['--json', '--nope', 'worker'], io, made.sources)).toBe(2);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'remove.invocation' });
    expect(made.typed).toEqual([]);
  });
});
