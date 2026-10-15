// The list page's seat-row section, word for word: the roster's columns, its placeholder words,
// the two status changes, the stopped-session rule, the activity counting rule and the JSON keys.
// The section's sentences are the contract the --seats output is read against; a rewrite may
// reword what surrounds them, never them. The counting rules and the activity format are pinned
// to the code's own functions, so the page and the code cannot drift apart unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { activeSeatsOf, formatActiveSeats } from '../../src/commands/list.ts';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const PAGE = '../../docs/commands/list.md';

describe('the list page seat-row sentences', () => {
  test('the roster\'s columns, placeholders and status changes stand, verbatim', () => {
    const page = prose(PAGE);
    expect(page).toContain('`name`, `id`, `status`, `cli`, `model`, `pane`');
    expect(page).toContain('A value herdr and the team file do not give is `-`, a status that cannot be read is `?`');
    expect(page).toContain(
      'a blocked seat is `waiting`, and a seat the file declares that herdr does not have is `stopped` — so every declared seat has a row. A stopped session has no roster and no rows.',
    );
  });

  test('the activity counting rule and the JSON key sets stand, verbatim', () => {
    const page = prose(PAGE);
    expect(page).toContain('an `idle` or `ready` seat counting as ready — `2 ready / 0 working / 0 waiting / 0 stopped`');
    expect(page).toContain(
      '`roster` and `active` to each object: the six shown fields per seat, plus `role`, `effort` and `last_active` when the team file is read, `null` for what is not there. A session with no team file carries fewer keys: `name`, `status`, `pane`',
    );
  });

  test('the page\'s activity example is the code\'s own format', () => {
    expect(formatActiveSeats({ ready: 2, working: 0, waiting: 0, stopped: 0 })).toBe(
      '2 ready / 0 working / 0 waiting / 0 stopped',
    );
  });

  test('the page\'s counting rules are the code\'s own counting', () => {
    // A blocked seat is `waiting`; an idle seat counts as ready.
    expect(activeSeatsOf([{ name: 'a', status: 'blocked' }, { name: 'b', status: 'idle' }])).toEqual({
      ready: 1,
      working: 0,
      waiting: 1,
      stopped: 0,
    });
    // Seats the file declares that herdr does not have count as stopped.
    expect(activeSeatsOf([{ name: 'a', status: 'idle' }], 3)).toEqual({ ready: 1, working: 0, waiting: 0, stopped: 2 });
    // A stopped session has no roster and no rows: its declared seats are stopped, nothing else.
    expect(activeSeatsOf(null, 2, false)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 2 });
  });
});
