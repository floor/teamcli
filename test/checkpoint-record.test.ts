// The checkpoint record (context reset R2): the ask `team checkpoint` writes and `restart` reads.
// These scenes drive the real state door — `updateState`, `readState` and the sanitize pass — in
// synthetic folders under the temporary directory, with an injected clock. No pane, no CLI, no
// credential folder is read; the record names a path and never a file, and the scenes pin that.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardFixtures } from './fixture-cleanup.ts';
import { askCheckpoint, latestCheckpoint, BOUNDARY_WAIT_MS } from '../src/checkpoint/checkpoint.ts';
import { handoverPath } from '../src/handover/paths.ts';
import { readState, STATE_FILE } from '../src/state.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const LATER = new Date('2026-11-04T12:40:00Z');

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) discardFixtures([path]); });

/** A synthetic project folder holding only a state file. */
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-record-')));
  owned.push(dir);
  return dir;
}

test('the handover path is the shared shape: the handovers folder, the seat, the instant', () => {
  expect(handoverPath('/teams/vega', 'architect', NOW)).toBe(
    '/teams/vega/handovers/architect-2026-11-04T12-00-00-000Z.md',
  );
});

test('an ask writes one record per seat: who asked, the path, the session, and a deadline half an hour on', () => {
  const dir = project();
  const record = askCheckpoint(dir, 'architect', 'vega', 'the owner', NOW);
  expect(record).toEqual({
    by: 'the owner',
    path: join(dir, 'handovers', 'architect-2026-11-04T12-00-00-000Z.md'),
    session: 'vega',
    at: NOW.toISOString(),
    deadline: new Date(NOW.getTime() + BOUNDARY_WAIT_MS).toISOString(),
  });
  expect(readState(dir).checkpoints).toEqual({ architect: record });
  // The ask is the record and nothing else: no folder is made and no file is written — only the
  // seat writes the handover.
  expect(existsSync(join(dir, 'handovers'))).toBe(false);
});

test('a second ask replaces the seat\'s record: one ask stands, the later path', () => {
  const dir = project();
  askCheckpoint(dir, 'architect', 'vega', 'the owner', NOW);
  const again = askCheckpoint(dir, 'architect', 'vega', 'a lead', LATER);
  const held = readState(dir).checkpoints;
  expect(Object.keys(held ?? {})).toEqual(['architect']);
  expect(held?.architect).toEqual(again);
  expect(again.at).toBe(LATER.toISOString());
});

test('the standing ask is offered only inside the terminal-host session that asked', () => {
  const dir = project();
  expect(latestCheckpoint(readState(dir), 'architect', 'vega')).toBeNull();
  const record = askCheckpoint(dir, 'architect', 'vega', 'the owner', NOW);
  expect(latestCheckpoint(readState(dir), 'architect', 'vega')).toEqual(record);
  expect(latestCheckpoint(readState(dir), 'architect', 'another-session')).toBeNull();
  expect(latestCheckpoint(readState(dir), 'writer', 'vega')).toBeNull();
});

test('a deadline past does not hide the record: a late file is still the seat\'s own handover', () => {
  const dir = project();
  const record = askCheckpoint(dir, 'architect', 'vega', 'the owner', NOW);
  const state = readState(dir);
  expect(new Date(state.checkpoints?.architect?.deadline ?? '').getTime()).toBeLessThan(LATER.getTime());
  expect(latestCheckpoint(state, 'architect', 'vega')).toEqual(record);
});

test('the read door keeps the record the command writes and drops what a hand-edit made', () => {
  const dir = project();
  const record = askCheckpoint(dir, 'architect', 'vega', 'the owner', NOW);
  const writer = askCheckpoint(dir, 'writer', 'vega', 'the owner', NOW);
  const state = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
    ...state,
    checkpoints: {
      architect: record,
      writer,
      'not a seat': record,
      forged: { by: 'the owner', path: '/etc/passwd', session: 'vega', at: NOW.toISOString(), deadline: 'not a date' },
      empty: null,
    },
  }, null, 2)}\n`);
  const cleaned = readState(dir).checkpoints;
  // The door drops a key that is not a seat name and a record that is not the command's; each
  // seat's own record stays under its own name — only the command writes keys, so this is the
  // same truth the swap queue's door tells.
  expect(Object.keys(cleaned ?? {}).sort()).toEqual(['architect', 'writer']);
  expect(cleaned?.architect).toEqual(record);
  expect(cleaned?.writer).toEqual(writer);
});

test('the read door drops a path the ask never minted for this seat, however well-formed the record', () => {
  const dir = project();
  const record = askCheckpoint(dir, 'architect', 'vega', 'the owner', NOW);
  const writer = askCheckpoint(dir, 'writer', 'vega', 'the owner', NOW);
  const made = (path: string) => ({
    by: 'the owner',
    path,
    session: 'vega',
    at: NOW.toISOString(),
    deadline: NOW.toISOString(),
  });
  const state = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
    ...state,
    checkpoints: {
      architect: record,
      // A made-up path whose other fields are all well formed, deadline included: the state file
      // is unsigned, so the door cannot take the path on trust.
      foreign: made('/etc/passwd'),
      // Another seat's own minted path under this seat's name: minted, but not for this seat.
      swapped: made(writer.path),
    },
  }, null, 2)}\n`);
  const cleaned = readState(dir).checkpoints;
  expect(Object.keys(cleaned ?? {})).toEqual(['architect']);
  expect(cleaned?.architect).toEqual(record);
});
