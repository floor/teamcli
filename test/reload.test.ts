// A drifted model or effort is closed only at an idle prompt, then launched again. A ready
// seat that `up` leaves alone keeps the launch record, including a lead.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = CLAUDE_IDLE;
const OWNER = { kind: 'owner' as const };
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'alpha' };

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function seat(name: string, role: string, effort: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    `    effort: ${effort}`,
    '    mode: shared',
    '    cwd: .',
  ].join('\n');
}

function teamYaml(scope: string[]): string {
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
${seat('lead', 'coordinator', 'high')}
${seat('worker', 'implementer', 'high')}
grant:
  session: alpha
  seat: lead
  scope:
${scope.map((act) => `    - ${act}`).join('\n')}
`;
}

function approve(text = teamYaml(['reload'])): void {
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

function remember(name: string, effort: string | undefined, version = '5.5'): void {
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats[name] = {
      stage: 'ready',
      pane: `${name}-pane`,
      workspace: `${name}-ws`,
      cli: 'claude-code',
      launched: { shell: 1, cli: [2] },
      model: 'Claude Opus',
      version,
      launch_line: 'claude --model claude-opus-5-5',
      ...(effort === undefined ? {} : { effort }),
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

function harness(options: { status?: string; text?: string; create?: boolean; present?: boolean } = {}): {
  sources: ReloadSources;
  closed: string[];
  commands: string[];
} {
  const panes = new Map<string, string>();
  const closed: string[] = [];
  const commands: string[] = [];
  let clock = NOW.getTime();
  let n = 0;
  const text = options.text ?? IDLE;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      if (options.create === false) return null;
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, IDLE);
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane, command) {
      commands.push(command);
      // The relaunched CLI draws its own model on the status row.
      panes.set(pane, command.includes('sonnet') ? IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5') : IDLE);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => options.present === false ? [] : [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: options.status ?? 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: options.status ?? 'idle', cwd: null },
    ] satisfies HerdrAgent[],
    workspacePanes(_session, workspace) {
      if (workspace === 'lead-ws') return ['lead-pane'];
      if (workspace === 'worker-ws') return ['worker-pane'];
      return [`made-${n}`];
    },
    paneText(_session, pane) {
      return panes.get(pane) ?? text;
    },
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { sources: { launch, home, now: () => new Date(clock) }, closed, commands };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reload-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team reload', () => {
  test('an effort-only edit at an idle prompt closes once and stores the new effort', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    const stored = readState(dir).sessions.alpha?.seats.worker;
    expect({ code, closed, effort: stored?.effort, model: stored?.model, line: logText() }).toEqual({
      code: 0,
      closed: ['worker-ws'],
      effort: 'high',
      model: 'Claude Opus',
      line: expect.stringContaining('reload [owner] worker: effort'),
    });
    expect(logText().match(/reload \[owner\] worker: effort/g)).toHaveLength(1);
  });

  test('model and effort together are one close and one line naming both', async () => {
    remember('worker', 'low', '5.4');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('reload [owner] worker: model; effort');
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ effort: 'high', version: '5.5' });
  });

  test('unsent text closes nothing and writes no log', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ text: claudeBox('draft') });
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(1);
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });

  test('a working seat closes nothing and writes no log', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ status: 'working' });
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(1);
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
  });

  test('a matching record exits 0 and writes nothing', async () => {
    remember('worker', 'high');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err, closed, log: logText() }).toEqual({ code: 0, err: '', closed: [], log: '' });
    expect(io.out).toContain('already running what the file declares');
  });

  test('a ready seat with no recorded model is refused', async () => {
    updateState(dir, (file) => {
      (file.sessions.alpha ??= emptySession()).seats.worker = {
        stage: 'ready', pane: 'worker-pane', workspace: 'worker-ws', launched: { shell: 1, cli: [2] },
      };
    });
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('were not recorded at launch');
    expect(closed).toEqual([]);
  });

  test('the owner reloads a lead that up left ready', async () => {
    remember('lead', 'low');
    remember('worker', 'high');
    const closed: string[] = [];
    const up: UpSources = {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
        { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
      ],
      alive: () => true,
      home,
      now: () => NOW,
      launch: {
        sessionState: () => 'running',
        startServer: () => false,
        sessionUp: () => true,
        createWorkspace: () => null,
        paneRun: () => false,
        renameAgent: () => false,
        closeWorkspace(_session, workspace) {
          closed.push(workspace);
          return true;
        },
        agentPanes: () => [],
        agents: () => [],
        paneText: () => IDLE,
        foreground: () => ['claude'],
        sleep: async () => {},
        now: () => NOW,
      },
    };
    const upCode = await runUp([], testIo(root, OWNER), up);
    expect(upCode).toBe(0);
    expect(closed).toEqual([]);
    expect(readState(dir).sessions.alpha?.seats.lead?.effort).toBe('low');
    const { sources, closed: reclosed } = harness();
    const code = await runReload(['lead'], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    expect(reclosed).toEqual(['lead-ws']);
    expect(readState(dir).sessions.alpha?.seats.lead?.effort).toBe('high');
  });

  test('a granted reload of the caller is refused, and a grant of up does not include reload', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const self = harness();
    const selfIo = testIo(root, LEAD);
    expect(await runReload(['lead'], selfIo, self.sources)).toBe(1);
    expect(selfIo.err).toContain('does not close the caller\'s seat');
    expect(self.closed).toEqual([]);
    approve(teamYaml(['up']));
    const scope = harness();
    const scopeIo = testIo(root, LEAD);
    expect(await runReload(['worker'], scopeIo, scope.sources)).toBe(1);
    expect(scopeIo.err).toContain('does not list `reload`');
    expect(scope.closed).toEqual([]);
    expect(logText()).toBe('');
  });

  test('a granted reload runs the live file\'s edited launch line with no approval of the edit', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const line = 'claude --model claude-sonnet-5-5';
    const text = readFileSync(join(dir, 'team.yaml'), 'utf8')
      .replaceAll('model: Claude Opus', 'model: Claude Sonnet')
      .replaceAll('launch: claude --model claude-opus-5-5', `launch: ${line}`);
    writeFileSync(join(dir, 'team.yaml'), text);
    const { sources, closed, commands } = harness();
    const io = testIo(root, LEAD);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(line);
    expect(readState(dir).sessions.alpha?.seats.worker?.launch_line).toContain(line);
    expect(logText()).toContain('grant [grant] lead reload: worker model');
  });

  test('a granted reload of another seat logs the grant and the difference', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, LEAD), sources);
    expect(code).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('grant [grant] lead reload: worker effort');
    expect(logText()).not.toContain('reload [owner]');
  });

});
