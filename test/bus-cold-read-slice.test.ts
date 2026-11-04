// Cold reads over large retained bus logs, on the real paths a daemon uses at start.
//
// Three scenes. (1) A caught-up read after one appended record parses and verifies only the bytes
// after the last digest mark, and returns exactly the records an independent full read of the
// same bytes returns. (2) The presence publisher's first pass over a large retained log publishes
// 64 transitions without re-reading the files for every new key: the one-pass record-id-to-offset
// index reads the retained bytes once, then answers each new key from its own lines. (3) Three
// checkouts with large retained logs start one machine daemon; a health probe in its own process
// keeps asking at the product's own 500 ms budget and must be answered throughout the start,
// because the first reconcile pass yields between slices and between checkouts. The bus's
// first-pass rows reach their settled state afterwards.
//
// Every world is synthetic: a temporary home, checkout and team file, no live session, credential
// file, seat or pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, EVENT_DOMAIN, eventLogPath, readEvents, type EventReadResult } from '../src/bus/log.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import { daemonSocketPath, daemonStatePath } from '../src/daemon/paths.ts';
import { PRESENCE_STATE_OF, presenceId, type PresenceEvent } from '../src/daemon/presence/contract.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { createPresencePublisher, presenceRecordIdOf } from '../src/daemon/presence/publish.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { STATE_FILE } from '../src/state.ts';
import { messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';

const PROJECT = 'acme';
const SESSION = 'acme-dev';
const SEAT = 'worker-1';
/** Recent past: the presence ingester refuses a staged record stamped too far ahead of its clock. */
const AT = new Date(Date.now() - 30 * 60_000).toISOString();

const TEAM_TEXT = `format: 1
entity: floor
project: ${PROJECT}
session: ${SESSION}
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: ${SEAT}
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type Root = { root: string; dir: string };
type World = { base: string; home: string; roots: Root[] };

let bases: string[] = [];
let daemons: MachineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    try { await daemon.close(); } catch { /* the scene already closed it */ }
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function makeWorld(lineCounts: number[], name: string): World {
  const base = realpathSync(mkdtempSync(`/private/tmp/talos-${name}-`));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const world: World = { base, home, roots: [] };
  lineCounts.forEach((lines, index) => {
    world.roots.push(addRoot(world, `r${String(index + 1)}`, lines));
  });
  return world;
}

/** One more checkout in the same world, sharing its home and therefore its message key. */
function addRoot(world: World, name: string, lines: number): Root {
  const root = join(world.base, name);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(dir, 'team.yaml'), TEAM_TEXT);
  const validated = validateTeamFile(TEAM_TEXT);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  upsertTeam(world.home, teamIdOf(root), {
    project: PROJECT,
    entity: 'floor',
    session: SESSION,
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  fillLog(world.home, root, lines);
  return { root, dir };
}

/** Writes `lines` retained, validly signed records into one checkout's log. The first record goes
 *  through the real append (it creates the store ladder and the message key); the rest are signed
 *  and written as one block so the fixture does not spend its time in 20,000 appends. */
function fillLog(home: string, root: string, lines: number): void {
  const first = appendEvent(PROJECT, root, home, {
    ts: AT, kind: 'seat.working', session: SESSION, record_id: 'r-1', seat: SEAT,
  }, { retain: false });
  if (!first.ok) throw new Error(first.reason);
  const key = messageKeyOf(home);
  const reason = 'x'.repeat(170);
  const block: string[] = [];
  for (let seq = 2; seq <= lines; seq += 1) {
    const payload = {
      v: 1, seq, ts: AT, kind: 'seat.working', session: SESSION, record_id: `r-${String(seq)}`, seat: SEAT, reason,
    };
    block.push(JSON.stringify({ payload, signature: signDomain(EVENT_DOMAIN, payload as unknown as Json, key) }));
  }
  appendFileSync(eventLogPath(PROJECT, root, home), `${block.join('\n')}\n`);
}

function ok(result: EventReadResult): Extract<EventReadResult, { ok: true }> {
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** The payloads of a read, in order: the content two independent reads must agree on. */
function payloads(result: Extract<EventReadResult, { ok: true }>): string[] {
  return result.events.map((record) => JSON.stringify(record.payload));
}

describe('a caught-up read', () => {
  const LINES = 20_000;

  test('reads only what moved, keeps exactly the full read\'s records, and re-checks bytes whose stamps were put back', async () => {
    const world = makeWorld([LINES], 'caught-up');
    const root = world.roots[0]!.root;
    const logPath = eventLogPath(PROJECT, root, world.home);

    const cold = ok(readEvents(PROJECT, root, world.home));
    expect(cold.full).toBe(true);
    expect(cold.checked).toBe(LINES);
    expect(cold.events).toHaveLength(LINES);

    // Nothing moved: the stamps the last read saw answer the next one without touching the log.
    const quietBegan = performance.now();
    const quiet = ok(readEvents(PROJECT, root, world.home));
    const quietMs = performance.now() - quietBegan;
    expect(quiet.full).toBe(false);
    expect(quiet.checked).toBe(0);
    expect(quiet.events).toHaveLength(LINES);
    // The unchanged read answers from memory. Parsing and hashing every retained line again, as
    // the unscaled scan does, takes about 40 ms for this log on this host before any other work.
    expect(quietMs).toBeLessThan(20);

    const appended = appendEvent(PROJECT, root, world.home, {
      ts: AT, kind: 'message.arrived', session: SESSION, record_id: 'r-append-1',
    });
    if (!appended.ok) throw new Error(appended.reason);
    expect(appended.duplicate).toBe(false);

    const caught = ok(readEvents(PROJECT, root, world.home));
    expect(caught.full).toBe(false);
    expect(caught.checked).toBe(1);
    expect(caught.unverified).toBe(0);
    expect(caught.events).toHaveLength(LINES + 1);
    expect(caught.newestSeq).toBe(LINES + 1);
    expect(caught.events[LINES]!.payload.record_id).toBe('r-append-1');

    // The same bytes, read cold in an independent store in the same world (same message key) with
    // no checkpoint: a full parse and verification of every line. Its records must be exactly the
    // caught-up read's records.
    const copy = addRoot(world, 'copy', 10);
    writeFileSync(
      eventLogPath(PROJECT, copy.root, world.home),
      readFileSync(logPath),
    );
    const full = ok(readEvents(PROJECT, copy.root, world.home));
    expect(full.full).toBe(true);
    expect(full.unverified).toBe(0);
    expect(payloads(full)).toEqual(payloads(caught));

    // The sliced read the daemon drives returns the same records as the blocking one.
    const logModule = await import('../src/bus/log.ts') as Record<string, unknown>;
    const slicedRead = logModule.readEventsSliced;
    if (typeof slicedRead !== 'function') throw new Error('the sliced read is missing');
    const sliced = ok(await (slicedRead as (
      project: string, root: string, home: string, options?: { kept?: number },
    ) => Promise<EventReadResult>)(PROJECT, root, world.home));
    expect(sliced.full).toBe(false);
    expect(payloads(sliced)).toEqual(payloads(caught));

    // Same inode, same size, modification time put back within a microsecond: only the inode
    // change time moved. The read must not answer from memory; it re-hashes the retained bytes
    // and reports the changed record as unverified instead of returning its old verified answer.
    const before = statSync(logPath);
    const text = readFileSync(logPath, 'utf8');
    const pad = 'x'.repeat(170);
    const spot = text.indexOf(pad);
    if (spot < 0) throw new Error('the fixture log holds no padded record');
    const rewritten = `${text.slice(0, spot + pad.length - 1)}y${text.slice(spot + pad.length)}`;
    expect(rewritten).toHaveLength(text.length);
    writeFileSync(logPath, rewritten);
    utimesSync(logPath, before.atimeMs / 1000, before.mtimeMs / 1000);
    const after = statSync(logPath);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(0.001);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    const caughtRewrite = ok(readEvents(PROJECT, root, world.home));
    expect(caughtRewrite.full).toBe(true);
    expect(caughtRewrite.unverified).toBe(1);
    expect(caughtRewrite.events).toHaveLength(LINES);
  }, 30_000);
});

describe('the presence publisher over a large retained bus log', () => {
  const LINES = 20_000;
  const TRANSITIONS = 64;
  const BINDING = 'prs_0123456789ab';

  test('one pass over the retained bytes publishes every transition, with the same content a replay dedupes', async () => {
    const world = makeWorld([LINES], 'publisher');
    const root = world.roots[0]!;
    const statePath = join(root.dir, STATE_FILE);
    writeFileSync(statePath, JSON.stringify({
      format: 1,
      sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', presence_binding: BINDING } }, worktrees: {} } },
    }));
    // The ingester's stat cache follows the record's mtime; a fixed recent stamp is enough here.
    const stamp = new Date(1700000000000 + 1_000);
    utimesSync(statePath, stamp, stamp);

    const ingester = createPresenceIngester({ stateDir: root.dir, session: SESSION });
    let staged: Array<{ id: string; ts: string; event: PresenceEvent; seq: number }> = [];
    try {
      const phases: PresenceEvent[] = ['turn-start', 'human-wait', 'turn-end', 'session-end'];
      staged = [];
      for (let index = 1; index <= TRANSITIONS; index += 1) {
        const at = Date.parse(AT) + index * 100;
        const ts = new Date(at).toISOString();
        const id = presenceId(ts, index.toString(16).padStart(8, '0'));
        if (id === null) throw new Error('the fixture minted an invalid presence id');
        const result = stagePresenceRecord(root.dir, {
          session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-hook',
          event: phases[index % phases.length]!, ts, id,
        });
        if (result.kind !== 'staged') throw new Error(result.why);
        staged.push({ id, ts, event: phases[index % phases.length]!, seq: index });
      }
      const ingest = await ingester.step();
      expect(ingest.ingested).toHaveLength(TRANSITIONS);
      expect(ingest.errors).toEqual([]);
    } finally {
      await ingester.close();
    }

    const logPath = eventLogPath(PROJECT, root.root, world.home);
    const retainedBytes = statSync(logPath).size;
    const publisher = createPresencePublisher({
      stateDir: root.dir, session: SESSION, project: PROJECT, root: root.root, home: world.home,
    });

    // The read-count witness the append index keeps: one pass over the retained bytes plus the
    // one line each new key can start at. A pass that re-read the files per key would count its
    // whole size 64 times.
    const logModule = await import('../src/bus/log.ts') as Record<string, unknown>;
    const counters = logModule as {
      appendIndexReads?: () => { files: number; lines: number; bytes: number };
      resetAppendIndexReads?: () => void;
    };
    counters.resetAppendIndexReads?.();

    const began = performance.now();
    const step = await publisher(new Date(Date.parse(AT) + 1_000_000));
    const elapsed = performance.now() - began;
    expect(step.failed).toBeNull();
    expect(step.seats).toHaveLength(1);
    const seat = step.seats[0]!;
    expect(seat.read).toBe(TRANSITIONS);
    expect(seat.published).toBe(TRANSITIONS);
    expect(seat.duplicate).toBe(0);
    expect(seat.skipped).toBe(0);
    expect(seat.failure).toBeNull();
    expect(seat.cursor).toBe(TRANSITIONS);
    // The ordinary append-per-transition path takes about half a second for this log on the
    // unscaled scan; one pass is a few tens of milliseconds. A bound wide enough for a loaded
    // host still separates the two.
    expect(elapsed).toBeLessThan(300);

    if (typeof counters.appendIndexReads !== 'function') {
      throw new Error('the append index does not report its reads');
    }
    const reads = counters.appendIndexReads();
    expect(reads.bytes).toBeGreaterThanOrEqual(retainedBytes);
    expect(reads.bytes).toBeLessThan(retainedBytes * 1.1);
    expect(reads.files).toBeLessThanOrEqual(TRANSITIONS + 1);

    // Every published record carries exactly the fields the contract names for its transition,
    // in sequence order, under its deterministic record id.
    const read = ok(readEvents(PROJECT, root.root, world.home));
    expect(read.full).toBe(true);
    expect(read.unverified).toBe(0);
    expect(read.events).toHaveLength(LINES + TRANSITIONS);
    for (const transition of staged) {
      const record = read.events[LINES + transition.seq - 1]!;
      const payload = record.payload;
      expect(payload.seq).toBe(LINES + transition.seq);
      expect(payload.ts).toBe(transition.ts);
      expect(payload.kind).toBe('presence.changed');
      expect(payload.session).toBe(SESSION);
      expect(payload.seat).toBe(SEAT);
      expect(payload.presence_state).toBe(PRESENCE_STATE_OF[transition.event]);
      expect(payload.presence_event).toBe(transition.event);
      expect(payload.presence_source).toBe('runtime-hook');
      expect(payload.presence_binding).toBe(BINDING);
      expect(payload.presence_event_id).toBe(transition.id);
      expect(payload.presence_seq).toBe(transition.seq);
      expect(payload.record_id).toBe(presenceRecordIdOf(SEAT, { binding: BINDING, seq: transition.seq, id: transition.id }));
      expect(Number.isFinite(Date.parse(payload.presence_observed_at ?? ''))).toBe(true);
    }

    // A replay from an empty cursor answers duplicate for every transition and writes nothing.
    const replayPublisher = createPresencePublisher({
      stateDir: root.dir, session: SESSION, project: PROJECT, root: root.root, home: world.home,
    });
    const sizeAfterPublish = statSync(logPath).size;
    const replay = await replayPublisher(new Date(Date.parse(AT) + 2_000_000));
    const replaySeat = replay.seats[0]!;
    expect(replaySeat.published).toBe(0);
    expect(replaySeat.duplicate).toBe(TRANSITIONS);
    expect(replaySeat.failure).toBeNull();
    expect(statSync(logPath).size).toBe(sizeAfterPublish);
  }, 60_000);
});

describe('three checkouts with large retained logs start under one daemon', () => {
  /** 86,000 signed records: the named 38.2 MB root, the size the original gate measured. */
  const LINES = 86_000;

  test('a health probe at the product budget is answered throughout the cold start', async () => {
    const world = makeWorld([LINES, LINES, LINES], 'cold-start');
    const socketPath = daemonSocketPath(world.home);
    const readyPath = join(world.base, 'probe.ready');
    const stopPath = join(world.base, 'probe.stop');
    const childPath = fileURLToPath(new URL('./fixtures/cold-read-probe-child.ts', import.meta.url));
    const prober = Bun.spawn([process.execPath, childPath, socketPath, readyPath, '25000', stopPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait until the child is probing, so its window covers the whole start on every host.
    const readyBy = Date.now() + 10_000;
    while (!existsSync(readyPath)) {
      if (Date.now() > readyBy) throw new Error('the probe child never became ready');
      await new Promise((tick) => setTimeout(tick, 10));
    }

    const started = await startMachineDaemon({
      home: world.home,
      roots: world.roots.map((entry) => entry.root),
      version: '0.0.0-cold-read-scene',
      // A short beat: the daemon refreshes each bus row's first-pass progress on every state
      // write, so this is the cadence at which the settled pass becomes readable here.
      heartbeatMs: 250,
      presenceHosting: false,
      restoreSweep: false,
    });
    if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
    daemons.push(started.daemon);
    expect(started.daemon.roots.map((status) => status.bus)).toEqual(['serving', 'serving', 'serving']);

    // The background pass still finishes for every checkout after the start returned.
    type StateRow = { roots?: Array<{ firstPass?: { running?: boolean } }> };
    const deadline = Date.now() + 60_000;
    const settled = (): boolean => {
      let record: StateRow | null = null;
      try { record = JSON.parse(readFileSync(daemonStatePath(world.home), 'utf8')) as StateRow; } catch { return false; }
      const rows = record?.roots ?? [];
      return rows.length === world.roots.length
        && rows.every((row) => row.firstPass !== undefined && row.firstPass.running === false);
    };
    while (!settled()) {
      if (Date.now() > deadline) throw new Error('a first pass never settled');
      await new Promise((tick) => setTimeout(tick, 25));
    }
    // The probe window covered the start and the background pass; it can end now.
    writeFileSync(stopPath, '');

    const stdout = await new Response(prober.stdout).text();
    const stderr = await new Response(prober.stderr).text();
    const exit = await prober.exited;
    if (exit !== 0) throw new Error(`the probe child failed (${String(exit)}): ${stdout}${stderr}`);

    const probes: Array<{ at: number; kind: string; reason: string | null; ms: number }> = [];
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('PROBE ')) continue;
      const value = JSON.parse(line.slice('PROBE '.length)) as Record<string, unknown>;
      if (value.done !== undefined) continue;
      probes.push({
        at: Number(value.at), kind: String(value.kind),
        reason: value.reason === null || value.reason === undefined ? null : String(value.reason),
        ms: Number(value.ms),
      });
    }
    const answered = probes.filter((probe) => probe.kind === 'answered');
    // A dial that connected and then waited out the budget is a held daemon loop, never a start
    // that has not bound yet: before the bind the dial fails at once.
    const held = probes.filter((probe) => probe.kind === 'unanswered' && probe.reason === 'timeout');
    expect(held.map((probe) => `+${String(probe.at)} ms waited ${String(probe.ms)} ms`)).toEqual([]);
    expect(answered.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
