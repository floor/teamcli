// `team agents prune`: the agent records no team roster names, what the dry run lists, what
// `--apply` retires, and the records it deliberately leaves alone. Hermetic: a temporary HOME,
// synthetic agent records and team records, never ~/.config/team.

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runAgents, type AgentsJson } from '../../src/commands/agents.ts';
import { agentsDir, getAgent, registerAgent, type Agent, type AgentLifecycle } from '../../src/registry/agents.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../../src/registry/teams.ts';
import type { Io } from '../../src/io.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-31T09:00:00.000Z');
const owner: Caller = { kind: 'owner' };
const detached: Caller = { kind: 'owner-no-tty' };
const seatCaller: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p1', session: 'acme' };

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
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
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Place = { base: string; home: string; root: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A team file in a fresh home, its registry record written by the test that needs one. */
function place(file: string | null = TEAM): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agents-prune-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  if (file !== null) writeFileSync(join(root, '.agents', 'team.yaml'), file);
  return { base, home, root };
}

/** An agent record reaching `seat` on `team`, as a launch would leave it. */
function record(home: string, team: string, seat: string, lifecycle: AgentLifecycle = 'stopped'): Agent {
  return registerAgent(home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team, seat, session: 'acme', pane: `w1:${seat}`, address: null },
    mcp: [],
    skills: [],
    lifecycle,
    by: 'test',
  });
}

/** The team record the registry holds for this place, no roster line unless one is named. */
function teamRecord(where: Place, rosterAgent?: string, seat = 'worker'): string {
  const id = teamIdOf(where.root);
  upsertTeam(where.home, id, {
    project: 'acme',
    session: 'acme',
    root: where.root,
    by: 'test',
    ...(rosterAgent === undefined ? {} : { roster: [{ agent: rosterAgent, seat, role: 'implementer' }] }),
  });
  return id;
}

type Ran = { code: number; out: string; err: string };

async function run(where: Place, argv: string[], caller: Caller = owner): Promise<Ran> {
  const io: Io & { out: string; err: string } = testIo(where.root, caller);
  return { code: await runAgents(argv, io, { home: where.home, now: () => NOW }), out: io.out, err: io.err };
}

function jsonOf(value: Ran): AgentsJson {
  return JSON.parse(value.out) as AgentsJson;
}

function bytesOf(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('team agents prune', () => {
  test('a dry run lists an orphan and writes nothing', async () => {
    const where = place();
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    const path = join(agentsDir(where.home), `${ghost.id}.yaml`);
    const before = bytesOf(path);
    const ran = await run(where, ['prune']);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('1 agent record no team roster names: 1 record to retire');
    expect(ran.out).toContain(ghost.id);
    expect(ran.out).toContain('ghost');
    expect(bytesOf(path)).toBe(before);
    const after = getAgent(where.home, ghost.id);
    expect(after?.lifecycle).toBe('stopped');
    expect(after?.orphaned_at ?? null).toBeNull();
  });

  test('--apply retires the record and keeps every field', async () => {
    const where = place();
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    const ran = await run(where, ['prune', '--apply']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('1 record retired');
    const path = join(agentsDir(where.home), `${ghost.id}.yaml`);
    expect(existsSync(path)).toBe(true);
    const after = getAgent(where.home, ghost.id);
    expect(after?.lifecycle).toBe('retired');
    expect(after?.orphaned_at).toBe(NOW.toISOString());
    expect(after?.reach).toMatchObject({ team, seat: 'ghost', session: 'acme', pane: null });
    expect(after?.signing).toEqual(ghost.signing);
    expect(after?.name).toBe(ghost.name);
  });

  test('a retired record is listed but not retired again, and that dry run exits 0', async () => {
    const where = place();
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    expect((await run(where, ['prune', '--apply'])).code).toBe(0);
    const at = getAgent(where.home, ghost.id)?.orphaned_at;
    const ran = await run(where, ['prune']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('none to retire');
    expect(ran.out).toContain('retired');
    expect(getAgent(where.home, ghost.id)?.orphaned_at).toBe(at ?? '');
  });

  test('a seat the team file declares is left alone', async () => {
    const where = place();
    const team = teamRecord(where);
    const worker = record(where.home, team, 'worker');
    const ran = await run(where, ['prune', '--apply']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('none to retire');
    expect(ran.out).toContain('declared');
    const after = getAgent(where.home, worker.id);
    expect(after?.lifecycle).toBe('stopped');
    expect(after?.orphaned_at ?? null).toBeNull();
  });

  test('a record another agent supersedes on its seat is retired, and the roster line holder is not', async () => {
    const where = place();
    const first = record(where.home, 'aaaaaaaaaaaa', 'worker');
    const second = record(where.home, 'aaaaaaaaaaaa', 'worker');
    upsertTeam(where.home, 'aaaaaaaaaaaa', {
      project: 'acme',
      session: 'acme',
      root: where.root,
      by: 'test',
      roster: [{ agent: first.id, seat: 'worker', role: 'implementer' }],
    });
    const ran = await run(where, ['prune', '--apply']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('superseded');
    expect(ran.out).not.toContain(first.id);
    expect(ran.out).toContain(second.id);
    expect(getAgent(where.home, first.id)?.lifecycle).toBe('stopped');
    expect(getAgent(where.home, second.id)?.lifecycle).toBe('retired');
  });

  test('a record a roster names is not listed at all', async () => {
    const where = place();
    const worker = record(where.home, 'aaaaaaaaaaaa', 'worker');
    upsertTeam(where.home, 'aaaaaaaaaaaa', {
      project: 'acme',
      session: 'acme',
      root: where.root,
      by: 'test',
      roster: [{ agent: worker.id, seat: 'worker', role: 'implementer' }],
    });
    const ran = await run(where, ['prune']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('no agent record stands without a roster line');
    expect(ran.out).not.toContain(worker.id);
  });

  test('a record whose team the registry no longer holds is listed and never retired', async () => {
    const where = place();
    const gone = record(where.home, 'ffffffffffff', 'ghost');
    const ran = await run(where, ['prune', '--apply']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('unregistered');
    expect(ran.out).toContain('none to retire');
    const after = getAgent(where.home, gone.id);
    expect(after?.lifecycle).toBe('stopped');
    expect(after?.orphaned_at ?? null).toBeNull();
  });

  test("a team whose configuration cannot be read declares nothing, so its records are left alone", async () => {
    const where = place(null);
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    const ran = await run(where, ['prune', '--apply']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('unverified');
    expect(ran.out).toContain('none to retire');
    const after = getAgent(where.home, ghost.id);
    expect(after?.lifecycle).toBe('stopped');
    expect(after?.orphaned_at ?? null).toBeNull();
  });

  test('--apply by a caller who is not the owner is refused and writes nothing', async () => {
    const where = place();
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    const detachedRan = await run(where, ['prune', '--apply'], detached);
    expect(detachedRan.code).toBe(1);
    expect(detachedRan.err).toContain('only the owner runs this');
    const seatRan = await run(where, ['prune', '--apply'], seatCaller);
    expect(seatRan.code).toBe(1);
    expect(seatRan.err).toContain('is not the owner');
    expect(getAgent(where.home, ghost.id)?.lifecycle).toBe('stopped');
    expect(getAgent(where.home, ghost.id)?.orphaned_at ?? null).toBeNull();
  });

  test('a seat caller reads the dry run', async () => {
    const where = place();
    const team = teamRecord(where);
    record(where.home, team, 'ghost');
    const ran = await run(where, ['prune'], seatCaller);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('1 record to retire');
  });

  test('an unreadable team registry refuses before anything is listed', async () => {
    const where = place();
    mkdirSync(join(where.home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(where.home), 'teams: [\n');
    const ran = await run(where, ['prune']);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('teams.yaml');
  });

  test('the invocation must name prune and nothing else', async () => {
    const where = place();
    const missing = await run(where, []);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('a subcommand is required');
    const unknown = await run(where, ['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown subcommand "nope"');
    const extra = await run(where, ['prune', 'ghost']);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('unexpected "ghost"');
  });

  test('--apply reports a record it could not retire and leaves it as it was', async () => {
    const where = place();
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    chmodSync(agentsDir(where.home), 0o555);
    let ran: Ran;
    try {
      ran = await run(where, ['prune', '--apply']);
    } finally {
      chmodSync(agentsDir(where.home), 0o755);
    }
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('1 record could not be retired');
    const after = getAgent(where.home, ghost.id);
    expect(after?.lifecycle).toBe('stopped');
    expect(after?.orphaned_at ?? null).toBeNull();
  });

  test('--json publishes the plan, each record and its counts', async () => {
    const where = place();
    const team = teamRecord(where);
    const ghost = record(where.home, team, 'ghost');
    record(where.home, team, 'worker');
    const ran = await run(where, ['prune', '--json']);
    expect(ran.code).toBe(1);
    const doc = jsonOf(ran);
    expect(doc.format).toBe(1);
    expect(doc.apply).toBe(false);
    const bySeat = new Map(doc.records.map((one) => [one.seat, one]));
    expect([...bySeat.keys()].sort()).toEqual(['ghost', 'worker']);
    expect(bySeat.get('ghost')).toMatchObject({
      id: ghost.id, team, project: 'acme', state: 'orphaned', action: 'retire', lifecycle: 'stopped', orphaned_at: null,
    });
    expect(bySeat.get('worker')).toMatchObject({ state: 'declared', action: 'none' });
    expect(doc.counts).toMatchObject({ listed: 2, orphaned: 1, declared: 1, to_retire: 1, retired: 0, failed: 0 });
  });

  test('--json --apply reports what was retired', async () => {
    const where = place();
    const team = teamRecord(where);
    record(where.home, team, 'ghost');
    const ran = await run(where, ['prune', '--apply', '--json']);
    expect(ran.code).toBe(0);
    const doc = jsonOf(ran);
    expect(doc.apply).toBe(true);
    expect(doc.records[0]).toMatchObject({ state: 'orphaned', action: 'retire', orphaned_at: NOW.toISOString(), lifecycle: 'retired' });
    expect(doc.counts).toMatchObject({ listed: 1, to_retire: 1, retired: 1, failed: 0 });
  });
});
