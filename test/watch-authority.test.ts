// The watch actor verifier: the record, the fence and the clock. These cases run against a real
// state file in a real team root, read through `readState` under the state lock, because the
// verifier's job is to judge exactly what the session records — not a snapshot a caller made up.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_FILE, STATE_FILE, withLock } from '../src/state.ts';
import { verifyWatchAuthority } from '../src/watch/authority.ts';
import {
  WATCH_AUTHORITY_FUTURE_SKEW_MS,
  WATCH_AUTHORITY_MAX_AGE_MS,
} from '../src/watch/epoch.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const SESSION = 'acme-web';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const EPOCH = `watch_${'0f'.repeat(16)}`;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

type Watch = Record<string, unknown> | undefined;

function world(watch: Watch, watchdog: Record<string, unknown> | null | undefined = undefined): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'watch-authority-'));
  roots.push(root);
  mkdirSync(join(root, '.agents'));
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, EXAMPLE);
  const session: Record<string, unknown> = { seats: {}, worktrees: {} };
  if (watch !== undefined) session.watch = watch;
  if (watchdog !== null) session.watchdog = watchdog ?? { file, pane: 'w1:p1' };
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: session } }, null, 2)}\n`,
  );
  return { root, file };
}

function beat(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function current(over: Watch = {}): Watch {
  return { pid: process.pid, epoch: EPOCH, heartbeat: beat(-1000), pane: 'w1:p1', ...over };
}

function ask(root: string, over: Record<string, unknown> = {}) {
  return verifyWatchAuthority({
    root,
    session: SESSION,
    epoch: EPOCH,
    purpose: 'direct-work',
    now: NOW,
    ...over,
  } as Parameters<typeof verifyWatchAuthority>[0]);
}

describe('the watch actor verifier', () => {
  test('admits the watch this session records, with a canonical authority and a diagnostic proof', () => {
    const { root, file } = world(current());
    const verdict = ask(root);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actor).toEqual({ kind: 'watch', session: SESSION, pane: 'w1:p1' });
    expect(verdict.authority.pid).toBe(process.pid);
    expect(verdict.authority.epoch).toBe(EPOCH);
    expect(verdict.authority.heartbeat).toBe(beat(-1000));
    expect(verdict.authority.file).toBe(realpathSync(file));
    expect(verdict.proof).toMatch(/^[0-9a-f]{64}$/);
  });

  test('canonicalizes the root: a trailing slash is the same watch, with the same proof', () => {
    const { root } = world(current());
    const plain = ask(root);
    const slashed = ask(`${root}/`);
    expect(plain.ok && slashed.ok).toBe(true);
    if (!plain.ok || !slashed.ok) return;
    expect(slashed.proof).toBe(plain.proof);
    expect(slashed.authority.file).toBe(plain.authority.file);
  });

  test('refuses when this session records no watch', () => {
    const { root } = world(undefined);
    expect(ask(root)).toEqual({ ok: false, why: 'this session records no watch' });
  });

  test('refuses when the record carries no epoch', () => {
    const { root } = world({ pid: process.pid, heartbeat: beat(-1000), pane: 'w1:p1' });
    expect(ask(root)).toEqual({ ok: false, why: 'the recorded watch carries no epoch' });
  });

  test('refuses an epoch that is not an epoch, even when the record matches it', () => {
    const { root } = world(current({ epoch: 'watch_nothex' }));
    expect(ask(root, { epoch: 'watch_nothex' })).toEqual({ ok: false, why: 'this host holds no watch epoch' });
  });

  test('refuses a recorded epoch the state read door dropped as unknown', () => {
    const { root } = world(current({ epoch: 'watch_nothex' }));
    expect(ask(root)).toEqual({ ok: false, why: 'the recorded watch carries no epoch' });
  });

  test('refuses another watch\'s epoch', () => {
    const { root } = world(current());
    expect(ask(root, { epoch: `watch_${'ab'.repeat(16)}` })).toEqual({
      ok: false,
      why: 'the recorded watch is another watch\'s epoch',
    });
  });

  test('refuses another process', () => {
    const { root } = world(current({ pid: process.pid + 1 }));
    expect(ask(root)).toEqual({ ok: false, why: 'the recorded watch is another process' });
  });

  test('refuses a session the team file does not name', () => {
    const { root } = world(current());
    expect(ask(root, { session: 'other' })).toEqual({ ok: false, why: 'the session is not this team file\'s' });
  });

  test('refuses a purpose other than direct work', () => {
    const { root } = world(current());
    expect(ask(root, { purpose: 'file-read' })).toEqual({
      ok: false,
      why: 'the watch actor is admitted for direct work only',
    });
  });

  test('refuses a clock that cannot be read', () => {
    const { root } = world(current());
    expect(ask(root, { now: new Date(Number.NaN) })).toEqual({ ok: false, why: 'the clock cannot be read' });
  });

  test('refuses a heartbeat that is not a stamp', () => {
    const { root } = world(current({ heartbeat: 'yesterday' }));
    expect(ask(root)).toEqual({ ok: false, why: 'the recorded watch carries no readable heartbeat' });
  });

  test('accepts a heartbeat exactly at the liveness bound and refuses one millisecond past it', () => {
    const { root } = world(current({ heartbeat: beat(-WATCH_AUTHORITY_MAX_AGE_MS) }));
    expect(ask(root).ok).toBe(true);
    const late = world(current({ heartbeat: beat(-WATCH_AUTHORITY_MAX_AGE_MS - 1) }));
    expect(ask(late.root)).toEqual({
      ok: false,
      why: 'the recorded watch has not beaten within its liveness bound',
    });
  });

  test('accepts a heartbeat exactly at the future tolerance and refuses one millisecond past it', () => {
    const { root } = world(current({ heartbeat: beat(WATCH_AUTHORITY_FUTURE_SKEW_MS) }));
    expect(ask(root).ok).toBe(true);
    const ahead = world(current({ heartbeat: beat(WATCH_AUTHORITY_FUTURE_SKEW_MS + 1) }));
    expect(ask(ahead.root)).toEqual({
      ok: false,
      why: 'the recorded watch heartbeat is in the future',
    });
  });

  test('refuses when the session records no watch file', () => {
    const { root } = world(current(), null);
    expect(ask(root)).toEqual({ ok: false, why: 'this session records no watch file' });
  });

  test('refuses a watch file that is not this team file', () => {
    const { root } = world(current());
    const other = join(root, '.agents', 'other.yaml');
    writeFileSync(other, EXAMPLE);
    writeFileSync(
      join(root, '.agents', 'team.state.json'),
      `${JSON.stringify({
        format: 1,
        sessions: { [SESSION]: {
          seats: {}, worktrees: {}, watch: current(), watchdog: { file: other, pane: 'w1:p1' },
        } },
      }, null, 2)}\n`,
    );
    expect(ask(root)).toEqual({ ok: false, why: 'the recorded watch file is not this team file' });
  });

  test('refuses a pane that disagrees with the recorded file', () => {
    const { root } = world(current({ pane: 'w2:p1' }));
    expect(ask(root)).toEqual({
      ok: false,
      why: 'the recorded watch pane and its file disagree',
    });
  });

  test('refuses while the state lock is held, without waiting on it', () => {
    const { root } = world(current());
    let verdict: ReturnType<typeof verifyWatchAuthority> | undefined;
    const started = Date.now();
    // The test holds the same state lock the verifier must take for its snapshot; the verifier
    // makes one nonblocking attempt and refuses, so a hosted cycle's event loop is not stalled,
    // and the holder's lock file is left exactly as it is.
    withLock(join(root, '.agents'), () => {
      const lockPath = join(root, '.agents', LOCK_FILE);
      const ino = statSync(lockPath).ino;
      verdict = ask(root);
      expect(statSync(lockPath).ino).toBe(ino);
      expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(verdict).toEqual({
      ok: false,
      why: 'the session state is being written; the watch is not proven now',
    });
  });

  test('refuses a fresh lock file that has not named its holder yet, and leaves it untouched', () => {
    const { root } = world(current());
    const path = join(root, '.agents', LOCK_FILE);
    // A lock that exists with no readable pid is what a writer leaves between its open and its
    // first write. The one-attempt lock refuses it at once and must not take it over: the file,
    // its inode and its bytes stay exactly as the other writer left them.
    writeFileSync(path, '');
    const ino = statSync(path).ino;
    const started = Date.now();
    const verdict = ask(root);
    expect(Date.now() - started).toBeLessThan(500);
    expect(verdict).toEqual({
      ok: false,
      why: 'the session state is being written; the watch is not proven now',
    });
    expect(statSync(path).ino).toBe(ino);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  test('refuses a state it cannot read as an unreadable state, not as contention', () => {
    const { root } = world(current());
    const path = join(root, '.agents', STATE_FILE);
    rmSync(path);
    mkdirSync(path);
    expect(ask(root)).toEqual({
      ok: false,
      why: 'the session state cannot be read; the watch is not proven now',
    });
  });

  test('the proof binds the snapshot: a later heartbeat is a different digest', () => {
    const first = world(current({ heartbeat: beat(-2000) }));
    const second = world(current({ heartbeat: beat(-1000) }));
    const a = ask(first.root);
    const b = ask(second.root);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.proof).not.toBe(b.proof);
  });

  test('admits a record with no pane: the daemon-surviving shape', () => {
    const { root } = world(current({ pane: undefined }));
    const verdict = ask(root);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actor).toEqual({ kind: 'watch', session: SESSION });
    expect(verdict.authority.pane).toBeUndefined();
  });
});
