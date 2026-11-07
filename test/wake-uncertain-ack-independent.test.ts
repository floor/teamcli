// A typed wake that pressed Enter and then could not read the acknowledgement keeps its
// reservation. A second request for the same id does not take that reservation again, so it
// does not type. The walk is the real typed wake. The pane host is the outer edge: it draws
// an idle composer, takes the line and the Enter, and then every read is unreadable.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serveWakeChild, type WakeChildDeps } from '../src/daemon/wake/child.ts';
import type { WakeChildRequest } from '../src/daemon/wake/token.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { reserveWake, wakeMarkAt, wakePath } from '../src/send/wake-marker.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const LINE = 'Answer the note.';
const SEAT = 'hand';
const SESSION = 'scratch';
const PANE = 'fixture-pane-one';
const NOW = new Date('2026-11-06T17:00:00.000Z');
const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'idle.txt'), 'utf8');

function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

const owned: string[] = [];

afterEach(() => {
  const paths = owned.splice(0);
  if (paths.length > 0) discardFixtures(paths, { roots: [join(paths[0] ?? '.', '..')] });
});

test('an unread acknowledgement keeps the reservation so the same id is not typed again', async () => {
  const scratch = fixtureBase('wake-uncertain-');
  owned.push(scratch);
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const dir = join(root, '.agents');
  const drops = join(dir, 'drops');
  mkdirSync(drops, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dropPath = join(drops, ID);
  const request: WakeChildRequest = {
    version: 1,
    id: ID,
    seat: SEAT,
    session: SESSION,
    cli: 'muse',
    line: LINE,
    dropPath,
    dir,
    root,
    project: 'acme',
    home,
    from: 'guide',
    body: 'kept',
    stagedAt: NOW.getTime() - 1_000,
  };
  const marker = wakePath(dirname(dropPath), ID);
  expect(reserveWake(marker, { id: ID, at: NOW.toISOString(), state: 'reserved' })).toBe(true);

  let reads = 0;
  let enters = 0;
  const typed: string[] = [];
  const host: TypedWakeHost = {
    read: () => {
      reads += 1;
      if (reads <= 2) return IDLE;
      if (enters === 0) return holding(LINE);
      return null;
    },
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  let walks = 0;
  const deps: WakeChildDeps = {
    agents: () => [{ name: SEAT, pane: PANE }],
    processes: () => null,
    walk: async (bound, pane, line, cli) => {
      walks += 1;
      expect(pane).toBe(PANE);
      return deliverTypedWake(bound, pane, line, cli);
    },
    wakeHost: () => host,
    now: () => NOW,
  };

  const first = await serveWakeChild(request, deps);
  expect(first.outcome).toBe('failed');
  if (first.outcome === 'failed') expect(first.reason).toContain('could not be read');
  expect(typed).toEqual([LINE]);
  expect(enters).toBe(1);
  expect(walks).toBe(1);
  expect(wakeMarkAt(marker)).not.toBeNull();
  expect(reserveWake(marker, { id: ID, at: NOW.toISOString(), state: 'reserved' })).toBe(false);
  expect(walks).toBe(1);
  expect(enters).toBe(1);
});
