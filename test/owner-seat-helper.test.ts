// The real Secure Enclave helper, on a Mac with swiftc only: built by the build script into a
// throwaway folder, self-tested, and its signature format checked against TeamCLI's verifier. A
// stored key is created through the enclave-blob backend (no prompt at creation) and read back;
// signing a stored key needs Touch ID and is left to the owner.

import { afterAll, describe, expect, test } from 'bun:test';
import { verify as cryptoVerify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { ownerSeatPublicKey } from '../src/client/owner-seat.ts';

const swift = platform() === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) spawnSync('/usr/bin/trash', [d]); });

describe.skipIf(!swift)('owner-seat helper (macOS)', () => {
  const dest = mkdtempSync('/private/tmp/owner-seat-helper-test-');
  dirs.push(dest);
  let helper = '';

  test('the build script builds, ad-hoc signs, installs and self-tests', () => {
    const out = execFileSync(join(import.meta.dir, '..', 'scripts', 'build-owner-seat-helper.sh'), ['--dest', dest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toContain('ok secure-enclave');
    helper = join(dest, 'owner-seat-keystore');
    expect(existsSync(helper)).toBe(true);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    expect(spawnSync('codesign', ['-dv', helper], { encoding: 'utf8' }).stderr).toContain('Signature=adhoc');
  }, 120_000);

  test("the helper's public key and DER signature verify under TeamCLI's verifier", () => {
    const [pub, sig] = execFileSync(helper, ['selftest', '--emit'], { encoding: 'utf8' }).trim().split('\n');
    const key = ownerSeatPublicKey(pub!);
    expect(key).not.toBeNull();
    expect(cryptoVerify('sha256', Buffer.from('teamcli owner-seat selftest'), { key: key!, dsaEncoding: 'der' }, Buffer.from(sig!, 'hex'))).toBe(true);
    expect(cryptoVerify('sha256', Buffer.from('another message'), { key: key!, dsaEncoding: 'der' }, Buffer.from(sig!, 'hex'))).toBe(false);
  });

  test('create keeps an enclave handle (0600), public reads the same key back, a second create is refused', () => {
    const env = { ...process.env, OWNER_SEAT_BACKEND: 'enclave-blob' };
    const created = execFileSync(helper, ['create', 'helper-test'], { encoding: 'utf8', env }).trim();
    expect(created).toMatch(/^04[0-9a-f]{128}$/);
    expect(execFileSync(helper, ['public', 'helper-test'], { encoding: 'utf8' }).trim()).toBe(created);
    expect(statSync(join(dest, 'keys', 'helper-test.se')).mode & 0o777).toBe(0o600);
    expect(spawnSync(helper, ['create', 'helper-test'], { env }).status).toBe(1);
    expect(spawnSync(helper, ['public', 'no-such-key']).status).toBe(1);
    expect(spawnSync(helper, ['public', '../escape']).status).toBe(1);
  });

  test('an ad-hoc build that tries the keychain first falls back to the enclave handle (-34018)', () => {
    const created = execFileSync(helper, ['create', 'helper-fallback'], { encoding: 'utf8', env: { ...process.env, OWNER_SEAT_BACKEND: '' } }).trim();
    expect(created).toMatch(/^04[0-9a-f]{128}$/);
    expect(existsSync(join(dest, 'keys', 'helper-fallback.se'))).toBe(true);
  });
});
