// A fake rejected stream past the cap. No signal is installed and no live seat is touched.
import { expect, test } from 'bun:test';
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capRejected, STATUS_REJECTED_CAP, sweepNonId } from '../src/daemon/presence/native-feed.ts';

test('a rejected stream past the cap keeps the bound and counts the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-rejected-'));
  try {
    const dir = join(root, 'status-rejected');
    mkdirSync(dir, { mode: 0o700 });
    const extra = 3;
    for (let i = 0; i < STATUS_REJECTED_CAP + extra; i += 1) {
      writeFileSync(join(dir, `file-${String(i).padStart(4, '0')}.json`), '{}\n');
    }
    expect(capRejected(root)).toBe(extra);
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(STATUS_REJECTED_CAP);
    expect(kept[0]).toBe(`file-${String(extra).padStart(4, '0')}.json`);
    writeFileSync(join(dir, 'file-9999.json'), '{}\n');
    expect(capRejected(root)).toBe(extra + 1);
    expect(readdirSync(dir)).toHaveLength(STATUS_REJECTED_CAP);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a flood of non-id names is swept and counted', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-rejected-'));
  try {
    const spool = join(root, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    const id = '2026-11-06T19:00:00.000Z-abcdef12.json';
    writeFileSync(join(spool, id), '{}\n');
    for (let i = 0; i < 70; i += 1) writeFileSync(join(spool, `junk-${String(i)}`), 'x\n');
    expect(sweepNonId(root, spool)).toBe(70);
    expect(readdirSync(spool)).toEqual([id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('50,000 non-id names drain over passes of at most 1,024 names', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-sweep-budget-'));
  try {
    const spool = join(root, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    const id = '2026-11-06T19:00:00.000Z-abcdef12.json';
    writeFileSync(join(spool, id), '{}\n');
    for (let i = 0; i < 50_000; i += 1) writeFileSync(join(spool, `junk-${String(i)}`), '');
    let removed = 0;
    let passes = 0;
    while (removed < 50_000 && passes < 100) {
      const total = sweepNonId(root, spool);
      expect(total - removed).toBeGreaterThan(0);
      expect(total - removed).toBeLessThanOrEqual(1_024);
      expect(readdirSync(spool)).toHaveLength(50_001 - total);
      removed = total;
      passes += 1;
    }
    expect(removed).toBe(50_000);
    expect(passes).toBeGreaterThan(1);
    expect(readdirSync(spool)).toEqual([id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('empty planted directories are removed without recursion or following links', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-sweep-directories-'));
  try {
    const spool = join(root, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    mkdirSync(join(spool, 'empty-one'));
    mkdirSync(join(spool, 'empty-two'));
    const populated = join(spool, 'populated');
    mkdirSync(populated);
    writeFileSync(join(populated, 'inside'), 'keep inside\n');
    const outside = join(root, 'outside');
    writeFileSync(outside, 'keep outside\n');
    symlinkSync(outside, join(spool, 'linked'));
    expect(sweepNonId(root, spool)).toBe(3);
    expect(existsSync(join(spool, 'empty-one'))).toBe(false);
    expect(existsSync(join(spool, 'empty-two'))).toBe(false);
    expect(existsSync(join(spool, 'linked'))).toBe(false);
    expect(readFileSync(join(populated, 'inside'), 'utf8')).toBe('keep inside\n');
    expect(readFileSync(outside, 'utf8')).toBe('keep outside\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent directories do not starve junk behind the per-pass budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-sweep-fairness-'));
  try {
    const spool = join(root, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    // Choose the layout from this filesystem's entry order rather than assuming sorted names.
    for (let i = 0; i < 1_124; i += 1) mkdirSync(join(spool, `entry-${String(i).padStart(4, '0')}`));
    const names = readdirSync(spool);
    const persistent = new Set(names.slice(0, 1_100));
    const junk = names.slice(1_100);
    for (const name of persistent) writeFileSync(join(spool, name, 'inside'), 'keep inside\n');
    for (const name of junk) {
      rmdirSync(join(spool, name));
      writeFileSync(join(spool, name), 'junk\n');
    }
    expect(readdirSync(spool).slice(0, 1_024).every(name => persistent.has(name))).toBe(true);
    let removed = 0;
    for (let pass = 0; pass < Math.ceil(names.length / 1_024); pass += 1) removed = sweepNonId(root, spool);
    expect(removed).toBe(junk.length);
    expect(junk.every(name => !existsSync(join(spool, name)))).toBe(true);
    expect(readdirSync(spool)).toHaveLength(1_100);
    expect(readFileSync(join(spool, names[0]!, 'inside'), 'utf8')).toBe('keep inside\n');
    writeFileSync(join(spool, '000-wrap-junk'), 'junk before the cursor\n');
    for (let pass = 0; pass < Math.ceil((persistent.size + 1) / 1_024); pass += 1) removed = sweepNonId(root, spool);
    expect(removed).toBe(junk.length + 1);
    expect(existsSync(join(spool, '000-wrap-junk'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('staging cleanup uses ctime age and preserves receipts and link targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-staging-age-'));
  try {
    const spool = join(root, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    // Every inode is new: backdated or future mtime does not change its retention age.
    const now = Date.now();
    const old = new Date(now - 6 * 60_000);
    const recent = new Date(now - 4 * 60_000);
    const future = new Date(now + 60 * 60_000);
    const receipt = '2026-11-06T19:00:00.000Z-00000000.json';
    const stage = (nonce: number) => join(spool,
      `2026-11-06T19:00:00.000Z-${nonce.toString(16).padStart(8, '0')}.json.new.0123456789abcdef`);
    writeFileSync(join(spool, receipt), 'old receipt\n');
    utimesSync(join(spool, receipt), old, old);
    writeFileSync(stage(1), 'expired staging\n');
    utimesSync(stage(1), old, old);
    writeFileSync(stage(2), 'recent staging\n');
    utimesSync(stage(2), old, recent);
    writeFileSync(stage(3), 'future staging\n');
    utimesSync(stage(3), future, future);
    mkdirSync(stage(4));
    utimesSync(stage(4), old, old);
    mkdirSync(stage(5));
    writeFileSync(join(stage(5), 'inside'), 'keep nested\n');
    utimesSync(stage(5), old, old);
    const target = join(root, 'outside-spool');
    writeFileSync(target, 'keep target\n');
    utimesSync(target, old, old);
    symlinkSync(target, stage(6));
    lutimesSync(stage(6), recent, recent);
    symlinkSync(target, stage(7));
    lutimesSync(stage(7), old, old);
    const malformed = stage(8).slice(0, -1);
    writeFileSync(malformed, 'not an exact staging name\n');

    expect(sweepNonId(root, spool, now)).toBe(1);
    expect(existsSync(stage(1))).toBe(true);
    expect(readFileSync(stage(2), 'utf8')).toBe('recent staging\n');
    expect(readFileSync(stage(3), 'utf8')).toBe('future staging\n');
    expect(existsSync(stage(4))).toBe(true);
    expect(readFileSync(join(stage(5), 'inside'), 'utf8')).toBe('keep nested\n');
    expect(existsSync(stage(6))).toBe(true);
    expect(existsSync(stage(7))).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('keep target\n');
    expect(readFileSync(join(spool, receipt), 'utf8')).toBe('old receipt\n');
    expect(existsSync(malformed)).toBe(false);
    expect(sweepNonId(root, spool, now + 6 * 60_000)).toBe(7);
    for (const nonce of [1, 2, 3, 4, 6, 7]) expect(existsSync(stage(nonce))).toBe(false);
    expect(readFileSync(join(stage(5), 'inside'), 'utf8')).toBe('keep nested\n');
    expect(readFileSync(target, 'utf8')).toBe('keep target\n');
    expect(readFileSync(join(spool, receipt), 'utf8')).toBe('old receipt\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('a future mtime cannot extend staging retention past its ctime cutoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-staging-ctime-'));
  try {
    const spool = join(root, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    const path = join(spool, '2026-11-06T19:00:00.000Z-00000001.json.new.0123456789abcdef');
    writeFileSync(path, 'staging with future mtime\n');
    const future = new Date(Date.now() + 60 * 60_000);
    utimesSync(path, future, future);
    const held = lstatSync(path);
    const expires = held.ctimeMs + 5 * 60_000;
    expect(held.mtimeMs).toBeGreaterThan(expires + 1);
    expect(sweepNonId(root, spool, expires)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(sweepNonId(root, spool, expires + 1)).toBe(1);
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
