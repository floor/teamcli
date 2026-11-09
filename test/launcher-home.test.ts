// The launcher home: a declaration is a reference, a compiled line names no script, and a
// launch that runs a script from a repository or a temp folder is a problem team check
// reports. Homes, repositories and pane names are synthetic. No launcher script, credential
// or CLI is read.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import type { Seat } from '../src/file/types.ts';
import {
  builtinLeadDecl,
  compileLauncher,
  launcherHome,
  launchLineProblem,
  realLaunchPlace,
  readLauncherHome,
  type LauncherDecl,
} from '../src/launch/launcher-home.ts';
import { CHANNEL_FLAG } from '../src/mcp/channel.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T10:00:00Z');
const SESSION = 'ses_0123456789ab';
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

function withTemp<T>(dir: string | undefined, fn: () => T): T {
  const saved = process.env.TMPDIR;
  if (dir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

function writeDecl(dir: string, name: string, body: string, mode?: number): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, body);
  if (mode !== undefined) chmodSync(path, mode);
}

const GOOD = `name: glm
harness: claude-code
argv:
  - claude
env:
  API_TOKEN:
    ref: glm-token
identity: account
`;

const VALUE = `name: glm
harness: claude-code
argv:
  - claude
env:
  API_TOKEN: placed-secret
`;

function seat(extra: { cli: string; model?: string; agent_session?: string; channel?: boolean }): Seat & { agent_session?: string; channel?: boolean } {
  return {
    role: 'implementer',
    name: 'maker',
    cli: extra.cli,
    vendor: 'lab',
    model: extra.model ?? 'Opus',
    version: '5.5',
    display: 'Opus 5.5',
    launch: extra.cli,
    cwd: '.',
    label: 'maker',
    mode: 'shared',
    parked: false,
    stopped: false,
    declared: 'maker',
    count: 1,
    instance: 1,
    line: 1,
    ...(extra.agent_session !== undefined ? { agent_session: extra.agent_session } : {}),
    ...(extra.channel !== undefined ? { channel: extra.channel } : {}),
  };
}

test('a private declaration of references is read, and a pointer file selects the folder', () => {
  const home = scratch('launcher-home-');
  const pointed = join(home, 'pointed');
  writeDecl(pointed, 'glm', GOOD, 0o644);
  const pointer = join(home, '.config', 'team', 'launcher-home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(pointer, `${pointed}\n`, { mode: 0o600 });

  expect(launcherHome(home)).toBe(pointed);
  const read = readLauncherHome(home);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.launchers).toEqual([
    {
      name: 'glm',
      harness: 'claude-code',
      argv: ['claude'],
      env: { API_TOKEN: { ref: 'glm-token' } },
      identity: 'account',
    },
  ]);

  const plain = scratch('launcher-home-');
  expect(launcherHome(plain)).toBe(join(plain, '.config', 'team', 'launchers'));
  expect(readLauncherHome(plain)).toEqual({ ok: true, launchers: [] });
});

test('an env value that is not a reference is refused', () => {
  const home = scratch('launcher-home-');
  writeDecl(join(home, '.config', 'team', 'launchers'), 'glm', VALUE, 0o644);
  const read = readLauncherHome(home);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.problems).toContain('glm env API_TOKEN is a value, not a { ref }');
});

test('a group-writable declaration is refused', () => {
  const home = scratch('launcher-home-');
  writeDecl(join(home, '.config', 'team', 'launchers'), 'glm', GOOD, 0o666);
  const read = readLauncherHome(home);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.problems).toContain('glm.yaml is group- or world-writable');
});

test('compileLauncher names no script, and claude-code gains the seat model, resume, inbound accept and channel', () => {
  const harnesses = ['claude-code', 'codex', 'cursor', 'grok', 'agy', 'jules'] as const;
  for (const harness of harnesses) {
    const decl: LauncherDecl = {
      name: 'maker',
      harness,
      argv: [harness === 'claude-code' ? 'claude' : harness],
      identity: 'account',
    };
    const line = compileLauncher(decl, seat({ cli: harness, agent_session: SESSION, channel: true }));
    expect(line.includes('account')).toBe(false);
    expect(line.includes('.sh')).toBe(false);
    if (harness === 'claude-code') {
      expect(line).toContain('--model');
      expect(line).toContain('Opus');
      expect(line).toContain('crossSessionInbound');
      expect(line).toContain('--resume');
      expect(line).toContain(SESSION);
      expect(line).toContain(CHANNEL_FLAG);
      expect(line).toContain('server:team-inbox');
    } else {
      expect(line).toBe(harness);
      expect(line.includes('crossSessionInbound')).toBe(false);
      expect(line.includes(CHANNEL_FLAG)).toBe(false);
    }
  }

  const lead = builtinLeadDecl({ name: 'lead', model: 'Opus', agent_session: SESSION }, true);
  expect(lead.identity).toBe('account');
  expect(lead.harness).toBe('claude-code');
  const compiled = compileLauncher(lead, seat({ cli: 'claude-code', model: 'Opus', agent_session: SESSION, channel: true }));
  expect(compiled.includes('.sh')).toBe(false);
  expect(compiled.includes('account')).toBe(false);
  expect(compiled).toContain('crossSessionInbound');
  expect(compiled).toContain(CHANNEL_FLAG);
});

test('a script in a repository, a docs repository, or a temp folder is a problem, and an ordinary program is not', () => {
  const base = scratch('launcher-lines-');
  const repo = join(base, 'repo');
  const docs = join(base, 'docs');
  const home = join(base, 'home');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(join(docs, 'guides'), { recursive: true });
  mkdirSync(home);
  git(repo, 'init', '-q', '-b', 'main');
  git(docs, 'init', '-q', '-b', 'main');
  const repoScript = join(repo, 'tools', 'start.sh');
  const docsScript = join(docs, 'guides', 'synthetic-lead.sh');
  writeFileSync(repoScript, '# synthetic\n');
  writeFileSync(docsScript, '# synthetic\n');

  withTemp(undefined, () => {
    const place = realLaunchPlace();
    expect(launchLineProblem(repoScript, repo, home, place)).toContain('inside a repository');
    expect(launchLineProblem(docsScript, repo, home, place)).toContain('inside a repository');
    expect(launchLineProblem('/tmp/synthetic-launch.sh', repo, home, place)).toContain('temp folder');
    expect(launchLineProblem('/private/tmp/synthetic-launch.sh', repo, home, place)).toContain('temp folder');
  });

  const scratchDir = join(base, 'scratch');
  mkdirSync(scratchDir);
  withTemp(scratchDir, () => {
    expect(launchLineProblem(join(scratchDir, 'run.sh'), repo, home, realLaunchPlace())).toContain('temp folder');
  });

  expect(launchLineProblem('claude --model opus', repo, home, realLaunchPlace())).toBeNull();
});

test('a script under the realpath of a symlinked temp root is a temp folder', () => {
  const base = scratch('launcher-link-');
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  const real = join(base, 'real-temp');
  const link = join(base, 'link-temp');
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(real);
  symlinkSync(real, link);
  const script = join(realpathSync(link), 'run.sh');
  writeFileSync(script, '# synthetic\n');
  withTemp(link, () => {
    expect(launchLineProblem(script, repo, home, realLaunchPlace())).toContain('temp folder');
  });
});

test('team check reports a repository launch line and the migrate repair', () => {
  const base = scratch('launcher-check-');
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  const script = join(root, 'tools', 'start.sh');
  writeFileSync(script, '# synthetic\n');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - .
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: maker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${JSON.stringify(script)}
    mode: shared
`);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead' },
        maker: { stage: 'ready', pane: 'pane-maker' },
      },
    };
  });
  const io = testIo(root, { kind: 'owner' });
  const code = withTemp(undefined, () => runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => ({
      running: true,
      agents: [
        { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
        { name: 'maker', agent: 'claude-code', pane: 'pane-maker', workspace: 'ws-maker', status: 'idle', cwd: root },
      ],
      workspaces: [
        { id: 'ws-lead', label: 'lead' },
        { id: 'ws-maker', label: 'maker' },
      ],
      screens: { 'pane-lead': 'idle\n', 'pane-maker': 'idle\n' },
    }),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
    launchPlace: realLaunchPlace(),
  }));
  expect(code).not.toBe(2);
  expect(io.out).toContain('maker: its launch line runs a script inside a repository');
  expect(io.out).toContain('repair: team launchers migrate');
  expect(readFileSync(script, 'utf8')).toBe('# synthetic\n');
});
