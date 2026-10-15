// A run placed outside herdr with no terminal is not the owner. Owner-gated acts refuse it
// with one sentence, and `up` does not launch.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveFingerprint } from '../src/approve/owner-token.ts';
import { DETACHED_REFUSAL } from '../src/caller.ts';
import { runApprove } from '../src/commands/approve.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { findStore } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

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
  expect(io.err).toContain(`team up: ${DETACHED_REFUSAL}\n`);
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
  expect(io.out).toContain(`! up would refuse: ${DETACHED_REFUSAL}\n`);
  expect(created).toBe(0);
});

test('approve refuses a detached child placed by the caller walk, with or without an owner token, and writes nothing', async () => {
  const { root, home } = repo();
  const checked = validateTeamFile(EXAMPLE, { home, root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const token = approveFingerprint(checked.team);

  for (const env of [{}, { TEAM_OWNER_APPROVAL: token }]) {
    const io = testIo(root);
    io.env = env;
    io.callerSources = () => ({
      ancestors: () => [{ pid: 90, name: 'zsh' }],
      agents: () => {
        throw new Error('the walk asked herdr for a session');
      },
      paneRootPid: () => {
        throw new Error('the walk asked herdr for a pane root');
      },
      env,
      stdinIsTTY: false,
    });
    const code = await runApprove([], io, {
      ask: async () => {
        throw new Error('approve asked a question after the refusal');
      },
      waiting: () => {
        throw new Error('approve probed the terminal after the refusal');
      },
      now: () => new Date('2026-10-14T09:00:00Z'),
      home,
    });
    expect(code).toBe(1);
    expect(io.err).toContain(`team approve: ${DETACHED_REFUSAL}\n`);
    expect(findStore(root, home)).toBeNull();
    expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
  }
});

test('approve refuses a real double-forked detached child subprocess, with or without an owner token, and writes nothing', () => {
  const { root, home } = repo();
  const checked = validateTeamFile(EXAMPLE, { home, root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const token = approveFingerprint(checked.team);

  // Double-fork via python3 (setsid + second fork so the wrapper is reparented to pid 1,
  // with stdin detached on /dev/null and HERDR_*/AGENT_UNATTENDED cleared from env).
  const script = [
    'import json, os, subprocess, sys',
    'out_path, cwd, bun_bin, cli_path, home, token = sys.argv[1:7]',
    'r, w = os.pipe()',
    'pid = os.fork()',
    'if pid > 0:',
    '    os.close(w)',
    '    data = b""',
    '    while True:',
    '        chunk = os.read(r, 4096)',
    '        if not chunk: break',
    '        data += chunk',
    '    os.close(r)',
    '    os.waitpid(pid, 0)',
    '    sys.stdout.buffer.write(data)',
    '    sys.exit(0)',
    'os.close(r)',
    'os.setsid()',
    'pid2 = os.fork()',
    'if pid2 > 0:',
    '    os._exit(0)',
    'env = {"HOME": home, "PATH": os.environ.get("PATH", "")}',
    'if token:',
    '    env["TEAM_OWNER_APPROVAL"] = token',
    'with open(os.devnull, "rb") as devnull:',
    '    p = subprocess.run([bun_bin, cli_path, "approve"], cwd=cwd, env=env, stdin=devnull, capture_output=True, text=True)',
    'os.write(w, json.dumps({"exit": p.returncode, "out": p.stdout, "err": p.stderr}).encode())',
    'os.close(w)',
    'os._exit(0)',
  ].join('\n');

  for (const candidateToken of ['', token]) {
    const proc = spawnSync(
      'python3',
      ['-c', script, '', root, process.execPath, CLI, home, candidateToken],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
    );
    expect(proc.status).toBe(0);
    const result = JSON.parse(proc.stdout.trim()) as { exit: number; out: string; err: string };
    expect(result.exit).toBe(1);
    expect(result.err).toContain(`team approve: ${DETACHED_REFUSAL}\n`);
    expect(result.out).not.toContain('Approved.');
    expect(findStore(root, home)).toBeNull();
    expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
  }
});
