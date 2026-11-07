import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, eventLogPath, readEvents, sealUnsealedSegmentsSteps } from '../src/bus/log.ts';
import { LOCK_FILE } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

test('closing a seal paused with pending chunks releases its key without losing the verified log', () => {
  const base = mkdtempSync(join(tmpdir(), 'independent-yielding-seal-')); made.push(base);
  const root = join(base, 'project'); const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(home);
  const project = 'sample'; const session = 'morning';
  const input = (id: string) => ({ ts: new Date().toISOString(), kind: 'seat.working' as const,
    session, record_id: id, seat: 'worker', reason: 'synthetic padding '.repeat(20) });
  for (let n = 0; n < 12; n++) {
    expect(appendEvent(project, root, home, input(`seed-${n}`), { retain: false, kept: 20 }).ok).toBe(true);
  }
  const path = eventLogPath(project, root, home); const store = dirname(path);
  const original = readFileSync(path);
  const lock = join(store, 'locks/events', LOCK_FILE);
  const steps = sealUnsealedSegmentsSteps(project, root, home,
    { kept: 20, segmentBytes: 1024, retentionSeconds: 86400, sliceLines: 2 });
  let paused = false;
  try {
    for (let n = 0; n < 500; n++) {
      const next = steps.next();
      if (next.done) break;
      if (existsSync(lock) && readdirSync(store).some(name => name.startsWith('events.jsonl.pending-'))) {
        paused = true; break;
      }
    }
    expect(paused).toBe(true);
    expect(readFileSync(path).equals(original)).toBe(true);
    const during = readEvents(project, root, home, { kept: 20 });
    expect(during.ok).toBe(true);
    if (!during.ok) throw new Error(during.reason);
    expect(during.events.length).toBe(12); expect(during.unverified).toBe(0);
    const blocked = appendEvent(project, root, home, input('during-pause'), { retain: false, kept: 20, lockWaitMs: 0 });
    expect(blocked).toMatchObject({ ok: false, busy: true });
    expect(readFileSync(path).equals(original)).toBe(true);
  } finally { steps.return([]); }
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(store).some(name => name.includes('.pending-'))).toBe(false);
  expect(readFileSync(path).equals(original)).toBe(true);
  expect(appendEvent(project, root, home, input('after-cancel'), { retain: false, kept: 20, lockWaitMs: 0 }).ok).toBe(true);
  const after = readEvents(project, root, home, { kept: 20 });
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(after.reason);
  expect(after.events.length).toBe(13); expect(after.unverified).toBe(0);
  expect(new Set(after.events.map(row => row.payload.seq)).size).toBe(13);
});
