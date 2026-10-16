// `team reload` closes a drifted seat at an idle prompt and launches the file's line again. The
// boundaries of that close: a dialog, a question or a shell is never closed over, and herdr's
// idle word is not enough — the screen decides. The close re-reads herdr itself: a seat that
// turned busy between the check and the close, or whose pane holds a process team did not
// launch, closes nothing. A version drift is a model drift; an effort dropped from the file is a
// drift that leaves no effort behind. A second reload after a successful one finds nothing to
// do. Only the seat named closes — a drifted lead beside it keeps running — and the relaunch
// runs the file's current launch line.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const IDLE = CLAUDE_IDLE;
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const question = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const permission = `Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`;

let base: string;
let root: string;
let dir: string;
let home: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, stdio: 'ignore', env: gitEnv(),
  });
}

// The worker with its effort line, launch line and stopping flag optional: the scenes rewrite
// the file the record was launched from.
function seat(name: string, options: { effort?: string; stopped?: boolean; launch?: string } = {}): string {
  return [
    `  - role: ${name === 'lead' ? 'coordinator' : 'implementer'}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    `    launch: ${options.launch ?? 'claude --model claude-opus-5-5'}`,
    ...(options.effort ? [`    effort: ${options.effort}`] : []),
    ...(options.stopped ? ['    stopped: true'] : []),
    '    mode: shared',
    '    cwd: .',
  ].join('\n');
}

function teamYaml(worker: ReturnType<typeof seat> = seat('worker', { effort: 'high' })): string {
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
${seat('lead', { effort: 'high' })}
${worker}
`;
}

function approve(text = teamYaml()): void {
  const path = join(dir, 'team.yaml');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function remember(name: string, effort: string | undefined, version = '5.5'): void {
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
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

function harness(options: {
  status?: string;
  text?: string;
  create?: boolean;
  processes?: { shell: number; foreground: number[] };
  flipAfterFirstRead?: boolean;
} = {}): { sources: ReloadSources; closed: string[]; commands: string[] } {
  const panes = new Map<string, string>();
  const closed: string[] = [];
  const commands: string[] = [];
  let clock = NOW.getTime();
  let n = 0;
  let readsOfRecorded = 0;
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
      panes.set(pane, IDLE);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: options.status ?? 'idle', cwd: null },
    ] satisfies HerdrAgent[],
    workspacePanes(_session, workspace) {
      if (workspace === 'lead-ws') return ['lead-pane'];
      if (workspace === 'worker-ws') return ['worker-pane'];
      return [`made-${n}`];
    },
    paneText(_session, pane) {
      if (pane === 'worker-pane' && options.flipAfterFirstRead) {
        // The check read an idle prompt; the close reads again, and the seat has turned.
        readsOfRecorded += 1;
        return readsOfRecorded === 1 ? IDLE : busy;
      }
      return panes.get(pane) ?? options.text ?? IDLE;
    },
    foreground: () => ['claude'],
    processInfo: () => options.processes ?? { shell: 1, foreground: [1, 2] },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { sources: { launch, home, now: () => new Date(clock) }, closed, commands };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reload-bounds-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  chmodSync(join(home, '.config', 'team', 'lobby'), 0o700);
  mkdirSync(dir, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the screen the close demands', () => {
  test('a question and a permission dialog are never closed over', async () => {
    for (const screen of [question, permission]) {
      remember('worker', 'low');
      const { sources, closed } = harness({ text: screen });
      const io = testIo(root, OWNER);
      const code = await runReload(['worker'], io, sources);
      expect(code, io.out + io.err).toBe(1);
      expect(io.err).toContain('not at an idle prompt');
      expect(closed).toEqual([]);
      expect(logText()).toBe('');
      expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
    }
  });

  test('a shell prompt is never closed over', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ text: 'jvial@mac acme % ' });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('not at an idle prompt');
    expect(closed).toEqual([]);
  });

  test('herdr\'s idle word is not enough: a screen mid-turn refuses; done at an idle prompt closes', async () => {
    remember('worker', 'low');
    const midTurn = harness({ status: 'idle', text: busy });
    const io = testIo(root, OWNER);
    expect(await runReload(['worker'], io, midTurn.sources)).toBe(1);
    expect(io.err).toContain('is working; nothing closed');
    expect(midTurn.closed).toEqual([]);
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
    // A finished turn at an empty prompt is free to close.
    const done = harness({ status: 'done' });
    const second = testIo(root, OWNER);
    expect(await runReload(['worker'], second, done.sources)).toBe(0);
    expect(done.closed).toEqual(['worker-ws']);
  });
});

describe('what counts as drift', () => {
  test('a version drift is a model drift: it closes and stores the file\'s version', async () => {
    remember('worker', 'high', '5.4');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('reload [owner] worker: model');
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ model: 'Claude Opus', version: '5.5', effort: 'high' });
  });

  test('an effort dropped from the file is a drift, and no effort remains in the record after', async () => {
    approve(teamYaml(seat('worker')));
    remember('worker', 'low');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('reload [owner] worker: effort');
    const stored = readState(dir).sessions.alpha?.seats.worker;
    expect(stored?.effort).toBeUndefined();
    expect(stored).toMatchObject({ model: 'Claude Opus', version: '5.5' });
  });
});

describe('the close re-reads herdr', () => {
  test('a seat that turned busy between the check and the close is never closed', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ flipAfterFirstRead: true });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(1);
    expect(io.err).toContain('the seat changed before it closed');
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });

  test('a pane whose process was replaced is never closed', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ processes: { shell: 1, foreground: [9] } });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(1);
    expect(io.err).toContain('the seat changed before it closed');
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });
});

describe('after a reload', () => {
  test('a second reload finds nothing to do: the record now runs what the file declares', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness();
    const first = testIo(root, OWNER);
    expect(await runReload(['worker'], first, sources)).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    const second = testIo(root, OWNER);
    const code = await runReload(['worker'], second, sources);
    expect(code, second.out + second.err).toBe(0);
    expect(second.out).toContain('already running what the file declares');
    expect(closed).toEqual(['worker-ws']);
  });

  test('a seat stopped in the file is never relaunched', async () => {
    approve(teamYaml(seat('worker', { effort: 'high', stopped: true })));
    remember('worker', 'low');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(1);
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
  });
});

describe('only the seat that was named', () => {
  test('a drifted lead beside the named seat is left running', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(readState(dir).sessions.alpha?.seats.lead?.effort).toBe('low');
    expect(logText()).toContain('reload [owner] worker: effort');
    expect(logText()).not.toContain('lead');
  });
});

describe('the line the relaunch runs', () => {
  test('the file\'s current launch line, not the one the record was launched with', async () => {
    const line = 'claude --model claude-opus-5-5 --reasoning high';
    approve(teamYaml(seat('worker', { effort: 'high', launch: line })));
    remember('worker', 'low');
    const { sources, closed, commands } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    // The pane runs the file's line, wrapped with the unattended environment and the rules.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(line);
    expect(readState(dir).sessions.alpha?.seats.worker?.launch_line).toContain(line);
  });
});
