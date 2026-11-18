// E7b revision 3: a stamped (lvl 3) record is written only where level-2 code never reads.
//
// The level-2 reader is the real E7a code (commit d8cd0ae3d), extracted from this repository's
// history into a temporary folder and imported as a fixture. Over a root where this build wrote a
// stamped record, the E7a listing, by-id read, drops listing and record-id listing see nothing and
// settle nothing, while this build lists and reads the record. Skipped when the repository's
// history is not at hand (a packed copy, a shallow clone).
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { installedLevel3Tree, level2Tree } from './e7a-fixture.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { listUnread, readMessage } from '../src/mcp/inbox.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { recordChannelAbort } from '../src/mcp/channel.ts';
import { markPending } from '../src/send/pending.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { signedIdentityOf, SIGN_FROM_IDENTITY, withSignedIdentity } from '../src/comms/identity.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };

// The fixture folder is left to the system's temporary-folder sweep.
const e7a = level2Tree();

type At = { root: string; home: string; legacy: string; stamped: string };

function place(): At {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-r3-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  const dirs = seatMailDirs(root, SESSION, 'lead');
  mkdirSync(dirs.legacy, { recursive: true, mode: 0o700 });
  return { root, home, ...dirs };
}

function payloadOf(at: At, id: string): RecordPayload {
  return { kind: 'message', id, to: 'lead', to_id: null, root: at.root, session: SESSION, at: '2026-11-18T00:00:01.000Z', body: `the secret body of ${id}`, from: 'worker', from_id: null, rule: 'the owner', thread: id };
}

const ID = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e31';
const context = (at: At) => ({ to: 'lead', root: at.root, session: SESSION });
const target = (at: At) => ({ dropDir: at.legacy, root: at.root, session: SESSION, seat: 'lead' });

/** An active root holding one stamped record, written through this build's record writer. */
function stampedRoot(): At {
  const at = place();
  expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  const payload = stampedPayload(payloadOf(at, ID), at.home);
  expect(payload.lvl).toBe(3);
  const written = writeRecord(at.legacy, signRecord(payload, at.home));
  expect(written.ok).toBe(true);
  return at;
}

describe('revision 3: the stamped tree (this build)', () => {
  test('a stamped record is written only under send-stamped; the legacy folder holds no file of it', () => {
    const at = stampedRoot();
    expect(existsSync(join(at.stamped, ID))).toBe(true);
    expect(readdirSync(at.legacy).filter((name) => name.startsWith(ID))).toEqual([]);
  });

  test('this build lists the stamped record and reads it', () => {
    const at = stampedRoot();
    expect(listUnread(at.legacy, context(at), at.home).map((message) => message.id)).toEqual([ID]);
    const got = readMessage(target(at), ID, at.home);
    expect(got.ok).toBe(true);
    // The read receipt sits beside the record, in the stamped tree.
    expect(existsSync(join(at.stamped, `${ID}.read.json`))).toBe(true);
    expect(readdirSync(at.legacy).filter((name) => name.startsWith(ID))).toEqual([]);
  });
});

describe('revision 3: settlement and marks follow the record into the stamped tree', () => {
  test('a read receipt published from the legacy folder (the team ack path) sits beside the stamped record', () => {
    const at = stampedRoot();
    const state = messageKeyState(at.home);
    if (state.kind !== 'key') throw new Error('no key');
    const published = publishRecordRead({ dropDir: at.legacy, id: ID, to: 'lead', root: at.root, session: SESSION, home: at.home, key: state.key, at: new Date().toISOString() });
    expect(published.kind).toBe('published');
    expect(existsSync(join(at.stamped, `${ID}.read.json`))).toBe(true);
    expect(readdirSync(at.legacy).filter((name) => name.startsWith(ID))).toEqual([]);
  });

  test('a channel mark and a pending marker named from the legacy folder sit in the stamped tree', () => {
    const at = stampedRoot();
    expect(recordChannelAbort(at.legacy, ID, new Date().toISOString(), 'a fixture')).toBe(true);
    markPending(at.legacy, { id: ID, from: 'worker', to: 'lead', body: 'the secret body', ts: new Date().toISOString() });
    expect(readdirSync(at.legacy).filter((name) => name.startsWith(ID))).toEqual([]);
    expect(readdirSync(at.stamped).filter((name) => name.startsWith(`${ID}.`)).length).toBeGreaterThanOrEqual(2);
  });

  test('a stamped record is never written into a folder that is no seat folder', () => {
    const at = place();
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    const loose = join(at.root, 'loose');
    mkdirSync(loose, { recursive: true, mode: 0o700 });
    const written = writeRecord(loose, signRecord(stampedPayload(payloadOf(at, ID), at.home), at.home));
    expect(written.ok).toBe(false);
    expect(readdirSync(loose)).toEqual([]);
  });
});

describe.skipIf(e7a === null)('revision 3: level-2 (E7a) code over a root with a stamped record', () => {
  test('E7a listUnread lists nothing and readMessage refuses the id; nothing is written', async () => {
    const at = stampedRoot();
    const inbox = await import(`${e7a}/mcp/inbox.ts`);
    expect(inbox.listUnread(at.legacy, context(at), at.home)).toEqual([]);
    expect(inbox.listUnread(at.legacy, context(at), at.home, undefined, undefined, { legacy: 'include' })).toEqual([]);
    const got = inbox.readMessage(target(at), ID, at.home);
    expect(got.ok).toBe(false);
    expect(readdirSync(at.legacy).filter((name) => name.startsWith(ID))).toEqual([]);
    expect(readdirSync(at.stamped).sort()).toEqual([ID, '.exposures'].sort());
  });

  test('E7a drops listing, record-id listing and by-id folder lookup see nothing', async () => {
    const at = stampedRoot();
    const drops = await import(`${e7a}/commands/drops.ts`);
    const listing = drops.listDrops(at.legacy);
    expect(listing.kind).toBe('ok');
    expect(listing.rows).toEqual([]);
    const frame = await import(`${e7a}/send/frame.ts`);
    expect(frame.existingRecordIdsIn(at.legacy)).toEqual([]);
    const folder = await import(`${e7a}/send/drop-folder.ts`);
    expect(folder.folderOfDrop(at.legacy, ID)).toBe(at.legacy);
    const record = await import(`${e7a}/send/record.ts`);
    expect(existsSync(record.recordFile(at.legacy, ID))).toBe(false);
  });
});

describe.skipIf(e7a === null)('the Claude adapter (F18): an E7a reader never meets from_identity', () => {
  test('an identity-signed stamped record sits in the stamped tree, which E7a never lists or reads', async () => {
    const at = place();
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    // As a later build that enables the writer would sign it.
    const stampedOne = stampedPayload(payloadOf(at, ID), at.home);
    const payload = { ...stampedOne, from_identity: signedIdentityOf(stampedOne, at.home) };
    expect(writeRecord(at.legacy, signRecord(payload, at.home)).ok).toBe(true);
    expect(existsSync(join(at.stamped, ID))).toBe(true);
    expect(readdirSync(at.legacy).filter((name) => name.startsWith(ID))).toEqual([]);
    const inbox = await import(`${e7a}/mcp/inbox.ts`);
    expect(inbox.listUnread(at.legacy, context(at), at.home, undefined, undefined, { legacy: 'include' })).toEqual([]);
    expect(inbox.readMessage(target(at), ID, at.home).ok).toBe(false);
    const drops = await import(`${e7a}/commands/drops.ts`);
    expect(drops.listDrops(at.legacy).rows).toEqual([]);
  });

  test('an unstamped record (a dark root) carries no from_identity, and E7a reads it as before', async () => {
    const at = place();
    const payload = withSignedIdentity(stampedPayload(payloadOf(at, ID), at.home), at.home);
    expect(payload.lvl).toBeUndefined();
    expect('from_identity' in payload).toBe(false);
    expect(writeRecord(at.legacy, signRecord(payload, at.home)).ok).toBe(true);
    const inbox = await import(`${e7a}/mcp/inbox.ts`);
    expect(inbox.listUnread(at.legacy, context(at), at.home).map((message: { id: string }) => message.id)).toEqual([ID]);
  });
});

const installed = installedLevel3Tree();

describe.skipIf(installed === null)('round 1: the installed level-3 build (682867020) reads what this build writes', () => {
  test('the writer is staged off: a new stamped record carries no from_identity, and the installed reader lists and reads it', async () => {
    expect(SIGN_FROM_IDENTITY).toBe(false);
    const at = place();
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    const payload = withSignedIdentity(stampedPayload(payloadOf(at, ID), at.home), at.home);
    expect(payload.lvl).toBe(3);
    expect('from_identity' in payload).toBe(false);
    expect(writeRecord(at.legacy, signRecord(payload, at.home)).ok).toBe(true);
    const inbox = await import(`${installed}/mcp/inbox.ts`);
    expect(inbox.listUnread(at.legacy, context(at), at.home).map((message: { id: string }) => message.id)).toEqual([ID]);
    const got = inbox.readMessage(target(at), ID, at.home);
    expect(got.ok).toBe(true);
    // And after a rollback to dark, the installed build still reads the pending stamped record.
    const floor = await import('../src/queue/floor.ts');
    expect(floor.deactivate(at.root, at.home).kind).toBe('dark');
    expect(inbox.listUnread(at.legacy, context(at), at.home, undefined, undefined, { legacy: 'include' }).map((message: { id: string }) => message.id)).toContain(ID);
  });
});
