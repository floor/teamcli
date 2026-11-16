// A trace step the event lock kept out is deferred to the store's own folder, never dropped, and
// the next append that lands flushes it (2026-11-16: "the leg step socket was not written (the
// event log is busy; the record was not written)" lost a step of a live send).
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { appendStep, deferredStepsFolder, deferStep, flushDeferredSteps, STEP_RETRY_BUDGET_MS, type StepStore } from '../src/send/steps.ts';

const PROJECT = 'acme';
const TS = '2026-11-16T08:54:24.000Z';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): StepStore {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-steps-deferred-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { project: PROJECT, root, home };
}

const step = (id: string) => ({
  ts: TS,
  kind: 'leg.tried' as const,
  session: 'acme',
  record_id: `${id}:leg.tried:socket`,
  from: 'operator-02',
  to: 'orchestrator',
  via: 'socket',
  outcome: 'delivered',
  ms: 116,
});

const recordIds = (at: StepStore): string[] => {
  const read = readEvents(at.project, at.root, at.home);
  if (!read.ok) throw new Error('the event log did not read');
  return read.events.map((one) => one.payload.record_id);
};

test('a deferred step is flushed by the next append that lands, once, and its file is gone', () => {
  const at = store();
  expect(deferStep(at, step('m-1'))).toBe(true);
  expect(readdirSync(deferredStepsFolder(at))).toHaveLength(1);
  expect(recordIds(at)).not.toContain('m-1:leg.tried:socket');

  const landed = appendStep(at, step('m-2'));
  expect(landed.ok).toBe(true);
  expect(recordIds(at)).toEqual(expect.arrayContaining(['m-1:leg.tried:socket', 'm-2:leg.tried:socket']));
  expect(readdirSync(deferredStepsFolder(at))).toHaveLength(0);
  // A second flush finds nothing; the step is one event, not two.
  expect(flushDeferredSteps(at)).toBe(0);
  expect(recordIds(at).filter((one) => one === 'm-1:leg.tried:socket')).toHaveLength(1);
});

test('the same step deferred twice is one file, and flushing it twice is one event', () => {
  const at = store();
  expect(deferStep(at, step('m-3'))).toBe(true);
  expect(deferStep(at, step('m-3'))).toBe(true);
  expect(readdirSync(deferredStepsFolder(at))).toHaveLength(1);
  expect(flushDeferredSteps(at)).toBe(1);
  expect(recordIds(at).filter((one) => one === 'm-3:leg.tried:socket')).toHaveLength(1);
  expect(existsSync(deferredStepsFolder(at))).toBe(true);
});

test('the busy retry is bounded: the whole wait stays inside two seconds', () => {
  expect(STEP_RETRY_BUDGET_MS).toBe(2_000);
});
