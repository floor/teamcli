// Independent refusals for pretrust. Off writes nothing. A CLI with no captured record
// is not guessed. Nothing presses a key. The dialogs.trust switch stays owner-only.
// Synthetic homes only.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { Io } from '../src/io.ts';
import { grantedFolderPretrust, lobbyPretrustLine, projectRootPretrust, type PretrustSeat } from '../src/launch/pretrust.ts';
import { planGrant } from '../src/permissions/grants.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import type { Standing } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-06T15:00:00.000Z');
const homes: string[] = [];

afterEach(() => discardFixtures(homes.splice(0)));

function homeOf(): string {
  const home = mkdtempSync(join(tmpdir(), 'pretrust-refusal-'));
  homes.push(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function fresh(cli: string, cwd: string, lobby = false): PretrustSeat {
  return { cli, cwd, lobby, stage: 'launched' };
}

test('pretrust off writes no trust record', () => {
  const home = homeOf();
  const lobby = join(home, 'lobby');
  mkdirSync(lobby, { mode: 0o700 });
  const line = lobbyPretrustLine(fresh('grok', lobby, true), home, { write: false, now: NOW });
  expect(line).toBeNull();
  expect(existsSync(join(home, '.grok'))).toBe(false);
});

test('a CLI with no captured record is not guessed', () => {
  const home = homeOf();
  const root = join(home, 'project');
  mkdirSync(root, { mode: 0o700 });
  const before = new Set(readdirSync(home));
  const wrote = projectRootPretrust(fresh('gemini', root), home, { now: NOW, root });
  expect(wrote).toBe(false);
  expect(readdirSync(home).filter((name) => !before.has(name))).toEqual([]);
});

test('a trust answer with the switch off presses no key', async () => {
  const home = homeOf();
  const project = join(home, 'project');
  mkdirSync(join(project, '.agents'), { recursive: true, mode: 0o700 });
  const file = join(project, '.agents', 'team.yaml');
  writeFileSync(file, `format: 1
project: acme
operator: owner
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: grok
    vendor: xai
    model: grok
    version: "4.7"
    launch: grok
    leads: true
  - role: builder
    name: owner
    cli: grok
    vendor: xai
    model: grok
    version: "4.7"
    launch: grok
  - role: builder
    name: builder
    cli: grok
    vendor: xai
    model: grok
    version: "4.7"
    launch: grok
`);
  const keys: string[] = [];
  const host: AnswerHost = {
    version: () => null,
    agents: () => [],
    pane: () => undefined,
    sendKey: () => { keys.push('key'); return true; },
    rename: () => true,
    foreground: () => null,
    foregroundCwd: () => null,
    list: () => [],
    status: () => null,
    type: () => { keys.push('type'); return true; },
    enter: () => { keys.push('enter'); return true; },
    now: () => NOW,
    sleep: async () => {},
    home,
    standing: () => ({ kind: 'none' }) as Standing,
  };
  let stderr = '';
  const caller: Caller = { kind: 'owner' };
  const io: Io = {
    cwd: project,
    env: {},
    stdinIsTTY: true,
    caller,
    stdout: () => {},
    stderr: (text) => { stderr += text; },
  };
  const code = await runAnswer(['builder', 'trust', '--file', file], io, host);
  expect(code).not.toBe(0);
  expect(stderr).toContain('dialogs.trust is off; only the owner can turn it on');
  expect(keys).toEqual([]);
});

test('a seat grant cannot turn dialogs.trust on', () => {
  const home = homeOf();
  const root = join(home, 'project');
  mkdirSync(root, { mode: 0o700 });
  const plan = planGrant(home, {
    name: 'seat-trust',
    kind: 'seat',
    grantee: 'agt_0123456789ab',
    capabilities: ['dialogs.trust'],
    roots: [root],
  }, { now: NOW });
  expect(plan.ok).toBe(false);
  if (plan.ok) return;
  expect(plan.why).toContain('a seat grant never carries `dialogs.trust`');
});

const CAPTURED = ['grok', 'cursor', 'claude-code', 'codex'] as const;

test('the default project policy trusts the project folder for each captured CLI and prints no pretrust note', () => {
  const home = homeOf();
  const project = join(home, 'acme');
  const outside = join(home, 'outside');
  const sockets = join(home, 'sockets');
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  mkdirSync(sockets, { mode: 0o700 });
  mkdirSync(join(project, '.agents'), { mode: 0o700 });
  const file = join(project, '.agents', 'team.yaml');
  writeFileSync(file, `format: 1
project: acme
operator: owner
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: grok
    vendor: xai
    model: grok
    version: "4.7"
    launch: grok
    leads: true
  - role: builder
    name: owner
    cli: grok
    vendor: xai
    model: grok
    version: "4.7"
    launch: grok
`);
  const nested = join(project, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  const projectReal = realpathSync(project);
  const outsideReal = realpathSync(outside);
  const nestedReal = realpathSync(nested);
  const grant = {
    covers: (folder: string) => folder === nestedReal || folder === outsideReal,
    listed: () => false,
  };
  for (const cli of CAPTURED) {
    expect(projectRootPretrust(fresh(cli, outsideReal), home, { now: NOW, root: projectReal })).toBe(false);
    expect(projectRootPretrust(fresh(cli, projectReal), home, { now: NOW, root: projectReal })).toBe(true);
    expect(grantedFolderPretrust(fresh(cli, outsideReal), home, { now: NOW, grant, root: projectReal, mode: 'project' })).toBe(false);
    expect(grantedFolderPretrust(fresh(cli, nestedReal), home, { now: NOW, grant, root: projectReal, mode: 'project' })).toBe(true);
  }
  const grok = readFileSync(join(home, '.grok', 'trusted_folders.toml'), 'utf8');
  expect(grok).toContain(projectReal);
  expect(grok).not.toContain(outsideReal);
  const slug = projectReal.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const cursor = readFileSync(join(home, '.cursor', 'projects', slug, '.workspace-trusted'), 'utf8');
  expect(cursor).toContain(projectReal);
  expect(cursor).not.toContain(outsideReal);
  const claude = readFileSync(join(home, '.claude.json'), 'utf8');
  expect(claude).toContain(projectReal);
  expect(claude).not.toContain(outsideReal);
  const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  expect(codex).toContain(projectReal);
  expect(codex).not.toContain(outsideReal);
  let stdout = '';
  const caller: Caller = { kind: 'owner' };
  const io: Io = {
    cwd: project,
    env: {},
    stdinIsTTY: true,
    caller,
    stdout: (text) => { stdout += text; },
    stderr: () => {},
  };
  runTeamCheck({ file, json: true }, io, {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }) as Standing,
    now: () => NOW,
    home,
    sockets,
  });
  expect(stdout).not.toContain('pretrust:');
  expect(stdout).not.toContain('first-run-admission:');

  const written = writePolicySet(home, {
    level: 'team',
    target: project,
    teamRoot: project,
    name: 'pretrust',
    value: 'off',
  }, { now: NOW });
  expect(written.ok).toBe(true);
  stdout = '';
  runTeamCheck({ file, json: true }, io, {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }) as Standing,
    now: () => NOW,
    home,
    sockets,
  });
  expect(stdout).toContain('pretrust: off');
  expect(stdout).not.toContain('first-run-admission:');
});
