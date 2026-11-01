// The HOME-sensitive modules are loaded only in a fresh process with an owned HOME.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const forbidden = 'SYNTHETIC_WEBHOOK_HEADER_BODY_PRIVATE_VALUE';
const flag = 'TEAM_WEBHOOK_HEADER_BODY_INDEPENDENT_CHILD';
if (process.env[flag] === import.meta.path) {
  test('the child uses its explicit synthetic HOME from process startup', () => {
    expect(realpathSync(homedir())).toBe(realpathSync(process.env.HOME!));
    expect(process.env.HOME).toBe(process.env.TEAM_WEBHOOK_HEADER_BODY_INDEPENDENT_HOME);
  });
  await import('./adapters/webhook-header-body-independent-fixture.ts');
} else {
  test('independent webhook header and body contract in an isolated child', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'whbi-')));
    const home = join(base, 'h'); mkdirSync(home, { mode: 0o700 });
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, HOME: home, [flag]: import.meta.path, TEAM_WEBHOOK_HEADER_BODY_INDEPENDENT_HOME: home },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const output = stdout + stderr;
      const secretAbsent = !output.includes(forbidden);
      expect(secretAbsent).toBe(true);
      if (secretAbsent) { process.stdout.write(stdout); process.stderr.write(stderr); }
      expect(code).toBe(0);
    } finally { execFileSync('trash', [base]); }
  }, 30_000);
}
