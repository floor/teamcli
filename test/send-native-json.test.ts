import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
import { MCP_INBOX_UNAVAILABLE } from '../src/send/walk-cascade.ts';
// --json for a native seat. The socket documents live in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';
import { withoutSendId } from './helpers/output.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('--json sent (unconfirmed) names the seat, exit 0, and the drop id', async () => {
  // The drop file is the whole record: no read receipt came back, so the document says
  // `sent (unconfirmed)` and the exit is 0 — the record is on disk.
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['idle', 'working']);
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--json'], io, host);

  expect(code).toBe(0);
  expect(io.err).toBe(queuedLine('native', NO_EVENT_ADAPTER_TOOK_IT));
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
  expect(withoutSendId(doc.action_summary)).toBe('native: sent (unconfirmed) (drop, 0 ms); queued; native reads it at its next turn, and nothing here gives it one (pull-only)');
  expect(doc.project).toBe('acme');
  expect(doc.session).toBe('acme');
  expect(doc.channel).toBe('drop');
  expect(doc.ids.reply).toBeNull();
  expect('reply' in doc).toBe(false);
  expect('plan' in doc).toBe(false);
  const drops = dropDir(made.dir);
  const names = readdirSync(drops);
  // The drop is the signed record the document names; the `<id>.fallback.json` beside it is
  // the delivery walk's episode marker (src/send/fallback-events.ts), a derivative file and
  // never a second message.
  expect(names.filter((name) => !name.endsWith('.fallback.json') && !name.endsWith('.pending'))).toEqual([doc.ids.sent]);
  expect(names).toContain(`${doc.ids.sent}.fallback.json`);
  expect(recordBody(join(drops, doc.ids.sent))).toBe(filed('hello'));
  expect(pane.typed.length).toBe(0);
  expect(pane.enters).toBe(0);
  expect(host.frames).toEqual([]);
});

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: --json not-submitted writes the error document naming the box and the drop path', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host } = nativeHost(made, ['idle']);
  const io = owner(made.root);

  const retired = await runSend(['native', 'hello', '--json'], io, host);
  expect(await retired).toBe(0);
});

test('--json --wait on a native seat sends the record and reports send.timeout when no reply arrives on the thread', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['idle', 'working']);
  host.waitMs = 0;
  const io = owner(made.root);

  const code = await runSend(['native', 'hello', '--wait', '--timeout', '5', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe(queuedLine('native', NO_EVENT_ADAPTER_TOOK_IT));
  const doc = JSON.parse(io.out) as Record<string, unknown> & { error: Record<string, unknown> };
  // The text line's ` (id <uuid>)` tail rides the error message too; the rest of the document
  // is asserted exactly.
  const error = doc.error as { message: string };
  error.message = withoutSendId(error.message);
  expect(doc).toEqual({
    schema: { name: 'team.error', version: 1 },
    error: {
      id: 'send.timeout',
      message: 'native: timeout: sent, no reply on the thread within 5s; the thread stays open',
      repair: null,
    },
    // The error document carries the resolved walk, as the delivered one does.
    delivery: [
      { leg: 'mcp-inbox', state: 'skipped', reason: MCP_INBOX_UNAVAILABLE },
      // The declared `typed` word wakes a Codex seat through its runtime queue (codex-daemon on).
      { leg: 'native', state: 'attempted', reason: 'no trusted runtime session is recorded for this seat (no agent record for this seat)' },
      { leg: 'drop', state: 'attempted' },
    ],
  });
  expect(pane.typed.length).toBe(0);
  expect(pane.enters).toBe(0);
  expect(host.frames).toEqual([]);
});
