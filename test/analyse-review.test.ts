import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mayAnalyseProject, signAnalyserSetting } from '../src/analyse/gate.ts';
import { readProjectFacts } from '../src/analyse/read.ts';
import { recordText } from '../src/config/team-record.ts';
import { upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import type { Caller } from '../src/caller.ts';
import type { YamlValue } from '../src/yaml.ts';

const made: string[] = [];
afterEach(() => { for (const p of made.splice(0)) execFileSync('trash', [p]); });
function world() {
  const base = mkdtempSync(join(tmpdir(), 'analysis-review-')); made.push(base);
  const home = join(base, 'home'); const repo = join(base, 'repo');
  mkdirSync(join(home, '.config', 'team'), { recursive: true }); mkdirSync(repo);
  const caller: Caller = { kind: 'seat', name: 'seat-a', session: 'team-a', pane: 'pane-a' };
  const io = { cwd: repo, env: { HOME: home }, stdinIsTTY: false, caller };
  const configure = (value: YamlValue) => writeFileSync(join(home, '.config', 'team', 'entities.yaml'), recordText({ 'entity-a': { analyser: signAnalyserSetting(home, 'entity', 'entity-a', value) as unknown as YamlValue } }));
  configure({ principal: 'seat-a@team-a', roots: [repo] });
  const record = () => {
    upsertTeam(home, teamIdOf(repo), { project: 'team-a', session: 'team-a', root: repo });
    updateState(join(repo, '.agents'), state => { state.sessions['team-a'] = { seats: { 'seat-a': { stage: 'ready', pane: 'pane-a' } }, worktrees: {} }; });
  };
  return { home, repo, io, configure, record };
}

test('no recorded pane refuses an explicitly supplied seat caller', () => {
  const w = world();
  expect(mayAnalyseProject(w.io, '.', { home: w.home }).ok).toBe(false);
});

test('recorded placement admits its seat and rejects missing session and foreign pane', () => {
  const w = world(); w.record();
  expect(mayAnalyseProject(w.io, '.', { home: w.home }).ok).toBe(true);
  for (const caller of [
    { kind: 'seat' as const, name: 'seat-a', pane: 'pane-a' },
    { kind: 'seat' as const, name: 'seat-a', session: 'team-a', pane: 'pane-b' },
  ]) expect(mayAnalyseProject({ ...w.io, caller }, '.', { home: w.home }).ok).toBe(false);
});

test('bare principal, unsigned value, and empty signed roots refuse', () => {
  const w = world(); w.record();
  for (const value of [{ principal: 'seat-a', roots: [w.repo] }, { principal: 'seat-a@team-a', roots: [] }]) {
    w.configure(value); expect(mayAnalyseProject(w.io, '.', { home: w.home }).ok).toBe(false);
  }
  writeFileSync(join(w.home, '.config', 'team', 'entities.yaml'), recordText({ 'entity-a': { analyser: { principal: 'seat-a@team-a', roots: [w.repo] } } }));
  expect(mayAnalyseProject(w.io, '.', { home: w.home }).ok).toBe(false);
});

test('a pane recorded in another session cannot override the authorised session pane', () => {
  const w = world(); const otherRoot = join(w.home, 'other-root'); mkdirSync(otherRoot);
  upsertTeam(w.home, teamIdOf(otherRoot), { project: 'team-a', session: 'team-b', root: otherRoot });
  updateState(join(otherRoot, '.agents'), state => { state.sessions['team-b'] = { seats: { 'seat-a': { stage: 'ready', pane: 'pane-b' } }, worktrees: {} }; });
  w.record();
  // Exercise normal process placement, without io.caller or sources.caller injection.
  const io = {
    cwd: w.repo, env: { HOME: w.home }, stdinIsTTY: false,
    callerSources: () => ({
      ancestors: () => [{ pid: 101, name: 'claude' }, { pid: 100, name: 'herdr' }],
      agents: () => [{ name: 'seat-a', pane: 'pane-b', agent: 'claude', workspace: 'space-a', status: 'idle' as const, cwd: null }],
      paneRootPid: () => 101, env: {}, stdinIsTTY: false,
    }),
  };
  expect(mayAnalyseProject(io, '.', { home: w.home }).ok).toBe(false);
});

test('a broader root does not override a narrower principal and equal roots refuse', () => {
  const w = world(); w.record();
  const signed = (id: string, principal: string, root: string) => ({ analyser: signAnalyserSetting(w.home, 'entity', id, { principal, roots: [root] }) as unknown as YamlValue });
  writeFileSync(join(w.home, '.config', 'team', 'entities.yaml'), recordText({ 'entity-a': signed('entity-a', 'seat-a@team-a', w.repo), 'entity-b': signed('entity-b', 'seat-b@team-b', w.home + '/..') }));
  expect(mayAnalyseProject(w.io, '.', { home: w.home }).ok).toBe(true);
  writeFileSync(join(w.home, '.config', 'team', 'entities.yaml'), recordText({ 'entity-a': signed('entity-a', 'seat-a@team-a', w.repo), 'entity-b': signed('entity-b', 'seat-b@team-b', w.repo) }));
  expect(mayAnalyseProject(w.io, '.', { home: w.home }).ok).toBe(false);
});

test('starting directly under runtime state does not scan or count its files', () => {
  const w = world(); const runtime = join(w.repo, '.agents');
  mkdirSync(join(runtime, 'screens'), { recursive: true });
  writeFileSync(join(runtime, 'screens', 'capture.txt'), 'analyser: PRIVATE_RUNTIME_SENTINEL\ngrant: up\n');
  const result = readProjectFacts(runtime, { maxDurationMs: 1000 });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_RUNTIME_SENTINEL');
});

test('runtime state remains hidden when nested below the requested root', () => {
  const w = world();
  mkdirSync(join(w.repo, 'src', '.agents', 'drops'), { recursive: true });
  writeFileSync(join(w.repo, 'src', '.agents', 'drops', 'message.txt'), 'analyser: PRIVATE_NESTED_SENTINEL\n');
  expect(JSON.stringify(readProjectFacts(w.repo, { maxDurationMs: 1000 }))).not.toContain('PRIVATE_NESTED_SENTINEL');
});
