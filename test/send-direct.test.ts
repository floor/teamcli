// The direct-only send seam: the watch's idle dispatch runs the ordinary send command with the
// typed and native legs left out, hands in the pane and CLI its own pass saw, and reads back the
// route that ended the walk rather than an exit code. Nothing here types, and a send the caller
// did not see is refused before any route is attempted.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { sendDirect } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
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
