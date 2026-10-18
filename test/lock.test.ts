import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLock } from '../src/commands/lock.ts';
import { runUnlock } from '../src/commands/unlock.ts';
import {
  formatAge,
  formatWho,
  lockDirectory,
  locksRoot,
  parseWho,
  type LockIdentity,
  type LockSources,
} from '../src/lock/machine.ts';
import { LOCK_OUTPUT_SCHEMA, UNLOCK_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const OWNER: LockIdentity = { team: 'beacon', by: 'owner' };
const SEAT: LockIdentity = { team: 'beacon', by: 'claude-keeper' };
const OTHER: LockIdentity = { team: 'other', by: 'owner' };
const AT = Date.parse('2026-10-04T09:00:00Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function homeOf(): string {
  base = mkdtempSync(join(tmpdir(), 'team-lock-'));
  return join(base, 'home');
}

function sources(home: string, identity: LockIdentity, clock: { at: number } = { at: AT }, sleep?: LockSources['sleep']): LockSources {
  return {
    home,
    identity,
    now: () => new Date(clock.at),
    sleep: sleep ?? (() => {}),
  };
}

function whoPath(home: string, name: string): string {
  return join(lockDirectory(home, name), 'who');
}

describe('formatAge', () => {
  test('counts seconds, then minutes, hours and days', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(59_000)).toBe('59s');
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(3_600_000)).toBe('1h');
    expect(formatAge(3_900_000)).toBe('1h 5m');
    expect(formatAge(49 * 3_600_000)).toBe('2d 1h');
    expect(formatAge(-5)).toBe('0s');
  });
});

describe('team lock', () => {
  test('a plain mkdir takes the lock and the holder is written after', async () => {
    const home = homeOf();
    const io = testIo(base, { kind: 'owner' });
    const code = await runLock(['heavy-run', '--for', 'release CI'], io, sources(home, OWNER));
    expect(code).toBe(0);
    expect(io.out).toBe(
      'heavy-run: taken\nteam: beacon\nrun: release CI\nby: owner\nat: 2026-10-04T09:00:00Z\n',
    );
    expect(io.err).toBe('');
    const dir = lockDirectory(home, 'heavy-run');
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readFileSync(whoPath(home, 'heavy-run'), 'utf8')).toBe(formatWho({
      team: 'beacon',
      run: 'release CI',
      by: 'owner',
      at: '2026-10-04T09:00:00Z',
    }));
    expect(readdirSync(locksRoot(home)).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  test('a held lock is refused and its holder file is not replaced', async () => {
    const home = homeOf();
    const first = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--for', 'release CI'], first, sources(home, OWNER))).toBe(0);
    const held = readFileSync(whoPath(home, 'heavy-run'), 'utf8');
    const second = testIo(base, { kind: 'seat', name: 'claude-keeper', pane: 'w1:p1' });
    const code = await runLock(['heavy-run', '--for', 'a later run'], second, sources(home, SEAT, { at: AT + 90_000 }));
    expect(code).toBe(1);
    expect(second.out).toBe('');
    expect(second.err).toBe('heavy-run: held since 2026-10-04T09:00:00Z by owner (beacon) — release CI, for 1m\n');
    expect(readFileSync(whoPath(home, 'heavy-run'), 'utf8')).toBe(held);
  });

  test('an existing directory is held, so a recursive mkdir cannot take it or write a holder', async () => {
    const home = homeOf();
    mkdirSync(lockDirectory(home, 'heavy-run'), { recursive: true });
    const io = testIo(base, { kind: 'owner' });
    const code = await runLock(['heavy-run'], io, sources(home, OWNER));
    expect(code).toBe(1);
    expect(io.err).toBe('heavy-run: held; its holder file is not there yet\n');
    expect(existsSync(whoPath(home, 'heavy-run'))).toBe(false);
    expect(readdirSync(lockDirectory(home, 'heavy-run'))).toEqual([]);
  });

  test('a hand mkdir of the same path loses to the primitive, and the primitive loses to a hand mkdir', async () => {
    const home = homeOf();
    const io = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run'], io, sources(home, OWNER))).toBe(0);
    expect(() => mkdirSync(lockDirectory(home, 'heavy-run'))).toThrow();
    const other = join(base, 'other-home');
    mkdirSync(lockDirectory(other, 'heavy-run'), { recursive: true });
    const lost = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run'], lost, sources(other, OWNER))).toBe(1);
    expect(existsSync(whoPath(other, 'heavy-run'))).toBe(false);
  });

  test('a name that is a path is refused before the lock root exists', async () => {
    const home = homeOf();
    const io = testIo(base, { kind: 'owner' });
    for (const name of ['../out', 'a/b', '..', '.', 'Heavy', '-a', 'a--b', 'a.lock', 'a b', 'a'.repeat(65)]) {
      const code = await runLock([name], io, sources(home, OWNER));
      expect(code).toBe(2);
    }
    expect(existsSync(locksRoot(home))).toBe(false);
    expect(existsSync(join(base, 'out'))).toBe(false);
    expect(io.err).toContain('is a name, not a path');
  });

  test('a newline in --for stays one line in the holder file', async () => {
    const home = homeOf();
    const io = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--for', 'one\ntwo'], io, sources(home, OWNER))).toBe(0);
    const who = parseWho(readFileSync(whoPath(home, 'heavy-run'), 'utf8'));
    expect(who?.run).toBe('one two');
  });

  test('--wait times out on a held lock and does not break it', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run', '--for', 'release CI'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    const held = readFileSync(whoPath(home, 'heavy-run'), 'utf8');
    const clock = { at: AT };
    const slept: number[] = [];
    const io = testIo(base, { kind: 'owner' });
    const code = await runLock(['heavy-run', '--wait', '2'], io, sources(home, SEAT, clock, (ms) => {
      slept.push(ms);
      clock.at += ms;
    }));
    expect(code).toBe(1);
    expect(slept).toEqual([1000, 1000]);
    expect(io.err).toContain('by owner (beacon)');
    expect(readFileSync(whoPath(home, 'heavy-run'), 'utf8')).toBe(held);
  });

  test('--wait takes the lock once the holder has released it', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    const clock = { at: AT };
    const io = testIo(base, { kind: 'seat', name: 'claude-keeper', pane: 'w1:p1' });
    const code = await runLock(['heavy-run', '--wait', '2', '--for', 'next'], io, sources(home, SEAT, clock, () => {
      clock.at += 1000;
      unlinkSync(whoPath(home, 'heavy-run'));
      rmdirSync(lockDirectory(home, 'heavy-run'));
    }));
    expect(code).toBe(0);
    expect(parseWho(readFileSync(whoPath(home, 'heavy-run'), 'utf8'))?.by).toBe('claude-keeper');
  });

  test('a frozen clock ends the wait instead of spinning', async () => {
    const home = homeOf();
    mkdirSync(lockDirectory(home, 'heavy-run'), { recursive: true });
    const slept: number[] = [];
    const io = testIo(base, { kind: 'owner' });
    const code = await runLock(['heavy-run', '--wait', '30'], io, sources(home, OWNER, { at: AT }, (ms) => {
      slept.push(ms);
    }));
    expect(code).toBe(1);
    expect(slept).toEqual([1000]);
    expect(io.err).toBe('heavy-run: held; its holder file is not there yet\n');
  });

  test('a symlink at the lock path is not followed and nothing is written through it', async () => {
    const home = homeOf();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'who'), 'secret\n');
    mkdirSync(locksRoot(home), { recursive: true });
    symlinkSync(outside, lockDirectory(home, 'heavy-run'));
    const io = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--for', 'nope'], io, sources(home, OWNER))).toBe(1);
    expect(io.err).toBe('heavy-run: held; its lock is not a directory\n');
    expect(readFileSync(join(outside, 'who'), 'utf8')).toBe('secret\n');
  });

  test('the caller and the project are recorded from the team file when no identity is injected', async () => {
    const home = homeOf();
    const root = join(base, 'beacon');
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: beacon
coordinator: lead
operator: lead
trust:
  - .
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`);
    const io = testIo(root, { kind: 'owner' });
    const code = await runLock(['heavy-run', '--for', 'from the file'], io, {
      home,
      now: () => new Date(AT),
      sleep: () => {},
    });
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(parseWho(readFileSync(whoPath(home, 'heavy-run'), 'utf8'))).toEqual({
      team: 'beacon',
      run: 'from the file',
      by: 'owner',
      at: '2026-10-04T09:00:00Z',
    });
  });

  test('outside a repository, the refusal offers no --file: lock takes none', async () => {
    const home = homeOf();
    const io = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run'], io, { home, now: () => new Date(AT), sleep: () => {} })).toBe(2);
    expect(io.err).toBe('team lock: not inside a git repository: run team from a project\n');

    const json = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--json'], json, { home, now: () => new Date(AT), sleep: () => {} })).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, {
      id: 'lock.project',
      messageContains: 'not inside a git repository: run team from a project',
    });
  });
});

describe('team unlock', () => {
  test('the holder releases the lock, and a second unlock finds it gone', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    const io = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], io, sources(home, OWNER))).toBe(0);
    expect(io.out).toBe('heavy-run: released\n');
    expect(existsSync(lockDirectory(home, 'heavy-run'))).toBe(false);
    const again = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], again, sources(home, OWNER))).toBe(1);
    expect(again.err).toBe('heavy-run: not held\n');
  });

  test('outside a repository, the refusal offers no --file: unlock takes none', async () => {
    const home = homeOf();
    const io = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], io, { home })).toBe(2);
    expect(io.err).toBe('team unlock: not inside a git repository: run team from a project\n');

    const json = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run', '--json'], json, { home })).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, {
      id: 'unlock.project',
      messageContains: 'not inside a git repository: run team from a project',
    });
  });

  test('someone else is refused and the holder file is left as it was', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run', '--for', 'release CI'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    const held = readFileSync(whoPath(home, 'heavy-run'), 'utf8');
    const seat = testIo(base, { kind: 'seat', name: 'claude-keeper', pane: 'w1:p1' });
    expect(await runUnlock(['heavy-run'], seat, sources(home, SEAT))).toBe(1);
    expect(seat.err).toBe('heavy-run: held by owner (beacon) since 2026-10-04T09:00:00Z — release CI, not you\n');
    const other = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], other, sources(home, OTHER))).toBe(1);
    expect(other.err).toContain('not you');
    expect(readFileSync(whoPath(home, 'heavy-run'), 'utf8')).toBe(held);
    expect(existsSync(lockDirectory(home, 'heavy-run'))).toBe(true);
  });

  test('a lock with no holder file, or one that cannot be read, is left in place', async () => {
    const home = homeOf();
    mkdirSync(lockDirectory(home, 'heavy-run'), { recursive: true });
    const missing = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], missing, sources(home, OWNER))).toBe(1);
    expect(missing.err).toContain('its holder file is not there yet');
    expect(existsSync(lockDirectory(home, 'heavy-run'))).toBe(true);
    writeFileSync(whoPath(home, 'heavy-run'), 'owner\n');
    const garbage = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], garbage, sources(home, OWNER))).toBe(1);
    expect(garbage.err).toContain('its holder file cannot be read');
    expect(readFileSync(whoPath(home, 'heavy-run'), 'utf8')).toBe('owner\n');
  });

  test('a directory that still holds something else keeps its holder', async () => {
    const home = homeOf();
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, OWNER))).toBe(0);
    const held = readFileSync(whoPath(home, 'heavy-run'), 'utf8');
    writeFileSync(join(lockDirectory(home, 'heavy-run'), 'extra'), 'leave me\n');
    const io = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], io, sources(home, OWNER))).toBe(1);
    expect(io.err).toContain('could not remove');
    expect(readFileSync(whoPath(home, 'heavy-run'), 'utf8')).toBe(held);
    expect(readFileSync(join(lockDirectory(home, 'heavy-run'), 'extra'), 'utf8')).toBe('leave me\n');
  });

  test('a symlink is not removed', async () => {
    const home = homeOf();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'who'), 'secret\n');
    mkdirSync(locksRoot(home), { recursive: true });
    symlinkSync(outside, lockDirectory(home, 'heavy-run'));
    const io = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], io, sources(home, OWNER))).toBe(1);
    expect(io.err).toContain('not a directory');
    expect(lstatSync(lockDirectory(home, 'heavy-run')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'who'), 'utf8')).toBe('secret\n');
  });

  test('--json emits team.lock and team.unlock on success and team.error on refusals', async () => {
    const home = homeOf();
    const takeIo = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--for', 'release CI', '--json'], takeIo, sources(home, OWNER))).toBe(0);
    expect(takeIo.err).toBe('');
    const lockDoc = assertMatchesOutputSchema(takeIo.out, LOCK_OUTPUT_SCHEMA);
    expect(lockDoc).toEqual({
      schema: { name: 'team.lock', version: 1 },
      format: 1,
      dry_run: false,
      status: 'taken',
      action_summary: 'heavy-run: taken',
      project: 'beacon',
      target: 'heavy-run',
      value: 'release CI',
      holder: {
        team: 'beacon',
        run: 'release CI',
        by: 'owner',
        at: '2026-10-04T09:00:00Z',
      },
    });

    const heldIo = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--json'], heldIo, sources(home, SEAT))).toBe(1);
    expect(heldIo.err).toBe('');
    assertJsonErrorShape(heldIo.out, {
      id: 'lock.held',
      messageContains: 'heavy-run: held since 2026-10-04T09:00:00Z by owner (beacon)',
      repair: null,
    });

    const notYoursIo = testIo(base, { kind: 'seat', name: 'claude-keeper', pane: 'w1:p1' });
    expect(await runUnlock(['heavy-run', '--json'], notYoursIo, sources(home, SEAT))).toBe(1);
    expect(notYoursIo.err).toBe('');
    assertJsonErrorShape(notYoursIo.out, {
      id: 'unlock.not-yours',
      messageContains: 'not you',
      repair: null,
    });

    const releaseIo = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run', '--json'], releaseIo, sources(home, OWNER))).toBe(0);
    expect(releaseIo.err).toBe('');
    const unlockDoc = assertMatchesOutputSchema(releaseIo.out, UNLOCK_OUTPUT_SCHEMA);
    expect(unlockDoc).toEqual({
      schema: { name: 'team.unlock', version: 1 },
      format: 1,
      dry_run: false,
      status: 'released',
      action_summary: 'heavy-run: released',
      project: 'beacon',
      target: 'heavy-run',
      value: null,
    });

    const badLockIo = testIo(base, { kind: 'owner' });
    expect(await runLock(['--nope', '--json'], badLockIo, sources(home, OWNER))).toBe(2);
    expect(badLockIo.err).toBe('');
    assertJsonErrorShape(badLockIo.out, {
      id: 'lock.invocation',
      messageContains: 'unknown option --nope',
      repair: null,
    });

    const badUnlockIo = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['--nope', '--json'], badUnlockIo, sources(home, OWNER))).toBe(2);
    expect(badUnlockIo.err).toBe('');
    assertJsonErrorShape(badUnlockIo.out, {
      id: 'unlock.invocation',
      messageContains: 'unknown option --nope',
      repair: null,
    });
  });
});
