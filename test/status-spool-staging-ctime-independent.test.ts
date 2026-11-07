// An exact staging name is reclaimed from its own ctime. The sweep clock is the third argument,
// so the five-minute window moves without waiting. mtime, an hour either way, does not. A fresh
// name is kept and, once renamed onto the receipt, stays published. A symlink is aged by its own
// inode and is not followed. The sweep calls lstat directly and takes no fs seam, so a failure
// is a real ENAMETOOLONG: the staging path is grown past the platform limit, and a shorter
// sibling stays under it.
import { expect, test } from 'bun:test';
import {
  lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sweepNonId } from '../src/daemon/presence/native-feed.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const KEEP_MS = 5 * 60_000;
const sweep = sweepNonId as (root: string, directory: string, now: number) => number;

function receiptName(nonce: string): { staging: string; receipt: string } {
  const id = `2026-11-06T19:00:00.000Z-${nonce}`;
  return { staging: `${id}.json.new.${'ab'.repeat(8)}`, receipt: `${id}.json` };
}

function world(prefix: string): { base: string; root: string; spool: string } {
  const base = fixtureBase(prefix);
  const root = join(base, 'presence');
  const spool = join(root, 'status-spool');
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  return { base, root, spool };
}

test('an exact staging name is reclaimed only once its ctime is more than five minutes old', () => {
  const { base, root, spool } = world('spool-ctime-old');
  const path = join(spool, receiptName('00000001').staging);
  try {
    writeFileSync(path, 'exact\n', { mode: 0o600 });
    const ctime = lstatSync(path).ctimeMs;
    expect(sweep(root, spool, ctime + KEEP_MS)).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('exact\n');
    expect(sweep(root, spool, ctime + KEEP_MS + 1)).toBe(1);
    expect(readdirSync(spool)).not.toContain(receiptName('00000001').staging);
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});

test('an hour-ahead or hour-behind mtime does not change staging retention', () => {
  const { base, root, spool } = world('spool-ctime-mtime');
  const aheadName = receiptName('00000002').staging;
  const behindName = receiptName('00000003').staging;
  const ahead = join(spool, aheadName);
  const behind = join(spool, behindName);
  try {
    writeFileSync(ahead, 'ahead\n', { mode: 0o600 });
    writeFileSync(behind, 'behind\n', { mode: 0o600 });
    utimesSync(ahead, new Date(Date.now() + 60 * 60_000), new Date(Date.now() + 60 * 60_000));
    utimesSync(behind, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));
    const aheadStat = lstatSync(ahead);
    const behindStat = lstatSync(behind);
    expect(aheadStat.mtimeMs).toBeGreaterThan(aheadStat.ctimeMs + 59 * 60_000);
    expect(behindStat.mtimeMs).toBeLessThan(behindStat.ctimeMs - 59 * 60_000);
    const keptAt = Math.min(aheadStat.ctimeMs, behindStat.ctimeMs) + KEEP_MS;
    expect(behindStat.mtimeMs).toBeLessThan(keptAt);
    expect(sweep(root, spool, keptAt)).toBe(0);
    expect(readFileSync(ahead, 'utf8')).toBe('ahead\n');
    expect(readFileSync(behind, 'utf8')).toBe('behind\n');
    const dropAt = Math.max(aheadStat.ctimeMs, behindStat.ctimeMs) + KEEP_MS + 1;
    expect(aheadStat.mtimeMs).toBeGreaterThan(dropAt);
    expect(sweep(root, spool, dropAt)).toBe(2);
    const left = readdirSync(spool);
    expect(left).not.toContain(aheadName);
    expect(left).not.toContain(behindName);
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});

test('a fresh staging name is kept and publishes once renamed onto the receipt', () => {
  const { base, root, spool } = world('spool-ctime-publish');
  const { staging, receipt } = receiptName('00000004');
  const staged = join(spool, staging);
  const published = join(spool, receipt);
  const body = 'published record\n';
  try {
    writeFileSync(staged, body, { mode: 0o600 });
    const ctime = lstatSync(staged).ctimeMs;
    expect(sweep(root, spool, ctime + KEEP_MS)).toBe(0);
    expect(readFileSync(staged, 'utf8')).toBe(body);
    renameSync(staged, published);
    expect(readdirSync(spool)).not.toContain(staging);
    expect(sweep(root, spool, ctime + 60 * 60_000)).toBe(0);
    expect(readFileSync(published, 'utf8')).toBe(body);
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});

test('a dangling staging symlink is aged by its own ctime and never followed', () => {
  const { base, root, spool } = world('spool-ctime-link');
  const danglingName = receiptName('00000005').staging;
  const linkedName = receiptName('00000006').staging;
  const dangling = join(spool, danglingName);
  const linked = join(spool, linkedName);
  const missing = join(base, 'missing-target');
  const target = join(base, 'kept-target');
  try {
    symlinkSync(missing, dangling);
    lutimesSync(dangling, new Date(Date.now() + 60 * 60_000), new Date(Date.now() + 60 * 60_000));
    const danglingStat = lstatSync(dangling);
    expect(danglingStat.isSymbolicLink()).toBe(true);
    expect(danglingStat.mtimeMs).toBeGreaterThan(danglingStat.ctimeMs + 59 * 60_000);

    writeFileSync(target, 'target body\n', { mode: 0o600 });
    utimesSync(target, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));
    symlinkSync(target, linked);
    const linkStat = lstatSync(linked);
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(lstatSync(target).mtimeMs).toBeLessThan(linkStat.ctimeMs - 59 * 60_000);

    const keptAt = Math.min(danglingStat.ctimeMs, linkStat.ctimeMs) + KEEP_MS;
    expect(sweep(root, spool, keptAt)).toBe(0);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dangling)).toBe(missing);
    expect(readdirSync(base)).not.toContain('missing-target');
    expect(readFileSync(target, 'utf8')).toBe('target body\n');

    const dropAt = Math.max(danglingStat.ctimeMs, linkStat.ctimeMs) + KEEP_MS + 1;
    expect(danglingStat.mtimeMs).toBeGreaterThan(dropAt);
    expect(sweep(root, spool, dropAt)).toBe(2);
    const left = readdirSync(spool);
    expect(left).not.toContain(danglingName);
    expect(left).not.toContain(linkedName);
    expect(readdirSync(base)).not.toContain('missing-target');
    expect(readFileSync(target, 'utf8')).toBe('target body\n');
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});

test('an lstat failure keeps the staging name', () => {
  const base = fixtureBase('spool-ctime-lstat');
  const root = join(base, 'presence');
  // Enough name-max segments to pass both the 1024-byte and 4096-byte path limits.
  const parts = Array.from({ length: 24 }, (_, index) => `p${String(index).padStart(2, '0')}`);
  const staging = receiptName('00000007').staging;
  const spoolAt = (names: readonly string[]) => join(base, ...names, 'spool');
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(spoolAt(parts), { recursive: true, mode: 0o700 });
    writeFileSync(join(spoolAt(parts), staging), 'held\n', { mode: 0o600 });
    writeFileSync(join(spoolAt(parts), 'zz-note'), 'junk\n', { mode: 0o600 });
    let spins = 0;
    for (;;) {
      if (++spins > 800) throw new Error('staging path stayed statable');
      const spool = spoolAt(parts);
      let stagingCode: string | undefined;
      try { lstatSync(join(spool, staging)); }
      catch (error) { stagingCode = (error as NodeJS.ErrnoException).code; }
      let junkCode: string | undefined;
      try { lstatSync(join(spool, 'zz-note')); }
      catch (error) { junkCode = (error as NodeJS.ErrnoException).code; }
      if (stagingCode === 'ENAMETOOLONG' && junkCode === undefined) break;
      if (stagingCode !== undefined) throw new Error(`staging lstat ${stagingCode}`);
      if (junkCode !== undefined) throw new Error(`junk lstat ${junkCode}`);
      const index = parts.findIndex((part) => part.length < 255);
      if (index < 0) throw new Error('staging path stayed statable');
      const from = join(base, ...parts.slice(0, index + 1));
      const previous = parts[index]!;
      // 51 bytes separate the staging name from zz-note, so a short step crosses the
      // limit for one and not the other. Outer segments grow first, so the rename stays
      // under the limit until the leaf path is already too long to lstat.
      const extra = Math.min(255 - previous.length, 32);
      parts[index] = `${previous}${'n'.repeat(extra)}`;
      try {
        renameSync(from, join(base, ...parts.slice(0, index + 1)));
      } catch (error) {
        parts[index] = previous;
        if ((error as NodeJS.ErrnoException).code !== 'ENAMETOOLONG' || extra === 1) throw error;
        parts[index] = `${previous}n`;
        renameSync(from, join(base, ...parts.slice(0, index + 1)));
      }
    }
    const spool = spoolAt(parts);
    expect(readdirSync(spool)).toContain(staging);
    expect(readdirSync(spool)).toContain('zz-note');
    expect(sweep(root, spool, Date.now() + 24 * 60 * 60_000)).toBe(1);
    const left = readdirSync(spool);
    expect(left).toContain(staging);
    expect(left).not.toContain('zz-note');
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});
