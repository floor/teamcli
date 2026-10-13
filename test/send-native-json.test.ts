// --json for a native seat. The socket documents live in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { dropDir, nativeHost, owner, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('--json delivered names the seat, exit 0, and the drop id', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['idle', 'working']);
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--json'], io, host);

  expect(code).toBe(0);
  expect(io.err).toBe('');
  const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; ids: { sent: string; reply: null } };
  expect(doc.seat).toBe('native');
  expect(doc.status).toBe('delivered');
  expect(doc.exit).toBe(0);
  expect(doc.ids.reply).toBeNull();
  expect('reply' in doc).toBe(false);
  expect('error' in doc).toBe(false);
  const drops = dropDir(made.dir);
  expect(readdirSync(drops)).toEqual([doc.ids.sent]);
  expect(readFileSync(join(drops, doc.ids.sent), 'utf8')).toBe('hello');
  expect(pane.typed.length).toBe(1);
  expect(host.frames).toEqual([]);
});

test('--json unreachable reports exit 1 and keeps the drop id', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host } = nativeHost(made, ['idle']);
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe('');
  const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; error: string; ids: { sent: string; reply: null } };
  expect(doc.seat).toBe('native');
  expect(doc.status).toBe('unreachable');
  expect(doc.exit).toBe(1);
  expect(doc.error).toContain('herdr did not report the seat working');
  expect(doc.ids.reply).toBeNull();
  const path = join(dropDir(made.dir), doc.ids.sent);
  expect(doc.error).toContain(path);
  expect(readFileSync(path, 'utf8')).toBe('hello');
  expect('reply' in doc).toBe(false);
});

test('--json refused for a native --wait writes nothing and sends no id', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['working']);
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--wait', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe('');
  const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; error: string; ids: { sent: null; reply: null } };
  expect(doc).toEqual({
    seat: 'native',
    status: 'refused',
    exit: 1,
    error: 'native runs codex: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent',
    ids: { sent: null, reply: null },
  });
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(existsSync(join(made.dir, 'send-drops'))).toBe(false);
  expect(host.frames).toEqual([]);
});
