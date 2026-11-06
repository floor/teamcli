// A fake rejected stream past the cap. No signal is installed and no live seat is touched.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    for (let pass = 0; pass < 4; pass += 1) removed = sweepNonId(root, spool);
    expect(removed).toBe(junk.length);
    expect(junk.every(name => !existsSync(join(spool, name)))).toBe(true);
    expect(readdirSync(spool)).toHaveLength(1_100);
    expect(readFileSync(join(spool, names[0]!, 'inside'), 'utf8')).toBe('keep inside\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
