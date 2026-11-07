// The `messaging.store` word (ADR D8): what a send leaves behind. Durability is the safe side —
// `first` stores the signed record before the walk wakes the seat, `parallel` starts the write
// and the wake together and ends the send only when both settle, `none` never stores the record
// (the frame still carries the signed bytes). A level may always tighten toward `first`;
// loosening toward `parallel` or `none` is allowed only where the setting lists the level, which
// is the entity and the project. The file scenes pin the two places a team file writes the word;
// the resolver scenes pin the chain and its refusals; the catalogue scenes pin the signed record
// behind them.
import { describe, expect, test } from 'bun:test';
import { validateTeamFile } from '../src/file/validate.ts';
import { ENFORCED_POLICY_NAMES, POLICY_CATALOGUE, normalizePolicyName } from '../src/policy/types.ts';
import {
  MESSAGING_STORE,
  MESSAGING_STORES,
  isMessagingStore,
  wordDeclarationsOf,
  type MessagingStore,
  type WordDeclaration,
} from '../src/settings/inherit.ts';
import { messagingStore, resolveWordSetting } from '../src/settings/resolve.ts';

/** A minimal accepted file: a lead, a worker, and whatever the scene adds at the end (top-level
 *  words) or on the worker (`seatExtra` is already indented four spaces). */
function team(extra = '', seatExtra = ''): string {
  return `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: worker
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${seatExtra}${extra}`;
}

function parsed(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

describe('the team file', () => {
  test("the file's own word reads at the top level", () => {
    expect(parsed(team('messaging:\n  store: none\n')).messaging).toEqual({ store: 'none' });
  });

  test('a file that writes no word carries an empty map, so every old digest stands', () => {
    expect(parsed(team()).messaging).toEqual({});
  });

  test("a seat's word sits on the seat and nowhere else", () => {
    const file = parsed(team('', '    messaging:\n      store: parallel\n'));
    expect(file.seats.find((seat) => seat.name === 'helper')?.messaging).toEqual({ store: 'parallel' });
    expect(file.seats.find((seat) => seat.name === 'lead') ?? {}).not.toHaveProperty('messaging');
    expect(file.messaging).toEqual({});
  });

  test('a word outside the three is refused', () => {
    const result = validateTeamFile(team('messaging:\n  store: sometimes\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.message)).toContain('messaging.store must be one of: first, parallel, none');
  });

  test('an unknown key beside the word is refused', () => {
    const result = validateTeamFile(team('messaging:\n  retries: 3\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.message)).toContain('unknown field "retries" in messaging');
  });

  test('a seat word outside the three is refused too', () => {
    const result = validateTeamFile(team('', '    messaging:\n      store: later\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.message)).toContain('seat "helper": messaging.store must be one of: first, parallel, none');
  });
});

describe('messaging.store resolution', () => {
  test('first when nothing declares it', () => {
    const resolved = resolveWordSetting(MESSAGING_STORE, wordDeclarationsOf<MessagingStore>({}));
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([]);
    expect(messagingStore({})).toBe('first');
  });

  test('the entity and the project may loosen toward parallel and none', () => {
    expect(messagingStore({ entity: 'parallel' })).toBe('parallel');
    expect(messagingStore({ entity: 'none' })).toBe('none');
    expect(messagingStore({ project: 'none' })).toBe('none');
  });

  test('a team word that loosens is set aside: only entity and project are listed', () => {
    const resolved = resolveWordSetting(MESSAGING_STORE, wordDeclarationsOf<MessagingStore>({ team: 'parallel' }));
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([{ level: 'team', value: 'parallel' }]);
  });

  test('a seat word that loosens is set aside even under an entity that loosened', () => {
    // The entity's parallel is the value in force; the seat's none would keep less than that, and
    // the seat is not a listed level, so it is set aside.
    const resolved = resolveWordSetting(MESSAGING_STORE, wordDeclarationsOf<MessagingStore>({ entity: 'parallel', seat: 'none' }));
    expect(resolved.value).toBe('parallel');
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([{ level: 'seat', value: 'none' }]);
  });

  test("a seat word that would loosen a team's first is refused", () => {
    // The team closed the entity's none back to first — tightening, so any level may do it; the
    // seat's none would keep less than the team's word, and the seat is not a listed level.
    const resolved = resolveWordSetting(MESSAGING_STORE, wordDeclarationsOf<MessagingStore>({ entity: 'none', team: 'first', seat: 'none' }));
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBe('team');
    expect(resolved.refused).toEqual([{ level: 'seat', value: 'none' }]);
  });

  test('tightening is the safe side: every level may close back toward first', () => {
    expect(messagingStore({ entity: 'none', team: 'parallel' })).toBe('parallel');
    expect(messagingStore({ entity: 'none', project: 'first' })).toBe('first');
    expect(messagingStore({ entity: 'none', seat: 'first' })).toBe('first');
  });

  test('a seat that tightens after a team word keeps the tighter value', () => {
    const resolved = resolveWordSetting(MESSAGING_STORE, wordDeclarationsOf<MessagingStore>({ entity: 'none', team: 'parallel', seat: 'first' }));
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBe('seat');
    expect(resolved.refused).toEqual([]);
  });

  test('a word equal to the value in force is no word at all', () => {
    const resolved = resolveWordSetting(MESSAGING_STORE, wordDeclarationsOf<MessagingStore>({ entity: 'parallel', seat: 'parallel' }));
    expect(resolved.value).toBe('parallel');
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([]);
  });

  test('the chain decides, not the order the words are listed in', () => {
    const shuffled: WordDeclaration<MessagingStore>[] = [
      { level: 'seat', value: 'none' },
      { level: 'entity', value: 'parallel' },
    ];
    // The entity loosens to parallel; the seat's none would keep less than that, and the seat is
    // not a listed level, so it is set aside.
    const resolved = resolveWordSetting(MESSAGING_STORE, shuffled);
    expect(resolved.value).toBe('parallel');
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([{ level: 'seat', value: 'none' }]);
  });

  test('within one level the last word wins', () => {
    expect(resolveWordSetting(MESSAGING_STORE, [
      { level: 'entity', value: 'none' },
      { level: 'entity', value: 'parallel' },
    ]).value).toBe('parallel');
  });

  test('an expired word is unset; an expiry this build cannot read is refused', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    const expired: WordDeclaration<MessagingStore> = { level: 'entity', value: 'none', expiry: '2026-11-01T00:00:00Z' };
    const past = resolveWordSetting(MESSAGING_STORE, [expired], { now });
    expect(past.value).toBe('first');
    expect(past.source).toBeNull();
    expect(past.refused).toEqual([]);
    const unreadable: WordDeclaration<MessagingStore> = { level: 'entity', value: 'none', expiry: 'not-a-date' };
    const refused = resolveWordSetting(MESSAGING_STORE, [unreadable], { now });
    expect(refused.value).toBe('first');
    expect(refused.refused).toEqual([{ level: 'entity', value: 'none', expiry: 'not-a-date' }]);
  });

  test('a value the policy rejects is refused, not carried', () => {
    const resolved = resolveWordSetting(MESSAGING_STORE, [{ level: 'entity', value: 'sometimes' }]);
    expect(resolved.value).toBe('first');
    expect(resolved.refused).toEqual([{ level: 'entity', value: 'sometimes' }]);
  });

  test('the chain builders keep the levels that carry a word, in chain order', () => {
    expect(wordDeclarationsOf<MessagingStore>({ seat: 'none', entity: 'parallel', project: undefined })).toEqual([
      { level: 'entity', value: 'parallel' },
      { level: 'seat', value: 'none' },
    ]);
    expect(MESSAGING_STORES).toEqual(['first', 'parallel', 'none']);
    expect(MESSAGING_STORE.name).toBe('messaging.store');
    expect(isMessagingStore('none')).toBe(true);
    expect(isMessagingStore('later')).toBe(false);
  });
});

describe('the signed policy behind the words', () => {
  test('messaging.store is an enforced policy at every level, defaulting to first', () => {
    expect(ENFORCED_POLICY_NAMES).toContain('messaging.store');
    const spec = POLICY_CATALOGUE['messaging.store'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team', 'seat']);
    expect(spec.looseningLevels).toEqual(['entity', 'project']);
    expect(spec.defaultValue).toBe('first');
    expect(spec.gateLifting).toBe(false);
    expect(spec.parseValue('none')).toBe('none');
    expect(spec.parseValue('sometimes')).toBeNull();
  });

  test('the spellings the command accepts all name the one policy', () => {
    expect(normalizePolicyName('messaging.store')).toBe('messaging.store');
    expect(normalizePolicyName('messaging_store')).toBe('messaging.store');
    expect(normalizePolicyName('messaging-store')).toBe('messaging.store');
  });

  test('durability is what isWithin ranks: a word is within a lower one when it keeps at least as much', () => {
    const isWithin = POLICY_CATALOGUE['messaging.store'].isWithin;
    expect(isWithin('first', 'none')).toBe(true);
    expect(isWithin('first', 'parallel')).toBe(true);
    expect(isWithin('parallel', 'none')).toBe(true);
    expect(isWithin('none', 'parallel')).toBe(false);
    expect(isWithin('none', 'first')).toBe(false);
  });
});
