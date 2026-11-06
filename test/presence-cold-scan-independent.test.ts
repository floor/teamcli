// Independent verification for `fix/presence-cold-scan`:
// 1. A three-root cold start of tens-of-MB fixture logs answers health probes at the 500 ms budget.
//    A timeout during the recorded startMachineDaemon window is startup. Once that call has
//    returned serving, every timeout is fatal. A blocking answer after that window stays fatal.
// 2. Every read line is still signature-verified (one bad line planted mid-log is refused as before).
// 3. A truncated or tampered log is refused (never served from a stale in-memory or on-disk checkpoint).
// 4. The append index never reports a record as appended that is not on disk.
// 5. Events appended during an async subscribe registration are delivered once.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendEvent,
  appendIndexReads,
  EVENT_DOMAIN,
  eventLogPath,
  readEvents,
  readEventsFromCursorSliced,
  readEventsSliced,
  resetAppendIndexReads,
  type EventReadResult,
  type SignedEventRecord,
} from '../src/bus/log.ts';
import {
  busSocket,
  encodeBusLine,
  parseBusAnswer,
  publishToBus,
  startBus,
  type BusAnswer,
  type BusHandle,
} from '../src/bus/server.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import { daemonSocketPath, daemonStatePath } from '../src/daemon/paths.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';
import { storePath } from '../src/store/store.ts';

const PROJECT = ' synth-proj'.trim();
const SESSION = 'synth-session';
const LEAD = 'coord-seat';
const WORKER = 'worker-1';
const AT = new Date(Date.now() - 20 * 60_000).toISOString();

const TEAM_YAML = `format: 1
entity: floor
project: ${PROJECT}
session: ${SESSION}
coordinator: ${LEAD}
operator: ${LEAD}
workspace:
  mode: shared
seats:
  - name: ${LEAD}
    role: coordinator
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: ${WORKER}
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type RootFixture = { root: string; dir: string };
type WorldFixture = { base: string; home: string; roots: RootFixture[] };

const tempBases: string[] = [];
const activeDaemons: MachineDaemon[] = [];
const activeBuses: BusHandle[] = [];

afterEach(async () => {
  for (const bus of activeBuses.splice(0)) {
    try {
      await bus.close();
    } catch {}
  }
  for (const daemon of activeDaemons.splice(0)) {
    try {
      await daemon.close();
    } catch {}
  }
  for (const base of tempBases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function createWorld(lineCounts: number[], label: string): WorldFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `presence-cold-scan-${label}-`)));
  tempBases.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const world: WorldFixture = { base, home, roots: [] };
  lineCounts.forEach((count, idx) => {
    world.roots.push(addCheckout(world, `root-${String(idx + 1)}`, count));
  });
  return world;
}

function addCheckout(world: WorldFixture, name: string, lines: number): RootFixture {
  const root = join(world.base, name);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(dir, 'team.yaml'), TEAM_YAML);
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  upsertTeam(world.home, teamIdOf(root), {
    project: PROJECT,
    entity: 'floor',
    session: SESSION,
    root,
    roster: [{ agent: 'agt_coord0000001', seat: LEAD, role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  if (lines > 0) {
    populateSignedLog(world.home, root, lines);
  }
  return { root, dir };
}

function populateSignedLog(home: string, root: string, totalLines: number): void {
  const first = appendEvent(
    PROJECT,
    root,
    home,
    {
      ts: AT,
      kind: 'seat.working',
      session: SESSION,
      record_id: 'rec-1',
      seat: WORKER,
    },
    { retain: false },
  );
  if (!first.ok) throw new Error(first.reason);
  if (totalLines <= 1) return;
  const key = messageKeyOf(home);
  const pad = 'p'.repeat(180);
  const logFile = eventLogPath(PROJECT, root, home);
  const batchSize = 5_000;
  for (let start = 2; start <= totalLines; start += batchSize) {
    const end = Math.min(totalLines, start + batchSize - 1);
    const chunk: string[] = [];
    for (let seq = start; seq <= end; seq += 1) {
      const payload = {
        v: 1 as const,
        seq,
        ts: AT,
        kind: 'seat.working' as const,
        session: SESSION,
        record_id: `rec-${String(seq)}`,
        seat: WORKER,
        reason: pad,
      };
      const signature = signDomain(EVENT_DOMAIN, payload as unknown as Json, key);
      chunk.push(JSON.stringify({ payload, signature }));
    }
    appendFileSync(logFile, `${chunk.join('\n')}\n`);
  }
}

function unwrapRead(res: EventReadResult): Extract<EventReadResult, { ok: true }> {
  if (!res.ok) throw new Error(res.reason);
  return res;
}

type ColdProbe = { at: number; epoch: number; kind: string; reason: string | null; ms: number };

function readColdProbes(stdout: string): ColdProbe[] {
  const probes: ColdProbe[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('PROBE ')) continue;
    const obj = JSON.parse(line.slice('PROBE '.length)) as Record<string, unknown>;
    if (obj.done !== undefined) continue;
    probes.push({
      at: Number(obj.at),
      epoch: Number(obj.epoch),
      kind: String(obj.kind),
      reason: obj.reason === null || obj.reason === undefined ? null : String(obj.reason),
      ms: Number(obj.ms),
    });
  }
  return probes;
}

/** Timeouts whose wait does not overlap the recorded startup window. A missing epoch fails closed. */
function timeoutsAfterServing(probes: ColdProbe[], startupBegan: number, startupEnded: number): ColdProbe[] {
  if (!(startupEnded > startupBegan)) throw new Error('the startup window was not recorded');
  return probes.filter((probe) => {
    if (probe.kind !== 'unanswered' || probe.reason !== 'timeout') return false;
    const duringStartup = Number.isFinite(probe.epoch) && Number.isFinite(probe.ms)
      && probe.epoch < startupEnded && probe.epoch + probe.ms > startupBegan;
    return !duringStartup;
  });
}

describe('fix/presence-cold-scan independent verification', () => {
  test('probe 1: three-root cold start of tens-of-MB fixture logs answers health probes within 500 ms throughout', async () => {
    // 50,000 signed records per root (~22.6 MB per root, ~67.8 MB across three roots).
    const LINES_PER_ROOT = 50_000;
    const world = createWorld([LINES_PER_ROOT, LINES_PER_ROOT, LINES_PER_ROOT], 'three-root-cold');
    for (const entry of world.roots) {
      const bytes = statSync(eventLogPath(PROJECT, entry.root, world.home)).size;
      expect(bytes).toBeGreaterThan(20_000_000);
    }

    const socketPath = daemonSocketPath(world.home);
    const readyPath = join(world.base, 'probe.ready');
    const stopPath = join(world.base, 'probe.stop');
    const childScript = fileURLToPath(new URL('./fixtures/cold-read-probe-child.ts', import.meta.url));
    const prober = Bun.spawn([process.execPath, childScript, socketPath, readyPath, '30000', stopPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const readyDeadline = Date.now() + 10_000;
    while (!existsSync(readyPath)) {
      if (Date.now() > readyDeadline) throw new Error('probe child did not become ready');
      await new Promise((r) => setTimeout(r, 10));
    }

    const epochNow = (): number => Math.round(performance.timeOrigin + performance.now());
    const startupBegan = epochNow();
    const started = await startMachineDaemon({
      home: world.home,
      roots: world.roots.map((r) => r.root),
      version: '0.0.0-probe-cold-scan',
      heartbeatMs: 200,
      presenceHosting: false,
      restoreSweep: false,
    });
    const startupEnded = epochNow();
    if (started.kind !== 'serving') throw new Error(`daemon failed to start: ${started.kind}`);
    activeDaemons.push(started.daemon);
    expect(started.daemon.roots.map((r) => r.bus)).toEqual(['serving', 'serving', 'serving']);

    type DaemonStateShape = {
      roots?: Array<{ firstPass?: { running?: boolean; scanned?: number; errors?: boolean } }>;
    };
    const settleDeadline = Date.now() + 60_000;
    let finalRows: NonNullable<DaemonStateShape['roots']> = [];
    while (true) {
      try {
        const parsed = JSON.parse(readFileSync(daemonStatePath(world.home), 'utf8')) as DaemonStateShape;
        const rows = parsed.roots ?? [];
        if (
          rows.length === 3 &&
          rows.every((row) => row.firstPass !== undefined && row.firstPass.running === false)
        ) {
          finalRows = rows;
          break;
        }
      } catch {}
      if (Date.now() > settleDeadline) throw new Error('daemon firstPass did not settle across all 3 roots');
      await new Promise((r) => setTimeout(r, 25));
    }

    writeFileSync(stopPath, '');
    const stdout = await new Response(prober.stdout).text();
    const stderr = await new Response(prober.stderr).text();
    const code = await prober.exited;
    if (code !== 0) throw new Error(`probe child exited ${String(code)}: ${stdout}${stderr}`);

    expect(finalRows.every((row) => row.firstPass?.errors === false)).toBe(true);

    const probes = readColdProbes(stdout);
    const fatal = timeoutsAfterServing(probes, startupBegan, startupEnded);
    expect(fatal.map((probe) => `+${String(probe.at)} ms waited ${String(probe.ms)} ms`)).toEqual([]);

    const answered = probes.filter((p) => p.kind === 'answered');
    expect(answered.length).toBeGreaterThanOrEqual(3);
    for (const ans of answered) {
      expect(ans.ms).toBeLessThanOrEqual(500);
    }
  }, 120_000);

  test('a blocking health answer after the startup window is fatal', async () => {
    // The demonstrated stall: the first two health answers block for 700 ms, past the 500 ms
    // budget. The startup window is already closed, so those timeouts stay fatal.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'presence-cold-scan-hold-')));
    tempBases.push(base);
    const socketPath = join(base, 'daemon.sock');
    const readyPath = join(base, 'probe.ready');
    const stopPath = join(base, 'probe.stop');
    let holds = 0;
    const server = createServer((socket) => {
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let parsed: { v?: unknown; id?: unknown };
        try {
          parsed = JSON.parse(line) as { v?: unknown; id?: unknown };
        } catch {
          socket.destroy();
          return;
        }
        holds += 1;
        if (holds <= 2) Bun.sleepSync(700);
        try {
          socket.end(`${JSON.stringify({ v: parsed.v, id: parsed.id, ok: true, health: { pid: process.pid } })}\n`);
        } catch {
          // The probe already gave up at its budget and closed the socket.
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    try {
      const epochNow = (): number => Math.round(performance.timeOrigin + performance.now());
      const startupBegan = epochNow() - 20;
      const startupEnded = epochNow() - 1;
      const childScript = fileURLToPath(new URL('./fixtures/cold-read-probe-child.ts', import.meta.url));
      const prober = Bun.spawn([process.execPath, childScript, socketPath, readyPath, '2500', stopPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const readyDeadline = Date.now() + 10_000;
      while (!existsSync(readyPath)) {
        if (Date.now() > readyDeadline) throw new Error('probe child did not become ready');
        await new Promise((r) => setTimeout(r, 10));
      }
      const code = await prober.exited;
      const stdout = await new Response(prober.stdout).text();
      const stderr = await new Response(prober.stderr).text();
      if (code !== 0) throw new Error(`probe child exited ${String(code)}: ${stdout}${stderr}`);
      const probes = readColdProbes(stdout);
      const fatal = timeoutsAfterServing(probes, startupBegan, startupEnded);
      expect(fatal.length).toBeGreaterThanOrEqual(2);
      for (const probe of fatal) expect(probe.ms).toBeGreaterThanOrEqual(500);
      expect(probes.some((probe) => probe.kind === 'answered')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  test('probe 2: every read line is signature-verified and a bad line planted mid-log is refused as before', async () => {
    const TOTAL = 4_500;
    const BAD_SEQ = 2_250;
    const world = createWorld([0], 'bad-mid-line');
    const root = world.roots[0]!.root;
    const logPath = eventLogPath(PROJECT, root, world.home);

    // Seed line 1 via appendEvent so store ladder & message key exist.
    populateSignedLog(world.home, root, TOTAL);

    // Replace line BAD_SEQ mid-log with a record whose signature does not verify.
    const rawLines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(rawLines).toHaveLength(TOTAL);
    const midParsed = JSON.parse(rawLines[BAD_SEQ - 1]!) as SignedEventRecord;
    expect(midParsed.payload.seq).toBe(BAD_SEQ);
    const badMidRecord: SignedEventRecord = {
      payload: { ...midParsed.payload, reason: 'forged-mid-log-payload' },
      signature: midParsed.signature,
    };
    rawLines[BAD_SEQ - 1] = JSON.stringify(badMidRecord);
    writeFileSync(logPath, `${rawLines.join('\n')}\n`);

    // 1. Cold synchronous read verifies every line and refuses the planted mid-log line.
    const cold = unwrapRead(readEvents(PROJECT, root, world.home));
    expect(cold.full).toBe(true);
    expect(cold.checked).toBe(TOTAL);
    expect(cold.unverified).toBe(1);
    expect(cold.events).toHaveLength(TOTAL - 1);
    expect(cold.events.some((e) => e.payload.seq === BAD_SEQ)).toBe(false);

    // Because unverified > 0, no verify-checkpoint.json may be written to disk.
    const checkpointFile = join(storePath(PROJECT, root, world.home), 'verify-checkpoint.json');
    expect(existsSync(checkpointFile)).toBe(false);

    // 2. Sliced async read and cursor read also refuse the planted mid-log line.
    const sliced = unwrapRead(await readEventsSliced(PROJECT, root, world.home));
    expect(sliced.unverified).toBe(1);
    expect(sliced.events).toHaveLength(TOTAL - 1);
    expect(sliced.events.some((e) => e.payload.seq === BAD_SEQ)).toBe(false);

    const fromCursor = await readEventsFromCursorSliced(PROJECT, root, world.home, 2_245);
    if (!fromCursor.ok || fromCursor.kind !== 'events') throw new Error('expected cursor events');
    expect(fromCursor.unverified).toBe(1);
    expect(fromCursor.events.some((e) => e.payload.seq === BAD_SEQ)).toBe(false);
    expect(fromCursor.events[0]!.payload.seq).toBe(2_246);
    expect(fromCursor.events.find((e) => e.payload.seq === 2_249)).toBeDefined();
    expect(fromCursor.events.find((e) => e.payload.seq === 2_251)).toBeDefined();
  }, 30_000);

  test('probe 3: a truncated or tampered log is refused and never served from a stale checkpoint', async () => {
    const TOTAL = 3_500;
    const world = createWorld([TOTAL], 'truncated-or-tampered');
    const root = world.roots[0]!.root;
    const logPath = eventLogPath(PROJECT, root, world.home);

    // First read builds both in-memory and on-disk checkpoints.
    const initial = unwrapRead(readEvents(PROJECT, root, world.home));
    expect(initial.full).toBe(true);
    expect(initial.checked).toBe(TOTAL);
    expect(initial.unverified).toBe(0);
    expect(initial.events).toHaveLength(TOTAL);
    const checkpointFile = join(storePath(PROJECT, root, world.home), 'verify-checkpoint.json');
    expect(existsSync(checkpointFile)).toBe(true);

    // 3a. In-place mid-log byte tamper with mtime/atime restored: checkpoint must invalidate and refuse the line.
    const cleanBytes = readFileSync(logPath, 'utf8');
    const cleanStat = statSync(logPath);
    const cleanLines = cleanBytes.trimEnd().split('\n');
    const targetIdx = 1_500;
    const targetLine = cleanLines[targetIdx]!;
    const tamperedLine = targetLine.replace('pppppppppp', 'qqqqqqqqqq');
    expect(tamperedLine).not.toBe(targetLine);
    expect(tamperedLine.length).toBe(targetLine.length);
    cleanLines[targetIdx] = tamperedLine;
    writeFileSync(logPath, `${cleanLines.join('\n')}\n`);
    utimesSync(logPath, cleanStat.atimeMs / 1000, cleanStat.mtimeMs / 1000);

    const afterTamper = unwrapRead(await readEventsSliced(PROJECT, root, world.home));
    expect(afterTamper.full).toBe(true);
    expect(afterTamper.checked).toBe(TOTAL);
    expect(afterTamper.unverified).toBe(1);
    expect(afterTamper.events).toHaveLength(TOTAL - 1);
    expect(afterTamper.events.some((e) => e.payload.seq === targetIdx + 1)).toBe(false);

    // Restore clean bytes and re-establish clean checkpoint.
    writeFileSync(logPath, cleanBytes);
    const restored = unwrapRead(readEvents(PROJECT, root, world.home));
    expect(restored.unverified).toBe(0);
    expect(restored.events).toHaveLength(TOTAL);

    // 3b. Truncate mid-line inside the last record: partial line must be refused as unverified.
    truncateSync(logPath, cleanBytes.length - 45);
    const afterPartialTruncate = unwrapRead(await readEventsSliced(PROJECT, root, world.home));
    expect(afterPartialTruncate.full).toBe(true);
    expect(afterPartialTruncate.unverified).toBe(1);
    expect(afterPartialTruncate.events).toHaveLength(TOTAL - 1);
    expect(afterPartialTruncate.newestSeq).toBe(TOTAL - 1);

    // 3c. Truncate 200 whole lines from the end: checkpoint covering TOTAL lines must not serve deleted tail records.
    const origLines = cleanBytes.trimEnd().split('\n');
    const keptCount = TOTAL - 200;
    writeFileSync(logPath, `${origLines.slice(0, keptCount).join('\n')}\n`);
    const afterWholeTruncate = unwrapRead(await readEventsSliced(PROJECT, root, world.home));
    expect(afterWholeTruncate.full).toBe(true);
    expect(afterWholeTruncate.checked).toBe(keptCount);
    expect(afterWholeTruncate.unverified).toBe(0);
    expect(afterWholeTruncate.events).toHaveLength(keptCount);
    expect(afterWholeTruncate.newestSeq).toBe(keptCount);
  }, 30_000);

  test('probe 4: the append index never reports a record as appended that is not on disk', () => {
    const INITIAL_LINES = 4_000;
    const world = createWorld([INITIAL_LINES], 'append-index');
    const root = world.roots[0]!.root;
    const logPath = eventLogPath(PROJECT, root, world.home);

    // 4a. An append that fails payload validation after index lookup never marks the key as present in duplicates.
    const failedAppend = appendEvent(PROJECT, root, world.home, {
      ts: 'not-a-valid-iso-date',
      kind: 'seat.working',
      session: SESSION,
      record_id: 'rec-never-written',
      seat: WORKER,
    });
    expect(failedAppend.ok).toBe(false);

    const retryValid = appendEvent(PROJECT, root, world.home, {
      ts: AT,
      kind: 'seat.working',
      session: SESSION,
      record_id: 'rec-never-written',
      seat: WORKER,
    });
    expect(retryValid.ok).toBe(true);
    if (!retryValid.ok) throw new Error(retryValid.reason);
    expect(retryValid.duplicate).toBe(false);
    expect(retryValid.record.payload.seq).toBe(INITIAL_LINES + 1);

    // 4b. A line on disk with a bad signature spelling the target record_id is never reported as an appended duplicate.
    const badOnDiskPayload = {
      v: 1,
      seq: INITIAL_LINES + 2,
      ts: AT,
      kind: 'seat.working',
      session: SESSION,
      record_id: 'rec-unverified-on-disk',
      seat: WORKER,
    };
    appendFileSync(
      logPath,
      `${JSON.stringify({ payload: badOnDiskPayload, signature: retryValid.record.signature })}\n`,
    );

    const overBadLine = appendEvent(PROJECT, root, world.home, {
      ts: AT,
      kind: 'seat.working',
      session: SESSION,
      record_id: 'rec-unverified-on-disk',
      seat: WORKER,
    });
    expect(overBadLine.ok).toBe(true);
    if (!overBadLine.ok) throw new Error(overBadLine.reason);
    expect(overBadLine.duplicate).toBe(false);
    expect(overBadLine.record.payload.seq).toBe(INITIAL_LINES + 2);

    // 4c. If a previously appended record is truncated off disk, the append index never reports it as still appended.
    const sizeBeforeEphemeral = statSync(logPath).size;
    const ephemeralFirst = appendEvent(PROJECT, root, world.home, {
      ts: AT,
      kind: 'message.arrived',
      session: SESSION,
      record_id: 'rec-ephemeral',
    });
    if (!ephemeralFirst.ok) throw new Error(ephemeralFirst.reason);
    expect(ephemeralFirst.duplicate).toBe(false);

    // Confirm duplicate detection while the record IS on disk.
    const ephemeralDup = appendEvent(PROJECT, root, world.home, {
      ts: AT,
      kind: 'message.arrived',
      session: SESSION,
      record_id: 'rec-ephemeral',
    });
    if (!ephemeralDup.ok) throw new Error(ephemeralDup.reason);
    expect(ephemeralDup.duplicate).toBe(true);

    // Truncate `rec-ephemeral` off disk so it is no longer on disk.
    truncateSync(logPath, sizeBeforeEphemeral);
    const readAfterTruncate = unwrapRead(readEvents(PROJECT, root, world.home));
    expect(readAfterTruncate.events.some((e) => e.payload.record_id === 'rec-ephemeral')).toBe(false);

    // Appending `rec-ephemeral` now must write it to disk (`duplicate: false`), never report it as already appended.
    const ephemeralReappended = appendEvent(PROJECT, root, world.home, {
      ts: AT,
      kind: 'message.arrived',
      session: SESSION,
      record_id: 'rec-ephemeral',
    });
    if (!ephemeralReappended.ok) throw new Error(ephemeralReappended.reason);
    expect(ephemeralReappended.duplicate).toBe(false);
    const readAfterReappend = unwrapRead(readEvents(PROJECT, root, world.home));
    expect(readAfterReappend.events.some((e) => e.payload.record_id === 'rec-ephemeral')).toBe(true);

    // 4d. The fixture is past the segment bound, so the first append seals it.
    // Later appends read the open segment once. The counter is that pass, not
    // another read of the sealed log.
    const world2 = createWorld([6_000], 'append-one-pass');
    const root2 = world2.roots[0]!.root;
    const log2Path = eventLogPath(PROJECT, root2, world2.home);
    const sealedBytes = statSync(log2Path).size;
    resetAppendIndexReads();
    for (let i = 1; i <= 25; i += 1) {
      const res = appendEvent(PROJECT, root2, world2.home, {
        ts: AT,
        kind: 'seat.working',
        session: SESSION,
        record_id: `rec-fresh-${String(i)}`,
        seat: WORKER,
      });
      if (!res.ok) throw new Error(res.reason);
      expect(res.duplicate).toBe(false);
    }
    const openBytes = statSync(log2Path).size;
    const stats = appendIndexReads();
    expect(openBytes).toBeLessThan(sealedBytes);
    expect(stats.bytes).toBeGreaterThan(openBytes / 2);
    expect(stats.bytes).toBeLessThan(openBytes * 1.15);
  }, 30_000);

  test('probe 5: events appended during an async subscribe registration are delivered once', async () => {
    // 15,000 lines forces readEventsFromCursorSliced to yield across multiple slices while the
    // subscriber is in its `holding` state.
    const TOTAL = 15_000;
    const CURSOR = 14_990;
    const DURING_COUNT = 12;
    const AFTER_COUNT = 4;

    const world = createWorld([TOTAL], 'async-subscribe-once');
    const root = world.roots[0]!.root;
    const validated = validateTeamFile(TEAM_YAML);
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));

    const started = await startBus({
      root,
      team: validated.team,
      home: world.home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      additiveRouting: { 'seat.working': ['lead'] },
      deliver: () => {},
    });
    if (started.kind !== 'serving') throw new Error(`bus did not start: ${started.kind}`);
    activeBuses.push(started.handle);

    const receivedAnswers: BusAnswer[] = [];
    let initialBatchSettled = false;
    let resolveInitialBatch!: () => void;
    const initialBatchPromise = new Promise<void>((resolve) => {
      resolveInitialBatch = resolve;
    });
    let resolveAllExpected!: () => void;
    const expectedTotalEvents = (TOTAL - CURSOR) + DURING_COUNT + AFTER_COUNT;
    const deliveredRecords: SignedEventRecord[] = [];
    const allExpectedPromise = new Promise<void>((resolve) => {
      resolveAllExpected = resolve;
    });

    const subSocket = connect(busSocket(root));
    subSocket.setEncoding('utf8');
    let buffer = '';
    subSocket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const parsed = parseBusAnswer(line);
        if (!parsed) throw new Error(`invalid bus answer line: ${line}`);
        receivedAnswers.push(parsed);
        if (parsed.ok && parsed.kind === 'events') {
          deliveredRecords.push(...parsed.events);
          if (!initialBatchSettled) {
            initialBatchSettled = true;
            resolveInitialBatch();
          }
        } else if (parsed.ok && parsed.kind === 'event') {
          deliveredRecords.push(parsed.event);
        }
        if (deliveredRecords.length >= expectedTotalEvents) {
          resolveAllExpected();
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      subSocket.once('connect', () => resolve());
      subSocket.once('error', reject);
    });

    // Send the follow subscription request; the server registers `sub` with `holding: []` and starts
    // the sliced cursor read over 15,000 lines.
    subSocket.write(
      encodeBusLine({
        op: 'subscribe',
        seat: LEAD,
        cursor: CURSOR,
        follow: true,
      }),
    );

    // While the sliced catch-up read is yielding on the event loop, publish DURING_COUNT events.
    for (let i = 1; i <= DURING_COUNT; i += 1) {
      const pub = await publishToBus(root, {
        ts: AT,
        kind: 'seat.working',
        session: SESSION,
        record_id: `rec-during-${String(i)}`,
        seat: WORKER,
      });
      if (pub.kind !== 'published') throw new Error(`publish failed: ${pub.kind}`);
      expect(pub.duplicate).toBe(false);
    }

    await initialBatchPromise;

    // Publish AFTER_COUNT more events after the initial batch has flushed and holding is null.
    for (let i = 1; i <= AFTER_COUNT; i += 1) {
      const pub = await publishToBus(root, {
        ts: AT,
        kind: 'seat.working',
        session: SESSION,
        record_id: `rec-after-${String(i)}`,
        seat: WORKER,
      });
      if (pub.kind !== 'published') throw new Error(`publish failed: ${pub.kind}`);
      expect(pub.duplicate).toBe(false);
    }

    await Promise.race([
      allExpectedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${String(expectedTotalEvents)} events (got ${String(deliveredRecords.length)})`)), 10_000),
      ),
    ]);
    subSocket.destroy();

    // Verify first answer was the `{ kind: 'events' }` batch.
    expect(receivedAnswers[0]?.ok).toBe(true);
    if (!receivedAnswers[0] || !receivedAnswers[0].ok || receivedAnswers[0].kind !== 'events') {
      throw new Error('first answer was not an events batch');
    }

    // Verify every single event from CURSOR + 1 through TOTAL + DURING_COUNT + AFTER_COUNT was delivered
    // strictly once and in exact sequence order.
    expect(deliveredRecords).toHaveLength(expectedTotalEvents);
    const seenSeqs = new Set<number>();
    const seenIds = new Set<string>();
    for (let idx = 0; idx < expectedTotalEvents; idx += 1) {
      const expectedSeq = CURSOR + 1 + idx;
      const rec = deliveredRecords[idx]!;
      expect(rec.payload.seq).toBe(expectedSeq);
      expect(seenSeqs.has(rec.payload.seq)).toBe(false);
      expect(seenIds.has(rec.payload.record_id)).toBe(false);
      seenSeqs.add(rec.payload.seq);
      seenIds.add(rec.payload.record_id);
    }
    for (let i = 1; i <= DURING_COUNT; i += 1) {
      expect(seenIds.has(`rec-during-${String(i)}`)).toBe(true);
    }
    for (let i = 1; i <= AFTER_COUNT; i += 1) {
      expect(seenIds.has(`rec-after-${String(i)}`)).toBe(true);
    }
  }, 30_000);
});
