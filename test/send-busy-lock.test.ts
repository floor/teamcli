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

test('a typed send queued on a held seat lock is typed once when the seat is free, and read once', async () => {
  const made = world();
  cleanup = made.cleanup;
  const sendPane = scripted(['idle', 'working']);
  const host = fake(made, { native: sendPane });
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', 'lead');
  if (!('release' in held)) throw new Error('the fixture lock was already held');

  const code = await runSend(['lead', 'hello', '--json'], io, host);

  expect(code).toBe(0);
  expect(io.err).toBe('');
  const doc = assertMatchesOutputSchema<QueuedDoc>(io.out, SEND_OUTPUT_SCHEMA);
  expect(doc.status).toBe('queued (receiver busy)');
  expect(doc.channel).toBe('typed');
  // The walk stopped at the typed leg: the leg it queued on says so, the leg behind was never
  // reached, and the inbox leg is still the skip it was.
  expect(doc.delivery).toEqual([
    { leg: 'mcp-inbox', state: 'skipped', reason: 'no live inbox listener' },
    { leg: 'typed', state: 'queued' },
  ]);
  const id = doc.ids.sent;
  expect(id).not.toBeNull();
  if (id === null) return;

  // Nothing was typed and no frame was dialed; the signed record and the marker are the send.
  expect(sendPane.typed).toEqual([]);
  expect(sendPane.enters).toBe(0);
  expect(host.frames).toEqual([]);
  const dir = dropDir(made.dir, 'lead');
  expect(recordBody(join(dir, id))).toBe(filed('hello'));
  const pending = readPending(dir);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id, from: 'owner', to: 'lead', ts: NOW.toISOString() });
  // A marker with no leg is the typed retry's record, exactly as a held send leaves it.
  expect(pending[0]?.leg).toBeUndefined();

  // The acceptance is the only line so far: nothing was delivered, so nothing says so.
  const sent = readHistory('acme', made.root, made.home);
  expect(sent.ok).toBe(true);
  if (!sent.ok) return;
  expect(sent.entries.map((entry) => [entry.id, entry.outcome])).toEqual([[id, 'queued (receiver busy)']]);

  held.release();
  const one = pane(claudeBox(''));
  const said: string[] = [];
  await retryHeldDrops(scene(made, one, said));

  expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
  expect(one.enters).toBe(1);
  expect(readPending(dir)).toEqual([]);
  // A later pass finds no marker: the trigger is never typed a second time.
  await retryHeldDrops(scene(made, one, said, new Date(NOW.getTime() + 60_000)));
  expect(one.typed).toHaveLength(1);
  expect(one.enters).toBe(1);

  // The trigger left the box and no receipt came back: the queued send is sent, never called
  // delivered, and the id is the one the acceptance named.
  const taken = readHistory('acme', made.root, made.home);
  expect(taken.ok).toBe(true);
  if (!taken.ok) return;
  expect(taken.entries.map((entry) => [entry.id, entry.outcome])).toEqual([
    [id, 'queued (receiver busy)'],
    [id, 'sent (unconfirmed)'],
  ]);
  expect(taken.entries[1]).toMatchObject({ body: filed('hello'), via: 'typed', note: 'trigger taken, no read receipt yet' });
  expect(taken.entries.some((entry) => String(entry.outcome).startsWith('delivered'))).toBe(false);
});

test('a queued send whose trigger writes the read receipt is delivered (read) once, same id', async () => {
  const made = world();
  cleanup = made.cleanup;
  const host = fake(made);
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', 'lead');
  if (!('release' in held)) throw new Error('the fixture lock was already held');

  expect(await runSend(['lead', 'hello', '--json'], io, host)).toBe(0);
  const doc = assertMatchesOutputSchema<QueuedDoc>(io.out, SEND_OUTPUT_SCHEMA);
  const id = doc.ids.sent;
  if (id === null) throw new Error('the queued send named no id');
  const dir = dropDir(made.dir, 'lead');

  held.release();
  const one = pane(claudeBox(''));
  const said: string[] = [];
  // The seat does what the trigger asks: its own signed drop read, inside the retry's window.
  one.onSubmit = () => {
    const read = readMessage({ dropDir: dir, root: realpathSync(made.root), seat: 'lead', session: 'acme' }, id, made.home);
    if (!read.ok) throw new Error(read.reason);
  };
  await retryHeldDrops(scene(made, one, said));

  expect(one.typed).toHaveLength(1);
  expect(one.enters).toBe(1);
  expect(readPending(dir)).toEqual([]);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  // The acceptance, then the read itself: one delivery line, its own message id, and the seat's
  // read is the word that ends it.
  expect(history.entries.map((entry) => [entry.id, entry.outcome, entry.via])).toEqual([
    [id, 'queued (receiver busy)', undefined],
    [id, 'delivered (read)', 'typed'],
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

test('an inbox send queued on a held seat lock waits for its inbox read, then the fallback retry', async () => {
  const made = world(['mcp-inbox', 'typed']);
  cleanup = made.cleanup;
  const dir = dropDir(made.dir, 'lead');
  // A listener marker this process owns: the inbox leg is live, and the lock is what is held.
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
  expect(doc.channel).toBe('mcp-inbox');
  expect(doc.delivery).toEqual([
    { leg: 'mcp-inbox', state: 'queued' },
    { leg: 'typed', state: 'not-reached' },
  ]);
  const id = doc.ids.sent;
  if (id === null) throw new Error('the queued send named no id');
  expect(host.frames).toEqual([]);
  expect(recordBody(join(dir, id))).toBe(filed('hello'));
  const pending = readPending(dir);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id, leg: 'mcp-inbox' });

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
    [id, 'delivered (read)', 'mcp-inbox'],
  ]);
});
