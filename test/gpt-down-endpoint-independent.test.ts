// Independent command-level scenes. TEAM_GPT_SUBJECT_ROOT runs these unchanged at the base.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DownSources } from '../src/commands/down.ts';
import type { EndpointStopRead } from '../src/launch/codex-endpoint.ts';
import type { Io } from '../src/io.ts';
import type { SeatState } from '../src/state.ts';

const subject = process.env.TEAM_GPT_SUBJECT_ROOT ?? resolve(import.meta.dir, '..');
const load = (path: string) => import(pathToFileURL(join(subject, 'src', path)).href);
const { runDown } = await load('commands/down.ts');
const { approvalOf } = await load('approve/approval.ts');
const { loadTeamFile } = await load('file/load.ts');
const { emptySession, readState, updateState } = await load('state.ts');
const { storePath, writeApproval } = await load('store/store.ts');
const { stopSeatCodexEndpoint } = await load('launch/codex-endpoint.ts');

const NOW = new Date('2026-11-01T00:00:00Z');
const BINDING = 'prs_123456789abc';
const PREDECESSOR = 'prs_abcdef123456';
const ARGS = ['--file', '.agents/team.yaml'];
type StopInput = { dir: string; session: string; seat: string };
type Stop = (input: StopInput) => EndpointStopRead;
type Place = { root: string; home: string; dir: string };

function fixture(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gpt-down-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  const env = { ...process.env };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'EMAIL']) delete env[key];
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'fixture');
  const file = join(dir, 'team.yaml');
  const text = `format: 1
project: fixture
session: fixture
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${['lead', 'worker', 'peer'].map((name) => `  - name: ${name}
    role: ${name === 'lead' ? 'coordinator' : 'implementer'}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`).join('')}`;
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw Error('independent team fixture is invalid');
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root, NOW), file: text }, loaded.team.seats, home);
  return { root, dir, home };
}

function record(at: Place, name = 'worker', kind = 'current'): SeatState {
  const endpoint = {
    url: `unix://${join(at.dir, 'run', 'fixture', name, BINDING + '.sock')}`,
    binding: kind === 'predecessor' ? PREDECESSOR : BINDING,
    pid: kind === 'unreadable' ? 'unreadable' : 424242,
    started_at: '2026-10-31T23:59:00Z',
  };
  return {
    id: name === 'worker' ? 'seat_123456789abc' : 'seat_abcdef123456',
    stage: 'ready', cli: 'claude-code', pane: `fixture-pane-${name}`,
    workspace: `fixture-workspace-${name}`, presence_binding: BINDING,
    codex_endpoint: endpoint as never, last_active: '2026-10-31T23:59:30Z',
    agent_session: `fixture-thread-${name}`, start_cwd: at.root, rules: 'message',
  };
}

function seed(at: Place, seats: Record<string, SeatState>): void {
  updateState(at.dir, (state: { sessions: Record<string, { seats: Record<string, SeatState> }> }) => {
    state.sessions.fixture = { ...emptySession(), seats };
  });
}
const seatsAt = (at: Place): Record<string, SeatState> => readState(at.dir).sessions.fixture.seats;

function world(at: Place, names: string[], stop?: Stop) {
  const stops: { input: StopInput; record: SeatState | undefined }[] = [];
  const events: string[] = [];
  let running = true;
  const sources: DownSources = {
    home: at.home, now: () => NOW, sessionRunning: () => running,
    agents: () => names.map((name) => ({ name, agent: 'claude', pane: `fixture-pane-${name}`, workspace: `fixture-workspace-${name}`, status: 'idle', cwd: null })),
    alive: () => false, commandOf: () => null, startOf: () => null,
    screen: () => ({ kind: 'idle' }), screenText: () => undefined,
    status: () => 'idle', foreground: () => ['fixture-shell'], shellBack: () => true,
    foregroundCwd: () => null, sleep: async () => {},
    launch: {
      typeText: () => { throw Error('unexpected fixture input'); },
      sendKey: () => { throw Error('unexpected fixture input'); },
      pressEnter: () => { throw Error('unexpected fixture input'); },
      agentPanes: () => [], closeWorkspace: (_session, workspace) => { events.push(`close:${workspace}`); return true; },
      stopSession: () => { events.push('stop-session'); running = false; return true; },
      deleteSession: () => { events.push('delete-session'); return true; },
      kill: () => { throw Error('unexpected fixture signal'); },
      sleep: async () => {}, now: () => NOW,
    },
    ...(stop ? { codexEndpoint: { stop: (input: StopInput) => {
      stops.push({ input, record: structuredClone(seatsAt(at)[input.seat]) });
      return stop(input);
    } } } : {}),
  };
  return { sources, stops, events };
}

async function down(at: Place, sources: DownSources, flags = ['--json']) {
  let out = '', err = '';
  const io: Io = { cwd: at.root, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
    caller: { kind: 'owner' }, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } };
  const code = await runDown([...ARGS, ...flags], io, sources);
  return { code, out, err, json: flags.includes('--json') ? JSON.parse(out) : null };
}

function held(result: Awaited<ReturnType<typeof down>>, at: Place, before: SeatState, w: ReturnType<typeof world>) {
  expect(result.code).toBe(1);
  expect(result.json.schema.name).toBe('team.error');
  expect(result.json.error.id).toBe('down.held');
  expect(seatsAt(at).worker).toEqual(before);
  expect(w.stops).toEqual([{ input: { dir: at.dir, session: 'fixture', seat: 'worker' }, record: before }]);
  expect(w.events).not.toContain('stop-session');
  expect(w.events).not.toContain('delete-session');
  expect(readState(at.dir).sessions.fixture.retained_seats?.worker).toBeUndefined();
}

for (const [ki, kind] of ['current', 'unreadable'].entries()) {
  for (const [ri, why] of ['synthetic proof refused', undefined, ''].entries()) {
    test(`D${ki + 1}${ri + 1}: a refused stop retains the complete launch`, async () => {
      const at = fixture(), before = record(at, 'worker', kind);
      seed(at, { worker: before });
      const w = world(at, ['worker'], () => why === undefined ? { stopped: false } : { stopped: false, why });
      held(await down(at, w.sources), at, before, w);
    });
  }
}

test('D30: the production stop reader refuses an unreadable record without signalling', async () => {
  const at = fixture(), before = record(at, 'worker', 'unreadable');
  seed(at, { worker: before });
  const signals: number[] = [];
  const w = world(at, ['worker'], (input) => stopSeatCodexEndpoint(input, {
    alive: () => true, commandOf: () => null, startOf: () => null,
    terminate: (pid: number) => signals.push(pid), isPlainDir: () => true, isSocket: () => false,
    drop: () => { throw Error('unexpected fixture unlink'); },
  }));
  held(await down(at, w.sources), at, before, w);
  expect(signals).toEqual([]);
});

test('D31: a refused launch remains available to a successful retry', async () => {
  const at = fixture(), before = record(at);
  seed(at, { worker: before });
  const first = world(at, ['worker'], () => ({ stopped: false }));
  held(await down(at, first.sources), at, before, first);
  const retry = world(at, ['worker'], () => ({ stopped: true }));
  const result = await down(at, retry.sources);
  expect(result.code).toBe(0);
  expect(result.json.status).toBe('stopped');
  expect(retry.stops[0]?.record).toEqual(before);
  expect(seatsAt(at).worker).toBeUndefined();
  expect(retry.events).toContain('stop-session');
});

test('D32: one refusal retains that launch while a proven peer is removed', async () => {
  const at = fixture(), before = record(at), peer = record(at, 'peer');
  seed(at, { worker: before, peer });
  const w = world(at, ['worker', 'peer'], ({ seat }) => ({ stopped: seat === 'peer' }));
  const result = await down(at, w.sources);
  expect(result.code).toBe(1);
  expect(result.json.error.id).toBe('down.held');
  expect(seatsAt(at).worker).toEqual(before);
  expect(seatsAt(at).peer).toBeUndefined();
  expect(w.stops.map((item) => item.input.seat).sort()).toEqual(['peer', 'worker']);
  expect(w.events).not.toContain('stop-session');
});

test('D33: text mode also reports the held run and retains its binding', async () => {
  const at = fixture(), before = record(at);
  seed(at, { worker: before });
  const w = world(at, ['worker'], () => ({ stopped: false }));
  const result = await down(at, w.sources, []);
  expect(result.code).toBe(1);
  expect(result.out).toContain('not stopped');
  expect(result.err).toContain('record was kept');
  expect(seatsAt(at).worker).toEqual(before);
});

test('D34: the production reader refuses a live process whose ownership is unproven', async () => {
  const at = fixture(), before = record(at);
  seed(at, { worker: before });
  const signals: number[] = [];
  const w = world(at, ['worker'], (input) => stopSeatCodexEndpoint(input, {
    alive: () => true, commandOf: () => 'fixture unrelated process', startOf: () => null,
    terminate: (pid: number) => signals.push(pid), isPlainDir: () => true, isSocket: () => false,
    drop: () => { throw Error('unexpected fixture unlink'); },
  }));
  held(await down(at, w.sources), at, before, w);
  expect(signals).toEqual([]);
});

test('D80: a proven stop removes the launch after the stop reader sees it', async () => {
  const at = fixture(), before = record(at);
  seed(at, { worker: before });
  const w = world(at, ['worker'], () => ({ stopped: true }));
  const result = await down(at, w.sources);
  expect(result.code).toBe(0);
  expect(result.json.status).toBe('stopped');
  expect(w.stops[0]?.record).toEqual(before);
  expect(seatsAt(at).worker).toBeUndefined();
  expect(readState(at.dir).sessions.fixture.retained_seats.worker.id).toBe(before.id);
  expect(w.events).toContain('stop-session');
});

for (const [ki, kind] of ['predecessor', 'absent', 'null', 'no-seam'].entries()) {
  test(`D8${ki + 1}: an unmanaged or predecessor launch keeps its established cleanup`, async () => {
    const at = fixture(), before = record(at, 'worker', kind);
    if (kind === 'absent') delete before.codex_endpoint;
    if (kind === 'null') before.codex_endpoint = null as never;
    seed(at, { worker: before });
    const w = world(at, ['worker'], kind === 'no-seam' ? undefined : () => ({ stopped: false }));
    const result = await down(at, w.sources);
    expect(result.code).toBe(0);
    expect(result.json.status).toBe('stopped');
    expect(w.stops).toEqual([]);
    expect(seatsAt(at).worker).toBeUndefined();
    expect(w.events).toContain('stop-session');
  });
}

test('D85: the production reader proves and signals only the recorded endpoint', async () => {
  const at = fixture(), before = record(at);
  seed(at, { worker: before });
  const endpoint = before.codex_endpoint!;
  const signals: number[] = [];
  const w = world(at, ['worker'], (input) => stopSeatCodexEndpoint(input, {
    alive: () => true, commandOf: () => `codex app-server --listen ${endpoint.url}`,
    startOf: () => Date.parse(endpoint.started_at), terminate: (pid: number) => signals.push(pid),
    isPlainDir: () => true, isSocket: () => false,
    drop: () => { throw Error('unexpected fixture unlink'); },
  }));
  const result = await down(at, w.sources);
  expect(result.code).toBe(0);
  expect(result.json.status).toBe('stopped');
  expect(signals).toEqual([endpoint.pid]);
  expect(w.stops[0]?.record).toEqual(before);
  expect(seatsAt(at).worker).toBeUndefined();
});

test('D90: a dry run never calls the endpoint stop or changes the seat', async () => {
  const at = fixture(), before = record(at);
  seed(at, { worker: before });
  const w = world(at, ['worker'], () => ({ stopped: false }));
  const result = await down(at, w.sources, ['--json', '--dry-run']);
  expect(result.code).toBe(0);
  expect(result.json.dry_run).toBe(true);
  expect(w.stops).toEqual([]);
  expect(w.events).toEqual([]);
  expect(seatsAt(at).worker).toEqual(before);
});
