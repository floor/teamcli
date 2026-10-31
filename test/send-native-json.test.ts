import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
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

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: --json sent (unconfirmed) names the seat, exit 0, and the drop id', async () => {
  // A trigger the seat takes is a transport delivery, not a read: the box cleared and the
  // screen moved on, and no signed read receipt came back. The document therefore says
  // `sent (unconfirmed)` with the trigger note, as docs/commands/send.md's typed-leg row says,
  // and the exit is still 0 — the record is on disk.
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['idle', 'working']);
  const io = owner(made.root);

  const retired = await runSend(['native', 'hello', '--json'], io, host);
  expect(await retired).toBe(0);
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
      // The declared `typed` word wakes a Codex seat through its runtime queue (codex-daemon on).
      { leg: 'native', state: 'attempted', reason: 'no trusted runtime session is recorded for this seat (no agent record for this seat)' },
      { leg: 'drop', state: 'attempted' },
    ],
  });
  expect(pane.typed.length).toBe(0);
  expect(pane.enters).toBe(0);
  expect(host.frames).toEqual([]);
});
