// The granted orchestrator's `remove --keep` may close, without typing, a seat a quota
// screen holds or one whose box holds team's own unsent trigger line — the close `remove
// --abandon` makes. Every other caller keeps today's rule, the owner's own unsent text is
// refused, and a working seat is refused for everyone.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readScreen } from '../src/watch/screen.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T09:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const RATE = `API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00\n${IDLE}`;
const OWNER = { kind: 'owner' as const };
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'alpha' };

let base: string;
let root: string;
let dir: string;
let home: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, stdio: 'ignore', env: gitEnv(),
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

function teamYaml(scope: string[] | null = ['up', 'down', 'reload']): string {
  const grantBlock = scope === null
    ? ''
    : `grant:\n  session: alpha\n  seat: lead\n  scope:\n${scope.map((act) => `    - ${act}`).join('\n')}\n`;
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${join(home, '.config', 'team', 'lobby')}
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

function remember(name: string, pane: string): void {
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
    session.seats[name] = {
      stage: 'ready',
      pane,
      workspace: `${name}-ws`,
      cli: 'claude-code',
      launched: { shell: 1, cli: [2] },
      model: 'Claude Opus',
      version: '5.5',
      launch_line: 'claude --model claude-opus-5-5',
      effort: 'high',
      id: `${name}-id`,
    };
  });
}

// The remove double. `text` is the worker pane's screen; `status` is herdr's word for it.
// `typed` records every key this run sent: the close without typing must leave it empty.
function harness(options: { text?: string; status?: string } = {}): {
  sources: RemoveSources;
  closed: string[];
  typed: string[];
} {
  const closed: string[] = [];
  const typed: string[] = [];
  const text = options.text ?? IDLE;
  const status = options.status ?? 'blocked';
  const launch: DownLaunch = {
    typeText(_session, pane, line) {
      typed.push(`${pane}: ${line}`);
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      typed.push(`${pane}: <enter>`);
      return true;
    },
    agentPanes: () => ['lead-pane', 'worker-pane'],
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: RemoveSources = {
    sessionRunning: () => true,
    agents: () => [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status, cwd: null },
    ] satisfies HerdrAgent[],
    alive: () => true,
    screen: (_session, _pane, cli) => readScreen(cli, text),
    screenText: () => text,
    status: () => status,
    foreground: () => ['claude'],
    shellBack: () => null,
    now: () => NOW,
    home,
    launch,
  };
  return { sources, closed, typed };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-remove-unasked-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the granted orchestrator\'s remove --keep', () => {
  test('a quota screen is closed without typing and stopped in the file', async () => {
    if (readScreen('claude-code', RATE).kind !== 'rate limit') {
      throw new Error('the fixture screen must read as a rate limit');
    }
    remember('lead', 'lead-pane');
    remember('worker', 'worker-pane');
    const { sources, closed, typed } = harness({ text: RATE });
    const io = testIo(root, LEAD);
    const code = await runRemove(['worker', '--keep'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(typed).toEqual([]);
    expect(readFileSync(join(dir, 'team.yaml'), 'utf8')).toContain('stopped: true');
    expect(readState(dir).sessions.alpha?.seats.worker).toBeUndefined();
  });

  test('a box holding team\'s own unsent trigger line is closed without typing', async () => {
    remember('lead', 'lead-pane');
    remember('worker', 'worker-pane');
    const dropDir = join(dir, 'send-drops', 'alpha', 'worker');
    mkdirSync(dropDir, { recursive: true });
    const dropPath = join(dropDir, '6f2c7d30-2222-4c5d-8e9f-0a1b2c3d4e5f');
    writeFileSync(dropPath, 'the brief itself\n');
    const { sources, closed, typed } = harness({
      text: claudeBox(`Read ${dropPath} and do that.`),
      status: 'idle',
    });
    const io = testIo(root, LEAD);
    const code = await runRemove(['worker', '--keep'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(typed).toEqual([]);
    expect(readFileSync(join(dir, 'team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('the owner\'s own unsent text keeps the refusal', async () => {
    remember('lead', 'lead-pane');
    remember('worker', 'worker-pane');
    // herdr says blocked: not idle or done, so the non-owner's leave is out too — the box is
    // named and nothing is closed.
    const { sources, closed, typed } = harness({ text: claudeBox('draft the release notes') });
    const io = testIo(root, LEAD);
    const code = await runRemove(['worker', '--keep'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('holds unsent text');
    expect(closed).toEqual([]);
    expect(typed).toEqual([]);
  });

  test('a working seat keeps the refusal', async () => {
    remember('lead', 'lead-pane');
    remember('worker', 'worker-pane');
    const { sources, closed, typed } = harness({ status: 'working' });
    const io = testIo(root, LEAD);
    const code = await runRemove(['worker', '--keep'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('is working');
    expect(closed).toEqual([]);
    expect(typed).toEqual([]);
  });

  test('a caller the grant does not name keeps today\'s quota refusal', async () => {
    approve(teamYaml(null));
    remember('lead', 'lead-pane');
    remember('worker', 'worker-pane');
    const { sources, closed, typed } = harness({ text: RATE });
    const io = testIo(root, LEAD);
    const code = await runRemove(['worker', '--keep'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('is blocked at a prompt');
    expect(closed).toEqual([]);
    expect(typed).toEqual([]);
  });
});
