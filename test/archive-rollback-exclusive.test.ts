// A manifest-write refusal rolls the archive back without replacing a live file that appeared
// in the meantime. The live file and the archived copy both stay, and the report names them.
// Synthetic home and team only.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { getRelativeDirOps, retireDropsSliced } from '../src/send/drop-retention.ts';
import { signReceiptPayload, writeReceipt } from '../src/send/record.ts';

const ID = '11111111-2222-4333-8444-555555555551';
const OLD = '2026-09-01T00:00:00.000Z';
const LIVE = 'new concurrent contents';

test('a manifest refusal keeps a recreated live file and the archived copy', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-archive-rollback-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  try {
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home, { mode: 0o700 });
    const planted = plantRecord(home, root, 'acme', 'worker', ID, 'original body', { at: OLD, from: 'lead' });
    const original = readFileSync(planted, 'utf8');
    const dir = recordDir(root, 'acme', 'worker');
    const receipt = signReceiptPayload(
      { kind: 'receipt', status: 'read', id: ID, to: 'worker', root, session: 'acme', at: OLD },
      home,
    );
    const wrote = writeReceipt(dir, receipt, home);
    if (!wrote.ok) throw new Error(wrote.reason);
    const ops = getRelativeDirOps();
    expect(ops).not.toBeNull();
    if (ops === null) return;
    let injected = false;
    const report = await retireDropsSliced({
      root,
      home,
      at: new Date('2026-11-06T17:00:00Z'),
      olderThanMs: 86_400_000,
      atFfi: {
        ...ops,
        openat: (fd, name, flags, mode) => {
          if (name.startsWith('manifest-')) {
            injected = true;
            writeFileSync(planted, LIVE);
            return { fd: -1, errno: 13 };
          }
          return ops.openat(fd, name, flags, mode);
        },
      },
      slices: { sliceMs: 2_000, stopping: () => false, yield: async () => true },
    });
    const archivedCopy = report.archived.flatMap((family) => family.files).find((file) => file.dest.endsWith(`/${ID}`));
    expect(injected).toBe(true);
    expect(report.refused).not.toBeNull();
    expect(report.archived.length).toBeGreaterThan(0);
    expect(readFileSync(planted, 'utf8')).toBe(LIVE);
    expect(archivedCopy).toBeDefined();
    expect(readFileSync(join(root, archivedCopy!.dest), 'utf8')).toBe(original);
    expect(report.refused).toContain(planted);
    expect(report.refused).toContain(archivedCopy!.dest);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
