// A plain send is the drop file for every seat, Claude Code included, and `--wait` to a Claude
// Code seat is refused while the socket is not the channel: the frame it waits on is a write
// this build does not make. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { dropDir, fake, filed, owner, scripted, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('a plain send to a claude-code seat writes the drop and types one trigger', async () => {
  const made = world();
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  expect(pane.typed[0]).not.toContain('hello');
  expect(pane.enters).toBe(1);
  const drops = dropDir(made.dir, 'lead');
  const files = readdirSync(drops);
  expect(files.length).toBe(1);
  expect(readFileSync(join(drops, files[0] as string), 'utf8')).toBe(filed('hello'));
});

test('--wait to a claude-code seat is refused: no frame, no drop, nothing typed', async () => {
  const made = world();
  cleanup = made.cleanup;
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], owner(made.root), host);

  expect(code).toBe(1);
  expect(host.frames).toEqual([]);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  expect(existsSync(join(made.dir, 'send-drops'))).toBe(false);
});
