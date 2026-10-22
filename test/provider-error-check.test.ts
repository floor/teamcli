// The provider-error check, called on its own. The screen union does not carry the kinds yet, so
// the seat's screen is built as the reading the classifier will return and passed through.
import { describe, expect, test } from 'bun:test';
import type { TeamFile } from '../src/file/types.ts';
import type { CheckContext, Report, SeatObservation } from '../src/watch/check.ts';
import { providerError } from '../src/watch/checks/provider-error.ts';
import type { Reset, Screen } from '../src/watch/screen.ts';

function seat(name: string, screen: { kind: string; reset?: Reset | null }, running = true, working = false, account?: string): SeatObservation {
  return {
    name,
    running,
    working,
    screen: screen as Screen,
    account,
  } as SeatObservation;
}

function harness(): { ctx: CheckContext; finish: () => void } {
  const active = new Set<string>();
  let current = new Set<string>();
  const ctx: CheckContext = {
    now: 0,
    watch: {} as TeamFile['watch'],
    budgets: {} as TeamFile['budgets'],
    once(key: string, text: string, to: Report['to'] = 'operator'): Report | null {
      current.add(key);
      return active.has(key) ? null : { key, text, to };
    },
    keep(key: string): void {
      if (active.has(key)) current.add(key);
    },
    memory<T>(_kind: string, start: () => T): T {
      return start();
    },
  };
  return {
    ctx,
    finish() {
      active.clear();
      for (const key of current) active.add(key);
      current = new Set();
    },
  };
}

const texts = (reports: Report[]) => reports.map((report) => `${report.to}: ${report.text}`);

describe('provider-error check', () => {
  test('a connection-lost seat is told once, to the operator and the owner, and again after it leaves', () => {
    const { ctx, finish } = harness();
    const lost = seat('claude-a', { kind: 'provider error' });
    const first = providerError.run(lost, ctx);
    expect(texts(first)).toEqual([
      'operator: claude-a shows a provider error: connection lost, and no capture names a retry',
      'owner: claude-a shows a provider error: connection lost, and no capture names a retry',
    ]);
    finish();
    expect(providerError.run(lost, ctx)).toEqual([]);
    finish();
    expect(providerError.run(seat('claude-a', { kind: 'idle' }), ctx)).toEqual([]);
    finish();
    expect(texts(providerError.run(lost, ctx))).toEqual(texts(first));
  });

  test('a rate limit carries the reset time the screen gives, and says so when it gives none', () => {
    const { ctx, finish } = harness();
    const limited = seat('claude-b', { kind: 'rate limit', reset: { kind: 'at', value: '11:00' } });
    expect(texts(providerError.run(limited, ctx))).toEqual([
      'operator: claude-b is out of quota: usage limit, resets at 11:00',
      'owner: claude-b is out of quota: usage limit, resets at 11:00',
    ]);
    finish();
    const quiet = harness();
    expect(texts(providerError.run(seat('claude-b', { kind: 'rate limit', reset: null }), quiet.ctx))).toEqual([
      'operator: claude-b is out of quota: usage limit, and the screen names no reset time',
      'owner: claude-b is out of quota: usage limit, and the screen names no reset time',
    ]);
  });

  test('a rate limit names the pool the seat spends, and leaves it out when the seat names none', () => {
    const { ctx } = harness();
    const limited = seat('claude-b', { kind: 'rate limit', reset: { kind: 'at', value: '11:00' } }, true, false, 'claude-glm');
    expect(texts(providerError.run(limited, ctx))).toEqual([
      'operator: claude-b is out of quota on claude-glm: usage limit, resets at 11:00',
      'owner: claude-b is out of quota on claude-glm: usage limit, resets at 11:00',
    ]);
    const bare = harness();
    expect(texts(providerError.run(seat('claude-b', { kind: 'rate limit', reset: null }, true, false, ''), bare.ctx))).toEqual([
      'operator: claude-b is out of quota: usage limit, and the screen names no reset time',
      'owner: claude-b is out of quota: usage limit, and the screen names no reset time',
    ]);
  });

  test('a seat working on a provider-error screen is not reported, and is reported when it stops', () => {
    const { ctx, finish } = harness();
    const screen = { kind: 'provider error' };
    const told = [
      'operator: claude-a shows a provider error: connection lost, and no capture names a retry',
      'owner: claude-a shows a provider error: connection lost, and no capture names a retry',
    ];
    expect(providerError.run(seat('claude-a', screen, true, true), ctx)).toEqual([]);
    finish();
    expect(texts(providerError.run(seat('claude-a', screen), ctx))).toEqual(told);
    finish();
    expect(providerError.run(seat('claude-a', screen, true, true), ctx)).toEqual([]);
    finish();
    expect(texts(providerError.run(seat('claude-a', screen), ctx))).toEqual(told);
  });

  test('the two states carry different report keys, so the bus maps by key and never by the prose', () => {
    const limited = harness();
    expect(
      providerError.run(seat('claude-b', { kind: 'rate limit', reset: { kind: 'at', value: '11:00' } }), limited.ctx).map((report) => report.key),
    ).toEqual(['rate-limit:claude-b', 'rate-limit:claude-b:owner']);
    const lost = harness();
    expect(
      providerError.run(seat('claude-b', { kind: 'provider error' }), lost.ctx).map((report) => report.key),
    ).toEqual(['provider-error:claude-b', 'provider-error:claude-b:owner']);
  });

  test('a seat that is not running, and any other screen, is not this state', () => {
    const { ctx } = harness();
    expect(providerError.run(seat('claude-a', { kind: 'provider error' }, false), ctx)).toEqual([]);
    expect(providerError.run(seat('claude-a', { kind: 'question' }), ctx)).toEqual([]);
    expect(providerError.run(seat('claude-a', { kind: 'idle' }), ctx)).toEqual([]);
  });
});
