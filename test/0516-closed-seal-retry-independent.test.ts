import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, eventLogPath, pruneEventLog, readEvents, sealUnsealedSegmentsSteps, verifyEventLogSeals } from '../src/bus/log.ts';
import { sealPathOf } from '../src/bus/seal.ts';
import { acquireLock, LockBusyError } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

test('a held key defers closed sealing and pruning; retry verifies records and rejects a forged append', () => {
  const base = mkdtempSync(join(tmpdir(), 'independent-closed-seal-')); made.push(base);
  const root = join(base, 'project'); const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(home);
  const project = 'sample';
  for (let n = 0; n < 4; n++) {
    expect(appendEvent(project, root, home, { ts: new Date().toISOString(), kind: 'seat.working',
      session: 'morning', seat: 'worker', record_id: `seed-${n}` }, { retain: false, kept: 6 }).ok).toBe(true);
  }
  const open = eventLogPath(project, root, home); const closed = open + '.1';
  renameSync(open, closed);
  const original = readFileSync(closed);
  const lock = join(dirname(open), 'locks/events'); mkdirSync(lock, { recursive: true });
  const release = acquireLock(lock, { waitMs: 0 });
  const options = { kept: 6, segmentBytes: 1000000, retentionSeconds: 86400, sliceLines: 2 };
  const steps = sealUnsealedSegmentsSteps(project, root, home, options);
  let sealBusy: unknown; let pruneBusy: unknown;
  try {
    try { while (!steps.next().done) {} } catch (e) { sealBusy = e; }
    expect(sealBusy instanceof LockBusyError).toBe(true);
    expect(existsSync(sealPathOf(closed))).toBe(false);
    expect(readFileSync(closed).equals(original)).toBe(true);
    try { pruneEventLog(project, root, home, { kept: 6, retentionSeconds: 86400, lockWaitMs: 0 }); }
    catch (e) { pruneBusy = e; }
    expect(pruneBusy instanceof LockBusyError).toBe(true);
    expect(readFileSync(closed).equals(original)).toBe(true);
  } finally { steps.return([]); release(); }
  const retry = sealUnsealedSegmentsSteps(project, root, home, options);
  while (!retry.next().done) {}
  expect(existsSync(sealPathOf(closed))).toBe(true);
  const seals = verifyEventLogSeals(project, root, home, { kept: 6 });
  expect(seals.ok).toBe(true);
  if (!seals.ok) throw new Error(seals.reason);
  expect(seals.segments.find(row => row.path === closed)?.state).toBe('sealed');
  const good = readEvents(project, root, home, { kept: 6 });
  expect(good.ok).toBe(true);
  if (!good.ok) throw new Error(good.reason);
  expect(good.events.length).toBe(4); expect(good.unverified).toBe(0);
  const forged = JSON.parse(original.toString('utf8').split('\n')[0]!);
  forged.payload.seat = 'forged-worker';
  appendFileSync(closed, JSON.stringify(forged) + '\n');
  const checked = readEvents(project, root, home, { kept: 6 });
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error(checked.reason);
  expect(checked.unverified).toBeGreaterThan(0);
  expect(checked.events.some(row => row.payload.seat === 'forged-worker')).toBe(false);
});
