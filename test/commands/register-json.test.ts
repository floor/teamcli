// The `--json` document of `team register`: one `team.register` envelope on stdout, stderr empty,
// the status saying what the run did; the dry run's single plan step; a refusal as the
// `team.error` document named by the contract row. The harness is register.test.ts's: fake
// herdr, a temporary home, a pinned caller, and an owner who reads the team file under trust.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../../src/herdr.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { LOG_FILE, STATE_FILE } from '../../src/state.ts';
import { REGISTER_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const NOW = new Date('2026-10-16T21:00:00Z');
const OWNER = { kind: 'owner' as const };
const PANE = 'w1:p1';
const WORKSPACE = 'ws-1';

const made: string[] = [];
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; dir: string };

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-json-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  return { base, home, root, dir: join(root, '.agents') };
}

function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: null, session: 'claude-session-1' };
}

function sources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agent('lead')],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    now: () => NOW,
    ...over,
  };
}

async function register(w: World, argv: string[], over: Partial<RegisterSources> = {}) {
  const io = testIo(w.root, OWNER);
  const code = await runRegister(argv, io, sources(w, over));
  return { code, io };
}

describe('team register --json', () => {
  test('a registered seat is one team.register document closing on its summary', async () => {
    const w = world();
    const { code, io } = await register(w, ['lead', '--json']);
    expect(code, io.err).toBe(0);
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
    }>(io.out, REGISTER_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.register', version: 1 });
    expect(doc.dry_run).toBe(false);
    expect(doc.status).toBe('ready');
    expect(doc.action_summary).toBe('lead: registered — pane w1:p1; nothing was launched');
    expect(doc.project).toBe('acme');
    expect(doc.session).toBe('acme');
    expect(doc.seat).toBe('lead');
    expect(doc.pane).toBe(PANE);
    expect(Array.isArray(doc.notes)).toBe(true);
    expect(existsSync(join(w.dir, STATE_FILE))).toBe(true);
  });

  test('a second run is the already document, and writes nothing new to the seat', async () => {
    const w = world();
    const first = await register(w, ['lead']);
    expect(first.code).toBe(0);
    const { code, io } = await register(w, ['lead', '--json']);
    expect(code, io.err).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{ status: string; action_summary: string; seat: string; pane: string | null }>(
      io.out,
      REGISTER_OUTPUT_SCHEMA,
    );
    expect(doc.status).toBe('already');
    expect(doc.action_summary.startsWith('lead: already registered — pane w1:p1')).toBe(true);
    expect(doc.seat).toBe('lead');
    expect(doc.pane).toBe(PANE);
  });

  test('a dry run is the dry-run document with one plan step and writes nothing', async () => {
    const w = world();
    const { code, io } = await register(w, ['lead', '--dry-run', '--json']);
    expect(code, io.err).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      dry_run: boolean;
      status: string;
      action_summary: string;
      seat: string;
      pane: string | null;
      plan: { step: string; seat?: string | null; detail: string; prefix?: string }[];
      notes: string[];
    }>(io.out, REGISTER_OUTPUT_SCHEMA);
    expect(doc.dry_run).toBe(true);
    expect(doc.status).toBe('dry-run');
    expect(doc.action_summary).toBe('dry run: nothing was run');
    expect(doc.seat).toBe('lead');
    expect(doc.pane).toBe(PANE);
    expect(doc.plan).toEqual([
      { step: 'register', seat: 'lead', detail: 'lead: registered — pane w1:p1; nothing was launched', prefix: '+' },
    ]);
    expect(existsSync(join(w.dir, STATE_FILE))).toBe(false);
    expect(existsSync(join(w.dir, LOG_FILE))).toBe(false);
  });

  test('a dry run on an already-registered seat is still the dry-run document, never the already one', async () => {
    const w = world();
    const first = await register(w, ['lead']);
    expect(first.code).toBe(0);
    const before = readFileSync(join(w.dir, STATE_FILE), 'utf8');
    const { code, io } = await register(w, ['lead', '--dry-run', '--json']);
    expect(code, io.err).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      dry_run: boolean;
      status: string;
      action_summary: string;
      seat: string;
      pane: string | null;
      plan: { step: string; seat?: string | null; detail: string; prefix?: string }[];
    }>(io.out, REGISTER_OUTPUT_SCHEMA);
    // A dry run paints nothing for real, so its document is a plan whatever the real run would
    // find — the already path included — and says so in the status and the summary.
    expect(doc.dry_run).toBe(true);
    expect(doc.status).toBe('dry-run');
    expect(doc.action_summary).toBe('dry run: nothing was run');
    expect(doc.seat).toBe('lead');
    expect(doc.pane).toBe(PANE);
    expect(doc.plan.length).toBe(1);
    expect(doc.plan[0]!.step).toBe('register');
    expect(doc.plan[0]!.seat).toBe('lead');
    expect(doc.plan[0]!.prefix).toBe('+');
    expect(doc.plan[0]!.detail).toBe(`lead: already registered — pane ${PANE}; the record would be refreshed from the file, nothing relaunched`);
    // And the record the real first run wrote is left exactly as it stands.
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(before);
  });

  test('a seat the file does not declare is the register.no-seat document', async () => {
    const w = world();
    const { code, io } = await register(w, ['ghost', '--json']);
    expect(code).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'register.no-seat', messageContains: 'no seat' });
  });

  test('a pane holding another program is the register.cli document', async () => {
    const w = world();
    const { code, io } = await register(w, ['lead', '--json'], { foreground: () => ['zsh'] });
    expect(code).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'register.cli', messageContains: 'holds no `claude-code` process' });
  });

  test('a bad invocation is the register.usage document and exit 2', async () => {
    const w = world();
    const { code, io } = await register(w, ['--json', '--nope', 'lead']);
    expect(code).toBe(2);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'register.usage' });
  });
});
