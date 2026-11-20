// The delivery report a send prints under `--json`: the resolved walk's legs in order, each
// attempted, skipped, refused or not reached, with the word that kept it out. A dry run walks
// nothing, so its entries are candidate or skipped with `eligible`. The implied socket leg a
// Claude receiver's files do not let the walk dial, and the development channel a walk leaves
// out, are listed too rather than omitted. Every scene
// is synthetic: a temporary team, a fake pane, a fake socket write and a settings file this test
// writes itself. No live session is read and nothing real is dialed or written.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redeliverChannelOnSocket, runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { buildCommandOutputSchema, SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { LOG_FILE } from '../src/state.ts';
import { assertMatchesOutputSchema, validateAgainstJsonSchema } from './helpers/output.ts';
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

test('a dry run lists the implied socket leg as a candidate when the receiver may take it, and dials nothing', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'lead', 'accept');
  const host = fake(made);
  const io = owner(made.root);

  const code = await runSend(['lead', 'hello', '--dry-run', '--json'], io, host);

  expect(code).toBe(0);
  // The default order is typed, drop; this CLI declares no wake for the typed leg, so the dry
  // run names the drop alone behind the implied socket candidate.
  expect(deliveryOf(io)).toEqual([
    { leg: 'channel', state: 'skipped', eligible: false, reason: "the receiving seat's launch carries no development channel" },
    { leg: 'socket', state: 'candidate', eligible: true },
    { leg: 'drop', state: 'candidate', eligible: true },
  ]);
  // A dry run writes nothing: no frame, no record, no history or log line.
  expect(host.frames).toEqual([]);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  expect(existsSync(join(made.dir, LOG_FILE))).toBe(false);
});

test('an order led by the retired inbox word, with no proven channel, still walks the socket the seat accepts ahead of the drop', async () => {
  // The floor orchestrator's shape on a dark root: `[mcp-inbox]` resolves to the drop leg alone,
  // and with no channel listener nothing would wake the seat. The socket its files allow is walked.
  for (const order of [['mcp-inbox'], ['mcp-inbox', 'drop']]) {
    const made = world(order);
    declare(made, 'lead', 'accept');
    const host = fake(made);
    const io = owner(made.root);
    try {
      expect(await runSend(['lead', 'hello', '--dry-run', '--json'], io, host)).toBe(0);
      const legs = deliveryOf(io).filter((entry) => entry.state === 'candidate').map((entry) => entry.leg);
      expect(legs).toEqual(['socket', 'drop']);
      expect(host.frames).toEqual([]);
    } finally {
      made.cleanup();
    }
  }
});

test('an inbox-led order keeps the socket out when the seat does not accept it: the drop alone, as before', async () => {
  const made = world(['mcp-inbox']);
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);
  expect(await runSend(['lead', 'hello', '--dry-run', '--json'], io, host)).toBe(0);
  const legs = deliveryOf(io).filter((entry) => entry.state === 'candidate').map((entry) => entry.leg);
  expect(legs).toEqual(['drop']);
});

test('a dry run lists the socket the walk would not dial with its reason instead of omitting it', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);

  const code = await runSend(['lead', 'hello', '--dry-run', '--json'], io, host);

  expect(code).toBe(0);
  expect(deliveryOf(io)).toEqual([
    { leg: 'channel', state: 'skipped', eligible: false, reason: "the receiving seat's launch carries no development channel" },
    {
      leg: 'socket',
      state: 'skipped',
      eligible: false,
      reason: 'the receiving Claude session does not declare crossSessionInbound accept (human-launched or launch without --settings; owner CLI settings are not read)',
    },
    { leg: 'drop', state: 'candidate', eligible: true },
  ]);
  expect(host.frames).toEqual([]);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  expect(existsSync(join(made.dir, LOG_FILE))).toBe(false);
});

test('the report schema accepts the channel row and still refuses a leg no report names', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);

  expect(await runSend(['lead', 'hello', '--dry-run', '--json'], io, host)).toBe(0);
  const doc = JSON.parse(io.out) as { delivery: DeliveryEntry[] };
  const schema = buildCommandOutputSchema(SEND_OUTPUT_SCHEMA);
  // The development channel is a leg of the report, not of any declared order: the schema must
  // carry its row, and widening the enum by that one name must not open it to invented legs.
  expect(validateAgainstJsonSchema(doc, schema)).toEqual([]);
  const first = doc.delivery[0];
  if (first === undefined) throw new Error('the dry report carries no delivery row');
  doc.delivery[0] = { ...first, leg: 'invented' };
  const violations = validateAgainstJsonSchema(doc, schema).join('\n');
  expect(violations).toContain('$.delivery[0].leg');
  expect(violations).toContain('"invented"');
});

test('a body a carrier already delivered is not carried again by repeated socket redeliveries; an undelivered one still is', async () => {
  // The watch's Claude ladder and the channel's socket retry both redeliver on the socket. After the
  // first send's full-body frame, its delivered receipt stands: every later pass is the ID-only wake.
  const made = world(['socket', 'drop']);
  cleanup = made.cleanup;
  declare(made, 'lead', 'accept');
  const host = fake(made);
  const io = owner(made.root);
  expect(await runSend(['lead', 'Carried once\nand only once'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(host.frames[0]).toContain('Carried once\\nand only once');
  const drops = dropDir(made.dir, 'lead');
  const id = readdirSync(drops).find((name) => /^[0-9a-f-]{36}$/.test(name))!;
  expect(existsSync(join(drops, `${id}.delivered.json`))).toBe(true);
  const loaded = readTeamConfig(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('the fixture team file does not read');
  const again = () => redeliverChannelOnSocket({
    host, dir: made.dir, root: made.root, project: loaded.team.project, session: loaded.team.session, seat: 'lead', cli: 'claude-code',
    dropDir: drops, drop: { id, from: 'owner' }, team: loaded.team,
  });
  for (let pass = 0; pass < 3; pass += 1) expect((await again()).ok).toBe(true);
  expect(host.frames).toHaveLength(4);
  for (const frame of host.frames.slice(1)) {
    expect(frame).not.toContain('Carried once');
    expect(frame).toContain(id);
  }
  // A message whose delivered receipt is gone (nothing proves a hand-over) keeps its body.
  unlinkSync(join(drops, `${id}.delivered.json`));
  expect((await again()).ok).toBe(true);
  expect(host.frames[4]).toContain('Carried once\\nand only once');
});
