// Channel follows the seat's cli. The native direction (drop file, no socket frame) is in
// send.test.ts. This is the other direction: a Claude Code seat. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { dropDir, fake, owner, scripted, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('a claude-code seat uses the socket and does not write a drop or type a trigger', async () => {
  const made = world();
  cleanup = made.cleanup;
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  const frame = JSON.parse((host.frames[0] as string).trim()) as { message: { content: string } };
  expect(frame.message.content).toBe('hello');
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  expect(existsSync(join(made.dir, 'send-drops'))).toBe(false);
});
