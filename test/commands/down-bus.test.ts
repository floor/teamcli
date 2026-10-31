// What `team down` does with the event bus `team up` started. The bus's record names the pane
// and the workspace; a real stop closes that workspace after the seats and before the session,
// clears the record, and says `bus: stopped`. A dry run shows the same close in its plan and
// performs none of it; a refused run returns before any step runs, its plan carrying the close
// or not. A bus the owner runs in a terminal of their own is not in the state and is left alone.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-15T11:30:00Z');
const owner = { kind: 'owner' } as const;
const leadSeat = { kind: 'seat', name: 'lead', pane: 'pane-a', session: 'acme' } as const;
const FILE = ['--file', '.agents/team.yaml'];
const BUS = { pane: 'pane-b', workspace: 'w9', started: '2026-10-15T11:00:00Z' };

type Place = { base: string; root: string; home: string; file: string; dir: string };

const LEAD = `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function teamText(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${LEAD}  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function layout(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-down-bus-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const file = join(root, '.agents', 'team.yaml');
  const text = teamText();
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  return { base, root, home, file, dir: join(root, '.agents') };
}

function seedSeat(at: Place): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = { stage: 'ready', pane: 'pane-a', workspace: 'w1' } as never;
  });
}

function seedBus(at: Place): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.bus = { ...BUS };
  });
}

function launchOf(over: Partial<DownLaunch> = {}): DownLaunch {
  return {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => [],
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
    ...over,
  };
}

function sourcesOf(at: Place, over: Partial<DownSources> = {}): { sources: DownSources; closes: [string, string][] } {
  const closes: [string, string][] = [];
  const sources: DownSources = {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['zsh'],
    shellBack: () => true,
    foregroundCwd: () => null,
    now: () => NOW,
    sleep: async () => {},
    home: at.home,
    launch: launchOf({ closeWorkspace: (session, workspace) => { closes.push([session, workspace]); return true; } }),
    ...over,
  };
  return { sources, closes };
}

function stateBus(at: Place) {
  return readState(at.dir).sessions.acme?.bus;
}

let places: Place[] = [];
function place(): Place {
  const made = layout();
  places.push(made);
  return made;
}
afterEach(() => {
  for (const made of places) rmSync(made.base, { recursive: true, force: true });
  places = [];
});

describe('the event bus a stop finds in the state', () => {
  test('a real stop closes its workspace and clears the record', async () => {
    const at = place();
    seedSeat(at);
    seedBus(at);
    const { sources, closes } = sourcesOf(at);
    const io = testIo(at.root, owner);
    expect(await runDown([...FILE], io, sources)).toBe(0);
    expect(closes).toContainEqual(['acme', 'w9']);
    expect(io.out).toContain('bus: stopped');
    expect(stateBus(at)).toBeUndefined();
  });

  test('a dry run prints the close and runs nothing', async () => {
    const at = place();
    seedSeat(at);
    seedBus(at);
    const { sources, closes } = sourcesOf(at);
    const io = testIo(at.root, owner);
    expect(await runDown([...FILE, '--dry-run'], io, sources)).toBe(0);
    expect(io.out).toContain('the event bus');
    expect(io.out).toContain('workspace close w9');
    expect(closes).toEqual([]);
    expect(stateBus(at)).toEqual(BUS);
  });

  test('a refused run closes nothing and keeps the record', async () => {
    const at = place();
    seedSeat(at);
    seedBus(at);
    const { sources, closes } = sourcesOf(at);
    const io = testIo(at.root, leadSeat);
    expect(await runDown(['--abandon'], io, sources)).toBe(1);
    expect(io.err).toContain('only the owner abandons');
    expect(closes).toEqual([]);
    expect(stateBus(at)).toEqual(BUS);
  });
});
