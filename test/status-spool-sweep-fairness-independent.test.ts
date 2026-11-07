// A spool sweep drops at most 1,024 entries in one pass. Non-empty planted directories ahead
// of the junk hold the front of the scan, so the junk waits for a later pass, and a few
// passes still remove every junk file and every empty planted directory. A valid receipt and
// its staging name stay.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { presenceId } from '../src/daemon/presence/contract.ts';
import { sweepNonId } from '../src/daemon/presence/native-feed.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const BLOCKERS = 1100;
const JUNK = 24;
const EMPTY = 3;
const CAP = 1024;

test('junk behind a long run of planted directories is removed within a few passes', () => {
  const base = fixtureBase('spool-fairness');
  const root = join(base, 'presence');
  const spool = join(root, 'status-spool');
  const ts = '2026-11-06T20:21:00.000Z';
  const id = presenceId(ts, '0123abcd');
  if (id === null) throw new Error('presence id');
  const receipt = `${id}.json`;
  const staging = `${id}.json.new.${'ab'.repeat(8)}`;
  try {
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    writeFileSync(join(spool, receipt), `${JSON.stringify({
      v: 1,
      id,
      ts,
      session: 'sandbox',
      seat: 'seat-one',
      binding: 'prs_0123456789ab',
      epoch: null,
      source: 'claude-hook',
      reason: 'event',
    })}\n`, { mode: 0o600 });
    writeFileSync(join(spool, staging), '{}\n', { mode: 0o600 });
    for (let i = 0; i < BLOCKERS; i++) {
      const dir = join(spool, `aa-${String(i).padStart(4, '0')}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'keep'), 'held\n', { mode: 0o600 });
    }
    for (let i = 0; i < EMPTY; i++) mkdirSync(join(spool, `mm-empty-${i}`), { recursive: true, mode: 0o700 });
    for (let i = 0; i < JUNK; i++) {
      writeFileSync(join(spool, `zz-junk-${String(i).padStart(2, '0')}`), 'junk\n', { mode: 0o600 });
    }

    const first = sweepNonId(root, spool);
    expect(first).toBeLessThanOrEqual(CAP);
    expect(existsSync(join(spool, 'zz-junk-00'))).toBe(true);

    const dropped = [first];
    for (let pass = 0; pass < 5 && existsSync(join(spool, 'zz-junk-00')); pass++) {
      const count = sweepNonId(root, spool);
      expect(count).toBeLessThanOrEqual(CAP);
      dropped.push(count);
    }

    for (let i = 0; i < JUNK; i++) {
      expect(existsSync(join(spool, `zz-junk-${String(i).padStart(2, '0')}`))).toBe(false);
    }
    for (let i = 0; i < EMPTY; i++) expect(existsSync(join(spool, `mm-empty-${i}`))).toBe(false);
    for (let i = 0; i < BLOCKERS; i++) {
      expect(existsSync(join(spool, `aa-${String(i).padStart(4, '0')}`, 'keep'))).toBe(true);
    }
    expect(existsSync(join(spool, receipt))).toBe(true);
    expect(existsSync(join(spool, staging))).toBe(true);
    const removed = JUNK + EMPTY;
    const sum = dropped.reduce((total, count) => total + count, 0);
    expect(sum === removed || dropped[dropped.length - 1] === removed).toBe(true);
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});
