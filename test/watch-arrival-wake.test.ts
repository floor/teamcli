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
  test('a nudge ends the current wait now; one between passes ends the next wait; a standby ignores it', async () => {
    let loopOf: HostedLoop | null = null;
    const outcomes: boolean[] = [];
    let release: () => void = () => {};
    const ended = new Promise<void>((resolve) => { release = resolve; });
    const watch = createHostedWatch({
      route: { root: '/work/acme', team: 'acme', session: SESSION } as never,
      run: async (loop) => {
        loopOf = loop;
        // A wait far longer than any test: only the nudge can end it.
        outcomes.push(await loop.wait(10 * 60_000));
        // A nudge that lands between passes ends the next wait at once.
        loop.nudge?.();
        outcomes.push(await loop.wait(10 * 60_000));
        release();
        return await new Promise<number>(() => {});
      },
    });
    watch.tick(new Date());
    for (let at = 0; at < 200 && loopOf === null; at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loopOf).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    (loopOf as unknown as HostedLoop).nudge?.();
    await ended;
    expect(outcomes).toEqual([true, true]);
    void watch.stop('the test ends');
  });
});
