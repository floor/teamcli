// `team down --session <other>` and the registry: the team's lifecycle is keyed by the session the
// registry addresses the team in (the one `up --session x` recorded), and an agent is ended only by
// a stop of the session it lives in.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { getAgent } from '../src/registry/agents.ts';
import { registerEnd, registerLaunch, type RegistryTeam } from '../src/registry/sync.ts';
import { getTeam, teamIdOf } from '../src/registry/teams.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T02:00:00Z');

const SEAT = (name: string, role: string, extra = ''): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;

function teamYaml(root: string): string {
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
${SEAT('lead', 'coordinator')}
${SEAT('worker', 'implementer')}`;
}

type Fixture = { root: string; home: string; file: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-down-session-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, teamYaml(root));
  return { root, home, file, dir };
}

function registryOf(fixture: Fixture, session?: string): RegistryTeam {
  const parsed = validateTeamFile(teamYaml(fixture.root), { home: fixture.home, root: fixture.root });
  if (!parsed.ok) throw new Error('fixture team does not validate');
  return { home: fixture.home, team: parsed.team, root: fixture.root, by: 'owner', ...(session ? { session } : {}) };
}

/** Both seats launched into `session`, as `up --session` would register them. */
function registerBoth(fixture: Fixture, session?: string): { lead: string; worker: string } {
  const input = registryOf(fixture, session);
  const seat = (name: string) => input.team.seats.find((item) => item.name === name)!;
  return {
    lead: (registerLaunch(input, seat('lead'), 'pane-lead') as { id: string }).id,
    worker: (registerLaunch(input, seat('worker'), 'pane-worker') as { id: string }).id,
  };
}

/** The state of a session whose two seats are ready, as `up` leaves it. */
function seedState(fixture: Fixture, session: string): void {
  updateState(fixture.dir, (state) => {
    const current = (state.sessions[session] ??= emptySession());
    current.launched_file = fixture.file;
    current.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    current.seats.worker = { stage: 'ready', pane: 'pane-worker', workspace: 'ws-worker' };
  });
}

/** A running session of two idle seats; closing a workspace ends its seat. */
function downSources(fixture: Fixture): DownSources {
  const alive = new Set<string>(['lead', 'worker']);
  const shelled = new Set<string>();
  const boxes = new Map<string, string>();
  const listed = (): HerdrAgent[] => [...alive].map((name) => ({
    name, agent: 'claude-code', pane: `pane-${name}`, workspace: `ws-${name}`, status: 'idle', cwd: fixture.root,
  }));
  const launch: DownLaunch = {
    typeText: (_session, pane, text) => { boxes.set(pane, claudeBox(text)); return true; },
    sendKey: () => true,
    pressEnter: (_session, pane) => { shelled.add(pane); return true; },
    agentPanes: () => listed().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      alive.delete(workspace.replace('ws-', ''));
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    home: fixture.home,
    sessionRunning: () => true,
    agents: () => listed(),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => boxes.get(pane) ?? claudeBox(''),
    status: () => 'idle',
    foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch,
  };
}

const owner = { kind: 'owner' } as const;

describe('team down --session and the team record', () => {
  test('a stop of the session the registry addresses the team in moves the team to stopped, and keeps that session', async () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture, 'alternate');
    const teamId = teamIdOf(fixture.root);
    expect(getTeam(fixture.home, teamId)).toMatchObject({ session: 'alternate', lifecycle: 'running' });
    seedState(fixture, 'alternate');

    const io = testIo(fixture.root, owner);
    const code = await runDown(['--session', 'alternate'], io, downSources(fixture));
    expect({ code, err: io.err }).toEqual({ code: 0, err: '' });

    expect(getTeam(fixture.home, teamId)).toMatchObject({ session: 'alternate', lifecycle: 'stopped' });
    for (const id of [ids.lead, ids.worker]) {
      expect(getAgent(fixture.home, id)).toMatchObject({ lifecycle: 'stopped', reach: { session: 'alternate', pane: null } });
    }
  });

  test('a session found already dead is the same: the team addressed there is stopped', async () => {
    const fixture = makeFixture();
    registerBoth(fixture, 'alternate');
    const idle: DownSources = { ...downSources(fixture), sessionRunning: () => false };
    const io = testIo(fixture.root, owner);
    expect(await runDown(['--session', 'alternate'], io, idle)).toBe(0);
    expect(io.out).toContain('is not running: nothing to stop');
    expect(getTeam(fixture.home, teamIdOf(fixture.root))).toMatchObject({ session: 'alternate', lifecycle: 'stopped' });
  });

  test('a stop of the file\'s session leaves a team addressed in another session running', async () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture, 'alternate');
    seedState(fixture, 'acme');
    const io = testIo(fixture.root, owner);
    expect(await runDown([], io, downSources(fixture))).toBe(0);

    expect(getTeam(fixture.home, teamIdOf(fixture.root))).toMatchObject({ session: 'alternate', lifecycle: 'running' });
    for (const id of [ids.lead, ids.worker]) {
      expect(getAgent(fixture.home, id)).toMatchObject({ lifecycle: 'running', reach: { session: 'alternate', pane: expect.stringMatching(/^pane-/) } });
    }
  });

  test('a team with no record is registered only by a stop of the file\'s session', async () => {
    const fixture = makeFixture();
    seedState(fixture, 'alternate');
    const io = testIo(fixture.root, owner);
    expect(await runDown(['--session', 'alternate'], io, downSources(fixture))).toBe(0);
    expect(getTeam(fixture.home, teamIdOf(fixture.root))).toBeNull();
  });
});

describe('an agent ends only with a stop of the session it lives in', () => {
  test('registerEnd for another session leaves the agent as it is; for its own, ends it', () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture, 'alternate');
    const fileSession = registryOf(fixture);

    expect(registerEnd(fileSession, 'worker', 'stopped')).toBeNull();
    expect(registerEnd({ ...fileSession, session: 'third' }, 'worker', 'retired')).toBeNull();
    expect(getAgent(fixture.home, ids.worker)).toMatchObject({ lifecycle: 'running', reach: { session: 'alternate', pane: 'pane-worker' } });
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster.map((item) => item.seat).sort()).toEqual(['lead', 'worker']);

    expect(registerEnd({ ...fileSession, session: 'alternate' }, 'worker', 'stopped')).toBeNull();
    expect(getAgent(fixture.home, ids.worker)).toMatchObject({ lifecycle: 'stopped', reach: { pane: null } });
  });

  test('a down of the file\'s session does not end the seat records pointed at another session', async () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture, 'alternate');
    seedState(fixture, 'acme');
    expect(await runDown([], testIo(fixture.root, owner), downSources(fixture))).toBe(0);
    // The seats' own state in the file's session is dropped; the agents' records are not.
    expect(getAgent(fixture.home, ids.lead)?.lifecycle).toBe('running');
    expect(getAgent(fixture.home, ids.worker)?.lifecycle).toBe('running');
  });
});
