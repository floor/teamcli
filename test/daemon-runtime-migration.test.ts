// The runtime-home migration step: kit folders move out of the machine lobby into
// runtime/kits, one folder wholly in one home or the other under every failure the step
// can still report. Fixtures only — filler bytes under synthetic names.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lobbyDir, verifyLobby } from '../src/lobby/gate.ts';
import { shippedStartupReads } from '../src/profiles/index.ts';
import { runtimeKitsDir, runtimeMigrationNotePath } from '../src/daemon/paths.ts';
import {
  migrateRuntimeHome,
  undoRuntimeHomeMigration,
  type RuntimeMigrationSources,
} from '../src/daemon/runtime-migration.ts';

let base = '';
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function homeOf(): string {
  base = mkdtempSync(join(tmpdir(), 'team-runtime-migration-'));
  return join(base, 'home');
}

function kit(home: string, name: string, files: Record<string, string>, mode = 0o700): string {
  const dir = join(lobbyDir(home), name);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, mode);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const at = (home: string, name: string) => join(runtimeKitsDir(home), name);
const NOW = new Date('2026-11-04T05:00:00Z');
const quiet: RuntimeMigrationSources = { now: () => NOW, loadedPrograms: () => [], guardDirsNamed: () => [] };

describe('the runtime-home migration', () => {
  test('moves the listed kits, narrows their folders, and leaves unknowns and later lanes', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'config.json': '{"synthetic":true}\n', 'answers/a.json': '{"n":1}\n' });
    kit(home, 'front-810', { 'deploy.zsh': '# filler\n' }, 0o755);
    chmodSync(join(lobbyDir(home), 'front-810', 'deploy.zsh'), 0o755);
    kit(home, 'bridge-810', { 'bridge.json': '{}\n' });
    kit(home, 'unknown-kit', { 'x.txt': 'mine\n' });

    const report = migrateRuntimeHome(home, quiet);
    expect(report.moved).toEqual(['lead-810', 'front-810']);
    expect(report.later).toEqual(['bridge-810']);
    expect(report.refused).toEqual([]);
    expect(report.complete).toBe(true);
    expect(readFileSync(join(at(home, 'lead-810'), 'answers/a.json'), 'utf8')).toBe('{"n":1}\n');
    expect(lstatSync(at(home, 'front-810')).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(at(home, 'front-810'), 'deploy.zsh')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(lobbyDir(home), 'lead-810'))).toBe(false);
    expect(readFileSync(join(lobbyDir(home), 'unknown-kit', 'x.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(lobbyDir(home), 'bridge-810'))).toBe(true);
    const note = JSON.parse(readFileSync(runtimeMigrationNotePath(home), 'utf8')) as { moved: { name: string }[] };
    expect(note.moved.map((entry) => entry.name)).toEqual(['lead-810', 'front-810']);

    const again = migrateRuntimeHome(home, quiet);
    expect(again.moved).toEqual([]);
    expect(again.alreadyMoved).toEqual(['lead-810', 'front-810']);
  });

  test('a folder in both homes is refused and neither copy is touched', () => {
    const home = homeOf();
    kit(home, 'desk-810', { 'a.txt': 'lobby copy\n' });
    mkdirSync(at(home, 'desk-810'), { recursive: true });
    writeFileSync(join(at(home, 'desk-810'), 'a.txt'), 'runtime copy\n');
    const report = migrateRuntimeHome(home, quiet);
    expect(report.moved).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.name).toBe('desk-810');
    expect(readFileSync(join(lobbyDir(home), 'desk-810', 'a.txt'), 'utf8')).toBe('lobby copy\n');
    expect(readFileSync(join(at(home, 'desk-810'), 'a.txt'), 'utf8')).toBe('runtime copy\n');
  });

  test('a folder a loaded unit names is held, and moves once the unit is gone', () => {
    const home = homeOf();
    const dir = kit(home, 'helper-810', { 'run.zsh': '# filler\n' });
    const heldSources: RuntimeMigrationSources = {
      ...quiet,
      loadedPrograms: () => [{ label: 'unit.helper', program: ['/bin/sh', join(dir, 'run.zsh')] }],
    };
    const held = migrateRuntimeHome(home, heldSources);
    expect(held.held).toEqual([{ name: 'helper-810', unit: 'unit.helper' }]);
    expect(existsSync(at(home, 'helper-810'))).toBe(false);
    const moved = migrateRuntimeHome(home, quiet);
    expect(moved.moved).toEqual(['helper-810']);
  });

  test('a failure on the second folder leaves the first moved and a re-run finishes', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'a\n' });
    kit(home, 'desk-810', { 'b.txt': 'b\n' });
    const failing: RuntimeMigrationSources = {
      ...quiet,
      rename: (from, to) => {
        if (from.endsWith('desk-810')) throw new Error('a made-up rename failure');
        renameSync(from, to);
      },
    };
    const first = migrateRuntimeHome(home, failing);
    expect(first.moved).toEqual(['lead-810']);
    expect(first.refused.map((one) => one.name)).toEqual(['desk-810']);
    const second = migrateRuntimeHome(home, quiet);
    expect(second.moved).toEqual(['desk-810']);
    expect(second.alreadyMoved).toEqual(['lead-810']);
    expect(readFileSync(join(at(home, 'lead-810'), 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(at(home, 'desk-810'), 'b.txt'), 'utf8')).toBe('b\n');
  });

  test('a dry run reports the plan and moves nothing', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'a\n' });
    const report = migrateRuntimeHome(home, quiet, { dryRun: true });
    expect(report.moved).toEqual(['lead-810']);
    expect(existsSync(join(lobbyDir(home), 'lead-810', 'a.txt'))).toBe(true);
    expect(existsSync(at(home, 'lead-810'))).toBe(false);
    expect(existsSync(runtimeMigrationNotePath(home))).toBe(false);
  });

  test('a link at the kit path, and a link inside a kit, are refused and never followed', () => {
    const home = homeOf();
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'outside\n');
    mkdirSync(lobbyDir(home), { recursive: true });
    symlinkSync(outside, join(lobbyDir(home), 'lead-810'));
    const desk = kit(home, 'desk-810', { 'a.txt': 'a\n' });
    symlinkSync(join(outside, 'keep.txt'), join(desk, 'linked.txt'));

    const report = migrateRuntimeHome(home, quiet);
    expect(report.moved).toEqual([]);
    expect(report.refused.map((one) => one.name).sort()).toEqual(['desk-810', 'lead-810']);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside\n');
    expect(existsSync(at(home, 'desk-810'))).toBe(false);
  });

  test('the cross-device path copies to a temp, verifies, and only then removes the source', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'alpha\n', 'sub/b.bin': 'bravo\n' });
    let direct = 0;
    const exdev: RuntimeMigrationSources = {
      ...quiet,
      rename: (from, to) => {
        if (!from.includes('.moving-')) {
          direct += 1;
          throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        }
        renameSync(from, to);
      },
    };
    const report = migrateRuntimeHome(home, exdev);
    expect(direct).toBe(1);
    expect(report.moved).toEqual(['lead-810']);
    expect(readFileSync(join(at(home, 'lead-810'), 'sub/b.bin'), 'utf8')).toBe('bravo\n');
    expect(existsSync(join(lobbyDir(home), 'lead-810'))).toBe(false);
    expect(readdirSync(runtimeKitsDir(home)).some((name) => name.includes('.moving-'))).toBe(false);
  });

  test('a copy that does not verify keeps the source, and a mid-copy crash is swept on re-run', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' });
    const exdev = (copyFile: RuntimeMigrationSources['copyFile']): RuntimeMigrationSources => ({
      ...quiet,
      rename: (from, to) => {
        if (!from.includes('.moving-')) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        renameSync(from, to);
      },
      ...(copyFile === undefined ? {} : { copyFile }),
    });

    const corrupt = migrateRuntimeHome(home, exdev((from, to) => writeFileSync(to, 'tampered\n')));
    expect(corrupt.moved).toEqual([]);
    expect(corrupt.refused).toHaveLength(1);
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(existsSync(at(home, 'lead-810'))).toBe(false);

    let copies = 0;
    const crashing = migrateRuntimeHome(home, exdev((from, to) => {
      copies += 1;
      if (copies > 1) throw new Error('a made-up mid-copy death');
      writeFileSync(to, readFileSync(from));
    }));
    expect(crashing.moved).toEqual([]);
    expect(existsSync(join(lobbyDir(home), 'lead-810', 'b.txt'))).toBe(true);
    expect(existsSync(at(home, 'lead-810'))).toBe(false);
    expect(readdirSync(runtimeKitsDir(home)).some((name) => name.includes('.moving-'))).toBe(true);

    const finished = migrateRuntimeHome(home, exdev(undefined));
    expect(finished.moved).toEqual(['lead-810']);
    expect(readdirSync(runtimeKitsDir(home)).some((name) => name.includes('.moving-'))).toBe(false);
    expect(readFileSync(join(at(home, 'lead-810'), 'b.txt'), 'utf8')).toBe('bravo\n');
  });

  test('a moved guard prints its replacement line and stays incomplete until the new path is named', () => {
    const home = homeOf();
    const dir = kit(home, 'guard-floor-helper', { 'guard.json': '{}\n' });
    const before: RuntimeMigrationSources = { ...quiet, guardDirsNamed: () => [dir] };
    const report = migrateRuntimeHome(home, before);
    expect(report.moved).toEqual(['guard-floor-helper']);
    expect(report.guardLines).toEqual([`guard_dir: ${at(home, 'guard-floor-helper')}`]);
    expect(report.complete).toBe(false);

    const after: RuntimeMigrationSources = { ...quiet, guardDirsNamed: () => [at(home, 'guard-floor-helper')] };
    const closed = migrateRuntimeHome(home, after);
    expect(closed.alreadyMoved).toEqual(['guard-floor-helper']);
    expect(closed.guardLines).toEqual([]);
    expect(closed.complete).toBe(true);
  });

  test('the lobby gate passes once the kits have moved out', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'CLAUDE.md': '# filler\n' });
    chmodSync(lobbyDir(home), 0o700);
    const blocked = verifyLobby(home, { reads: shippedStartupReads() });
    expect(blocked.ok).toBe(false);

    const report = migrateRuntimeHome(home, quiet);
    expect(report.moved).toEqual(['lead-810']);
    const gate = verifyLobby(home, { reads: shippedStartupReads() });
    expect(gate.ok).toBe(true);
  });

  test('undo before the guard re-approval renames every moved folder back', () => {
    const home = homeOf();
    const guardDir = kit(home, 'guard-floor-helper', { 'guard.json': '{}\n' });
    kit(home, 'lead-810', { 'a.txt': 'alpha\n' });
    const before: RuntimeMigrationSources = { ...quiet, guardDirsNamed: () => [guardDir] };
    migrateRuntimeHome(home, before);

    const undone = undoRuntimeHomeMigration(home, before);
    expect(undone.movedBack).toEqual(['lead-810', 'guard-floor-helper']);
    expect(undone.refused).toEqual([]);
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(join(guardDir, 'guard.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(at(home, 'lead-810'))).toBe(false);
    const note = JSON.parse(readFileSync(runtimeMigrationNotePath(home), 'utf8')) as { moved: unknown[]; guardsPending: unknown[] };
    expect(note.moved).toEqual([]);
    expect(note.guardsPending).toEqual([]);

    const again = undoRuntimeHomeMigration(home, before);
    expect(again.movedBack).toEqual([]);
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  test('undo after the guard re-approval refuses the guard and names the state', () => {
    const home = homeOf();
    const guardDir = kit(home, 'guard-floor-helper', { 'guard.json': '{}\n' });
    kit(home, 'lead-810', { 'a.txt': 'alpha\n' });
    migrateRuntimeHome(home, { ...quiet, guardDirsNamed: () => [guardDir] });

    const landed: RuntimeMigrationSources = { ...quiet, guardDirsNamed: () => [at(home, 'guard-floor-helper')] };
    const undone = undoRuntimeHomeMigration(home, landed);
    expect(undone.movedBack).toEqual(['lead-810']);
    expect(undone.refused).toHaveLength(1);
    expect(undone.refused[0]!.name).toBe('guard-floor-helper');
    expect(undone.refused[0]!.why).toContain('re-approval landed');
    expect(undone.guardLines).toEqual([`guard_dir: ${guardDir}`]);
    expect(readFileSync(join(at(home, 'guard-floor-helper'), 'guard.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(lobbyDir(home), 'guard-floor-helper'))).toBe(false);
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  test('undo refuses a folder standing in both homes, and a dry run moves nothing back', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'alpha\n' });
    kit(home, 'desk-810', { 'b.txt': 'bravo\n' });
    migrateRuntimeHome(home, quiet);
    mkdirSync(join(lobbyDir(home), 'lead-810'), { recursive: true });
    writeFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'other copy\n');

    const dry = undoRuntimeHomeMigration(home, quiet, { dryRun: true });
    expect(dry.movedBack).toEqual(['desk-810']);
    expect(existsSync(at(home, 'desk-810'))).toBe(true);

    const undone = undoRuntimeHomeMigration(home, quiet);
    expect(undone.movedBack).toEqual(['desk-810']);
    expect(undone.refused.map((one) => one.name)).toEqual(['lead-810']);
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'utf8')).toBe('other copy\n');
    expect(readFileSync(join(at(home, 'lead-810'), 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(join(lobbyDir(home), 'desk-810', 'b.txt'), 'utf8')).toBe('bravo\n');
  });

  test('a link anywhere in the parent chain refuses the whole step, and nothing moves', () => {
    // The lobby itself is a link into an outside folder.
    const home = homeOf();
    const outside = join(base, 'outside-lobby');
    mkdirSync(join(outside, 'lead-810'), { recursive: true });
    writeFileSync(join(outside, 'lead-810', 'a.txt'), 'alpha\n');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    symlinkSync(outside, lobbyDir(home));
    const report = migrateRuntimeHome(home, quiet);
    expect(report.moved).toEqual([]);
    expect(report.refused.map((one) => one.name)).toEqual(['lead-810']);
    expect(report.refused[0]!.why).toContain('link');
    expect(readFileSync(join(outside, 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(existsSync(at(home, 'lead-810'))).toBe(false);

    // runtime/kits is a link into an outside folder.
    const home2 = homeOf();
    kit(home2, 'lead-810', { 'a.txt': 'alpha\n' });
    const outsideKits = join(base, 'outside-kits');
    mkdirSync(outsideKits, { recursive: true });
    mkdirSync(join(home2, '.config', 'team', 'runtime'), { recursive: true });
    symlinkSync(outsideKits, runtimeKitsDir(home2));
    const report2 = migrateRuntimeHome(home2, quiet);
    expect(report2.moved).toEqual([]);
    expect(report2.refused.map((one) => one.name)).toEqual(['lead-810']);
    expect(readFileSync(join(lobbyDir(home2), 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(readdirSync(outsideKits)).toEqual([]);
  });

  test('a folder owned by another user refuses the step', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'alpha\n' });
    const otherUser: RuntimeMigrationSources = { ...quiet, uid: () => lstatSync(lobbyDir(home)).uid + 1 };
    const report = migrateRuntimeHome(home, otherUser);
    expect(report.moved).toEqual([]);
    expect(report.refused.map((one) => one.name)).toEqual(['lead-810']);
    expect(report.refused[0]!.why).toContain('another user');
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(existsSync(at(home, 'lead-810'))).toBe(false);
  });

  test('undo refuses a note entry naming any path but the pinned pair, and moves nothing', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'alpha\n' });
    migrateRuntimeHome(home, quiet);
    const forged = JSON.parse(readFileSync(runtimeMigrationNotePath(home), 'utf8')) as { moved: { name: string; from: string; to: string }[] };
    const outside = join(base, 'elsewhere');
    forged.moved[0]!.from = outside;
    writeFileSync(runtimeMigrationNotePath(home), `${JSON.stringify(forged)}\n`);
    const undone = undoRuntimeHomeMigration(home, quiet);
    expect(undone.movedBack).toEqual([]);
    expect(undone.refused.map((one) => one.name)).toEqual(['lead-810']);
    expect(undone.refused[0]!.why).toContain('pinned');
    expect(readFileSync(join(at(home, 'lead-810'), 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(lobbyDir(home), 'lead-810'))).toBe(false);
  });

  test('an undo copy that dies mid-way is swept from the lobby on re-run', () => {
    const home = homeOf();
    kit(home, 'lead-810', { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' });
    migrateRuntimeHome(home, quiet);
    const exdev = (copyFile: RuntimeMigrationSources['copyFile']): RuntimeMigrationSources => ({
      ...quiet,
      rename: (from, to) => {
        if (!from.includes('.moving-')) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        renameSync(from, to);
      },
      ...(copyFile === undefined ? {} : { copyFile }),
    });
    let copies = 0;
    const crashing = undoRuntimeHomeMigration(home, exdev((from, to) => {
      copies += 1;
      if (copies > 1) throw new Error('a made-up mid-copy death');
      writeFileSync(to, readFileSync(from));
    }));
    expect(crashing.movedBack).toEqual([]);
    expect(readdirSync(lobbyDir(home)).some((name) => name.includes('.moving-'))).toBe(true);
    expect(existsSync(join(lobbyDir(home), 'lead-810'))).toBe(false);

    const finished = undoRuntimeHomeMigration(home, exdev(undefined));
    expect(finished.movedBack).toEqual(['lead-810']);
    expect(readdirSync(lobbyDir(home)).some((name) => name.includes('.moving-'))).toBe(false);
    expect(readFileSync(join(lobbyDir(home), 'lead-810', 'b.txt'), 'utf8')).toBe('bravo\n');
    expect(existsSync(at(home, 'lead-810'))).toBe(false);
  });
});
