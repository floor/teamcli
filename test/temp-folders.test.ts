// The doctor row that compares the daemon's temp folder with the seats': a Claude Code seat's
// session socket sits under its own temp folder, and the daemon looks under its own alone. Every
// folder here is a fixture or a string; no scene reads the machine's daemon.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempFolderFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { readDaemonState, serializeDaemonState, type DaemonState } from '../src/daemon/state.ts';
import { SERVER_ENVIRONMENT } from '../src/launch/plan.ts';
import { paneTempDir, sameTempFolder, tempDirOf, tempFolderRow, TEMP_VARIABLES } from '../src/temp-folders.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

const same = (a: string, b: string): boolean => a === b;

describe('the temp folder a process answers', () => {
  test('the first temp variable set wins, its trailing separator dropped; none set is /tmp', () => {
    expect(tempDirOf({})).toBe('/tmp');
    expect(tempDirOf({ TMPDIR: '/run/user/1000/' })).toBe('/run/user/1000');
    expect(tempDirOf({ TMPDIR: '', TMP: '/var/tmp' })).toBe('/var/tmp');
    expect(tempDirOf({ TEMP: '/scratch', TMP: '/var/tmp' })).toBe('/var/tmp');
    expect(tempDirOf({ TMPDIR: '/' })).toBe('/');
  });

  test('a pane `team up` starts names no temp folder, so a seat answers the default', () => {
    for (const name of TEMP_VARIABLES) expect(SERVER_ENVIRONMENT as readonly string[]).not.toContain(name);
    expect(paneTempDir()).toBe('/tmp');
  });

  test('two spellings of one folder are one folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'temp-same-'));
    made.push(root);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(sameTempFolder(join(root, 'link'), join(root, 'real'))).toBe(true);
    expect(sameTempFolder(join(root, 'real'), join(root, 'other'))).toBe(false);
  });
});

describe('the row', () => {
  test('no running daemon reports nothing', () => {
    expect(tempFolderRow({ daemon: { kind: 'none' }, same })).toBeNull();
  });

  test('a daemon whose record names no folder is a note, never a warning', () => {
    const row = tempFolderRow({ daemon: { kind: 'unrecorded' }, same });
    expect(row?.level).toBe('note');
    expect(row?.text).toContain('`team daemon restart` records it');
  });

  test('one folder is ok', () => {
    expect(tempFolderRow({ daemon: { kind: 'recorded', dir: '/tmp' }, same })).toEqual({
      level: 'ok',
      text: 'the daemon and the seats keep their temporary files in one folder (/tmp)',
    });
  });

  test('two folders warn, naming both, the socket folder the daemon reads, and where the seats\' was read', () => {
    const row = tempFolderRow({ daemon: { kind: 'recorded', dir: '/home/owner/tmp' }, same });
    expect(row?.level).toBe('warn');
    expect(row?.text).toBe(
      "the daemon's temp folder (/home/owner/tmp) is not the seats' (/tmp, the folder a pane started by `team up` gets): " +
      "the daemon looks for a Claude Code seat's session socket in /home/owner/tmp/cc-socks only, so a send it carries " +
      "reaches such a seat by a later leg; give the daemon and the terminal host's server the same temp folder",
    );
    const measured = tempFolderRow({ daemon: { kind: 'recorded', dir: '/tmp' }, measured: '/run/user/1000', same });
    expect(measured?.level).toBe('warn');
    expect(measured?.text).toContain("not the seats' (/run/user/1000, read in this pane)");
  });

  test('the row names no system facility', () => {
    const row = tempFolderRow({ daemon: { kind: 'recorded', dir: '/a' }, same });
    expect(row?.text).not.toMatch(/systemd|launchd|herdr|tmux|TMPDIR/);
  });
});

describe('doctor reads the row', () => {
  function sources(daemon: DoctorSources['daemonTempDir'], own = '/run/user/1000'): DoctorSources {
    return {
      version: () => null, onPath: () => false, loggedIn: () => null, herdrVersion: () => null,
      sessionRunning: () => null, now: () => new Date(0), home: '/home/owner',
      ...(daemon === undefined ? {} : { daemonTempDir: daemon }),
      ownTempDir: () => own,
    };
  }

  test('in a seat\'s pane the seats\' folder is this process\'s own; elsewhere it is a pane\'s default', () => {
    const recorded = () => ({ kind: 'recorded' as const, dir: '/tmp' });
    const inSeat = tempFolderFindings(sources(recorded), { kind: 'seat', name: 'lead', pane: 'w1:p1' });
    expect(inSeat).toHaveLength(1);
    expect(inSeat[0]?.level).toBe('warn');
    expect(inSeat[0]?.text).toContain('(/run/user/1000, read in this pane)');
    const inPane = tempFolderFindings(sources(recorded), { kind: 'pane', pane: 'w1:p2' });
    expect(inPane[0]?.text).toContain('read in this pane');
    const owner = tempFolderFindings(sources(recorded), { kind: 'owner' });
    expect(owner[0]?.level).toBe('ok');
  });

  test('a source that does not read the daemon reports no row', () => {
    expect(tempFolderFindings(sources(undefined), { kind: 'owner' })).toEqual([]);
    expect(tempFolderFindings(sources(() => ({ kind: 'none' })), { kind: 'owner' })).toEqual([]);
  });
});

describe('the state record keeps the daemon\'s temp folder', () => {
  const state: DaemonState = {
    format: 1, pid: 4321, uid: 1000, since: '2026-11-14T00:00:00.000Z', startedBy: 'service-manager',
    version: '0.5.22', heartbeatAt: '2026-11-14T00:00:01.000Z', socket: '/home/owner/.config/team/daemon.sock',
    features: { broker: 'absent' }, stuck: [], roots: [],
  };
  function written(extra: Record<string, unknown>): ReturnType<typeof readDaemonState> {
    const home = mkdtempSync(join(tmpdir(), 'temp-home-'));
    made.push(home);
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'daemon.state.json'), JSON.stringify({ ...JSON.parse(serializeDaemonState(state)), ...extra }));
    return readDaemonState(home);
  }

  test('an absolute folder reads back; a relative or missing one is left out', () => {
    const read = written({ tempDir: '/tmp' });
    expect(read.kind === 'ok' ? read.state.tempDir : null).toBe('/tmp');
    for (const tempDir of ['tmp', '', 42, undefined]) {
      const other = written(tempDir === undefined ? {} : { tempDir });
      expect(other.kind).toBe('ok');
      expect(other.kind === 'ok' && 'tempDir' in other.state).toBe(false);
    }
  });
});
