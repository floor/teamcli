// The daemon record is opened once. A symlink is not followed. A path swapped after
// that open is not what the read returns. No signal is installed.
import { expect, test } from 'bun:test';
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
