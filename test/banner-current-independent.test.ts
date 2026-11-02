import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const roots: string[] = [];
const fixtureRoot = fileURLToPath(new URL('../../banner-current-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
afterAll(() => { if (roots.length > 0) discardFixtures(roots, { quiet: true, roots: [fixtureRoot] }); }, 30_000);
const header = ' ▐▛███▛█   Claude Code v2.1.291';
const line = (id: string) => `▝▜██████▀  ${id} · API Usage Billing`;
const current = `${header}\n${line('glm-5.3')}`;
const older = `${header.replace('291', '289')}\n${line('glm-5.2')}`;
const cases: [string, string | null, string | null, boolean][] = [
  ['current welcome', current, 'glm-5.3', false],
  ['current mismatch', `${header}\n${line('glm-5.2')}`, 'glm-5.2', true],
  ['quoted old id before welcome', `Example: glm-5.2 · API Usage Billing\n${current}`, 'glm-5.3', false],
  ['quoted old id after welcome', `${current}\nExample: glm-5.2 · API Usage Billing`, 'glm-5.3', false],
  ['quoted full welcome before current', `> ${older.replaceAll('\n', '\n> ')}\n${current}`, 'glm-5.3', false],
  ['two different welcomes', `${older}\n${current}`, null, false],
  ['two identical welcomes', `${current}\n${current}`, null, false],
  ['two welcomes reversed', `${current}\n${older}`, null, false],
  ['id alone', line('glm-5.2'), null, false],
  ['quoted id alone', 'Example from a transcript: glm-5.2 · API Usage Billing', null, false],
  ['model two lines below header', `${header}\n\n${line('glm-5.2')}`, null, false],
  ['junk directly below header', `${header}\nordinary transcript\n${line('glm-5.2')}`, null, false],
  ['model above header', `${line('glm-5.2')}\n${header}`, null, false],
  ['no model below header', header, null, false],
  ['quoted welcome only', `> ${older.replaceAll('\n', '\n> ')}`, null, false],
  ['indented current welcome', current.split('\n').map((word) => `  ${word}  `).join('\n'), 'glm-5.3', false],
  ['terminal colors around current', `\u001b[32m${header}\u001b[0m\n\u001b[36m${line('glm-5.3')}\u001b[0m`, 'glm-5.3', false],
  ['line ending variants', current.replaceAll('\n', '\r\n'), 'glm-5.3', false],
  ['empty screen', '', null, false],
  ['missing screen', null, null, false],
];
for (const [name, screen, banner, drift] of cases) {
  test(`${name} reads only the current welcome model`, () => {
    const root = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    const worker = fileURLToPath(new URL('./adapters/banner-current-independent-worker.ts', import.meta.url));
    const child = spawnSync(process.execPath, [worker, home, JSON.stringify(screen)], { cwd: root, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.home).toBe(home);
    expect(result.banner).toBe(banner);
    expect(result.drift).toBe(drift);
  });
}
