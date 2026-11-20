// The lead's capture notice for an unrecognised screen: one per episode, and an episode whose
// reservation was cut off before its record landed is published again under the same id.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatMailDirIn } from '../src/queue/mail-tree.ts';
import { clearUnrecognisedScreen, noteUnrecognisedScreen, unrecognisedScreenPath } from '../src/send/unrecognised-screen.ts';
import { world, type World } from './send-native-fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scene(): { made: World; dropDir: string; notices: () => string[] } {
  const made = world(['typed']);
  cleanups.push(made.cleanup);
  const dropDir = seatMailDirIn(made.dir, 'acme', 'helper');
  const lead = join(made.root, '.agents', 'messages', 'lead');
  return { made, dropDir, notices: () => (existsSync(lead) ? readdirSync(lead).filter((name) => name.startsWith('unrecognised-screen-helper-')).map((name) => join(lead, name)) : []) };
}

const AT = new Date('2026-11-20T21:13:00.000Z');

test('an episode whose reservation stands without its record is published by the next pass, once', () => {
  const { made, dropDir, notices } = scene();
  // A writer cut off between the reservation and the record: the marker is reserved, nothing landed.
  mkdirSync(dropDir, { recursive: true });
  const id = `unrecognised-screen-helper-${String(AT.getTime())}`;
  writeFileSync(unrecognisedScreenPath(dropDir), `${JSON.stringify({ at: AT.toISOString(), id, state: 'reserved', seat: 'helper', pane: 'pane-h' })}\n`);
  expect(notices()).toEqual([]);
  const input = { dropDir, root: made.root, session: 'acme', home: made.home, seat: 'helper', pane: 'pane-h', lead: 'lead', at: new Date(AT.getTime() + 60_000) };
  expect(noteUnrecognisedScreen(input)).toBe(true);
  expect(notices()).toHaveLength(1);
  expect(notices()[0]!.endsWith(`${id}.json`)).toBe(true);
  // A published episode stays quiet: the record under the reserved id is the publication.
  expect(noteUnrecognisedScreen({ ...input, at: new Date(AT.getTime() + 120_000) })).toBe(false);
  expect(notices()).toHaveLength(1);
});

test('a fresh episode is reserved, published and marked reported in one call', () => {
  const { made, dropDir, notices } = scene();
  const input = { dropDir, root: made.root, session: 'acme', home: made.home, seat: 'helper', pane: 'pane-h', lead: 'lead', at: AT };
  expect(noteUnrecognisedScreen(input)).toBe(true);
  expect(noteUnrecognisedScreen(input)).toBe(false);
  expect(notices()).toHaveLength(1);
  expect(readFileSync(notices()[0]!, 'utf8')).toContain('helper (pane pane-h): screen not recognised, capture needed');
});

test('a marker cleared at any point after the reservation is never recreated, and the next episode is reported', () => {
  const { made, dropDir, notices } = scene();
  const base = { dropDir, root: made.root, session: 'acme', home: made.home, seat: 'helper', pane: 'pane-h', lead: 'lead' };
  // The watch ends the episode (a delivered wake) right after the record lands: nothing is
  // written to the marker afterwards, so it stays gone.
  expect(noteUnrecognisedScreen({ ...base, at: AT, afterPublish: () => clearUnrecognisedScreen(dropDir) })).toBe(true);
  expect(existsSync(unrecognisedScreenPath(dropDir))).toBe(false);
  // The next unrecognised frame is a new episode, and its lead hears of it.
  expect(noteUnrecognisedScreen({ ...base, at: new Date(AT.getTime() + 60_000) })).toBe(true);
  expect(notices()).toHaveLength(2);
  // An open episode's marker is never rewritten by a later pass.
  const before = readFileSync(unrecognisedScreenPath(dropDir), 'utf8');
  expect(noteUnrecognisedScreen({ ...base, at: new Date(AT.getTime() + 120_000) })).toBe(false);
  expect(readFileSync(unrecognisedScreenPath(dropDir), 'utf8')).toBe(before);
});
