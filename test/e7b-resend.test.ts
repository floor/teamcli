// rfc-event-comms E7b (R3.4): the one re-send scheduler. Every stamped record that is not settled
// is offered again through the seat's current adapter after its backoff (60 s, doubling, capped at
// 30 minutes, no attempt cap, no last day), whatever leg the seat takes: a Codex seat's native
// queue, a profile's typed wake, the cross-session socket, the development channel, or none at all
// (a drop-only seat, whose next copy is its own next inbox read). Only an ack, a reply or a
// clearance settles a record; a dark root has nothing for the scheduler.
//
// The live finding this pins (2026-11-18, a test team): a stamped message to a Codex seat that was
// not acknowledged got copy 1 on its native leg and no copy 2 in 11 minutes, because only the
// Claude channel and socket ladders re-sent a stamped copy.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as send from '../src/commands/send.ts';
import type { SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { listenerPath, readMessage } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { backoffMs, copyHistory, EXPOSURES, offerLedger, resendDue, takeCopyNumber } from '../src/queue/handover.ts';
import { seatMailDirIn } from '../src/queue/mail-tree.ts';
import { resendCandidates, resendPass, type ResendSeat } from '../src/queue/resend.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import type { RetryScene } from '../src/watch/retry.ts';
import { testIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const MIN = 60_000;
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const ID = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e71';
const ID2 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e72';

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
 *  folder). Returns the seat's legacy folder, the one every reader starts from. */
function stamped(at: { root: string; dir: string; home: string }, seat: string, id: string, body = `body of ${id}`): string {
  const payload: RecordPayload = {
    kind: 'message', id, to: seat, to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(),
    body, from: 'lead', from_id: null, rule: 'the owner', thread: id,
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
  return { dropDir, context: { to: seat, root: at.root, session: SESSION, lead: 'lead' }, key: keyOf(at.home) };
}

/** Moves the record's whole delivery history (its copies, the offer ledger and the record's own
 *  arrival) `ms` into the past, as if that much time had gone by. */
function age(folder: string, id: string, ms: number): void {
  const history = join(folder, EXPOSURES, id);
  if (existsSync(history)) {
    for (const name of readdirSync(history)) {
      const path = join(history, name);
      if (name === '.offers') {
        const ledger = JSON.parse(readFileSync(path, 'utf8')) as { n: number; at: string };
        writeFileSync(path, `${JSON.stringify({ v: 1, n: ledger.n, at: new Date(Date.parse(ledger.at) - ms).toISOString() })}\n`);
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

const headerOf = (text: string | undefined): string => (text ?? '').split('\n')[0] ?? '';


describe('the schedule: from the delivery history, 60 s doubling to 30 minutes, no cap, no last day', () => {
  test('backoff after each attempt, counted from the newest copy or offer', () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const folder = stampedFolder(at, 'native');
    const now = Date.now();
    // No copy yet: the send's own delivery is not doubled; one first backoff from arrival.
    expect(resendDue(folder, ID, now + 59_000, now)).toBe(false);
    expect(resendDue(folder, ID, now + 60_000, now)).toBe(true);
    // Copy 1 now: due 60 s on, not before.
    expect(takeCopyNumber(dropDir, ID, 'native')).toBe(1);
    expect(resendDue(folder, ID, now + 30_000, now)).toBe(false);
    expect(resendDue(folder, ID, now + 61_000, now)).toBe(true);
    // Copy 2: the wait doubles to 120 s.
    expect(takeCopyNumber(dropDir, ID, 'native')).toBe(2);
    expect(resendDue(folder, ID, now + 119_000, now)).toBe(false);
    expect(resendDue(folder, ID, now + 121_000, now)).toBe(true);
    expect([1, 2, 3, 4, 5, 6, 10, 40].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
  });

  test('an offer that carried no copy still counts as an attempt and spaces the next one', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const folder = stampedFolder(at, 'native');
    takeCopyNumber(dropDir, ID, 'native');
    const seat = seatOf(at, dropDir, 'native');
    const offers: string[] = [];
    const none = async (id: string) => { offers.push(id); return null; };
    const t0 = Date.now() + 61_000;
    expect(await resendPass(seat, t0, none)).toEqual([{ id: ID, copy: null, via: null }]);
    expect(offerLedger(folder, ID)).toEqual({ offers: 1, lastMs: t0 });
    // Copy 1 and the offer are one attempt each: the wait stays 60 s, from the newest of them.
    await resendPass(seat, t0 + 59_000, none);
    expect(offers).toHaveLength(1);
    await resendPass(seat, t0 + 60_000, none);
    expect(offers).toHaveLength(2);
    expect(offerLedger(folder, ID).offers).toBe(2);
    // Two attempts: 120 s.
    await resendPass(seat, t0 + 60_000 + 119_000, none);
    expect(offers).toHaveLength(2);
    await resendPass(seat, t0 + 60_000 + 120_000, none);
    expect(offers).toHaveLength(3);
    // No cap: twenty offers on, the wait is 30 minutes and it is still offered.
    let t = t0 + 60_000 + 120_000;
    for (let n = 0; n < 20; n += 1) {
      t += 30 * MIN;
      await resendPass(seat, t, none);
    }
    expect(offers).toHaveLength(23);
    expect(resendDue(folder, ID, t + 30 * MIN - 1, null)).toBe(false);
    expect(resendDue(folder, ID, t + 30 * MIN, null)).toBe(true);
  });

  test('no last day: a record weeks old is still due; an ack, a reply or a clearance ends it', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    const folder = stampedFolder(at, 'native');
    age(folder, ID, 30 * 24 * 60 * MIN);
    const seat = seatOf(at, dropDir, 'native');
    expect(resendCandidates(seat, Date.now())).toEqual([ID]);
    ack(at, dropDir, 'native', ID);
    expect(resendCandidates(seat, Date.now() + 60 * MIN)).toEqual([]);
    const offered: string[] = [];
    expect(await resendPass(seat, Date.now() + 60 * MIN, async (id) => { offered.push(id); return 'native'; })).toEqual([]);
    expect(offered).toEqual([]);
  });

  test('a writer-side read (the leg\'s own copy) does not settle: the record stays due', async () => {
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
    expect(await resendPass(seatOf(at, dropDir, 'native'), Date.now(), async (id) => { offered.push(id); return 'native'; })).toEqual([]);
    expect(offered).toEqual([]);
    expect(existsSync(join(dropDir, EXPOSURES))).toBe(false);
  });
});

/** The watch's unread pass, as the daemon runs it, for the fixture team, at `now`. The re-send
 *  adapter is the real one (`resendStampedRecord`) over a send host whose Codex queue records. */
function passScene(at: World, now: Date, host: SendHost, said: string[] = []): RetryScene {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('fixture team failed to load');
  const team = loaded.team;
  const live: Live = { running: true, agents: [{ name: 'native', agent: 'codex', pane: 'pane-native', workspace: 'w', status: 'idle', cwd: null }], workspaces: [], screens: {} };
  const resendStampedRecord = (send as unknown as Record<string, unknown>).resendStampedRecord as typeof send.resendStampedRecord | undefined;
  return {
    dir: at.dir, session: SESSION, root: at.root, home: at.home, team, live, ownPane: null, now,
    say: (text) => { said.push(text); },
    sources: {
      screen: () => null,
      status: () => 'idle',
      typeText: () => { throw new Error('the pass must not type into a pane here'); },
      pressEnter: () => { throw new Error('the pass must not submit a pane here'); },
      sleep: async () => {},
    },
    eventLegs: (seat: string) => send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat, team, now: () => now }),
    // The build before the fix has no re-send adapter: the pass then offers nothing (the finding).
    ...(resendStampedRecord === undefined ? {} : {
      resendStamped: (seat, dropDir, id) => resendStampedRecord({ host: { ...host, now: () => now }, dir: at.dir, root: at.root, project: team.project, session: SESSION, seat: seat.name, cli: seat.cli, dropDir, id, team }),
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
    await wakeUnreadDrops(passScene(at, new Date(t0 + 30_000), host, said), { unreadAfter: 600 });
    expect(queue.copies).toEqual([]);
    await wakeUnreadDrops(passScene(at, new Date(t0 + 61_000), host, said), { unreadAfter: 600 });
    expect(queue.copies.map(headerOf)).toEqual([`message ${ID} · delivery 2 — a re-send; an earlier delivery of this message may already have arrived or may still arrive`]);
    expect(queue.copies[0]).toContain(`body of ${ID}`);
    expect(queue.copies[0]).toContain(`team ack ${ID}`);
    expect(said.some((line) => line.includes(`message ${ID} is not acknowledged; offered again on the native (delivery 2)`))).toBe(true);
    // The next wait is 120 s from that offer.
    await wakeUnreadDrops(passScene(at, new Date(t0 + 61_000 + 119_000), host), { unreadAfter: 600 });
    expect(queue.copies).toHaveLength(1);
    await wakeUnreadDrops(passScene(at, new Date(t0 + 61_000 + 120_000), host), { unreadAfter: 600 });
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
});

/** Runs the scheduler with the real adapter for one seat until three copies stand or `passes`
 *  passes are spent, advancing the clock past each wait. */
async function threeOffers(at: World, seat: string, cli: string, host: SendHost, dropDir: string): Promise<{ results: Awaited<ReturnType<typeof resendPass>>[] }> {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('fixture team failed to load');
  const team = loaded.team;
  const results: Awaited<ReturnType<typeof resendPass>>[] = [];
  const folder = stampedFolder(at, seat);
  for (let n = 0; n < 2; n += 1) {
    // Past the wait of every attempt so far.
    age(folder, ID, 31 * MIN);
    results.push(await resendPass(seatOf(at, dropDir, seat), Date.now(), (id) => send.resendStampedRecord({
      host, dir: at.dir, root: at.root, project: team.project, session: SESSION, seat, cli, dropDir, id, team,
    })));
  }
  return { results };
}

describe('every leg type takes copies 2 and 3, numbered', () => {
  test('native (a Codex seat\'s queue)', async () => {
    const at = made(['native']);
    activateRoot(at);
    const dropDir = stamped(at, 'native', ID);
    takeCopyNumber(dropDir, ID, 'native');
    const queue = nativeQueue();
    const { results } = await threeOffers(at, 'native', 'codex', fake(at, { nativeRoute: queue.route }), dropDir);
    expect(results).toEqual([[{ id: ID, copy: 2, via: 'native' }], [{ id: ID, copy: 3, via: 'native' }]]);
    expect(queue.copies.map(headerOf).map((line) => line.slice(0, `message ${ID} · delivery 2`.length))).toEqual([`message ${ID} · delivery 2`, `message ${ID} · delivery 3`]);
  });

  test('typed (a profile\'s typed wake into an idle pane: Antigravity\'s agent prompt)', async () => {
    const at = made(['typed'], [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    activateRoot(at);
    const dropDir = stamped(at, 'agy', ID, 'short');
    takeCopyNumber(dropDir, ID, 'typed');
    const fixtures = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
    const idle = readFileSync(join(fixtures, 'idle.txt'), 'utf8');
    const working = readFileSync(join(fixtures, 'working-synthetic.txt'), 'utf8');
    const prompted: string[] = [];
    const wake = (): TypedWakeHost => {
      let mine = 0;
      return {
        read: () => (mine > 0 ? working : idle),
        type: () => false,
        enter: () => false,
        prompt: (_pane, line) => { prompted.push(line); mine += 1; return true; },
        wait: async () => {},
      };
    };
    const host = fake(at, { agents: () => [{ name: 'agy', pane: 'pane-agy', cli: 'agy' }], typedWake: wake, wakeVerifyMs: 50, wakePollMs: 1 });
    const { results } = await threeOffers(at, 'agy', 'antigravity', host, dropDir);
    expect(results).toEqual([[{ id: ID, copy: 2, via: 'typed' }], [{ id: ID, copy: 3, via: 'typed' }]]);
    expect(prompted.map(headerOf).map((line) => line.slice(0, `message ${ID} · delivery 2`.length))).toEqual([`message ${ID} · delivery 2`, `message ${ID} · delivery 3`]);
    expect(prompted[0]).toContain(`team ack ${ID}`);
  });

  test('typed, a body whose numbered copy does not fit the wake: the pointer is typed, no number is taken, the read is the copy', async () => {
    const at = made(['typed'], [{ name: 'typist', role: 'implementer', cli: 'muse', launch: 'muse' }]);
    activateRoot(at);
    const dropDir = stamped(at, 'typist', ID, 'short');
    const idle = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'idle.txt'), 'utf8');
    const working = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'working-synthetic.txt'), 'utf8');
    const typed: string[] = [];
    const wake = (): TypedWakeHost => {
      const state = { enters: 0, typed: 0 };
      return {
        read: () => (state.enters > 0 ? working : state.typed > 0 ? idle.replace('❯\n', `❯ ${typed.at(-1) ?? ''}\n`) : idle),
        type: (_pane, text) => { typed.push(text); state.typed += 1; return true; },
        enter: () => { state.enters += 1; return true; },
        wait: async () => {},
      };
    };
    const host = fake(at, { agents: () => [{ name: 'typist', pane: 'pane-typist', cli: 'muse' }], typedWake: wake, wakeVerifyMs: 50, wakePollMs: 1 });
    const { results } = await threeOffers(at, 'typist', 'muse', host, dropDir);
    expect(results).toEqual([[{ id: ID, copy: null, via: 'typed' }], [{ id: ID, copy: null, via: 'typed' }]]);
    expect(typed).toHaveLength(2);
    for (const line of typed) {
      expect(line).toContain(`--id ${ID}`);
      expect(line).not.toContain('short');
    }
    const shown = readMessage({ dropDir, root: at.root, session: SESSION, seat: 'typist' }, ID, at.home);
    if (!shown.ok) throw new Error('the read failed');
    expect(headerOf(shown.body)).toBe(`message ${ID} · delivery 1`);
  });

  test('socket (a Claude seat that accepts cross-session frames)', async () => {
    const at = made(null);
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
    const { results } = await threeOffers(at, 'helper', 'claude-code', host, dropDir);
    expect(results).toEqual([[{ id: ID, copy: 2, via: 'socket' }], [{ id: ID, copy: 3, via: 'socket' }]]);
    expect(host.frames).toHaveLength(2);
    expect(host.frames[0]).toContain(`message ${ID} · delivery 2 — a re-send`);
    expect(host.frames[1]).toContain(`message ${ID} · delivery 3 — a re-send`);
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
    const { results } = await threeOffers(at, 'helper', 'claude-code', host, dropDir);
    // The adapter's walk ends in the mailbox: no copy, no number taken, the offers counted.
    expect(results).toEqual([[{ id: ID, copy: null, via: null }], [{ id: ID, copy: null, via: null }]]);
    expect(host.frames).toEqual([]);
    expect(offerLedger(stampedFolder(at, 'helper'), ID).offers).toBe(2);
    expect(headerOf(read())).toStartWith(`message ${ID} · delivery 2 — a re-send`);
    expect(headerOf(read())).toStartWith(`message ${ID} · delivery 3 — a re-send`);
    ack(at, dropDir, 'helper', ID);
    expect(resendCandidates(seatOf(at, dropDir, 'helper'), Date.now() + 60 * MIN)).toEqual([]);
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
    // Inside the 60 s wait nothing more is pushed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notices(stream.replies)).toHaveLength(1);
    age(folder, ID2, 61_000);
    await until(() => notices(stream.replies).length >= 2);
    expect(headerOf(notices(stream.replies)[1])).toStartWith(`message ${ID2} · delivery 2 — a re-send`);
    age(folder, ID2, 121_000);
    await until(() => notices(stream.replies).length >= 3);
    expect(headerOf(notices(stream.replies)[2])).toStartWith(`message ${ID2} · delivery 3 — a re-send`);
    // The watch's pass leaves this seat to its server: its live channel leads the walk.
    const loaded = loadTeamFile(at.root, { home: at.home });
    if (!loaded.ok) throw new Error('fixture team failed to load');
    expect(send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat: 'lead', team: loaded.team, now: () => new Date() }).channel).toBe(true);
    const offered: string[] = [];
    const scene: RetryScene = {
      dir: at.dir, session: SESSION, root: at.root, home: at.home, team: loaded.team, ownPane: null, now: new Date(Date.now() + 60 * MIN),
      live: { running: true, agents: [], workspaces: [], screens: {} }, say: () => {},
      sources: { screen: () => null, status: () => 'idle', typeText: () => false, pressEnter: () => false, sleep: async () => {} },
      eventLegs: (seat: string) => send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat, team: loaded.team, now: () => new Date() }),
      resendStamped: async (_seat, _dropDir, id) => { offered.push(id); return null; },
    };
    await wakeUnreadDrops(scene, { unreadAfter: 600, noNudge: false });
    expect(offered).toEqual([]);
    // The ack ends the pushes.
    ack(at, at.dropDir, 'lead', ID2);
    age(folder, ID2, 31 * MIN);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notices(stream.replies)).toHaveLength(3);
    stream.end();
    expect(await running).toBe(0);
  });
});
