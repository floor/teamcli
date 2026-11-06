import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon } from '../src/commands/daemon.ts';
import { rootsFromAddedNotice, runningRegistryRoots } from '../src/daemon/registry-roots.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { StartMachineDaemonInput } from '../src/daemon/host.ts';
import { noteTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function temp(): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fm-roots-')));
  bases.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { home, root };
}

describe('dynamic daemon roots', () => {
  test('a running registry team is hosted and any other lifecycle is not', () => {
    expect(runningRegistryRoots({
      a: { root: '/repo/a', lifecycle: 'running' },
      b: { root: '/repo/b', lifecycle: 'defined' },
      c: { root: '/repo/c', lifecycle: 'running' },
      d: { root: '/repo/d', lifecycle: 'stopped' },
      e: { root: '/repo/e', lifecycle: 'archived' },
    })).toEqual([
      { root: '/repo/a', source: 'registry' },
      { root: '/repo/c', source: 'registry' },
    ]);
  });

  test('root.added hosts only what the registry already marks running', () => {
    const teams = {
      a: { root: '/repo/a', lifecycle: 'running' },
      b: { root: '/repo/b', lifecycle: 'defined' },
    };
    expect(rootsFromAddedNotice(teams, { op: 'health' })).toBeNull();
    expect(rootsFromAddedNotice(teams, { op: 'root.added', root: '/repo/b' })).toEqual([
      { root: '/repo/a', source: 'registry' },
    ]);
    teams.b = { root: '/repo/b', lifecycle: 'running' };
    expect(rootsFromAddedNotice(teams, { op: 'root.added', root: '/repo/b' })).toEqual([
      { root: '/repo/a', source: 'registry' },
      { root: '/repo/b', source: 'registry' },
    ]);
  });

  test('a rescan lands a running team a missed notice never named', () => {
    const scanned = runningRegistryRoots({
      a: { root: '/repo/a', lifecycle: 'running' },
      late: { root: '/repo/late', lifecycle: 'running' },
      parked: { root: '/repo/parked', lifecycle: 'defined' },
    });
    expect(scanned.map((one) => one.root)).toEqual(['/repo/a', '/repo/late']);
    expect(scanned.every((one) => one.source === 'registry')).toBe(true);
  });

  test('the unit argument list carries no --root', () => {
    const { home } = temp();
    const folder = join(home, 'app');
    mkdirSync(folder, { recursive: true });
    const entry = join(folder, 'cli.js');
    writeFileSync(entry, 'synthetic entry\n');
    const manager = darwinServiceManager({
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      uid: 501,
      accountHome: home,
    });
    const unit = manager.install(home, {
      execPath: '/runtime/bin/node',
      entry,
      roots: ['/repo/a', '/repo/b'],
    });
    expect(unit.ok).toBe(true);
    if (!unit.ok) return;
    const text = readFileSync(unit.unitPath, 'utf8');
    expect(text).not.toContain('--root');
    expect(text).not.toContain('/repo/a');
    expect(text).toContain('service-manager');
  });

  test('a service start with no --root hosts the running registry teams', async () => {
    const { home, root } = temp();
    const other = join(root, '..', 'other');
    mkdirSync(other, { recursive: true });
    expect(noteTeam(home, root, { project: 'acme', entity: null, session: 'acme', lobby: null }, 'running', 'owner')).toBeNull();
    expect(noteTeam(home, other, { project: 'other', entity: null, session: 'other', lobby: null }, 'defined', 'owner')).toBeNull();
    const seen: StartMachineDaemonInput[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(['run', '--started-by', 'service-manager'], io, {
      home,
      accountHome: home,
      start: async (input) => {
        seen.push(input);
        return { kind: 'already-running', pid: 42 };
      },
    });
    expect(code).toBe(0);
    expect(seen[0]?.roots).toEqual([root]);
    expect(seen[0]?.rootsFromRegistry).toBe(true);
    expect(seen[0]?.runningRoots?.()).toEqual([root]);
    expect(io.out).toContain('already running');
  });
});
