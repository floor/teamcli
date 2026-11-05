import { independentHomeSuite } from './muse-exit-home-fixture.ts';
await independentHomeSuite(import.meta.path, async () => {
  process.env.TEAM_CONFIG_SOURCE='file';
  const { afterAll, afterEach, expect } = await import('bun:test');
  const original = process.kill, calls: unknown[][] = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === process.pid && signal === 0) return true;
    calls.push([pid, signal]); throw new Error('a real process signal is forbidden in this suite');
  }) as typeof process.kill;
  afterEach(() => expect(calls).toEqual([]));
  afterAll(() => { process.kill = original; });
  await import('./muse-exit-independent-cases.ts');
});
