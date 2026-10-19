import { describe, expect, test } from 'bun:test';
import { composeSeatConfig } from '../src/config/compose.ts';
import type { ConfigSeatInput } from '../src/config/compose.ts';
import type { DeliveryLeg } from '../src/settings/inherit.ts';
import { DELIVERY_ORDER } from '../src/settings/inherit.ts';

const BARE: ConfigSeatInput = { model: 'claude-opus-5-5' };

function row(seat: ConfigSeatInput, teamOrder: readonly DeliveryLeg[] | null, key: string) {
  const found = composeSeatConfig(seat, teamOrder).find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no row for ${key}`);
  return found;
}

describe('a seat that writes every setting', () => {
  const seat: ConfigSeatInput = {
    model: 'claude-opus-5-5',
    effort: 'high',
    nickname: 'Atlas',
    human: true,
    deliveryOrder: ['mcp-inbox', 'typed'],
  };

  test('every row reads the team file', () => {
    for (const entry of composeSeatConfig(seat, ['drop'])) expect(entry.origin).toBe('team file');
  });

  test('the values are the seat entry\'s own', () => {
    expect(row(seat, ['drop'], 'model').value).toBe('claude-opus-5-5');
    expect(row(seat, ['drop'], 'effort').value).toBe('high');
    expect(row(seat, ['drop'], 'nickname').value).toBe('Atlas');
    expect(row(seat, ['drop'], 'delivery_order').value).toEqual(['mcp-inbox', 'typed']);
    expect(row(seat, ['drop'], 'human').value).toBe(true);
  });

  test('the seat\'s own order wins over the file\'s team order', () => {
    expect(row(seat, ['drop'], 'delivery_order').value).toEqual(['mcp-inbox', 'typed']);
    expect(row(seat, null, 'delivery_order').value).toEqual(['mcp-inbox', 'typed']);
  });
});

describe('a seat that writes none of them', () => {
  test('an unset effort or nickname is unset, not guessed', () => {
    const effort = row(BARE, null, 'effort');
    expect(effort.value).toBeNull();
    expect(effort.origin).toBe('none');
    const nickname = row(BARE, null, 'nickname');
    expect(nickname.value).toBeNull();
    expect(nickname.origin).toBe('none');
  });

  test('the required model still comes from the file', () => {
    expect(row(BARE, null, 'model')).toEqual({
      key: 'model',
      value: 'claude-opus-5-5',
      origin: 'team file',
      applies: 'restart-resume',
    });
  });

  test('human is off by default', () => {
    expect(row(BARE, null, 'human')).toEqual({
      key: 'human',
      value: false,
      origin: 'default',
      applies: 'at-once',
    });
  });

  test('the order is the file\'s team order when the file writes one', () => {
    expect(row(BARE, ['mcp-inbox', 'typed'], 'delivery_order')).toEqual({
      key: 'delivery_order',
      value: ['mcp-inbox', 'typed'],
      origin: 'team default',
      applies: 'at-once',
    });
  });

  test('the order falls back to the release order when the file writes none', () => {
    expect(row(BARE, null, 'delivery_order')).toEqual({
      key: 'delivery_order',
      value: ['mcp-inbox', 'drop', 'typed'],
      origin: 'default',
      applies: 'at-once',
    });
  });
});

describe('the model the file decides', () => {
  test('an empty model is unset, not an empty team-file value', () => {
    expect(row({ model: '' }, null, 'model')).toEqual({
      key: 'model',
      value: null,
      origin: 'none',
      applies: 'restart-resume',
    });
  });

  test('a model the launcher chooses is unset: the file does not decide it', () => {
    expect(row({ model: 'Claude Opus', modelFrom: 'launcher' }, null, 'model')).toEqual({
      key: 'model',
      value: null,
      origin: 'none',
      applies: 'restart-resume',
    });
  });
});

describe('the order arrays', () => {
  test('are copies, never the source arrays by reference', () => {
    const seatOrder: DeliveryLeg[] = ['typed'];
    const teamOrder: DeliveryLeg[] = ['mcp-inbox', 'typed'];
    const own = composeSeatConfig({ model: 'claude-opus-5-5', deliveryOrder: seatOrder }, teamOrder);
    const inherited = composeSeatConfig({ model: 'claude-opus-5-5' }, teamOrder);
    const fallback = composeSeatConfig({ model: 'claude-opus-5-5' }, null);
    expect(own.find((entry) => entry.key === 'delivery_order')!.value).not.toBe(seatOrder);
    expect(inherited.find((entry) => entry.key === 'delivery_order')!.value).not.toBe(teamOrder);
    // The release default is the registry's own array: a caller's edit must not reach it.
    expect(fallback.find((entry) => entry.key === 'delivery_order')!.value).not.toBe(DELIVERY_ORDER.fallback);
    expect(fallback.find((entry) => entry.key === 'delivery_order')!.value).toEqual(DELIVERY_ORDER.fallback);
  });
});

describe('the row order', () => {
  test('is the registry order, whatever the seat writes', () => {
    expect(composeSeatConfig(BARE, null).map((entry) => entry.key)).toEqual([
      'model',
      'effort',
      'nickname',
      'delivery_order',
      'human',
    ]);
  });

  test('every row carries its application kind', () => {
    expect(composeSeatConfig(BARE, null).map((entry) => entry.applies)).toEqual([
      'restart-resume',
      'restart-resume',
      'at-once',
      'at-once',
      'at-once',
    ]);
  });
});

describe('signed records', () => {
  const seat: ConfigSeatInput = {
    model: 'Claude Opus',
    effort: 'high',
    nickname: 'Atlas',
    human: true,
    deliveryOrder: ['typed'],
  };

  test('a seat record beats the seat\'s own file entry and names its file', () => {
    const rows = composeSeatConfig(seat, ['drop'], {
      model: { level: 'seat', value: 'claude-opus-5-5', sourceFile: '/home/.config/team/agents/agt_1.yaml' },
    });
    const model = rows.find((entry) => entry.key === 'model')!;
    expect(model.value).toBe('claude-opus-5-5');
    expect(model.origin).toBe('seat record');
    expect(model.sourceFile).toBe('/home/.config/team/agents/agt_1.yaml');
    expect(rows.find((entry) => entry.key === 'effort')!.origin).toBe('team file');
  });

  test('the seat file entry beats a team record; the team record beats the team order', () => {
    const fileWins = composeSeatConfig(seat, ['drop'], {
      nickname: { level: 'team', value: 'team-name' },
    }).find((entry) => entry.key === 'nickname')!;
    expect(fileWins.value).toBe('Atlas');
    expect(fileWins.origin).toBe('team file');

    const recordWins = composeSeatConfig(BARE, ['drop'], {
      delivery_order: { level: 'team', value: ['mcp-inbox'] },
    }).find((entry) => entry.key === 'delivery_order')!;
    expect(recordWins.value).toEqual(['mcp-inbox']);
    expect(recordWins.origin).toBe('team record');
  });

  test('a project or entity record reads as its own level, and an absent one leaves the fallback', () => {
    const rows = composeSeatConfig(BARE, null, { effort: { level: 'project', value: 'max' } });
    expect(rows.find((entry) => entry.key === 'effort')).toEqual({
      key: 'effort',
      value: 'max',
      origin: 'project record',
      applies: 'restart-resume',
    });
    expect(rows.find((entry) => entry.key === 'delivery_order')!.origin).toBe('default');
    expect(rows.find((entry) => entry.key === 'human')).toEqual({
      key: 'human',
      value: false,
      origin: 'default',
      applies: 'at-once',
    });
  });

  test('a record value is copied, never the caller\'s array by reference', () => {
    const order = ['mcp-inbox'] as const;
    const rows = composeSeatConfig(BARE, null, { delivery_order: { level: 'seat', value: [...order] } });
    expect(rows.find((entry) => entry.key === 'delivery_order')!.value).not.toBe(order);
  });
});
