// The Claude adapter on an active root (§2, §3): F1–F3, F6, F8–F10, with a fake clock.
//
// For a claude-code seat each re-send attempt is decided at its reservation, from live facts: the
// channel push while the seat's channel is proven (a live level-3 listener declaring the channel,
// whose token-ack log holds a proving ack, and no channel offer overdue), and otherwise one typed
// pointer line through the watch's own guarded typed wake. An adapter change makes the record due
// at once; there is one clock, the re-send scheduler's. Only an ack, a reply or a clearance
// settles; a read is a copy. Fixtures only: a synthetic team, a scripted typed seam, no live pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as send from '../src/commands/send.ts';
import { runQueues } from '../src/commands/queues.ts';
import { runWatch } from '../src/commands/watch.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import type { SendHost } from '../src/commands/send.ts';
import { listenerKeyOf, offerAcks, proveOffer } from '../src/comms/offer.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readMessage, writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import { activate, deactivate, queuesFolder, type FloorActor } from '../src/queue/floor.ts';
import { attemptLedger, EXPOSURES, offeredCopies, reserveAttempt, takeCopyNumber } from '../src/queue/handover.ts';
import { nativePendingDir, seatMailDirIn } from '../src/queue/mail-tree.ts';
import { channelUnproven, CHANNEL_OVERDUE_MS, overdueChannelRecords } from '../src/queue/resend.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { clearedFile, leadAckReceiptAt, signReceiptPayload, signRecord, stampedPayload, stampedSettled, stampedSettlement, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { adapterPointerLine, deliverTypedWake, type TypedWakeResult } from '../src/send/typed-wake.ts';
import { acquireSeatLock } from '../src/launch/seat-lock.ts';
import { typedWakeMaxFor } from '../src/send/readable-wake.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { readState } from '../src/state.ts';
import { hostedLoop } from './helpers/hosted-watch.ts';
import { testIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const SEAT = 'helper';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const ID = '5c1a0d0e-0000-4000-8000-0000000ad001';
const OTHER = '9d2b1e0f-0000-4000-8000-0000000ad002';
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
function place(extra: Parameters<typeof world>[1] = [], order: readonly string[] | null = null): Place {
  const at = world(order, extra);
  cleanups.push(at.cleanup);
  expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  const root = realpathSync(at.root);
  const teamId = teamIdOf(root);
  const leadId = registerAgent(at.home, {
    name: 'lead', signing: { model: 'Model', version: 'S 6.2', role: 'coordinator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'claude',
    reach: { team: teamId, seat: 'lead', session: SESSION, pane: 'pane-lead', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }).id;
  upsertTeam(at.home, teamId, { project: 'acme', session: SESSION, root, roster: [{ agent: leadId, seat: 'lead', role: 'coordinator', nickname: 'Wren' }] });
  const seatState = (name: string) => ({
    stage: 'ready', pane: `pane-${name}`, agent_session: `session-of-${name}`, launched: { shell: 111, cli: [222], cli_start: [1_700_000_000_500] }, pane_shell: 111, pane_shell_start: 1_700_000_000_000,
  });
  writeFileSync(join(at.dir, 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { [SEAT]: seatState(SEAT), lead: seatState('lead') }, worktrees: {} } } })}\n`);
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

/** A proving ack for another message, five minutes ago: the channel is proven for this listener. */
function proven(at: Place): void {
  stamped(at, OTHER);
  const token = 'a'.repeat(32);
  pushed(at, OTHER, token);
  ack(at, OTHER, 'channel');
  expect(proveOffer(dropOf(at), OTHER, token, listenerKeyOf(at.listener), { root: at.root, session: SESSION, seat: SEAT, key: keyOf(at.home) }, Date.now() - 300_000)).not.toBeNull();
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
  const ref = id.slice(0, 8);
  expect(line).toStartWith(`team 1 new message from Wren · lead@acme · Model S 6.2 (copy ${String(copy)}${copy > 1 ? ', a re-send' : ''}) — read it with: team show ${ref}, then team ack ${ref}`);
  expect(Buffer.byteLength(line ?? '', 'utf8')).toBeLessThanOrEqual(typedWakeMaxFor('claude-code'));
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

describe('activation and the first guarded pointer', () => {
  for (const recordedStarts of [false, true]) {
    test(`an unproven ${recordedStarts ? 'relaunched' : 'pre-install'} seat gets a pointer in one pass through the real typed helper`, async () => {
      const at = place();
      // A reused workspace predates create-time shell anchors. Relaunch records the new CLI
      // identity but does not recreate that workspace, so both ages can lack these fields.
      const state = readState(at.dir);
      const held = state.sessions[SESSION]!.seats[SEAT]!;
      delete held.pane_shell;
      delete held.pane_shell_start;
      if (!recordedStarts) delete held.launched!.cli_start;
      writeFileSync(join(at.dir, 'team.state.json'), JSON.stringify(state));
      stamped(at, ID);
      const lines: string[] = [];
      const scene = pass(at, new Date(Date.now() + 1_000), lines);
      let entered = false;
      scene.live.screens[`pane-${SEAT}`] = CLAUDE_IDLE;
      scene.sources.keyOwner = {
        agents: () => [{ name: SEAT, pane: `pane-${SEAT}`, session: `session-of-${SEAT}` }],
        processes: () => ({ shell: 111, foreground: [222] }),
        processStart: pid => pid === 111 ? 1_700_000_000_000 : 1_700_000_000_500,
      };
      scene.sources.typedWake = (pane, line, cli, _session, options) => deliverTypedWake({
        read: () => entered
          ? CLAUDE_IDLE.replace('❯', '✻ Working…\n❯')
          : lines.length === 0 ? CLAUDE_IDLE : CLAUDE_IDLE.replace(/❯[^\n]*/, `❯ ${lines[0]}`),
        type: (_pane, text) => { lines.push(text); return true; },
        enter: () => { entered = true; return true; },
        wait: async () => {},
      }, pane, line, cli, { ...options, settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 });
      const io = testIo(at.root, { kind: 'owner' });
      expect(await runWatch(['--file', join(at.dir, 'team.yaml')], io, {
        ...scene.sources,
        live: () => scene.live,
        machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
        standing: () => ({ kind: 'none' }),
        readChecks: () => [],
        foreground: () => ['claude'],
        notify: () => {},
        now: () => scene.now,
        wait: async () => false,
        alive: () => false,
        pid: process.pid,
        home: at.home,
        hosted: hostedLoop(),
      })).toBe(0);
      expectPointer(lines[0], ID, 1);
      expect(entered).toBe(true);
      expect(attemptLedger(stampedOf(at), ID).attempts).toBe(1);
    });
  }

  test('conversation continuity never rescues a missing, ambiguous or contradictory proof', async () => {
    for (const change of [
      { session: undefined },
      { session: 'another-conversation' },
      { session: `session-of-${SEAT}`, duplicate: true },
      { session: `session-of-${SEAT}`, shell: 333 },
      { session: `session-of-${SEAT}`, cliStart: 1_700_000_009_999 },
      { session: `session-of-${SEAT}`, anchor: 'mismatched' },
      { session: `session-of-${SEAT}`, anchor: 'incomplete' },
    ]) {
      const at = place();
      const state = readState(at.dir);
      const held = state.sessions[SESSION]!.seats[SEAT]!;
      if (change.anchor === undefined) delete held.pane_shell;
      if (change.anchor !== 'mismatched') delete held.pane_shell_start;
      else held.pane_shell_start = 1_700_000_009_999;
      writeFileSync(join(at.dir, 'team.state.json'), JSON.stringify(state));
      stamped(at, ID);
      const lines: string[] = [];
      const scene = pass(at, new Date(Date.now() + 1_000), lines);
      scene.sources.keyOwner = {
        agents: () => [
          { name: SEAT, pane: `pane-${SEAT}`, ...(change.session === undefined ? {} : { session: change.session }) },
          ...(change.duplicate ? [{ name: 'another-seat', pane: 'another-pane', session: change.session }] : []),
        ],
        processes: () => ({ shell: change.shell ?? 111, foreground: [222] }),
        processStart: pid => pid === 111 ? 1_700_000_000_000 : change.cliStart ?? 1_700_000_000_500,
      };
      await wakeUnreadDrops(scene, { unreadAfter: 600 });
      expect(lines).toEqual([]);
      expect(attemptLedger(stampedOf(at), ID).attempts).toBe(0);
    }
  });

  function daemonAt(at: Place): void {
    const now = new Date().toISOString();
    writeDaemonState(at.home, {
      format: 1, pid: process.pid, uid: process.getuid!(), since: now, heartbeatAt: now,
      startedBy: 'manual', version: 'b', socket: join(at.home, 'daemon.sock'),
      features: { broker: 'off' }, stuck: [], roots: [], floorLevel: 3,
    });
  }

  function proveSeat(at: Place, seat: string): void {
    stampedTo(at, seat, OTHER);
    const dropDir = seatMailDirIn(at.dir, SESSION, seat);
    const listener = { ...at.listener, seat };
    expect(writeListener(dropDir, listener)).toBe(true);
    const token = 'd'.repeat(32);
    expect(takeCopyNumber(seatMailDirIn(at.dir, SESSION, seat, 'stamped'), OTHER, 'channel', Date.now(), { token, listener: listenerKeyOf(listener) })).not.toBeNull();
    expect(publishRecordRead({ dropDir, id: OTHER, to: seat, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy: 'channel' }).kind).toBe('published');
    expect(proveOffer(dropDir, OTHER, token, listenerKeyOf(listener), { root: at.root, session: SESSION, seat, key: keyOf(at.home) })).not.toBeNull();
  }

  function snapshot(folder: string): string {
    return JSON.stringify(readdirSync(folder, { recursive: true }).map(String).sort().map(name => {
      try { return [name, readFileSync(join(folder, name), 'base64')]; } catch { return [name, 'directory']; }
    }));
  }

  test('activation refuses every unproven Claude seat by name and changes no file', async () => {
    const at = place();
    daemonAt(at);
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    const before = [snapshot(at.root), snapshot(at.home)];
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], io, { home: at.home })).toBe(1);
    expect(io.err).toContain(SEAT);
    expect(io.err).toContain('lead');
    expect(io.err).toContain('no proven channel');
    expect([snapshot(at.root), snapshot(at.home)]).toEqual(before);
  });

  test('activation refuses one unproven Claude seat after the other is proven', async () => {
    const at = place();
    daemonAt(at);
    proveSeat(at, 'lead');
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    const before = [snapshot(at.root), snapshot(at.home)];
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], io, { home: at.home })).toBe(1);
    expect(io.err).toContain(SEAT);
    expect(io.err).not.toContain('lead:');
    expect([snapshot(at.root), snapshot(at.home)]).toEqual(before);
  });

  test('activation succeeds once all Claude seats have proven their current channel', async () => {
    const at = place();
    daemonAt(at);
    proveSeat(at, 'lead');
    proveSeat(at, SEAT);
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], io, { home: at.home })).toBe(0);
    expect(io.out).toContain('activated at level 3');
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

// ---------------------------------------------------------------------------------------------
// Review round 1.

/** A stamped record from the lead to `seat` (the helper unless named). */
function stampedTo(at: Place, seat: string, id: string, fromId: string | null = at.leadId): void {
  const payload: RecordPayload = { kind: 'message', id, to: seat, to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: `the secret body of ${id}`, from: 'lead', from_id: fromId, rule: 'the owner', thread: id };
  const dir = seatMailDirIn(at.dir, SESSION, seat);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  expect(writeRecord(dir, signRecord(stampedPayload(payload, at.home), at.home)).ok).toBe(true);
}

describe('round 1: a protected pane (its declared order leaves typed out) takes zero keys', () => {
  test('no pointer is typed, and team doctor names it as waiting', async () => {
    const at = place([], ['drop']);
    stamped(at, ID);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 31 * 60_000), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    expect(attemptLedger(stampedOf(at), ID).attempts).toBe(0);
    const { runDoctor } = await import('../src/commands/doctor.ts');
    const io = testIo(at.root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, { version: () => '2.1.326', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now: () => new Date(), home: at.home });
    expect(`${io.out}${io.err}`).toContain(`${SEAT}: waiting: protected pane, no proven channel`);
  });
});

describe('round 1: a lead\'s pointer goes through the guarded typed seam', () => {
  test('an unproven idle lead gets the pointer from the seam; the raw writers stay closed', async () => {
    const at = place();
    stampedTo(at, 'lead', ID, null);
    const lines: string[] = [];
    // `pass` binds raw writers that throw: the pointer can only arrive through the seam.
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines, { seat: 'lead' }), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`team 1 new message from lead (copy 1) — read it with: team show ${ID.slice(0, 8)}`);
  });
});

describe('round 1: a pointer needs a positively active floor and an enforcing attempt', () => {
  test('an unreadable floor file, and a deactivation between the reservation and the first key, type nothing', async () => {
    const at = place();
    stamped(at, ID);
    const lines: string[] = [];
    // Deactivated after the pass reserved its attempt, before the first key.
    const scene = pass(at, new Date(Date.now() + 1_000), lines);
    const seamNow = scene.sources.typedWake!;
    scene.sources.typedWake = async (pane, line, cli, session, options) => {
      expect(deactivate(at.root, at.home).kind).toBe('dark');
      return seamNow(pane, line, cli, session, options);
    };
    await wakeUnreadDrops(scene, { unreadAfter: 600 });
    expect(lines).toEqual([]);
    // Active again, then a floor file nobody can read: unknown, so no pointer.
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    writeFileSync(join(queuesFolder(at.root), 'PUBLISHED'), 'not a floor record');
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 31 * 60_000), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
  });
});

describe('round 1: the pointer fits the Claude typed bound and reads the body', () => {
  test('long ASCII and multibyte identities stay inside the bound with room for the token', async () => {
    const max = typedWakeMaxFor('claude-code');
    for (const name of ['x'.repeat(200), '名'.repeat(200), '🙂'.repeat(200)]) {
      const line = adapterPointerLine({ name, address: `${'a'.repeat(60)}@${'b'.repeat(60)}`, model: 'm'.repeat(64) }, ID.slice(0, 8), 2, max);
      expect(line).not.toBeNull();
      expect(Buffer.byteLength(`${line} [w:abcd]`, 'utf8')).toBeLessThanOrEqual(max);
      // The real typed helper does not refuse it for its size.
      const result = await deliverTypedWake({ read: async () => null, wait: async () => {}, type: () => false, enter: () => false }, 'pane', `${line} [w:abcd]`, 'claude-code', {});
      expect(result.reason).not.toContain('does not fit');
    }
  });

  test('a retired sender is named by its signed spelling; team show <ref> serves the body and leaves it pending', async () => {
    const at = place();
    stampedTo(at, SEAT, ID, 'agt_0000000000ff');
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`team 1 new message from lead (copy 1) — read it with: team show ${ID.slice(0, 8)}, then team ack ${ID.slice(0, 8)}`);
    const { runShow } = await import('../src/commands/show.ts');
    const io = testIo(at.root, { kind: 'seat', name: SEAT, pane: `pane-${SEAT}`, session: SESSION });
    expect(await runShow([ID.slice(0, 8)], io, { home: at.home, now: () => new Date() })).toBe(0);
    expect(io.out).toContain(`the secret body of ${ID}`);
    expect(settled(at, ID)).toBe(false);
  });
});

describe('round 1: a silent channel stays unproven after a pointer', () => {
  test('the missed channel offer still counts after the pointer; a new message gets a pointer too', async () => {
    const at = place();
    proven(at);
    stamped(at, ID);
    age(at, ID, CHANNEL_OVERDUE_MS + 1_000);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    // The pointer is the newest offer now; the channel's missed offer still stands.
    expect(unproven(at)).toBe('overdue offer');
    // A later channel attempt does not move the deadline either.
    reserveAttempt(stampedOf(at), ID, 'channel', Date.now());
    expect(unproven(at)).toBe('overdue offer');
    const NEXT = '3e4f5a6b-0000-4000-8000-0000000ad003';
    stamped(at, NEXT);
    // One pointer line per seat per pass: the older record's (its newest offer went by the
    // channel), then the new one's.
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines), { unreadAfter: 600 });
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 2_000), lines), { unreadAfter: 600 });
    expect(lines.some((line) => line.includes(`team show ${NEXT.slice(0, 8)}`))).toBe(true);
  });
});

describe('round 1: --wait reports a clearance and waits behind a busy seat', () => {
  test('a copy, then the lead\'s clearance: cleared by lead', async () => {
    const at = place();
    const io = testIo(at.root, { kind: 'owner' });
    const host = fake(at, { agents: () => [], waitMs: 3_000, sendId: () => ID });
    setTimeout(() => {
      readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home);
    }, 150);
    setTimeout(() => {
      expect(publishRecordRead({ dropDir: dropOf(at), id: ID, to: SEAT, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy: 'lead-ack:lead', lead: 'lead' }).kind).toBe('published');
    }, 500);
    expect(await send.runSend([SEAT, '--wait', 'please ack'], io, host)).toBe(0);
    expect(io.out).toContain(`${SEAT}: cleared by lead`);
  });

  test('a stamped send queued behind a busy seat lock still waits for its ack', async () => {
    const at = place();
    const lock = acquireSeatLock(at.dir, SESSION, SEAT);
    if (!('release' in lock)) throw new Error('the fixture could not take the seat lock');
    try {
      const io = testIo(at.root, { kind: 'owner' });
      const host = fake(at, { agents: () => [], waitMs: 3_000, sendId: () => ID });
      setTimeout(() => ack(at, ID), 400);
      const code = await send.runSend([SEAT, '--wait', 'please ack'], io, host);
      expect(`${code} ${io.out}`).toContain(`${SEAT}: delivered (acked)`);
    } finally {
      lock.release();
    }
  });
});

describe('round 3: the protected panes are found by role and read again at every key', () => {
  test('the entity\'s main orchestrator (the owner\'s pane, found by role) takes zero keys, whatever the order', async () => {
    const at = place([], ['typed', 'drop']);
    // The team whose project is the entity itself: its orchestrator is the entity's main one.
    const file = join(at.dir, 'team.yaml');
    const lobby = resolveLobby(at.home, { entity: 'acme' });
    mkdirSync(lobby, { recursive: true });
    writeFileSync(file, `${readFileSync(file, 'utf8').replace(lobbyDir(at.home), lobby)}entity: acme\n`);
    stampedTo(at, 'lead', ID, null);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 31 * 60_000), lines, { seat: 'lead' }), { unreadAfter: 600 });
    expect(lines).toEqual([]);
  });

  test('another team\'s lead with no declared order gets the pointer through the seam', async () => {
    const at = place();
    stampedTo(at, 'lead', ID, null);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines, { seat: 'lead' }), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`team 1 new message from lead (copy 1) — read it with: team show ${ID.slice(0, 8)}`);
  });

  test('a pane protected between the reservation and the first key takes no key', async () => {
    const at = place();
    stamped(at, ID);
    const lines: string[] = [];
    const scene = pass(at, new Date(Date.now() + 1_000), lines);
    const seamNow = scene.sources.typedWake!;
    scene.sources.typedWake = async (pane, line, cli, session, options) => {
      const file = join(at.dir, 'team.yaml');
      writeFileSync(file, `${readFileSync(file, 'utf8')}delivery_order: [drop]\n`);
      return seamNow(pane, line, cli, session, options);
    };
    await wakeUnreadDrops(scene, { unreadAfter: 600 });
    expect(lines).toEqual([]);
  });
});

describe('round 2: an overdue record stays owed a pointer when another message proves the channel', () => {
  test('the first notification is lost, the second is token-acked before the first deadline; the first still gets its pointer', async () => {
    const at = place();
    // The first arrived 91 s ago and was pushed; nothing acked it.
    stamped(at, ID);
    pushed(at, ID, 'f'.repeat(32));
    age(at, ID, CHANNEL_OVERDUE_MS + 1_000);
    // The second arrived since and was acked with its token: the channel works for new traffic.
    stamped(at, OTHER);
    pushed(at, OTHER, 'a'.repeat(32));
    ack(at, OTHER, 'channel');
    const binding = { root: at.root, session: SESSION, seat: SEAT, key: keyOf(at.home) };
    expect(proveOffer(dropOf(at), OTHER, 'a'.repeat(32), listenerKeyOf(at.listener), binding)).not.toBeNull();
    expect(unproven(at)).toBeNull();
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expectPointer(lines[0], ID, 2);
  });
});

describe('round 3: an overdue record\'s pointer keeps its own clock', () => {
  test('an unconfirmed read just before the deadline does not postpone the pointer', async () => {
    const at = place();
    stamped(at, ID);
    pushed(at, ID, 'f'.repeat(32));
    age(at, ID, CHANNEL_OVERDUE_MS + 1_000);
    stamped(at, OTHER);
    pushed(at, OTHER, 'a'.repeat(32));
    ack(at, OTHER, 'channel');
    expect(proveOffer(dropOf(at), OTHER, 'a'.repeat(32), listenerKeyOf(at.listener), { root: at.root, session: SESSION, seat: SEAT, key: keyOf(at.home) })).not.toBeNull();
    // A writer-side read takes a fresh copy now: it settles nothing and moves no pointer clock.
    expect(readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home).ok).toBe(true);
    expect(settled(at, ID)).toBe(false);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`team show ${ID.slice(0, 8)}`);
  });
});

describe('round 3: a clearance note counts only with the ack it was committed with', () => {
  const ctx = (at: Place) => ({ to: SEAT, root: at.root, session: SESSION, lead: 'lead' });
  test('a note left without its ack (an interrupted pair), and a garbage note, are no clearance', () => {
    const at = place();
    stamped(at, ID);
    expect(readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home).ok).toBe(true);
    // The clearance note alone, as if the ack write never happened.
    const note = signReceiptPayload({ kind: 'receipt', status: 'read', id: ID, to: SEAT, root: at.root, session: SESSION, at: new Date().toISOString(), read_by: 'lead-ack:lead' }, at.home);
    writeFileSync(clearedFile(stampedOf(at), ID), `${JSON.stringify(note, null, 2)}\n`);
    expect(leadAckReceiptAt(stampedOf(at), ID, ctx(at), keyOf(at.home))).toBeNull();
    expect(settled(at, ID)).toBe(false);
    writeFileSync(clearedFile(stampedOf(at), ID), 'not a receipt');
    expect(leadAckReceiptAt(stampedOf(at), ID, ctx(at), keyOf(at.home))).toBeNull();
  });

  test('a recipient ack that wins the name is never reported as the clearer\'s', () => {
    const at = place();
    stamped(at, ID);
    expect(readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home).ok).toBe(true);
    ack(at, ID);
    publishRecordRead({ dropDir: dropOf(at), id: ID, to: SEAT, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy: 'lead-ack:lead', lead: 'lead' });
    expect(stampedSettlement(stampedOf(at), ID, ctx(at), keyOf(at.home))).toEqual({ kind: 'acked' });
    expect(existsSync(clearedFile(stampedOf(at), ID))).toBe(false);
  });

  test('a clearer without authority writes nothing', () => {
    const at = place();
    stamped(at, ID);
    expect(readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home).ok).toBe(true);
    const outcome = publishRecordRead({ dropDir: dropOf(at), id: ID, to: SEAT, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy: 'lead-ack:native', lead: 'lead' });
    expect(outcome.kind).not.toBe('published');
    expect(settled(at, ID)).toBe(false);
  });
});

describe('round 3: the overdue sweep reads history only inside the seat tree', () => {
  test('a fifo attempt entry and a linked seat folder authorize nothing and block nothing', async () => {
    const at = place();
    proven(at);
    stamped(at, ID);
    pushed(at, ID, 'f'.repeat(32));
    age(at, ID, CHANNEL_OVERDUE_MS + 1_000);
    execFileSync('mkfifo', [join(stampedOf(at), EXPOSURES, ID, '.attempt-1')]);
    expect(overdueChannelRecords({ dropDir: dropOf(at), context: { to: SEAT, root: at.root, session: SESSION, lead: 'lead' }, key: keyOf(at.home), nowMs: Date.now() })).toEqual(new Map());
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    // A stamped seat folder that is a link: no history is read through it.
    const real = stampedOf(at);
    const moved = join(at.root, 'moved-seat');
    renameSync(real, moved);
    symlinkSync(moved, real);
    expect(offeredCopies(real, ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Review round 4.

describe('round 4: an unproven seat\'s pointers keep the pointer clock', () => {
  test('a first pointer, then an unconfirmed read just before the next retry: the second pointer is still typed', async () => {
    const at = place();
    stamped(at, ID);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    // The next pointer waits backoffMs(2) = 120 s from the first pointer's reservation.
    age(at, ID, 121_000);
    // A read just now takes a fresh copy: it must not move the pointer clock.
    expect(readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home).ok).toBe(true);
    await wakeUnreadDrops(pass(at, new Date(), lines), { unreadAfter: 600 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`team show ${ID.slice(0, 8)}`);
  });
});

describe('round 4: the clearance intent comes before its ack, and a retry finishes the same pair', () => {
  const ctx = (at: Place) => ({ to: SEAT, root: at.root, session: SESSION, lead: 'lead' });
  test('between the writes no one sees an ack; the retry after a lost ack write reports cleared by lead', () => {
    const at = place();
    stamped(at, ID);
    expect(readMessage({ dropDir: dropOf(at), root: at.root, session: SESSION, seat: SEAT }, ID, at.home).ok).toBe(true);
    // The intent alone, as a clearance whose ack write was lost: a waiter sees nothing settled.
    const intentAt = new Date(Date.now() - 5_000).toISOString();
    const intent = signReceiptPayload({ kind: 'receipt', status: 'read', id: ID, to: SEAT, root: at.root, session: SESSION, at: intentAt, read_by: 'lead-ack:lead' }, at.home);
    writeFileSync(clearedFile(stampedOf(at), ID), `${JSON.stringify(intent, null, 2)}\n`);
    expect(stampedSettlement(stampedOf(at), ID, ctx(at), keyOf(at.home))).toBeNull();
    expect(settled(at, ID)).toBe(false);
    // The retry finishes that pair at the intent's time.
    expect(publishRecordRead({ dropDir: dropOf(at), id: ID, to: SEAT, root: at.root, session: SESSION, home: at.home, key: keyOf(at.home), at: new Date().toISOString(), readBy: 'lead-ack:lead', lead: 'lead' }).kind).toBe('published');
    expect(stampedSettlement(stampedOf(at), ID, ctx(at), keyOf(at.home))).toEqual({ kind: 'cleared', by: 'lead' });
  });
});

describe('round 4: an unproven seat\'s pass never opens a fifo; the proof reader checks the whole chain', () => {
  test('a fifo attempt entry: the unproven pass returns and types nothing; a linked session folder proves nothing', async () => {
    const at = place();
    stamped(at, ID);
    execFileSync('mkfifo', [join(stampedOf(at), EXPOSURES, ID, '.attempt-1')]);
    const lines: string[] = [];
    await wakeUnreadDrops(pass(at, new Date(Date.now() + 1_000), lines), { unreadAfter: 600 });
    expect(lines).toEqual([]);
    // A genuine proof, then the seat's session folder in the stamped tree moved and linked back.
    const binding = { root: at.root, session: SESSION, seat: SEAT, key: keyOf(at.home) };
    stamped(at, OTHER);
    pushed(at, OTHER, 'a'.repeat(32));
    expect(proveOffer(dropOf(at), OTHER, 'a'.repeat(32), listenerKeyOf(at.listener), binding)).not.toBeNull();
    expect(offerAcks(dropOf(at), listenerKeyOf(at.listener), binding)).toHaveLength(1);
    const sessionDir = dirname(stampedOf(at));
    const moved = join(at.root, 'moved-session');
    renameSync(sessionDir, moved);
    symlinkSync(moved, sessionDir);
    expect(offerAcks(dropOf(at), listenerKeyOf(at.listener), binding)).toEqual([]);
  });
});
