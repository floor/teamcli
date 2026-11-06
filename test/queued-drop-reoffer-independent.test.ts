// Independent scenes for a queued drop. A seat that goes from working to idle is offered
// the oldest drop once, through the guarded wake. Staying idle offers nothing more. A seat
// that is still working is not offered, and nothing is typed. A mid-turn pane is never typed
// into. No queued drop means no offer. Synthetic homes and a fake pane only.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Seat, TeamFile } from '../src/file/types.ts';
import { markPending } from '../src/send/pending.ts';
import { RECORD_KIND, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';
import { retryHeldDrops, type RetryScene } from '../src/watch/retry.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8');
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };
const NOW = new Date('2026-11-06T15:00:00.000Z');
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'pane-1';

const homes: string[] = [];
afterEach(() => discardFixtures(homes.splice(0)));

function seat(): Seat {
  return {
    role: 'implementer',
    name: SEAT,
    cli: 'grok',
    vendor: 'xai',
    model: 'grok',
    version: '4.7',
    display: 'grok',
    launch: 'grok',
    cwd: '.',
    label: SEAT,
    mode: 'shared',
    parked: false,
    stopped: false,
    declared: SEAT,
    count: 1,
    instance: 1,
    line: 1,
  };
}

type Made = {
  scene: RetryScene;
  offers: string[];
  prompts: string[];
  typed: string[];
  enters: () => number;
};

function open(status: () => string, queued: boolean): Made {
  const root = mkdtempSync(join(tmpdir(), 'queued-drop-'));
  homes.push(root);
  const home = join(root, 'home');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const offers: string[] = [];
  const prompts: string[] = [];
  const typed: string[] = [];
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => WORKING,
    type: (_pane, text) => { typed.push(text); return true; },
    enter: () => { enters += 1; return true; },
    prompt: (_pane, line) => { prompts.push(line); return true; },
    wait: async () => {},
  };
  const scene: RetryScene = {
    dir,
    session: SESSION,
    root,
    home,
    team: { format: 1, project: 'acme', session: SESSION, orchestrator: 'lead', seats: [seat()] } as TeamFile,
    live: {
      running: true,
      agents: [{ name: SEAT, agent: 'grok', pane: PANE, workspace: 'ws-1', status: 'idle', cwd: root }],
      workspaces: [],
      screens: {},
    },
    ownPane: null,
    now: NOW,
    say: () => {},
    sources: {
      screen: () => WORKING,
      status: () => status(),
      typeText: () => { typed.push('typeText'); return true; },
      pressEnter: () => { enters += 1; return true; },
      sleep: async () => {},
      typedWake: async (pane, line, cli) => {
        offers.push(line);
        return deliverTypedWake(host, pane, line, cli, FAST);
      },
    },
  };
  if (queued) {
    plant(home, root, 'older-drop', 'alpha', '2026-11-06T14:50:00.000Z');
    plant(home, root, 'newer-drop', 'beta', '2026-11-06T14:55:00.000Z');
  }
  return { scene, offers, prompts, typed, enters: () => enters };
}

function plant(home: string, root: string, id: string, body: string, at: string): void {
  const record: RecordPayload = {
    kind: RECORD_KIND,
    id,
    to: SEAT,
    to_id: null,
    root,
    session: SESSION,
    at,
    body,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  };
  const dropDir = join(root, '.agents', 'send-drops', SESSION, SEAT);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const written = writeRecord(dropDir, signRecord(record, home));
  if (!written.ok) throw new Error(written.reason);
  markPending(dropDir, { id, from: 'owner', to: SEAT, body, ts: at, leg: 'drop' });
}

test('a seat that goes from working to idle is offered the oldest queued drop once', async () => {
  if (readScreen('grok', WORKING).kind !== 'working') throw new Error('the grok frame is not a running turn');
  let state = 'working';
  const made = open(() => state, true);
  await retryHeldDrops(made.scene);
  expect(made.offers).toEqual([]);
  state = 'idle';
  await retryHeldDrops(made.scene);
  expect(made.offers).toHaveLength(1);
  expect(made.offers[0]).toContain('alpha');
  expect(made.offers[0]).not.toContain('beta');
  await retryHeldDrops(made.scene);
  expect(made.offers).toHaveLength(1);
});

test('a seat that stays idle is offered nothing more', async () => {
  const made = open(() => 'idle', true);
  await retryHeldDrops(made.scene);
  const offered = made.offers.length;
  await retryHeldDrops(made.scene);
  expect(made.offers.length).toBe(offered);
  expect(offered).toBeLessThanOrEqual(1);
});

test('a seat that is still working is not offered, and nothing is typed', async () => {
  const made = open(() => 'working', true);
  await retryHeldDrops(made.scene);
  await retryHeldDrops(made.scene);
  expect(made.offers).toEqual([]);
  expect(made.prompts).toEqual([]);
  expect(made.typed).toEqual([]);
  expect(made.enters()).toBe(0);
});

test('a mid-turn pane is never typed into', async () => {
  const made = open(() => 'idle', true);
  await retryHeldDrops(made.scene);
  expect(made.prompts).toEqual([]);
  expect(made.typed).toEqual([]);
  expect(made.enters()).toBe(0);
});

test('an idle seat with no queued drop is offered nothing', async () => {
  const made = open(() => 'idle', false);
  await retryHeldDrops(made.scene);
  expect(made.offers).toEqual([]);
  expect(made.prompts).toEqual([]);
});
