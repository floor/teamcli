// A fake rejected stream past the cap. No signal is installed and no live seat is touched.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capRejected, STATUS_REJECTED_CAP } from '../src/daemon/presence/native-feed.ts';

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
