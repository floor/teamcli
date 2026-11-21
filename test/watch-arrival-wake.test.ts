// The hosted watch's arrival wake (src/watch/arrival-wake.ts, src/daemon/watch.ts `nudge`).
//
// A stamped message for a Claude Code seat whose channel is not proven starts the hosted watch's
// next pass at once instead of at the end of its interval; the pass keeps every typed-key check.
// A proven seat, another CLI's seat, and anything that is not a record name wake nothing, and a
// burst is one wake. Fixtures only: a synthetic root and home, a scripted folder watch.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerKeyOf, proveOffer } from '../src/comms/offer.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import { takeCopyNumber } from '../src/queue/handover.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import { ARRIVAL_WAKE_MIN_MS, arrivalWakes, startArrivalWake } from '../src/watch/arrival-wake.ts';

const SESSION = 'acme';
const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: tester
    name: tester
    cli: claude-code
    vendor: anthropic
    model: Claude Haiku
    version: "5.5"
    launch: claude
  - role: builder
    name: coder
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex
`;
const ID = '7a0b1c2d-0000-4000-8000-0000000aa001';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function place(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'arrival-wake-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

function listen(at: { root: string }, seat: string): InboxListener {
  const dirs = seatMailDirs(at.root, SESSION, seat);
  mkdirSync(dirs.legacy, { recursive: true, mode: 0o700 });
  const listener: InboxListener = { v: 1, seat, session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), channel: true, level: 3 };
  expect(writeListener(dirs.legacy, listener)).toBe(true);
  return listener;
}

/** A proving ack for this listener: the seat's channel is proven. */
function prove(at: { root: string; home: string }, seat: string, listener: InboxListener): void {
  const dirs = seatMailDirs(at.root, SESSION, seat);
  const payload: RecordPayload = { kind: 'message', id: ID, to: seat, to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: 'x', from: 'owner', from_id: null, rule: 'the owner', thread: ID, lvl: 3 };
  expect(writeRecord(dirs.legacy, signRecord(payload, at.home)).ok).toBe(true);
  const token = 'e'.repeat(32);
  expect(takeCopyNumber(dirs.stamped, ID, 'channel', Date.now(), { token, listener: listenerKeyOf(listener) })).not.toBeNull();
  const key = messageKeyState(at.home);
  if (key.kind !== 'key') throw new Error('no key');
  expect(proveOffer(dirs.legacy, ID, token, listenerKeyOf(listener), { root: at.root, session: SESSION, seat, key: key.key })).not.toBeNull();
}

describe('which arrivals wake the hosted watch', () => {
  test('an unproven Claude seat wakes it; a proven one and another CLI\'s seat do not', () => {
    const at = place();
    expect(arrivalWakes(at.root, SESSION, at.home, 'tester', Date.now())).toBe(true);
    const lead = listen(at, 'lead');
    prove(at, 'lead', lead);
    expect(arrivalWakes(at.root, SESSION, at.home, 'lead', Date.now())).toBe(false);
    expect(arrivalWakes(at.root, SESSION, at.home, 'coder', Date.now())).toBe(false);
    expect(arrivalWakes(at.root, SESSION, at.home, 'nobody', Date.now())).toBe(false);
  });

  test('a record name under a seat wakes once per window; sidecars and markers never', async () => {
    const at = place();
    let onName: (name: string) => void = () => {};
    let clock = 1_000_000;
    let nudges = 0;
    const close = startArrivalWake({
      root: at.root, session: SESSION, home: at.home, nudge: () => { nudges += 1; }, now: () => clock,
      watchFolder: (_folder, handler) => { onName = handler; return { close: () => {} }; },
    });
    onName(`tester/${ID}.ack.json`);
    onName(`tester/.exposures/${ID}/1`);
    onName('tester/.inbox-listener');
    expect(nudges).toBe(0);
    onName(`tester/${ID}`);
    expect(nudges).toBe(1);
    // A burst inside the window is carried to its end as one wake.
    onName('tester/7a0b1c2d-0000-4000-8000-0000000aa002');
    onName('tester/7a0b1c2d-0000-4000-8000-0000000aa003');
    expect(nudges).toBe(1);
    clock += ARRIVAL_WAKE_MIN_MS;
    await new Promise((resolve) => setTimeout(resolve, ARRIVAL_WAKE_MIN_MS + 50));
    expect(nudges).toBe(2);
    onName(`coder/${ID}`);
    expect(nudges).toBe(2);
    close();
  }, 10_000);
});

describe('the real folder watch', () => {
  test('a record written with the tree, before the watch could attach, is caught up when it does', async () => {
    const at = place();
    let nudges = 0;
    const close = startArrivalWake({ root: at.root, session: SESSION, home: at.home, nudge: () => { nudges += 1; }, rearmMs: 50 });
    try {
      // The first stamped write makes the tree and lands its record in one go.
      const stamped = seatMailDirs(at.root, SESSION, 'tester').stamped;
      mkdirSync(stamped, { recursive: true, mode: 0o700 });
      writeFileSync(join(stamped, ID), '{}\n');
      for (let wait = 0; wait < 100 && nudges === 0; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nudges).toBe(1);
    } finally {
      close();
    }
  });

  test('a watch that errors is armed again, and what landed meanwhile is caught up', async () => {
    const at = place();
    const stamped = seatMailDirs(at.root, SESSION, 'tester').stamped;
    mkdirSync(stamped, { recursive: true, mode: 0o700 });
    let nudges = 0;
    let arms = 0;
    let fail: () => void = () => {};
    const close = startArrivalWake({
      root: at.root, session: SESSION, home: at.home, nudge: () => { nudges += 1; }, rearmMs: 50,
      watchFolder: (_folder, _onName, onError) => { arms += 1; fail = onError; return { close: () => {} }; },
    });
    try {
      expect(arms).toBe(1);
      fail();
      // Down: the record lands with no watch standing.
      writeFileSync(join(stamped, ID), '{}\n');
      for (let wait = 0; wait < 100 && (arms < 2 || nudges === 0); wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(arms).toBe(2);
      expect(nudges).toBe(1);
    } finally {
      close();
    }
  });


  test('a record landing in the stamped tree, made after the wake started, nudges the loop', async () => {
    const at = place();
    let nudges = 0;
    const close = startArrivalWake({ root: at.root, session: SESSION, home: at.home, nudge: () => { nudges += 1; }, rearmMs: 50 });
    try {
      // The root is dark: no stamped tree yet. It appears at activation; the wake arms on it.
      const stamped = seatMailDirs(at.root, SESSION, 'tester').stamped;
      mkdirSync(stamped, { recursive: true, mode: 0o700 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(join(stamped, ID), '{}\n');
      for (let wait = 0; wait < 100 && nudges === 0; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nudges).toBe(1);
    } finally {
      close();
    }
  });
});

describe('the hosted loop\'s nudge', () => {
  test('a nudge ends only the between-pass wait; a pass\'s own sleep runs its full time and the nudge waits for the pass\'s end', async () => {
    let loopOf: HostedLoop | null = null;
    const steps: string[] = [];
    let inPassSettled = false;
    let release: () => void = () => {};
    const ended = new Promise<void>((resolve) => { release = resolve; });
    const watch = createHostedWatch({
      route: { root: '/work/acme', team: 'acme', session: SESSION } as never,
      run: async (loop) => {
        loopOf = loop;
        // Between passes: only a nudge ends this wait.
        steps.push(`between ${String(await loop.wait(10 * 60_000, { between: true }))}`);
        // Inside a pass: a settle delay on the typing path. A nudge here must not end it.
        const inPass = loop.wait(10 * 60_000).then((ok) => { inPassSettled = true; return ok; });
        steps.push(`in-pass ${String(await inPass)}`);
        // The nudge that landed during the pass ends the next between-pass wait at once.
        steps.push(`between ${String(await loop.wait(10 * 60_000, { between: true }))}`);
        release();
        return await new Promise<number>(() => {});
      },
    });
    watch.tick(new Date());
    for (let at = 0; at < 200 && loopOf === null; at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const loop = loopOf as unknown as HostedLoop;
    await new Promise((resolve) => setTimeout(resolve, 20));
    loop.nudge?.();
    for (let at = 0; at < 200 && steps.length === 0; at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(steps).toEqual(['between true']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // An arrival during the pass: the in-pass sleep keeps running.
    loop.nudge?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inPassSettled).toBe(false);
    // Its own time comes: the host's tick past its due ends it.
    watch.tick(new Date(Date.now() + 11 * 60_000));
    await ended;
    expect(steps).toEqual(['between true', 'in-pass true', 'between true']);
    void watch.stop('the test ends');
  });
});
