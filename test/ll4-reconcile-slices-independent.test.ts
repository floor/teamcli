// Independent coverage for LL4: the reconcile pass in slices.
//
// The sliced driver must reach the same result and the same event log as the unsliced pass over
// every record source a store holds — signed drops and receipts, a mailbox message and its
// receipt, a pending marker, refused files and history outcomes. Two passes on one event loop
// must share the 2 ms slice budget rather than stacking it, and both must make progress. A
// declaration change between two passes must orphan the removed seat, and a seat that appears
// in the registry without a declaration must be marked on the pass that sees it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, type SignedEventRecord } from '../src/bus/log.ts';
import {
  createReconcileState,
  DEFAULT_RECONCILE_SLICE_MS,
  reconcilePass,
  reconcilePassAsync,
  type ReconcileResult,
} from '../src/bus/reconcile.ts';
import { plantMessage, receiptFile } from '../src/commands/messages.ts';
import { TEAM_FILE } from '../src/file/load.ts';
import { readTeamConfig, TEAM_CONFIG_SOURCE_ENV } from '../src/file/team-config.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import { readAgents, registerAgent } from '../src/registry/agents.ts';
import { registerDeclaredSeat } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { appendHistory } from '../src/send/history.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf, RECEIPT_DOMAIN, signDomain } from '../src/store/keys.ts';

const PROJECT = 'slices';
const TS = '2026-11-05T00:00:00.000Z';
const LATER = '2026-11-05T02:00:00.000Z';
const DAY = 24 * 60 * 60;

const teamYaml = (withWorker: boolean): string => `format: 1
project: ${PROJECT}
coordinator: lead
operator: ${withWorker ? 'worker' : 'lead'}
session: ${PROJECT}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
${withWorker
    ? `  - role: worker
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`
    : ''}`;

type World = { base: string; root: string; home: string };
const bases: string[] = [];
// The fixture team lives in a registry record under the test home; an inherited source override
// would send the reader after another store, so every test runs with it unset.
const sourceEnv = process.env[TEAM_CONFIG_SOURCE_ENV];

beforeEach(() => {
  delete process.env[TEAM_CONFIG_SOURCE_ENV];
});

afterEach(() => {
  if (sourceEnv === undefined) delete process.env[TEAM_CONFIG_SOURCE_ENV];
  else process.env[TEAM_CONFIG_SOURCE_ENV] = sourceEnv;
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function world(withWorker = true): World {
  const short = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  const base = realpathSync(mkdtempSync(join(short, 'team-ll4-independent-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const wrote = writeTeamText(join(root, TEAM_FILE), teamYaml(withWorker), {
    home,
    source: 'registry',
    command: 'init',
    create: true,
  });
  if (!wrote.ok) throw new Error(`the fixture team file was not written: ${JSON.stringify(wrote.errors)}`);
  messageKeyOf(home);
  return { base, root, home };
}

function seedSeatRecords(at: World): void {
  const loaded = readTeamConfig(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('the fixture team file did not load');
  for (const seat of loaded.team.seats) {
    const registered = registerDeclaredSeat({ home: at.home, team: loaded.team, root: at.root, by: 'owner' }, seat);
    if ('note' in registered) throw new Error(`the fixture seat was not registered: ${registered.note}`);
  }
}

function dropDirOf(at: World, seat = 'worker'): string {
  return join(at.root, '.agents', 'send-drops', PROJECT, seat);
}

function writeSignedDrop(at: World, id: string, at2: string): void {
  const dir = dropDirOf(at);
  mkdirSync(dir, { recursive: true });
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'worker',
    to_id: null,
    root: at.root,
    session: PROJECT,
    at: at2,
    body: `message ${id}`,
    from: 'lead',
    from_id: null,
    rule: 'synthetic admission',
    thread: id,
  };
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(signRecord(payload, at.home))}\n`);
}

function seedStore(at: World): void {
  const first = appendEvent(PROJECT, at.root, at.home, {
    ts: TS,
    kind: 'message.arrived',
    session: PROJECT,
    record_id: 'seeded-1',
    from: 'lead',
    to: 'worker',
  });
  if (!first.ok) throw new Error(`the fixture event was not appended: ${first.reason}`);

  writeSignedDrop(at, 'drop-a', '2026-11-05T00:01:00.000Z');
  writeSignedDrop(at, 'drop-b', '2026-11-05T00:02:00.000Z');
  const dir = dropDirOf(at);
  writeFileSync(join(dir, 'drop-a.delivered.json'), '{"ok":true}');
  writeFileSync(join(dir, 'drop-a.read.json'), '{"ok":true}');
  writeFileSync(
    join(dir, 'drop-b.pending'),
    JSON.stringify({ id: 'drop-b', from: 'lead', to: 'worker', body: 'held', ts: TS, tries: 1, leg: 'drop' }),
  );
  writeFileSync(join(dir, 'bad-unsigned.json'), '{"not":"signed"}');

  plantMessage(at.home, at.root, 'worker', 'mbox-1', {
    kind: 'message',
    id: 'mbox-1',
    from: 'lead',
    to: 'worker',
    root: at.root,
    session: PROJECT,
    at: '2026-11-05T00:03:00.000Z',
    body: 'mailbox message',
  });
  const receiptPayload = {
    kind: 'receipt' as const,
    id: 'mbox-1',
    to: 'worker',
    root: at.root,
    session: PROJECT,
    at: '2026-11-05T00:04:00.000Z',
  };
  writeFileSync(
    receiptFile(at.root, 'worker', 'mbox-1'),
    JSON.stringify({ payload: receiptPayload, signature: signDomain(RECEIPT_DOMAIN, receiptPayload, messageKeyOf(at.home)) }),
  );

  appendHistory(PROJECT, at.root, at.home, {
    ts: '2026-11-05T00:05:00.000Z',
    from: 'lead',
    to: 'worker',
    body: 'message drop-a',
    id: 'drop-a',
    outcome: 'answered',
  });

  updateState(join(at.root, '.agents'), (state) => {
    (state.sessions[PROJECT] ??= emptySession()).seats['worker'] = {
      stage: 'ready',
      last_active: '2026-11-05T00:06:00.000Z',
    };
  });
}

function summaryOf(result: ReconcileResult): string[] {
  if (!result.ok) throw new Error(result.reason);
  return result.raised.map(
    (record: SignedEventRecord) =>
      `${record.payload.kind}:${record.payload.record_id}:${record.payload.seat ?? ''}`,
  );
}

function optionsFor(at: World) {
  return {
    project: PROJECT,
    root: at.root,
    session: PROJECT,
    home: at.home,
    now: new Date(LATER),
    maxBytes: 8_000_000,
    kept: 13,
    retentionSeconds: 30 * DAY,
  };
}

function logSummary(at: World): string[] {
  const read = readEvents(PROJECT, at.root, at.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.map((event) => `${event.payload.kind}:${event.payload.record_id}`);
}

describe('LL4: the sliced pass reaches the unsliced result', () => {
  test('parity over drops, receipts, mailbox, pending, refusals and history, cold then warm', async () => {
    const syncWorld = world();
    const asyncWorld = world();
    seedStore(syncWorld);
    seedStore(asyncWorld);

    const syncState = createReconcileState();
    const asyncState = createReconcileState();
    const syncRefused: string[] = [];
    const asyncRefused: string[] = [];

    const syncCold = reconcilePass({ ...optionsFor(syncWorld), state: syncState, onRefused: (r) => syncRefused.push(r.where) });
    const asyncCold = await reconcilePassAsync({
      ...optionsFor(asyncWorld),
      state: asyncState,
      sliceMs: 0,
      onRefused: (r) => asyncRefused.push(r.where),
    });

    expect(summaryOf(asyncCold)).toEqual(summaryOf(syncCold));
    expect(asyncRefused).toEqual(syncRefused);
    expect(asyncRefused).toHaveLength(1);
    expect(syncCold.ok && asyncCold.ok).toBe(true);
    if (syncCold.ok && asyncCold.ok) {
      expect(asyncCold.checked).toBe(syncCold.checked);
      expect(asyncCold.full).toBe(syncCold.full);
    }
    expect(asyncState.stats.filesRead).toBe(syncState.stats.filesRead);
    expect(asyncState.stats.verifies).toBe(syncState.stats.verifies);
    // The sliced driver really yielded: sliceMs 0 gives the loop a turn at every step.
    expect(asyncState.stats.yields).toBeGreaterThan(0);

    // Every source the store holds is in the raised set, not just the signed drops.
    const raised = summaryOf(syncCold);
    expect(raised).toContain('message.arrived:drop-a:');
    expect(raised).toContain('message.arrived:drop-b:');
    expect(raised).toContain('message.arrived:mbox-1:');
    expect(raised.some((line) => line.startsWith('message.held:drop-b'))).toBe(true);
    expect(raised.some((line) => line.startsWith('message.replied:drop-a'))).toBe(true);
    expect(raised.some((line) => line.startsWith('message.read:drop-a'))).toBe(true);

    // A warm second pass reuses the caches and answers the same result.
    const syncWarm = reconcilePass({ ...optionsFor(syncWorld), state: syncState });
    const asyncWarm = await reconcilePassAsync({ ...optionsFor(asyncWorld), state: asyncState, sliceMs: 2 });
    expect(summaryOf(asyncWarm)).toEqual(summaryOf(syncWarm));
    expect(summaryOf(asyncWarm)).toEqual([]);
    expect(asyncState.stats.filesRead).toBe(0);
    expect(asyncState.stats.filesReused).toBe(syncState.stats.filesReused);

    expect(logSummary(asyncWorld)).toEqual(logSummary(syncWorld));
  }, 20_000);
});

describe('LL4: concurrent passes share the budget and each makes progress', () => {
  test('two passes on one event loop yield, finish, and serve a timer while they run', async () => {
    expect(DEFAULT_RECONCILE_SLICE_MS).toBe(2);
    const stores = [0, 1].map((index) => {
      const at = world();
      seedSeatRecords(at);
      const dir = dropDirOf(at);
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 2_000; i += 1) {
        writeFileSync(join(dir, `refused-${String(i).padStart(4, '0')}.json`), `{"id":"r${i}","body":"unsigned"}\n`);
      }
      for (let i = 0; i < 8; i += 1) {
        // Signed drops, so this pass has records to raise: a line already in the log is not a
        // record the pass raises.
        writeSignedDrop(at, `seeded-${String(index)}-${String(i)}`, `2026-11-05T00:0${String(i)}:00.000Z`);
      }
      return { at, state: createReconcileState() };
    });

    // No warm pass: both stores are reconciled cold on the same event loop, each with real
    // work to do, which is the case the shared budget exists for.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    let results: ReconcileResult[] = [];
    try {
      // Started together, so both are active on the same event loop while they run.
      const runs = stores.map((store) => reconcilePassAsync({ ...optionsFor(store.at), state: store.state }));
      results = await Promise.all(runs);
    } finally {
      clearInterval(timer);
    }

    expect(ticks).toBeGreaterThan(0);
    for (const [index, result] of results.entries()) {
      if (!result.ok) throw new Error(result.reason);
      // Each pass reached its own store and raised that store's events: neither starved the other.
      expect(result.raised.map((record) => record.payload.record_id)).toHaveLength(8);
      expect(result.raised.every((record) => record.payload.record_id.startsWith(`seeded-${String(index)}-`))).toBe(true);
      expect(stores[index]!.state.stats.yields).toBeGreaterThan(0);
      expect(stores[index]!.state.stats.passes).toBe(1);
    }
  }, 20_000);
});

describe('LL4: a declaration change between passes orphans the removed seat', () => {
  test('the removed seat is marked on the next pass, and a registry-only seat is marked too', () => {
    const at = world();
    seedSeatRecords(at);
    const state = createReconcileState();

    const first = reconcilePass({ ...optionsFor(at), state, now: new Date(TS) });
    expect(first.ok).toBe(true);
    expect(readAgents(at.home).every((agent) => agent.orphaned_at == null)).toBe(true);

    // The declaration drops the worker between the two passes.
    const rewrote = writeTeamText(join(at.root, TEAM_FILE), teamYaml(false), {
      home: at.home,
      source: 'registry',
      command: 'edit',
      now: () => new Date(LATER),
    });
    expect(rewrote).toEqual({ ok: true, target: 'registry' });

    const second = reconcilePass({ ...optionsFor(at), state, now: new Date(LATER) });
    expect(second.ok).toBe(true);
    const worker = readAgents(at.home).find((agent) => agent.reach.seat === 'worker');
    const lead = readAgents(at.home).find((agent) => agent.reach.seat === 'lead');
    expect(worker?.orphaned_at).toBe(LATER);
    expect(lead?.orphaned_at == null).toBe(true);

    // A seat that only the registry knows is marked on the pass that first sees it: the
    // stamp covers the agents directory, not only the declaration file.
    const registered = registerAgent(at.home, {
      name: 'late-seat',
      signing: { model: 'Claude Sonnet', version: '4.6', role: 'worker' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamIdOf(at.root), seat: 'late-seat', session: PROJECT, pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'registered',
      by: 'owner',
    });
    const third = reconcilePass({ ...optionsFor(at), state, now: new Date('2026-11-05T03:00:00.000Z') });
    expect(third.ok).toBe(true);
    const late = readAgents(at.home).find((agent) => agent.id === registered.id);
    expect(late?.orphaned_at).toBe('2026-11-05T03:00:00.000Z');
    // The seat removed earlier keeps the timestamp of the pass that marked it.
    expect(readAgents(at.home).find((agent) => agent.reach.seat === 'worker')?.orphaned_at).toBe(LATER);
  }, 20_000);
});
