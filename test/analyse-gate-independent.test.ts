// Independent scenes for the analyse gate on a signed analyser: the caller's session and pane
// are checked, a running agent vouches a pane only in the named session, an alias cannot hand
// the path to a broader analyser, and a refusal reads no target content and runs no git.
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { signAnalyserSetting } from '../src/analyse/gate.ts';
import { runAnalyse } from '../src/commands/analyse.ts';
import { recordText } from '../src/config/team-record.ts';
import type { Io } from '../src/io.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import type { YamlValue } from '../src/yaml.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const MARKER = 'scene-marker-text';
const RUNTIME = 'runtime-marker-text';
const bases: string[] = [];

afterEach(() => {
  const roots = [...new Set(bases.map((base) => dirname(base)))];
  discardFixtures(bases.splice(0), { roots });
});

function world() {
  const base = fixtureBase('analyse-gate-');
  bases.push(base);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  fs.mkdirSync(join(home, '.config', 'team'), { recursive: true });
  fs.mkdirSync(repo);
  fs.writeFileSync(join(repo, 'README.md'), `analyser: ${MARKER}\n`);
  fs.mkdirSync(join(repo, '.agents', 'screens'), { recursive: true });
  fs.mkdirSync(join(repo, '.agents', 'drops'), { recursive: true });
  fs.writeFileSync(join(repo, '.agents', 'team.log'), `${RUNTIME}\n`);
  fs.writeFileSync(join(repo, '.agents', 'screens', 'capture.txt'), `${RUNTIME}\n`);
  fs.writeFileSync(join(repo, '.agents', 'drops', 'note.txt'), `${RUNTIME}\n`);
  upsertTeam(home, teamIdOf(repo), { project: 'team-a', session: 'team-a', root: repo });
  fs.writeFileSync(join(home, '.config', 'team', 'entities.yaml'), recordText({
    'entity-a': {
      analyser: signAnalyserSetting(home, 'entity', 'entity-a', {
        principal: 'seat-a@team-a',
        roots: [repo],
      }) as unknown as YamlValue,
    },
  }));
  const io = (pane: string, session = 'team-a'): Io & { out: string } => {
    let out = '';
    return {
      cwd: repo,
      env: { HOME: home },
      stdinIsTTY: false,
      caller: { kind: 'seat', name: 'seat-a', session, pane },
      stdout: (text) => { out += text; },
      stderr: () => {},
      get out() { return out; },
    };
  };
  return { home, repo, base, io };
}

function recordPane(w: ReturnType<typeof world>, pane: string): void {
  updateState(join(w.repo, '.agents'), (state) => {
    state.sessions['team-a'] = {
      seats: { 'seat-a': { stage: 'ready', pane } },
      worktrees: {},
    };
  });
}

function runningAgent(w: ReturnType<typeof world>, session: string, pane: string): void {
  registerAgent(w.home, {
    name: 'seat-a',
    signing: { model: 'Model A', version: '1', role: 'builder' },
    lab: 'vendor-a',
    cli: 'claude-code',
    launcher: null,
    launch: 'cli-a',
    reach: { team: teamIdOf(w.repo), seat: 'seat-a', session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
}

async function runWatched(w: ReturnType<typeof world>, pane: string, session = 'team-a') {
  const read = fs.readFileSync;
  const spawn = childProcess.spawnSync;
  const targetReads: string[] = [];
  const runtimeReads: string[] = [];
  let gitCalls = 0;
  const reads = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof read>) => {
    const path = String(args[0]);
    if (path.startsWith(`${w.repo}/`) && !path.includes('/.agents/')) targetReads.push(path);
    if (path.includes('/screens/') || path.includes('/drops/') || path.endsWith('team.log')) runtimeReads.push(path);
    return Reflect.apply(read, fs, args);
  }) as typeof read);
  const spawns = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (args[0] === 'git') gitCalls += 1;
    return Reflect.apply(spawn, childProcess, args);
  }) as typeof spawn);
  const io = w.io(pane, session);
  let code: number;
  try {
    code = await runAnalyse(['.', '--json'], io, { home: w.home });
  } finally {
    reads.mockRestore();
    spawns.mockRestore();
  }
  return { code, out: io.out, targetReads, runtimeReads, gitCalls };
}

test('a caller on another pane is refused before any target read or git', async () => {
  const w = world();
  recordPane(w, 'fixture-pane-one');
  const result = await runWatched(w, 'fixture-pane-two');
  expect(result).toMatchObject({ code: 1, targetReads: [], runtimeReads: [], gitCalls: 0 });
  expect(result.out.includes(MARKER)).toBe(false);
  expect(result.out.includes(RUNTIME)).toBe(false);
});

test('a caller in another session is refused before any target read or git', async () => {
  const w = world();
  recordPane(w, 'fixture-pane-one');
  const result = await runWatched(w, 'fixture-pane-one', 'other-session');
  expect(result).toMatchObject({ code: 1, targetReads: [], runtimeReads: [], gitCalls: 0 });
  expect(result.out.includes(MARKER)).toBe(false);
});

test('a running agent in another session does not vouch the pane', async () => {
  const w = world();
  runningAgent(w, 'other-session', 'fixture-pane-two');
  const result = await runWatched(w, 'fixture-pane-two');
  expect(result).toMatchObject({ code: 1, targetReads: [], gitCalls: 0 });
  expect(result.out.includes(MARKER)).toBe(false);
});

test('a running agent in the named session vouches its own pane', async () => {
  const w = world();
  runningAgent(w, 'team-a', 'fixture-pane-one');
  const result = await runWatched(w, 'fixture-pane-one');
  expect(result.code).toBe(0);
  expect(result.runtimeReads).toEqual([]);
  expect(result.out.includes(RUNTIME)).toBe(false);
});

test('an alias cannot hand the path to the broader analyser', async () => {
  const w = world();
  recordPane(w, 'fixture-pane-one');
  const narrow = join(w.repo, 'private');
  fs.mkdirSync(join(narrow, 'sub'), { recursive: true });
  fs.writeFileSync(join(narrow, 'sub', 'README.md'), `analyser: ${MARKER}\n`);
  const other = join(w.base, 'team-b');
  fs.mkdirSync(other);
  upsertTeam(w.home, teamIdOf(other), { project: 'team-b', session: 'team-b', root: other });
  updateState(join(other, '.agents'), (state) => {
    state.sessions['team-b'] = {
      seats: { 'seat-b': { stage: 'ready', pane: 'fixture-pane-two' } },
      worktrees: {},
    };
  });
  fs.writeFileSync(join(w.home, '.config', 'team', 'entities.yaml'), recordText({
    'entity-a': {
      analyser: signAnalyserSetting(w.home, 'entity', 'entity-a', {
        principal: 'seat-a@team-a',
        roots: [w.repo],
      }) as unknown as YamlValue,
    },
    'entity-b': {
      analyser: signAnalyserSetting(w.home, 'entity', 'entity-b', {
        principal: 'seat-b@team-b',
        roots: [narrow],
      }) as unknown as YamlValue,
    },
  }));
  fs.mkdirSync(join(w.repo, 'shared'));
  fs.symlinkSync(narrow, join(w.repo, 'shared', 'entry'));
  const target = join(w.repo, 'shared', 'entry', 'sub');
  const read = fs.readFileSync;
  const spawn = childProcess.spawnSync;
  const targetReads: string[] = [];
  let gitCalls = 0;
  const reads = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof read>) => {
    const path = String(args[0]);
    if (path.startsWith(`${narrow}/`)) targetReads.push(path);
    return Reflect.apply(read, fs, args);
  }) as typeof read);
  const spawns = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (args[0] === 'git') gitCalls += 1;
    return Reflect.apply(spawn, childProcess, args);
  }) as typeof spawn);
  let code: number;
  try {
    code = await runAnalyse([target, '--json'], w.io('fixture-pane-one'), { home: w.home });
  } finally {
    reads.mockRestore();
    spawns.mockRestore();
  }
  expect({ code, targetReads, gitCalls }).toEqual({ code: 1, targetReads: [], gitCalls: 0 });
});
