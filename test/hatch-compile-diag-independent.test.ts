import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeFolderChain, readSealedRelative, readThrough } from '../src/bus/relative-read.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';

const COMPILE_TIMEOUT_MS = 30_000;

let tempBaseDir: string | null = null;
let tempBuildDir: string | null = null;
const cleanupDirs: string[] = [];

function makeFixtureWorld(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hatch-node-ind-')));
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents', 'send-drops', 'acme', 'iris'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, root, home };
}

function makePayload(root: string, id: string, from = 'lead'): RecordPayload {
  return {
    kind: 'message',
    id,
    to: 'iris',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-04T00:00:00.000Z',
    body: `body-${id}`,
    from,
    from_id: null,
    rule: 'fixture-rule',
    thread: id,
  };
}

describe('node build compilation and Bun/Node relative-read parity (independent verification)', () => {
  beforeAll(() => {
    tempBaseDir = mkdtempSync(resolve(tmpdir(), 'hatch-ind-build-'));
    copyFileSync(resolve(process.cwd(), 'package.json'), resolve(tempBaseDir, 'package.json'));
    tempBuildDir = resolve(tempBaseDir, 'dist');
    const tsc = spawnSync(
      'bun',
      ['run', 'tsc', '-p', 'tsconfig.build.json', '--outDir', tempBuildDir],
      { timeout: COMPILE_TIMEOUT_MS },
    );
    if (tsc.status !== 0 || tsc.error) {
      const stderr = tsc.stderr?.toString().trim() ?? '';
      const stdout = tsc.stdout?.toString().trim() ?? '';
      throw new Error(
        `tsconfig.build.json compile failed (status=${tsc.status}):\nstderr:\n${stderr}\nstdout:\n${stdout}`,
      );
    }
    mkdirSync(resolve(tempBuildDir, 'profiles'), { recursive: true });
    for (const name of readdirSync(resolve(process.cwd(), 'src/profiles'))) {
      if (name.endsWith('.yaml') || name.endsWith('.json')) {
        copyFileSync(
          resolve(process.cwd(), 'src/profiles', name),
          resolve(tempBuildDir, 'profiles', name),
        );
      }
    }
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    if (tempBaseDir) {
      rmSync(tempBaseDir, { recursive: true, force: true });
      tempBaseDir = null;
      tempBuildDir = null;
    }
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tsconfig.build.json compiles cleanly without bun:ffi type errors and emits bus/relative-read.js and watch/screen-file.js', () => {
    expect(tempBuildDir).not.toBeNull();
    expect(existsSync(resolve(tempBuildDir!, 'bus/relative-read.js'))).toBe(true);
    expect(existsSync(resolve(tempBuildDir!, 'bus/arrival.js'))).toBe(true);
    expect(existsSync(resolve(tempBuildDir!, 'watch/screen-file.js'))).toBe(true);
  });

  test('compiled bus/relative-read.js executes under the real node runtime and matches Bun FFI and nodeFolderChain across valid, missing, and all refusal cases', () => {
    const { base, root, home } = makeFixtureWorld();
    const folders = ['.agents', 'send-drops', 'acme', 'iris'] as const;

    // 1. Valid signed record
    const validId = 'rec-valid';
    writeFileSync(
      join(root, ...folders, validId),
      JSON.stringify(signRecord(makePayload(root, validId), home)),
    );

    // 2. Symlinked leaf record
    const externalTarget = join(base, 'external-record.json');
    writeFileSync(
      externalTarget,
      JSON.stringify(signRecord(makePayload(root, 'rec-symlink-leaf', 'stranger'), home)),
    );
    symlinkSync(externalTarget, join(root, ...folders, 'rec-symlink-leaf'));

    // 3. Directory at leaf path
    mkdirSync(join(root, ...folders, 'rec-dir-leaf'));

    // 4. Non-JSON file at leaf path
    writeFileSync(join(root, ...folders, 'rec-bad-json'), '{not-valid-json');

    // 5. Valid JSON but not a signed record envelope
    writeFileSync(join(root, ...folders, 'rec-unsigned-json'), JSON.stringify({ hello: 'world' }));

    // 6. Symlinked intermediate folder
    const externalFolder = join(base, 'external-dir');
    mkdirSync(externalFolder, { recursive: true });
    writeFileSync(
      join(externalFolder, 'rec-behind-link'),
      JSON.stringify(signRecord(makePayload(root, 'rec-behind-link', 'stranger'), home)),
    );
    symlinkSync(externalFolder, join(root, '.agents', 'send-drops', 'acme', 'linked-seat'));

    // 7. Regular file in place of an intermediate folder (ENOTDIR)
    writeFileSync(join(root, '.agents', 'send-drops', 'acme', 'file-not-dir'), 'plain-file');

    type ProbeSpec = {
      label: string;
      rootPath: string;
      folders: readonly string[];
      name: string;
    };

    const probes: ProbeSpec[] = [
      { label: 'valid signed record', rootPath: root, folders, name: validId },
      { label: 'missing leaf record', rootPath: root, folders, name: 'no-such-record' },
      {
        label: 'missing intermediate folder',
        rootPath: root,
        folders: ['.agents', 'send-drops', 'no-such-session', 'iris'],
        name: validId,
      },
      { label: 'symlinked leaf record', rootPath: root, folders, name: 'rec-symlink-leaf' },
      {
        label: 'symlinked intermediate folder',
        rootPath: root,
        folders: ['.agents', 'send-drops', 'acme', 'linked-seat'],
        name: 'rec-behind-link',
      },
      {
        label: 'regular file as intermediate folder (ENOTDIR)',
        rootPath: root,
        folders: ['.agents', 'send-drops', 'acme', 'file-not-dir'],
        name: 'child-rec',
      },
      { label: 'directory at leaf path', rootPath: root, folders, name: 'rec-dir-leaf' },
      { label: 'non-JSON leaf file', rootPath: root, folders, name: 'rec-bad-json' },
      { label: 'unsigned JSON leaf file', rootPath: root, folders, name: 'rec-unsigned-json' },
      { label: 'empty segment name', rootPath: root, folders, name: '' },
      { label: 'dot segment', rootPath: root, folders, name: '.' },
      { label: 'dot-dot traversal segment', rootPath: root, folders, name: '..' },
      { label: 'slash in segment', rootPath: root, folders, name: 'sub/rec' },
      { label: 'NUL byte in segment', rootPath: root, folders, name: 'rec\0bad' },
      {
        label: 'dot-dot in intermediate folder segment',
        rootPath: root,
        folders: ['.agents', '..', 'acme', 'iris'],
        name: validId,
      },
      {
        label: 'non-existent root directory',
        rootPath: join(base, 'no-such-root'),
        folders,
        name: validId,
      },
    ];

    // Run all probes in Bun via `readSealedRelative` (which uses `bunChain` / `openat`) and via `nodeFolderChain`
    const bunResults = probes.map((p) => readSealedRelative(p.rootPath, p.folders, p.name));
    const nodeChainResults = probes.map((p) =>
      readThrough(nodeFolderChain(p.rootPath), p.rootPath, p.folders, p.name),
    );

    // Run all probes in a real Node.js subprocess importing the compiled `bus/relative-read.js`
    const builtModuleUrl = pathToFileURL(resolve(tempBuildDir!, 'bus/relative-read.js')).href;
    const nodeScript = `
      import { readSealedRelative } from ${JSON.stringify(builtModuleUrl)};
      const probes = ${JSON.stringify(probes)};
      if (process.versions.bun !== undefined) {
        throw new Error('Expected real Node.js runtime without process.versions.bun');
      }
      const results = probes.map((p) => readSealedRelative(p.rootPath, p.folders, p.name));
      process.stdout.write(JSON.stringify(results));
    `;
    const nodeRun = spawnSync('node', ['--input-type=module', '-e', nodeScript], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(nodeRun.stderr).toBe('');
    expect(nodeRun.status).toBe(0);
    const nodeSubprocessResults = JSON.parse(nodeRun.stdout) as typeof bunResults;

    // Verify exact parity across Bun FFI, nodeFolderChain, and real Node.js subprocess
    expect(nodeChainResults).toEqual(bunResults);
    expect(nodeSubprocessResults).toEqual(bunResults);

    // Verify the exact refusal words on every failure probe
    expect(bunResults[0]?.ok).toBe(true);
    expect(bunResults[1]).toEqual({ ok: true, sealed: null });
    expect(bunResults[2]).toEqual({ ok: true, sealed: null });
    expect(bunResults[3]).toEqual({ ok: false, reason: 'a symbolic link was found and not followed' });
    expect(bunResults[4]).toEqual({ ok: false, reason: 'a symbolic link was found and not followed' });
    expect(bunResults[5]).toEqual({ ok: false, reason: 'a symbolic link was found and not followed' });
    expect(bunResults[6]).toEqual({ ok: false, reason: 'the record is not a regular file' });
    expect(bunResults[7]).toEqual({ ok: false, reason: 'the record is not JSON' });
    expect(bunResults[8]).toEqual({ ok: false, reason: 'the record is not a signed record' });
    for (let i = 9; i < probes.length; i++) {
      expect(bunResults[i]).toEqual({ ok: false, reason: 'the record could not be read' });
    }

    // Cleanup the symlinked leaf so nothing dangles
    unlinkSync(join(root, ...folders, 'rec-symlink-leaf'));
  });
});
