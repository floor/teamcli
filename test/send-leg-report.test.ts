// The delivery report a send prints under `--json`: the resolved walk's legs in order, each
// attempted, skipped, refused or not reached, with the word that kept it out. A dry run walks
// nothing, so its entries are candidate or skipped with `eligible`, and the implied socket leg a
// Claude receiver's files do not let the walk dial is listed too rather than left out. Every scene
// is synthetic: a temporary team, a fake pane, a fake socket write and a settings file this test
// writes itself. No live session is read and nothing real is dialed or written.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { LOG_FILE } from '../src/state.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';
import { dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's own launch declaration at its generated settings path. The file predates
 *  the socket it stands for, as a launcher's declaration does when the session started after it. */
function declare(made: World, seat: string, policy: string): void {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
  writeFileSync(join(made.sockets, '222.sock'), '');
}

type DeliveryEntry = { leg: string; state: string; eligible?: boolean; reason?: string };

/** The `delivery` list of a `team.send` action document, after the schema check. */
function deliveryOf(io: { out: string }): DeliveryEntry[] {
  const doc = assertMatchesOutputSchema<{ delivery?: DeliveryEntry[] }>(io.out, SEND_OUTPUT_SCHEMA);
  expect(doc.delivery).toBeDefined();
  return doc.delivery as DeliveryEntry[];
}

test('a real send marks the legs it walked, the leg that took it, and the legs behind it', async () => {
  const made = world(['mcp-inbox', 'typed', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made, { native: scripted(['idle', 'working']) });
  const io = owner(made.root);

  const code = await runSend(['lead', 'hello', '--json'], io, host);

  expect(code).toBe(0);
  const doc = assertMatchesOutputSchema<{ status: string; channel: string }>(io.out, SEND_OUTPUT_SCHEMA);
  expect(doc.status).toBe('sent (unconfirmed)');
  expect(doc.channel).toBe('typed');
  expect((doc as unknown as { delivery: DeliveryEntry[] }).delivery).toEqual([
    { leg: 'mcp-inbox', state: 'skipped', reason: 'no live inbox listener' },
    { leg: 'typed', state: 'attempted' },
    { leg: 'drop', state: 'not-reached' },
  ]);
});

test('a refused send reports the refusing leg and the legs the walk never reached, in the error document', async () => {
  const made = world(['typed', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made, {
    agents: () => [{ name: 'lead', pane: 'w1:p1' }, { name: 'lead', pane: 'w1:p2' }],
  });
  const io = owner(made.root);

  const code = await runSend(['lead', 'hello', '--json'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe('');
  const doc = assertJsonErrorShape(io.out, {
    id: 'send.refused',
    messageContains: 'more than one agent of this name',
  }) as unknown as { delivery: DeliveryEntry[] };
  // The error schema admits the list: a failed send reports the same walk a delivered one does.
  expect(doc.delivery).toEqual([
    { leg: 'typed', state: 'refused', reason: 'lead: herdr lists more than one agent of this name; nothing was sent' },
    { leg: 'drop', state: 'not-reached' },
  ]);
});

test('a dry run lists the implied socket leg as a candidate when the receiver may take it, and dials nothing', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'lead', 'accept');
  const host = fake(made);
  const io = owner(made.root);

  const code = await runSend(['lead', 'hello', '--dry-run', '--json'], io, host);

  expect(code).toBe(0);
  expect(deliveryOf(io)).toEqual([
    { leg: 'socket', state: 'candidate', eligible: true },
    { leg: 'mcp-inbox', state: 'candidate', eligible: true },
    { leg: 'typed', state: 'candidate', eligible: true },
    { leg: 'drop', state: 'candidate', eligible: true },
  ]);
  // A dry run writes nothing: no frame, no record, no history or log line.
  expect(host.frames).toEqual([]);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  expect(existsSync(join(made.dir, LOG_FILE))).toBe(false);
});

test('a dry run lists the socket the walk would not dial with its reason instead of omitting it', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);

  const code = await runSend(['lead', 'hello', '--dry-run', '--json'], io, host);

  expect(code).toBe(0);
  expect(deliveryOf(io)).toEqual([
    {
      leg: 'socket',
      state: 'skipped',
      eligible: false,
      reason: 'the receiving Claude session does not declare crossSessionInbound accept',
    },
    { leg: 'mcp-inbox', state: 'candidate', eligible: true },
    { leg: 'typed', state: 'candidate', eligible: true },
    { leg: 'drop', state: 'candidate', eligible: true },
  ]);
  expect(host.frames).toEqual([]);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  expect(existsSync(join(made.dir, LOG_FILE))).toBe(false);
});

test('a dry run reports the native leg it would walk for a Codex seat, and the one no sender here can walk', async () => {
  const made = world(['native', 'typed', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made);

  const codex = owner(made.root);
  expect(await runSend(['native', 'hello', '--dry-run', '--json'], codex, host)).toBe(0);
  expect(deliveryOf(codex)).toEqual([
    { leg: 'native', state: 'candidate', eligible: true },
    { leg: 'typed', state: 'candidate', eligible: true },
    { leg: 'drop', state: 'candidate', eligible: true },
  ]);

  // The same order for a Claude receiver: the native leg is the sending session's own
  // SendMessage, and this run's sender is the owner, so the leg is skipped with that word.
  const claude = owner(made.root);
  expect(await runSend(['lead', 'hello', '--dry-run', '--json'], claude, host)).toBe(0);
  expect(deliveryOf(claude)).toEqual([
    {
      leg: 'native',
      state: 'skipped',
      eligible: false,
      reason: "unavailable; the native leg is the sending session's own SendMessage",
    },
    { leg: 'typed', state: 'candidate', eligible: true },
    { leg: 'drop', state: 'candidate', eligible: true },
  ]);
  expect(host.frames).toEqual([]);
  expect(existsSync(join(made.dir, LOG_FILE))).toBe(false);
});
