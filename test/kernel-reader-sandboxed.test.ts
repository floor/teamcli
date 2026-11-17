// A process its Seatbelt profile confines never reads its parents from the kernel. A profile can
// let `proc_pidinfo` answer for processes outside the sandbox while it refuses `ps`; the kernel
// walk would then place a confined seat by its parents, skip the confined-seat placement and its
// outbox relay, and send its reply down the direct path, whose writes into another team's folder
// the sandbox refuses (EPERM on that team's seat lock). Under any Seatbelt profile the walk reads
// the `ps` table, as every caller did before the kernel reader, so a refused `ps` leaves the walk
// unread and the confined placement decides.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { confinedBySeatbelt } from '../src/process-kernel.ts';

describe('the Seatbelt check', () => {
  test('an unconfined answer keeps the kernel reader', () => {
    expect(confinedBySeatbelt(() => 0)).toBe(false);
  });

  test('a confined answer turns it off', () => {
    expect(confinedBySeatbelt(() => 1)).toBe(true);
  });

  test('a check that cannot be made counts as confined', () => {
    expect(confinedBySeatbelt(() => { throw new Error('no symbol'); })).toBe(true);
  });

  test('it asks about this process, with no operation and no filter', () => {
    const seen: unknown[][] = [];
    confinedBySeatbelt((...args) => { seen.push(args); return 0; });
    expect(seen).toEqual([[process.pid, null, 0]]);
  });
});

const seatbelt = process.platform === 'darwin' && process.versions.bun !== undefined && existsSync('/usr/bin/sandbox-exec');

describe.skipIf(!seatbelt)('a walk inside a Seatbelt profile (macOS)', () => {
  const src = resolve(import.meta.dir, '..', 'src');
  const dir = mkdtempSync(join(tmpdir(), 'kernel-sandboxed-'));
  const script = join(dir, 'walk.ts');
  writeFileSync(script, [
    `import { readAncestors } from ${JSON.stringify(join(src, 'caller.ts'))};`,
    `import { kernelProcessBound, setKernelProcessForTests } from ${JSON.stringify(join(src, 'process-kernel.ts'))};`,
    'const chain = readAncestors(undefined, undefined, () => {});',
    'const bound = kernelProcessBound();',
    'setKernelProcessForTests(null);',
    'const psOnly = readAncestors(undefined, undefined, () => {});',
    'const len = (c) => c === null ? null : c.length;',
    'console.log(JSON.stringify({ bound, chain: len(chain), psOnly: len(psOnly) }));',
  ].join('\n'));
  const run = (profile: string | null): { bound: boolean; chain: number | null; psOnly: number | null } => {
    const args = profile === null ? [process.execPath, script] : ['-p', profile, process.execPath, script];
    const out = execFileSync(profile === null ? args[0]! : '/usr/bin/sandbox-exec', profile === null ? args.slice(1) : args, { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop()!);
  };

  test('outside any profile the kernel reader is bound and the chain is read', () => {
    const seen = run(null);
    expect(seen.bound).toBe(true);
    expect(seen.chain).toBeGreaterThan(0);
  });

  test('a profile that refuses ps but answers proc_pidinfo leaves the walk unread', () => {
    const seen = run('(version 1)(allow default)(deny process-exec (literal "/bin/ps"))');
    expect(seen.bound).toBe(false);
    expect(seen.chain).toBeNull();
  });

  test('under any profile the walk is exactly the ps-only walk', () => {
    for (const profile of ['(version 1)(allow default)', '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))']) {
      const seen = run(profile);
      expect(seen.bound).toBe(false);
      expect(seen.chain).toBe(seen.psOnly);
    }
  });
});
