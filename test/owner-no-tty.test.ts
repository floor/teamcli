// A run placed outside herdr with no terminal is not the owner. Owner-gated acts refuse it
// with one sentence, and `up` does not launch.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const UP_ROUTE = 'only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { gitEnv, testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-tty-')));
  dirs.push(base);
  const root = join(base, 'acme-web');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), EXAMPLE);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

test('up refuses a run with no terminal and does not launch', async () => {
  const { root, home } = repo();
  let created = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => false,
    createWorkspace() {
      created += 1;
      return { pane: 'made', workspace: 'ws' };
    },
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => ['zsh'],
    sleep: async () => {},
    now: () => new Date('2026-10-14T09:00:00Z'),
  };
  const sources: UpSources = {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    launch,
    now: () => new Date('2026-10-14T09:00:00Z'),
  };
  const io = testIo(root, { kind: 'owner-no-tty' });
  const code = await runUp([], io, sources);
  expect(code).toBe(1);
  expect(io.err).toContain(`team up: ${UP_ROUTE}\n`);
  expect(created).toBe(0);
});

test('a dry run names the same sentence and still does not launch', async () => {
  const { root, home } = repo();
  let created = 0;
  const sources: UpSources = {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    launch: {
      sessionState: () => 'absent',
      startServer: () => true,
      sessionUp: () => false,
      createWorkspace() {
        created += 1;
        return { pane: 'made', workspace: 'ws' };
      },
      paneRun: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents: () => [],
      paneText: () => '',
      foreground: () => ['zsh'],
      sleep: async () => {},
      now: () => new Date('2026-10-14T09:00:00Z'),
    },
    now: () => new Date('2026-10-14T09:00:00Z'),
  };
  const io = testIo(root, { kind: 'owner-no-tty' });
  const code = await runUp(['--dry-run'], io, sources);
  expect(code).toBe(1);
  expect(io.out).toContain(`! up would refuse: ${UP_ROUTE}\n`);
  expect(created).toBe(0);
});
