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
import { ackedFile, isRead, isStampedPayload, receiptFile, recordAuthOf, recordStampAt, signReceiptPayload, signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { activate, checkActors, deactivate, floorState, queuesFolder, type FloorActor } from '../src/queue/floor.ts';
import { backoffMs, copyHistory, deliveryHeader, resendDue, takeCopyNumber, unwrapCopy, wrapCopy, EXPOSURES } from '../src/queue/handover.ts';
import { seatMailDirIn } from '../src/queue/mail-tree.ts';
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

/** A stamped record through the record writer: it lands in the seat's stamped folder (revision 3). */
function writeStamped(at: At, id: string): void {
  const written = writeRecord(at.dropDir, signRecord(stampedPayload(payloadOf(at, id), at.home), at.home));
  if (!written.ok) throw new Error(written.reason);
}

const stampedDir = (at: At): string => seatMailDirIn(join(at.root, '.agents'), SESSION, 'lead', 'stamped');

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
  test('a writer-side read does not settle and writes no receipt; the ack writes the one receipt', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    expect(read(at, M1).kind).toBe('published');
    expect(existsSync(receiptFile(at.dropDir, M1, 'read'))).toBe(false);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
    expect(read(at, M1, 'ack').kind).toBe('published');
    expect(existsSync(ackedFile(at.dropDir, M1))).toBe(false);
    expect(readdirSync(at.dropDir).filter((name) => name.startsWith(`${M1}.`))).toEqual([`${M1}.read.json`]);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(true);
    expect(read(at, M1, 'ack').kind).toBe('served');
  });

  test('a copy receipt an earlier build wrote does not settle; the ack is the note beside it', () => {
    const at = place();
    activateRoot(at);
    write(at, M1);
    const copy = signReceiptPayload({ kind: 'receipt', status: 'read', id: M1, to: 'lead', root: at.root, session: SESSION, at: new Date().toISOString(), read_by: 'copy' }, at.home);
    writeFileSync(receiptFile(at.dropDir, M1, 'read'), `${JSON.stringify(copy, null, 2)}\n`);
    expect(takeCopyNumber(at.dropDir, M1, 'read')).toBe(1);
    expect(isRead(at.dropDir, M1, context(at), key(at))).toBe(false);
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
    expect(resendDue(at.dropDir, M1, Date.now(), null)).toBe(true);
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
    expect(resendDue(at.dropDir, M1, Date.now(), null)).toBe(true);
    takeCopyNumber(at.dropDir, M1, 'channel');
    expect(resendDue(at.dropDir, M1, Date.now(), null)).toBe(false);
    expect(resendDue(at.dropDir, M1, Date.now() + 61_000, null)).toBe(true);
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
    expect(moved[0]?.undelivered).toEqual({ from: 'worker', from_id: null });
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

  test('the re-send scheduler offers again every due unsettled stamped record, marker or not', async () => {
    const { resendCandidates } = await import('../src/queue/resend.ts');
    const { channelAbortPath } = await import('../src/mcp/channel.ts');
    const at = place();
    activateRoot(at);
    writeStamped(at, M1);
    writeStamped(at, M2);
    writeFileSync(channelAbortPath(stampedDir(at), M2), `{"id":"${M2}"}\n`);
    const seat = { dropDir: at.dropDir, context: { ...context(at), lead: 'lead' }, key: key(at), agentsDir: join(at.root, '.agents') };
    // Just arrived, no copy yet: the arrival's own delivery is not doubled.
    expect(resendCandidates(seat, Date.now())).toEqual([]);
    // A minute on, both are due: M1 never delivered (its first history write failed, say), M2 aborted.
    const later = Date.now() + 61_000;
    expect(resendCandidates(seat, later).sort()).toEqual([M1, M2].sort());
    // A copy just taken is not due until its backoff; an acknowledged record is never due.
    takeCopyNumber(at.dropDir, M1, 'channel');
    read(at, M2, 'ack');
    expect(resendCandidates(seat, Date.now() + 1_000)).toEqual([]);
    expect(resendCandidates(seat, Date.now() + 61_000)).toEqual([M1]);
  });

  test('a stamped record with a plain (no reader word) read stays unsettled for the scheduler and retention', async () => {
    const { resendCandidates } = await import('../src/queue/resend.ts');
    const { signReceiptPayload, receiptFile, stampedSettled } = await import('../src/send/record.ts');
    const at = place();
    activateRoot(at);
    writeStamped(at, M1);
    const plain = signReceiptPayload({ kind: 'receipt', status: 'read', id: M1, to: 'lead', root: at.root, session: SESSION, at: new Date().toISOString() }, at.home);
    writeFileSync(receiptFile(at.dropDir, M1, 'read'), `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 });
    expect(stampedSettled(at.dropDir, M1, context(at), key(at))).toBe(false);
    const seat = { dropDir: at.dropDir, context: context(at), key: key(at), agentsDir: join(at.root, '.agents') };
    expect(resendCandidates(seat, Date.now() + 61_000)).toEqual([M1]);
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



  test('a stamped record written through the record writer carries its era folder: a plain read never hides it from the listing', async () => {
    const { listUnread } = await import('../src/mcp/inbox.ts');
    const { writeRecord } = await import('../src/send/record.ts');
    const at = place();
    activateRoot(at);
    expect(writeRecord(at.dropDir, signRecord(stampedPayload(payloadOf(at, M1), at.home), at.home)).ok).toBe(true);
    // Revision 3: the record and its era folder sit in the seat's stamped tree.
    expect(existsSync(join(at.dropDir.replace('/send-drops/', '/send-stamped/'), EXPOSURES, M1))).toBe(true);
    expect(existsSync(join(at.dropDir, M1))).toBe(false);
    expect(copyHistory(at.dropDir, M1)).toMatchObject({ copies: 0 });
    await plainRead(at, M1);
    expect(listUnread(at.dropDir, context(at), at.home).map((m) => m.id)).toEqual([M1]);
  });
});


describe('revision 3: activation needs only the daemon at the floor', () => {
  const launched = (at: At, seat: string) => writeFileSync(join(at.root, '.agents', 'team.state.json'), JSON.stringify({
    format: 1, sessions: { [SESSION]: { seats: { [seat]: { stage: 'ready', launched: { shell: process.pid, cli: [process.pid] } } } } },
  }));
  const marker = (at: At, seat: string, fields: Record<string, unknown>) => {
    const dir = join(at.root, '.agents', 'send-drops', SESSION, seat);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.inbox-listener'), `${JSON.stringify({ v: 1, seat, session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), level: 3, ...fields })}\n`);
  };
  const scanActivate = async (at: At) => {
    const { liveFloorActors } = await import('../src/queue/floor-actors.ts');
    const scanned = (liveFloorActors(at.root, at.home) ?? []).filter((a) => a.kind !== 'daemon');
    return { scanned, outcome: activate(at.root, { home: at.home, build: 'b', actors: () => [daemon, ...scanned] }).kind };
  };

  test('a live seat with no inbox marker (a launch from any build) is no actor: activation allowed', async () => {
    const at = place();
    launched(at, 'builder');
    const run = await scanActivate(at);
    expect(run.scanned).toEqual([]);
    expect(run.outcome).toBe('activated');
  });

  test('a live level-2 inbox server, a stale marker and a marker bound elsewhere are no actors: they cannot see the stamped tree', async () => {
    for (const fields of [{ level: 2 }, { pid: 999_999_99 }, { root: '/elsewhere' }]) {
      const at = place();
      launched(at, 'lead');
      marker(at, 'lead', fields);
      const run = await scanActivate(at);
      expect(run.scanned).toEqual([]);
      expect(run.outcome).toBe('activated');
    }
  });

  test('the daemon below the floor, or no live daemon, refuses activation', () => {
    const at = place();
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [{ ...daemon, level: 2 }] }).kind).toBe('refused');
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [] }).kind).toBe('refused');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });
});

describe('round 5 and 6 fixes', () => {
  const plain = async (at: At, id: string) => {
    const { signReceiptPayload, receiptFile } = await import('../src/send/record.ts');
    writeFileSync(receiptFile(at.dropDir, id, 'read'), `${JSON.stringify(signReceiptPayload({ kind: 'receipt', status: 'read', id, to: 'lead', root: at.root, session: SESSION, at: new Date().toISOString() }, at.home), null, 2)}\n`, { mode: 0o600 });
  };

  test('the ordinary staged send writes the era folder before the record: a plain read never hides it', async () => {
    const { stageSendRecord } = await import('../src/commands/send.ts');
    const { listUnread } = await import('../src/mcp/inbox.ts');
    const at = place();
    activateRoot(at);
    const staged = await stageSendRecord(at.dropDir, stampedPayload(payloadOf(at, M1), at.home), at.home, () => new Date(), 'acme');
    expect(staged.ok).toBe(true);
    // Revision 3: the record and its era folder sit in the seat's stamped tree.
    expect(existsSync(join(at.dropDir.replace('/send-drops/', '/send-stamped/'), EXPOSURES, M1))).toBe(true);
    expect(existsSync(join(at.dropDir, M1))).toBe(false);
    await plain(at, M1);
    expect(listUnread(at.dropDir, context(at), at.home).map((m) => m.id)).toEqual([M1]);
  });


});

describe('not-delivered notice before the move (replaces the archive reconcile)', () => {
  test('a retired seat\'s unacknowledged stamped record moves only once its notice stands; the notice names it exactly', async () => {
    const { noticeBeforeMove } = await import('../src/daemon/chores/inbox-archive.ts');
    const { archiveSeatInbox } = await import('../src/send/inbox-retention.ts');
    const { readRecord } = await import('../src/send/record.ts');
    const at = place();
    activateRoot(at);
    write(at, M1);
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof noticeBeforeMove>[0]['team'];
    const run = (gate: (item: { id: string }) => boolean) => archiveSeatInbox({
      dropDir: at.dropDir, seat: 'lead', context: context(at), key: key(at), home: at.home, now: new Date('2026-12-30T00:00:00.000Z'), dryRun: false,
      options: { unreadKeepMs: 14 * 86_400_000, retired: true, orphans: false }, beforeUndelivered: gate,
    });
    // A notice that cannot be written: nothing moves, the record stays live.
    expect(run(() => false).move.filter((m) => m.id === M1)).toEqual([]);
    expect(existsSync(join(at.dropDir, M1))).toBe(true);
    // The real gate: the notice is written first, then the record moves.
    const gate = (item: { id: string }) => noticeBeforeMove({ home: at.home, root: at.root, session: SESSION, seat: 'lead', team, key: key(at), at: new Date().toISOString(), item: { id: item.id, undelivered: { from: 'worker', from_id: null } } });
    expect(run(gate).move.map((m) => m.id)).toEqual([M1]);
    const noticePath = join(at.root, '.agents', 'send-drops', SESSION, 'boss', undeliveredNoticeId(M1));
    const notice = readRecord(noticePath, undeliveredNoticeId(M1));
    expect(notice.ok && notice.record?.payload.in_reply_to).toBe(M1);
  });

  test('an occupied notice name that is not this obligation\'s own notice holds the move back', async () => {
    const { noticeBeforeMove } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const bossDir = join(at.root, '.agents', 'send-drops', SESSION, 'boss');
    mkdirSync(bossDir, { recursive: true });
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof noticeBeforeMove>[0]['team'];
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', team, key: key(at), at: new Date().toISOString(), item: { id: M1, undelivered: { from: 'worker', from_id: null } } };
    // A runtime record at the id that only mentions the message (no in_reply_to binding).
    const other = signRecord({ kind: 'message', id: undeliveredNoticeId(M1), to: 'boss', to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: `mentions ${M1}`, from: 'runtime', from_id: null, rule: "the team's unread-message report", thread: undeliveredNoticeId(M1) }, at.home);
    writeFileSync(join(bossDir, undeliveredNoticeId(M1)), `${JSON.stringify(other, null, 2)}\n`, { mode: 0o600 });
    expect(noticeBeforeMove(input)).toBe(false);
  });

  test('the notice follows the sender resolved by its signed agent id, in its current session', async () => {
    const { noticeBeforeMove } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }, { name: 'worker' }] } as unknown as Parameters<typeof noticeBeforeMove>[0]['team'];
    const agents = [
      { id: 'agt_000000000007', reach: { team: 't', seat: 'worker-2', session: 'other' }, lifecycle: 'running' },
      { id: 'agt_000000000008', reach: { team: 't', seat: 'worker', session: SESSION }, lifecycle: 'running' },
    ] as unknown as NonNullable<Parameters<typeof noticeBeforeMove>[0]['agents']>;
    expect(noticeBeforeMove({ home: at.home, root: at.root, session: SESSION, seat: 'lead', team, key: key(at), at: new Date().toISOString(), item: { id: M1, undelivered: { from: 'worker', from_id: 'agt_000000000007' } }, agents, teamId: 't' })).toBe(true);
    expect(existsSync(join(at.root, '.agents', 'send-drops', 'other', 'worker-2', undeliveredNoticeId(M1)))).toBe(true);
    expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'worker', undeliveredNoticeId(M1)))).toBe(false);
  });
});

describe('round 8 fixes', () => {
  const launchedState = (at: At, seat: string, cli: number[] | null) => writeFileSync(join(at.root, '.agents', 'team.state.json'), JSON.stringify({
    format: 1, sessions: { [SESSION]: { seats: { [seat]: { stage: 'ready', ...(cli === null ? {} : { launched: { shell: process.pid, cli } }) } } } },
  }));
  const scan = async (at: At) => {
    const { liveFloorActors } = await import('../src/queue/floor-actors.ts');
    return (liveFloorActors(at.root, at.home) ?? []).filter((a) => a.kind !== 'daemon');
  };

  test('the notice must be durable before the source moves; a failed fsync holds it, a later pass moves it', async () => {
    const { noticeBeforeMove } = await import('../src/daemon/chores/inbox-archive.ts');
    const { acquireLockAt } = await import('../src/launch/seat-lock.ts');
    const { queueBaseOf } = await import('../src/queue/append.ts');
    const at = place();
    activateRoot(at);
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof noticeBeforeMove>[0]['team'];
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', team, key: key(at), at: new Date().toISOString(), item: { id: M1, undelivered: { from: 'worker', from_id: null } } };
    expect(noticeBeforeMove({ ...input, fsync: () => { throw new Error('fsync failed'); } })).toBe(false);
    // The notice's own queue lock is held: the notice is still written whole and made durable.
    const bossDir = join(at.root, '.agents', 'send-drops', SESSION, 'boss');
    const base = queueBaseOf(bossDir);
    const lock = base === null ? null : acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    try {
      expect(noticeBeforeMove(input)).toBe(true);
    } finally {
      if (lock !== null && 'release' in lock) lock.release();
    }
    expect(existsSync(join(bossDir, undeliveredNoticeId(M1)))).toBe(true);
  });
});

describe('round 9 fixes', () => {
  const scan = async (at: At) => {
    const { liveFloorActors } = await import('../src/queue/floor-actors.ts');
    return (liveFloorActors(at.root, at.home) ?? []).filter((a) => a.kind !== 'daemon');
  };
  const refusedWith = async (at: At) => {
    const actors = await scan(at);
    return { actors, outcome: activate(at.root, { home: at.home, build: 'b', actors: () => [daemon, ...actors] }).kind };
  };

  const noticeSetup = async () => {
    const { noticeBeforeMove } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof noticeBeforeMove>[0]['team'];
    const input = { home: at.home, root: at.root, session: SESSION, seat: 'lead', team, key: key(at), at: new Date().toISOString(), item: { id: M1, undelivered: { from: 'worker', from_id: null } } };
    const bossDir = join(at.root, '.agents', 'send-drops', SESSION, 'boss');
    const wrong = signRecord({ kind: 'message', id: undeliveredNoticeId(M1), to: 'boss', to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: `mentions ${M1}`, from: 'runtime', from_id: null, rule: "the team's unread-message report", thread: undeliveredNoticeId(M1) }, at.home);
    return { noticeBeforeMove, at, input, bossDir, wrongText: `${JSON.stringify(wrong, null, 2)}\n` };
  };

  test('a replacement between verification and open is caught: the descriptor read is what is verified', async () => {
    const { noticeBeforeMove, input, bossDir, wrongText } = await noticeSetup();
    const swap = () => { writeFileSync(join(bossDir, `${undeliveredNoticeId(M1)}.swap`), wrongText); renameSync(join(bossDir, `${undeliveredNoticeId(M1)}.swap`), join(bossDir, undeliveredNoticeId(M1))); };
    expect(noticeBeforeMove({ ...input, hooks: { beforeOpen: swap } })).toBe(false);
  });

  test('a different file at the name after the flush is caught (identity check)', async () => {
    const { noticeBeforeMove, input, bossDir, wrongText } = await noticeSetup();
    const swap = () => { writeFileSync(join(bossDir, `${undeliveredNoticeId(M1)}.swap`), wrongText); renameSync(join(bossDir, `${undeliveredNoticeId(M1)}.swap`), join(bossDir, undeliveredNoticeId(M1))); };
    expect(noticeBeforeMove({ ...input, hooks: { afterFlush: swap } })).toBe(false);
  });

  test('a fresh notice under a held notice queue lock (taken before the first call) is written, verified and made durable', async () => {
    const { noticeBeforeMove, input, bossDir } = await noticeSetup();
    const { acquireLockAt } = await import('../src/launch/seat-lock.ts');
    const { queueBaseOf } = await import('../src/queue/append.ts');
    mkdirSync(bossDir, { recursive: true });
    const base = queueBaseOf(bossDir);
    if (base !== null) mkdirSync(base, { recursive: true });
    const lock = base === null ? null : acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect(lock !== null && 'release' in lock).toBe(true);
    try {
      expect(noticeBeforeMove(input)).toBe(true);
    } finally {
      if (lock !== null && 'release' in lock) lock.release();
    }
  }, 30_000);
});

describe('round 10 fixes', () => {
  const scan = async (at: At) => {
    const { liveFloorActors } = await import('../src/queue/floor-actors.ts');
    return (liveFloorActors(at.root, at.home) ?? []).filter((a) => a.kind !== 'daemon');
  };
  const state = (at: At, session: string, seat: string, cli: number[]) => writeFileSync(join(at.root, '.agents', 'team.state.json'), JSON.stringify({
    format: 1, sessions: { [session]: { seats: { [seat]: { stage: 'ready', launched: { shell: process.pid, cli } } } } },
  }));

  test('an in-place overwrite of the notice after the flush (same inode) holds the move', async () => {
    const { noticeBeforeMove } = await import('../src/daemon/chores/inbox-archive.ts');
    const at = place();
    activateRoot(at);
    const team = { session: SESSION, orchestrator: 'boss', seats: [{ name: 'boss' }] } as unknown as Parameters<typeof noticeBeforeMove>[0]['team'];
    const notice = join(at.root, '.agents', 'send-drops', SESSION, 'boss', undeliveredNoticeId(M1));
    const overwrite = () => writeFileSync(notice, '{"truncated":true}\n');
    expect(noticeBeforeMove({ home: at.home, root: at.root, session: SESSION, seat: 'lead', team, key: key(at), at: new Date().toISOString(), item: { id: M1, undelivered: { from: 'worker', from_id: null } }, hooks: { afterFlush: overwrite } })).toBe(false);
  });

});
