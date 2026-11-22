// A seat whose inherited rules name `{root}` or `{worktrees}` this machine cannot fill is refused
// before anything about it changes (src/launch/rules.ts `inheritedRulesProblem`): `team restart`
// leaves the running seat running with its record as it was, and `team reload` closes nothing,
// writes no brief or hook and never says "reloaded". The rule here is the registry home project's
// (the team file names no `in_project`), the one source only the launch composes. Synthetic
// fixtures only: no live terminal host, registry or store is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-14T12:00:00Z');
const OWNER = { kind: 'owner' as const };

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    channel: off
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Fixture = { root: string; home: string; dir: string };

/** One team in a checkout, its registry record naming the home project `site`, whose rules name
 *  `{root}`: the team file itself writes no word, and names no entity to fill it from. */
function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'rw-gate-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(join(dir, 'team.yaml'), TEAM.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`));
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, projectId: 'site', at: NOW.toISOString() });
  writeFileSync(join(home, '.config', 'team', 'projects.yaml'), 'projects:\n  site:\n    name: site\n    rules:\n      - "Never edit {root}/production."\n');
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', launched: { shell: 1, cli: [2] }, presence_binding: 'prs_000000000001' };
  });
  return { root, home, dir };
}

/** A terminal host where both seats sit idle; every close, workspace and line is counted. */
function host(f: Fixture): { upLaunch: Launch; downLaunch: DownLaunch; did: { closed: string[]; created: number; runs: string[] } } {
  const did = { closed: [] as string[], created: 0, runs: [] as string[] };
  const agents = (): HerdrAgent[] => [
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: f.root },
    { name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: f.root },
  ];
  const downLaunch: DownLaunch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      did.created += 1;
      return { pane: `pane-new-${did.created}`, workspace: `ws-new-${did.created}` };
    },
    paneRun(_session, _pane, command) {
      did.runs.push(command);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    workspacePanes: (_session, workspace) => (workspace === 'ws-old' ? ['pane-old'] : workspace === 'ws-lead' ? ['pane-lead'] : []),
    paneText: () => CLAUDE_IDLE,
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: () => 'idle',
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async () => {},
    now: () => NOW,
  };
  return { upLaunch, downLaunch, did };
}

const PROBLEM = "worker: its entity's or project's rules write {root} or {worktrees}, and the team names no entity";

describe('a seat whose inherited rules name a folder this machine cannot fill', () => {
  test('team restart refuses before stopping it: the seat keeps running and its record is unchanged', async () => {
    const f = fixture();
    const { upLaunch, downLaunch, did } = host(f);
    const before = readState(f.dir).sessions.acme?.seats.worker;
    const doctor: DoctorSources = {
      version: () => '2.1.288', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1',
      sessionRunning: () => true, now: () => NOW, home: f.home,
    } as DoctorSources;
    const sources: RestartSources = {
      home: f.home,
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => upLaunch.agents('acme'),
      workspaces: () => [{ id: 'ws-lead' }, { id: 'ws-old' }],
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: () => claudeBox(''),
      status: () => 'idle',
      foreground: () => ['claude'],
      standing: () => ({ kind: 'none' }),
      launch: downLaunch,
      upLaunch,
      doctor,
      sleep: async () => {},
      now: () => NOW,
    } as RestartSources;
    const io = testIo(f.root, OWNER);
    const code = await runRestart(['worker'], io, sources);
    expect(code, `${io.err}${io.out}`).not.toBe(0);
    expect(`${io.err}${io.out}`).toContain(PROBLEM);
    expect(did).toEqual({ closed: [], created: 0, runs: [] });
    expect(readState(f.dir).sessions.acme?.seats.worker).toEqual(before);
  });

  test('team reload refuses before the brief, the hook or the close, says no "reloaded", and keeps the binding', async () => {
    const f = fixture();
    // A drift reload acts on: the record names another model than the file.
    updateState(f.dir, (state) => {
      const seat = state.sessions.acme!.seats.worker!;
      seat.model = 'Claude Sonnet';
      seat.version = '5.5';
    });
    const before = readState(f.dir).sessions.acme?.seats.worker;
    const { upLaunch, did } = host(f);
    const sources: ReloadSources = { launch: upLaunch, home: f.home, now: () => NOW } as ReloadSources;
    const io = testIo(f.root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, `${io.err}${io.out}`).toBe(1);
    expect(io.err).toContain(`${PROBLEM}; nothing closed`);
    expect(io.out).not.toContain('reloaded');
    expect(did).toEqual({ closed: [], created: 0, runs: [] });
    expect(readState(f.dir).sessions.acme?.seats.worker).toEqual(before);
  });
});
