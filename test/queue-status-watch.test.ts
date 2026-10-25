import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus } from '../src/commands/status.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { backlogDepth, queueDepth, readBacklogDepth, readQueueDepths } from '../src/queues.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { claudeBox, testIo } from './helpers.ts';

const idle = claudeBox('');
const limited = readFileSync(new URL('./fixtures/claude-code/rate-limit.txt', import.meta.url), 'utf8');
const machine = { loadPerCore: 0.1, memoryFree: 70, diskFree: 100e9, swapTotal: 8e9, swapFree: 7e9, swapUsed: 1e9 };
let fixture: string;
let root: string;
let home: string;
let file: string;
let text: string;
let team: TeamFile;
let live: Live;

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'team-queues-')));
  home = join(fixture, 'home');
  root = join(home, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'notes/queue'), { recursive: true });
  file = join(root, '.agents/team.yaml');
  text = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ${root}
  - ${home}/.config/team/lobby
workspace:
  mode: shared
watch:
  queue_dir: notes/queue
  interval: 1s
  team_idle: 1s
  idle_first: 1h
seats:
${['lead', 'first', 'second'].map((name) => `  - name: ${name}
    role: ${name === 'lead' ? 'coordinator' : 'implementer'}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`).join('')}`;
  writeFileSync(file, text);
  const parsed = validateTeamFile(text, { home, root });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  team = parsed.team;
  live = {
    running: true,
    agents: team.seats.map((seat) => ({ name: seat.name, workspace: seat.name, pane: `${seat.name}:pane`, agent: 'claude', status: 'idle', cwd: null })),
    workspaces: team.seats.map((seat) => ({ id: seat.name, label: seat.label })),
    screens: Object.fromEntries(team.seats.map((seat) => [`${seat.name}:pane`, idle])),
  };
  for (const seat of team.seats) writeFileSync(join(root, 'notes/queue', `${seat.name}.md`), '# Queue\n');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

test('counts top-level numbered work and unchecked tasks, ignoring completed tasks, children and fences', () => {
  expect(queueDepth('# Queue\n1. first\n   1. detail\n2. [x] done\n3. [ ] next\n- [ ] last\n- prose\n```md\n1. sample\n```\n~~~\n- [ ] sample\n~~~\n')).toBe(3);
  expect(queueDepth('  - [x] done\n  - [ ] work\n    - [ ] detail\n')).toBe(1);
  expect(queueDepth('# Empty\nNo assigned work.')).toBe(0);
});

test('queue directory is optional and validated', () => {
  expect(validateTeamFile(text.replace('queue_dir: notes/queue', 'queue_dir: 4')).ok).toBe(false);
  expect(validateTeamFile(text.replace('queue_dir: notes/queue', 'queue_dir: ""')).ok).toBe(false);
  const unconfigured = { ...team, watch: { ...team.watch, queueDir: undefined } };
  expect(readQueueDepths(unconfigured, root, home)).toBeNull();
});

test('reads project-relative and home-relative queues; absent, non-file and oversized queues stay unknown', () => {
  writeFileSync(join(root, 'notes/queue/first.md'), '- [ ] pending\n- [x] finished\n');
  expect(readQueueDepths(team, root, home)).toEqual({ lead: 0, first: 1, second: 0 });
  rmSync(join(root, 'notes/queue/first.md'));
  rmSync(join(root, 'notes/queue/second.md'));
  mkdirSync(join(root, 'notes/queue/second.md'));
  expect(readQueueDepths(team, root, home)).toEqual({ lead: 0, first: null, second: null });
  writeFileSync(join(root, 'notes/queue/first.md'), 'x'.repeat(1024 * 1024 + 1));
  expect(readQueueDepths(team, root, home)?.first).toBeNull();
  mkdirSync(join(home, 'queue'));
  writeFileSync(join(home, 'queue/first.md'), '1. assigned\n');
  expect(readQueueDepths({ ...team, watch: { ...team.watch, queueDir: '~/queue' } }, root, home)?.first).toBe(1);
});

test('status text and JSON expose queue depth and name the pool on a rate-limited seat', async () => {
  writeFileSync(join(root, 'notes/queue/first.md'), '1. task\n2. task\n');
  rmSync(join(root, 'notes/queue/second.md'));
  live.screens['second:pane'] = limited;
  const sources = { live: () => live, branch: () => 'main', standing: () => verifiedOf(team, text, root), now: () => new Date(), home };
  for (const extra of [[], ['--all']]) {
    const io = testIo(root, { kind: 'owner' });
    await runStatus(['--file', file, ...extra], io, sources);
    expect(io.out, io.err).toContain('queues:\n  lead: 0\n  first: 2\n  second: unknown');
    expect(io.out).toContain('idle (rate limit on anthropic, resets at 11:00)');
    const json = testIo(root, { kind: 'owner' });
    await runStatus(['--file', file, '--json', ...extra], json, sources);
    const rows = JSON.parse(json.out).rows;
    expect(rows.find((row: { name: string }) => row.name === 'first').queue_depth).toBe(2);
    expect(rows.find((row: { name: string }) => row.name === 'second')).toMatchObject({ queue_depth: null, state: 'idle (rate limit on anthropic, resets at 11:00)' });
  }
});

function cycle(memory: ReturnType<typeof newMemory>, now: number, depths = { lead: 0, first: 0, second: 0 } as Record<string, number | null>, backlog: number | null = null) {
  return pass({ team, watch: team.watch, state: emptySession(), live, machine, now, memory, queueDepths: depths, queueBacklog: backlog });
}

test('summary waits, reports once to the orchestrator, excludes quota seats and rearms after work arrives', () => {
  live.screens['second:pane'] = limited;
  const memory = newMemory();
  cycle(memory, 0);
  const due = cycle(memory, 1000).reports.filter((report) => report.key === 'queue-idle');
  expect(due).toEqual([{ key: 'queue-idle', text: '1 seat idle, queues empty; at a quota or limit: second', to: 'orchestrator' }]);
  expect(cycle(memory, 5000).reports.some((report) => report.key === 'queue-idle')).toBe(false);
  cycle(memory, 6000, { lead: 0, first: 1, second: 0 });
  expect(cycle(memory, 7000).reports.some((report) => report.key === 'queue-idle')).toBe(false);
  expect(cycle(memory, 8000).reports.some((report) => report.key === 'queue-idle')).toBe(true);
});

test('unknown or pending queues, blocked screens, missing workers and working seats cannot produce an idle summary', () => {
  for (const depth of [null, 1]) {
    const memory = newMemory();
    cycle(memory, 0, { lead: 0, first: depth, second: 0 });
    expect(cycle(memory, 2000, { lead: 0, first: depth, second: 0 }).queueSummary).toBeNull();
  }
  for (const screen of [limited, claudeBox('owner draft'), 'unreadable screen']) {
    for (const agent of live.agents) live.screens[agent.pane] = screen;
    expect(cycle(newMemory(), 0).queueSummary).toBeNull();
  }
  for (const agent of live.agents) { agent.status = 'working'; live.screens[agent.pane] = idle; }
  expect(cycle(newMemory(), 0).queueSummary).toBeNull();
  live.agents = live.agents.filter((agent) => agent.name !== 'second');
  expect(cycle(newMemory(), 0).queueSummary).toBeNull();
});

test('counts unclaimed backlog items: numbered, unchecked, and carrying no claim marker', () => {
  expect(backlogDepth('# Backlog\n\n1. open\n2. taken — claimed: builder-1 16 Oct\n3. finished — done: builder-2, PR #1\n4. elsewhere — Claimed: builder-3\n')).toBe(1);
  expect(backlogDepth('1. plain numbered\n2. [x] a checked one\n3. [ ] still open\n- [ ] a task is no numbered item\n')).toBe(2);
  // A marker under the item belongs to it, a child item does not become one, and a fenced
  // example is no item at all.
  expect(backlogDepth('1. first\n   — claimed: builder-2\n2. second\n   1. nested, not top level\n3. third\n```\n4. sample\n```\n')).toBe(2);
  expect(backlogDepth('# Empty\n')).toBe(0);
});

test('backlog count is unknown, never zero, when there is no file to read', () => {
  writeFileSync(join(root, 'notes/queue/linear-backlog.md'), '1. open\n2. claimed: builder-1\n');
  expect(readBacklogDepth(team, root, home)).toBe(1);
  rmSync(join(root, 'notes/queue/linear-backlog.md'));
  expect(readBacklogDepth(team, root, home)).toBeNull();
  mkdirSync(join(root, 'notes/queue/linear-backlog.md'));
  expect(readBacklogDepth(team, root, home)).toBeNull();
  rmSync(join(root, 'notes/queue/linear-backlog.md'), { recursive: true });
  writeFileSync(join(root, 'notes/queue/linear-backlog.md'), 'x'.repeat(1024 * 1024 + 1));
  expect(readBacklogDepth(team, root, home)).toBeNull();
  const unconfigured = { ...team, watch: { ...team.watch, queueDir: undefined } };
  expect(readBacklogDepth(unconfigured, root, home)).toBeNull();
  mkdirSync(join(home, 'queue'), { recursive: true });
  writeFileSync(join(home, 'queue/linear-backlog.md'), '1. assigned\n');
  expect(readBacklogDepth({ ...team, watch: { ...team.watch, queueDir: '~/queue' } }, root, home)).toBe(1);
});

test('status prints the unclaimed backlog count beside the queue depths, unknown when unreadable', async () => {
  writeFileSync(join(root, 'notes/queue/linear-backlog.md'), '1. open\n2. taken — claimed: builder-1\n3. finished — done: builder-2, PR #1\n');
  const sources = { live: () => live, branch: () => 'main', standing: () => verifiedOf(team, text, root), now: () => new Date(), home };
  const io = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file], io, sources);
  expect(io.out, io.err).toContain('queues:\n  lead: 0\n  first: 0\n  second: 0\n  backlog: 1 unclaimed');
  const json = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file, '--json'], json, sources);
  expect(JSON.parse(json.out).queue_backlog).toBe(1);
  rmSync(join(root, 'notes/queue/linear-backlog.md'));
  const missing = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file], missing, sources);
  expect(missing.out).toContain('\n  backlog: unknown');
  const missingJson = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file, '--json'], missingJson, sources);
  expect(JSON.parse(missingJson.out).queue_backlog).toBeNull();
});

async function watchScenario(options: { noNudge?: boolean; busy?: boolean; clear?: boolean; failEnter?: boolean; foreign?: boolean; workers?: boolean; backlog?: string } = {}) {
  let tick = 0;
  let now = 0;
  const typed: Record<string, string> = {};
  if (options.backlog !== undefined) writeFileSync(join(root, 'notes/queue/linear-backlog.md'), options.backlog);
  if (options.workers) {
    text = text.replace('idle_first: 1h', 'idle_first: 1s');
    team.watch.idleFirst = 1;
    writeFileSync(file, text);
  }
  const attempts: string[] = [];
  let entered = 0;
  const lead = live.agents.find((agent) => agent.name === 'lead')!;
  const sources: WatchSources = {
    live: () => live, machine: () => machine, standing: () => verifiedOf(team, text, root), readChecks: () => [],
    screen: (pane) => typed[pane] ? claudeBox(typed[pane]!) : live.screens[pane] ?? null,
    status: (pane) => live.agents.find((agent) => agent.pane === pane)?.status ?? null,
    foreground: () => ['claude'], typeText: (pane, value) => { attempts.push(pane); typed[pane] = value; return true; },
    pressEnter: (pane) => { if (pane === 'lead:pane') { entered++; if (options.failEnter && entered === 1) return false; } delete typed[pane]; return true; },
    sleep: async (ms) => { now += ms; }, notify: () => {}, now: () => new Date(now),
    wait: async () => {
      tick++; now += 1000;
      if (options.busy) lead.status = tick < 3 ? 'working' : 'idle';
      if (options.clear && tick === 2) writeFileSync(join(root, 'notes/queue/first.md'), '- [ ] new work\n');
      for (const agent of live.agents) live.screens[agent.pane] = typed[agent.pane] ? claudeBox(typed[agent.pane]!) : idle;
      return tick < 5;
    },
    alive: () => false, pid: 987654321, home,
  };
  const io = testIo(root, { kind: 'owner' });
  const args = ['--file', file, '--no-notify', ...(options.noNudge ? ['--no-nudge'] : []), ...(options.foreign ? ['--session', 'other-team'] : [])];
  expect(await runWatch(args, io, sources), io.err).toBe(0);
  let bodies: string[] = [];
  try { const dir = join(root, '.agents/send-drops/acme/lead'); bodies = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')); } catch { /* No delivery. */ }
  return { attempts, entered, bodies, io };
}

test('the queue summary is reported, never typed into the orchestrator\'s pane', async () => {
  const result = await watchScenario({ busy: true });
  expect(result.attempts).not.toContain('lead:pane');
  expect(result.bodies).toEqual([]);
  expect(result.io.out + result.io.err).toContain('2 seats idle, queues empty');
});

test('the reported summary carries the backlog count', async () => {
  const result = await watchScenario({ backlog: '1. open\n2. open\n3. taken — claimed: builder-1\n' });
  expect(result.io.out + result.io.err).toContain('2 seats idle, queues empty; 2 unclaimed backlog items');
});

test('a pending summary is discarded when a queue gains work before the orchestrator is free', async () => {
  const result = await watchScenario({ busy: true, clear: true });
  expect(result.attempts).toEqual([]);
  expect(result.bodies).toEqual([]);
});

test.each([{ noNudge: true }, { foreign: true }])('watch does not deliver with %j', async (options) => {
  const result = await watchScenario(options);
  expect(result.attempts).toEqual([]);
  expect(result.bodies).toEqual([]);
});

test('a team with no queue directory prints no queue section and no backlog field', async () => {
  const bare = text.replace('  queue_dir: notes/queue\n', '');
  writeFileSync(file, bare);
  const parsed = validateTeamFile(bare, { home, root });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const sources = { live: () => live, branch: () => 'main', standing: () => verifiedOf(parsed.team, bare, root), now: () => new Date(), home };
  const io = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file, '--json'], io, sources);
  const doc = JSON.parse(io.out);
  expect('queue_backlog' in doc, io.err).toBe(false);
  expect(doc.rows.every((row: { queue_depth?: number }) => row.queue_depth === undefined)).toBe(true);
  const plain = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file], plain, sources);
  expect(plain.out, plain.err).not.toContain('queues:');
});

test('the summary names unclaimed backlog work, and the count never extends a stretch', () => {
  const memory = newMemory();
  expect(cycle(memory, 0, { lead: 0, first: 0, second: 0 }, 2).queueSummary?.text).toBe('2 seats idle, queues empty; 2 unclaimed backlog items');
  const due = cycle(memory, 1000, { lead: 0, first: 0, second: 0 }, 2).reports.filter((report) => report.key === 'queue-idle');
  expect(due).toEqual([{ key: 'queue-idle', text: '2 seats idle, queues empty; 2 unclaimed backlog items', to: 'orchestrator' }]);
  // The count is part of the sentence, not of the stretch: it moving sends no second report.
  expect(cycle(memory, 2000, { lead: 0, first: 0, second: 0 }, 0).reports.some((report) => report.key === 'queue-idle')).toBe(false);
  // A count this pass could not read is unknown, not zero: the sentence stays the one without a count.
  expect(cycle(newMemory(), 0, { lead: 0, first: 0, second: 0 }, null).queueSummary?.text).toBe('2 seats idle, queues empty');
});

test('temporary seats also have queue depths and rate-limit state', async () => {
  updateState(join(root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.helper = { stage: 'ready', temporary: { like: 'first', until: 'manual' } };
  });
  live.agents.push({ name: 'helper', workspace: 'helper', pane: 'helper:pane', agent: 'claude', status: 'done', cwd: null });
  live.screens['helper:pane'] = limited;
  writeFileSync(join(root, 'notes/queue/helper.md'), '- [ ] task\n');
  const io = testIo(root, { kind: 'owner' });
  await runStatus(['--file', file, '--json'], io, { live: () => live, branch: () => 'main', standing: () => verifiedOf(team, text, root), now: () => new Date(), home });
  expect(JSON.parse(io.out).rows.find((row: { name: string }) => row.name === 'helper')).toMatchObject({ queue_depth: 1, state: 'done (rate limit on anthropic, resets at 11:00), temporary' });
});
