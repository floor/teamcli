import { describe, expect, test } from 'bun:test';
import {
  DELIVERY_ORDER,
  SEATS_CROSS_TEAMS,
  SETTING_LEVELS,
  declarationsOf,
  orderDeclarationsOf,
  type DeliveryLeg,
} from '../src/settings/inherit.ts';
import { deliveryOrder, resolveOrderSetting, resolveSetting, seatsCrossTeams } from '../src/settings/resolve.ts';

describe('seats_cross_teams', () => {
  test('off when nothing declares it', () => {
    const resolved = resolveSetting(SEATS_CROSS_TEAMS, declarationsOf({}));
    expect(resolved.value).toBe(false);
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([]);
    expect(seatsCrossTeams({})).toBe(false);
  });

  test('the project may open it', () => {
    expect(seatsCrossTeams({ project: true })).toBe(true);
  });

  test('the entity may not: only the project may open it', () => {
    const resolved = resolveSetting(SEATS_CROSS_TEAMS, declarationsOf({ entity: true }));
    expect(resolved.value).toBe(false);
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([{ level: 'entity', value: true }]);
  });

  test('a team closes what the project opened', () => {
    const resolved = resolveSetting(SEATS_CROSS_TEAMS, declarationsOf({ project: true, team: false }));
    expect(resolved.value).toBe(false);
    expect(resolved.source).toBe('team');
    expect(resolved.refused).toEqual([]);
  });

  test('a seat closes it for itself', () => {
    expect(seatsCrossTeams({ project: true, seat: false })).toBe(false);
  });

  test('a seat may not reopen what the project left closed', () => {
    const resolved = resolveSetting(SEATS_CROSS_TEAMS, declarationsOf({ seat: true }));
    expect(resolved.value).toBe(false);
    expect(resolved.refused).toEqual([{ level: 'seat', value: true }]);
  });

  test('a word equal to the value in force passes at every level', () => {
    const resolved = resolveSetting(SEATS_CROSS_TEAMS, declarationsOf({ entity: false, project: true, team: true }));
    expect(resolved.value).toBe(true);
    expect(resolved.refused).toEqual([]);
  });

  test('the chain decides, not the order the words are listed in', () => {
    const shuffled = [
      { level: 'seat' as const, value: false },
      { level: 'project' as const, value: true },
      { level: 'entity' as const, value: true },
    ];
    // The entity's word is refused, the project opens, the seat closes: false.
    const resolved = resolveSetting(SEATS_CROSS_TEAMS, shuffled);
    expect(resolved.value).toBe(false);
    expect(resolved.source).toBe('seat');
    expect(resolved.refused).toEqual([{ level: 'entity', value: true }]);
  });

  test('within one level the last word wins', () => {
    expect(resolveSetting(SEATS_CROSS_TEAMS, [
      { level: 'project', value: true },
      { level: 'project', value: false },
    ]).value).toBe(false);
    expect(resolveSetting(SEATS_CROSS_TEAMS, [
      { level: 'project', value: false },
      { level: 'project', value: true },
    ]).value).toBe(true);
  });

  test('the names and the order are the ones the chain is read in', () => {
    expect(SEATS_CROSS_TEAMS.name).toBe('seats_cross_teams');
    expect(SETTING_LEVELS).toEqual(['machine', 'entity', 'project', 'team', 'seat']);
  });
});

describe('the chain builders', () => {
  test('declarationsOf drops the levels the chain does not name', () => {
    expect(declarationsOf({ seat: false, entity: true, project: undefined })).toEqual([
      { level: 'entity', value: true },
      { level: 'seat', value: false },
    ]);
  });
});

describe('delivery_order', () => {
  test('mcp-inbox, drop, typed when nothing declares one', () => {
    expect(DELIVERY_ORDER.name).toBe('delivery_order');
    expect(deliveryOrder({})).toEqual(['mcp-inbox', 'drop', 'typed']);
    const resolved = resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf<DeliveryLeg>({}));
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([]);
  });

  test('drop is in the default order, so a level may name it first', () => {
    expect(DELIVERY_ORDER.fallback).toContain('drop');
    expect(deliveryOrder({ seat: ['drop'] })).toEqual(['drop']);
    const resolved = resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf<DeliveryLeg>({ seat: ['drop', 'typed'] }));
    expect(resolved.value).toEqual(['drop', 'typed']);
    expect(resolved.source).toBe('seat');
    expect(resolved.refused).toEqual([]);
    // The default word itself is no word at all, in any level's voice.
    expect(deliveryOrder({ team: ['mcp-inbox', 'drop', 'typed'] })).toEqual(['mcp-inbox', 'drop', 'typed']);
  });

  test('a level may drop a leg, and the levels below work on what is left', () => {
    expect(deliveryOrder({ team: ['mcp-inbox', 'typed'] })).toEqual(['mcp-inbox', 'typed']);
    expect(deliveryOrder({ team: ['mcp-inbox', 'typed'], seat: ['typed'] })).toEqual(['typed']);
  });

  test('a level may reorder the legs it keeps', () => {
    expect(deliveryOrder({ seat: ['typed', 'mcp-inbox', 'drop'] })).toEqual(['typed', 'mcp-inbox', 'drop']);
    const resolved = resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf<DeliveryLeg>({ seat: ['typed', 'mcp-inbox', 'drop'] }));
    expect(resolved.source).toBe('seat');
  });

  test('a word with no leg is set aside: an order of no legs takes no send', () => {
    // The YAML reader refuses a written key with no items, and the registry refuses an empty
    // `delivery_order` at load. A chain built in code gets the same answer: taken as a drop of
    // every leg, the word would resolve the order to `[]` and every send would then fail.
    const resolved = resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf<DeliveryLeg>({ entity: ['typed'], seat: [] }));
    expect(resolved.value).toEqual(['typed']);
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([{ level: 'seat', value: [] }]);
    expect(deliveryOrder({ entity: ['typed'], seat: [] })).toEqual(['typed']);
    // Against the default order, an empty word at any level leaves the default standing.
    expect(deliveryOrder({ team: [] })).toEqual(['mcp-inbox', 'drop', 'typed']);
    expect(deliveryOrder({ entity: [], project: [], team: [], seat: [] })).toEqual(['mcp-inbox', 'drop', 'typed']);
  });

  test('a level may not add a leg: the word is set aside and the order in force stands', () => {
    // `native` is the sender's own leg, chosen and recorded at the send: no order in force
    // carries it, so a level that names it adds a leg and its word is set aside.
    const resolved = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf<DeliveryLeg>({ entity: ['typed'], team: ['native', 'typed'] }),
    );
    expect(resolved.value).toEqual(['typed']);
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([{ level: 'team', value: ['native', 'typed'] as DeliveryLeg[] }]);
    const unknown = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf<DeliveryLeg>({ entity: ['typed'], team: ['telepathy' as DeliveryLeg, 'typed'] }),
    );
    expect(unknown.refused).toEqual([{ level: 'team', value: ['telepathy', 'typed'] as DeliveryLeg[] }]);
  });

  test('a level may not name a leg twice', () => {
    const resolved = resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf<DeliveryLeg>({ project: ['mcp-inbox', 'mcp-inbox', 'typed'] }));
    expect(resolved.value).toEqual(['mcp-inbox', 'drop', 'typed']);
    expect(resolved.refused).toEqual([{ level: 'project', value: ['mcp-inbox', 'mcp-inbox', 'typed'] }]);
  });

  test('a word equal to the order in force is no word at all', () => {
    const resolved = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf<DeliveryLeg>({
        entity: ['mcp-inbox', 'drop', 'typed'],
        seat: ['mcp-inbox', 'drop', 'typed'],
      }),
    );
    expect(resolved.value).toEqual(['mcp-inbox', 'drop', 'typed']);
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([]);
    // The older three-leg word names `native`, which the order in force does not carry: the
    // word adds a leg and is set aside, so the default order stands.
    expect(deliveryOrder({ team: ['native', 'mcp-inbox', 'typed'] })).toEqual(['mcp-inbox', 'drop', 'typed']);
  });

  test('within a level the last word wins, judged against what the one before it left', () => {
    const resolved = resolveOrderSetting(DELIVERY_ORDER, [
      { level: 'team', value: ['mcp-inbox', 'typed'] },
      // Valid against the team's own word above: it drops mcp-inbox from it.
      { level: 'team', value: ['typed'] },
    ]);
    expect(resolved.value).toEqual(['typed']);
    expect(resolved.source).toBe('team');
    expect(resolved.refused).toEqual([]);
  });
});
