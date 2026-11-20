// `team drops --read --id <short id>`: the reader line and the event pointer print an 8-character
// id, and the seat reads by it. The short id names the one record in the seat's folders that
// starts with it; a record's own sidecars (`<id>.wake-try`, `<id>.lead-episode`, any
// `<id>.<anything>`) are never it, and an ambiguous or too-short word is left as given so the read
// refuses it.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDropId } from '../src/commands/drops.ts';

const A = '5203223c-0000-4000-8000-00000000a001';
const B = '5203223c-1111-4000-8000-00000000a002';
const C = '7d79d6d5-0000-4000-8000-00000000c003';

let base = '';
afterEach(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

function seatFolder(): string {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'drops-short-id-')));
  const dir = join(base, '.agents', 'send-drops', 'acme', 'worker');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('a unique short id names its record, never the sidecars beside it', () => {
  const dir = seatFolder();
  writeFileSync(join(dir, C), '{}');
  for (const suffix of ['wake-try', 'lead-episode', 'pending', 'read.json', 'a-later-sidecar']) writeFileSync(join(dir, `${C}.${suffix}`), '{}');
  expect(resolveDropId(dir, C.slice(0, 8))).toBe(C);
  expect(resolveDropId(dir, C.slice(0, 13))).toBe(C);
});

test('a whole id, a word under 8 characters, an ambiguous prefix, or one that names nothing is left as given', () => {
  const dir = seatFolder();
  writeFileSync(join(dir, A), '{}');
  writeFileSync(join(dir, B), '{}');
  expect(resolveDropId(dir, A)).toBe(A);
  expect(resolveDropId(dir, '5203223')).toBe('5203223');
  expect(resolveDropId(dir, '5203223c')).toBe('5203223c');
  expect(resolveDropId(dir, 'deadbeef')).toBe('deadbeef');
});

test('a short id finds a record in the seat\'s stamped folder too', () => {
  const dir = seatFolder();
  const stamped = join(base, '.agents', 'send-stamped', 'acme', 'worker');
  mkdirSync(stamped, { recursive: true });
  writeFileSync(join(stamped, C), '{}');
  writeFileSync(join(stamped, `${C}.wake-try`), '{}');
  expect(resolveDropId(dir, C.slice(0, 8))).toBe(C);
});

test('an unreadable folder of the seat leaves the word as given: half a listing never makes a prefix unique', () => {
  const dir = seatFolder();
  writeFileSync(join(dir, A), '{}');
  // The stamped seat folder is not a folder that lists: a second match could sit there.
  mkdirSync(join(base, '.agents', 'send-stamped', 'acme'), { recursive: true });
  writeFileSync(join(base, '.agents', 'send-stamped', 'acme', 'worker'), 'not a folder');
  expect(resolveDropId(dir, A.slice(0, 8))).toBe(A.slice(0, 8));
  // The legacy folder itself not listing is the same refusal.
  const fileDir = join(base, 'not-a-folder');
  writeFileSync(fileDir, 'x');
  expect(resolveDropId(fileDir, A.slice(0, 8))).toBe(A.slice(0, 8));
});

test('only a regular file with a record name counts: a folder, or an entry with another name, never blocks the one match', () => {
  const dir = seatFolder();
  writeFileSync(join(dir, A), '{}');
  // A folder named like a record with the same prefix, and dotless names that are no record.
  mkdirSync(join(dir, B));
  writeFileSync(join(dir, '5203223c-junk'), 'x');
  mkdirSync(join(dir, '5203223c-folder'));
  expect(resolveDropId(dir, '5203223c')).toBe(A);
});
