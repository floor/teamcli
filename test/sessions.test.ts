// The session registry: the lines the launch and stop commands write, how they fold into one
// record, and what `team sessions` prints. The registry is TeamCLI's own record — no agent writes
// a line, and no CLI session file is read to make one.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costText, groupSessions, runSessions, sessionJson, shortStamp } from '../src/commands/sessions.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { launchSessionId, withLaunchSession } from '../src/profiles/profile.ts';
import { registerEnd } from '../src/registry/sync.ts';
import {
  beginSession,
  endSession,
  foldSessions,
  mintSessionId,
  parseSessionLine,
  readAllSessions,
  readStoreSessions,
  SESSIONS_FILE,
  type SessionEvent,
  type SessionStartEvent,
} from '../src/sessions/registry.ts';
import { storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const START = new Date('2026-10-04T08:00:00Z');
const LATER = new Date('2026-10-04T08:30:00Z');

const SEAT = (name: string, role: string, model: string): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: ${model}
    version: "5.5"
    launch: claude --model claude-${model === 'Claude Opus' ? 'opus' : 'sonnet'}-5-5`;

// A CLI that takes no session id at launch: the launch is the only thing that can tell two of
// its sessions apart, and a relaunch in the same pane must never be mistaken for the old one.
const CODEX_SEAT = (name: string): string => `  - role: implementer
    name: ${name}
    label: ${name}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol`;

function teamYaml(root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('lead', 'coordinator', 'Claude Opus')}
${SEAT('worker', 'implementer', 'Claude Sonnet')}
${CODEX_SEAT('codex')}`;
}

type Fixture = { root: string; home: string; team: TeamFile };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sessions-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const parsed = validateTeamFile(teamYaml(root), { home, root });
  if (!parsed.ok) throw new Error('fixture team does not validate');
  return { root, home, team: parsed.team };
}

function seatOf(fixture: Fixture, name: string) {
  const seat = fixture.team.seats.find((one) => one.name === name);
  if (seat === undefined) throw new Error(`fixture has no seat ${name}`);
  return seat;
}

function begin(
  fixture: Fixture,
  seatName: string,
  pane: string,
  cliSession?: string,
  now: Date = START,
): string {
  const started = beginSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: 'sess',
    seat: seatOf(fixture, seatName),
    pane,
    workspace: 'ws',
    ...(cliSession === undefined ? {} : { cli_session: cliSession }),
    now,
  });
  if (!('id' in started)) throw new Error(started.note);
  return started.id;
}

function sessionsOf(fixture: Fixture) {
  const read = readStoreSessions(storePath(fixture.team.project, fixture.root, fixture.home), fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read.sessions;
}

function startEvent(id: string, seat: string, ts: string, extra: Partial<SessionStartEvent> = {}): SessionEvent {
  return {
    event: 'start',
    ts,
    id,
    project: 'acme',
    team: 'acme',
    seat,
    cli: 'claude-code',
    lab: 'anthropic',
    account: 'anthropic',
    herdr_session: 'sess',
    ...extra,
  };
}

describe('the registry file', () => {
  test('a missing registry is no sessions, not a refusal', () => {
    const fixture = makeFixture();
    const read = readStoreSessions(storePath('acme', fixture.root, fixture.home), fixture.home);
    expect(read).toEqual({ ok: true, sessions: [] });
  });

  test('a line this version does not write is skipped, and the rest still folds', () => {
    const fixture = makeFixture();
    const store = storePath(fixture.team.project, fixture.root, fixture.home);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, SESSIONS_FILE), [
      'not json at all',
      '{"event":"start","ts":"2026-10-04T08:00:00.000Z"}',
      JSON.stringify({ event: 'start', ts: '2026-10-04T08:00:00.000Z', id: 'ses_000000000001', project: 'acme', team: 'acme', seat: 'lead', cli: 'claude-code', lab: 'anthropic', account: 'anthropic', herdr_session: 'sess' }),
      JSON.stringify({ event: 'end', ts: '2026-10-04T08:30:00.000Z', id: 'ses_000000000001', reason: 'owner-stop' }),
    ].join('\n'));
    const sessions = sessionsOf(fixture);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.ended).toBe('2026-10-04T08:30:00.000Z');
    expect(sessions[0]?.reason).toBe('owner-stop');
  });

  test('the first start and the first end win', () => {
    const events: SessionEvent[] = [
      startEvent('ses_000000000001', 'lead', '2026-10-04T08:00:00.000Z', { model: 'Claude Opus' }),
      startEvent('ses_000000000001', 'lead', '2026-10-04T08:10:00.000Z', { model: 'Claude Sonnet' }),
      { event: 'end', ts: '2026-10-04T08:30:00.000Z', id: 'ses_000000000001', reason: 'owner-stop' },
      { event: 'end', ts: '2026-10-04T08:40:00.000Z', id: 'ses_000000000001', reason: 'quota' },
    ];
    const [record] = foldSessions(events);
    expect(record?.model).toBe('Claude Opus');
    expect(record?.ended).toBe('2026-10-04T08:30:00.000Z');
    expect(record?.reason).toBe('owner-stop');
  });

  test('the chain reads from either side', () => {
    const [first, second] = foldSessions([
      startEvent('ses_000000000001', 'lead', '2026-10-04T08:00:00.000Z'),
      startEvent('ses_000000000002', 'lead', '2026-10-04T08:30:00.000Z', { previous: 'ses_000000000001' }),
    ]);
    expect(first?.next).toBe('ses_000000000002');
    expect(second?.previous).toBe('ses_000000000001');
  });

  test('an event this version does not write does not parse', () => {
    expect(parseSessionLine('{"event":"end","ts":"2026-10-04T08:30:00.000Z","id":"ses_1","reason":"power-cut"}')).toBeNull();
    expect(parseSessionLine('{"event":"start","ts":"2026-10-04T08:00:00.000Z","id":"ses_1"}')).toBeNull();
    expect(parseSessionLine('')).toBeNull();
  });

  test('the id is `ses_` and twelve lowercase hex characters', () => {
    for (let i = 0; i < 20; i += 1) expect(mintSessionId()).toMatch(/^ses_[0-9a-f]{12}$/);
  });
});

describe('beginSession and endSession', () => {
  test('a launch records what the launch knew', () => {
    const fixture = makeFixture();
    const id = begin(fixture, 'lead', 'pane-lead', '2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c');
    expect(id).toMatch(/^ses_[0-9a-f]{12}$/);
    const [record] = sessionsOf(fixture);
    expect(record).toMatchObject({
      id,
      ts: START.toISOString(),
      project: 'acme',
      team: 'acme',
      seat: 'lead',
      cli: 'claude-code',
      lab: 'anthropic',
      model: 'Claude Opus',
      version: '5.5',
      account: 'anthropic',
      herdr_session: 'sess',
      pane: 'pane-lead',
      workspace: 'ws',
      cli_session: '2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c',
      resumable: true,
    });
    expect(record?.ended).toBeUndefined();
    expect(record?.previous).toBeUndefined();
    expect(record?.tokens).toBeUndefined();
    expect(record?.cost).toBeUndefined();
  });

  test('the same launch reported twice writes one start', () => {
    const fixture = makeFixture();
    const first = begin(fixture, 'lead', 'pane-lead', 'abc');
    const second = begin(fixture, 'lead', 'pane-lead', 'abc', LATER);
    expect(second).toBe(first);
    expect(sessionsOf(fixture)).toHaveLength(1);
  });

  test('a new launch in another pane closes the open record as crash', () => {
    const fixture = makeFixture();
    const first = begin(fixture, 'lead', 'pane-lead', 'abc');
    const second = begin(fixture, 'lead', 'pane-new', 'def', LATER);
    expect(second).not.toBe(first);
    const sessions = sessionsOf(fixture);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: first,
      ended: LATER.toISOString(),
      reason: 'crash',
      note: 'a new launch found this session open',
      next: second,
    });
    expect(sessions[1]).toMatchObject({ id: second, previous: first });
    expect(sessions[1]?.ended).toBeUndefined();
  });

  test('a CLI that takes no session id, relaunched in its pane, is a new session linked to the old', () => {
    const fixture = makeFixture();
    const first = begin(fixture, 'codex', 'w1:p1', undefined, START);
    const second = begin(fixture, 'codex', 'w1:p1', undefined, LATER);
    expect(second).not.toBe(first);
    const sessions = sessionsOf(fixture);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: first,
      ended: LATER.toISOString(),
      reason: 'crash',
      note: 'a new launch found this session open',
      next: second,
    });
    expect(sessions[1]).toMatchObject({ id: second, previous: first });
    expect(sessions[1]?.ended).toBeUndefined();
  });

  test('a launch that replaces a session closed on purpose ends it as that reason, with no crash note', () => {
    const fixture = makeFixture();
    const first = begin(fixture, 'codex', 'w1:p1', undefined, START);
    const second = beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'sess',
      seat: seatOf(fixture, 'codex'),
      pane: 'w2:p1',
      replaces: 'swap',
      now: LATER,
    });
    if (!('id' in second)) throw new Error(second.note);
    const sessions = sessionsOf(fixture);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: first, ended: LATER.toISOString(), reason: 'swap', next: second.id });
    expect(sessions[0]?.note).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: second.id, previous: first });
  });

  test('an end names one seat, or every open record of the team', () => {
    const fixture = makeFixture();
    const lead = begin(fixture, 'lead', 'pane-lead', 'abc');
    const worker = begin(fixture, 'worker', 'pane-worker', 'def');
    const one = endSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'sess',
      seat: 'worker',
      reason: 'swap',
      now: LATER,
    });
    expect(one).toEqual({ ended: [worker] });
    const rest = endSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'sess',
      reason: 'owner-stop',
      now: LATER,
    });
    expect(rest).toEqual({ ended: [lead] });
    const sessions = sessionsOf(fixture);
    expect(sessions.map((record) => [record.id, record.reason])).toEqual([[lead, 'owner-stop'], [worker, 'swap']]);
  });

  test('ending a session the registry never opened writes nothing', () => {
    const fixture = makeFixture();
    const ended = endSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'sess',
      seat: 'lead',
      reason: 'owner-stop',
    });
    expect(ended).toEqual({ ended: [] });
    expect(sessionsOf(fixture)).toEqual([]);
  });

  test('registerEnd closes the record with the reason its call names', () => {
    const fixture = makeFixture();
    const id = begin(fixture, 'lead', 'pane-lead', 'abc');
    const note = registerEnd(
      { home: fixture.home, team: fixture.team, root: fixture.root, by: 'owner', session: 'sess' },
      'lead',
      'stopped',
      'restart',
    );
    expect(note).toBeNull();
    const [record] = sessionsOf(fixture);
    expect(record).toMatchObject({ id, reason: 'restart', ended: expect.any(String) });
  });

  test('a registry that cannot be read refuses by name', () => {
    const fixture = makeFixture();
    const store = storePath(fixture.team.project, fixture.root, fixture.home);
    mkdirSync(join(store, SESSIONS_FILE), { recursive: true });
    const read = readStoreSessions(store, fixture.home);
    expect(read).toEqual({ ok: false, reason: 'the session registry path is a directory' });
  });
});

describe('team sessions', () => {
  test('the listing filters to one seat and groups by model', async () => {
    const fixture = makeFixture();
    begin(fixture, 'lead', 'pane-lead', 'a');
    begin(fixture, 'worker', 'pane-worker', 'b');
    begin(fixture, 'lead', 'pane-lead-2', 'c', LATER);
    const all = testIo(fixture.root);
    expect(await runSessions([], all, { home: fixture.home, now: () => LATER })).toBe(0);
    expect(all.out.startsWith('3 sessions\n')).toBe(true);
    const one = testIo(fixture.root);
    expect(await runSessions(['worker'], one, { home: fixture.home, now: () => LATER })).toBe(0);
    expect(one.out.startsWith('1 session\n')).toBe(true);
    expect(one.out).toContain('worker');
    expect(one.out).not.toContain('Claude Opus');
    const grouped = testIo(fixture.root);
    expect(await runSessions(['--by', 'model'], grouped, { home: fixture.home, now: () => LATER })).toBe(0);
    expect(grouped.out.indexOf('model: Claude Opus')).toBeGreaterThan(-1);
    expect(grouped.out.indexOf('model: Claude Opus')).toBeLessThan(grouped.out.indexOf('model: Claude Sonnet'));
  });

  test('the JSON document carries each record whole, absent readings absent', async () => {
    const fixture = makeFixture();
    const id = begin(fixture, 'lead', 'pane-lead', 'abc');
    const io = testIo(fixture.root);
    expect(await runSessions(['--json'], io, { home: fixture.home, now: () => LATER })).toBe(0);
    const payload = JSON.parse(io.out) as { format: number; by: unknown; seat: unknown; sessions: Record<string, unknown>[] };
    expect(payload).toMatchObject({ format: 1, by: null, seat: null });
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({ id, started: START.toISOString(), ended: null, reason: null });
    expect(payload.sessions[0]?.ended).toBeNull();
    expect('cost' in (payload.sessions[0] ?? {})).toBe(false);
    expect('tokens' in (payload.sessions[0] ?? {})).toBe(false);
  });

  test('an empty registry prints the count and exits 0', async () => {
    const fixture = makeFixture();
    const io = testIo(fixture.root);
    expect(await runSessions([], io, { home: fixture.home, now: () => LATER })).toBe(0);
    expect(io.out).toBe('0 sessions\n');
    expect(io.err).toBe('');
  });

  test('a malformed invocation prints the usage and exits 2', async () => {
    const fixture = makeFixture();
    const io = testIo(fixture.root);
    expect(await runSessions(['--by', 'nothing'], io, { home: fixture.home, now: () => LATER })).toBe(2);
    expect(io.err).toContain('--by must be one of model, team, entity');
    expect(io.err).toContain('Usage: team sessions');
    const json = testIo(fixture.root);
    expect(await runSessions(['--by', 'nothing', '--json'], json, { home: fixture.home, now: () => LATER })).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({
      schema: { name: 'team.error', version: 1 },
      error: { id: 'sessions.invocation' },
    });
  });

  test('an unknown cost is the word, never zero', () => {
    expect(costText(undefined)).toBe('unknown');
    expect(costText({ amount: 0.1, currency: 'USD', source: 'estimated' })).toBe('0.1 USD (estimated)');
    expect(costText({ amount: 0, currency: 'USD', source: 'measured' })).toBe('0 USD');
  });

  test('a timestamp shows UTC to the minute', () => {
    expect(shortStamp('2026-10-04T08:00:00.000Z')).toBe('2026-10-04 08:00Z');
    expect(shortStamp('not-a-time')).toBe('not-a-time');
  });

  test('grouping names the unknowns', () => {
    const fixture = makeFixture();
    begin(fixture, 'lead', 'pane-lead', 'abc');
    const sessions = sessionsOf(fixture);
    expect(groupSessions(sessions, 'model').map((section) => section.group)).toEqual(['Claude Opus']);
    expect(groupSessions(sessions, 'team').map((section) => section.group)).toEqual(['acme']);
    expect(groupSessions(sessions, 'entity').map((section) => section.group)).toEqual(['no entity']);
  });

  test('every record reads back across the machine, oldest first', () => {
    const fixture = makeFixture();
    const early = begin(fixture, 'lead', 'pane-lead', 'a', START);
    const late = begin(fixture, 'worker', 'pane-worker', 'b', LATER);
    const read = readAllSessions(fixture.home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sessions.map((record) => record.id)).toEqual([early, late]);
    expect(sessionJson(read.sessions[0]!).started).toBe(START.toISOString());
  });
});

describe('the launch session id', () => {
  test('Claude Code gets an id TeamCLI minted, and the line keeps its command', () => {
    const launch = withLaunchSession('claude-code', 'claude --model claude-opus-5-5');
    expect(launch.command.startsWith('claude --model claude-opus-5-5 --session-id ')).toBe(true);
    expect(launch.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(launchSessionId(launch.command)).toBe(launch.sessionId);
  });

  test('a line that chooses its own session is left alone', () => {
    for (const command of [
      'claude --resume 2f6d1c1a',
      'claude -r 2f6d1c1a',
      'claude --continue',
      'claude -c',
      'claude --session-id 2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c',
    ]) {
      const launch = withLaunchSession('claude-code', command);
      expect(launch.command).toBe(command);
      expect(launch.sessionId).toBe(launchSessionId(command));
    }
    expect(launchSessionId('claude --session-id 2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c'))
      .toBe('2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c');
    expect(launchSessionId('claude --resume 2f6d1c1a')).toBeUndefined();
  });

  test('another CLI is left alone, and records no id', () => {
    const launch = withLaunchSession('codex', 'codex --model gpt-5');
    expect(launch).toEqual({ command: 'codex --model gpt-5' });
  });
});
