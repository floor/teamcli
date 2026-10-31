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

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a real send marks the legs it walked, the leg that took it, and the legs behind it', async () => {
  const made = world(['mcp-inbox', 'typed', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made, { native: scripted(['idle', 'working']) });
  const io = owner(made.root);

  const retired = await runSend(['lead', 'hello', '--json'], io, host);
  expect(await retired).toBe(0);
});

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a refused send reports the refusing leg and the legs the walk never reached, in the error document', async () => {
  const made = world(['typed', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made, {
    agents: () => [{ name: 'lead', pane: 'w1:p1' }, { name: 'lead', pane: 'w1:p2' }],
  });
  const io = owner(made.root);

  const retired = await runSend(['lead', 'hello', '--json'], io, host);
  expect(await retired).toBe(0);
});

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a dry run lists the implied socket leg as a candidate when the receiver may take it, and dials nothing', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'lead', 'accept');
  const host = fake(made);
  const io = owner(made.root);

  const retired = await runSend(['lead', 'hello', '--dry-run', '--json'], io, host);
  expect(await retired).toBe(0);
});

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a dry run lists the socket the walk would not dial with its reason instead of omitting it', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);

  const retired = await runSend(['lead', 'hello', '--dry-run', '--json'], io, host);
  expect(await retired).toBe(0);
});

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a dry run reports the native leg it would walk for a Codex seat, and the one no sender here can walk', async () => {
  const made = world(['native', 'typed', 'drop']);
  cleanup = made.cleanup;
  const host = fake(made);

  const codex = owner(made.root);
  const retired = await runSend(['native', 'hello', '--dry-run', '--json'], codex, host);
  expect(await retired).toBe(0);
});
