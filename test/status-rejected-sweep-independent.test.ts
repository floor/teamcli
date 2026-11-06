// One sweep of a fake spool. No signal is installed and no live seat is touched.
import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sweepNonId } from '../src/daemon/presence/native-feed.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

test('a spool sweep removes non-id names, keeps a receipt and its temp name, and does not follow a symlink or a subfolder', () => {
  const root = fixtureBase('status-rejected-sweep-');
  try {
    const spool = join(root, 'status-spool');
    mkdirSync(spool, { mode: 0o700 });
    const id = '2026-11-06T19:00:00.000Z-a1b2c3d4';
    const receipt = `${id}.json`;
    // The writer's in-flight name (`<receipt>.new.<16 hex>`) is renamed onto the receipt. A sweep
    // that unlinks it loses the record before that rename, so this name is not a dropped non-id.
    const temp = `${receipt}.new.0123abcd0123abcd`;
    writeFileSync(join(spool, receipt), 'receipt-bytes\n', { mode: 0o600 });
    writeFileSync(join(spool, temp), 'temp-bytes\n', { mode: 0o600 });
    const flood = 41;
    for (let i = 0; i < flood - 1; i += 1) {
      writeFileSync(join(spool, `noise-${String(i).padStart(4, '0')}.txt`), 'noise\n', { mode: 0o600 });
    }
    writeFileSync(join(spool, 'plain.json'), '{}\n', { mode: 0o600 });
    const target = join(root, 'symlink-target');
    writeFileSync(target, 'symlink-target\n', { mode: 0o600 });
    symlinkSync(target, join(spool, 'alias'));
    const nested = join(spool, 'nested');
    mkdirSync(nested, { mode: 0o700 });
    writeFileSync(join(nested, 'kept.txt'), 'nested-bytes\n', { mode: 0o600 });
    const dropped = sweepNonId(root, spool);
    expect(dropped).toBe(flood + 1);
    expect(readdirSync(spool).sort()).toEqual([receipt, temp, 'nested']);
    expect(readFileSync(join(spool, receipt), 'utf8')).toBe('receipt-bytes\n');
    expect(readFileSync(join(spool, temp), 'utf8')).toBe('temp-bytes\n');
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('symlink-target\n');
    expect(lstatSync(nested).isDirectory()).toBe(true);
    expect(readFileSync(join(nested, 'kept.txt'), 'utf8')).toBe('nested-bytes\n');
  } finally {
    discardFixtures([root], { roots: [dirname(root)] });
  }
});
