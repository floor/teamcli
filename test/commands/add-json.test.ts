// The `--json` document of `team add`: one `team.add` envelope on stdout, stderr empty, the
// status saying what the run did and the final record as the summary; a refusal as the
// `team.error` document named by the contract row. The harness is the one add.test.ts uses: a
// two-seat file, the approval written in force, herdr answered by closures.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { ADD_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import { readState } from '../../src/state.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = CLAUDE_IDLE;

let base: string;
let project: string;
let home: string;

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    # the seat stays in this order
    stopped: true
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function approve(): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = FILE.replace(
    'coordinator: lead\n',
    `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\n`,
  );
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
}

function doctor(): DoctorSources {
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

function world(): { launch: Launch; creates: string[]; renames: string[]; session: 'absent' | 'running' } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = { launch: {} as Launch, creates: [] as string[], renames: [] as string[], session: 'absent' as 'absent' | 'running' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

function sources(made: ReturnType<typeof world>, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-json-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const owner = { kind: 'owner' } as const;

describe('team add --json', () => {
  test('a ready seat is one team.add document closing on its record', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker', '--json'], io, sources(made))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      dry_run: boolean;
      status: string;
      action_summary: string;
      project: string | null;
      session: string | null;
      seat: string;
      pane: string | null;
      notes: string[];
    }>(io.out, ADD_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.add', version: 1 });
    expect(doc.dry_run).toBe(false);
    expect(doc.status).toBe('ready');
    expect(doc.action_summary).toBe('worker: ready');
    expect(doc.project).toBe('acme');
    expect(doc.session).toBe('acme');
    expect(doc.seat).toBe('worker');
    expect(doc.pane).toBe('w1:p1');
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker?.stage).toBe('ready');
  });

  test('a brief that cannot be written is a note in the document', async () => {
    const made = world();
    // A fresh seat's record id is derived from a lifetime the delivery mints at the write, so the
    // scene holds the seat's own drop folder shut instead: a file where the folder must be.
    const path = join(project, '.agents', 'send-drops', 'acme', 'worker');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not a folder\n');
    const io = testIo(project, owner);
    expect(await runAdd(['worker', '--json'], io, sources(made))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{ status: string; notes: string[] }>(io.out, ADD_OUTPUT_SCHEMA);
    expect(doc.status).toBe('ready');
    expect(doc.notes).toEqual([
      'team add: worker: the general seat brief was not delivered (the record could not be written)',
    ]);
  });

  test('a dry run is the plan, and nothing is made', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker', '--dry-run', '--json'], io, sources(made))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      dry_run: boolean;
      status: string;
      action_summary: string;
      seat: string;
      plan: { step: string; prefix: string }[];
    }>(io.out, ADD_OUTPUT_SCHEMA);
    expect(doc.dry_run).toBe(true);
    expect(doc.status).toBe('dry-run');
    expect(doc.action_summary).toBe('dry run: nothing was run');
    expect(doc.seat).toBe('worker');
    expect(doc.plan.length).toBeGreaterThan(0);
    expect(doc.plan.map((step) => step.prefix)).toContain('+');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a bad invocation is the add.invocation document and exit 2', async () => {
    const made = world();
    // `--json` is read off the raw argv, so a bad option before it, and a malformed
    // `--json=1` the parser refuses, still owe the document rather than the usage line.
    for (const argv of [['--json', '--nope'], ['--nope', '--json'], ['worker', '--json=1']]) {
      const io = testIo(project, owner);
      expect(await runAdd(argv, io, sources(made))).toBe(2);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'add.invocation' });
    }
    expect(made.creates).toEqual([]);
  });

  test('a seat caller without the override is the add.caller document', async () => {
    const made = world();
    const io = testIo(project, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    expect(await runAdd(['worker', '--json'], io, sources(made))).toBe(1);
    expect(io.err).toBe('');
    const doc = assertJsonErrorShape(io.out, { id: 'add.caller', messageContains: 'only the owner or a standing grant' });
    expect(made.creates).toEqual([]);
    // The repair names the command a delegate runs, or the owner's: this run's --json is not part of it.
    expect(doc.error.repair).toBe('an approved delegate runs `team add …` from its own pane when team config names one; otherwise the owner runs it from this folder, at a terminal outside herdr');
    expect(doc.error.repair).not.toContain('--json');

    // The dry answer's line is the command itself, without the dry run's own flag.
    const dry = testIo(project, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    expect(await runAdd(['worker', '--dry-run'], dry, sources(world()))).toBe(1);
    expect(dry.out).toContain('! to unblock: an approved delegate runs `team add worker`');
    expect(dry.out).not.toContain('--dry-run`');
  });

  test('a read-at-start warning is a note of its own sentence, on a dry run and a real one', async () => {
    const lobby = join(home, '.config', 'team', 'lobby');
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    writeFileSync(join(lobby, 'CLAUDE.md'), 'plant\n');
    const warning = `warning: the lobby ${lobby}: CLAUDE.md is read at start by claude-code, cursor and grok`;

    // The lead starts in the project, so the planted file is said and not refused; the
    // document's note is the sentence itself, without the terminal's `team add: `.
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['lead', '--json'], io, sources(made))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{ status: string; notes: string[] }>(io.out, ADD_OUTPUT_SCHEMA);
    expect(doc.status).toBe('ready');
    expect(doc.notes).toContain(warning);
    expect(doc.notes.some((note) => note.startsWith('team add:'))).toBe(false);

    const dryWorld = world();
    const dry = testIo(project, owner);
    expect(await runAdd(['lead', '--dry-run', '--json'], dry, sources(dryWorld))).toBe(0);
    expect(dry.err).toBe('');
    const dryDoc = assertMatchesOutputSchema<{ status: string; notes: string[] }>(dry.out, ADD_OUTPUT_SCHEMA);
    expect(dryDoc.status).toBe('dry-run');
    expect(dryDoc.notes).toContain(warning);
    expect(dryDoc.notes.some((note) => note.startsWith('team add:'))).toBe(false);
  });

  test('the dev-mode warning rides in the document notes, and stderr stays empty', async () => {
    const made = world();
    const io = testIo(project, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runAdd(['worker', '--json'], io, sources(made))).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{ status: string; notes: string[] }>(io.out, ADD_OUTPUT_SCHEMA);
    expect(doc.status).toBe('ready');
    expect(doc.notes).toContain(
      'warning: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is helper; dev mode continues',
    );
    expect(doc.notes.some((note) => note.startsWith('team add:'))).toBe(false);
    expect(made.creates).toEqual(['worker']);

    // A dry run collects the same sentence: the plan's `! ` marks a terminal line, not a note.
    const dryIo = testIo(project, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    dryIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runAdd(['worker', '--dry-run', '--json'], dryIo, sources(world()))).toBe(0);
    expect(dryIo.err).toBe('');
    const dryDoc = assertMatchesOutputSchema<{ status: string; notes: string[] }>(dryIo.out, ADD_OUTPUT_SCHEMA);
    expect(dryDoc.status).toBe('dry-run');
    expect(dryDoc.notes).toContain(
      'warning: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is helper; dev mode continues',
    );
    expect(dryDoc.notes.some((note) => note.startsWith('! '))).toBe(false);
  });
});
