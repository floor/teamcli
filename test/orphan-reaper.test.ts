// The reaper a closed pane's orphans are handed to besides pid 1: recorded once at the daemon's
// start, only when the system's service manager started it and names itself its parent, and
// trusted afterwards only while the same process holds that pid. Every table here is a fixture.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxProcessStart, orphanReapers, recordedReapers, serviceReaperAtStart } from '../src/orphan-reaper.ts';
import { readDaemonState, serializeDaemonState, type DaemonState } from '../src/daemon/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

function procTable(rows: Record<number, string>): string {
  const proc = mkdtempSync(join(tmpdir(), 'reaper-proc-'));
  made.push(proc);
  for (const [pid, stat] of Object.entries(rows)) {
    mkdirSync(join(proc, pid));
    writeFileSync(join(proc, pid, 'stat'), stat);
  }
  return proc;
}

// A `/proc/<pid>/stat` line: the name, the state, then fields 4 to 22; the start is field 22.
const statLine = (pid: number, name: string, start: number): string =>
  `${pid} (${name}) S 1 ${pid} ${pid} 0 -1 4194560 2741 30552 0 6 21 9 53 25 20 0 1 0 ${start} 22327296 2788 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0\n`;

describe('a process start from the system table', () => {
  test('field 22 is read after the name, whatever the name holds', () => {
    const proc = procTable({ 1116: statLine(1116, 'systemd', 812), 77: statLine(77, 'a (b) c', 4242) });
    expect(linuxProcessStart(1116, proc)).toBe(812);
    expect(linuxProcessStart(77, proc)).toBe(4242);
    expect(linuxProcessStart(78, proc)).toBeNull();
    expect(linuxProcessStart(0, proc)).toBeNull();
  });

  test('a line that does not read gives no start', () => {
    const proc = procTable({ 5: '5 (short) S 1\n', 6: 'no parentheses here\n' });
    expect(linuxProcessStart(5, proc)).toBeNull();
    expect(linuxProcessStart(6, proc)).toBeNull();
  });
});

describe('the reaper recorded at the daemon\'s start', () => {
  const base = { platform: 'linux' as const, startedBy: 'service-manager', ppid: 1116, managerPid: '1116', startOf: () => 812 };

  test('the service manager that started the daemon and names itself its parent is recorded with its start', () => {
    expect(serviceReaperAtStart(base)).toEqual({ pid: 1116, start: 812 });
  });

  test('every other start records none', () => {
    expect(serviceReaperAtStart({ ...base, platform: 'darwin' })).toBeNull();
    expect(serviceReaperAtStart({ ...base, startedBy: 'manual' })).toBeNull();
    expect(serviceReaperAtStart({ ...base, startedBy: 'team-up' })).toBeNull();
    expect(serviceReaperAtStart({ ...base, managerPid: undefined })).toBeNull();
    expect(serviceReaperAtStart({ ...base, managerPid: '999' })).toBeNull();
    expect(serviceReaperAtStart({ ...base, ppid: 1, managerPid: '1' })).toBeNull();
    expect(serviceReaperAtStart({ ...base, startOf: () => null })).toBeNull();
  });
});

describe('the reaper a later close trusts', () => {
  test('only while the process at the pid is still the recorded one', () => {
    const reaper = { pid: 1116, start: 812 };
    expect(recordedReapers({ platform: 'linux', reaper, startOf: () => 812 })).toEqual([1116]);
    expect(recordedReapers({ platform: 'linux', reaper, startOf: () => 9000 })).toEqual([]);
    expect(recordedReapers({ platform: 'linux', reaper, startOf: () => null })).toEqual([]);
    expect(recordedReapers({ platform: 'linux', reaper: undefined, startOf: () => 812 })).toEqual([]);
  });

  test('on macOS the list is empty whatever a record says: an orphan goes to pid 1 alone', () => {
    expect(recordedReapers({ platform: 'darwin', reaper: { pid: 1116, start: 812 }, startOf: () => 812 })).toEqual([]);
  });
});

describe('the state record keeps the reaper', () => {
  const state: DaemonState = {
    format: 1, pid: 4321, uid: 1000, since: '2026-11-14T00:00:00.000Z', startedBy: 'service-manager',
    version: '0.5.22', heartbeatAt: '2026-11-14T00:00:01.000Z', socket: '/home/owner/.config/team/daemon.sock',
    features: { broker: 'absent' }, stuck: [], roots: [],
  };
  function written(extra: Record<string, unknown>): ReturnType<typeof readDaemonState> {
    const home = mkdtempSync(join(tmpdir(), 'reaper-home-'));
    made.push(home);
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'team', 'daemon.state.json'),
      JSON.stringify({ ...JSON.parse(serializeDaemonState(state)), ...extra }),
    );
    return readDaemonState(home);
  }

  test('a recorded reaper reads back; an older record has none', () => {
    const read = written({ reaper: { pid: 1116, start: 812 } });
    expect(read.kind === 'ok' ? read.state.reaper : null).toEqual({ pid: 1116, start: 812 });
    const older = written({});
    expect(older.kind).toBe('ok');
    expect(older.kind === 'ok' && 'reaper' in older.state).toBe(false);
  });

  // The close reads the record itself; on Linux it trusts this test's own process as the reaper
  // only while the start it holds is this process's own.
  test.skipIf(process.platform !== 'linux')('a close reads the recorded reaper while it is the same process', () => {
    const home = mkdtempSync(join(tmpdir(), 'reaper-close-'));
    made.push(home);
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const file = join(home, '.config', 'team', 'daemon.state.json');
    const start = linuxProcessStart(process.pid);
    expect(start).not.toBeNull();
    writeFileSync(file, JSON.stringify({ ...JSON.parse(serializeDaemonState(state)), reaper: { pid: process.pid, start } }));
    expect(orphanReapers(home)).toEqual([process.pid]);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(serializeDaemonState(state)), reaper: { pid: process.pid, start: (start ?? 0) + 1 } }));
    expect(orphanReapers(home)).toEqual([]);
    writeFileSync(file, 'not json');
    expect(orphanReapers(home)).toEqual([]);
  });

  test('a malformed reaper is left out and the record still reads', () => {
    for (const reaper of [{ pid: 1, start: 812 }, { pid: 'x', start: 812 }, { pid: 1116 }, { pid: 1116, start: -1 }, 'reaper', null]) {
      const read = written({ reaper });
      expect(read.kind, JSON.stringify(reaper)).toBe('ok');
      expect(read.kind === 'ok' && 'reaper' in read.state, JSON.stringify(reaper)).toBe(false);
    }
  });
});
