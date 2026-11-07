// One trim of a fake rejected stream. No signal is installed and no live seat is touched.
import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { capRejected, STATUS_REJECTED_CAP } from '../src/daemon/presence/native-feed.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

test('a stream past 64 drops the earliest names first, leaves the symlink target, and adds the planted count', () => {
  expect(STATUS_REJECTED_CAP).toBe(64);
  const root = fixtureBase('status-rejected-cap-');
  try {
    const rejected = join(root, 'status-rejected');
    mkdirSync(rejected, { mode: 0o700 });
    const target = join(root, 'symlink-target');
    writeFileSync(target, 'symlink-target\n', { mode: 0o600 });
    symlinkSync(target, join(rejected, 'file-0000.link'));
    for (let i = 1; i <= STATUS_REJECTED_CAP + 2; i += 1) {
      writeFileSync(join(rejected, `file-${String(i).padStart(4, '0')}.json`), '{}\n', { mode: 0o600 });
    }
    const planted = 4;
    const counter = join(root, 'status-rejected-dropped.json');
    writeFileSync(counter, `{"dropped":${planted}}\n`, { mode: 0o600 });
    const before = readdirSync(rejected).sort();
    const overflow = before.length - STATUS_REJECTED_CAP;
    expect(before.slice(0, overflow)).toEqual(['file-0000.link', 'file-0001.json', 'file-0002.json']);
    const dropped = capRejected(root);
    const kept = readdirSync(rejected).sort();
    expect(dropped).toBe(planted + overflow);
    expect(kept).toEqual(before.slice(overflow));
    expect(kept).toHaveLength(STATUS_REJECTED_CAP);
    expect(kept[0]).toBe('file-0003.json');
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('symlink-target\n');
    expect(lstatSync(counter).isSymbolicLink()).toBe(false);
    expect(readFileSync(counter, 'utf8')).toBe(`{"dropped":${planted + overflow}}\n`);
  } finally {
    discardFixtures([root], { roots: [dirname(root)] });
  }
});
