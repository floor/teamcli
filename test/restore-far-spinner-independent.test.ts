// Independent scene for a working seat whose spinner or interrupt line sits more than
// eight rows above an empty idle prompt. Restore (team up) and the live run must not
// close or relaunch it, including when its agent record ties with another record.
// Synthetic home, host, and records only.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { agentsDir, readAgents, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, recordRenames, testIo } from './helpers.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
const TIED_AT = '2026-11-06T12:00:00.000Z';
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'pane-working';
const WORKSPACE = 'ws-working';
const SESSION_ID = 'ses_working';
const RECORD = { stage: 'ready' as const, pane: PANE, workspace: WORKSPACE, launched: { shell: 100, cli: [200] }, agent_session: SESSION_ID };
const RESTORED: PaneProcesses = { shell: 101, foreground: [201] };
const LAUNCH = 'team-deepseek';

const homes: string[] = [];
afterEach(() => {
  discardFixtures(homes.splice(0));
});

function rowsAbovePrompt(screen: string, marker: string): number {
  const lines = screen.split('\n');
  const at = lines.indexOf(marker);
  const open = lines.findIndex((line) => line.startsWith('─'));
  return open - at;
}

/** The captured idle box, emptied, with `marker` more than eight rows above its opening rule. */
function farAbove(marker: string): string {
  const idle = CLAUDE_IDLE.split('\n');
  const open = idle.findIndex((line) => line.startsWith('─'));
  const box = idle.slice(open);
  const prompt = box.findIndex((line) => line.startsWith('❯'));
  box[prompt] = '❯ ';
  const gap = Array.from({ length: 9 }, (_, index) => `finished row ${index + 1}`);
  const screen = [marker, ...gap, ...box].join('\n');
  if (rowsAbovePrompt(screen, marker) <= 8) throw new Error('the marker is inside the eight-row cluster');
  return screen;
}

function tieRecords(home: string): void {
  const dir = agentsDir(home);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue;
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8').replace(/updated_at: .*/g, `updated_at: "${TIED_AT}"`);
    writeFileSync(path, text);
  }
}

function world(screen: string): { root: string; sources: UpSources; typed: string[]; closed: string[]; runs: string[] } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'restore-far-spinner-')));
  homes.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], {
    cwd: root,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin:/usr/local/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: home },
  });
  writeFileSync(join(root, 'README.md'), 'acme\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], {
    cwd: root,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin:/usr/local/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: home },
  });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], {
    cwd: root,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin:/usr/local/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: home },
  });
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
    human: true
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    launch: ${LAUNCH}
`;
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = RECORD;
  });
  const common = {
    name: SEAT,
    signing: { model: 'DeepSeek Flash', version: 'V4.1', role: 'implementer' },
    lab: 'deepseek',
    cli: 'claude-code',
    launcher: null,
    launch: LAUNCH,
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      address: null,
      agent_session: SESSION_ID,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running' as const,
    by: 'team up',
  };
  registerAgent(home, { ...common, reach: { ...common.reach, pane: PANE }, seat_handle: 'seat_0123456789ab' });
  registerAgent(home, { ...common, reach: { ...common.reach, pane: 'pane-other' }, seat_handle: 'seat_abcdefabcdef' });
  tieRecords(home);
  const tied = readAgents(home).filter((agent) => agent.reach.seat === SEAT);
  if (tied.length !== 2 || tied[0]?.provenance.updated_at !== tied[1]?.provenance.updated_at) {
    throw new Error('the two agent records do not tie');
  }

  const typed: string[] = [];
  const closed: string[] = [];
  const runs: string[] = [];
  let exited = false;
  const agents = (): HerdrAgent[] => [{
    name: null,
    agent: 'claude',
    pane: PANE,
    workspace: WORKSPACE,
    status: 'idle',
    cwd: root,
    session: SESSION_ID,
  }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'made-watch', workspace: 'ws-watch' }),
    paneRun: (_session, _pane, command) => {
      runs.push(command);
      return true;
    },
    typeText: (_session, _pane, line) => {
      typed.push(line);
      if (line === '/exit') exited = true;
      return true;
    },
    pressEnter: () => true,
    renameWorkspace: () => true,
    renameAgent: () => true,
    closeWorkspace: (_session, workspace) => {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE],
    agents,
    workspacePanes: () => [PANE],
    paneText: () => screen,
    foreground: () => ['claude'],
    processInfo: () => (exited ? { shell: RESTORED.shell, foreground: [RESTORED.shell] } : RESTORED),
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  const sources: UpSources = {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents,
    workspaces: () => [{ id: WORKSPACE, label: SEAT }],
    home,
    doctor,
    launch,
    now: () => NOW,
  };
  return { root, sources, typed, closed, runs };
}

async function restore(marker: string): Promise<{ out: string; typed: string[]; closed: string[]; runs: string[] }> {
  const made = world(farAbove(marker));
  const run = testIo(made.root, { kind: 'owner' });
  const code = await runUp([], run, made.sources);
  return { out: `${run.out}\n${run.err}\nexit ${code}`, typed: made.typed, closed: made.closed, runs: made.runs };
}

test('a spinner more than eight rows above an empty prompt is not closed or relaunched', async () => {
  const marker = '✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)';
  expect(rowsAbovePrompt(farAbove(marker), marker)).toBeGreaterThan(8);
  const out = await restore(marker);
  expect(out.typed).toEqual([]);
  expect(out.closed).toEqual([]);
  expect(out.runs.some((command) => command.includes(LAUNCH))).toBe(false);
  expect(out.out).toContain('nothing closed');
});

test('an interrupt line more than eight rows above an empty prompt is not closed or relaunched', async () => {
  const marker = 'esc to interrupt';
  expect(rowsAbovePrompt(farAbove(marker), marker)).toBeGreaterThan(8);
  const out = await restore(marker);
  expect(out.typed).toEqual([]);
  expect(out.closed).toEqual([]);
  expect(out.runs.some((command) => command.includes(LAUNCH))).toBe(false);
  expect(out.out).toContain('nothing closed');
});
