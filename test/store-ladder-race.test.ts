// STORE-LADDER-RACE coverage: several writers beginning in a brand-new empty home race to create the
// state folder ladder. Exactly one process can win each `mkdir`; every other process must accept
// the winner's folder as ready, not fail with "the state folder could not be created". The
// spawn-per-writer with one shared start instant follows test/bus-log-concurrent-seq.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { ensureStoreLadder, historyPath } from '../src/send/history.ts';
import { pendingDir } from '../src/send/pending.ts';

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
