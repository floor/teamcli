// rfc-event-comms E7b: at-least-once activation. A stamped record is settled only
// by its recipient (ack, reply, clearance); every copy names its message and its delivery number;
// a re-send says so; the stamp is decided at signing (stamp unless proven dark); activation needs
// every actor at level 3 and an older actor rolls the root back to dark; the rollback is one
// command and resumable; retention never moves an unsettled stamped record while its seat exists.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage } from '../src/mcp/inbox.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { ackedFile, isRead, isStampedPayload, recordAuthOf, recordStampAt, signRecord, stampedPayload, type RecordPayload } from '../src/send/record.ts';
import { activate, checkActors, deactivate, floorState, queuesFolder, type FloorActor } from '../src/queue/floor.ts';
import { backoffMs, copyHistory, deliveryDue, deliveryHeader, takeCopyNumber, unwrapCopy, wrapCopy, EXPOSURES } from '../src/queue/handover.ts';
import { exposeBody } from '../src/queue/exposure.ts';
import { planSeatArchive } from '../src/send/inbox-retention.ts';
import { seatRetired, undeliveredNoticeId } from '../src/daemon/chores/inbox-archive.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const e7aServer: FloorActor = { kind: 'inbox-server', name: 'acme/lead', pid: 2, build: 'e7a', level: 2 };
const M1 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e01';
const M2 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e02';

type At = { root: string; home: string; dropDir: string };

function place(): At {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  return { root, home, dropDir };
}

function payloadOf(at: At, id: string): RecordPayload {
  return { kind: 'message', id, to: 'lead', to_id: null, root: at.root, session: SESSION, at: '2026-11-18T00:00:01.000Z', body: `body of ${id}`, from: 'worker', from_id: null, rule: 'the owner', thread: id };
}

function write(at: At, id: string): void {
  writeFileSync(join(at.dropDir, id), `${JSON.stringify(signRecord(stampedPayload(payloadOf(at, id), at.home), at.home), null, 2)}\n`, { mode: 0o600 });
}

const activateRoot = (at: At, actors: FloorActor[] = [daemon]) => activate(at.root, { home: at.home, build: 'b', actors: () => actors });
const context = (at: At) => ({ to: 'lead', root: at.root, session: SESSION });
const key = (at: At) => {
  const state = messageKeyState(at.home);
  if (state.kind !== 'key') throw new Error('no key');
  return state.key;
};
const read = (at: At, id: string, readBy?: string) => publishRecordRead({
  dropDir: at.dropDir, id, to: 'lead', root: at.root, session: SESSION, home: at.home, key: key(at), at: new Date().toISOString(),
  ...(readBy === undefined ? {} : { readBy }),
});

describe('the stamp, decided at signing (decision 3: stamp unless proven dark)', () => {
  test('a dark root signs no stamp; an active root stamps', () => {
    const at = place();
    expect(stampedPayload(payloadOf(at, M1), at.home).lvl).toBeUndefined();
    expect(activateRoot(at).kind).toBe('activated');
    expect(stampedPayload(payloadOf(at, M1), at.home).lvl).toBe(3);
    write(at, M1);
    expect(recordStampAt(at.dropDir, M1)).toBe(true);
  });

  test('an unknown floor stamps (an activated team never loses the guarantee to an unreadable floor)', () => {
    const at = place();
    mkdirSync(queuesFolder(at.root), { recursive: true });
    // ACTIVATION without PROTOCOL is no state any order makes: unknown.
    writeFileSync(join(queuesFolder(at.root), 'ACTIVATION'), '{"payload":{},"signature":"x"}\n');
    expect(floorState(at.root, at.home).kind).toBe('unknown');
    expect(stampedPayload(payloadOf(at, M1), at.home).lvl).toBe(3);
  });

  test('the stamp is inside the signed bytes: stripping it breaks the signature', () => {
    const at = place();
    activateRoot(at);
    const signed = signRecord(stampedPayload(payloadOf(at, M1), at.home), at.home);
    const raw = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
    expect(recordAuthOf(raw, key(at)).kind).toBe('ok');
    delete raw.payload.lvl;
    expect(recordAuthOf(raw, key(at)).kind).toBe('tampered');
  });

  test('the stamp survives a rollback: a record signed while active stays stamped after deactivate', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    expect(floorState(at.root, at.home).kind).toBe('dark');
    expect(recordStampAt(at.dropDir, M1)).toBe(true);
    // A record signed after the rollback is unstamped.
    write(at, M2);
    expect(recordStampAt(at.dropDir, M2)).toBe(false);
  });
});

describe('settlement: only the recipient settles a stamped record (R3.1, R4.3)', () => {
  test('a writer-side read does not settle; the ack does', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    expect(read(at, M1).kind).toBe('published');
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
    // The ack finds the read name taken by the unconfirmed read: it writes the acked name.
    expect(read(at, M1, 'ack').kind).toBe('published');
    expect(existsSync(ackedFile(at.dropDir, M1))).toBe(true);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(true);
    expect(read(at, M1, 'ack').kind).toBe('served');
  });

  test('an ack with the read name free settles at the read name', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    expect(read(at, M1, 'channel').kind).toBe('published');
    expect(existsSync(ackedFile(at.dropDir, M1))).toBe(false);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(true);
  });

  test('an unstamped record keeps legacy settlement', () => {
    const at = place();
    write(at, M1);
    expect(read(at, M1).kind).toBe('published');
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(true);
  });

  test('an unconfirmed read stays unsettled across deactivate, a restart of the reader and reactivation', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    read(at, M1);
    deactivate(at.root, at.home);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
    activateRoot(at);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
    expect(read(at, M1, 'ack').kind).toBe('published');
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(true);
  });

  test('a stamped record takes no exclusive claim and is never answered with a pointer', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    expect(exposeBody({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', msgId: M1 }, 'channel', at.home).kind).toBe('legacy');
  });
});

describe('numbered copies (R4.1)', () => {
  test('every read of an unacknowledged stamped record is one more numbered copy; a re-send says so', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    const target = { dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead' };
    const first = readMessage(target, M1, at.home);
    expect(first.ok).toBe(true);
    const firstBody = first.ok ? first.body : '';
    expect(firstBody.startsWith(`message ${M1} · delivery 1\n`)).toBe(true);
    expect(firstBody).toContain(`team ack ${M1}`);
    const second = readMessage(target, M1, at.home);
    expect(second.ok).toBe(true);
    expect(second.ok ? second.body : '').toContain(`message ${M1} · delivery 2 — a re-send`);
    read(at, M1, 'ack');
    const after = readMessage(target, M1, at.home);
    expect(after.ok).toBe(false);
  });

  test('an unstamped record is shown exactly as before (no header)', () => {
    const at = place();
    write(at, M1);
    const shown = readMessage({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead' }, M1, at.home);
    expect(shown.ok ? shown.body.startsWith('message ') : true).toBe(false);
  });

  test('numbers are taken once each, durably, and the history is never rewritten', () => {
    const at = place();
    expect(takeCopyNumber(at.dropDir, M1, 'channel')).toBe(1);
    expect(takeCopyNumber(at.dropDir, M1, 'socket')).toBe(2);
    expect(takeCopyNumber(at.dropDir, M1, 'read')).toBe(3);
    expect(readdirSync(join(at.dropDir, EXPOSURES, M1)).filter(n => !n.startsWith('.')).sort()).toEqual(['1', '2', '3']);
    expect(copyHistory(at.dropDir, M1)).toMatchObject({ copies: 3 });
  });

  test('a rival that took the next number makes this copy take the one after', () => {
    const at = place();
    mkdirSync(join(at.dropDir, EXPOSURES, M1), { recursive: true });
    writeFileSync(join(at.dropDir, EXPOSURES, M1, '1'), '{"leg":"typed"}\n');
    expect(takeCopyNumber(at.dropDir, M1, 'channel')).toBe(2);
  });

  test('a history that cannot be read sends no copy now (X3 defer) and stays due', () => {
    const at = place();
    mkdirSync(join(at.dropDir, EXPOSURES), { recursive: true });
    writeFileSync(join(at.dropDir, EXPOSURES, M1), 'not a folder\n');
    expect(copyHistory(at.dropDir, M1)).toBe('unknown');
    expect(takeCopyNumber(at.dropDir, M1, 'channel')).toBeNull();
    expect(deliveryDue(at.dropDir, M1, Date.now())).toBe(true);
  });

  test('the header and ack line come off again for a body comparison', () => {
    expect(unwrapCopy(wrapCopy('the body', M1, 2), M1)).toBe('the body');
    expect(unwrapCopy('the body', M1)).toBe('the body');
    expect(deliveryHeader(M1, 1)).toBe(`message ${M1} · delivery 1`);
  });
});

describe('retry: due from history, no attempt cap (R3.4)', () => {
  test('backoff doubles from 60 s and stays at 30 minutes', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(6)).toBe(30 * 60_000);
    expect(backoffMs(60)).toBe(30 * 60_000);
  });

  test('a record with no copy is due; one just sent is not; one past its backoff is again', () => {
    const at = place();
    expect(deliveryDue(at.dropDir, M1, Date.now())).toBe(true);
    takeCopyNumber(at.dropDir, M1, 'channel');
    expect(deliveryDue(at.dropDir, M1, Date.now())).toBe(false);
    expect(deliveryDue(at.dropDir, M1, Date.now() + 61_000)).toBe(true);
  });
});

describe('activation and the one-command rollback (decision 2, §3)', () => {
  test('activation refuses while an actor below level 3 is live', () => {
    const at = place();
    const outcome = activateRoot(at, [daemon, e7aServer]);
    expect(outcome.kind).toBe('refused');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });

  test('an older actor seen after activation rolls the root back to dark', () => {
    const at = place();
    activateRoot(at);
    expect(floorState(at.root, at.home).kind).toBe('active');
    expect(checkActors(at.root, at.home, [daemon, e7aServer]).kind).toBe('dark');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });

  test('an unreadable actor list rolls back too', () => {
    const at = place();
    activateRoot(at);
    expect(checkActors(at.root, at.home, null).kind).toBe('dark');
  });

  for (const step of ['begin', 'reader', 'published', 'record', 'marker', 'fenced'] as const) {
    test(`a rollback cut off after ${step} leaves no active root, refuses activation, and resumes`, () => {
      const at = place();
      activateRoot(at);
      expect(() => deactivate(at.root, at.home, { after: (s) => { if (s === step) throw new Error('crash'); } })).toThrow('crash');
      const state = floorState(at.root, at.home).kind;
      expect(state === 'unknown' || state === 'dark').toBe(true);
      expect(activateRoot(at).kind).toBe('refused');
      expect(deactivate(at.root, at.home).kind).toBe('dark');
      expect(floorState(at.root, at.home).kind).toBe('dark');
      expect(activateRoot(at).kind).toBe('activated');
    });
  }

  test('deactivate on a dark root writes nothing', () => {
    const at = place();
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    expect(existsSync(join(queuesFolder(at.root), 'DEACTIVATING'))).toBe(false);
  });
});

describe('retention (decision 4)', () => {
  const plan = (at: At, options: { unreadKeepMs?: number | null; retired?: boolean }) => {
    const planned = planSeatArchive(at.dropDir, 'lead', context(at), key(at), Date.parse('2026-12-30T00:00:00.000Z'), null, options);
    if ('refused' in planned) throw new Error(planned.refused);
    return planned;
  };

  test('an unsettled stamped record never moves while its seat exists, stopped included', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    read(at, M1); // a writer-side read, two days and more old by the plan's clock
    expect(plan(at, { unreadKeepMs: 14 * 86_400_000 }).move).toEqual([]);
  });

  test('a retired seat\'s unacknowledged stamped record moves, marked undelivered for its sender', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    const moved = plan(at, { unreadKeepMs: 14 * 86_400_000, retired: true }).move;
    expect(moved.length).toBe(1);
    expect(moved[0]?.unread).toBe(true);
    expect(moved[0]?.undelivered).toEqual({ from: 'worker' });
  });

  test('an acknowledged stamped record moves as settled mail', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    read(at, M1, 'ack');
    const moved = plan(at, {}).move;
    expect(moved.length).toBe(1);
    expect(moved[0]?.unread).toBeUndefined();
  });

  test('a stopped seat is not retired; a seat gone from the team and registry is', () => {
    const team = { session: SESSION, seats: [{ name: 'lead', stopped: true }] } as unknown as Parameters<typeof seatRetired>[2];
    expect(seatRetired([], 't', team, 'lead')).toBe(false);
    expect(seatRetired([], 't', team, 'gone')).toBe(true);
    expect(undeliveredNoticeId(M1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(undeliveredNoticeId(M1)).toBe(undeliveredNoticeId(M1));
  });
});

describe('the channel: one attempt retired so the next numbered copy can be pushed (R2.4)', () => {
  test('the push, emitted and abort markers move into the history, never deleted', async () => {
    const { retireChannelAttempt, channelPushPath, channelEmittedPath, channelAbortPath } = await import('../src/mcp/channel.ts');
    const at = place();
    for (const path of [channelPushPath(at.dropDir, M1), channelEmittedPath(at.dropDir, M1), channelAbortPath(at.dropDir, M1)]) writeFileSync(path, `{"id":"${M1}"}\n`);
    expect(retireChannelAttempt(at.dropDir, M1, 1_000)).toBe(true);
    for (const path of [channelPushPath(at.dropDir, M1), channelEmittedPath(at.dropDir, M1), channelAbortPath(at.dropDir, M1)]) expect(existsSync(path)).toBe(false);
    const kept = readdirSync(join(at.dropDir, EXPOSURES, M1)).filter(n => n.startsWith('c1000.'));
    expect(kept.length).toBe(3);
    // A retirement with nothing standing is done (idempotent).
    expect(retireChannelAttempt(at.dropDir, M1, 2_000)).toBe(true);
    // The retired evidence does not count as a numbered copy.
    expect(copyHistory(at.dropDir, M1)).toMatchObject({ copies: 0 });
  });
});

describe('code round 1 fixes', () => {
  test('a leg numbers the exact payload it was handed, whatever the floor says later (no recomputation)', async () => {
    const { legBody } = await import('../src/send/readable-wake.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    const stamped = stampedPayload(payloadOf(at, M1), at.home);
    deactivate(at.root, at.home);
    const body = legBody(stamped, at.home, 'native', at.dropDir);
    expect(body.carriesBody).toBe(true);
    expect(body.text?.startsWith(`message ${M1} · delivery 1`)).toBe(true);
  });

  test('a leg whose history cannot be written carries no body (the pointer), never the raw body', async () => {
    const { legBody, legText } = await import('../src/send/readable-wake.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    mkdirSync(join(at.dropDir, EXPOSURES), { recursive: true });
    writeFileSync(join(at.dropDir, EXPOSURES, M1), 'not a folder\n');
    const stamped = stampedPayload(payloadOf(at, M1), at.home);
    const body = legBody(stamped, at.home, 'typed', at.dropDir);
    expect(body.carriesBody).toBe(false);
    expect(legText(body, stamped)).not.toContain(`body of ${M1}`);
  });

  test('a general seat brief is never stamped (it keeps its own lifecycle)', () => {
    const at = place();
    activateRoot(at);
    const brief = { ...payloadOf(at, M1), brief_sha256: 'a'.repeat(64), incarnation: 'i0000000000000001' };
    expect(stampedPayload(brief, at.home).lvl).toBeUndefined();
  });

  test('the channel offers again every due unsettled stamped record, marker or not', async () => {
    const { channelRedeliveryDue } = await import('../src/mcp/serve.ts');
    const { channelAbortPath } = await import('../src/mcp/channel.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    write(at, M2);
    writeFileSync(channelAbortPath(at.dropDir, M2), `{"id":"${M2}"}\n`);
    const serving = { dropDir: at.dropDir, seat: 'lead', root: at.root, session: SESSION, home: at.home };
    // Just arrived, no copy yet: the arrival's own push is not doubled.
    expect(channelRedeliveryDue(serving, Date.now())).toEqual([]);
    // A minute on, both are due: M1 never pushed (its first history write failed, say), M2 aborted.
    const later = Date.now() + 61_000;
    expect(channelRedeliveryDue(serving, later).sort()).toEqual([M1, M2].sort());
    // A copy just taken is not due until its backoff; an acknowledged record is never due.
    takeCopyNumber(at.dropDir, M1, 'channel');
    read(at, M2, 'ack');
    expect(channelRedeliveryDue(serving, Date.now() + 1_000)).toEqual([]);
    expect(channelRedeliveryDue(serving, Date.now() + 61_000)).toEqual([M1]);
  });

  test('a retired seat\'s not-delivered notices are reconciled from its archive, once each', async () => {
    const { noticeUndelivered } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const archived = join(at.dropDir, 'archive', '2026-11', 'unread');
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    writeFileSync(join(archived, M1), `${JSON.stringify(signRecord(stampedPayload(payloadOf(at, M1), at.home), at.home), null, 2)}\n`, { mode: 0o600 });
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'worker' }, { name: 'boss' }] } as unknown as Parameters<typeof noticeUndelivered>[0]['team'];
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', dropDir: at.dropDir, team, context: context(at), key: key(at), at: new Date().toISOString() };
    // No registry: the sender cannot be resolved by its agent id, so the team's lead is told.
    expect(noticeUndelivered(input)).toBe(1);
    expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'boss', undeliveredNoticeId(M1)))).toBe(true);
    // A second pass (after a crash, or a failed first write) finds the notice and writes no other.
    expect(noticeUndelivered(input)).toBe(0);
  });

  test('the not-delivered notice goes to the sender resolved by its signed agent id, not by a reused seat name', async () => {
    const { noticeUndelivered } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const archived = join(at.dropDir, 'archive', '2026-11', 'unread');
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    const payload = stampedPayload({ ...payloadOf(at, M1), from_id: 'agt_000000000007' }, at.home);
    writeFileSync(join(archived, M1), `${JSON.stringify(signRecord(payload, at.home), null, 2)}\n`, { mode: 0o600 });
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'worker' }, { name: 'boss' }, { name: 'worker-2' }] } as unknown as Parameters<typeof noticeUndelivered>[0]['team'];
    // The agent that sent it now sits at worker-2; a replacement holds the name `worker`.
    const agents = [
      { id: 'agt_000000000007', reach: { team: 't', seat: 'worker-2', session: SESSION }, lifecycle: 'running' },
      { id: 'agt_000000000008', reach: { team: 't', seat: 'worker', session: SESSION }, lifecycle: 'running' },
    ] as unknown as NonNullable<Parameters<typeof noticeUndelivered>[0]['agents']>;
    expect(noticeUndelivered({ home: at.home, root: at.root, session: SESSION, seat: 'lead', dropDir: at.dropDir, team, context: context(at), key: key(at), at: new Date().toISOString(), agents, teamId: 't' })).toBe(1);
    expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'worker-2', undeliveredNoticeId(M1)))).toBe(true);
    expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'worker', undeliveredNoticeId(M1)))).toBe(false);
  });

  test('a stamped record with a plain (no reader word) read stays unsettled for the scheduler and retention', async () => {
    const { channelRedeliveryDue } = await import('../src/mcp/serve.ts');
    const { signReceiptPayload, receiptFile, stampedSettled } = await import('../src/send/record.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    const plain = signReceiptPayload({ kind: 'receipt', status: 'read', id: M1, to: 'lead', root: at.root, session: SESSION, at: new Date().toISOString() }, at.home);
    writeFileSync(receiptFile(at.dropDir, M1, 'read'), `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 });
    expect(stampedSettled(at.dropDir, M1, context(at), key(at))).toBe(false);
    const serving = { dropDir: at.dropDir, seat: 'lead', root: at.root, session: SESSION, home: at.home };
    expect(channelRedeliveryDue(serving, Date.now() + 61_000)).toEqual([M1]);
    const planned = planSeatArchive(at.dropDir, 'lead', context(at), key(at), Date.parse('2026-12-30T00:00:00.000Z'), null, { unreadKeepMs: 14 * 86_400_000 });
    expect('move' in planned ? planned.move : null).toEqual([]);
    // The recipient's ack settles it.
    expect(read(at, M1, 'ack').kind).toBe('published');
    expect(stampedSettled(at.dropDir, M1, context(at), key(at))).toBe(true);
  });

  test('an unrelated outbound send (answered-by-send) does not settle a stamped record; a reply does', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    expect(read(at, M1, 'answered-by-send').kind).toBe('published');
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
    expect(read(at, M1, 'reply').kind).toBe('published');
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(true);
  });
});

describe('code round 3 fixes', () => {
  const plainRead = async (at: At, id: string, readBy?: string) => {
    const { signReceiptPayload, receiptFile } = await import('../src/send/record.ts');
    const plain = signReceiptPayload({ kind: 'receipt', status: 'read', id, to: 'lead', root: at.root, session: SESSION, at: new Date().toISOString(), ...(readBy === undefined ? {} : { read_by: readBy }) }, at.home);
    writeFileSync(receiptFile(at.dropDir, id, 'read'), `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 });
  };

  test('a delivered stamped record with a plain read stays in the listing and is served again by an exact-id read', async () => {
    const { listUnread } = await import('../src/mcp/inbox.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    takeCopyNumber(at.dropDir, M1, 'channel'); // delivered once, numbered
    await plainRead(at, M1);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
    expect(listUnread(at.dropDir, context(at), at.home).map((m) => m.id)).toEqual([M1]);
    const shown = readMessage({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead' }, M1, at.home);
    expect(shown.ok ? shown.body : '').toContain(`message ${M1} · delivery 2 — a re-send`);
  });

  test('a clearance counts only with its authority: a lead-ack naming another seat does not settle', async () => {
    const { stampedSettled, LEAD_ACK_PREFIX } = await import('../src/send/record.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    await plainRead(at, M1, `${LEAD_ACK_PREFIX}intruder`);
    expect(stampedSettled(at.dropDir, M1, { ...context(at), lead: 'boss' }, key(at))).toBe(false);
    await plainRead(at, M1, `${LEAD_ACK_PREFIX}boss`);
    expect(stampedSettled(at.dropDir, M1, { ...context(at), lead: 'boss' }, key(at))).toBe(true);
    await plainRead(at, M1, `${LEAD_ACK_PREFIX}owner`);
    expect(stampedSettled(at.dropDir, M1, context(at), key(at))).toBe(true);
  });

  test('the notice follows the sender\'s current session, and an archived notice is never written again', async () => {
    const { noticeUndelivered } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const archived = join(at.dropDir, 'archive', '2026-11', 'unread');
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    writeFileSync(join(archived, M1), `${JSON.stringify(signRecord(stampedPayload({ ...payloadOf(at, M1), from_id: 'agt_000000000007' }, at.home), at.home), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(archived, M2), `${JSON.stringify(signRecord(stampedPayload({ ...payloadOf(at, M2), from_id: 'agt_000000000007' }, at.home), at.home), null, 2)}\n`, { mode: 0o600 });
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'worker' }, { name: 'boss' }] } as unknown as Parameters<typeof noticeUndelivered>[0]['team'];
    const agents = [{ id: 'agt_000000000007', reach: { team: 't', seat: 'worker', session: 'other' }, lifecycle: 'running' }] as unknown as NonNullable<Parameters<typeof noticeUndelivered>[0]['agents']>;
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', dropDir: at.dropDir, team, context: context(at), key: key(at), at: new Date().toISOString(), agents, teamId: 't' };
    // M2's notice was written earlier (a genuine signed runtime notice) and has since been archived
    // from the sender's folder.
    const { writeRuntimeNotice } = await import('../src/send/endpoint-notice.ts');
    const senderDir = join(at.root, '.agents', 'send-drops', 'other', 'worker');
    const genuine = writeRuntimeNotice({ home: at.home, root: at.root, session: 'other', lead: 'worker', id: undeliveredNoticeId(M2), body: `not delivered: seat retired (lead). The message ${M2} from worker was never acknowledged.`, at: new Date().toISOString() });
    expect(genuine.ok).toBe(true);
    mkdirSync(join(senderDir, 'archive', '2026-11'), { recursive: true });
    renameSync(join(senderDir, undeliveredNoticeId(M2)), join(senderDir, 'archive', '2026-11', undeliveredNoticeId(M2)));
    expect(noticeUndelivered(input)).toBe(1);
    expect(existsSync(join(senderDir, undeliveredNoticeId(M1)))).toBe(true);
    expect(existsSync(join(senderDir, undeliveredNoticeId(M2)))).toBe(false);
    expect(existsSync(join(archived, `${M1}.noticed`))).toBe(true);
    expect(existsSync(join(archived, `${M2}.noticed`))).toBe(true);
    expect(noticeUndelivered(input)).toBe(0);
  });

  test('an occupied but unverifiable notice name leaves the obligation pending', async () => {
    const { noticeUndelivered } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const archived = join(at.dropDir, 'archive', '2026-11', 'unread');
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    writeFileSync(join(archived, M1), `${JSON.stringify(signRecord(stampedPayload(payloadOf(at, M1), at.home), at.home), null, 2)}\n`, { mode: 0o600 });
    const bossDir = join(at.root, '.agents', 'send-drops', SESSION, 'boss');
    mkdirSync(bossDir, { recursive: true });
    writeFileSync(join(bossDir, undeliveredNoticeId(M1)), '{}\n');
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof noticeUndelivered>[0]['team'];
    expect(noticeUndelivered({ home: at.home, root: at.root, session: SESSION, seat: 'lead', dropDir: at.dropDir, team, context: context(at), key: key(at), at: new Date().toISOString() })).toBe(0);
    expect(existsSync(join(archived, `${M1}.noticed`))).toBe(false);
  });

  test('a stamped record written through the record writer carries its era folder: a plain read never hides it from the listing', async () => {
    const { listUnread } = await import('../src/mcp/inbox.ts');
    const { writeRecord } = await import('../src/send/record.ts');
    const at = place();
    activateRoot(at);
    expect(writeRecord(at.dropDir, signRecord(stampedPayload(payloadOf(at, M1), at.home), at.home)).ok).toBe(true);
    expect(existsSync(join(at.dropDir, EXPOSURES, M1))).toBe(true);
    expect(copyHistory(at.dropDir, M1)).toMatchObject({ copies: 0 });
    await plainRead(at, M1);
    expect(listUnread(at.dropDir, context(at), at.home).map((m) => m.id)).toEqual([M1]);
  });
});

describe('closing items after round 4', () => {
  const archive = (at: At, ids: string[]) => {
    const archived = join(at.dropDir, 'archive', '2026-11', 'unread');
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    for (const id of ids) writeFileSync(join(archived, id), `${JSON.stringify(signRecord(stampedPayload(payloadOf(at, id), at.home), at.home), null, 2)}\n`, { mode: 0o600 });
    return archived;
  };
  const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof import('../src/daemon/chores/inbox-archive.ts').noticeUndelivered>[0]['team'];

  test('a stray, unsigned "notice sent" mark counts as absent: the notice is written and the mark replaced', async () => {
    const { noticeUndelivered } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const archived = archive(at, [M1]);
    writeFileSync(join(archived, `${M1}.noticed`), '{}\n');
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', dropDir: at.dropDir, team, context: context(at), key: key(at), at: new Date().toISOString() };
    expect(noticeUndelivered(input)).toBe(1);
    expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'boss', undeliveredNoticeId(M1)))).toBe(true);
    expect(readFileSync(join(archived, `${M1}.noticed`), 'utf8')).toContain('notice-mark');
    expect(noticeUndelivered(input)).toBe(0);
  });

  test('the reconcile walks a bounded step and resumes from its cursor', async () => {
    const { noticeUndeliveredFrom } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    archive(at, [M1, M2]);
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', dropDir: at.dropDir, team, context: context(at), key: key(at), at: new Date().toISOString(), limit: 1 };
    const first = noticeUndeliveredFrom(input);
    expect(first).toMatchObject({ written: 1, more: true });
    const second = noticeUndeliveredFrom({ ...input, after: first.last as string });
    expect(second).toMatchObject({ written: 1 });
    expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'boss', undeliveredNoticeId(M2)))).toBe(true);
  });
});
