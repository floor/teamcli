// The advised `seat-numbering` setting: how a seat's number is written at the front of its name.
// The catalogue carries the two fields — `width` (1 to 4 digits, or `auto` for the smallest width
// that holds the team's largest number) and `separator` — as one canonical policy value, `2-` for
// the default. It is set at entity, project or team, and because it is an advised format with no
// tighter numbering to judge against, a lower level chooses freely.
import { describe, expect, test } from 'bun:test';
import {
  getPolicySpec,
  normalizePolicyName,
  resolvePolicy,
  type Policy,
  type PolicyLevel,
  type PolicyValue,
} from '../src/policy/index.ts';
import {
  parseSeatNumberingValue,
  seatNumberingOf,
  seatNumberingValue,
  seatWidthFor,
  SEAT_NUMBERING_DEFAULT,
  SEAT_NUMBERING_DEFAULT_VALUE,
} from '../src/settings/inherit.ts';

const AT = '2026-10-17T00:00:00.000Z';

function declared(level: PolicyLevel, value: PolicyValue, extra: Partial<Policy> = {}): Policy {
  return { name: 'seat-numbering', value, level, setter: 'owner', date: AT, kind: 'advised', ...extra };
}

function effective(declarations: Policy[]) {
  const result = resolvePolicy<string>('seat-numbering', declarations);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals));
  return result.effective;
}

function refusalsOf(declarations: Policy[]) {
  const result = resolvePolicy('seat-numbering', declarations);
  if (result.ok) throw new Error('expected a refusal, but the policy resolved');
  return result.refusals;
}

describe('the seat-numbering catalogue entry', () => {
  test('is advised, set at entity, project or team, and ships two digits and a hyphen', () => {
    const spec = getPolicySpec('seat-numbering');
    expect(spec).not.toBeNull();
    expect(spec?.kind).toBe('advised');
    expect(spec?.levels).toEqual(['entity', 'project', 'team']);
    expect(spec?.defaultValue).toBe('2-');
    expect(spec?.defaultValue).toBe(SEAT_NUMBERING_DEFAULT_VALUE);
    expect(spec?.gateLifting).toBe(false);
    expect(spec?.lowerLevelChooses).toBe(true);
    // The snake_case file spelling names the same policy.
    expect(normalizePolicyName('seat_numbering')).toBe('seat-numbering');
  });

  test('reads the canonical value back into the two fields', () => {
    expect(seatNumberingOf('2-')).toEqual(SEAT_NUMBERING_DEFAULT);
    expect(seatNumberingOf('2-')).toEqual({ width: 2, separator: '-' });
    expect(seatNumberingOf('auto.')).toEqual({ width: 'auto', separator: '.' });
    expect(seatNumberingOf('1')).toEqual({ width: 1, separator: '' });
    for (const value of ['1', '4_', '2-', '3.', 'auto/', 'auto']) {
      const parsed = parseSeatNumberingValue(value);
      expect(parsed).toBe(value);
      expect(seatNumberingValue(seatNumberingOf(value)!)).toBe(value);
    }
    for (const bad of ['', '0-', '5-', 'x-', '--', 2, null, true]) {
      expect(seatNumberingOf(bad)).toBeNull();
      expect(parseSeatNumberingValue(bad)).toBeNull();
    }
  });

  test('`auto` is the width of the team\'s largest number, and an explicit width is itself', () => {
    const auto = { width: 'auto' as const, separator: '-' };
    expect(seatWidthFor(auto, 7)).toBe(1);
    expect(seatWidthFor(auto, 42)).toBe(2);
    expect(seatWidthFor(auto, 123)).toBe(3);
    expect(seatWidthFor(auto, 1000)).toBe(4);
    const two = { width: 2 as const, separator: '-' };
    expect(seatWidthFor(two, 123)).toBe(2);
    expect(seatWidthFor(two, 7)).toBe(2);
  });
});

describe('resolving seat-numbering', () => {
  test('with no word at any level, the release default stands and names its level as default', () => {
    const resolved = effective([]);
    expect(resolved.value).toBe('2-');
    expect(resolved.level).toBe('default');
    expect(resolved.kind).toBe('advised');
    expect(resolved.setter).toBeNull();
  });

  test('an entity, project or team may set it, and the lowest level that speaks chooses', () => {
    expect(effective([declared('entity', '3.')]).value).toBe('3.');
    expect(effective([declared('project', '3_')]).value).toBe('3_');
    expect(effective([declared('team', 'auto/')]).value).toBe('auto/');
    // An advised format has nothing tighter to judge against: the team's word replaces the
    // entity's, even though it is neither wider nor narrower.
    const chosen = effective([declared('entity', '2-'), declared('project', '3_'), declared('team', '1/')]);
    expect(chosen.value).toBe('1/');
    expect(chosen.level).toBe('team');
  });

  test('the seat may not set it', () => {
    const refusals = refusalsOf([declared('seat', '2-')]);
    expect(refusals).toEqual([{
      kind: 'invalid-policy',
      level: 'seat',
      policy: 'seat-numbering',
      why: 'policy "seat-numbering" may not be set at level seat',
      message: 'seat: policy "seat-numbering" may not be set at level seat (allowed: entity, project, team)',
    }]);
  });

  test('a declaration of the wrong kind is refused', () => {
    const refusals = refusalsOf([declared('team', '2-', { kind: 'enforced' })]);
    expect(refusals).toEqual([{
      kind: 'invalid-policy',
      level: 'team',
      policy: 'seat-numbering',
      why: 'policy "seat-numbering" is advised, not enforced',
      message: 'team: policy "seat-numbering" has kind advised, not enforced',
    }]);
  });

  test('a value that is not a numbering is refused, naming the value as written', () => {
    for (const bad of ['5-', '0-', 'x-', '']) {
      const refusals = refusalsOf([declared('team', bad)]);
      expect(refusals).toEqual([{
        kind: 'invalid-policy',
        level: 'team',
        policy: 'seat-numbering',
        why: `invalid value "${bad}" for policy "seat-numbering"`,
        message: `team: invalid value "${bad}" for policy "seat-numbering"`,
      }]);
    }
  });

  test('an expired word is unset at its level: the default or the inherited word stands', () => {
    const expired = effective([declared('team', '3.', { expiry: '2020-01-01T00:00:00.000Z' })]);
    expect(expired.value).toBe('2-');
    expect(expired.level).toBe('default');
    expect(expired.expired.map((policy) => [policy.level, policy.value])).toEqual([['team', '3.']]);

    const live = effective([declared('team', '3.', { expiry: '2999-01-01T00:00:00.000Z' })]);
    expect(live.value).toBe('3.');
    expect(live.level).toBe('team');
  });

  test('the settings spelling of the name reads the same policy', () => {
    const result = resolvePolicy<string>('seat_numbering', [declared('project', '3.')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effective.name).toBe('seat-numbering');
      expect(result.effective.value).toBe('3.');
    }
  });
});
