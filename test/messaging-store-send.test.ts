// The `messaging.store` word a send walks: `first` writes the signed copy before the frame
// leaves and keeps it; `parallel` starts that write beside the dial and ends the send only when
// both settled; `none` stores nothing at all and the frame carries the signed record's bytes,
// which a receiver verifies with the same key check it applies to a folder copy. A `none` walk
// keeps only the legs that carry the body themselves — the socket frame and the session call —
// and sets a leg that would read or wake a stored copy aside, pointer lines included.
// No live pane and no real socket: the host's deliver is a fake, and the socket file only has to
// stand where the socket lookup looks.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend, sendDirect } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { readHistory } from '../src/send/history.ts';
import { carriedRecordOf, readRecord } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { cleanupFakeJules, fakeJulesOnPath } from './helpers/fake-jules.ts';
import { testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';
import { withoutSendId } from './helpers/output.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  cleanupFakeJules();
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

/** What a `none` walk says about a leg that would read or wake a stored copy. */
const POINTER_SET_ASIDE = 'the store is none, and this leg hands the seat a pointer to the stored copy; only a leg that carries the body itself is walked';

test('none sets a pointer leg aside with its reason and lets the socket carry the send', async () => {
  const made = world(['native', 'headless-resume', 'socket', 'drop']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made);
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
  expect(frames).toHaveLength(1);
  // A runtime queue and a headless resume hand the seat an id to read: with no copy stored, they
  // would point at a file nothing wrote, so they are set aside before the walk and the history
  // line names why. The socket carries the signed bytes, so it is the leg that walks.
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  const failed = history.entries.at(-1)?.failed ?? [];
  expect(failed).toContain(`native: ${POINTER_SET_ASIDE}`);
  expect(failed).toContain(`headless-resume: ${POINTER_SET_ASIDE}`);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
});

test('a none walk that names only a pointer leg refuses: no copy exists for it to point at', async () => {
  const made = world(['native', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made, { store: 'none' });
  const io = owner(made.root);

  const code = await runSend(['native', 'a note'], io, host);

  expect(code).toBe(1);
  expect(io.err).toContain('messaging.store is none and no route the order names carries the body itself');
  expect(existsSync(dropDir(made.dir, 'native'))).toBe(false);
});

test('none never runs the Claude handoff: its record and pending file write nothing', async () => {
  const made = world(['native', 'drop']);
  cleanup = made.cleanup;
  // A Claude Code sender and a resolvable recipient: without the store rule this is exactly the
  // walk that writes the handoff's own record and pending file, store or no store.
  updateState(made.dir, (state) => {
    state.sessions.acme = {
      seats: { helper: { stage: 'ready', pane: 'fixture-pane-1' } },
      worktrees: {},
    };
  });
  writeFileSync(join(made.sockets, '222.sock'), '');
  const host = fake(made, {
    store: 'none',
    native: scripted(['idle', 'working']),
    newId: () => 'aaaaaaaa-0000-4000-8000-000000000801',
  });
  const io = testIo(made.root, { kind: 'seat', name: 'helper', pane: 'fixture-pane-1', session: 'acme' });

  const code = await runSend(['lead', 'hello'], io, host);

  expect(code).toBe(1);
  expect(io.err).toContain('messaging.store is none and no route the order names carries the body itself');
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
});

test('parallel does not call a created session delivered when its copy could not be written', async () => {
  const made = world(['session', 'drop'], [{ name: 'jules-seat', role: 'implementer', cli: 'jules', launch: 'jules' }]);
  cleanup = made.cleanup;
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/site.git'], { cwd: made.root, stdio: 'ignore' });
  const fakeJules = fakeJulesOnPath({ status: 0, stdout: 'Session created: https://jules.google.com/session/abc123\n' });
  expect(fakeJules.firstOnPath()).toBe(fakeJules.binary);
  const drops = dropDir(made.dir, 'jules-seat');
  mkdirSync(drops, { recursive: true });
  const id = 'aaaaaaaa-0000-4000-8000-000000000601';
  // A different record already holds the name: the walk's own write refuses while the CLI's
  // session call still creates its session. The send must say so, never `delivered`.
  writeFileSync(join(drops, id), '');
  const privateDir = join(dirname(made.root), 'private');
  mkdirSync(privateDir, { recursive: true });
  const names = join(privateDir, 'names.txt');
  writeFileSync(names, 'Zephyrine Quillfeather\n', { mode: 0o600 });
  const host = fake(made, {
    store: 'parallel',
    sendId: () => id,
    privateLists: { names, phrases: join(privateDir, 'phrases.txt') },
    repoVisibility: async () => 'public',
  });
  const io = owner(made.root);

  const code = await runSend(['jules-seat', 'a brief'], io, host);

  expect(code).toBe(0);
  expect(withoutSendId(io.out)).toContain('jules-seat: sent (unconfirmed) (session,');
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  // The session was created — the remote agent has the body — but the stored copy the store
  // promises is not there, so the send's word is the unconfirmed one and never delivered.
  expect(history.entries.at(-1)).toMatchObject({ id, outcome: 'sent (unconfirmed)', via: 'session', session: 'abc123' });
});

test('parallel hands a direct caller an unconfirmed ending when the frame was taken and the copy failed', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made);
  const drops = dropDir(made.dir, 'lead');
  mkdirSync(drops, { recursive: true });
  const id = 'aaaaaaaa-0000-4000-8000-000000000701';
  writeFileSync(join(drops, id), '');
  const host = fake(made, {
    store: 'parallel',
    sendId: () => id,
    agents: () => [{ name: 'lead', pane: 'fixture-pane-1' }],
    deliver: async () => ({ ok: true }),
  });

  const run = await sendDirect(owner(made.root), host, { seat: 'lead', pane: 'fixture-pane-1', cli: 'claude-code', body: 'a note' });

  expect(run.code).toBe(0);
  const result = run.result;
  expect(result).not.toBeNull();
  if (result === null) return;
  // The frame was taken, so the walk ends here; the recorded ending and the caller's result say
  // what settled — the copy did not — instead of repeating the delivered word the ending refused.
  expect(result.outcome).toBe('unreachable');
  expect(result.reason).toContain('the frame was taken, but the record was not written');
  expect(result.record).toBeNull();
});
