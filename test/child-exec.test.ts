// One awaited child, bounded: the process side of every async read in the watch. These scenes
// spawn synthetic scripts only, in scratch folders outside the repository, and prove the three
// ways the child ends: a refusal (the child's own non-zero exit), the per-call deadline (killed
// with the signal that no trap can swallow), and the loop's stop (aborted, and killed too).
//
// The pid each script writes is its own before it hands the process to its long sleeper, so a
// scene that proves "the child is gone" is proving the bounded child's own pid, not a wrapper's.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CHILD_TIMEOUT_MS, execText, wasAborted, wasKilled } from '../src/child.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An executable script in its own scratch folder, printing just what it is written to print. */
function script(body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'team-child-exec-'));
  made.push(dir);
  const path = join(dir, 'child');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { path, dir };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the child');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** True once the process is gone. A live pid is deliberately not reaped here: the child's own
 *  parent (the exec call) owns the wait, and a zombie is the parent's to release. */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const LONG_SLEEPER = 'trap "" TERM\necho $$ > "$1"\nexec sleep 30';

describe('one awaited child', () => {
  test('its output is the promise value, and its environment is exactly what the caller named', async () => {
    const { path } = script('echo "value:$TEAM_CHILD_SECRET"');
    process.env.TEAM_CHILD_SECRET = 'synthetic-not-a-secret';
    try {
      expect(await execText(path, [], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } }))
        .toBe('value:\n');
    } finally {
      delete process.env.TEAM_CHILD_SECRET;
    }
    expect(DEFAULT_CHILD_TIMEOUT_MS).toBe(10_000);
  });

  test('a non-zero exit is a refusal: rejected with its status, not killed, not aborted', async () => {
    const { path } = script('exit 3');
    let error: unknown;
    try {
      await execText(path, []);
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: unknown } | null)?.code).toBe(3);
    expect(wasKilled(error)).toBe(false);
    expect(wasAborted(error)).toBe(false);
  });

  test('a child that traps TERM is killed at the deadline, and its pid is gone', async () => {
    const { path, dir } = script(LONG_SLEEPER);
    const pidfile = join(dir, 'pid');
    const pending = execText(path, [pidfile], { timeoutMs: 1500 });
    const outcome = pending.then(() => null, (caught: unknown) => caught);
    // The trap and the pid are in place before the deadline: the kill has a process to kill.
    await until(() => {
      try {
        return readFileSync(pidfile, 'utf8').trim() !== '';
      } catch {
        return false;
      }
    }, 1200);
    const error = await outcome;
    expect(wasKilled(error)).toBe(true);
    expect((error as { signal?: unknown } | null)?.signal).toBe('SIGKILL');
    expect(wasAborted(error)).toBe(false);
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await until(() => pidGone(pid));
  });

  test('a stop aborts the child and kills it too', async () => {
    const { path, dir } = script(LONG_SLEEPER);
    const pidfile = join(dir, 'pid');
    const controller = new AbortController();
    const pending = execText(path, [pidfile], { signal: controller.signal, timeoutMs: 30_000 });
    // The script is past its trap and sleeper by the time its pid file exists.
    await until(() => {
      try {
        return readFileSync(pidfile, 'utf8').trim() !== '';
      } catch {
        return false;
      }
    });
    controller.abort();
    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(wasAborted(error)).toBe(true);
    expect((error as { code?: unknown } | null)?.code).toBe('ABORT_ERR');
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    await until(() => pidGone(pid));
  });
});
