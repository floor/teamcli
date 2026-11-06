// A Grok or Cursor reload with no recorded start folder is refused before the brief, the
// state, the inbox, or the hook file. A recorded task worktree is not that folder. A seat
// that has its own recorded folder still reloads, and any other CLI is left on the old path.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import type { Launch } from '../src/commands/up.ts';
import { readState, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, recordRenames, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T22:40:00Z');
const SEAT = 'scout';
const SESSION = 'studio';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-ws-scout';
const REPAIR = 'set the seat cwd to its own worktree or clone and restart it in a new workspace';

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = undefined;
});

type Cli = 'grok' | 'cursor' | 'codex';
type Mode = 'noop' | 'missing' | 'own';

function modelOf(cli: Cli): { model: string; version: string; launch: string } {
  if (cli === 'codex') return { model: 'Codex', version: '1', launch: 'codex' };
  if (cli === 'cursor') return { model: 'Grok', version: '4.7', launch: 'cursor-agent' };
  return { model: 'Grok', version: '4.7', launch: 'grok' };
}

function scene(cli: Cli, mode: Mode): {
  root: string;
  dir: string;
  run: () => Promise<number>;
  io: ReturnType<typeof testIo>;
  inbox: string[];
  closed: string[];
  commands: string[];
  hook: string;
  planted: string;
} {
  scratch = fixtureBase('reload-unrecorded-');
  const root = join(scratch, 'project');
  const home = join(scratch, 'home');
  const own = join(scratch, 'own-tree');
  const lobby = join(home, '.config', 'team', 'lobby');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(own, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: root, env: gitEnv(),
  });
  const declared = modelOf(cli);
  const text = [
    'format: 1',
    'project: acme',
    `coordinator: ${SEAT}`,
    `operator: ${SEAT}`,
    `session: ${SESSION}`,
    'workspace:',
    '  mode: shared',
    'trust:',
    `  - ${lobby}`,
    `  - ${root}`,
    'seats:',
    '  - role: implementer',
    `    name: ${SEAT}`,
    `    cli: ${cli}`,
    '    vendor: test',
    `    model: ${declared.model}`,
    `    version: "${declared.version}"`,
    `    launch: ${declared.launch}`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'team.yaml'), text, { mode: 0o600 });
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= { seats: {}, worktrees: {} });
    session.seats[SEAT] = {
      stage: 'ready',
      pane: PANE,
      workspace: WORKSPACE,
      cli,
      launched: { shell: 1, cli: [2] },
      ...(mode === 'missing' ? {} : { model: declared.model, version: declared.version }),
      ...(mode === 'own' ? { start_cwd: own } : {}),
    };
    if (mode !== 'own') {
      session.worktrees.task = { seat: SEAT, path: own, branch: 'fix/own', setup: 'ok' };
    }
  });
  const hook = join(dir, 'hooks', SESSION, `${SEAT}.json`);
  const planted = '{"kept":true}\n';
  if (mode !== 'own' && cli !== 'codex') {
    mkdirSync(dirname(hook), { recursive: true, mode: 0o700 });
    writeFileSync(hook, planted, { mode: 0o600 });
  }
  const inbox: string[] = [];
  const closed: string[] = [];
  const commands: string[] = [];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'fixture-pane-two', workspace: 'fixture-ws-other' }),
    paneRun: (_session, _pane, command) => {
      commands.push(command);
      return true;
    },
    registerInbox: () => {
      inbox.push('inbox');
      return { ok: true };
    },
    renameAgent: () => true,
    closeWorkspace: (_session, workspace) => {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE],
    agents: () => [{ name: SEAT, agent: cli, pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: null }],
    workspacePanes: () => [PANE],
    paneText: () => '',
    foreground: () => [cli],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);
  const sources: ReloadSources = { launch, home, now: () => NOW };
  const io = testIo(root, { kind: 'owner' });
  return {
    root, dir, io, inbox, closed, commands, hook, planted,
    run: () => runReload([SEAT], io, sources),
  };
}

function untouched(made: ReturnType<typeof scene>, before: string): void {
  expect(made.inbox).toEqual([]);
  expect(made.closed).toEqual([]);
  expect(made.commands).toEqual([]);
  expect(JSON.stringify(readState(made.dir))).toBe(before);
  expect(readFileSync(made.hook, 'utf8')).toBe(made.planted);
  expect(existsSync(join(made.root, '.agents', 'send-drops'))).toBe(false);
  expect(existsSync(join(made.dir, 'team.log'))).toBe(false);
}

for (const cli of ['grok', 'cursor'] as const) {
  for (const mode of ['noop', 'missing'] as const) {
    test(`${cli} ${mode} reload with no recorded start folder is refused before any write`, async () => {
      const made = scene(cli, mode);
      const before = JSON.stringify(readState(made.dir));
      expect(await made.run(), made.io.out + made.io.err).toBe(1);
      expect(made.io.out).toBe('');
      expect(made.io.err).toContain('no recorded start folder');
      expect(made.io.err).toContain(REPAIR);
      untouched(made, before);
    });
  }
}

test('a grok seat with its own recorded start folder still reloads', async () => {
  const made = scene('grok', 'own');
  expect(await made.run(), made.io.out + made.io.err).toBe(0);
  expect(made.io.out).toContain('already running what the file declares');
  expect(made.io.err).not.toContain('no recorded start folder');
  expect(made.inbox).toEqual(['inbox']);
  expect(made.closed).toEqual([]);
  expect(made.commands).toEqual([]);
});

test('a codex seat with no recorded start folder still reloads', async () => {
  const made = scene('codex', 'noop');
  expect(await made.run(), made.io.out + made.io.err).toBe(0);
  expect(made.io.out).toContain('already running what the file declares');
  expect(made.io.err).not.toContain('no recorded start folder');
  expect(made.inbox).toEqual([]);
  expect(made.closed).toEqual([]);
  expect(made.commands).toEqual([]);
});
