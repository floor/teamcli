// The `socket` delivery leg: a receiver's own `crossSessionInbound` declaration decides whether a
// send dials its cross-session socket, the signed record is written before the frame, and a
// declared order is walked as written. No live pane and no real socket: the host's deliver is a
// fake, and the socket file only has to stand where `socketOf` looks.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { testIo } from './helpers.ts';
import { dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's declaration at the launch's own settings path, and the socket its pane
 *  exposes. With `fresh`, the declaration's file predates the socket: the session was started
 *  after the launcher declared the policy. */
function declare(made: World, policy: string | null, fresh = true): string {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  const settingsAt = fresh ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(path, new Date(settingsAt), new Date(settingsAt));
  return path;
}

test('an accepting Claude seat with no declared order walks the socket first, after the signed record', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  let atDial: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      atDial = readdirSync(drops);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(frames.length).toBe(1);
  expect(frames[0]).toContain('a note');
  // The durable signed copy was in the receiver's folder before the frame left: the record's
  // file is named by the message id, and it is the only file there.
  expect(atDial.length).toBe(1);
  expect(readdirSync(drops).length).toBe(1);
});

test('a plain-text owner send reports delivered (socket), never read', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, fake(made));

  expect(code).toBe(0);
  expect(io.out).toContain('lead: delivered (socket)');
  expect(io.out).not.toContain('read');
});

test('a receiver declaring hold is skipped and the typed trigger takes the send', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'hold');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a receiver declaring nothing is skipped and the typed trigger takes the send', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, null);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a session started before its accept declaration is skipped, and the trigger takes the send', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept', false);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a declared order that omits socket never dials, even for an accepting receiver', async () => {
  const made = world(['mcp-inbox', 'typed']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a declared order may place socket first, and it is walked there', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
});

test('a declared order that puts the typed leg first takes the send there, and the socket is not dialed', async () => {
  const made = world(['typed', 'socket']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a socket leg named for a non-Claude seat is skipped, and the typed leg behind it takes the send', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'native', pane: 'w9:p1' }], native: pane });

  const code = await runSend(['native', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});
