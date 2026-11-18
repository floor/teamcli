// rfc-event-comms E7b (R3.4): the one re-send scheduler. Every stamped record that is not settled
// is offered again through the seat's current adapter after its backoff (60 s, doubling, capped at
// 30 minutes, no attempt cap, no last day), whatever leg the seat takes: a Codex seat's native
// queue, a profile's typed wake (the watch's own guarded one), the cross-session socket, the
// webhook, the development channel, or none at all (a drop-only seat, whose next copy is its own
// next inbox read). Only an ack, a reply or a clearance settles a record; a dark root has nothing
// for the scheduler. Each attempt is reserved durably and exclusively before it is dispatched.
//
// The live finding this pins (2026-11-18, a test team): a stamped message to a Codex seat that was
// not acknowledged got copy 1 on its native leg and no copy 2 in 11 minutes, because only the
// Claude channel and socket ladders re-sent a stamped copy.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as send from '../src/commands/send.ts';
import type { SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { listenerPath, readMessage } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { attemptLedger, backoffMs, copyHistory, EXPOSURES, reserveAttempt, resendDue, takeCopyNumber } from '../src/queue/handover.ts';
import { seatMailDirIn } from '../src/queue/mail-tree.ts';
import { channelOwnsSeat, resendCandidates, resendPass, reserveDue, type ResendSeat } from '../src/queue/resend.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { markPending, PENDING_MAX_AGE_MS, readPending } from '../src/send/pending.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import type { TypedWakeResult } from '../src/send/typed-wake.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import { retryHeldDrops, type RetryScene, type RetrySources } from '../src/watch/retry.ts';
import { testIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const MIN = 60_000;
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const ID = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e71';
const ID2 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e72';
const RESEND_NOTE = /^message \S+ · delivery (\d+)/;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function made(order: readonly string[] | null, extra: Parameters<typeof world>[1] = []): World {
  const at = world(order, extra);
  cleanups.push(at.cleanup);
  return at;
}

function activateRoot(at: { root: string; home: string }): void {
  expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
}

function keyOf(home: string) {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('no message key');
  return state.key;
}

/** A stamped record from `lead` to `seat`, through the record writer (it lands in the stamped
 *  folder). `root` is the checkout the record is bound to (this one unless a scene says).
 *  Returns the seat's legacy folder, the one every reader starts from. */
function stamped(at: { root: string; dir: string; home: string }, seat: string, id: string, body = `body of ${id}`, root = at.root, sender: { from: string; from_id: string | null } = { from: 'lead', from_id: null }): string {
  const payload: RecordPayload = {
    kind: 'message', id, to: seat, to_id: null, root, session: SESSION, at: new Date().toISOString(),
    body, from: sender.from, from_id: sender.from_id, rule: 'the owner', thread: id,
  };
  const signed = signRecord(stampedPayload(payload, at.home), at.home);
  expect(signed.payload.lvl).toBe(3);
  const dropDir = seatMailDirIn(at.dir, SESSION, seat);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const written = writeRecord(dropDir, signed);
  if (!written.ok) throw new Error(written.reason);
  expect(existsSync(join(seatMailDirIn(at.dir, SESSION, seat, 'stamped'), id))).toBe(true);
  return dropDir;
}

function stampedFolder(at: { dir: string }, seat: string): string {
  return seatMailDirIn(at.dir, SESSION, seat, 'stamped');
}

function ack(at: { root: string; home: string }, dropDir: string, seat: string, id: string): void {
  const outcome = publishRecordRead({ dropDir, id, to: seat, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy: 'ack' });
  expect(outcome.kind).toBe('published');
}

function seatOf(at: { root: string; home: string }, dropDir: string, seat: string): ResendSeat {
  return { dropDir, context: { to: seat, root: at.root, session: SESSION, lead: 'lead' }, key: keyOf(at.home), agentsDir: join(at.root, '.agents') };
}

/** Moves the record's whole delivery history (its copies, its attempts and the record's own
 *  arrival) `ms` into the past, as if that much time had gone by. */
function age(folder: string, id: string, ms: number): void {
  const history = join(folder, EXPOSURES, id);
  if (existsSync(history)) {
    for (const name of readdirSync(history)) {
      const path = join(history, name);
      if (/^\.attempt-\d+$/.test(name)) {
        const attempt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { at: string };
        chmodSync(path, 0o600);
        writeFileSync(path, `${JSON.stringify({ ...attempt, at: new Date(Date.parse(attempt.at) - ms).toISOString() })}\n`);
        continue;
      }
      const at = new Date(Date.now() - ms);
      utimesSync(path, at, at);
    }
  }
  const arrived = new Date(Date.now() - ms);
  utimesSync(join(folder, id), arrived, arrived);
}

/** The Codex native queue the walk hands its copy to, recording each copy it was given. */
function nativeQueue(): { route: NonNullable<SendHost['nativeRoute']>; copies: string[] } {
  const copies: string[] = [];
  const route = (async (_target: unknown, message: { pointer?: string }) => {
    copies.push(message.pointer ?? '');
    return { route: 'native', outcome: 'enqueue', receipt: { copy: 'fixture', at: new Date().toISOString() }, walkAttempt: {} };
  }) as unknown as NonNullable<SendHost['nativeRoute']>;
  return { route, copies };
}

const AGY_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12', 'idle.txt'), 'utf8');

const headerOf = (text: string | undefined): string => (text ?? '').split('\n')[0] ?? '';
const numberOf = (text: string | undefined): number | null => {
  const match = RESEND_NOTE.exec(headerOf(text));
  return match === null ? null : Number(match[1]);
};

function teamOf(at: World) {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('fixture team failed to load');
  return loaded.team;
}

/** The adapter the watch binds: the seat's resolved walk, with no pane writer. */
function adapter(at: World, host: SendHost, cli: string, seat: string, dropDir: string) {
  const team = teamOf(at);
  const { typedWake: _unbound, ...rest } = host;
  return (id: string) => send.resendStampedRecord({ host: rest, dir: at.dir, root: at.root, project: team.project, session: SESSION, seat, cli, dropDir, id, team });
}

describe('the schedule: from the delivery history, 60 s doubling to 30 minutes, no cap, no last day', () => {
  test('the send\'s delivery is attempt one; a copy only moves the clock; each scheduler attempt doubles the wait', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const folder = stampedFolder(at, 'native');
    const now = Date.now();
    // No copy yet: the send's own delivery is not doubled; one first backoff from arrival.
    expect(resendDue(folder, ID, now + 59_000, now)).toBe(false);
    expect(resendDue(folder, ID, now + 60_000, now)).toBe(true);
    // Copy 1 (the send's): due 60 s after it.
    expect(takeCopyNumber(dropDir, ID, 'native')).toBe(1);
    expect(resendDue(folder, ID, now + 30_000, now)).toBe(false);
    expect(resendDue(folder, ID, now + 61_000, now)).toBe(true);
    // A seat's own read (copy 2) moves the clock, not the count: still 60 s.
    expect(takeCopyNumber(dropDir, ID, 'read')).toBe(2);
    expect(resendDue(folder, ID, now + 59_000, now)).toBe(false);
    expect(resendDue(folder, ID, now + 61_000, now)).toBe(true);
    expect([1, 2, 3, 4, 5, 6, 10, 40].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
  });

  test('copy 1, then an offer that carried nothing: the next waits 120 s, then 240 s; no cap', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const folder = stampedFolder(at, 'native');
    takeCopyNumber(dropDir, ID, 'native');
    const seat = seatOf(at, dropDir, 'native');
    const offers: string[] = [];
    const none = async (id: string) => { offers.push(id); return null; };
    const t0 = Date.now() + 61_000;
    expect(await resendPass(seat, t0, none, 'test')).toEqual([{ id: ID, attempt: 1, copy: null, via: null }]);
    expect(attemptLedger(folder, ID).attempts).toBe(1);
    await resendPass(seat, t0 + 119_000, none, 'test');
    expect(offers).toHaveLength(1);
    await resendPass(seat, t0 + 120_500, none, 'test');
    expect(offers).toHaveLength(2);
    await resendPass(seat, t0 + 120_500 + 239_000, none, 'test');
    expect(offers).toHaveLength(2);
    let t = t0 + 120_500 + 240_500;
    await resendPass(seat, t, none, 'test');
    expect(offers).toHaveLength(3);
    for (let n = 0; n < 20; n += 1) {
      t += 30 * MIN + 1_000;
      await resendPass(seat, t, none, 'test');
    }
    expect(offers).toHaveLength(23);
    expect(resendDue(folder, ID, t + 29 * MIN, null)).toBe(false);
    expect(resendDue(folder, ID, t + 30 * MIN + 1_000, null)).toBe(true);
  });

  test('a crash after the reservation and before the offer still counts and spaces the attempt', () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const folder = stampedFolder(at, 'native');
    takeCopyNumber(dropDir, ID, 'native');
    const t0 = Date.now() + 61_000;
    expect(reserveAttempt(folder, ID, 'watch', t0)).toBe(1);
    // The process dies here: no offer, no outcome. A restarted host reads the reservation.
    expect(resendDue(folder, ID, t0 + 119_000, null)).toBe(false);
    expect(resendDue(folder, ID, t0 + 120_000, null)).toBe(true);
    expect(existsSync(join(folder, EXPOSURES, ID, '.attempt-1.done'))).toBe(false);
  });

  test('two hosts at one due boundary dispatch the attempt once', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    takeCopyNumber(dropDir, ID, 'native');
    const seat = seatOf(at, dropDir, 'native');
    const offers: string[] = [];
    const slow = (host: string) => async (id: string) => { offers.push(`${host}:${id}`); await new Promise((resolve) => setTimeout(resolve, 20)); return host; };
    const t = Date.now() + 61_000;
    const [watch, channel] = await Promise.all([resendPass(seat, t, slow('watch'), 'watch'), resendPass(seat, t, slow('channel'), 'channel')]);
    expect(offers).toHaveLength(1);
    expect(watch.length + channel.length).toBe(1);
    expect(attemptLedger(stampedFolder(at, 'native'), ID).attempts).toBe(1);
  });

  test('a stale due decision reserves nothing: the decision is re-made under the seat lock', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    takeCopyNumber(dropDir, ID, 'native');
    const seat = seatOf(at, dropDir, 'native');
    const t = Date.now() + 61_000;
    // Both hosts decided the record is due before either reserved.
    expect(resendCandidates(seat, t)).toEqual([ID]);
    expect(resendCandidates(seat, t)).toEqual([ID]);
    // The first reserves attempt 1 and dispatches; the second, on its stale decision, reserves
    // nothing: under the lock attempt 1 is seen and the record is not due again for 120 s.
    expect(reserveDue(seat, ID, t, 'watch')).toBe(1);
    expect(reserveDue(seat, ID, t, 'channel')).toBeNull();
    expect(reserveDue(seat, ID, t + 1_000, 'channel')).toBeNull();
    expect(attemptLedger(stampedFolder(at, 'native'), ID).attempts).toBe(1);
    // A whole pass delayed after its selection behaves the same: one dispatch in all.
    const offers: string[] = [];
    const late = await resendPass(seat, t, async (id) => { offers.push(id); return 'native'; }, 'channel');
    expect(late).toEqual([]);
    expect(offers).toEqual([]);
  });

  test('no last day: a record weeks old is still due; an ack ends it', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    age(stampedFolder(at, 'native'), ID, 30 * 24 * 60 * MIN);
    const seat = seatOf(at, dropDir, 'native');
    expect(resendCandidates(seat, Date.now())).toEqual([ID]);
    ack(at, dropDir, 'native', ID);
    expect(resendCandidates(seat, Date.now() + 60 * MIN)).toEqual([]);
    const offered: string[] = [];
    expect(await resendPass(seat, Date.now() + 60 * MIN, async (id) => { offered.push(id); return 'native'; }, 'test')).toEqual([]);
    expect(offered).toEqual([]);
  });

  test('a writer-side read (the leg\'s own copy) does not settle: the record stays due', () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const read = readMessage({ dropDir, root: at.root, session: SESSION, seat: 'native' }, ID, at.home);
    expect(read.ok).toBe(true);
    expect(resendCandidates(seatOf(at, dropDir, 'native'), Date.now() + 61_000)).toEqual([ID]);
  });

  test('a dark root has no stamped folder: nothing is a candidate and nothing is offered', async () => {
    const at = made(['native']);
    const dropDir = seatMailDirIn(at.dir, SESSION, 'native');
    mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    const payload: RecordPayload = {
      kind: 'message', id: ID, to: 'native', to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(),
      body: 'legacy', from: 'lead', from_id: null, rule: 'the owner', thread: ID,
    };
    const plain = signRecord(stampedPayload(payload, at.home), at.home);
    expect(plain.payload.lvl).toBeUndefined();
    expect(writeRecord(dropDir, plain).ok).toBe(true);
    age(dropDir, ID, 60 * MIN);
    expect(existsSync(stampedFolder(at, 'native'))).toBe(false);
    const offered: string[] = [];
    expect(await resendPass(seatOf(at, dropDir, 'native'), Date.now(), async (id) => { offered.push(id); return 'native'; }, 'test')).toEqual([]);
    expect(offered).toEqual([]);
    expect(existsSync(join(dropDir, EXPOSURES))).toBe(false);
  });
});

type SceneOptions = {
  seat?: string;
  cli?: string;
  pane?: string;
  ownPane?: string | null;
  typedWake?: RetrySources['typedWake'];
  keyOwner?: RetrySources['keyOwner'];
  screen?: string;
  said?: string[];
};

/** The watch's unread pass, as the daemon runs it, for the fixture team, at `now`. The re-send
 *  adapter is the real one (`resendStampedRecord`, bound with no pane writer, as the watch binds
 *  it) over `host`. */
function passScene(at: World, now: Date, host: SendHost, options: SceneOptions = {}): RetryScene {
  const team = teamOf(at);
  const seat = options.seat ?? 'native';
  const live: Live = { running: true, agents: [{ name: seat, agent: options.cli ?? 'codex', pane: options.pane ?? `pane-${seat}`, workspace: 'w', status: 'idle', cwd: null }], workspaces: [], screens: {} };
  const resendStampedRecord = (send as unknown as Record<string, unknown>).resendStampedRecord as typeof send.resendStampedRecord | undefined;
  const { typedWake: _unbound, ...rest } = host;
  return {
    dir: at.dir, session: SESSION, root: at.root, home: at.home, team, live, ownPane: options.ownPane ?? null, now,
    say: (text) => { options.said?.push(text); },
    sources: {
      screen: () => options.screen ?? null,
      status: () => 'idle',
      typeText: () => { throw new Error('the pass must not type through the raw writer'); },
      pressEnter: () => { throw new Error('the pass must not submit through the raw writer'); },
      sleep: async () => {},
      ...(options.typedWake === undefined ? {} : { typedWake: options.typedWake }),
      ...(options.keyOwner === undefined ? {} : { keyOwner: options.keyOwner }),
    },
    eventLegs: (one: string) => send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat: one, team, now: () => now }),
    // The build before the fix has no re-send adapter: the pass then offers nothing (the finding).
    ...(resendStampedRecord === undefined ? {} : {
      resendStamped: (one, dropDir, id, typedRequest, startAfter) => resendStampedRecord({ host: { ...rest, now: () => now }, dir: at.dir, root: at.root, project: team.project, session: SESSION, seat: one.name, cli: one.cli, dropDir, id, team, typedRequest, ...(startAfter === undefined ? {} : { startAfter }) }),
    }),
  };
}

describe('the finding: a stamped copy to a Codex seat on its native leg, not acknowledged', () => {
  test('the daemon\'s unread pass offers copy 2 after 60 s and copy 3 after 120 s more, numbered; the ack ends it', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    // Copy 1 is the send's own, on the native leg.
    expect(takeCopyNumber(dropDir, ID, 'native')).toBe(1);
    const queue = nativeQueue();
    const host = fake(at, { nativeRoute: queue.route });
    const t0 = Date.now();
    const said: string[] = [];
    await wakeUnreadDrops(passScene(at, new Date(t0 + 30_000), host, { said }), { unreadAfter: 600 });
    expect(queue.copies).toEqual([]);
    await wakeUnreadDrops(passScene(at, new Date(t0 + 61_000), host, { said }), { unreadAfter: 600 });
    expect(queue.copies.map(headerOf)).toEqual([`message ${ID} · delivery 2 — a re-send; an earlier delivery of this message may already have arrived or may still arrive`]);
    expect(queue.copies[0]).toContain(`body of ${ID}`);
    expect(queue.copies[0]).toContain(`team ack ${ID}`);
    expect(said.some((line) => line.includes(`message ${ID} is not acknowledged; offered again on the native (delivery 2)`))).toBe(true);
    // The next wait is 120 s from that offer.
    await wakeUnreadDrops(passScene(at, new Date(t0 + 61_000 + 119_000), host), { unreadAfter: 600 });
    expect(queue.copies).toHaveLength(1);
    await wakeUnreadDrops(passScene(at, new Date(t0 + 61_000 + 121_000), host), { unreadAfter: 600 });
    expect(queue.copies.map(headerOf)[1]).toStartWith(`message ${ID} · delivery 3 — a re-send`);
    expect(copyHistory(dropDir, ID)).toMatchObject({ copies: 3 });
    // The recipient's ack ends the re-sends.
    ack(at, dropDir, 'native', ID);
    await wakeUnreadDrops(passScene(at, new Date(t0 + 60 * MIN), host), { unreadAfter: 600 });
    expect(queue.copies).toHaveLength(2);
  });

  test('a dark root: the pass offers nothing and writes no history (as before)', async () => {
    const at = made(['native']);
    const dropDir = seatMailDirIn(at.dir, SESSION, 'native');
    mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    const payload: RecordPayload = {
      kind: 'message', id: ID, to: 'native', to_id: null, root: at.root, session: SESSION, at: new Date(Date.now() - 60 * MIN).toISOString(),
      body: 'legacy', from: 'lead', from_id: null, rule: 'the owner', thread: ID,
    };
    expect(writeRecord(dropDir, signRecord(payload, at.home)).ok).toBe(true);
    const queue = nativeQueue();
    await wakeUnreadDrops(passScene(at, new Date(Date.now() + 61_000), fake(at, { nativeRoute: queue.route })), { unreadAfter: 600 });
    expect(queue.copies).toEqual([]);
    expect(existsSync(stampedFolder(at, 'native'))).toBe(false);
    expect(existsSync(join(dropDir, EXPOSURES))).toBe(false);
  });

  test('a record bound to another checkout, under the same session and seat names, is never re-sent here', async () => {
    const at = made(['native']);
    activateRoot(at);
    const other = made(['native']);
    activateRoot(other);
    const dropDir = stamped(at, 'native', ID, 'foreign', other.root);
    const queue = nativeQueue();
    const via = await adapter(at, fake(at, { nativeRoute: queue.route }), 'codex', 'native', dropDir)(ID);
    expect(via).toBeNull();
    expect(queue.copies).toEqual([]);
    expect(copyHistory(dropDir, ID)).toMatchObject({ copies: 0 });
  });
});

/** Two passes of the scheduler with the real adapter, the clock moved past each wait. */
async function twoOffers(at: World, seat: string, offer: (id: string) => Promise<string | null>, dropDir: string): Promise<Awaited<ReturnType<typeof resendPass>>[]> {
  const results: Awaited<ReturnType<typeof resendPass>>[] = [];
  for (let n = 0; n < 2; n += 1) {
    age(stampedFolder(at, seat), ID, 31 * MIN);
    results.push(await resendPass(seatOf(at, dropDir, seat), Date.now(), offer, 'watch'));
  }
  return results;
}

/** A guarded typed wake, keyed as the real one: the line is one key and Enter another, each behind
 *  `beforeEachKey`, the first also behind `beforeFirstKey`. It records each line that was typed and
 *  confirms a wake whose Enter went out. */
function typedSeam(lines: string[], result: Partial<TypedWakeResult> = {}, pressed: string[] = []): NonNullable<RetrySources['typedWake']> {
  return async (_pane, line, _cli, _session, options) => {
    const each = (): boolean => options?.beforeEachKey === undefined || options.beforeEachKey();
    if (!each() || (options?.beforeFirstKey !== undefined && !options.beforeFirstKey())) return { delivered: false, typed: false, tries: 0, reason: 'refused before the first key' } as TypedWakeResult;
    lines.push(line);
    if (!each()) return { delivered: false, typed: true, tries: 0, reason: 'the pane changed before Enter; no Enter was pressed', lineWritten: true } as TypedWakeResult;
    pressed.push('Enter');
    return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed', lineWritten: true, ...result } as TypedWakeResult;
  };
}

/** The seat's recorded pane and session, as `team up` leaves them (the incarnation the wake
 *  fence reads). */
function recordPane(at: World, seat: string, pane: string): void {
  writeFileSync(join(at.dir, 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { [seat]: {
    stage: 'ready', pane, agent_session: `session-of-${seat}`, launched: { shell: 111, cli: [222], cli_start: [1_700_000_000_500] }, pane_shell: 111, pane_shell_start: 1_700_000_000_000,
  } }, worktrees: {} } } })}\n`);
}

/** Fresh owner readings for the shared typed path's proof: by default the recorded launch. */
function owner(seat: string, pane: string, change: { agents?: { name: string; pane: string }[] | null; processes?: { shell: number; foreground: number[] } | null; start?: number | null; cliStart?: number | null; afterKeys?: number } = {}): NonNullable<RetrySources['keyOwner']> & { asked: number } {
  const proof = {
    asked: 0,
    agents: (_session: string) => {
      // `afterKeys`: the pane is handed to another seat once that many proofs have passed.
      proof.asked += 1;
      if (change.afterKeys !== undefined && proof.asked > change.afterKeys) return [{ name: 'other', pane }];
      return change.agents === undefined ? [{ name: seat, pane }] : change.agents;
    },
    processes: () => (change.processes === undefined ? { shell: 111, foreground: [222] } : change.processes),
    processStart: (pid: number) => (pid === 111
      ? (change.start === undefined ? 1_700_000_000_000 : change.start)
      : (change.cliStart === undefined ? 1_700_000_000_500 : change.cliStart)),
  };
  return proof;
}

describe('every leg type takes copies 2 and 3, numbered', () => {
  test('native (a Codex seat\'s queue)', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    takeCopyNumber(dropDir, ID, 'native');
    const queue = nativeQueue();
    const results = await twoOffers(at, 'native', adapter(at, fake(at, { nativeRoute: queue.route }), 'codex', 'native', dropDir), dropDir);
    expect(results).toEqual([[{ id: ID, attempt: 1, copy: 2, via: 'native' }], [{ id: ID, attempt: 2, copy: 3, via: 'native' }]]);
    expect(queue.copies.map(numberOf)).toEqual([2, 3]);
  });

  test('typed: the walk stops at its typed leg and the pass\'s own typed wake carries the pointer only; the read is the numbered body', async () => {
    const at = made(['typed', 'socket'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    recordPane(at, 'agy', 'pane-agy');
    const dropDir = stamped(at, 'agy', ID, 'the secret body');
    takeCopyNumber(dropDir, ID, 'typed');
    const lines: string[] = [];
    // The walk's own pane writer would throw: a re-send never types through the walk.
    const host = fake(at, {
      agents: () => [{ name: 'agy', pane: 'pane-agy', cli: 'agy' }],
      typedWake: () => { throw new Error('the walk must not type'); },
    });
    const t0 = Date.now();
    const said: string[] = [];
    for (const offset of [61_000, 61_000 + 121_000]) {
      await wakeUnreadDrops(passScene(at, new Date(t0 + offset), host, { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines), screen: AGY_IDLE, said }), { unreadAfter: 600 });
    }
    // The walk ended at its typed leg (the channel-class legs before it were walked first, as the
    // cascade orders them).
    expect(said.filter((line) => line.includes(`message ${ID} is not acknowledged; offered again on the typed`))).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`message ${ID} · delivery 2: run team drops`);
    expect(lines[1]).toContain(`message ${ID} · delivery 3: run team drops`);
    for (const line of lines) {
      expect(line).not.toContain('the secret body');
      // The wake-attempt fence's token rides on the line (the screen proof).
      expect(line).toMatch(/\[w:[^\]]+\]/);
    }
    expect(attemptLedger(stampedFolder(at, 'agy'), ID).attempts).toBe(2);
    const shown = readMessage({ dropDir, root: at.root, session: SESSION, seat: 'agy' }, ID, at.home);
    if (!shown.ok) throw new Error('the read failed');
    expect(numberOf(shown.body)).toBe(4);
    expect(shown.body).toContain('the secret body');
  });

  test('the re-send pointer renders no wake template: the sender, then the message, its number and team drops, nothing of the body', async () => {
    const at = made(['typed'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    recordPane(at, 'agy', 'pane-agy');
    // A body short enough that the default template's {summary} would carry it whole.
    const dropDir = stamped(at, 'agy', ID, 'tiny');
    takeCopyNumber(dropDir, ID, 'typed');
    const lines: string[] = [];
    await wakeUnreadDrops(passScene(at, new Date(Date.now() + 61_000), fake(at, { agents: () => [] }), { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines), screen: AGY_IDLE }), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\S+ — message ${ID} · delivery 2: run team drops \\[w:[^\\]]+\\]$`));
    expect(lines[0]).not.toContain('tiny');
    expect(lines[0]).not.toContain('Message from');
  });

  test('the shared typed path proves the pane\'s owner at its first key: any mismatch or unreadable reading types nothing', async () => {
    const at = made(['typed'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    recordPane(at, 'agy', 'pane-agy');
    const dropDir = stamped(at, 'agy', ID, 'short');
    takeCopyNumber(dropDir, ID, 'typed');
    const host = fake(at, { agents: () => [] });
    const lines: string[] = [];
    const pass = async (keyOwner: NonNullable<RetrySources['keyOwner']>): Promise<void> => {
      age(stampedFolder(at, 'agy'), ID, 31 * MIN);
      await wakeUnreadDrops(passScene(at, new Date(), host, { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines), screen: AGY_IDLE, keyOwner }), { unreadAfter: 600 });
    };
    // The pane id stays the recorded one each time; what lives in it does not.
    await pass(owner('agy', 'pane-agy', { processes: { shell: 111, foreground: [333] } }));
    await pass(owner('agy', 'pane-agy', { agents: [{ name: 'other', pane: 'pane-agy' }, { name: 'agy', pane: 'pane-9' }] }));
    await pass(owner('agy', 'pane-agy', { start: 1_700_000_000_999 }));
    await pass(owner('agy', 'pane-agy', { processes: null }));
    await pass(owner('agy', 'pane-agy', { agents: null }));
    await pass(owner('agy', 'pane-agy', { start: null }));
    // The same CLI pid under the same shell, born later: a reused pid is not the launch.
    await pass(owner('agy', 'pane-agy', { cliStart: 1_700_000_009_999 }));
    expect(lines).toEqual([]);
    // The pointer's number is taken only inside the proven first-key step: none was taken.
    expect(copyHistory(dropDir, ID)).toMatchObject({ copies: 1 });
    // No re-send was recorded for any of them: every attempt was withdrawn, the record stays due.
    expect(attemptLedger(stampedFolder(at, 'agy'), ID).attempts).toBe(0);
    // The recorded launch, read fresh: the pointer is typed.
    await pass(owner('agy', 'pane-agy'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`message ${ID} · delivery`);
  });

  test('the owner proof is asked before every key: a pane handed over after the line is typed gets no Enter, and no re-send is credited', async () => {
    const at = made(['typed'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    recordPane(at, 'agy', 'pane-agy');
    const dropDir = stamped(at, 'agy', ID, 'short');
    takeCopyNumber(dropDir, ID, 'typed');
    const lines: string[] = [];
    const pressed: string[] = [];
    const said: string[] = [];
    // The first proof (the line's key) passes; the pane belongs to another seat by the Enter.
    await wakeUnreadDrops(passScene(at, new Date(Date.now() + 61_000), fake(at, { agents: () => [] }), { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines, {}, pressed), screen: AGY_IDLE, keyOwner: owner('agy', 'pane-agy', { afterKeys: 1 }), said }), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(pressed).toEqual([]);
    expect(said.some((line) => line.includes('offered again on the typed'))).toBe(false);
  });

  test('two typed requests in one pass: the pointer credits only the id it names; the other is withdrawn and stays due', async () => {
    const at = made(['typed'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    recordPane(at, 'agy', 'pane-agy');
    const dropDir = stamped(at, 'agy', ID, 'first');
    stamped(at, 'agy', ID2, 'second');
    takeCopyNumber(dropDir, ID, 'typed');
    takeCopyNumber(dropDir, ID2, 'typed');
    const lines: string[] = [];
    await wakeUnreadDrops(passScene(at, new Date(Date.now() + 61_000), fake(at, { agents: () => [] }), { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines), screen: AGY_IDLE }), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    const named = lines[0]?.includes(ID) === true ? ID : ID2;
    const other = named === ID ? ID2 : ID;
    expect(attemptLedger(stampedFolder(at, 'agy'), named).attempts).toBe(1);
    expect(attemptLedger(stampedFolder(at, 'agy'), other).attempts).toBe(0);
    const history = readHistory('acme', at.root, at.home);
    expect(history.ok && history.entries.filter((entry) => entry.note?.includes('re-sent on the typed') === true).map((entry) => entry.id)).toEqual([named]);
    expect(resendCandidates(seatOf(at, dropDir, 'agy'), Date.now() + 62_000)).toContain(other);
  });

  test('a typed request is recorded only once its pointer was typed with its token; until then the record stays due', async () => {
    const at = made(['typed'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    recordPane(at, 'agy', 'pane-agy');
    const dropDir = stamped(at, 'agy', ID, 'short');
    takeCopyNumber(dropDir, ID, 'typed');
    const lines: string[] = [];
    const said: string[] = [];
    const t = Date.now() + 61_000;
    // No readable screen: the pass's typed wake types nothing.
    await wakeUnreadDrops(passScene(at, new Date(t), fake(at, { agents: () => [] }), { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines), said }), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    expect(said.some((line) => line.includes('offered again'))).toBe(false);
    const history = readHistory('acme', at.root, at.home);
    expect(history.ok && history.entries.some((entry) => entry.id === ID)).toBe(false);
    expect(attemptLedger(stampedFolder(at, 'agy'), ID).attempts).toBe(0);
    // Still due at once: the next pass asks again.
    expect(resendCandidates(seatOf(at, dropDir, 'agy'), t + 1_000)).toEqual([ID]);
    // Refused before any key, the walk went on past its typed leg in the same pass (here the
    // cascade has only the mailbox after it, so nothing took it).
    const walks: (string | undefined)[] = [];
    const scene = passScene(at, new Date(t + 2_000), fake(at, { agents: () => [] }), { seat: 'agy', cli: 'agy', typedWake: typedSeam(lines) });
    const inner = scene.resendStamped!;
    scene.resendStamped = (one, dir, id, typedRequest, startAfter) => { walks.push(startAfter); return inner(one, dir, id, typedRequest, startAfter); };
    await wakeUnreadDrops(scene, { unreadAfter: 600 });
    expect(walks).toEqual([undefined, 'typed']);
    expect(lines).toEqual([]);
  });

  test('socket (a Claude seat that accepts cross-session frames); the frame names the sender, never the receiver\'s persona', async () => {
    const at = made(null);
    const file = join(at.dir, 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('    name: helper\n', '    name: helper\n    label: "Persona Zed"\n'));
    const path = cliHookSettingsPath(at.dir, SESSION, 'helper');
    if (path === null) throw new Error('the fixture declares no settings path for helper');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
    writeFileSync(join(at.sockets, '222.sock'), '');
    const declaredAt = new Date(Date.now() - 60_000);
    utimesSync(path, declaredAt, declaredAt);
    activateRoot(at);
    const dropDir = stamped(at, 'helper', ID);
    takeCopyNumber(dropDir, ID, 'socket');
    const host = fake(at, { agents: () => [{ name: 'helper', pane: 'pane-helper', cli: 'claude' }] });
    const results = await twoOffers(at, 'helper', adapter(at, host, 'claude-code', 'helper', dropDir), dropDir);
    expect(results).toEqual([[{ id: ID, attempt: 1, copy: 2, via: 'socket' }], [{ id: ID, attempt: 2, copy: 3, via: 'socket' }]]);
    expect(host.frames).toHaveLength(2);
    expect(host.frames[0]).toContain(`message ${ID} · delivery 2 — a re-send`);
    expect(host.frames[1]).toContain(`message ${ID} · delivery 3 — a re-send`);
    for (const frame of host.frames) expect(frame).not.toContain('Persona Zed');
    // A sender whose signed agent id no longer resolves, spelled like the labelled local seat:
    // the frame names its signed spelling, never that seat's persona.
    const unresolved = stamped(at, 'helper', ID2, 'from afar', at.root, { from: 'helper', from_id: 'agt_0123456789ab' });
    takeCopyNumber(unresolved, ID2, 'socket');
    age(stampedFolder(at, 'helper'), ID2, 31 * MIN);
    await resendPass(seatOf(at, unresolved, 'helper'), Date.now(), adapter(at, host, 'claude-code', 'helper', unresolved), 'watch');
    const last = host.frames.at(-1) ?? '';
    expect(last).toContain(`message ${ID2} · delivery 2`);
    expect(last).not.toContain('Persona Zed');
  });

  test('webhook: an earlier 2xx does not stand for a re-send; every attempt is a new request', async () => {
    const hits: string[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => { hits.push(await request.text()); return Response.json({ ok: true }); } });
    cleanups.push(() => server.stop(true));
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-resend-hook-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    writeFileSync(join(base, 'url'), `http://127.0.0.1:${server.port}/routine\n`);
    writeFileSync(join(base, 'secret'), 'synthetic-secret-value\n', { mode: 0o600 });
    const at = made(['socket', 'drop'], [{ name: 'iris', role: 'remote', webhook: { urlFile: join(base, 'url'), secretFile: join(base, 'secret') } }]);
    activateRoot(at);
    const dropDir = stamped(at, 'iris', ID);
    const offer = adapter(at, fake(at, { agents: () => [] }), 'claude-code', 'iris', dropDir);
    // The send's own post, a 2xx.
    expect(await offer(ID)).toBe('webhook');
    expect(hits).toHaveLength(1);
    const results = await twoOffers(at, 'iris', offer, dropDir);
    expect(results.map((one) => one.map((r) => r.via))).toEqual([['webhook'], ['webhook']]);
    expect(hits).toHaveLength(3);
    // An inbox-shaped body names its copy on the carrier; the event shape carries no body at all.
    for (const hit of hits) {
      const sent = JSON.parse(hit) as { delivery?: string; event?: unknown; body?: string };
      if (sent.event === undefined) expect(sent.delivery).toMatch(new RegExp(`^message ${ID} · delivery \\d+`));
      else expect(hit).not.toContain(`body of ${ID}`);
    }
    // The ack ends it.
    ack(at, dropDir, 'iris', ID);
    age(stampedFolder(at, 'iris'), ID, 31 * MIN);
    expect(await resendPass(seatOf(at, dropDir, 'iris'), Date.now(), offer, 'watch')).toEqual([]);
    expect(hits).toHaveLength(3);
  });

  test('webhook, inbox body: a copy number that cannot be recorded posts nothing; the record stays due', async () => {
    const hits: string[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => { hits.push(await request.text()); return Response.json({ ok: true }); } });
    cleanups.push(() => server.stop(true));
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-resend-hook-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    writeFileSync(join(base, 'url'), `http://127.0.0.1:${server.port}/routine\n`);
    writeFileSync(join(base, 'secret'), 'synthetic-secret-value\n', { mode: 0o600 });
    const at = made(['socket', 'drop'], [{ name: 'iris', role: 'remote', webhook: { urlFile: join(base, 'url'), secretFile: join(base, 'secret') } }]);
    const file = join(at.dir, 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(`      secret_file: ${JSON.stringify(join(base, 'secret'))}\n`, `      secret_file: ${JSON.stringify(join(base, 'secret'))}\n      body: inbox\n`));
    activateRoot(at);
    const dropDir = stamped(at, 'iris', ID);
    const offer = adapter(at, fake(at, { agents: () => [] }), 'claude-code', 'iris', dropDir);
    // Numbered: the inbox body names its copy.
    expect(await offer(ID)).toBe('webhook');
    expect(hits).toHaveLength(1);
    expect((JSON.parse(hits[0] ?? '{}') as { delivery?: string; body?: string }).delivery).toBe(`message ${ID} · delivery 1`);
    // The history folder stands but takes no new number: nothing is posted, the record stays due.
    const history = join(stampedFolder(at, 'iris'), EXPOSURES, ID);
    chmodSync(history, 0o500);
    cleanups.unshift(() => chmodSync(history, 0o700));
    expect(await offer(ID)).toBeNull();
    expect(hits).toHaveLength(1);
    expect(copyHistory(dropDir, ID)).toMatchObject({ copies: 1 });
    expect(resendCandidates(seatOf(at, dropDir, 'iris'), Date.now() + 61_000)).toEqual([ID]);
  });

  test('drop-only: an offer carries nothing, and the seat\'s own reads are copies 2 and 3; the ack ends it', async () => {
    const at = made(['drop']);
    activateRoot(at);
    const dropDir = stamped(at, 'helper', ID);
    const read = (): string => {
      const shown = readMessage({ dropDir, root: at.root, session: SESSION, seat: 'helper' }, ID, at.home);
      if (!shown.ok) throw new Error('the read failed');
      return shown.body;
    };
    expect(headerOf(read())).toBe(`message ${ID} · delivery 1`);
    const host = fake(at, { agents: () => [] });
    const results = await twoOffers(at, 'helper', adapter(at, host, 'claude-code', 'helper', dropDir), dropDir);
    // The adapter's walk ends in the mailbox: no copy, no number taken, the attempts counted.
    expect(results).toEqual([[{ id: ID, attempt: 1, copy: null, via: null }], [{ id: ID, attempt: 2, copy: null, via: null }]]);
    expect(host.frames).toEqual([]);
    expect(attemptLedger(stampedFolder(at, 'helper'), ID).attempts).toBe(2);
    expect(headerOf(read())).toStartWith(`message ${ID} · delivery 2 — a re-send`);
    expect(headerOf(read())).toStartWith(`message ${ID} · delivery 3 — a re-send`);
    ack(at, dropDir, 'helper', ID);
    expect(resendCandidates(seatOf(at, dropDir, 'helper'), Date.now() + 60 * MIN)).toEqual([]);
  });
});

describe('the launch record carries the CLI\'s start time', () => {
  test('launchedIdentity records each CLI pid\'s start when it can read them all, and none otherwise', async () => {
    const { launchedIdentity } = await import('../src/launch/identity.ts');
    const pane = { shell: 111, foreground: [111, 222, 223] };
    expect(launchedIdentity(pane, (pid) => pid * 10)).toEqual({ shell: 111, cli: [222, 223], cli_start: [2220, 2230] });
    expect(launchedIdentity(pane, (pid) => (pid === 223 ? null : pid))).toEqual({ shell: 111, cli: [222, 223] });
    expect(launchedIdentity(pane)).toEqual({ shell: 111, cli: [222, 223] });
  });
});

describe('no legacy ladder handles a stamped record', () => {
  test('the held-drop retry neither retries nor gives up a stamped marker, before or past its cutoff; settlement clears it', async () => {
    const at = made(['drop']);
    activateRoot(at);
    const dropDir = stamped(at, 'helper', ID);
    const old = new Date(Date.now() - 10 * MIN).toISOString();
    markPending(dropDir, { ts: old, from: 'lead', to: 'helper', body: `body of ${ID}`, id: ID, leg: 'channel' });
    expect(readPending(dropDir).map((one) => one.id)).toEqual([ID]);
    const redelivered: string[] = [];
    const scene = (now: Date): RetryScene => ({
      ...passScene(at, now, fake(at), { seat: 'helper', cli: 'claude' }),
      socketRedeliver: async (_dir, drop) => { redelivered.push(drop.id); return { ok: true }; },
    });
    await retryHeldDrops(scene(new Date()));
    await retryHeldDrops(scene(new Date(Date.now() + PENDING_MAX_AGE_MS + 60 * MIN)));
    expect(redelivered).toEqual([]);
    expect(readPending(dropDir).map((one) => one.id)).toEqual([ID]);
    const history = readHistory('acme', at.root, at.home);
    expect(history.ok && history.entries.some((entry) => entry.id === ID)).toBe(false);
    ack(at, dropDir, 'helper', ID);
    await retryHeldDrops(scene(new Date()));
    expect(readPending(dropDir)).toEqual([]);
  });
});

describe('the channel: the seat\'s own server runs the same scheduler', () => {
  const FLAG = '--dangerously-load-development-channels server:team-inbox';

  function channelPlace(): { root: string; home: string; dir: string; dropDir: string; leadId: string; workerId: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-resend-channel-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.agents'));
    mkdirSync(join(root, 'home'), { mode: 0o700 });
    writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
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
    vendor: test
    model: Test
    version: "1"
    launch: claude ${FLAG}
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
    writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {} } } })}\n`);
    const home = join(root, 'home');
    const teamId = teamIdOf(root);
    const agents = (['lead', 'worker'] as const).map((seat) => registerAgent(home, {
      name: seat,
      signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'worker' },
      lab: 'test', cli: 'claude-code', launcher: null,
      launch: seat === 'lead' ? `claude ${FLAG}` : 'claude',
      reach: { team: teamId, seat, session: SESSION, pane: `pane-${seat}`, address: null },
      mcp: [], skills: [], lifecycle: 'running', by: 'owner',
    }));
    upsertTeam(home, teamId, { project: 'acme', session: SESSION, root, roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })) });
    return { root, home, dir: join(root, '.agents'), dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'), leadId: agents[0]!.id, workerId: agents[1]!.id };
  }

  function feed(): { lines: AsyncIterable<string>; write(line: string): void; push(line: string): void; end(): void; replies: string[] } {
    const pending: string[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const replies: string[] = [];
    const lines = (async function* () {
      for (;;) {
        if (pending.length > 0) { yield pending.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })();
    const bump = (): void => { const resume = wake; wake = null; resume?.(); };
    return { lines, write: (line) => replies.push(line), push: (line) => { pending.push(line); bump(); }, end: () => { ended = true; bump(); }, replies };
  }

  const notices = (replies: readonly string[]): string[] => replies
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((one) => one.method === 'notifications/claude/channel')
    .map((one) => String(one.params.content));

  async function until(check: () => boolean, limit = 600): Promise<void> {
    for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  test('copies 1, 2 and 3 are pushed after each wait, numbered; the ack ends them; the watch leaves the seat to it', async () => {
    const at = channelPlace();
    activateRoot(at);
    const payload: RecordPayload = {
      kind: 'message', id: ID2, to: 'lead', to_id: at.leadId, root: at.root, session: SESSION, at: new Date().toISOString(),
      body: 'from a worker — admitted by: the owner\n\nplease ack', from: 'worker', from_id: at.workerId, rule: 'the owner', thread: ID2,
    };
    mkdirSync(at.dropDir, { recursive: true, mode: 0o700 });
    expect(writeRecord(at.dropDir, signRecord(stampedPayload(payload, at.home), at.home)).ok).toBe(true);
    const folder = seatMailDirIn(at.dir, SESSION, 'lead', 'stamped');
    // Waiting before the server starts: the prime leaves it, and the scheduler offers it once its
    // first wait from arrival has passed.
    age(folder, ID2, 61_000);
    const io = testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION });
    const stream = feed();
    const running = runMcpServe({ seat: 'lead', session: SESSION, redeliverMs: 20 }, io, stream, { home: at.home });
    await until(() => existsSync(listenerPath(at.dropDir)));
    await until(() => notices(stream.replies).length >= 1);
    expect(notices(stream.replies).map(headerOf)).toEqual([`message ${ID2} · delivery 1`]);
    // Inside the wait (attempt 1 done: 120 s) nothing more is pushed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notices(stream.replies)).toHaveLength(1);
    age(folder, ID2, 121_000);
    await until(() => notices(stream.replies).length >= 2);
    expect(headerOf(notices(stream.replies)[1])).toStartWith(`message ${ID2} · delivery 2 — a re-send`);
    age(folder, ID2, 241_000);
    await until(() => notices(stream.replies).length >= 3);
    expect(headerOf(notices(stream.replies)[2])).toStartWith(`message ${ID2} · delivery 3 — a re-send`);
    // The ownership rule gives this seat to its server: the watch's pass offers nothing for it.
    const loaded = loadTeamFile(at.root, { home: at.home });
    if (!loaded.ok) throw new Error('fixture team failed to load');
    const legs = send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat: 'lead', team: loaded.team, now: () => new Date() });
    expect(channelOwnsSeat({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', walkTakesChannel: legs.channel })).toBe(true);
    const offered: string[] = [];
    const scene: RetryScene = {
      dir: at.dir, session: SESSION, root: at.root, home: at.home, team: loaded.team, ownPane: null, now: new Date(Date.now() + 60 * MIN),
      live: { running: true, agents: [], workspaces: [], screens: {} }, say: () => {},
      sources: { screen: () => null, status: () => 'idle', typeText: () => false, pressEnter: () => false, sleep: async () => {} },
      eventLegs: (seat: string) => send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat, team: loaded.team, now: () => new Date() }),
      resendStamped: async (_seat, _dropDir, id) => { offered.push(id); return null; },
    };
    await wakeUnreadDrops(scene, { unreadAfter: 600 });
    expect(offered).toEqual([]);
    // The ack ends the pushes.
    ack(at, at.dropDir, 'lead', ID2);
    age(folder, ID2, 31 * MIN);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notices(stream.replies)).toHaveLength(3);
    stream.end();
    expect(await running).toBe(0);
  });

  test('a live listener of an older level owns nothing: the watch offers for the seat', () => {
    const at = channelPlace();
    mkdirSync(at.dropDir, { recursive: true, mode: 0o700 });
    const marker = { v: 1, seat: 'lead', session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, channel: true, ts: new Date().toISOString() };
    writeFileSync(listenerPath(at.dropDir), `${JSON.stringify({ ...marker, level: 2 })}\n`);
    expect(channelOwnsSeat({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', walkTakesChannel: true })).toBe(false);
    writeFileSync(listenerPath(at.dropDir), `${JSON.stringify({ ...marker, level: 3 })}\n`);
    expect(channelOwnsSeat({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', walkTakesChannel: true })).toBe(true);
    // The walk does not take the channel: the watch owns the seat whatever the listener is.
    expect(channelOwnsSeat({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', walkTakesChannel: false })).toBe(false);
  });
});
