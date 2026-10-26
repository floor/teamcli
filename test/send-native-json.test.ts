// --json for a native seat. The socket documents live in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('--json sent (unconfirmed) names the seat, exit 0, and the drop id', async () => {
  // A trigger the seat takes is a transport delivery, not a read: the box cleared and the
  // screen moved on, and no signed read receipt came back. The document therefore says
  // `sent (unconfirmed)` with the trigger note, as docs/internal/commands/send.md's typed-leg row says,
  // and the exit is still 0 — the record is on disk.
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
  expect(doc.status).toBe('sent (unconfirmed)');
  expect(doc.action_summary).toBe('native: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)');
  expect(doc.project).toBe('acme');
  expect(doc.session).toBe('acme');
  expect(doc.channel).toBe('typed');
  expect(doc.ids.reply).toBeNull();
  expect('reply' in doc).toBe(false);
  expect('plan' in doc).toBe(false);
  const drops = dropDir(made.dir);
  const names = readdirSync(drops);
  // The drop is the signed record the document names; the `<id>.fallback.json` beside it is
  // the delivery walk's episode marker (src/send/fallback-events.ts), a derivative file and
  // never a second message.
  expect(names.filter((name) => !name.endsWith('.fallback.json'))).toEqual([doc.ids.sent]);
  expect(names).toContain(`${doc.ids.sent}.fallback.json`);
  expect(recordBody(join(drops, doc.ids.sent))).toBe(filed('hello'));
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
  // The drop is the message. Two derivative files sit beside it, both named after the same id
  // and neither a drop: `.pending` is the watch's retry record, and `.fallback.json` is the
  // delivery walk's episode marker (src/send/fallback-events.ts keeps the attempts and the
  // escalation there). Counting either as a second drop reads a retry or a marker as a message.
  const names = readdirSync(drops);
  const ids = names.filter((name) => !name.endsWith('.pending') && !name.endsWith('.fallback.json'));
  expect(ids.length).toBe(1);
  const id = ids[0] ?? '';
  expect(names).toContain(`${id}.pending`);
  expect(names).toContain(`${id}.fallback.json`);
  const path = join(drops, id);
  expect(doc.error.message).toContain(path);
  expect(recordBody(path)).toBe(filed('hello'));
});

test('--json --wait on a native seat sends the record and reports send.timeout when no reply arrives on the thread', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['idle', 'working']);
  host.waitMs = 0;
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--wait', '--timeout', '5', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe('');
  const doc = JSON.parse(io.out) as unknown;
  expect(doc).toEqual({
    schema: { name: 'team.error', version: 1 },
    error: {
      id: 'send.timeout',
      message: 'native: timeout: sent, no reply on the thread within 5s; the thread stays open',
      repair: null,
    },
    // The error document carries the resolved walk, as the delivered one does.
    delivery: [
      { leg: 'mcp-inbox', state: 'skipped', reason: 'no live inbox listener' },
      { leg: 'typed', state: 'attempted' },
    ],
  });
  expect(pane.typed.length).toBe(1);
  expect(pane.enters).toBe(1);
  expect(host.frames).toEqual([]);
});
