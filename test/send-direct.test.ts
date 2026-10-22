// The direct-only send seam: the watch's idle dispatch runs the ordinary send command with only
// the wake routes left in the walk, hands in the pane and CLI its own pass saw, and reads back the
// route that ended the walk rather than an exit code. The one keystroke this seam may make is the
// typed fallback behind a socket leg it actually dialed and the receiver refused; no stored copy
// counts as a delivery, and a send the caller did not see is refused before any route is attempted.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { sendDirect, type DirectSendResult } from '../src/commands/send.ts';
import { workPushResultOf } from '../src/commands/watch.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's own declaration that it accepts cross-session frames, and the socket its
 *  pane exposes. The declaration's file predates the socket, so the session was started after the
 *  declaration took effect and the socket leg is live. */
function accepting(made: World): void {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}


/** The team file with an entity, and the entity's own lobby in its trust list: a team that names
 *  an entity starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must
 *  trust. The entity also gives an owner sender the reply address its socket frame carries. */
function declareEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

test('a direct-only send takes the socket, types nothing and names the route that took it', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const pane = scripted(['idle'], '─'.repeat(30));
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      return { ok: true };
    },
  });

  const run = await sendDirect(owner(made.root), host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
  });

  expect(run.code).toBe(0);
  const result = run.result;
  expect(result).not.toBeNull();
  if (result === null) return;
  // The ending names the socket and no more than the transport said: an accepted frame, never a
  // read. The message id is the one the staged record carries.
  expect(result.route).toBe('socket');
  expect(result.outcome).toBe('delivered');
  expect(result.id).toMatch(MESSAGE_ID);
  const dir = dropDir(made.dir, 'lead');
  expect(readdirSync(dir).filter((name) => MESSAGE_ID.test(name))).toEqual([result.id]);
  expect(result.record).toBe(join(dir, result.id));
  expect(readFileSync(result.record as string, 'utf8')).toContain(result.id);
  expect(dials).toHaveLength(1);
  expect(dials[0]).toContain(result.id);
  // Nothing was typed: the socket leg needs no keystroke, and the direct-only walk leaves out the
  // legs that would make one.
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
});

test('a refused socket dial hands the work push to the typed trigger, and the ending names typed', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const pane = scripted(['idle', 'working'], '─'.repeat(30));
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      throw new Error('connect ECONNREFUSED');
    },
  });

  const run = await sendDirect(owner(made.root), host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
  });

  expect(run.code).toBe(0);
  const result = run.result;
  if (result === null) throw new Error('the walk recorded no ending');
  // The socket was dialed and the receiver refused it; the one keystroke this seam may make is
  // the typed trigger, and the ending names that route with the transport's own honesty: taken,
  // not yet read. The record is the one staged for the socket attempt: one message, one id.
  expect(dials).toHaveLength(1);
  expect(result.route).toBe('typed');
  expect(result.outcome).toBe('delivered');
  expect(result.reason).toBe('trigger taken, no read receipt yet');
  const trigger = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme' });
  if (trigger === null) throw new Error('the trigger did not fit');
  expect(pane.typed).toEqual([trigger]);
  expect(pane.enters).toBe(1);
  expect(readFileSync(result.record as string, 'utf8')).toContain(result.id);
});

test('a socket refusal with no typed leg in the order types nothing behind it', async () => {
  const made = world(['socket']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const pane = scripted(['idle'], '─'.repeat(30));
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      throw new Error('connect ECONNREFUSED');
    },
  });

  const run = await sendDirect(owner(made.root), host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
  });

  // The order names no typed leg, so the refusal is the walk's ending: the socket is named with
  // the transport's own reason, and no fallback is invented.
  expect(run.code).toBe(1);
  const result = run.result;
  if (result === null) throw new Error('the walk recorded no ending');
  expect(dials).toHaveLength(1);
  expect(result.route).toBe('socket');
  expect(result.outcome).toBe('unreachable');
  expect(result.reason).toBe('connect ECONNREFUSED');
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
});

test('a guard that refuses between the socket and the typed fallback types nothing', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const pane = scripted(['idle', 'working'], '─'.repeat(30));
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      throw new Error('connect ECONNREFUSED');
    },
  });
  // The first recheck stands the socket dial; the watch's authority is gone by the time the
  // refused frame hands the send to the typed leg.
  let asked = 0;
  const guard = (): { ok: true } | { ok: false; why: string } => {
    asked += 1;
    return asked === 1 ? { ok: true } : { ok: false, why: "the recorded watch is another watch's epoch" };
  };

  const run = await sendDirect(owner(made.root), host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
    guard,
  });

  expect(run.code).toBe(1);
  const result = run.result;
  if (result === null) throw new Error('the walk recorded no ending');
  expect(asked).toBe(2);
  expect(dials).toHaveLength(1);
  expect(result.route).toBe('typed');
  expect(result.outcome).toBe('refused');
  expect(result.reason).toBe("the recorded watch is another watch's epoch");
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
});

test('a direct-only send whose order holds no direct route attempts nothing and writes nothing', async () => {
  const made = world(['typed']);
  cleanup = made.cleanup;
  const pane = scripted(['idle'], null);
  const host = fake(made, { native: pane });

  const run = await sendDirect(owner(made.root), host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
  });

  expect(run.code).toBe(1);
  expect(run.result).toBeNull();
  expect(pane.typed).toEqual([]);
  // A refusal or a passed-over order is not an attempt: no signed record was staged.
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
});

test('a direct-only send never counts an inbox record or a drop copy as a wake', async () => {
  const made = world(['mcp-inbox', 'drop']);
  cleanup = made.cleanup;
  const pane = scripted(['idle'], null);
  const host = fake(made, { native: pane });

  const run = await sendDirect(owner(made.root), host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
  });

  // Neither leg reaches a live receiver: the inbox leg stores the record in the seat's folder and
  // the drop leg writes the same file, so neither is attempted by a wake path and nothing is left.
  expect(run.result).toBeNull();
  expect(pane.typed).toEqual([]);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
});

test('the dispatcher reads only a delivered route as a wake', () => {
  const delivered: DirectSendResult = { outcome: 'delivered', route: 'socket', id: 'i', record: '/r' };
  expect(workPushResultOf(delivered, '')).toEqual({ ok: true, outcome: 'socket: delivered' });
  const held: DirectSendResult = { ...delivered, outcome: 'held', reason: 'the box held it' };
  expect(workPushResultOf(held, '')).toEqual({ ok: false, refused: 'socket: held: the box held it' });
  const unreachable: DirectSendResult = { ...delivered, outcome: 'unreachable' };
  expect(workPushResultOf(unreachable, '')).toEqual({ ok: false, refused: 'socket: unreachable' });
  // A stored copy is never a wake, even though the send command exits 0 for it.
  const copied: DirectSendResult = { ...delivered, route: 'drop', outcome: 'held', reason: 'the record is stored; no seat was woken' };
  expect(workPushResultOf(copied, '')).toEqual({ ok: false, refused: 'drop: held: the record is stored; no seat was woken' });
  expect(workPushResultOf(null, 'team send: refused: no live agent\n'))
    .toEqual({ ok: false, refused: 'team send: refused: no live agent' });
  expect(workPushResultOf(null, ''))
    .toEqual({ ok: false, refused: 'the send ended before any direct route was attempted' });
});

test('a direct-only send refuses a pane the pass did not see, before any route is attempted', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const dials: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'lead', pane: 'w2:p9' }],
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const run = await sendDirect(io, host, {
    seat: 'lead',
    pane: 'w1:p1',
    cli: 'claude-code',
    body: 'a note',
  });

  expect(run.code).toBe(1);
  expect(run.result).toBeNull();
  expect(dials).toEqual([]);
  expect(io.err).toContain('its pane is now w2:p9, not the w1:p1 the pass saw');
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
});
