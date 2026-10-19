import { describe, expect, test } from 'bun:test';
import { composeSeatConfig } from '../src/config/compose.ts';
import type { ConfigSeatInput } from '../src/config/compose.ts';
import type { DeliveryLeg } from '../src/settings/inherit.ts';

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
