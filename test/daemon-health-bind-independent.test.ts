import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, async () => {
  // Install before importing any host module. Even liveness of another pid is forbidden.
  const { afterAll, afterEach, expect } = await import('bun:test');
  const original = process.kill;
  const forbidden: { pid: number; signal: unknown }[] = [];
  process.kill = ((pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (pid === process.pid && signal === 0) return true;
    forbidden.push({ pid, signal }); throw new Error('a real process signal is forbidden in this fixture');
  }) as typeof process.kill;
  afterEach(() => { expect(forbidden.splice(0)).toEqual([]); });
  afterAll(() => { process.kill = original; });
  await import('./daemon-health-bind-independent-cases.ts');
});
