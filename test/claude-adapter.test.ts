// The Claude adapter on an active root (§2, §3): F1–F3, F6, F8–F10, with a fake clock.
//
// For a claude-code seat each re-send attempt is decided at its reservation, from live facts: the
// channel push while the seat's channel is proven (a live level-3 listener declaring the channel,
// whose token-ack log holds a proving ack, and no channel offer overdue), and otherwise one typed
// pointer line through the watch's own guarded typed wake. An adapter change makes the record due
// at once; there is one clock, the re-send scheduler's. Only an ack, a reply or a clearance
// settles; a read is a copy. Fixtures only: a synthetic team, a scripted typed seam, no live pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as send from '../src/commands/send.ts';
import type { SendHost } from '../src/commands/send.ts';
import { listenerKeyOf, proveOffer } from '../src/comms/offer.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readMessage, writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import { activate, deactivate, type FloorActor } from '../src/queue/floor.ts';
import { attemptLedger, EXPOSURES, takeCopyNumber } from '../src/queue/handover.ts';
import { nativePendingDir, seatMailDirIn } from '../src/queue/mail-tree.ts';
import { channelUnproven, CHANNEL_OVERDUE_MS } from '../src/queue/resend.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord, stampedPayload, stampedSettled, writeRecord, type RecordPayload } from '../src/send/record.ts';
import type { TypedWakeResult } from '../src/send/typed-wake.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { testIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const SEAT = 'helper';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const ID = '5c1a0d0e-0000-4000-8000-0000000ad001';
const OTHER = '5c1a0d0e-0000-4000-8000-0000000ad002';
const CLAUDE_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', '2.1.326', 'idle.txt'), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

type Place = World & { leadId: string; listener: InboxListener };

function keyOf(home: string) {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('no message key');
  return state.key;
}

/** An active root whose `helper` (a Claude seat) has a recorded pane and a live level-3 channel
 *  listener, and whose `lead` is a registered sender. */
function place(extra: Parameters<typeof world>[1] = []): Place {
  const at = world(null, extra);
  cleanups.push(at.cleanup);
  expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  const root = realpathSync(at.root);
  const teamId = teamIdOf(root);
  const leadId = registerAgent(at.home, {
    name: 'lead', signing: { model: 'Model', version: 'S 6.2', role: 'coordinator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'claude',
    reach: { team: teamId, seat: 'lead', session: SESSION, pane: 'pane-lead', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }).id;
  upsertTeam(at.home, teamId, { project: 'acme', session: SESSION, root, roster: [{ agent: leadId, seat: 'lead', role: 'coordinator', nickname: 'Wren' }] });
  writeFileSync(join(at.dir, 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { [SEAT]: {
    stage: 'ready', pane: `pane-${SEAT}`, agent_session: `session-of-${SEAT}`, launched: { shell: 111, cli: [222], cli_start: [1_700_000_000_500] }, pane_shell: 111, pane_shell_start: 1_700_000_000_000,
  } }, worktrees: {} } } })}\n`);
  const dropDir = seatMailDirIn(at.dir, SESSION, SEAT);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const listener: InboxListener = { v: 1, seat: SEAT, session: SESSION, root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), channel: true, level: 3 };
  expect(writeListener(dropDir, listener)).toBe(true);
  return { ...at, root, leadId, listener };
}

function dropOf(at: Place): string {
  return seatMailDirIn(at.dir, SESSION, SEAT);
}

function stampedOf(at: Place): string {
  return seatMailDirIn(at.dir, SESSION, SEAT, 'stamped');
}

/** A stamped record from the lead to the helper, through the record writer. */
function stamped(at: Place, id: string): void {
  const payload: RecordPayload = { kind: 'message', id, to: SEAT, to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: `the secret body of ${id}`, from: 'lead', from_id: at.leadId, rule: 'the owner', thread: id };
  const signed = signRecord(stampedPayload(payload, at.home), at.home);
  expect(signed.payload.lvl).toBe(3);
  expect(writeRecord(dropOf(at), signed).ok).toBe(true);
}

/** The channel push the seat's server makes: copy n with an offer, under this listener. */
function pushed(at: Place, id: string, token: string): number {
  const n = takeCopyNumber(stampedOf(at), id, 'channel', Date.now(), { token, listener: listenerKeyOf(at.listener) });
  if (n === null) throw new Error('no copy number');
  return n;
}

/** A proving ack for another message: the channel is proven for this listener. */
function proven(at: Place): void {
  stamped(at, OTHER);
  const token = 'a'.repeat(32);
  pushed(at, OTHER, token);
  ack(at, OTHER, 'channel');
  expect(proveOffer(dropOf(at), OTHER, token, listenerKeyOf(at.listener))).not.toBeNull();
}

function ack(at: Place, id: string, readBy: 'ack' | 'channel' = 'ack'): void {
  expect(publishRecordRead({ dropDir: dropOf(at), id, to: SEAT, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy }).kind).toBe('published');
}

/** Moves the record's arrival and history `ms` into the past. */
function age(at: Place, id: string, ms: number): void {
  const folder = stampedOf(at);
  const then = new Date(Date.now() - ms);
  utimesSync(join(folder, id), then, then);
  const history = join(folder, EXPOSURES, id);
  if (!existsSync(history)) return;
  for (const name of readdirSync(history)) {
    const path = join(history, name);
    if (/^\.attempt-\d+$/.test(name)) {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as { at: string };
      chmodSync(path, 0o600);
      writeFileSync(path, `${JSON.stringify({ ...entry, at: new Date(Date.parse(entry.at) - ms).toISOString() })}\n`);
    } else if (/^\d+$/.test(name)) {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as { at: string };
      chmodSync(path, 0o600);
      writeFileSync(path, `${JSON.stringify({ ...entry, at: new Date(Date.parse(entry.at) - ms).toISOString() })}\n`);
      utimesSync(path, then, then);
    } else {
      utimesSync(path, then, then);
    }
  }
}

function unproven(at: Place): string | null {
  return channelUnproven({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT, context: { to: SEAT, root: at.root, session: SESSION, lead: 'lead' }, key: keyOf(at.home), nowMs: Date.now() });
}

function settled(at: Place, id: string): boolean {
  return stampedSettled(stampedOf(at), id, { to: SEAT, root: at.root, session: SESSION, lead: 'lead' }, keyOf(at.home));
}

/** The typed seam: records each line; the line and its Enter each pass the per-key proof. */
function seam(lines: string[]): NonNullable<RetrySources['typedWake']> {
  return async (_pane, line, _cli, _session, options) => {
    if ((options?.beforeEachKey !== undefined && !options.beforeEachKey()) || (options?.beforeFirstKey !== undefined && !options.beforeFirstKey())) {
      return { delivered: false, typed: false, tries: 0, reason: 'refused before the first key' } as TypedWakeResult;
    }
    lines.push(line);
    return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed', lineWritten: true } as TypedWakeResult;
  };
}

/** The watch's unread pass at `now`, as the daemon runs it, for the helper. */
function pass(at: Place, now: Date, lines: string[], options: { status?: string; seat?: string } = {}): RetryScene {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('fixture team failed to load');
  const team = loaded.team;
  const seat = options.seat ?? SEAT;
  const status = options.status ?? 'idle';
  const live: Live = { running: true, agents: [{ name: seat, agent: 'claude', pane: `pane-${seat}`, workspace: 'w', status, cwd: null }], workspaces: [], screens: {} };
  const host: SendHost = fake(at, { agents: () => [{ name: seat, pane: `pane-${seat}`, cli: 'claude' }] });
  const { typedWake: _unbound, ...rest } = host;
  return {
    dir: at.dir, session: SESSION, root: at.root, home: at.home, team, live, ownPane: null, now,
    say: () => {},
    sources: {
      screen: () => CLAUDE_IDLE,
      status: () => status,
      typeText: () => { throw new Error('the pass must not type through the raw writer'); },
      pressEnter: () => { throw new Error('the pass must not submit through the raw writer'); },
      sleep: async () => {},
      typedWake: seam(lines),
    },
    eventLegs: (one: string) => send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat: one, team, now: () => now }),
    resendStamped: (one, dropDir, id, typedRequest, startAfter) => send.resendStampedRecord({ host: { ...rest, now: () => now }, dir: at.dir, root: at.root, project: team.project, session: SESSION, seat: one.name, cli: one.cli, dropDir, id, team, typedRequest, ...(startAfter === undefined ? {} : { startAfter }) }),
  };
}

function expectPointer(line: string | undefined, id: string, copy: number): void {
  expect(line).toBeDefined();
  expect(line).toStartWith(`team 1 new message from Wren · lead@acme · Model S 6.2 (copy ${String(copy)}${copy > 1 ? ', a re-send' : ''}) — read it with: team drops, then team ack ${id}`);
  expect(line).not.toContain('the secret body');
  expect(line).not.toContain('\n');
}

describe('F1: a listener that declares the channel but never proves it', () => {
  test('a resume without the flag: the server marks pushes, nothing acks with a token; the next attempt is a pointer, and nothing settles without the seat', async () => {
    const at = place();
    stamped(at, ID);
    pushed(at, ID, 'b'.repeat(32));
    expect(unproven(at)).toBe('unproven since launch');
    const lines: string[] = [];
    // The record's newest offer went by the channel and the seat is unproven: due at once.
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expectPointer(lines[0], ID, 2);
    expect(settled(at, ID)).toBe(false);
    expect(attemptLedger(stampedOf(at), ID).attempts).toBe(1);
  });
});

describe('F2: a proven channel that drops notifications', () => {
  test('no pointer while the channel is proven; 90 s after the offer started the seat is unproven and the pointer follows in that sweep', async () => {
    const at = place();
    proven(at);
    stamped(at, ID);
    pushed(at, ID, 'c'.repeat(32));
    expect(unproven(at)).toBeNull();
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 30_000), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    age(at, ID, CHANNEL_OVERDUE_MS + 1_000);
    expect(unproven(at)).toBe('overdue offer');
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expectPointer(lines[0], ID, 2);
  });
});

describe('F3: the push stalls before any copy is written', () => {
  test('overdue 90 s from the arrival, with no copy at all; the pointer is copy 1', async () => {
    const at = place();
    proven(at);
    stamped(at, ID);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    age(at, ID, CHANNEL_OVERDUE_MS + 1_000);
    expect(unproven(at)).toBe('overdue offer');
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expectPointer(lines[0], ID, 1);
  });
});

describe('F6: a read is a copy; --wait ends on the settlement', () => {
  test('inbox_read with its response lost leaves the record pending; --wait keeps waiting; a later ack settles it: delivered (acked)', async () => {
    const at = place();
    const io = testIo(at.root, { kind: 'owner' });
    const host = fake(at, { agents: () => [], waitMs: 3_000, sendId: () => ID });
    const started = Date.now();
    let readAt = 0;
    setTimeout(() => {
      // The seat reads it (a copy); the response is lost: nothing settles.
      readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home);
      readAt = Date.now();
      expect(settled(at, ID)).toBe(false);
    }, 200);
    setTimeout(() => ack(at, ID), 700);
    const code = await send.runSend([SEAT, '--wait', 'please ack'], io, host);
    expect(readAt).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    expect(code).toBe(0);
    expect(io.out).toContain(`${SEAT}: delivered (acked)`);
    expect(settled(at, ID)).toBe(true);
  });
});

describe('F8: protected panes', () => {
  test('a human pane takes zero keys, whatever is due', async () => {
    const at = place([{ name: 'person', role: 'implementer', human: true }]);
    const payload: RecordPayload = { kind: 'message', id: ID, to: 'person', to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: 'for a person', from: 'lead', from_id: at.leadId, rule: 'the owner', thread: ID };
    const personDir = seatMailDirIn(at.dir, SESSION, 'person');
    mkdirSync(personDir, { recursive: true, mode: 0o700 });
    expect(writeRecord(personDir, signRecord(stampedPayload(payload, at.home), at.home)).ok).toBe(true);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 31 * 60_000), lines, { seat: 'person' }), { unreadAfter: 600 });
    expect(lines).toEqual([]);
  });
});

describe('F9: a pointer typed, then a crash', () => {
  test('no new attempt before the backoff; the repeat is numbered as a re-send; deactivate and reactivate keep the attempt history', async () => {
    const at = place();
    stamped(at, ID);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expectPointer(lines[0], ID, 1);
    // The next pass, inside the backoff from the pointer's attempt: nothing.
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 2_000), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    const before = attemptLedger(stampedOf(at), ID).attempts;
    expect(deactivate(at.root, at.home).kind).not.toBe('failed');
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    expect(attemptLedger(stampedOf(at), ID).attempts).toBe(before);
    age(at, ID, 121_000);
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(2);
    expectPointer(lines[1], ID, 2);
  });
});

describe('F10: a seat working when an attempt is due', () => {
  test('no keys mid-turn; the pointer is typed at the next pass that finds it idle', async () => {
    const at = place();
    stamped(at, ID);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines, { status: 'working' }), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 2_000), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expectPointer(lines[0], ID, 1);
  });
});

describe('a proven seat belongs to its channel server', () => {
  test('the watch types nothing for a proven seat inside the overdue window', async () => {
    const at = place();
    proven(at);
    stamped(at, ID);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 61_000), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
  });
});

describe('a declared order is ignored for a Claude receiver on an active root', () => {
  test('native, socket and typed words walk nothing: no handoff, no frame, no key; the record is stored for the pointer', async () => {
    const at = place();
    writeFileSync(join(at.sockets, '222.sock'), '');
    const io = testIo(at.root, { kind: 'owner' });
    const host = fake(at, { sendId: () => ID, delivery: { seat: ['native', 'socket', 'typed'] } });
    await send.runSend([SEAT, 'hello'], io, host);
    expect(host.frames).toEqual([]);
    expect(existsSync(join(nativePendingDir(at.root), `${ID}.json`))).toBe(false);
    expect(existsSync(join(stampedOf(at), ID))).toBe(true);
  });
});
