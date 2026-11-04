// A socket frame carries a sender the daemon was asked to deliver for, and nothing attests the
// caller: the frame's content is prefixed with the attribution mark, so a seat reading its pane
// never takes the displayed name for proof. Every sender is attributed, never verified, and the
// mark is always present. The receiving CLI is a fake; no live pane and no real socket. Synthetic
// home and repository only.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

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

/** The team names an entity, and that entity's own lobby is in the file's trust list. */
function declareEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** An accepting seat with no declared order walks the socket first. */
function socketWorld(): World {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made);
  return made;
}

test('a socket-delivered message opens with the sender attributed', async () => {
  const made = socketWorld();
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  const code = await runSend(['lead', 'a note'], owner(made.root), host);
  expect(code).toBe(0);
  expect(frames).toHaveLength(1);
  const frame = JSON.parse(frames[0] as string) as { message: { content: string } };
  expect(frame.message.content.startsWith('[attributed sender: owner]\n')).toBe(true);
  // The display header and the body follow the mark, in that order.
  expect(frame.message.content).toContain('a note');
  expect(frame.message.content.indexOf('a note')).toBeGreaterThan(
    frame.message.content.indexOf('[attributed sender: owner]'),
  );
});
