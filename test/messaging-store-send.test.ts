// The `messaging.store` word a send walks, on the socket leg: `first` writes the signed copy
// before the frame leaves and keeps it; `parallel` starts that write beside the dial and ends
// the send only when both settled; `none` stores nothing at all and the frame carries the signed
// record's bytes, which a receiver verifies with the same key check it applies to a folder copy.
// No live pane and no real socket: the host's deliver is a fake, and the socket file only has to
// stand where the socket lookup looks.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { readHistory } from '../src/send/history.ts';
import { carriedRecordOf, readRecord } from '../src/send/record.ts';
import { NOW, dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';
import { withoutSendId } from './helpers/output.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's `accept` declaration at the launch's own settings path, and the socket
 *  its pane exposes; the declaration predates the socket, as a session started after it. */
function declare(made: World, seat = 'lead'): void {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The team names an entity, and that entity's own lobby is in the file's trust list: the owner's
 *  frame reply line is read through it. */
function declareEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** An accepting Claude seat with no declared order walks the socket first. */
function socketWorld(): World {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made);
  return made;
}

type Frame = { msg_id: string; record?: string; message: { content: string } };

function frameOf(frames: readonly string[]): Frame {
  expect(frames).toHaveLength(1);
  return JSON.parse(frames[0] as string) as Frame;
}

test('first writes the signed copy before the frame and leaves it there', async () => {
  const made = socketWorld();
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  let atDial: string[] = [];
  const host = fake(made, {
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      // What the receiver's folder holds at the instant the frame is dialed.
      atDial = existsSync(drops) ? readdirSync(drops).filter((name) => !name.includes('.')) : [];
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(0);
  expect(withoutSendId(io.out)).toContain('lead: delivered (socket)');
  const frame = frameOf(frames);
  // The shipped `first` shape: the signed record is on disk before the dial, and the frame is
  // transport only.
  expect(atDial).toEqual([frame.msg_id]);
  expect(frame.record).toBeUndefined();
  const read = readRecord(join(drops, frame.msg_id), frame.msg_id);
  expect(read.ok).toBe(true);
  if (!read.ok || read.record === null) return;
  expect(read.record.payload.body.endsWith('a note')).toBe(true);
});

test('parallel ends the send only once the frame and the write both settled', async () => {
  const made = socketWorld();
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  const host = fake(made, {
    store: 'parallel',
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(0);
  expect(withoutSendId(io.out)).toContain('lead: delivered (socket)');
  const frame = frameOf(frames);
  // Only `none` rides the record inside the frame; `parallel` still keeps the copy on disk, and
  // the delivered ending means the write settled too.
  expect(frame.record).toBeUndefined();
  const read = readRecord(join(drops, frame.msg_id), frame.msg_id);
  expect(read.ok).toBe(true);
  if (!read.ok || read.record === null) return;
  expect(read.record.payload.body.endsWith('a note')).toBe(true);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)).toMatchObject({ id: frame.msg_id, outcome: 'delivered', via: 'socket' });
});

test('parallel reports a taken frame its write could not follow as sent (unconfirmed)', async () => {
  const made = socketWorld();
  const drops = dropDir(made.dir, 'lead');
  mkdirSync(drops, { recursive: true });
  const id = 'aaaaaaaa-0000-4000-8000-000000000501';
  // A different record already holds the name: the walk's own write refuses, while the dial is
  // taken. The send must say so, never `delivered`.
  writeFileSync(join(drops, id), '');
  const frames: string[] = [];
  const host = fake(made, {
    store: 'parallel',
    sendId: () => id,
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(0);
  expect(withoutSendId(io.out)).toContain('lead: sent (unconfirmed) (socket,');
  expect(frameOf(frames).msg_id).toBe(id);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)).toMatchObject({ id, outcome: 'sent (unconfirmed)', via: 'socket' });
});

test('none stores nothing and the frame carries the signed bytes a receiver verifies', async () => {
  const made = socketWorld();
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  const host = fake(made, {
    store: 'none',
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(0);
  expect(withoutSendId(io.out)).toContain('lead: delivered (socket)');
  // Nothing was stored: the receiving seat's folder is not even created.
  expect(existsSync(drops)).toBe(false);
  const frame = frameOf(frames);
  expect(typeof frame.record).toBe('string');
  const carried = carriedRecordOf(frames[0] as string, made.home);
  expect(carried.ok).toBe(true);
  if (!carried.ok) return;
  expect(carried.record.payload.id).toBe(frame.msg_id);
  expect(carried.record.payload.to).toBe('lead');
  expect(carried.record.payload.body.endsWith('a note')).toBe(true);
});

test('a tampered none-frame is refused by the same verifier that accepts a real one', async () => {
  const made = socketWorld();
  const frames: string[] = [];
  const host = fake(made, {
    store: 'none',
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);
  expect(await runSend(['lead', 'a note'], io, host)).toBe(0);

  const frame = frameOf(frames);
  expect(typeof frame.record).toBe('string');
  const altered = (frame.record as string).replace('a note', 'a boast');
  expect(altered).not.toBe(frame.record);
  const refused = carriedRecordOf(JSON.stringify({ ...frame, record: altered }), made.home);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.reason).toContain("does not verify with this home's key");
  // A frame with no carried record is refused with its own sentence: `none` is the only store
  // that puts one there, and a receiver never reads a frame as a message on faith.
  const empty = carriedRecordOf(JSON.stringify({ ...frame, record: undefined }), made.home);
  expect(empty).toMatchObject({ ok: false, reason: 'the frame carries no signed record' });
});

test('a none walk with no body-carrying leg refuses before anything is written', async () => {
  const made = world(['drop']);
  cleanup = made.cleanup;
  const drops = dropDir(made.dir, 'lead');
  const host = fake(made, { store: 'none' });
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(1);
  expect(io.err).toContain('messaging.store is none and no route the order names carries the body itself');
  expect(existsSync(drops)).toBe(false);
  expect(host.frames).toEqual([]);
});

test('a signed entity record decides the store, and a team record may tighten it back', async () => {
  const made = socketWorld();
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  // The entity is the level that may loosen away from `first`; it names `none` for every team
  // beneath it. The send consults the production chain — no host store is handed in.
  const loosened = writePolicySet(
    made.home,
    { level: 'entity', target: 'floor', name: 'messaging.store', value: 'none' },
    { now: NOW },
  );
  expect(loosened.ok).toBe(true);

  const firstCode = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(firstCode).toBe(0);
  expect(existsSync(drops)).toBe(false);
  expect(carriedRecordOf(frames[0] as string, made.home).ok).toBe(true);

  // The team may always close the door again: its signed word puts the copy back on disk, and
  // the next send is the shipped `first` shape again.
  const tightened = writePolicySet(
    made.home,
    { level: 'team', target: made.root, teamRoot: made.root, name: 'messaging.store', value: 'first' },
    { now: NOW },
  );
  expect(tightened.ok).toBe(true);

  const secondCode = await runSend(['lead', 'a second note'], owner(made.root), host);

  expect(secondCode).toBe(0);
  expect(frames).toHaveLength(2);
  const second = JSON.parse(frames[1] as string) as Frame;
  const read = readRecord(join(drops, second.msg_id), second.msg_id);
  expect(read.ok).toBe(true);
  if (!read.ok || read.record === null) return;
  expect(read.record.payload.body.endsWith('a second note')).toBe(true);
});
