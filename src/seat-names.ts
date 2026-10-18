// A seat name's number: the trailing digits a name carries after its separator (`builder-9`,
// `builder-10`, `builder-100`). The number is read by pattern and compared as a number wherever
// names are ordered or minted, so 9 sorts before 10 at any width and the next free number is the
// next integer, never the next string. The width and separator are the `seat-numbering` setting's
// (2- by default): `seatNumberingInForce` resolves it for a team, and every helper here takes the
// value it resolves rather than assuming a width.

import { SEAT_NUMBERING_DEFAULT, type SeatNumbering } from './settings/inherit.ts';

/** How a seat number is written: its width, or `auto` for as many digits as the number needs. */
export type { SeatNumbering } from './settings/inherit.ts';

/** `2-`: two digits, the separator `-`. The default until a file or a policy says otherwise. */
export const DEFAULT_SEAT_NUMBERING: SeatNumbering = SEAT_NUMBERING_DEFAULT;

/** A name's numbered tail: the stem before the separator, the number, and its digits as written
 *  (`builder-01` gives the stem `builder`, the number 1 and the digits `01`). */
export type SeatNumber = { base: string; number: number; digits: string };

/**
 * The number a seat name carries after the separator, or null when its tail is not digits —
 * `builder`, `builder-tmp`, `builder-x`. The last separator wins, so `builder-tmp-3` is number 3
 * of the stem `builder-tmp`. Leading zeros are read as part of the number: `builder-01` is
 * number 1, and the width it was written at is the digits' own length.
 */
export function seatNumberOf(name: string, separator: string = DEFAULT_SEAT_NUMBERING.separator): SeatNumber | null {
  const cut = name.lastIndexOf(separator);
  if (cut <= 0) return null;
  const digits = name.slice(cut + separator.length);
  if (!/^\d+$/.test(digits)) return null;
  return { base: name.slice(0, cut), number: Number(digits), digits };
}

/** One seat number as the numbering writes it: zero-padded to its width, or plain for `auto`. */
export function formatSeatNumber(n: number, numbering: SeatNumbering = DEFAULT_SEAT_NUMBERING): string {
  const digits = String(n);
  return numbering.width === 'auto' ? digits : digits.padStart(numbering.width, '0');
}

/**
 * The next free numbered name under `stem` — `builder-tmp` gives `builder-tmp-01`, or the next
 * integer after the used ones. A name holds its number whatever width it was written at, and
 * under either the configured separator or `-`, so a registry carrying `builder-tmp-1` from an
 * older build still occupies number 1 and the next mint is number 2.
 */
export function nextFreeSeatNumber(
  stem: string,
  used: Iterable<string>,
  numbering: SeatNumbering = DEFAULT_SEAT_NUMBERING,
): string {
  const separators = new Set([numbering.separator, '-']);
  const taken = new Set<number>();
  for (const name of used) {
    for (const separator of separators) {
      const parsed = seatNumberOf(name, separator);
      if (parsed !== null && parsed.base === stem) taken.add(parsed.number);
    }
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${stem}${numbering.separator}${formatSeatNumber(n, numbering)}`;
}

/**
 * Seat names in their own order: two names of one stem compare by number, so `builder-9` comes
 * before `builder-10` and `builder-100`; anything else (another stem, or a name with no numbered
 * tail) compares as code units, as it always did. A mixed-width team — `builder-9`, `builder-10`,
 * `builder-100` — orders 9, 10, 100.
 */
export function compareSeatNames(a: string, b: string, separator: string = DEFAULT_SEAT_NUMBERING.separator): number {
  const left = seatNumberOf(a, separator);
  const right = seatNumberOf(b, separator);
  if (left !== null && right !== null && left.base === right.base) return left.number - right.number;
  return a < b ? -1 : a > b ? 1 : 0;
}
