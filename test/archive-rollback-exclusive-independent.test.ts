// A manifest-write refusal during a retention move must not put the archived record back
// over a live drop recreated under the same name. Both files stay, both are named, and the
// live bytes are the ones just written. Synthetic mailbox only.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { receiptFile, signReceiptPayload } from '../src/send/record.ts';
import {
  DROP_ARCHIVE_DIR,
  dropRetirementSteps,
  getRelativeDirOps,
  type DropRetirementInput,
  type DropRetirementReport,
} from '../src/send/drop-retention.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const SESSION = 'morning';
const SEAT = 'reader';
const ID = '6b1f3c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';
const OLD = '2026-10-01T00:00:00.000Z';
const AT = new Date('2026-11-06T18:30:00.000Z');
const LIVE = 'recreated-live-drop\n';

const bases: string[] = [];
afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function retire(input: DropRetirementInput): DropRetirementReport {
  const steps = dropRetirementSteps(input);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

test('a manifest refusal keeps a recreated live drop and leaves the archived copy', () => {
  const base = fixtureBase('archive-rollback-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = join(base, 'oak');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const drop = recordDir(root, SESSION, SEAT);
  plantRecord(home, root, SESSION, SEAT, ID, 'the drop that retention moves', {
    from: 'reader',
    rule: 'a seat to a seat of its own team',
    at: OLD,
  });
  const receipt = signReceiptPayload({
    kind: 'receipt',
    status: 'read',
    id: ID,
    to: SEAT,
    root,
    session: SESSION,
    at: OLD,
  }, home);
  writeFileSync(receiptFile(drop, ID, 'read'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const original = readFileSync(join(drop, ID));
  const ops = getRelativeDirOps();
  expect(ops).not.toBeNull();
  if (ops === null) return;
  let recreated = false;
  const atFfi = {
    ...ops,
    openat(dirfd: number, name: string, flags: number, mode?: number) {
      if (name.startsWith('manifest-') && !recreated) {
        recreated = true;
        writeFileSync(join(drop, ID), LIVE, { mode: 0o600 });
        return { fd: -1, errno: 13 };
      }
      return ops.openat(dirfd, name, flags, mode);
    },
  };
  const report = retire({ root, home, at: AT, olderThanMs: 60_000, atFfi });
  const live = join(drop, ID);
  const archived = join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, AT.toISOString().slice(0, 10), SESSION, SEAT, ID);
  expect(recreated).toBe(true);
  expect(report.manifestPath).toBeNull();
  expect(report.refused ?? '').toContain(live);
  expect(report.refused ?? '').toContain(archived);
  expect(report.archived.map((family) => family.id)).toContain(ID);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(archived)).toBe(true);
  expect(readFileSync(live).toString()).toBe(LIVE);
  expect(readFileSync(archived).equals(original)).toBe(true);
});
