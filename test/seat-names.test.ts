// Seat numbers are read by pattern and compared as numbers, not as strings: builder-9 comes
// before builder-10 and builder-100 at any width. The helpers take the `seat-numbering` value
// (width and separator) they are given; the default is two digits with `-`, so a minted
// temporary is `worker-tmp-01`. These scenes pin the widths, the crossings at 9 and 99, mixed
// widths in one team, and the clash a team file refuses.
import { describe, expect, test } from 'bun:test';
import {
  compareSeatNames,
  DEFAULT_SEAT_NUMBERING,
  formatSeatNumber,
  nextFreeSeatNumber,
  seatNumberOf,
} from '../src/seat-names.ts';

describe('a seat name\'s number', () => {
  test('is the trailing digits after the separator', () => {
    expect(seatNumberOf('builder-9')).toEqual({ base: 'builder', number: 9, digits: '9' });
    expect(seatNumberOf('builder-10')).toEqual({ base: 'builder', number: 10, digits: '10' });
    expect(seatNumberOf('builder-100')).toEqual({ base: 'builder', number: 100, digits: '100' });
  });

  test('reads leading zeros as part of the number: builder-01 is number 1', () => {
    expect(seatNumberOf('builder-01')).toEqual({ base: 'builder', number: 1, digits: '01' });
    expect(seatNumberOf('builder-001')).toEqual({ base: 'builder', number: 1, digits: '001' });
  });

  test('the last separator wins, so a temporary name carries its own number', () => {
    expect(seatNumberOf('builder-tmp-3')).toEqual({ base: 'builder-tmp', number: 3, digits: '3' });
  });

  test('a name with no numbered tail has none', () => {
    expect(seatNumberOf('builder')).toBeNull();
    expect(seatNumberOf('builder-tmp')).toBeNull();
    expect(seatNumberOf('builder-x')).toBeNull();
    expect(seatNumberOf('-1')).toBeNull();
    expect(seatNumberOf('')).toBeNull();
  });

  test('another separator reads that separator\'s tail', () => {
    expect(seatNumberOf('builder.10', '.')).toEqual({ base: 'builder', number: 10, digits: '10' });
    expect(seatNumberOf('builder-10', '.')).toBeNull();
  });
});

describe('writing a seat number at each width', () => {
  test('width 1 writes as many digits as the number needs', () => {
    expect(formatSeatNumber(1, { width: 1, separator: '-' })).toBe('1');
    expect(formatSeatNumber(9, { width: 1, separator: '-' })).toBe('9');
    expect(formatSeatNumber(10, { width: 1, separator: '-' })).toBe('10');
    expect(formatSeatNumber(100, { width: 1, separator: '-' })).toBe('100');
  });

  test('width 2, the default, pads to two digits and widens past 99', () => {
    expect(formatSeatNumber(1)).toBe('01');
    expect(formatSeatNumber(9)).toBe('09');
    expect(formatSeatNumber(10)).toBe('10');
    expect(formatSeatNumber(99)).toBe('99');
    expect(formatSeatNumber(100)).toBe('100');
  });

  test('width 3 pads to three digits', () => {
    expect(formatSeatNumber(1, { width: 3, separator: '-' })).toBe('001');
    expect(formatSeatNumber(9, { width: 3, separator: '-' })).toBe('009');
    expect(formatSeatNumber(10, { width: 3, separator: '-' })).toBe('010');
    expect(formatSeatNumber(100, { width: 3, separator: '-' })).toBe('100');
  });

  test('auto never pads', () => {
    expect(formatSeatNumber(1, { width: 'auto', separator: '-' })).toBe('1');
    expect(formatSeatNumber(10, { width: 'auto', separator: '-' })).toBe('10');
    expect(formatSeatNumber(100, { width: 'auto', separator: '-' })).toBe('100');
  });

  test('the default numbering is width 2 with "-"', () => {
    expect(DEFAULT_SEAT_NUMBERING).toEqual({ width: 2, separator: '-' });
  });
});

describe('the next free number', () => {
  test('an empty team mints 01 at the default width', () => {
    expect(nextFreeSeatNumber('worker-tmp', [])).toBe('worker-tmp-01');
  });

  test('the next integer after the used ones', () => {
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-01'])).toBe('worker-tmp-02');
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-01', 'worker-tmp-02'])).toBe('worker-tmp-03');
  });

  test('a gap is reused: 01 and 03 taken mints 02', () => {
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-01', 'worker-tmp-03'])).toBe('worker-tmp-02');
  });

  test('crossing 9 to 10: the tenth mint is 10, not the string after 09', () => {
    const used = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((n) => `worker-tmp-${n}`);
    expect(nextFreeSeatNumber('worker-tmp', used)).toBe('worker-tmp-10');
  });

  test('crossing 99 to 100: the hundredth mint is 100, not the string after 99', () => {
    const used = Array.from({ length: 99 }, (_, i) => `worker-tmp-${String(i + 1).padStart(2, '0')}`);
    expect(nextFreeSeatNumber('worker-tmp', used)).toBe('worker-tmp-100');
  });

  test('a name from an older width holds its number', () => {
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-1'])).toBe('worker-tmp-02');
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-001'])).toBe('worker-tmp-02');
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-01', 'worker-tmp-1', 'worker-tmp-001'])).toBe('worker-tmp-02');
  });

  test('a name under another separator still holds its number', () => {
    // The registry may carry `worker-tmp-1` from before a separator change; a mint under `.`
    // must not hand out 1 again.
    expect(nextFreeSeatNumber('worker-tmp', ['worker-tmp-1'], { width: 2, separator: '.' })).toBe('worker-tmp.02');
  });

  test('width 1 and auto mint without padding, width 3 pads to three', () => {
    expect(nextFreeSeatNumber('worker-tmp', [], { width: 1, separator: '-' })).toBe('worker-tmp-1');
    expect(nextFreeSeatNumber('worker-tmp', Array.from({ length: 9 }, (_, i) => `worker-tmp-${i + 1}`), { width: 1, separator: '-' }))
      .toBe('worker-tmp-10');
    expect(nextFreeSeatNumber('worker-tmp', [], { width: 'auto', separator: '-' })).toBe('worker-tmp-1');
    expect(nextFreeSeatNumber('worker-tmp', [], { width: 3, separator: '-' })).toBe('worker-tmp-001');
  });

  test('another stem\'s numbers do not count', () => {
    expect(nextFreeSeatNumber('worker-tmp', ['scribe-tmp-01', 'worker-tmp-x'])).toBe('worker-tmp-01');
  });
});

describe('ordering seat names', () => {
  test('9 before 10 before 100, the crossing at each digit count', () => {
    expect(compareSeatNames('builder-9', 'builder-10')).toBeLessThan(0);
    expect(compareSeatNames('builder-10', 'builder-100')).toBeLessThan(0);
    expect(compareSeatNames('builder-99', 'builder-100')).toBeLessThan(0);
    expect(compareSeatNames('builder-100', 'builder-9')).toBeGreaterThan(0);
    expect(compareSeatNames('builder-9', 'builder-9')).toBe(0);
  });

  test('a mixed-width team orders by number: 2, 9, 10, 100, whatever the padding', () => {
    const names = ['builder-100', 'builder-10', 'builder-9', 'builder-02'];
    expect(names.slice().sort(compareSeatNames)).toEqual(['builder-02', 'builder-9', 'builder-10', 'builder-100']);
    expect(compareSeatNames('builder-09', 'builder-10')).toBeLessThan(0);
    expect(compareSeatNames('builder-1', 'builder-01')).toBe(0);
  });

  test('a name with no numbered tail keeps the code-unit order it always had', () => {
    expect(compareSeatNames('alpha', 'builder')).toBeLessThan(0);
    expect(compareSeatNames('builder', 'builder-1')).toBeLessThan(0);
    expect(compareSeatNames('builder-x', 'builder-y')).toBeLessThan(0);
    // Different stems compare as text, never by their numbers.
    expect(compareSeatNames('zzz-1', 'aaa-9')).toBeGreaterThan(0);
    expect(compareSeatNames('builder-2', 'scribe-1')).toBeLessThan(0);
  });

  test('the strings a code-unit sort got wrong', () => {
    const names = ['builder', 'builder-100', 'builder-10', 'builder-2', 'builder-9'];
    expect(names.slice().sort()).toEqual(['builder', 'builder-10', 'builder-100', 'builder-2', 'builder-9']);
    expect(names.slice().sort(compareSeatNames)).toEqual(['builder', 'builder-2', 'builder-9', 'builder-10', 'builder-100']);
  });
});
