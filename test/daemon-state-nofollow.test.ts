// The daemon record is opened once. A symlink is not followed. A path swapped after
// that open is not what the read returns. No signal is installed.
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonStatePath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';

function record(pid: number): string {
  return `${JSON.stringify({
    format: 1,
    pid,
    uid: 1,
    since: '2026-11-06T19:00:00.000Z',
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: '2026-11-06T19:00:00.000Z',
    socket: '/tmp/daemon.sock',
    features: { broker: 'off' },
    stuck: [],
    roots: [],
  })}\n`;
}

test('a symlink is not followed, and a file swapped after the open is not read', () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-state-nofollow-'));
  try {
    const dir = join(home, '.config', 'team');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = daemonStatePath(home);
    const other = join(dir, 'other.json');
    writeFileSync(other, record(222));
    symlinkSync(other, path);
    const linked = readDaemonState(home);
    expect(linked.kind).toBe('unreadable');
    if (linked.kind === 'unreadable') expect(linked.why).toBe('the daemon state record is not a regular file');

    rmSync(path);
    writeFileSync(path, record(111));
    const swapped = readDaemonState(home, {
      afterOpen: () => {
        renameSync(path, join(dir, 'opened.json'));
        symlinkSync(other, path);
      },
    });
    expect(swapped).toMatchObject({ kind: 'ok', state: { pid: 111 } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a record over 64 KiB is refused before reading, and exactly 64 KiB is accepted', () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-state-size-'));
  try {
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    const path = daemonStatePath(home);
    writeFileSync(path, record(111).padEnd(64 * 1024, ' '));
    expect(readDaemonState(home)).toMatchObject({ kind: 'ok', state: { pid: 111 } });
    writeFileSync(path, record(222).padEnd(64 * 1024 + 1, ' '));
    let reachedRead = false;
    const oversized = readDaemonState(home, { afterOpen: () => { reachedRead = true; } });
    expect(oversized).toEqual({ kind: 'unreadable', why: 'the daemon state record exceeds 64 KiB' });
    expect(reachedRead).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('a FIFO is refused without waiting for a writer', () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-state-fifo-'));
  try {
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', [daemonStatePath(home)]);
    const module = new URL('../src/daemon/state.ts', import.meta.url).href;
    const script = `import { readDaemonState } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(readDaemonState(${JSON.stringify(home)})));`;
    // The parent remains bounded even when a regression blocks the synchronous open.
    const child = spawnSync(process.execPath, ['--no-env-file', '-e', script], { encoding: 'utf8', timeout: 2_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ kind: 'unreadable', why: 'the daemon state record is not a regular file' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
