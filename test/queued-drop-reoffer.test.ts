// A queued drop is offered again when its seat returns to idle: one call through the guarded
// wake for that stretch, nothing while the seat is still working, and nothing when no drop is
// queued. The wake seam is the one the watch binds (two empty-idle reads, nothing into a
// working pane). These scenes script that seam and touch no live session.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { acquireSeatLock } from '../src/launch/seat-lock.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { readPending } from '../src/send/pending.ts';
import type { TypedWakeResult } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import { retryHeldDrops, type RetrySources } from '../src/watch/retry.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { dropDir, fake, NOW, owner, world, type World } from './send-native-fixtures.ts';

const SEAT = 'agy';
const PANE = ['w1', 'p1'].join(':');

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

type Status = 'idle' | 'working' | 'done' | 'blocked';

type Wake = { pane: string; line: string; cli: string };

function watch(made: World, status: Status) {
  const box = { status, typed: [] as string[], enters: 0 };
  const wakes: Wake[] = [];
  const agents: HerdrAgent[] = [
    { name: SEAT, agent: 'antigravity', pane: PANE, workspace: 'first', status, cwd: null },
  ];
  const live: Live = { running: true, agents, workspaces: [], screens: {} };
  const sources: RetrySources = {
    screen: () => '',
    status: () => box.status,
    typeText: () => {
      box.typed.push('typed');
      return true;
    },
    pressEnter: () => {
      box.enters += 1;
      return true;
    },
    sleep: async () => {},
    typedWake: async (pane, line, cli): Promise<TypedWakeResult> => {
      wakes.push({ pane, line, cli });
      return { delivered: false, typed: false, tries: 0, reason: 'the scene counts the offer' };
    },
  };
  const team = validateTeamFile(readFileSync(join(made.dir, 'team.yaml'), 'utf8'));
  if (!team.ok) throw new Error(JSON.stringify(team.errors));
  const setStatus = (next: Status): void => {
    box.status = next;
    const agent = agents[0];
    if (agent !== undefined) agent.status = next;
  };
  return {
    wakes,
    box,
    setStatus,
    scene: {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team: team.team,
      live,
      ownPane: null,
      sources,
      now: NOW,
      say: () => {},
    },
  };
}

/** A drop-leg send held on the seat lock, then the lock released. The record and its marker stay. */
async function queueDrop(made: World): Promise<string> {
  const host = fake(made, { agents: () => [{ name: SEAT, pane: PANE }] });
  const io = owner(made.root);
  const held = acquireSeatLock(made.dir, 'acme', SEAT);
  if (!('release' in held)) throw new Error('the fixture lock was already held');
  try {
    expect(await runSend([SEAT, 'hello', '--json'], io, host)).toBe(0);
  } finally {
    held.release();
  }
  const doc = assertMatchesOutputSchema<{ status: string; channel: string; ids: { sent: string | null } }>(
    io.out,
    SEND_OUTPUT_SCHEMA,
  );
  expect(doc.status).toBe('queued (receiver busy)');
  expect(doc.channel).toBe('drop');
  const id = doc.ids.sent;
  if (id === null) throw new Error('the queued send named no id');
  return id;
}

test('a seat that returns to idle is offered its queued drop once', async () => {
  const made = world(['drop'], [{ name: SEAT, role: 'implementer', cli: 'antigravity' }]);
  cleanup = made.cleanup;
  const id = await queueDrop(made);
  const dir = dropDir(made.dir, SEAT);
  const pass = watch(made, 'working');

  await retryHeldDrops(pass.scene);
  expect(pass.wakes).toEqual([]);

  pass.setStatus('idle');
  await retryHeldDrops(pass.scene);
  await retryHeldDrops(pass.scene);

  expect(pass.wakes).toHaveLength(1);
  const wake = pass.wakes[0];
  if (wake === undefined) throw new Error('the idle pass offered nothing');
  expect(wake.pane).toBe(PANE);
  expect(wake.cli).toBe('antigravity');
  expect(wake.line.length).toBeGreaterThan(0);
  expect(pass.box.typed).toEqual([]);
  expect(pass.box.enters).toBe(0);
  expect(readPending(dir).map((drop) => [drop.id, drop.offered])).toEqual([[id, true]]);

  pass.setStatus('working');
  await retryHeldDrops(pass.scene);
  expect(pass.wakes).toHaveLength(1);
  expect(readPending(dir).map((drop) => drop.offered)).toEqual([undefined]);

  pass.setStatus('idle');
  await retryHeldDrops(pass.scene);
  await retryHeldDrops(pass.scene);
  expect(pass.wakes).toHaveLength(2);
});

test('a seat that is still working is not offered its queued drop', async () => {
  const made = world(['drop'], [{ name: SEAT, role: 'implementer', cli: 'antigravity' }]);
  cleanup = made.cleanup;
  await queueDrop(made);
  const pass = watch(made, 'working');

  await retryHeldDrops(pass.scene);
  await retryHeldDrops(pass.scene);

  expect(pass.wakes).toEqual([]);
  expect(pass.box.typed).toEqual([]);
  expect(pass.box.enters).toBe(0);
});

test('an idle seat with no queued drop is not offered anything', async () => {
  const made = world(['drop'], [{ name: SEAT, role: 'implementer', cli: 'antigravity' }]);
  cleanup = made.cleanup;
  const pass = watch(made, 'idle');

  await retryHeldDrops(pass.scene);
  pass.setStatus('working');
  await retryHeldDrops(pass.scene);
  pass.setStatus('idle');
  await retryHeldDrops(pass.scene);

  expect(pass.wakes).toEqual([]);
  expect(readPending(dropDir(made.dir, SEAT))).toEqual([]);
});
