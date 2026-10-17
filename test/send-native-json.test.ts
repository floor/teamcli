// --json for a native seat. The socket documents live in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';

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
  const doc = JSON.parse(io.out) as {
    schema: { name: string; version: number };
    format: number;
    dry_run: boolean;
    status: string;
    action_summary: string;
    project: string;
    session: string;
    seat: string;
    channel: string;
    ids: { sent: string; reply: null };
  };
  expect(doc.schema).toEqual({ name: 'team.send', version: 1 });
  expect(doc.format).toBe(1);
  expect(doc.dry_run).toBe(false);
  expect(doc.seat).toBe('native');
  expect(doc.status).toBe('delivered');
  expect(doc.action_summary).toBe('native: delivered');
  expect(doc.project).toBe('acme');
  expect(doc.session).toBe('acme');
  expect(doc.channel).toBe('typed');
  expect(doc.ids.reply).toBeNull();
  expect('reply' in doc).toBe(false);
  expect('plan' in doc).toBe(false);
  const drops = dropDir(made.dir);
  expect(readdirSync(drops)).toEqual([doc.ids.sent]);
  expect(readFileSync(join(drops, doc.ids.sent), 'utf8')).toBe(filed('hello'));
  expect(pane.typed.length).toBe(1);
  expect(host.frames).toEqual([]);
});

test('--json not-submitted writes the error document naming the box and the drop path', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host } = nativeHost(made, ['idle']);
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe('');
  const doc = JSON.parse(io.out) as {
    schema: { name: string; version: number };
    error: { id: string; message: string; repair: null };
  };
  expect(doc.schema).toEqual({ name: 'team.error', version: 1 });
  expect(doc.error.id).toBe('send.not-submitted');
  expect(doc.error.message).toStartWith('native: not-submitted: ');
  expect(doc.error.message).toContain('the seat did not take the trigger');
  expect(doc.error.message).toContain('the box could not be read');
  expect(doc.error.repair).toBeNull();
  const drops = dropDir(made.dir);
  // The drop is the message; the record beside it is the watch's retry, not a second drop.
  const ids = readdirSync(drops).filter((name) => !name.endsWith('.pending'));
  expect(ids.length).toBe(1);
  const path = join(drops, ids[0] ?? '');
  expect(doc.error.message).toContain(path);
  expect(readFileSync(path, 'utf8')).toBe(filed('hello'));
});

test('--json refused for a native --wait writes nothing and sends no id', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['working']);
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--wait', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe('');
  const doc = JSON.parse(io.out) as unknown;
  expect(doc).toEqual({
    schema: { name: 'team.error', version: 1 },
    error: {
      id: 'send.refused',
      message: 'refused: native runs codex: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent',
      repair: null,
    },
  });
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(existsSync(join(made.dir, 'send-drops'))).toBe(false);
  expect(host.frames).toEqual([]);
});
