import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../../src/caller.ts';
import { launchedTeamFile, noteLaunchedPane } from '../../src/file/launched-file.ts';
import type { Io } from '../../src/io.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function placed(pane: string): CallerSources {
  return {
    ancestors: () => [{ pid: 10, name: 'zsh' }, { pid: 2, name: 'herdr' }, { pid: 1, name: 'launchd' }],
    agents: () => [{ name: 'lead', agent: 'claude', pane, workspace: 'w1', status: 'idle', cwd: null }],
    paneRootPid: (id) => (id === pane ? 10 : null),
    env: {},
    stdinIsTTY: true,
  };
}

function outside(): CallerSources {
  return {
    ancestors: () => [{ pid: 10, name: 'zsh' }, { pid: 1, name: 'launchd' }],
    agents: () => [],
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: true,
  };
}

function io(place: (session: string | undefined) => CallerSources): Pick<Io, 'env' | 'stdinIsTTY' | 'callerSources'> {
  return { env: {}, stdinIsTTY: true, callerSources: place };
}

function team(home: string, name: string, session: string): { file: string } {
  const root = join(home, name);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, 'format: 1\n');
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      [session]: {
        seats: { lead: { stage: 'ready', pane: 'w1:p1' } },
        worktrees: {},
        launched_file: file,
      },
    },
  })}\n`);
  return { file };
}

test('two teams that share a pane id each resolve their own file', () => {
  const home = mkdtempSync(join(tmpdir(), 'team-pane-'));
  roots.push(home);
  const alpha = team(home, 'alpha', 'alpha');
  const beta = team(home, 'beta', 'beta');
  noteLaunchedPane(home, alpha.file, 'w1:p1', 'alpha');
  noteLaunchedPane(home, beta.file, 'w1:p1', 'beta');
  expect(readdirSync(join(home, '.config', 'team', 'panes'))).toHaveLength(2);

  const asAlpha = io((session) => (session === undefined || session === 'alpha' ? placed('w1:p1') : outside()));
  const asBeta = io((session) => (session === undefined || session === 'beta' ? placed('w1:p1') : outside()));
  expect(launchedTeamFile(asAlpha, home)).toBe(alpha.file);
  expect(launchedTeamFile(asBeta, home)).toBe(beta.file);
});

test('a caller placed in neither session gets no file', () => {
  const home = mkdtempSync(join(tmpdir(), 'team-pane-'));
  roots.push(home);
  const alpha = team(home, 'alpha', 'alpha');
  const beta = team(home, 'beta', 'beta');
  noteLaunchedPane(home, alpha.file, 'w1:p1', 'alpha');
  noteLaunchedPane(home, beta.file, 'w1:p1', 'beta');
  const neither = io((session) => (session === undefined ? placed('w1:p1') : outside()));
  expect(launchedTeamFile(neither, home)).toBeUndefined();
});

test('a pointer stored under the pane id alone still resolves for its own team', () => {
  const home = mkdtempSync(join(tmpdir(), 'team-pane-'));
  roots.push(home);
  const alpha = team(home, 'alpha', 'alpha');
  const dir = join(home, '.config', 'team', 'panes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, encodeURIComponent('w1:p1')), `${alpha.file}\n`);
  const asAlpha = io((session) => (session === undefined || session === 'alpha' ? placed('w1:p1') : outside()));
  expect(launchedTeamFile(asAlpha, home)).toBe(alpha.file);
});
