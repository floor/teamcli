// A history read limited to some message ids returns exactly the entries a full read returns
// for those ids, in the same order: a line is passed over unparsed only when it cannot name one.
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { appendHistory, historyLineSkippable, readHistory, type HistoryEntry } from '../src/send/history.ts';
import { world, type World } from './send-native-fixtures.ts';

const made: World[] = [];
afterEach(() => {
  for (const one of made.splice(0)) one.cleanup();
});

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

function entry(id: string, via: string, ts: string, body = 'hello'): HistoryEntry {
  return { ts, from: 'lead', to: 'seat', body, id, outcome: 'delivered', via } as HistoryEntry;
}

describe('which raw lines may be passed over', () => {
  test('a line naming none of the ids and holding no \\u escape', () => {
    expect(historyLineSkippable(`{"id":"${C}","body":"x"}`, [A, B])).toBe(true);
    expect(historyLineSkippable(`{"id":"${A}","body":"x"}`, [A, B])).toBe(false);
    expect(historyLineSkippable(`{"id":"${C}","body":"${B} quoted"}`, [A, B])).toBe(false);
  });

  test('any \\u escape keeps the line, since an id can be spelled through one', () => {
    expect(historyLineSkippable('{"id":"\\u0061aaaaaaa-1111-4111-8111-111111111111"}', [A])).toBe(false);
  });

  test('an id of another shape keeps every line', () => {
    expect(historyLineSkippable(`{"id":"${C}"}`, ['id with space'])).toBe(false);
    expect(historyLineSkippable(`{"id":"${C}"}`, ['quote"id'])).toBe(false);
  });
});

describe('the limited read and the full read agree', () => {
  test('the same entries for the wanted ids, oldest first, retries included', () => {
    const one = world(null, []);
    made.push(one);
    appendHistory('acme', one.root, one.home, entry(A, 'socket', '2026-11-17T10:00:00.000Z'));
    appendHistory('acme', one.root, one.home, entry(C, 'typed', '2026-11-17T10:00:01.000Z'));
    appendHistory('acme', one.root, one.home, entry(B, 'channel', '2026-11-17T10:00:02.000Z'));
    appendHistory('acme', one.root, one.home, entry(A, 'typed', '2026-11-17T10:00:03.000Z', 'retry'));
    const full = readHistory('acme', one.root, one.home);
    const limited = readHistory('acme', one.root, one.home, new Set([A, B]));
    expect(full.ok && limited.ok).toBe(true);
    if (!full.ok || !limited.ok) return;
    expect(limited.entries).toEqual(full.entries.filter((one) => one.id === A || one.id === B));
    expect(limited.entries.map((one) => one.via)).toEqual(['socket', 'channel', 'typed']);
  });

  test('a line that spells a wanted id through \\u escapes is still read', () => {
    const one = world(null, []);
    made.push(one);
    appendHistory('acme', one.root, one.home, entry(C, 'typed', '2026-11-17T10:00:00.000Z'));
    const ok = readHistory('acme', one.root, one.home);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const escaped = JSON.stringify(entry(A, 'native', '2026-11-17T10:00:01.000Z')).replace(`"${A}"`, `"\\u0061${A.slice(1)}"`);
    appendFileSync(ok.path, `${escaped}\n`);
    const full = readHistory('acme', one.root, one.home);
    const limited = readHistory('acme', one.root, one.home, new Set([A]));
    expect(full.ok && limited.ok).toBe(true);
    if (!full.ok || !limited.ok) return;
    expect(limited.entries).toEqual(full.entries.filter((one) => one.id === A));
    expect(limited.entries).toHaveLength(1);
  });
});
