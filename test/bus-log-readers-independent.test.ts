// Independent verification of feat/bus-log-rotation-readers (b21c479af, slices 1-3):
// 1. Near-cap note at 4/5 of the retained-size cap (`busLogSizeNotes`, `retainedLogBytes`,
//    `runTeamCheck` plain and `--json`), with no difference added and no exit-code change.
// 2. `team trace`, `team raise`, and `readEventsMatching` via sealed indexes return the exact
//    same records as a full verified `readEvents` scan across multiple sealed segments and the
//    open segment, while never opening sealed segments whose index names no matching entry.
// 3. A tampered `.index.jsonl`, a tampered/missing `.seal.json`, or a tampered candidate line
//    in a sealed segment falls back to the full verified read and never skips valid records or
//    returns/counts a forged record.
// 4. Append dedupe hydration from sealed indexes: a fresh process (cold start) appends over
//    sealed segments without reading sealed segment bytes, answers a genuine sealed duplicate
//    from its single line, and a forged index entry or forged sealed candidate line never makes
//    dedupe drop a new record.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EVENT_LOG_TOTAL_BYTES,
  appendEvent,
  appendIndexReads,
  eventLogPath,
  readEvents,
  readEventsMatching,
  resetAppendIndexReads,
  retainedLogBytes,
} from '../src/bus/log.ts';
import type { EventKind } from '../src/bus/kinds.ts';
import { busLogSizeNotes } from '../src/bus/notes.ts';
import { indexPathOf, sealPathOf } from '../src/bus/seal.ts';
import type { Caller } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { RAISES_PER_DAY, runRaise } from '../src/commands/raise.ts';
import { runTrace } from '../src/commands/trace.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, fixtureBase, gitEnv, notesOtherThanSocket, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const PROJECT = 'acme';
const MAX_BYTES = 45_000;
const KEPT = 5;

const TEAM_YAML = `format: 1
project: acme
session: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const LEAD_CALLER: Caller = { kind: 'seat', name: 'lead', pane: 'pane1', session: 'acme' };

const EXPECTED_NEAR_CAP_NOTE =
  "bus: the bus log holds 80 MB of its 100 MB retained-size cap; the team's lead: shorten bus.retain_days, or accept the oldest sealed segments dropping (each drop is declared in the log)";

const cleanupDirs: string[] = [];
const chmodRestore: string[] = [];

afterEach(() => {
  for (const p of chmodRestore.splice(0)) {
    try {
      chmodSync(p, 0o600);
    } catch {}
  }
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type World = { root: string; home: string };

function createWorld(): World {
  const base = fixtureBase('.bus-log-readers-ind-');
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const parsed = validateTeamFile(TEAM_YAML);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions['acme'] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats['lead'] = { stage: 'ready', pane: 'pane1', workspace: 'space1' };
    session.seats['worker'] = { stage: 'ready', pane: 'pane2', workspace: 'space2' };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: 'acme',
    seats: ['lead', 'worker'],
    home,
    at: NOW.toISOString(),
  });
  return { root, home };
}

function makeLiveSnapshot(): Live {
  const parsed = validateTeamFile(TEAM_YAML);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: [
      {
        name: 'lead',
        agent: 'claude',
        pane: 'pane1',
        workspace: 'space1',
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(parsed.team.seats[0]!),
      },
      {
        name: 'worker',
        agent: 'claude',
        pane: 'pane2',
        workspace: 'space2',
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(parsed.team.seats[1]!),
      },
    ],
    workspaces: [
      { id: 'space1', label: workspaceLabel(parsed.team.seats[0]!) },
      { id: 'space2', label: workspaceLabel(parsed.team.seats[1]!) },
    ],
    screens: { pane1: CLAUDE_IDLE, pane2: CLAUDE_IDLE },
  };
}

function runCheck(w: World, json = false): { code: number; out: string; stdout: string } {
  const io = testIo(w.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', ...(json ? { json: true } : {}) }, io, {
    home: w.home,
    live: () => makeLiveSnapshot(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(w.root, 'unapproved-store')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}`, stdout: io.out };
}

function writeSparseSlot(w: World, slot: number, bytes: number): string {
  const base = eventLogPath(PROJECT, w.root, w.home);
  const path = slot === 0 ? base : `${base}.${String(slot)}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, bytes);
  return path;
}

function append(w: World, kind: EventKind, id: string, reason?: string, tsIso = NOW.toISOString()): void {
  const res = appendEvent(
    PROJECT,
    w.root,
    w.home,
    {
      ts: tsIso,
      kind,
      session: 'acme',
      record_id: id,
      from: 'lead',
      to: 'worker',
      ...(reason === undefined ? {} : { reason }),
    },
    { maxBytes: MAX_BYTES, kept: KEPT },
  );
  if (!res.ok) throw new Error(res.reason);
}

function rotateUntilSlotExists(w: World, slot: number, label: string): void {
  const target = `${eventLogPath(PROJECT, w.root, w.home)}.${String(slot)}`;
  for (let i = 1; i <= 1000; i += 1) {
    append(w, 'message.arrived', `filler-${label}-${String(i)}`, 'p'.repeat(220));
    if (existsSync(target)) return;
  }
  throw new Error(`failed to rotate into slot ${String(slot)}`);
}

function tamperRecordSignature(segmentPath: string, recordId: string): void {
  const lines = readFileSync(segmentPath, 'utf8').split('\n');
  const idx = lines.findIndex((line) => line.includes(`"record_id":"${recordId}"`));
  if (idx < 0) throw new Error(`record_id ${recordId} not found in ${segmentPath}`);
  const line = lines[idx]!;
  const sig = (JSON.parse(line) as { signature: string }).signature;
  const corrupted = `${sig[0] === '0' ? '1' : '0'}${sig.slice(1)}`;
  lines[idx] = line.replace(`"signature":"${sig}"`, `"signature":"${corrupted}"`);
  writeFileSync(segmentPath, lines.join('\n'));
}

async function runTraceJson(w: World, id: string) {
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runTrace([id, '--json'], io, { home: w.home });
  const doc = JSON.parse(io.out) as {
    steps?: Array<{ record_id: string; seq: number; kind: string; reason?: string }>;
    unverified?: number;
  };
  return {
    code,
    steps: doc.steps ?? [],
    ids: (doc.steps ?? []).map((s) => s.record_id),
    unverified: doc.unverified ?? -1,
    err: io.err,
  };
}

describe('feat/bus-log-rotation-readers independent verification', () => {
  test('1. near-cap note triggers at exactly 4/5 of the cap across live and sealed slots with no exit-code change', () => {
    // Direct unit boundary checks on `busLogSizeNotes`
    expect(busLogSizeNotes({ bytes: 0, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([]);
    expect(busLogSizeNotes({ bytes: 79_999_999, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([]);
    expect(busLogSizeNotes({ bytes: 80_000_000, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([EXPECTED_NEAR_CAP_NOTE]);
    expect(busLogSizeNotes({ bytes: 80_999_999, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([EXPECTED_NEAR_CAP_NOTE]);
    expect(busLogSizeNotes({ bytes: 95_500_000, cap: EVENT_LOG_TOTAL_BYTES })[0]).toContain(
      'holds 95 MB of its 100 MB retained-size cap',
    );
    expect(busLogSizeNotes({ bytes: 47_999_999, cap: 60_000_000 })).toEqual([]);
    expect(busLogSizeNotes({ bytes: 48_000_000, cap: 60_000_000 })[0]).toContain(
      'holds 48 MB of its 60 MB retained-size cap',
    );

    const w = createWorld();
    const baseline = runCheck(w);
    expect(baseline.code).toBe(0);
    expect(baseline.out).not.toContain('retained-size cap');
    expect(baseline.out).toContain('no differences');

    // One byte under 4/5 (79,999,999 bytes split across live, .1, and .2) + 30 MB in out-of-bound slot .51
    writeSparseSlot(w, 0, 30_000_000);
    const slot1 = writeSparseSlot(w, 1, 25_000_000);
    writeSparseSlot(w, 2, 24_999_999);
    writeSparseSlot(w, 51, 30_000_000); // outside default kept=51 (slots 0..50)

    // Make slot .1 unreadable (0o000) to prove `retainedLogBytes` only stats and never opens segment bytes
    chmodSync(slot1, 0o000);
    chmodRestore.push(slot1);

    expect(retainedLogBytes(PROJECT, w.root, w.home)).toBe(79_999_999);
    expect(retainedLogBytes(PROJECT, w.root, w.home, { kept: 2 })).toBe(55_000_000);

    const underCap = runCheck(w);
    expect(underCap.code).toBe(0);
    expect(underCap.out).not.toContain('retained-size cap');

    // Add 1 byte to slot .2 -> reaches 80,000,000 bytes (exact 4/5 of 100,000,000)
    writeSparseSlot(w, 2, 25_000_000);
    expect(retainedLogBytes(PROJECT, w.root, w.home)).toBe(80_000_000);

    const atFourFifths = runCheck(w);
    expect(atFourFifths.code).toBe(0);
    expect(atFourFifths.out).toContain(`note: ${EXPECTED_NEAR_CAP_NOTE}`);
    expect(atFourFifths.out).not.toContain('difference:');
    expect(atFourFifths.out).toContain('no differences');
    expect(notesOtherThanSocket(atFourFifths.out).length).toBe(notesOtherThanSocket(baseline.out).length + 1);

    const atFourFifthsJson = runCheck(w, true);
    expect(atFourFifthsJson.code).toBe(0);
    const parsedJson = JSON.parse(atFourFifthsJson.stdout) as {
      notes: string[];
      differences: unknown[];
    };
    expect(parsedJson.notes).toContain(EXPECTED_NEAR_CAP_NOTE);
    expect(parsedJson.differences).toEqual([]);
  });

  test('2. trace, raise, and readEventsMatching via sealed indexes match a full verified read and skip unrelated sealed segments', async () => {
    const w = createWorld();

    // Segment .2 will hold msg-alpha's early steps + 4 raises
    append(w, 'message.staged', 'msg-alpha:staged', 'alpha staged');
    append(w, 'leg.tried', 'msg-alpha:leg.tried:bus', 'alpha bus');
    for (let i = 1; i <= 4; i += 1) {
      append(w, 'release.ready', `raise-early-${String(i)}`, `early raise ${String(i)}`);
    }
    rotateUntilSlotExists(w, 1, 'seg2');

    // Segment .1 will hold msg-alpha arrival, msg-beta early step, and 5 more raises (no msg-gamma steps)
    append(w, 'message.arrived', 'msg-alpha', 'alpha arrived');
    append(w, 'message.staged', 'msg-beta:staged', 'beta staged');
    for (let i = 5; i <= 9; i += 1) {
      append(w, 'decision.needed', `raise-mid-${String(i)}`, `mid raise ${String(i)}`);
    }
    rotateUntilSlotExists(w, 2, 'seg1');

    // Open segment holds msg-beta arrival, msg-gamma steps, and 10th raise
    append(w, 'message.arrived', 'msg-beta', 'beta arrived');
    append(w, 'message.staged', 'msg-gamma:staged', 'gamma staged');
    append(w, 'message.arrived', 'msg-gamma', 'gamma arrived');
    append(w, 'release.ready', 'raise-open-10', 'open raise 10');

    // Compare `readEventsMatching` against a full verified `readEvents` scan for each filter
    const fullRead = readEvents(PROJECT, w.root, w.home, { kept: KEPT });
    expect(fullRead.ok).toBe(true);
    if (!fullRead.ok) throw new Error(fullRead.reason);

    for (const pred of [
      (e: { kind: string; record_id: string }) => e.record_id === 'msg-alpha' || e.record_id.startsWith('msg-alpha:'),
      (e: { kind: string; record_id: string }) => e.record_id === 'msg-beta' || e.record_id.startsWith('msg-beta:'),
      (e: { kind: string; record_id: string }) => e.record_id === 'msg-gamma' || e.record_id.startsWith('msg-gamma:'),
      (e: { kind: string; record_id: string }) => e.kind === 'release.ready' || e.kind === 'decision.needed',
    ]) {
      const matched = readEventsMatching(PROJECT, w.root, w.home, pred, { kept: KEPT });
      expect(matched.ok).toBe(true);
      if (!matched.ok) throw new Error(matched.reason);
      const expectedEvents = fullRead.events.filter((r) => pred(r.payload));
      expect(matched.events).toEqual(expectedEvents);
      expect(matched.unverified).toBe(0);
      expect(matched.checked).toBeLessThan(fullRead.checked);
    }

    // Verify `runTrace` across `.2`, `.1`, and open segment
    const traceAlpha = await runTraceJson(w, 'msg-alpha');
    expect(traceAlpha.code).toBe(0);
    expect(traceAlpha.ids).toEqual(['msg-alpha:staged', 'msg-alpha:leg.tried:bus', 'msg-alpha']);
    expect(traceAlpha.unverified).toBe(0);

    // Make `.2` and `.1` unreadable (`0o000`) and verify `msg-gamma` (which lives only in open segment)
    // still traces cleanly because neither `.2`'s nor `.1`'s index names `msg-gamma`
    const seg1 = `${eventLogPath(PROJECT, w.root, w.home)}.1`;
    const seg2 = `${eventLogPath(PROJECT, w.root, w.home)}.2`;
    chmodSync(seg1, 0o000);
    chmodSync(seg2, 0o000);
    chmodRestore.push(seg1, seg2);

    const traceGamma = await runTraceJson(w, 'msg-gamma');
    expect(traceGamma.code).toBe(0);
    expect(traceGamma.ids).toEqual(['msg-gamma:staged', 'msg-gamma']);
    expect(traceGamma.unverified).toBe(0);

    // Restore permissions on `.1` and `.2`, then verify `runRaise` enforces the 10-per-day cap
    // across sealed segments `.2` (4 raises), `.1` (5 raises), and open segment (1 raise = 10 total)
    chmodSync(seg1, 0o600);
    chmodSync(seg2, 0o600);
    const raiseIo = testIo(w.root, LEAD_CALLER);
    const raiseCode = await runRaise(['release.ready', 'eleventh raise should be capped'], raiseIo, {
      home: w.home,
      now: () => NOW,
      notify: () => {},
    });
    expect(raiseCode).toBe(1);
    expect(raiseIo.err).toContain('ten raises have reached the owner today');
  });

  test('3. a tampered index, tampered seal, or tampered candidate line falls back to the full verified read and never skips or misreports', async () => {
    const w = createWorld();

    append(w, 'message.staged', 'msg-trace:staged', 'step 1');
    append(w, 'leg.tried', 'msg-trace:leg.tried:bus', 'step 2');
    append(w, 'message.arrived', 'msg-trace', 'step 3');
    for (let i = 1; i <= RAISES_PER_DAY; i += 1) {
      append(w, 'release.ready', `raise-item-${String(i)}`, `raise body ${String(i)}`);
    }
    rotateUntilSlotExists(w, 1, 'tamper-suite');

    const seg1 = `${eventLogPath(PROJECT, w.root, w.home)}.1`;
    const idx1 = indexPathOf(seg1);
    const seal1 = sealPathOf(seg1);

    const origSeg1 = readFileSync(seg1, 'utf8');
    const origIdx1 = readFileSync(idx1, 'utf8');
    const origSeal1 = readFileSync(seal1, 'utf8');

    // (a) Tampered `.index.jsonl`: rename `msg-trace:staged` to `msg-other:staged` and `release.ready` to `message.arrived`
    // in the index so a naive index reader would skip `msg-trace:staged` and undercount raises.
    // Because the seal signs the index's `{ bytes, lines, digest }`, `readEventsMatching` must reject the
    // tampered index, fall back to the full verified read, and return all 3 trace steps and all 10 raises!
    const tamperedIdx = origIdx1
      .replace('"record_id":"msg-trace:staged"', '"record_id":"msg-other:staged"')
      .replaceAll('"kind":"release.ready"', '"kind":"message.arrived"');
    writeFileSync(idx1, tamperedIdx);

    const traceWithTamperedIdx = await runTraceJson(w, 'msg-trace');
    expect(traceWithTamperedIdx.code).toBe(0);
    expect(traceWithTamperedIdx.ids).toEqual(['msg-trace:staged', 'msg-trace:leg.tried:bus', 'msg-trace']);
    expect(traceWithTamperedIdx.unverified).toBe(0);

    const raiseWithTamperedIdxIo = testIo(w.root, LEAD_CALLER);
    const raiseWithTamperedIdxCode = await runRaise(
      ['release.ready', 'still blocked at 10 raises despite tampered index'],
      raiseWithTamperedIdxIo,
      { home: w.home, now: () => NOW, notify: () => {} },
    );
    expect(raiseWithTamperedIdxCode).toBe(1);
    expect(raiseWithTamperedIdxIo.err).toContain('ten raises have reached the owner today');

    // Restore `.index.jsonl`
    writeFileSync(idx1, origIdx1);

    // (b) Tampered `.seal.json` signature: flip first hex digit of signature in `.seal.json`.
    // Must fall back to full verified read and return identical verified results.
    const parsedSeal = JSON.parse(origSeal1) as { signature: string };
    const badSealSig = `${parsedSeal.signature[0] === '0' ? '1' : '0'}${parsedSeal.signature.slice(1)}`;
    writeFileSync(seal1, origSeal1.replace(`"signature": "${parsedSeal.signature}"`, `"signature": "${badSealSig}"`));

    const traceWithTamperedSeal = await runTraceJson(w, 'msg-trace');
    expect(traceWithTamperedSeal.code).toBe(0);
    expect(traceWithTamperedSeal.ids).toEqual(['msg-trace:staged', 'msg-trace:leg.tried:bus', 'msg-trace']);
    expect(traceWithTamperedSeal.unverified).toBe(0);

    // Restore `.seal.json`
    writeFileSync(seal1, origSeal1);

    // (c) Tampered non-candidate line in `.1`: corrupting a filler record's signature in `.1` does not
    // affect `msg-trace` because the non-candidate line is not read during indexed trace lookup.
    tamperRecordSignature(seg1, 'filler-tamper-suite-1');
    const traceWithTamperedFiller = await runTraceJson(w, 'msg-trace');
    expect(traceWithTamperedFiller.code).toBe(0);
    expect(traceWithTamperedFiller.ids).toEqual(['msg-trace:staged', 'msg-trace:leg.tried:bus', 'msg-trace']);
    expect(traceWithTamperedFiller.unverified).toBe(0);
    writeFileSync(seg1, origSeg1);

    // (d) Tampered candidate line in `.1`: corrupting `msg-trace:leg.tried:bus` (same byte length, bad signature)
    // causes `readEventsMatching` to detect the signature mismatch on the candidate line (`disagree = true`),
    // fall back to `readEventsSteps`, refuse the forged record (`unverified: 1`), and still return the two valid steps!
    tamperRecordSignature(seg1, 'msg-trace:leg.tried:bus');
    const traceWithTamperedCandidate = await runTraceJson(w, 'msg-trace');
    expect(traceWithTamperedCandidate.code).toBe(0);
    expect(traceWithTamperedCandidate.ids).toEqual(['msg-trace:staged', 'msg-trace']);
    expect(traceWithTamperedCandidate.unverified).toBe(1);

    // Also verify `readEventsMatching` directly on the tampered candidate line matches `readEvents` filtered
    const fullAfterTamper = readEvents(PROJECT, w.root, w.home, { kept: KEPT });
    const matchAfterTamper = readEventsMatching(
      PROJECT,
      w.root,
      w.home,
      (e) => e.record_id === 'msg-trace' || e.record_id.startsWith('msg-trace:'),
      { kept: KEPT },
    );
    expect(fullAfterTamper.ok).toBe(true);
    expect(matchAfterTamper.ok).toBe(true);
    if (fullAfterTamper.ok && matchAfterTamper.ok) {
      expect(matchAfterTamper.unverified).toBe(1);
      expect(matchAfterTamper.events).toEqual(
        fullAfterTamper.events.filter(
          (r) => r.payload.record_id === 'msg-trace' || r.payload.record_id.startsWith('msg-trace:'),
        ),
      );
    }
  });

  test('4. append dedupe hydrates from sealed indexes on a cold start, and a forged index entry or forged sealed line never makes dedupe drop a new record', () => {
    const w = createWorld();
    const live = eventLogPath(PROJECT, w.root, w.home);
    const seg1 = `${live}.1`;
    const seg2 = `${live}.2`;

    // Rotate into .2 and .1, then append one record to the open segment
    rotateUntilSlotExists(w, 2, 's3');
    const openFirst = appendEvent(
      PROJECT,
      w.root,
      w.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'open-anchor',
        from: 'lead',
        to: 'worker',
        reason: 'anchor in open segment',
      },
      { maxBytes: MAX_BYTES, kept: KEPT },
    );
    if (!openFirst.ok) throw new Error(openFirst.reason);
    const anchorSeq = openFirst.record.payload.seq;

    const openBytesBefore = statSync(live).size;
    const sealedBytesTotal = statSync(seg1).size + statSync(seg2).size;
    expect(openBytesBefore).toBeGreaterThan(0);
    expect(sealedBytesTotal).toBeGreaterThan(openBytesBefore);

    // (a) Fresh process (cold start via utimesSync) appends over unreadable sealed segments (.1 and .2 at 0o000)
    chmodSync(seg1, 0o000);
    chmodSync(seg2, 0o000);
    chmodRestore.push(seg1, seg2);
    const bump = new Date();
    utimesSync(seg1, bump, bump);

    resetAppendIndexReads();
    const freshAppend = appendEvent(
      PROJECT,
      w.root,
      w.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'cold-start-new-1',
        from: 'lead',
        to: 'worker',
        reason: 'appended without reading sealed segments',
      },
      { maxBytes: MAX_BYTES, kept: KEPT },
    );
    expect(freshAppend.ok).toBe(true);
    if (!freshAppend.ok) throw new Error(freshAppend.reason);
    expect(freshAppend.duplicate).toBe(false);
    expect(freshAppend.record.payload.seq).toBe(anchorSeq + 1);
    const coldReads = appendIndexReads();
    expect(coldReads.files).toBe(1);
    expect(coldReads.bytes).toBe(openBytesBefore);

    // Next append in the same process reads only the delta added to the open segment
    resetAppendIndexReads();
    const deltaAppend = appendEvent(
      PROJECT,
      w.root,
      w.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'cold-start-new-2',
        from: 'lead',
        to: 'worker',
        reason: 'delta tail append',
      },
      { maxBytes: MAX_BYTES, kept: KEPT },
    );
    expect(deltaAppend.ok).toBe(true);
    if (!deltaAppend.ok) throw new Error(deltaAppend.reason);
    expect(deltaAppend.duplicate).toBe(false);
    expect(deltaAppend.record.payload.seq).toBe(anchorSeq + 2);
    const deltaReads = appendIndexReads();
    expect(deltaReads.files).toBe(1);
    expect(deltaReads.bytes).toBeLessThan(1_000);

    // Restore permissions on .2 and .1
    chmodSync(seg1, 0o600);
    chmodSync(seg2, 0o600);

    // (b) A genuine duplicate in `.2` is answered from its single line while `.1` stays 0o000 unread
    chmodSync(seg1, 0o000);
    const bump2 = new Date(Date.now() + 1_000);
    utimesSync(seg1, bump2, bump2);
    resetAppendIndexReads();
    const dupReplay = appendEvent(
      PROJECT,
      w.root,
      w.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'filler-s3-1',
        from: 'lead',
        to: 'worker',
        reason: 'replay of existing sealed record',
      },
      { maxBytes: MAX_BYTES, kept: KEPT },
    );
    expect(dupReplay.ok).toBe(true);
    if (!dupReplay.ok) throw new Error(dupReplay.reason);
    expect(dupReplay.duplicate).toBe(true);
    expect(dupReplay.record.payload.record_id).toBe('filler-s3-1');
    expect(appendIndexReads().bytes).toBeLessThan(sealedBytesTotal);
    chmodSync(seg1, 0o600);

    // (c) Forged index entry in `.1.index.jsonl` claiming `forged-idx-id` already exists in `.1`:
    // Dedupe must NOT drop `forged-idx-id`; it falls back to the verified walk of `.1` and writes the new record!
    const idx1 = indexPathOf(seg1);
    const origIdx1 = readFileSync(idx1, 'utf8');
    const firstLineEnd = origIdx1.indexOf('\n');
    const firstEntry = JSON.parse(origIdx1.slice(0, firstLineEnd)) as { record_id: string };
    const forgedIdxText = origIdx1.replace(
      `"record_id":"${firstEntry.record_id}"`,
      '"record_id":"forged-idx-id"',
    );
    writeFileSync(idx1, forgedIdxText);
    const bump3 = new Date(Date.now() + 2_000);
    utimesSync(seg1, bump3, bump3);

    const afterForgedIdx = appendEvent(
      PROJECT,
      w.root,
      w.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'forged-idx-id',
        from: 'lead',
        to: 'worker',
        reason: 'must not be dropped by forged index entry',
      },
      { maxBytes: MAX_BYTES, kept: KEPT },
    );
    expect(afterForgedIdx.ok).toBe(true);
    if (!afterForgedIdx.ok) throw new Error(afterForgedIdx.reason);
    expect(afterForgedIdx.duplicate).toBe(false);
    expect(afterForgedIdx.record.payload.seq).toBe(anchorSeq + 3);
    expect(afterForgedIdx.record.payload.reason).toBe('must not be dropped by forged index entry');
    writeFileSync(idx1, origIdx1);

    // (d) Forged candidate line in `.2` (signature corrupted at same byte length while `.2.index.jsonl` and `.2.seal.json` remain intact):
    // Re-appending `filler-s3-1` detects that the indexed line in `.2` fails signature verification,
    // falls back to the full verified walk, and writes a fresh verified record instead of dropping it as a duplicate!
    tamperRecordSignature(seg2, 'filler-s3-1');
    const bump4 = new Date(Date.now() + 3_000);
    utimesSync(seg1, bump4, bump4);
    resetAppendIndexReads();
    const afterForgedLine = appendEvent(
      PROJECT,
      w.root,
      w.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'filler-s3-1',
        from: 'lead',
        to: 'worker',
        reason: 'freshly written because sealed candidate line was forged',
      },
      { maxBytes: MAX_BYTES, kept: KEPT },
    );
    expect(afterForgedLine.ok).toBe(true);
    if (!afterForgedLine.ok) throw new Error(afterForgedLine.reason);
    expect(afterForgedLine.duplicate).toBe(false);
    expect(afterForgedLine.record.payload.seq).toBe(anchorSeq + 4);
    expect(afterForgedLine.record.payload.reason).toBe('freshly written because sealed candidate line was forged');
    expect(appendIndexReads().bytes).toBeGreaterThanOrEqual(sealedBytesTotal);
  });
});
