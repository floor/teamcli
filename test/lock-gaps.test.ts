// The four sequential branches of the machine lock that the review of the feature branch found
// untested: the take-side rollback after a failed holder write (the lock directory our own
// mkdir just created is removed again), the release re-read that finds a different holder than
// the first look (the file changed between the two reads), a release whose directory removal
// and holder rewrite both fail, and an unreadable holder under --wait. Two takers in the same
// instant stay untested on purpose: mutual exclusion rests on mkdir's atomicity, a documented
// assumption of the design, not a property this suite could pin without racing.
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testIo } from './helpers.ts';
import type { LockIdentity, LockSources, Who } from '../src/lock/machine.ts';

const OWNER: LockIdentity = { team: 'beacon', by: 'owner' };
const AT = Date.parse('2026-10-04T09:00:00Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function homeOf(): string {
  base = mkdtempSync(join(tmpdir(), 'team-lock-gaps-'));
  return join(base, 'home');
}

function sources(home: string, identity: LockIdentity, clock: { at: number } = { at: AT }, sleep?: LockSources['sleep']): LockSources {
  return { home, identity, now: () => new Date(clock.at), sleep: sleep ?? (() => {}) };
}

// The release re-read has no injection seam: releaseLock reads the holder twice through the
// real filesystem and nothing in LockSources intercepts a read. The only way to make the file
// change between those two reads without a race is to intercept the read itself, so node:fs is
// wrapped before machine.ts first loads (bun 1.4.2 binds a named import to the function itself
// — the broker test's own finding — a patch registered after the import never fires). The
// wrapper delegates everything to the real fs except the second read of one named path, and
// counts its own firings: reads === 2 in the test below is the wire's positive control — a
// patch that never fires must never be believed.
let secondRead: { path: string; reads: number; bytes: string } | null = null;

let machine: typeof import('../src/lock/machine.ts');
let runLock: typeof import('../src/commands/lock.ts').runLock;
let runUnlock: typeof import('../src/commands/unlock.ts').runUnlock;

beforeAll(async () => {
  mock.module('node:fs', () => {
    const proxied = Object.assign({}, realFs);
    const realRead = realFs.readFileSync;
    proxied.readFileSync = ((path: unknown, options?: unknown) => {
      if (secondRead !== null && path === secondRead.path && options === 'utf8') {
        secondRead.reads += 1;
        if (secondRead.reads === 2) return secondRead.bytes;
      }
      return realRead(path as never, options as never);
    }) as typeof realFs.readFileSync;
    return proxied;
  });
  machine = await import('../src/lock/machine.ts');
  ({ runLock } = await import('../src/commands/lock.ts'));
  ({ runUnlock } = await import('../src/commands/unlock.ts'));
});

function whoPath(home: string): string {
  return join(machine.lockDirectory(home, 'heavy-run'), 'who');
}

describe('the take-side rollback', () => {
  test('a holder write that fails after our own mkdir frees the name again', async () => {
    const home = homeOf();
    // The locks root is created under the normal umask first, so only the lock directory that
    // the take itself creates comes out mode 000: with the umask at 0777 the mkdir still
    // succeeds (creating costs nothing), but the rename of the holder's temp file into that
    // directory needs write and search on it and fails with EACCES — a write that fails after
    // the take, which is the rollback's case. rmdir needs only write on the parent, so the
    // rollback can still remove the empty directory.
    mkdirSync(machine.locksRoot(home), { recursive: true });
    const was = process.umask(0o777);
    let code = -1;
    const io = testIo(base, { kind: 'owner' });
    try {
      code = await runLock(['heavy-run', '--for', 'release CI'], io, sources(home, OWNER));
    } finally {
      process.umask(was);
    }
    expect(code).toBe(1);
    expect(io.err).toContain('team lock: ');
    expect(io.err).toContain('EACCES');
    expect(io.err).toContain('rename');
    // the rollback: the empty directory is gone and no temp was left beside the lock
    expect(existsSync(machine.lockDirectory(home, 'heavy-run'))).toBe(false);
    expect(readdirSync(machine.locksRoot(home)).filter((name) => name.startsWith('.'))).toEqual([]);
    // and the name is free: a second take wins and writes its own holder
    const retake = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--for', 'again'], retake, sources(home, OWNER))).toBe(0);
    expect(readFileSync(whoPath(home), 'utf8')).toBe(
      machine.formatWho({ team: 'beacon', run: 'again', by: 'owner', at: '2026-10-04T09:00:00Z' }),
    );
  });
});

describe('the release re-read', () => {
  test('a holder that changes between the look and the removal is not released', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run', '--for', 'release CI'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    const held = readFileSync(whoPath(home), 'utf8');
    const changed: Who = { team: 'beacon', run: 'release CI', by: 'claude-keeper', at: '2026-10-04T09:00:05Z' };
    secondRead = { path: whoPath(home), reads: 0, bytes: machine.formatWho(changed) };
    const io = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], io, sources(home, OWNER))).toBe(1);
    expect(io.err).toBe(`${machine.notYoursLine('heavy-run', changed)}\n`);
    expect(secondRead.reads).toBe(2);
    // the real file was never touched: the lock stands, held by the holder on disk
    expect(readFileSync(whoPath(home), 'utf8')).toBe(held);
    expect(existsSync(machine.lockDirectory(home, 'heavy-run'))).toBe(true);
    secondRead = null;
  });
});

describe('a release whose removal and holder rewrite both fail', () => {
  test('reports the holder file as removed and leaves the directory', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run', '--for', 'release CI'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    // A read-only locks root: the holder file's unlink succeeds (it lives inside the still
    // writable lock directory), but the directory's removal needs write on the root and so
    // does the holder rewrite — writeWho's temp file — so both fail, which is the branch that
    // reports the holder file as removed.
    chmodSync(machine.locksRoot(home), 0o555);
    let code = -1;
    const io = testIo(base, { kind: 'owner' });
    try {
      code = await runUnlock(['heavy-run'], io, sources(home, OWNER));
    } finally {
      chmodSync(machine.locksRoot(home), 0o755);
    }
    expect(code).toBe(1);
    expect(io.err).toContain('team unlock: removed the holder file but could not remove ');
    expect(io.err).toContain('heavy-run.lock');
    expect(io.err).toContain('EACCES');
    // the unlink went through and the rewrite failed: the directory is left with no holder
    expect(existsSync(whoPath(home))).toBe(false);
    expect(existsSync(machine.lockDirectory(home, 'heavy-run'))).toBe(true);
  });
});

describe('an unreadable holder under --wait', () => {
  test('is final: the wait returns at once and never sleeps', async () => {
    const home = homeOf();
    // chmod 000 on the holder file makes see()'s read fail with EACCES — the unreadable
    // shape, distinct from a holder whose bytes do not parse: no content is ever read.
    mkdirSync(machine.lockDirectory(home, 'heavy-run'), { recursive: true });
    writeFileSync(whoPath(home), machine.formatWho({ team: 'beacon', run: 'release CI', by: 'owner', at: '2026-10-04T09:00:00Z' }));
    chmodSync(whoPath(home), 0o000);
    const clock = { at: AT };
    const slept: number[] = [];
    const io = testIo(base, { kind: 'owner' });
    const code = await runLock(
      ['heavy-run', '--wait', '2'],
      io,
      sources(home, OWNER, clock, (ms) => {
        slept.push(ms);
        clock.at += ms;
      }),
    );
    expect(code).toBe(1);
    expect(io.err).toBe('heavy-run: held; its holder file cannot be read\n');
    expect(slept).toEqual([]);
    expect(existsSync(machine.lockDirectory(home, 'heavy-run'))).toBe(true);
    expect(existsSync(whoPath(home))).toBe(true);
  });
});
