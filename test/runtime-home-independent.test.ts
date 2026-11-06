// Independent verification of runtime-home migration (`src/daemon/runtime-migration.ts`):
// 1. A symbolic link anywhere in the lobby, runtime, or kits parent chain (or at/inside a kit)
//    is refused on both forward migration and undo, with nothing moved or swept through the link.
// 2. A `migration.json` whose `from` or `to` is not the exact pinned `(lobby/<name>, kits/<name>)`
//    pair (or names an unknown kit) is refused on undo with nothing moved.
// 3. A crash mid-copy under cross-device (`EXDEV`) move, followed by a re-run, sweeps the
//    `.moving-<hex>` temp directory and leaves a complete, verified kit in both forward and undo.
// 4. Undo restores every moved kit and nested file byte-for-byte (including binary payloads and
//    file permissions) across both direct rename and cross-device copy-verify-move.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  machineConfigDir,
  runtimeDir,
  runtimeKitsDir,
  runtimeMigrationNotePath,
} from '../src/daemon/paths.ts';
import {
  LATER_KIT_FOLDERS,
  RUNTIME_KIT_FOLDERS,
  migrateRuntimeHome,
  runtimeMigrationLines,
  runtimeMigrationUndoLines,
  undoRuntimeHomeMigration,
  type RuntimeMigrationSources,
} from '../src/daemon/runtime-migration.ts';
import { lobbyDir } from '../src/lobby/gate.ts';

const NOW = new Date('2026-11-04T08:30:00.000Z');
const quietSources: RuntimeMigrationSources = {
  now: () => NOW,
  loadedPrograms: () => [],
  guardDirsNamed: () => [],
};

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeSandbox(label: string): { sandbox: string; home: string } {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), `rt-home-ind-${label}-`)));
  tempRoots.push(sandbox);
  const home = join(sandbox, 'throwaway-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { sandbox, home };
}

type FileSpec = { bytes: Buffer; mode: number };

function populateKit(
  baseDir: string,
  kitName: string,
  files: Record<string, FileSpec>,
  dirMode = 0o755,
): string {
  const kitPath = join(baseDir, kitName);
  mkdirSync(kitPath, { recursive: true, mode: dirMode });
  chmodSync(kitPath, dirMode);
  for (const [rel, spec] of Object.entries(files)) {
    const full = join(kitPath, rel);
    mkdirSync(dirname(full), { recursive: true, mode: dirMode });
    writeFileSync(full, spec.bytes);
    chmodSync(full, spec.mode);
  }
  return kitPath;
}

function snapshotTree(root: string): Map<string, { bytes: Buffer; sha256: string; mode: number }> {
  const out = new Map<string, { bytes: Buffer; sha256: string; mode: number }>();
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = prefix === '' ? entry : `${prefix}/${entry}`;
      const st = lstatSync(full);
      expect(st.isSymbolicLink()).toBe(false);
      if (st.isDirectory()) {
        visit(full, rel);
      } else {
        const bytes = readFileSync(full);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        out.set(rel, { bytes, sha256, mode: st.mode & 0o777 });
      }
    }
  };
  visit(root, '');
  return out;
}

function assertSnapshotsEqual(
  actual: Map<string, { bytes: Buffer; sha256: string; mode: number }>,
  expected: Map<string, { bytes: Buffer; sha256: string; mode: number }>,
): void {
  expect([...actual.keys()]).toEqual([...expected.keys()]);
  for (const [rel, exp] of expected.entries()) {
    const act = actual.get(rel)!;
    expect(act.sha256).toBe(exp.sha256);
    expect(Buffer.compare(act.bytes, exp.bytes)).toBe(0);
    expect(act.mode).toBe(exp.mode);
  }
}

describe('runtime-home migration independent security and recovery probes', () => {
  test('1. a link anywhere in the lobby, runtime, or kits chain is refused with nothing moved (forward and undo)', () => {
    // Subcase A: `.config` itself is a symlink to an outside directory.
    {
      const { sandbox, home } = makeSandbox('link-dot-config');
      const outsideConfig = join(sandbox, 'outside-config');
      mkdirSync(join(outsideConfig, 'team', 'lobby', 'lead-810'), { recursive: true });
      writeFileSync(join(outsideConfig, 'team', 'lobby', 'lead-810', 'a.txt'), 'keep-a\n');
      symlinkSync(outsideConfig, join(home, '.config'));

      const res = migrateRuntimeHome(home, quietSources);
      expect(res.moved).toEqual([]);
      expect(res.complete).toBe(false);
      expect(res.refused.map((r) => r.name)).toEqual(['lead-810']);
      expect(res.refused[0]!.why).toContain('is a link');
      expect(existsSync(join(outsideConfig, 'team', 'runtime'))).toBe(false);
      expect(readFileSync(join(outsideConfig, 'team', 'lobby', 'lead-810', 'a.txt'), 'utf8')).toBe('keep-a\n');
    }

    // Subcase B: `.config/team` (`machineConfigDir`) is a symlink to an outside directory.
    {
      const { sandbox, home } = makeSandbox('link-machine-dir');
      const outsideTeam = join(sandbox, 'outside-team');
      mkdirSync(join(outsideTeam, 'lobby', 'desk-810'), { recursive: true });
      writeFileSync(join(outsideTeam, 'lobby', 'desk-810', 'b.txt'), 'keep-b\n');
      mkdirSync(join(home, '.config'), { recursive: true });
      symlinkSync(outsideTeam, machineConfigDir(home));

      const res = migrateRuntimeHome(home, quietSources);
      expect(res.moved).toEqual([]);
      expect(res.complete).toBe(false);
      expect(res.refused.map((r) => r.name)).toEqual(['desk-810']);
      expect(res.refused[0]!.why).toContain('is a link');
      expect(existsSync(join(outsideTeam, 'runtime'))).toBe(false);
      expect(readFileSync(join(outsideTeam, 'lobby', 'desk-810', 'b.txt'), 'utf8')).toBe('keep-b\n');
    }

    // Subcase C: `.config/team/lobbies` (`lobbyDir`) is a symlink.
    {
      const { sandbox, home } = makeSandbox('link-lobby-dir');
      const outsideLobby = join(sandbox, 'outside-lobby');
      mkdirSync(join(outsideLobby, 'helper-810'), { recursive: true });
      writeFileSync(join(outsideLobby, 'helper-810', 'c.txt'), 'keep-c\n');
      mkdirSync(machineConfigDir(home), { recursive: true });
      symlinkSync(outsideLobby, lobbyDir(home));

      const res = migrateRuntimeHome(home, quietSources);
      expect(res.moved).toEqual([]);
      expect(res.complete).toBe(false);
      expect(res.refused.map((r) => r.name)).toEqual(['helper-810']);
      expect(res.refused[0]!.why).toContain('is a link');
      expect(existsSync(runtimeKitsDir(home))).toBe(false);
      expect(readFileSync(join(outsideLobby, 'helper-810', 'c.txt'), 'utf8')).toBe('keep-c\n');
    }

    // Subcase D: `.config/team/runtime` (`runtimeDir`) is a symlink.
    {
      const { sandbox, home } = makeSandbox('link-runtime-dir');
      populateKit(lobbyDir(home), 'front-810', {
        'run.sh': { bytes: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      });
      const outsideRuntime = join(sandbox, 'outside-runtime');
      mkdirSync(outsideRuntime, { recursive: true });
      // Plant a `.moving-` file in outsideRuntime/kits to verify `sweepTemps` is NOT called through the symlink!
      mkdirSync(join(outsideRuntime, 'kits'), { recursive: true });
      const sentinelTemp = join(outsideRuntime, 'kits', '.front-810.moving-deadbeefcafe');
      mkdirSync(sentinelTemp, { recursive: true });
      symlinkSync(outsideRuntime, runtimeDir(home));

      const res = migrateRuntimeHome(home, quietSources);
      expect(res.moved).toEqual([]);
      expect(res.complete).toBe(false);
      expect(res.refused.map((r) => r.name)).toEqual(['front-810']);
      expect(res.refused[0]!.why).toContain('is a link');
      // Neither the kit nor the sentinel temp in the symlink target was touched.
      expect(existsSync(sentinelTemp)).toBe(true);
      expect(existsSync(join(outsideRuntime, 'kits', 'front-810'))).toBe(false);
      expect(existsSync(join(lobbyDir(home), 'front-810', 'run.sh'))).toBe(true);
    }

    // Subcase E: `.config/team/runtime/kits` (`runtimeKitsDir`) is a symlink.
    {
      const { sandbox, home } = makeSandbox('link-kits-dir');
      populateKit(lobbyDir(home), 'mailbox-router', {
        'router.json': { bytes: Buffer.from('{"ok":true}\n'), mode: 0o600 },
      });
      const outsideKits = join(sandbox, 'outside-kits');
      mkdirSync(outsideKits, { recursive: true });
      mkdirSync(runtimeDir(home), { recursive: true });
      symlinkSync(outsideKits, runtimeKitsDir(home));

      const res = migrateRuntimeHome(home, quietSources);
      expect(res.moved).toEqual([]);
      expect(res.complete).toBe(false);
      expect(res.refused.map((r) => r.name)).toEqual(['mailbox-router']);
      expect(res.refused[0]!.why).toContain('is a link');
      expect(readdirSync(outsideKits)).toEqual([]);
      expect(existsSync(join(lobbyDir(home), 'mailbox-router', 'router.json'))).toBe(true);
    }

    // Subcase F: Undo also refuses when `lobbyDir` or `runtimeKitsDir` is replaced by a symlink after migration.
    {
      const { sandbox, home } = makeSandbox('link-on-undo');
      populateKit(lobbyDir(home), 'lead-810', {
        'state.json': { bytes: Buffer.from('{"v":1}\n'), mode: 0o600 },
      });
      const fwd = migrateRuntimeHome(home, quietSources);
      expect(fwd.moved).toEqual(['lead-810']);

      // Replace `lobbyDir(home)` with a symlink to `outsideLobby` containing a `.moving-` temp sentinel.
      rmSync(lobbyDir(home), { recursive: true, force: true });
      const outsideLobby = join(sandbox, 'outside-undo-lobby');
      mkdirSync(outsideLobby, { recursive: true });
      const undoSentinel = join(outsideLobby, '.lead-810.moving-123456abcdef');
      mkdirSync(undoSentinel, { recursive: true });
      symlinkSync(outsideLobby, lobbyDir(home));

      const undone = undoRuntimeHomeMigration(home, quietSources);
      expect(undone.movedBack).toEqual([]);
      expect(undone.refused.map((r) => r.name)).toEqual(['lead-810']);
      expect(undone.refused[0]!.why).toContain('is a link');
      // Sentinel in `outsideLobby` was NOT swept through the symlink, and `lead-810` remains in `runtime/kits`.
      expect(existsSync(undoSentinel)).toBe(true);
      expect(existsSync(join(outsideLobby, 'lead-810'))).toBe(false);
      expect(readFileSync(join(runtimeKitsDir(home), 'lead-810', 'state.json'), 'utf8')).toBe('{"v":1}\n');
    }
  });

  test('2. a migration.json whose from or to is not the pinned path for that kit is refused with nothing moved', () => {
    const { sandbox, home } = makeSandbox('forged-note');
    for (const name of ['lead-810', 'desk-810', 'helper-810', 'front-810', 'mailbox-router']) {
      populateKit(lobbyDir(home), name, {
        'data.txt': { bytes: Buffer.from(`payload-${name}\n`), mode: 0o600 },
      });
    }
    const fwd = migrateRuntimeHome(home, quietSources);
    expect(fwd.moved).toEqual(['lead-810', 'desk-810', 'helper-810', 'front-810', 'mailbox-router']);

    const outsideTarget = join(sandbox, 'outside-target');
    const outsideSource = join(sandbox, 'outside-source');
    mkdirSync(outsideSource, { recursive: true });
    writeFileSync(join(outsideSource, 'data.txt'), 'outside-source-bytes\n');

    // Craft a tampered `migration.json` testing 5 distinct unpinned path shapes + 1 unknown kit name:
    const forgedNote = {
      format: 1,
      moved: [
        // 1. `from` points outside the lobby:
        {
          name: 'lead-810',
          from: outsideTarget,
          to: join(runtimeKitsDir(home), 'lead-810'),
          at: NOW.toISOString(),
        },
        // 2. `to` points outside `runtime/kits`:
        {
          name: 'desk-810',
          from: join(lobbyDir(home), 'desk-810'),
          to: outsideSource,
          at: NOW.toISOString(),
        },
        // 3. `from` and `to` are swapped:
        {
          name: 'helper-810',
          from: join(runtimeKitsDir(home), 'helper-810'),
          to: join(lobbyDir(home), 'helper-810'),
          at: NOW.toISOString(),
        },
        // 4. `from` and `to` name a different valid kit (`front-810` paths under `mailbox-router` entry):
        {
          name: 'mailbox-router',
          from: join(lobbyDir(home), 'front-810'),
          to: join(runtimeKitsDir(home), 'front-810'),
          at: NOW.toISOString(),
        },
        // 5. Unnormalized `..` traversal in `from`:
        {
          name: 'front-810',
          from: `${join(lobbyDir(home), 'front-810')}/../front-810`,
          to: join(runtimeKitsDir(home), 'front-810'),
          at: NOW.toISOString(),
        },
        // 6. Unknown kit name not in `RUNTIME_KIT_FOLDERS`:
        {
          name: 'unlisted-kit',
          from: join(lobbyDir(home), 'unlisted-kit'),
          to: join(runtimeKitsDir(home), 'unlisted-kit'),
          at: NOW.toISOString(),
        },
      ],
      guardsPending: [],
    };
    writeFileSync(runtimeMigrationNotePath(home), `${JSON.stringify(forgedNote, null, 2)}\n`);

    const undone = undoRuntimeHomeMigration(home, quietSources);
    expect(undone.movedBack).toEqual([]);
    expect(undone.refused.map((r) => r.name)).toEqual([
      'lead-810',
      'desk-810',
      'helper-810',
      'front-810',
      'mailbox-router',
    ]);
    for (const r of undone.refused) {
      expect(r.why).toContain('pinned pair');
    }
    const plainLines = runtimeMigrationUndoLines(undone);
    expect(plainLines.length).toBe(5);
    expect(plainLines[0]).toContain('runtime home: refused lead-810:');

    // Nothing was moved out of `runtime/kits`, nothing was written to `lobbyDir` or `outsideTarget`,
    // and `outsideSource` was untouched.
    for (const name of ['lead-810', 'desk-810', 'helper-810', 'front-810', 'mailbox-router']) {
      expect(readFileSync(join(runtimeKitsDir(home), name, 'data.txt'), 'utf8')).toBe(`payload-${name}\n`);
      expect(existsSync(join(lobbyDir(home), name))).toBe(false);
    }
    expect(existsSync(outsideTarget)).toBe(false);
    expect(readFileSync(join(outsideSource, 'data.txt'), 'utf8')).toBe('outside-source-bytes\n');
  });

  test('3. a crash mid-copy under EXDEV, followed by a re-run, sweeps the temp and leaves a whole kit (forward and undo)', () => {
    const { home } = makeSandbox('crash-mid-copy');
    const files: Record<string, FileSpec> = {
      'alpha.json': { bytes: Buffer.from('{"step":1}\n'), mode: 0o600 },
      'bin/run.zsh': { bytes: Buffer.from('#!/bin/zsh\necho ok\n'), mode: 0o755 },
      'nested/deep/bravo.bin': { bytes: Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]), mode: 0o640 },
      'nested/charlie.txt': { bytes: Buffer.from('charlie-content\n'.repeat(50)), mode: 0o644 },
    };
    const lobbyKitPath = populateKit(lobbyDir(home), 'lead-810', files, 0o755);
    const expectedSnapshot = snapshotTree(lobbyKitPath);

    const makeExdevSources = (failOnCopyCall?: number): RuntimeMigrationSources => {
      let callCount = 0;
      return {
        ...quietSources,
        rename: (from, to) => {
          if (!from.includes('.moving-')) {
            throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
          }
          renameSync(from, to);
        },
        ...(failOnCopyCall === undefined
          ? {}
          : {
              copyFile: (from, to) => {
                callCount += 1;
                if (callCount === failOnCopyCall) {
                  // Write a partial prefix before crashing mid-copy.
                  writeFileSync(to, readFileSync(from).subarray(0, 4));
                  throw new Error('simulated power loss mid-copy');
                }
                writeFileSync(to, readFileSync(from));
              },
            }),
      };
    };

    // 1. Crash on the 3rd file during forward EXDEV migration:
    const crashedFwd = migrateRuntimeHome(home, makeExdevSources(3));
    expect(crashedFwd.moved).toEqual([]);
    expect(crashedFwd.complete).toBe(false);
    expect(crashedFwd.refused.map((r) => r.name)).toEqual(['lead-810']);
    // Source in lobby is still 100% intact; target does not exist; `.moving-` temp exists in `runtime/kits`.
    assertSnapshotsEqual(snapshotTree(lobbyKitPath), expectedSnapshot);
    expect(existsSync(join(runtimeKitsDir(home), 'lead-810'))).toBe(false);
    expect(readdirSync(runtimeKitsDir(home)).some((entry) => entry.startsWith('.lead-810.moving-'))).toBe(true);

    // 2. Re-run forward migration: sweeps `.moving-` temp, copies and verifies whole kit, removes lobby source.
    const recoveredFwd = migrateRuntimeHome(home, makeExdevSources());
    expect(recoveredFwd.moved).toEqual(['lead-810']);
    expect(recoveredFwd.refused).toEqual([]);
    expect(recoveredFwd.complete).toBe(true);
    expect(readdirSync(runtimeKitsDir(home))).toEqual(['lead-810']);
    expect(existsSync(lobbyKitPath)).toBe(false);
    const movedKitPath = join(runtimeKitsDir(home), 'lead-810');
    assertSnapshotsEqual(snapshotTree(movedKitPath), expectedSnapshot);
    // All directories in `runtime/kits/lead-810` are narrowed to 0700.
    expect(lstatSync(movedKitPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(movedKitPath, 'nested')).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(movedKitPath, 'nested', 'deep')).mode & 0o777).toBe(0o700);

    // 3. Crash on the 2nd file during undo EXDEV migration:
    const crashedUndo = undoRuntimeHomeMigration(home, makeExdevSources(2));
    expect(crashedUndo.movedBack).toEqual([]);
    expect(crashedUndo.refused.map((r) => r.name)).toEqual(['lead-810']);
    // `runtime/kits/lead-810` is still 100% intact; `lobby/lead-810` does not exist; `.moving-` temp exists in `lobby`.
    assertSnapshotsEqual(snapshotTree(movedKitPath), expectedSnapshot);
    expect(existsSync(lobbyKitPath)).toBe(false);
    expect(readdirSync(lobbyDir(home)).some((entry) => entry.startsWith('.lead-810.moving-'))).toBe(true);

    // 4. Re-run undo migration: sweeps `.moving-` temp in lobby, restores `lobby/lead-810` whole, removes `runtime/kits/lead-810`.
    const recoveredUndo = undoRuntimeHomeMigration(home, makeExdevSources());
    expect(recoveredUndo.movedBack).toEqual(['lead-810']);
    expect(recoveredUndo.refused).toEqual([]);
    expect(readdirSync(lobbyDir(home))).toEqual(['lead-810']);
    expect(existsSync(movedKitPath)).toBe(false);
    assertSnapshotsEqual(snapshotTree(lobbyKitPath), expectedSnapshot);
  });

  test('4. undo restores every moved kit and item byte-for-byte while preserving untouched later/unknown folders', () => {
    const { home } = makeSandbox('byte-for-byte-undo');

    const kitSpecs: Record<string, Record<string, FileSpec>> = {
      'lead-810': {
        'config.json': { bytes: Buffer.from('{"port":8100,"mode":"strict"}\n'), mode: 0o600 },
        'keys/pub.bin': { bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]), mode: 0o600 },
      },
      'desk-810': {
        'server.js': { bytes: Buffer.from('console.log("desk");\n'), mode: 0o755 },
        'assets/style.css': { bytes: Buffer.from('body { margin: 0; }\n'), mode: 0o644 },
      },
      'helper-810': {
        'helper.toml': { bytes: Buffer.from('[helper]\nenabled = true\n'), mode: 0o640 },
      },
      'guard-floor-helper': {
        'guard.json': { bytes: Buffer.from('{"allow":["read"]}\n'), mode: 0o600 },
      },
      'guard-pilot-wk': {
        'guard.json': { bytes: Buffer.from('{"allow":["status"]}\n'), mode: 0o600 },
      },
      'front-810': {
        'index.html': { bytes: Buffer.from('<!doctype html><title>front</title>\n'), mode: 0o644 },
      },
      'mailbox-router': {
        'routes/table.json': { bytes: Buffer.from('{"routes":[1,2,3]}\n'), mode: 0o600 },
        'bin/router': { bytes: Buffer.from('#!/bin/sh\nexit 0\n'), mode: 0o750 },
      },
    };

    expect(Object.keys(kitSpecs)).toEqual([...RUNTIME_KIT_FOLDERS]);

    const beforeSnapshots = new Map<string, Map<string, { bytes: Buffer; sha256: string; mode: number }>>();
    for (const [name, files] of Object.entries(kitSpecs)) {
      const p = populateKit(lobbyDir(home), name, files, 0o755);
      beforeSnapshots.set(name, snapshotTree(p));
    }

    // Also populate `LATER_KIT_FOLDERS` (`bridge-810`, `signer-810`) and an unknown folder (`custom-notes`).
    for (const laterName of LATER_KIT_FOLDERS) {
      populateKit(lobbyDir(home), laterName, {
        'later.txt': { bytes: Buffer.from(`later-${laterName}\n`), mode: 0o600 },
      });
    }
    populateKit(lobbyDir(home), 'custom-notes', {
      'note.md': { bytes: Buffer.from('# untouched\n'), mode: 0o644 },
    });

    // Forward migration: moves all 7 `RUNTIME_KIT_FOLDERS` in order, reports both `LATER_KIT_FOLDERS`.
    const guardLobbyPath = join(lobbyDir(home), 'guard-floor-helper');
    const sourcesBeforeReapproval: RuntimeMigrationSources = {
      ...quietSources,
      guardDirsNamed: () => [guardLobbyPath],
    };

    const fwd = migrateRuntimeHome(home, sourcesBeforeReapproval);
    expect(fwd.moved).toEqual([...RUNTIME_KIT_FOLDERS]);
    expect(fwd.later).toEqual([...LATER_KIT_FOLDERS]);
    expect(fwd.refused).toEqual([]);
    expect(fwd.guardLines).toEqual([`guard_dir: ${join(runtimeKitsDir(home), 'guard-floor-helper')}`]);
    expect(fwd.complete).toBe(false);
    expect(runtimeMigrationLines(fwd)).toContain(
      'runtime home: moved, not complete — the migration closes when team check shows the new guard path',
    );

    // Every moved kit in `runtime/kits` matches the original snapshot byte-for-byte.
    for (const name of RUNTIME_KIT_FOLDERS) {
      expect(existsSync(join(lobbyDir(home), name))).toBe(false);
      assertSnapshotsEqual(snapshotTree(join(runtimeKitsDir(home), name)), beforeSnapshots.get(name)!);
    }

    // Undo migration (before guard re-approval): moves all 7 kits back to `lobbyDir(home)` in order.
    const undone = undoRuntimeHomeMigration(home, sourcesBeforeReapproval);
    expect(undone.movedBack).toEqual([...RUNTIME_KIT_FOLDERS]);
    expect(undone.refused).toEqual([]);
    expect(undone.held).toEqual([]);
    expect(undone.guardLines).toEqual([]);

    // Verify every single restored kit in `lobbyDir(home)` is byte-for-byte and mode-for-mode identical!
    for (const name of RUNTIME_KIT_FOLDERS) {
      expect(existsSync(join(runtimeKitsDir(home), name))).toBe(false);
      assertSnapshotsEqual(snapshotTree(join(lobbyDir(home), name)), beforeSnapshots.get(name)!);
    }

    // Later and unknown folders remained untouched in `lobbyDir(home)` throughout.
    for (const laterName of LATER_KIT_FOLDERS) {
      expect(readFileSync(join(lobbyDir(home), laterName, 'later.txt'), 'utf8')).toBe(`later-${laterName}\n`);
    }
    expect(readFileSync(join(lobbyDir(home), 'custom-notes', 'note.md'), 'utf8')).toBe('# untouched\n');
  });
});
