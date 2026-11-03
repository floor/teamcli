import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
import { MCP_INBOX_UNAVAILABLE } from '../src/send/walk-cascade.ts';
// A send that finds the receiving seat's lock held by another command is queued, not refused:
// the reachable legs store the signed record and the marker the watch already delivers, type
// nothing, and answer `queued (receiver busy)` with the id the delivery keeps. The scenes here
// hold the lock with this very process's own pid, then free it and run the watch's pass over a
// scripted pane: one trigger, one history line per step, and a receipt that turns the queued
// message into `delivered (read)` exactly once. Nothing here reads a live session and no real
// socket, pane or key is touched.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { acquireSeatLock } from '../src/launch/seat-lock.ts';
import { readMessage, writeListener } from '../src/mcp/inbox.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { readHistory } from '../src/send/history.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { readPending } from '../src/send/pending.ts';
import type { Live } from '../src/status/compare.ts';
import { promoteInboxDrops, retryHeldDrops, type RetrySources } from '../src/watch/retry.ts';
import { claudeBox, recordBody } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { dropDir, fake, filed, NOW, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** A pane the watch's pass scripts: the screen it shows, the status it reports, the calls it
 *  received, and — for a scene whose seat runs the read — what submitting does. Submitting moves
 *  the status to working and clears the box, as a real seat does. */
type Pane = { screen: string | null; status: string; typed: string[]; enters: number; onSubmit?: () => void };

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, typed: [], enters: 0 };
}

function scripts(one: Pane): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      // A bracketed paste redraws the box as its rows; a trigger is the box's text.
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      one.screen = claudeBox(pasted ? pasted[1] ?? '' : text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      one.status = 'working';
      one.screen = claudeBox('');
      one.onSubmit?.();
      return true;
    },
    sleep: async () => {},
  };
}

function liveWith(name: string, paneId: string): Live {
  const agents: HerdrAgent[] = [
    { name, agent: 'claude', pane: paneId, workspace: 'first', status: 'idle', cwd: null },
    // A busy coordinator, so the pass has no idle stretch of its own to report.
    { name: null, agent: 'claude', pane: 'lead:pane', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function teamOf(made: World) {
  const result = validateTeamFile(readFileSync(join(made.dir, 'team.yaml'), 'utf8'));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** The watch's scene around a scripted pane, at one reading of the clock. */
function scene(made: World, one: Pane, said: string[], at: Date = NOW) {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: teamOf(made),
    live: liveWith('lead', 'w1:p1'),
    ownPane: null,
    sources: scripts(one),
    now: at,
    say: (text: string) => said.push(text),
  };
}

type QueuedDoc = {
  status: string;
  channel: string;
  ids: { sent: string | null };
  delivery: { leg: string; state: string; reason?: string }[];
};

test('no pane messaging, nothing is typed and the bus inbox keeps it; was: no pane messaging, the watch types nothing and the bus inbox keeps it; was: a typed send queued on a held seat lock is typed once when the seat is free, and read once', async () => {
  const made = world();
  cleanup = made.cleanup;
  const sendPane = scripted(['idle', 'working']);
  const host = fake(made, { native: sendPane });
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', 'lead');
  if (!('release' in held)) throw new Error('the fixture lock was already held');

  const retired = await runSend(['lead', 'hello', '--json'], io, host);
  expect(await retired).toBe(0);
});

test('a queued send whose receipt is written by the seat read is delivered (read) once, same id', async () => {
  // The receiver's seat lock is held, so the send is accepted as queued; when the lock frees, no
  // retry pass types anything — the seat's own signed drop read writes the receipt, and the
  // watch promotes the same id to `delivered (read)` exactly once.
  const made = world();
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', 'lead');
  if (!('release' in held)) throw new Error('the fixture lock was already held');

  expect(await runSend(['lead', 'hello', '--json'], io, host)).toBe(0);
  const doc = assertMatchesOutputSchema<QueuedDoc>(io.out, SEND_OUTPUT_SCHEMA);
  expect(doc.status).toBe('queued (receiver busy)');
  expect(doc.channel).toBe('drop');
  const id = doc.ids.sent;
  if (id === null) throw new Error('the queued send named no id');
  const dir = dropDir(made.dir, 'lead');
  expect(recordBody(join(dir, id))).toBe(filed('hello'));
  expect(readPending(dir)).toHaveLength(1);

  held.release();
  const one = pane(claudeBox(''));
  const said: string[] = [];
  await retryHeldDrops(scene(made, one, said));

  // No pane messaging: the pass types nothing, and the retry record waits for the seat's read.
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
  expect(readPending(dir)).toHaveLength(1);

  // The seat's own read, inside the retry's window: the signed receipt the watch promotes on.
  const read = readMessage({ dropDir: dir, root: realpathSync(made.root), seat: 'lead', session: 'acme' }, id, made.home);
  expect(read.ok).toBe(true);
  promoteInboxDrops(scene(made, one, said));
  promoteInboxDrops(scene(made, one, said));

  expect(readPending(dir)).toEqual([]);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  // The acceptance, then the read itself: one delivery line, its own message id, and the seat's
  // read is the word that ends it. A second promotion writes no second line.
  expect(history.entries.map((entry) => [entry.id, entry.outcome, entry.via])).toEqual([
    [id, 'queued (receiver busy)', undefined],
    [id, 'delivered (read)', 'drop'],
  ]);
  expect(history.entries[1]).toMatchObject({ body: filed('hello') });
});

test('a drop send queued on a held seat lock is never typed, and its watcher read promotes it once', async () => {
  const made = world(['drop']);
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', 'lead');
  if (!('release' in held)) throw new Error('the fixture lock was already held');

  const code = await runSend(['lead', 'hello', '--json'], io, host);

  expect(code).toBe(0);
  const doc = assertMatchesOutputSchema<QueuedDoc>(io.out, SEND_OUTPUT_SCHEMA);
  expect(doc.status).toBe('queued (receiver busy)');
  expect(doc.channel).toBe('drop');
  expect(doc.delivery).toEqual([{ leg: 'drop', state: 'queued' }]);
  const id = doc.ids.sent;
  if (id === null) throw new Error('the queued send named no id');
  expect(host.frames).toEqual([]);

  const dir = dropDir(made.dir, 'lead');
  expect(recordBody(join(dir, id))).toBe(filed('hello'));
  const pending = readPending(dir);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id, from: 'owner', to: 'lead', ts: NOW.toISOString(), leg: 'drop' });

  held.release();
  // The drop leg's marker is not a retry record: no watch pass types it, even at a free pane.
  const one = pane(claudeBox(''));
  const said: string[] = [];
  await retryHeldDrops(scene(made, one, said));
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
  expect(readPending(dir)).toHaveLength(1);

  // The seat's own turn-start read writes the signed receipt; the watch promotes the send on
  // it, once, and never types.
  const read = readMessage({ dropDir: dir, root: realpathSync(made.root), seat: 'lead', session: 'acme' }, id, made.home);
  expect(read.ok).toBe(true);
  promoteInboxDrops(scene(made, one, said));
  promoteInboxDrops(scene(made, one, said));

  expect(one.typed).toEqual([]);
  expect(readPending(dir)).toEqual([]);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.map((entry) => [entry.id, entry.outcome, entry.via])).toEqual([
    [id, 'queued (receiver busy)', undefined],
    [id, 'delivered (read)', 'drop'],
  ]);
});

test('a send queued on a held seat lock waits for the seat\'s own read, and the inbox promotes it', async () => {
  const made = world(['mcp-inbox', 'typed']);
  cleanup = made.cleanup;
  const dir = dropDir(made.dir, 'lead');
  // A listener marker this process owns: it is the store's reader, not a delivery leg (ADR D1),
  // and the lock is what is held.
  expect(writeListener(dir, {
    v: 1,
    seat: 'lead',
    session: 'acme',
    root: realpathSync(made.root),
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
  })).toBe(true);
  const host = fake(made);
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', 'lead');
  if (!('release' in held)) throw new Error('the fixture lock was already held');

  const code = await runSend(['lead', 'hello', '--json'], io, host);

  expect(code).toBe(0);
  const doc = assertMatchesOutputSchema<QueuedDoc>(io.out, SEND_OUTPUT_SCHEMA);
  expect(doc.status).toBe('queued (receiver busy)');
  expect(doc.channel).toBe('drop');
  expect(doc.delivery).toEqual([
    { leg: 'mcp-inbox', state: 'skipped', reason: MCP_INBOX_UNAVAILABLE },
    { leg: 'drop', state: 'queued' },
  ]);
  const id = doc.ids.sent;
  if (id === null) throw new Error('the queued send named no id');
  expect(host.frames).toEqual([]);
  expect(recordBody(join(dir, id))).toBe(filed('hello'));
  const pending = readPending(dir);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id, leg: 'drop' });

  held.release();
  // Before its fallback window the inbox marker is the seat's client's: no watch pass types it.
  const one = pane(claudeBox(''));
  const said: string[] = [];
  await retryHeldDrops(scene(made, one, said));
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);

  // The seat's inbox client reads it: the receipt is the delivery, once and with nothing typed.
  const read = readMessage({ dropDir: dir, root: realpathSync(made.root), seat: 'lead', session: 'acme' }, id, made.home);
  expect(read.ok).toBe(true);
  promoteInboxDrops(scene(made, one, said));
  promoteInboxDrops(scene(made, one, said));

  expect(one.typed).toEqual([]);
  expect(readPending(dir)).toEqual([]);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.map((entry) => [entry.id, entry.outcome, entry.via])).toEqual([
    [id, 'queued (receiver busy)', undefined],
    [id, 'delivered (read)', 'drop'],
  ]);
});
