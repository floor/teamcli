import { independentHomeSuite } from './corrupt-registry-home-fixture.ts';
await independentHomeSuite(import.meta.path, async () => {
  process.env.TEAM_CONFIG_SOURCE = 'registry';
  const { afterAll, afterEach, expect } = await import('bun:test');
  const original = process.kill;
  const signals: unknown[][] = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === process.pid && signal === 0) return true;
    signals.push([pid, signal]);
    throw new Error('no real process signal belongs in this suite');
  }) as typeof process.kill;
  afterEach(() => expect(signals).toEqual([]));
  afterAll(() => { process.kill = original; });
  await import('./corrupt-registry-independent-cases.ts');
});
