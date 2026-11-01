// Independent loader and command scenes. The parent imports no owner-store or command modules.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) spawnSync('trash', bases, { timeout: 20_000 }); }, 30_000);
type Result = { home: string; accepted?: boolean; line?: number; message?: string; withoutRule?: boolean; loaded?: { name: string; profile: string; composer: boolean }[]; parsed?: { ok: boolean; errors?: { line: number; message: string }[] }; code?: number; out?: string; err?: string; overridePath?: string };
function scene(name: string, fields: string[] = []): Result {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'independent-profile-rule-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/profile-rule-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, name, home, JSON.stringify(fields)], { cwd: base, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 15_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
const narrowing = ['on_footer: false', 'live: false', 'at_composer: false', 'without_rule: false'];
for (let mask = 1; mask < 16; mask++) {
  const fields = narrowing.filter((_field, index) => (mask & (1 << index)) !== 0);
  for (const reason of [false, true]) {
    const rule = [...fields, ...(reason ? ['reason: needs a choice'] : [])];
    test(`narrowing-only subset ${mask}${reason ? ' with reason' : ''} refuses at line 6`, () => {
      const result = scene('load-rule', rule);
      expect(result.accepted).toBe(false);
      expect(result.line).toBe(6);
      expect(result.message).toContain('primitive');
    });
  }
}
for (const field of ['on_footer: true', 'live: true', 'at_composer: true', 'reason: needs a choice']) {
  test(`${field} alone refuses at line 6`, () => {
    const result = scene('load-rule', [field]);
    expect(result.accepted).toBe(false);
    expect(result.line).toBe(6);
    expect(result.message).toMatch(/primitive|needs one of them/);
  });
}
test('without_rule true remains a matching primitive', () => {
  const result = scene('load-rule', ['without_rule: true', 'reason: no divider']);
  expect(result.accepted).toBe(true);
  expect(result.withoutRule).toBe(true);
});
test('all eight shipped launch and screen profiles load', () => {
  const result = scene('shipped');
  expect(result.loaded?.map((profile) => profile.name).sort()).toEqual(['antigravity', 'claude-code', 'codex', 'cursor', 'gemini', 'grok', 'jules', 'muse']);
  for (const profile of result.loaded ?? []) {
    expect(profile.profile).toBe(profile.name);
    expect(profile.composer).toBe(true);
  }
});
test('the added-rule override parser refuses the same narrowing-only rule at its line', () => {
  const result = scene('override');
  expect(result.parsed?.ok).toBe(false);
  expect(result.parsed?.errors?.[0]?.line).toBe(6);
  expect(result.parsed?.errors?.[0]?.message).toContain('primitive');
});
for (const command of ['doctor', 'status']) {
  for (const json of [false, true]) {
    test(`${command} surfaces the bad override with its file and line (${json ? 'structured' : 'plain'})`, () => {
      const result = scene(`${command}-${json ? 'json' : 'plain'}`);
      expect(result.code, (result.out ?? '') + (result.err ?? '')).toBe(1);
      if (!json) {
        expect((result.out ?? '') + (result.err ?? '')).toContain('line 6');
        expect((result.out ?? '') + (result.err ?? '')).toContain('matching primitive');
      } else {
        const document = JSON.parse(result.out ?? '') as { findings?: { level: string; text: string; blocks_launch: boolean }[]; differences?: { what: string }[] };
        const messages = command === 'doctor' ? document.findings?.filter((finding) => finding.level === 'miss' && finding.blocks_launch).map((finding) => finding.text) : document.differences?.map((difference) => difference.what);
        expect(messages?.some((message) => message.includes(result.overridePath ?? '') && message.includes('line 6') && message.includes('matching primitive'))).toBe(true);
      }
    });
  }
}
