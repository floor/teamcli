// The boundaries of `team reload` the happy paths do not cross: a seat that moved or
// vanished before the close, a seat that turned working between the drift read and the
// close, the granted seat's --file, and another run's lock.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { acquireRunLock } from '../src/launch/run-lock.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readScreen } from '../src/watch/screen.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = CLAUDE_IDLE;
const WORKING = `${'─'.repeat(40)}\n❯ \nesc to interrupt\n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const OWNER = { kind: 'owner' as const };
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'alpha' };

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function seat(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '    effort: high',
    '    mode: shared',
    '    cwd: .',
  ].join('\n');
}

function teamYaml(scope: string[] | null = ['reload']): string {
  const grantBlock = scope === null
    ? ''
    : `grant:\n  session: alpha\n  seat: lead\n  scope:\n${scope.map((act) => `    - ${act}`).join('\n')}\n`;
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${seat('lead', 'coordinator')}
${seat('worker', 'implementer')}
${grantBlock}`;
}

function approve(text = teamYaml()): void {
  const path = join(dir, 'team.yaml');
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function remember(name: string, effort: string): void {
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
    session.seats[name] = {
      stage: 'ready',
      pane: `${name}-pane`,
      workspace: `${name}-ws`,
      cli: 'claude-code',
      launched: { shell: 1, cli: [2] },
      model: 'Claude Opus',
      version: '5.5',
      launch_line: 'claude --model claude-opus-5-5',
      effort,
    };
  });
}

function logText(): string {
  try {
    return readFileSync(join(dir, 'team.log'), 'utf8');
  } catch {
    return '';
  }
}

// The herdr double. `workerPane` overrides where the listing shows the worker (a seat that
// moved); `present` drops it from the listing entirely; `workingFromRead` makes the worker's
// pane read idle until that many reads, then working — the seat turns busy between the drift
// read and the close.
function harness(options: { workerPane?: string; present?: boolean; workingFromRead?: number } = {}): {
  sources: ReloadSources;
  closed: string[];
} {
  const panes = new Map<string, string>();
  const closed: string[] = [];
  let reads = 0;
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      panes.set(`made-${n}`, IDLE);
      return { pane: `made-${n}`, workspace: `ws-${n}` };
    },
    paneRun(_session, pane) {
      panes.set(pane, IDLE);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => options.present === false ? [] : [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      {
        name: 'worker', agent: 'claude', pane: options.workerPane ?? 'worker-pane',
        workspace: 'worker-ws', status: 'idle', cwd: null,
      },
    ] satisfies HerdrAgent[],
    workspacePanes(_session, workspace) {
      if (workspace === 'lead-ws') return ['lead-pane'];
      if (workspace === 'worker-ws') return ['worker-pane'];
      return [`made-${n}`];
    },
    paneText(_session, pane) {
      if (pane === 'worker-pane' && options.workingFromRead !== undefined) {
        reads += 1;
        return reads >= options.workingFromRead ? WORKING : IDLE;
      }
      return panes.get(pane) ?? IDLE;
    },
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async () => {},
    now: () => NOW,
  };
  return { sources: { launch, home, now: () => NOW }, closed };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reload-b-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  // An empty first commit needs an identity the fixture owns; the README gives git something to add.
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team reload boundaries', () => {
  test('a seat that moved, or vanished from the listing, closes nothing and keeps its record', async () => {
    remember('worker', 'low');
    for (const options of [{ workerPane: 'worker-pane-2' }, { present: false }] as const) {
      const { sources, closed } = harness(options);
      const io = testIo(root, OWNER);
      const code = await runReload(['worker'], io, sources);
      expect(code).toBe(1);
      expect(io.err).toBe('team reload: the seat changed before it closed; nothing relaunched\n');
      expect(closed).toEqual([]);
      expect(logText()).toBe('');
      const stored = readState(dir).sessions.alpha?.seats.worker;
      expect({ stage: stored?.stage, effort: stored?.effort }).toEqual({ stage: 'ready', effort: 'low' });
    }
  });

  test('a seat that turns working between the drift read and the close is not closed', async () => {
    if (readScreen('claude-code', WORKING).kind !== 'working') {
      throw new Error('the fixture screen must read as working');
    }
    remember('worker', 'low');
    // The first read (the drift pre-check) sees the idle prompt; the repair's fresh read, made
    // right before the close, sees a running turn.
    const { sources, closed } = harness({ workingFromRead: 2 });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('team reload: the seat changed before it closed; nothing relaunched\n');
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
    const stored = readState(dir).sessions.alpha?.seats.worker;
    expect({ stage: stored?.stage, effort: stored?.effort }).toEqual({ stage: 'ready', effort: 'low' });
  });

  test('the granted seat cannot point --file elsewhere, and the team file itself is not elsewhere', async () => {
    remember('lead', 'high');
    remember('worker', 'low');

    const foreign = harness();
    const foreignIo = testIo(root, LEAD);
    const foreignCode = await runReload(['worker', '--file', 'other.yaml'], foreignIo, foreign.sources);
    expect(foreignCode).toBe(1);
    expect(foreignIo.err).toBe('team reload: --file is the owner\'s; the granted seat cannot use it\n');
    expect(foreign.closed).toEqual([]);
    expect(logText()).toBe('');

    const own = harness();
    const ownIo = testIo(root, LEAD);
    const ownCode = await runReload(['worker', '--file', '.agents/team.yaml'], ownIo, own.sources);
    expect(ownCode).toBe(0);
    expect(ownIo.err).toBe('');
    expect(own.closed).toEqual(['worker-ws']);
    expect(logText()).toContain('grant [grant] lead reload: worker effort');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('high');
  });

  test('while another session-mutating run holds the lock, nothing closes', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness();
    const lock = acquireRunLock(dir, 'alpha');
    expect('release' in lock).toBe(true);
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('another session-mutating run is holding session alpha');
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
    if (!('release' in lock)) throw new Error('the fixture holds the run lock');
    lock.release();
  });
});
