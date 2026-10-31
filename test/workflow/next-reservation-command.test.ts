// `team next`'s claim boundary with a reservation store injected, over a STAND-IN store: the
// item a dispatch reserved is not offered, a refused hold claims nothing, the store claim and
// the local lease carry the same deadline, a renewal moves both, a release clears both, and a
// tracker claim that refuses takes its store hold back out. Stand-in evidence about the command
// path only; the real-store pair is exercised in the race suite at the committed store head.
//
// The fixture is synthetic: a scratch project, two ready seats, a file-source task list.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runNext } from '../../src/commands/next.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { fileAdapter } from '../../src/tasks/file.ts';
import { LEASE_MS } from '../../src/tasks/lease.ts';
import type { TaskAdapter } from '../../src/tasks/adapter.ts';
import { gitEnv, testIo } from '../helpers.ts';
import { StandInStore, standInKeyText } from './reservation-stand-in-store.ts';
import type { ItemIdentity } from '../../src/workflow/reservation/index.ts';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
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

const ONE = '- id: m1\n  title: one\n';
const TWO = '- id: m1\n  title: one\n- id: m2\n  title: two\n';
const TIMED = '- id: m1\n  title: one\n  deadline: 2026-12-31T00:00:00Z\n- id: m2\n  title: two\n';

const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
/** The caller a seat's own pane makes: the pane the fixture's state records for it. */
function callerOf(seat: string): Extract<Caller, { kind: 'seat' }> {
  const record = readState(join(root, '.agents')).sessions.acme?.seats[seat];
  if (record?.pane === undefined) throw new Error(`the fixture records no pane for seat ${seat}`);
  return { kind: 'seat', name: seat, pane: record.pane, session: 'acme' };
}
const CTX = 'team acme, session "acme"\n';
const now = Date.parse('2026-10-08T09:00:00.000Z');

let base: string;
let root: string;
let home: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function ready(tasks = ONE): void {
  base = mkdtempSync(join(tmpdir(), 'team-next-reservation-store-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), tasks);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function item(id: string): ItemIdentity {
  return { source: 'file', project: 'acme', team: 'acme', id };
}

function holdOf(store: StandInStore, id = 'm1') {
  const key = standInKeyText(item(id));
  if (key === null) throw new Error('the fixture item is unkeyable');
  return store.index.get(key)?.hold;
}

function leaseOf(id = 'm1'): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.agents', 'leases', `${id}.json`), 'utf8')) as Record<string, unknown>;
}

function leaseExists(id: string): boolean {
  return existsSync(join(root, '.agents', 'leases', `${id}.json`));
}

async function next(store: StandInStore, argv: string[] = [], at = now): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, lead);
  const code = await runNext(argv, io, { home, now: () => at, reservations: store });
  return { code, out: io.out, err: io.err };
}

describe('team next with a reservation store injected', () => {
  test('a claim takes the store hold with the local lease deadline', async () => {
    ready();
    const store = new StandInStore();
    const answer = await next(store);
    expect(answer).toEqual({ code: 0, out: `${CTX}m1  one\nteam next: claimed m1\n`, err: '' });
    expect(leaseOf()).toMatchObject({ id: 'm1', seat: 'lead', pane: 'w1:p1' });
    expect(holdOf(store)).toMatchObject({
      kind: 'next-claim',
      owner: 'next:lead:w1:p1',
      seat: 'lead',
      pane: 'w1:p1',
      phase: 'pending',
      expiresAt: new Date(now + LEASE_MS).toISOString(),
    });
    expect(Date.parse(String(leaseOf().until))).toBe(now + LEASE_MS);
  });

  test('an item a dispatch reserved is not offered, and its hold is untouched', async () => {
    ready(TWO);
    const store = new StandInStore();
    store.seed(item('m1'), {
      hold: {
        kind: 'reservation',
        item: 'k',
        owner: 'run-1/1',
        seat: 'worker',
        phase: 'pending',
        at: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        run: 'run-1',
        attempt: 1,
        thread: 'th-1',
        receiver: 'worker',
        pane: 'w2:p1',
      },
    });
    const reserved = structuredClone(holdOf(store, 'm1'));
    const answer = await next(store);
    expect(answer.out).toBe(`${CTX}m2  two\nteam next: claimed m2\n`);
    expect(leaseExists('m1')).toBe(false);
    expect(leaseExists('m2')).toBe(true);
    expect(holdOf(store, 'm1')).toEqual(reserved);
  });

  test('when every candidate is excluded the answer is the shipped empty one and nothing is leased', async () => {
    ready();
    const store = new StandInStore();
    store.seed(item('m1'), { live: 'run-1' });
    const answer = await next(store);
    expect(answer).toEqual({ code: 0, out: `${CTX}team next: nothing is takeable\n`, err: '' });
    expect(leaseExists('m1')).toBe(false);
    expect(holdOf(store)).toBeUndefined();
  });

  test('a seat nothing can wake while it is idle takes the ordinary work, and the time-bound item is never held', async () => {
    ready(TIMED);
    const store = new StandInStore();
    // The worker's launch installs no wake adapter, so an idle worker is pull-on-turn: the
    // time-bound record would fall due between its turns, and the ordinary one stays open.
    const caller = callerOf('worker');
    const io = testIo(root, caller);
    const code = await runNext([], io, { home, now: () => now, reservations: store });
    expect({ code, out: io.out, err: io.err }).toEqual({ code: 0, out: `${CTX}m2  two\nteam next: claimed m2\n`, err: '' });
    expect(holdOf(store, 'm2')).toMatchObject({ kind: 'next-claim', owner: `next:worker:${caller.pane}`, seat: 'worker' });
    // The time-bound item was never offered, so the store was never asked to hold it.
    expect(holdOf(store, 'm1')).toBeUndefined();
    expect(leaseExists('m1')).toBe(false);
    expect(leaseExists('m2')).toBe(true);
  });

  test('a seat a wake reaches while it is idle takes the time-bound item, hold first', async () => {
    ready(TIMED);
    updateState(join(root, '.agents'), (state) => {
      const seats = state.sessions.acme!.seats;
      seats.worker = {
        ...seats.worker!,
        cli: 'claude-code',
        launch_line: 'claude --dangerously-load-development-channels server:team-inbox',
      };
    });
    const store = new StandInStore();
    const caller = callerOf('worker');
    const io = testIo(root, caller);
    const code = await runNext([], io, { home, now: () => now, reservations: store });
    expect({ code, out: io.out, err: io.err }).toEqual({ code: 0, out: `${CTX}m1  one\n  deadline: 2026-12-31T00:00:00Z\nteam next: claimed m1\n`, err: '' });
    expect(holdOf(store, 'm1')).toMatchObject({ kind: 'next-claim', owner: `next:worker:${caller.pane}` });
    expect(holdOf(store, 'm2')).toBeUndefined();
  });

  test('a lapsed hold does not exclude its item, and the claim replaces it', async () => {
    ready();
    const store = new StandInStore();
    store.seed(item('m1'), {
      hold: {
        kind: 'reservation',
        item: 'k',
        owner: 'run-1/1',
        seat: 'worker',
        phase: 'pending',
        at: new Date(now - 120_000).toISOString(),
        expiresAt: new Date(now).toISOString(),
        run: 'run-1',
        attempt: 1,
        receiver: 'worker',
      },
    });
    const answer = await next(store);
    expect(answer.out).toBe(`${CTX}m1  one\nteam next: claimed m1\n`);
    expect(holdOf(store)).toMatchObject({ owner: 'next:lead:w1:p1', kind: 'next-claim' });
  });

  test('release removes the lease and then clears the store claim', async () => {
    ready();
    const store = new StandInStore();
    expect((await next(store)).code).toBe(0);
    expect(holdOf(store)?.owner).toBe('next:lead:w1:p1');
    const answer = await next(store, ['--release']);
    expect(answer).toEqual({ code: 0, out: `${CTX}team next: released m1\n`, err: '' });
    expect(leaseExists('m1')).toBe(false);
    expect(holdOf(store)).toBeUndefined();
  });

  test('a live lease renews the store claim with it, and takes no second hold', async () => {
    ready();
    const store = new StandInStore();
    expect((await next(store)).code).toBe(0);
    const later = now + 60_000;
    const answer = await next(store, [], later);
    expect(answer.out).toBe(`${CTX}m1  one\nteam next: claimed m1\n`);
    expect(Date.parse(String(leaseOf().until))).toBe(later + LEASE_MS);
    expect(holdOf(store)).toMatchObject({ owner: 'next:lead:w1:p1', expiresAt: new Date(later + LEASE_MS).toISOString() });
    const renewals = store.calls.filter((call) => call.op === 'renewHold');
    expect(renewals.length).toBe(1);
  });

  test('a tracker claim that refuses gives its store hold back; one that holds keeps it and writes no lease', async () => {
    ready();
    const refusing = new StandInStore();
    const busy: TaskAdapter = { ...fileAdapter, claim: () => ({ kind: 'busy' }) };
    const refusedIo = testIo(root, lead);
    const refused = await runNext([], refusedIo, {
      home,
      now: () => now,
      reservations: refusing,
      registry: { file: busy },
    });
    expect(refused).toBe(0);
    expect(refusedIo.out).toBe(`${CTX}team next: nothing is takeable\n`);
    expect(refusedIo.err).toBe('');
    expect(holdOf(refusing)).toBeUndefined();
    expect(leaseExists('m1')).toBe(false);

    ready();
    const holding = new StandInStore();
    const io = testIo(root, lead);
    const held: TaskAdapter = { ...fileAdapter, claim: () => ({ kind: 'held' }) };
    expect(await runNext([], io, { home, now: () => now, reservations: holding, registry: { file: held } })).toBe(0);
    expect(io.out).toBe(`${CTX}m1  one\nteam next: claimed m1\n`);
    expect(holdOf(holding)).toMatchObject({ kind: 'next-claim', owner: 'next:lead:w1:p1' });
    expect(leaseExists('m1')).toBe(false);
  });
});
