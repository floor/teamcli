// TEAMCLI_DEV_MODE=1 turns the no-approval refusal and the caller-placement refusal
// into one warning and mounts the live file. Unset, the same file refuses and nothing launches.
// The run writes no approval, no signing key and no grant.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { keyFolder } from '../src/store/keys.ts';
import { storePath } from '../src/store/store.ts';
import { readState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const NOW = new Date('2026-10-15T12:00:00Z');
const UNPLACED = { kind: 'unplaced' as const, reason: 'it runs under herdr' };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-dev-mode-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), file(root));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const panes: string[] = [];
  const runs: { pane: string; command: string }[] = [];
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.push(pane);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => panes,
    agents: () => [],
    paneText: () => IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
    spawnWatch: () => 1,
  };
  return { launch, runs };
}

function sources(home: string, launch: Launch): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    doctor: doctor(home),
    launch,
    now: () => NOW,
  };
}

/** Approval records, the signing key, and a grant file. A rules file or a pane pointer is a mount. */
function approvalArtifacts(home: string, root: string): string[] {
  const found: string[] = [];
  if (existsSync(keyFolder(home))) found.push(keyFolder(home));
  const store = storePath('acme', root, home);
  for (const name of ['approval.json', 'approved.yaml']) {
    const path = join(store, name);
    if (existsSync(path)) found.push(path);
  }
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name === 'approval.json' || name === 'approved.yaml' || name === 'grant.json') found.push(path);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // A name that vanished between the read and the stat is not an artifact.
      }
    }
  };
  walk(home);
  return found;
}

test('an unapproved file refuses, and the same file mounts when TEAMCLI_DEV_MODE=1', async () => {
  const refused = repo();
  const refusedWorld = world();
  const refusedIo = testIo(refused.root, UNPLACED);
  const refusedCode = await runUp([], refusedIo, sources(refused.home, refusedWorld.launch));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toContain('team up: only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');
  expect(refusedIo.err).toContain('team up: the file was never approved on this machine: run `team approve`\n');
  expect(refusedIo.err).toContain('team up: run `team approve`: this file was never approved on this machine\n');
  expect(refusedWorld.runs).toEqual([]);
  expect(approvalArtifacts(refused.home, refused.root)).toEqual([]);

  const mounted = repo();
  const mountedWorld = world();
  const mountedIo = testIo(mounted.root, UNPLACED);
  mountedIo.env = { TEAMCLI_DEV_MODE: '1' };
  const mountedCode = await runUp([], mountedIo, sources(mounted.home, mountedWorld.launch));
  expect(mountedCode).toBe(0);
  expect(mountedIo.err).toContain('team up: warning:');
  expect(mountedIo.err).toContain('only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it runs under herdr)');
  expect(mountedIo.err).toContain('the file was never approved on this machine: run `team approve`');
  expect(mountedIo.err).toContain('run `team approve`: this file was never approved on this machine');
  expect(mountedIo.err).not.toContain('team up: only the owner runs `up`');
  expect(mountedIo.err).not.toContain('team up: the file was never approved');
  expect(mountedIo.err).not.toContain('team up: run `team approve`');
  expect(mountedWorld.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
  expect(readState(join(mounted.root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  expect(approvalArtifacts(mounted.home, mounted.root)).toEqual([]);
});
