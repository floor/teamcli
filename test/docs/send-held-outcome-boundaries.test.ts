import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The feed page says each completed `team send` run appends one line to messages.jsonl, and this
// branch adds `delivered (read)` and `sent (unconfirmed)` to the outcomes it names. The list is
// not page prose: it is the binary's own history union, and the page must carry exactly it — no
// outcome the binary never writes down, and none it does write down missing. `refused` is the
// edge: a refusal writes no history, and the day an append sneaks into the refusal path is the
// day this page quietly lies.

const FEED = readFileSync(new URL('../../docs/commands/feed.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const SEND_PAGE = readFileSync(new URL('../../docs/internal/commands/send.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const HISTORY_SRC = readFileSync(new URL('../../src/send/history.ts', import.meta.url), 'utf8');
const SEND_SRC = readFileSync(new URL('../../src/commands/send.ts', import.meta.url), 'utf8');

// The outcomes the binary may write to the history, from the union that types the append. The
// union may be laid out over several lines, and an outcome may hold a parenthesis.
const union = HISTORY_SRC.match(/export type HistoryOutcome =\s*([^;]+);/)?.[1] ?? '';
const written = [...union.matchAll(/'([^']+)'/g)].map((one) => one[1]);

// The outcomes send.ts actually appends, one per appendHistory call.
const appended = [...SEND_SRC.matchAll(/appendHistory\([^;]*?outcome: '([^']+)'/g)].map((one) => one[1]);

describe('the feed page’s outcome list', () => {
  test('the list is the binary’s history union, every outcome and no other', () => {
    expect(written.length, 'the history union is no longer a list of plain outcomes').toBeGreaterThanOrEqual(5);
    const listed = FEED.match(/run \((.*?)\) appends one JSON object/)?.[1] ?? '';
    expect(listed, 'feed.md lost its outcome list').not.toBe('');
    for (const outcome of written) {
      expect(listed.includes(`\`${outcome}\``), `feed.md does not name ${outcome}, which the binary writes down`).toBe(true);
    }
    const pageOnes = [...listed.matchAll(/`([^`]+)`/g)].map((one) => one[1]);
    expect(pageOnes.length, 'feed.md names an outcome the history union does not have').toBe(written.length);
  });

  test('the line the page shows is the entry the binary writes, field for field', () => {
    const entry = HISTORY_SRC.match(/export type HistoryEntry = \{([^}]+)\}/)?.[1] ?? '';
    // Required and optional alike — `ms` and `via` are declared `ms?:` and `via?:`, and the
    // page's example line shows the full shape, both present.
    const fields = [...entry.matchAll(/^\s*(\w+)\??:/gm)].map((one) => one[1]);
    expect(fields.length, 'the history entry lost its fields').toBeGreaterThanOrEqual(6);
    const line = FEED.match(/\{"ts":"<ISO-8601>"[^}]*\}/)?.[0] ?? '';
    expect(line, 'feed.md lost its example line').not.toBe('');
    for (const field of fields) {
      expect(line.includes(`"${field}":`), `the example line lacks the entry’s ${field} field`).toBe(true);
    }
    expect((line.match(/":/g) ?? []).length, 'the example line carries a field the entry does not have').toBe(fields.length);
    expect(FEED.includes('messages.jsonl'), 'feed.md no longer names the history file').toBe(true);
    expect(HISTORY_SRC.includes("export const HISTORY_FILE = 'messages.jsonl'"), 'the binary’s history file changed names').toBe(true);
  });

  test('send.ts appends exactly the outcomes the page lists, and never a refusal', () => {
    expect(new Set(appended), 'send.ts appends an outcome outside the history union').toEqual(new Set(written));
    expect(appended.includes('held'), 'held no longer reaches the history').toBe(true);
    expect(appended.includes('refused'), 'a refusal is now written down; feed.md says it is not').toBe(false);
  });

  test('the send page carries the outcomes the feed list belongs to', () => {
    // The README's `team send` row names no outcome; this page is where the full list lives, so
    // the list is held here.
    const outcomes = '`delivered` (or `delivered (read)`), `sent (unconfirmed)`, `answered`, `held`, `queued (receiver busy)`, `not-submitted`, `timeout`, `unreachable` or `refused`';
    expect(SEND_PAGE.includes(`one of ${outcomes}`), 'send.md lost the outcome sentence').toBe(true);
  });
});
