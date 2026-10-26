// The owner-seat helper is prepared on first use, at user level, with no prompt; a temp HOME only.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledHelperSource, ensureOwnerSeatHelper, STAMP_NAME, type ProvisionRunner } from '../src/client/owner-seat-provision.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) spawnSync('/usr/bin/trash', [d]); });
const home = () => { const d = mkdtempSync(join(tmpdir(), 'owner-seat-provision-')); dirs.push(d); return d; };

function fakeRun(calls: string[][]): ProvisionRunner {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'swiftc') writeFileSync(args[args.indexOf('-o') + 1]!, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    return { status: 0, stderr: '' };
  };
}

describe('owner-seat helper provisioning', () => {
  test('the package ships the helper source', () => {
    expect(bundledHelperSource()).not.toBeNull();
    expect(JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).files).toContain('helpers');
  });

  test('a missing helper is built, ad-hoc signed (never an identity), self-tested and stamped, under HOME', () => {
    const h = home(); const helper = join(h, '.config', 'team-owner-seat', 'owner-seat-keystore'); const calls: string[][] = [];
    const r = ensureOwnerSeatHelper(helper, { platform: 'darwin', run: fakeRun(calls) });
    expect(r).toEqual({ ok: true, action: 'built' });
    expect(calls.map((c) => c[0])).toEqual(['swiftc', 'codesign', expect.stringContaining('owner-seat-keystore')]);
    expect(calls[1]).toEqual(['codesign', '--force', '--sign', '-', expect.any(String)]);
    expect(calls.flat().some((a) => a.includes('sudo') || a.startsWith('/usr/local'))).toBe(false);
    expect(existsSync(helper)).toBe(true);
    expect(statSync(join(h, '.config', 'team-owner-seat')).mode & 0o777).toBe(0o700);
    expect(existsSync(join(h, '.config', 'team-owner-seat', STAMP_NAME))).toBe(true);
  });

  test('a second call does nothing; a changed source rebuilds silently', () => {
    const h = home(); const helper = join(h, 'seat', 'owner-seat-keystore'); const calls: string[][] = [];
    ensureOwnerSeatHelper(helper, { platform: 'darwin', run: fakeRun(calls) });
    expect(ensureOwnerSeatHelper(helper, { platform: 'darwin', run: fakeRun(calls) })).toEqual({ ok: true, action: 'present' });
    expect(calls.length).toBe(3);
    const src = join(h, 'changed.swift'); writeFileSync(src, '// v2\n');
    expect(ensureOwnerSeatHelper(helper, { platform: 'darwin', source: src, run: fakeRun(calls) })).toEqual({ ok: true, action: 'built' });
  });

  test('an owner-installed (unstamped, e.g. codesigned) helper is never replaced', () => {
    const h = home(); const helper = join(h, 'owner-seat-keystore'); writeFileSync(helper, 'mine', { mode: 0o755 }); const calls: string[][] = [];
    expect(ensureOwnerSeatHelper(helper, { platform: 'darwin', run: fakeRun(calls) })).toEqual({ ok: true, action: 'foreign' });
    expect(calls.length).toBe(0);
    expect(readFileSync(helper, 'utf8')).toBe('mine');
  });

  test('a failed build leaves no helper and says what to install', () => {
    const h = home(); const helper = join(h, 'owner-seat-keystore');
    const r = ensureOwnerSeatHelper(helper, { platform: 'darwin', run: () => ({ status: 1, stderr: 'no swiftc' }) });
    expect(r.ok).toBe(false);
    expect(existsSync(helper)).toBe(false);
    if (!r.ok) expect(r.why).toContain('xcode-select --install');
  });

  test('not macOS: nothing is built', () => {
    const calls: string[][] = [];
    expect(ensureOwnerSeatHelper(join(home(), 'x'), { platform: 'linux', run: fakeRun(calls) }).ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
