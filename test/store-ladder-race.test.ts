// STORE-LADDER-RACE coverage: several writers beginning in a brand-new empty home race to create the
// state folder ladder. Exactly one process can win each `mkdir`; every other process must accept
// the winner's folder as ready, not fail with "the state folder could not be created". The
// spawn-per-writer with one shared start instant follows test/bus-log-concurrent-seq.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { createDir0700, ensureFoldersBelow, ensureStoreLadder, historyPath } from '../src/send/history.ts';
import { nativeNonceOf, pendingDir, writePending, type PendingNative } from '../src/send/pending.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('writers starting in a brand-new empty home all create the ladder and append', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-store-ladder-')));
  dirs.push(base);
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  // The home folder is left absent: each writer's append is the first thing to create it, then
  // `<home>/.config`, `<home>/.config/team` and the project's store folder.
  const home = join(base, 'home');

  const writers = 12;
  const ids = Array.from({ length: writers }, (_, i) => `ladder-${String(i)}`);
  const startAt = Date.now() + 500;
  const helper = join(import.meta.dir, 'bus-log-concurrent-seq-run.ts');
  // One Promise.all over one spawn per writer: every process is alive before the shared start
  // instant, so all the appends reach the ladder together instead of in spawn order.
  const results = await Promise.all(
    ids.map(async (id) => {
      const proc = Bun.spawn(['bun', helper, root, home, id, String(startAt)], { stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        return {
          exitCode: proc.exitCode,
          ...(JSON.parse(line) as { ok?: boolean; reason?: string; seq?: number }),
        };
      } catch {
        return {
          exitCode: proc.exitCode,
          ok: false,
          reason: `unparseable output: ${line.slice(0, 80)} ${err.slice(0, 80)}`,
        };
      }
    }),
  );

  const read = readEvents('acme', root, home);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const storeDir = dirname(historyPath('acme', root, home));
  const storeMode = (statSync(storeDir).mode & 0o777).toString(8);
  // One fact object: a red run shows what each writer answered beside what the log retained and
  // what mode the shared store folder ended at.
  expect({
    exitCodes: results.map((result) => result.exitCode),
    ok: results.map((result) => result.ok),
    reasons: results.filter((result) => result.ok !== true).map((result) => result.reason ?? null),
    eventsSorted: read.events.map((event) => event.payload.record_id).sort(),
    storeMode,
  }).toEqual({
    exitCodes: ids.map(() => 0),
    ok: ids.map(() => true),
    reasons: [],
    eventsSorted: [...ids].sort(),
    storeMode: '700',
  });
}, 30000);

test("writers creating the same folders below one store all accept each other's mkdir", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-store-folders-')));
  dirs.push(base);
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const storeDir = dirname(historyPath('acme', root, home));
  expect(ensureStoreLadder(storeDir, home)).toBeNull();

  const writers = 8;
  const folder = join('accounts', 'acme', 'inbox');
  const startAt = Date.now() + 500;
  const helper = join(import.meta.dir, 'store-ladder-folder-race-run.ts');
  const results = await Promise.all(
    Array.from({ length: writers }, async () => {
      const proc = Bun.spawn(['bun', helper, storeDir, folder, String(startAt)], { stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        return { exitCode: proc.exitCode, ...(JSON.parse(line) as { ok?: boolean; reason?: string }) };
      } catch {
        return {
          exitCode: proc.exitCode,
          ok: false,
          reason: `unparseable output: ${line.slice(0, 80)} ${err.slice(0, 80)}`,
        };
      }
    }),
  );

  const modeOf = (at: string): string => (statSync(join(storeDir, at)).mode & 0o777).toString(8);
  // The loser of each level's mkdir must keep walking; a red run names what it answered instead.
  expect({
    exitCodes: results.map((result) => result.exitCode),
    ok: results.map((result) => result.ok),
    reasons: results.filter((result) => result.ok !== true).map((result) => result.reason ?? null),
    modes: ['accounts', join('accounts', 'acme'), folder].map(modeOf),
  }).toEqual({
    exitCodes: Array.from({ length: writers }, () => 0),
    ok: Array.from({ length: writers }, () => true),
    reasons: [],
    modes: ['700', '700', '700'],
  });
}, 30000);

test("pending handoffs beginning in a brand-new home all accept each other's mkdir", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pending-race-')));
  dirs.push(base);
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  // The home exists; the store ladder below it and then the pending folder are each a first
  // write for every one of these processes.
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });

  const writers = 8;
  const ids = Array.from({ length: writers }, (_, i) => `pending-race-${String(i)}`);
  const startAt = Date.now() + 500;
  const helper = join(import.meta.dir, 'pending-race-run.ts');
  const results = await Promise.all(
    ids.map(async (id) => {
      const proc = Bun.spawn(['bun', helper, 'acme', root, home, id, String(startAt)], { stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        return { exitCode: proc.exitCode, ...(JSON.parse(line) as { ok?: boolean; reason?: string }) };
      } catch {
        return {
          exitCode: proc.exitCode,
          ok: false,
          reason: `unparseable output: ${line.slice(0, 80)} ${err.slice(0, 80)}`,
        };
      }
    }),
  );

  const dir = pendingDir('acme', root, home);
  // The loser of the pending folder's mkdir must adopt the winner's folder and write its own
  // record; a red run names what it answered instead.
  expect({
    exitCodes: results.map((result) => result.exitCode),
    ok: results.map((result) => result.ok),
    reasons: results.filter((result) => result.ok !== true).map((result) => result.reason ?? null),
    files: readdirSync(dir).filter((name) => name.endsWith('.json')).sort(),
    mode: (statSync(dir).mode & 0o777).toString(8),
  }).toEqual({
    exitCodes: ids.map(() => 0),
    ok: ids.map(() => true),
    reasons: [],
    files: ids.map((id) => `${id}.json`).sort(),
    mode: '700',
  });
}, 30000);

test('independent adversarial checks: symlinks and regular files at each ladder level and pending folder, 0500 read-only parent refused and left 0500, 0755 non-seal levels left 0755, and 10-writer pending race in fresh home', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-store-ladder-adv-')));
  dirs.push(base);
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  const outside = join(base, 'outside');
  mkdirSync(outside, { recursive: true });
  chmodSync(outside, 0o755);

  // 1. Symlink planted at each ladder level (`configDir`, `stateRoot`, `storeDir`) and below `storeDir`:
  //    refused without following or chmodding the target.
  for (const levelName of ['config', 'team', 'store'] as const) {
    const home = join(base, `home-link-${levelName}`);
    mkdirSync(home, { recursive: true });
    const configDir = join(home, '.config');
    const stateRoot = join(configDir, 'team');
    const storeDir = dirname(historyPath('acme', root, home));

    if (levelName === 'config') {
      symlinkSync(outside, configDir);
    } else if (levelName === 'team') {
      mkdirSync(configDir, { mode: 0o700 });
      symlinkSync(outside, stateRoot);
    } else {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      symlinkSync(outside, storeDir);
    }

    expect(ensureStoreLadder(storeDir, home), levelName).toBe('a symbolic link was found and not followed');
    expect(createDir0700(levelName === 'config' ? configDir : levelName === 'team' ? stateRoot : storeDir), levelName).toBe(
      'a symbolic link was found and not followed',
    );
    expect((statSync(outside).mode & 0o777).toString(8), levelName).toBe('755');
  }

  // Symlink at each level below `storeDir` in `ensureFoldersBelow`:
  for (const subLevel of ['accounts', join('accounts', 'acme'), join('accounts', 'acme', 'inbox')] as const) {
    const home = join(base, `home-sublink-${subLevel.replaceAll('/', '-')}`);
    mkdirSync(home, { recursive: true });
    const storeDir = dirname(historyPath('acme', root, home));
    expect(ensureStoreLadder(storeDir, home)).toBeNull();
    const targetPath = join(storeDir, subLevel);
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    symlinkSync(outside, targetPath);

    expect(ensureFoldersBelow(storeDir, [join('accounts', 'acme', 'inbox')])).toBe(
      `${targetPath}: a symbolic link was found and not followed`,
    );
    expect((statSync(outside).mode & 0o777).toString(8)).toBe('755');
  }

  // 2. Raced symlink across 6 processes calling `ensureFoldersBelow`: every process refuses and
  //    never chmods `outside`.
  {
    const home = join(base, 'home-raced-link');
    mkdirSync(home, { recursive: true });
    const storeDir = dirname(historyPath('acme', root, home));
    expect(ensureStoreLadder(storeDir, home)).toBeNull();
    mkdirSync(join(storeDir, 'accounts', 'acme'), { recursive: true, mode: 0o700 });
    const racedInbox = join(storeDir, 'accounts', 'acme', 'inbox');
    symlinkSync(outside, racedInbox);

    const startAt = Date.now() + 250;
    const helper = join(import.meta.dir, 'store-ladder-folder-race-run.ts');
    const racedResults = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const proc = Bun.spawn(['bun', helper, storeDir, join('accounts', 'acme', 'inbox'), String(startAt)], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
        return { exitCode: proc.exitCode, ...(JSON.parse(line) as { ok?: boolean; reason?: string }) };
      }),
    );
    for (const res of racedResults) {
      expect(res.ok).toBe(false);
      expect(res.reason).toBe(`${racedInbox}: a symbolic link was found and not followed`);
    }
    expect(lstatSync(racedInbox).isSymbolicLink()).toBe(true);
    expect((statSync(outside).mode & 0o777).toString(8)).toBe('755');
  }

  // 3. Regular file planted at each ladder level (`configDir`, `stateRoot`, `storeDir`) and sub-level:
  //    refused with `the state folder path is not a directory`.
  for (const levelName of ['config', 'team', 'store', 'sub'] as const) {
    const home = join(base, `home-file-${levelName}`);
    mkdirSync(home, { recursive: true });
    const configDir = join(home, '.config');
    const stateRoot = join(configDir, 'team');
    const storeDir = dirname(historyPath('acme', root, home));

    if (levelName === 'config') {
      writeFileSync(configDir, 'not-a-dir');
      expect(ensureStoreLadder(storeDir, home)).toBe('the state folder path is not a directory');
      expect(createDir0700(configDir)).toBe('the state folder path is not a directory');
    } else if (levelName === 'team') {
      mkdirSync(configDir, { mode: 0o700 });
      writeFileSync(stateRoot, 'not-a-dir');
      expect(ensureStoreLadder(storeDir, home)).toBe('the state folder path is not a directory');
    } else if (levelName === 'store') {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(storeDir, 'not-a-dir');
      expect(ensureStoreLadder(storeDir, home)).toBe('the state folder path is not a directory');
    } else {
      expect(ensureStoreLadder(storeDir, home)).toBeNull();
      const subFile = join(storeDir, 'accounts');
      writeFileSync(subFile, 'not-a-dir');
      expect(ensureFoldersBelow(storeDir, [join('accounts', 'acme')])).toBe(
        `${subFile}: the state folder path is not a directory`,
      );
    }
  }

  // 4. Pre-existing 0500 read-only level (`configDir` or `stateRoot`): `ensureStoreLadder` refuses
  //    when creating the child level (`the state folder could not be created`) and leaves the
  //    pre-existing level at mode 0500.
  for (const levelName of ['config', 'team'] as const) {
    const home = join(base, `home-0500-${levelName}`);
    mkdirSync(home, { recursive: true });
    const configDir = join(home, '.config');
    const stateRoot = join(configDir, 'team');
    const storeDir = dirname(historyPath('acme', root, home));
    const readOnlyDir = levelName === 'config' ? configDir : stateRoot;
    mkdirSync(readOnlyDir, { recursive: true, mode: 0o700 });
    chmodSync(readOnlyDir, 0o500);
    try {
      expect(ensureStoreLadder(storeDir, home), levelName).toBe('the state folder could not be created');
      expect((statSync(readOnlyDir).mode & 0o777).toString(8), levelName).toBe('500');
    } finally {
      chmodSync(readOnlyDir, 0o700);
    }
  }

  // 5. Pre-existing 0755 non-seal levels (`<home>/.config` and `<home>/.config/team`) are left at
  //    0755 while `storeDir` (`seal: true`) is created at 0700 (or tightened from 0755 to 0700).
  {
    const home = join(base, 'home-0755');
    const configDir = join(home, '.config');
    const stateRoot = join(configDir, 'team');
    const storeDir = dirname(historyPath('acme', root, home));
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o755);
    mkdirSync(stateRoot, { recursive: true });
    chmodSync(stateRoot, 0o755);

    expect(ensureStoreLadder(storeDir, home)).toBeNull();
    expect((statSync(configDir).mode & 0o777).toString(8)).toBe('755');
    expect((statSync(stateRoot).mode & 0o777).toString(8)).toBe('755');
    expect((statSync(storeDir).mode & 0o777).toString(8)).toBe('700');

    chmodSync(storeDir, 0o755);
    expect(ensureStoreLadder(storeDir, home)).toBeNull();
    expect((statSync(configDir).mode & 0o777).toString(8)).toBe('755');
    expect((statSync(stateRoot).mode & 0o777).toString(8)).toBe('755');
    expect((statSync(storeDir).mode & 0o777).toString(8)).toBe('700');
  }

  // 6. Pending folder: 10 concurrent writers of distinct pending records into a fresh home all
  //    succeed and leave `pendingDir` at mode 0700; while a symlink or a regular file at `pendingDir`
  //    is refused (both via `writePending` and via `createDir0700(dir, 'the pending folder')`).
  {
    const home = join(base, 'home-pending-10');
    mkdirSync(home, { recursive: true });
    const writers = 10;
    const ids = Array.from({ length: writers }, (_, i) => `ind-pending-${String(i)}`);
    const startAt = Date.now() + 350;
    const helper = join(import.meta.dir, 'pending-race-run.ts');
    const results = await Promise.all(
      ids.map(async (id) => {
        const proc = Bun.spawn(['bun', helper, 'acme', root, home, id, String(startAt)], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
        return { exitCode: proc.exitCode, ...(JSON.parse(line) as { ok?: boolean; reason?: string }) };
      }),
    );
    const pDir = pendingDir('acme', root, home);
    expect({
      exitCodes: results.map((r) => r.exitCode),
      ok: results.map((r) => r.ok),
      files: readdirSync(pDir).filter((name) => name.endsWith('.json')).sort(),
      mode: (statSync(pDir).mode & 0o777).toString(8),
    }).toEqual({
      exitCodes: ids.map(() => 0),
      ok: ids.map(() => true),
      files: ids.map((id) => `${id}.json`).sort(),
      mode: '700',
    });

    // Symlink at `pendingDir`: refused by `writePending` and `createDir0700(dir, 'the pending folder')`.
    const sampleRecord = (id: string): PendingNative => ({
      v: 1,
      id,
      nonce: nativeNonceOf(id),
      ts: new Date().toISOString(),
      from: 'owner',
      from_id: null,
      to: 'acme',
      to_id: null,
      team: 'acme',
      session: 'session',
      cli: 'claude-code',
      pane: 'pane',
      address: 'uds:/nonexistent',
      rule: 'test',
      project: 'acme',
      root,
      body: 'body',
    });
    const homeLink = join(base, 'home-pending-link');
    mkdirSync(homeLink, { recursive: true });
    const storeLink = dirname(historyPath('acme', root, homeLink));
    expect(ensureStoreLadder(storeLink, homeLink)).toBeNull();
    const pDirLink = pendingDir('acme', root, homeLink);
    symlinkSync(outside, pDirLink);
    expect(writePending('acme', root, homeLink, sampleRecord('link-1'))).toEqual({
      ok: false,
      reason: 'a symbolic link was found and not followed',
    });
    expect(createDir0700(pDirLink, 'the pending folder')).toBe('a symbolic link was found and not followed');
    expect((statSync(outside).mode & 0o777).toString(8)).toBe('755');

    // Regular file at `pendingDir`: refused by `writePending` and `createDir0700(dir, 'the pending folder')`.
    const homeFile = join(base, 'home-pending-file');
    mkdirSync(homeFile, { recursive: true });
    const storeFile = dirname(historyPath('acme', root, homeFile));
    expect(ensureStoreLadder(storeFile, homeFile)).toBeNull();
    const pDirFile = pendingDir('acme', root, homeFile);
    writeFileSync(pDirFile, 'not-a-dir');
    expect(writePending('acme', root, homeFile, sampleRecord('file-1'))).toEqual({
      ok: false,
      reason: 'the pending folder is not a directory',
    });
    expect(createDir0700(pDirFile, 'the pending folder')).toBe('the state folder path is not a directory');
  }
}, 30000);
