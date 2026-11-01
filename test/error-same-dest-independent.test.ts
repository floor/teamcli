import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureRoot = fileURLToPath(new URL('../../error-same-dest-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const roots: string[] = [];
afterAll(() => { if (roots.length > 0) spawnSync('trash', roots, { timeout: 20_000 }); }, 30_000);
for (const [scenario, accepted] of [
  ['honest', true], ['guarded', true], ['redirected-refusal', true], ['normal', true],
  ['forged-same-over-done', false], ['forged-other-over-done', false], ['without-error', false],
  ['wrong-from', false], ['wrong-to', false], ['foreign-occurrence', false], ['bad-request', false], ['error-exit-effect', false],
] as [string, boolean][]) {
  test(`${scenario} agrees across append, fold and replay`, () => {
    const root = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    const worker = fileURLToPath(new URL('./adapters/error-same-dest-independent-worker.ts', import.meta.url));
    const child = spawnSync(process.execPath, [worker, home, scenario], { cwd: root, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.home).toBe(home);
    expect(result.appended, JSON.stringify(result.failure)).toBe(accepted);
    expect(result.reopened.ok).toBe(true);
    expect(result.replay.ok).toBe(true);
    if (accepted) {
      expect(result.fault).toBe(null);
      expect(result.folded.ok).toBe(true);
      expect(result.previewReplay.ok).toBe(true);
      expect(result.records).toBe(2);
      expect(result.reopened.live.state).toBe('halted');
      expect(result.reopened.live.revision).toBe(1);
      expect(result.reopened.live.activation).toBe(2);
      if (scenario !== 'normal') expect(result.decision.error?.rule).toBe('entry-effect-refused');
      if (scenario === 'guarded') expect(result.decision.guard).toBeUndefined();
    } else {
      expect(result.failure?.code).toBe('workflow.store.record-invalid');
      expect(result.unchanged).toBe(true);
      expect(result.records).toBe(1);
      expect(result.reopened.live.state).toBe('active');
      expect(result.previewReplay.ok).toBe(false);
    }
  });
}
