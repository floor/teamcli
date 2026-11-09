// A placed lead under the default rule does not set a policy that reaches the machine, and
// does not set a policy for another team. Daemon chores, the daemon heartbeat, the broker,
// dev mode and the development-mode switch stay the owner's. Entity and project writes stay
// the owner's. A team write and a seat this team declares are admitted. Homes, records and
// pane names are synthetic.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { standingOf } from '../src/caller.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { leadsCommandExcluded, leadsOwnTeamAdmits, policyNeedsOwner, policyWriteOwnTeam } from '../src/leads-authority.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T10:00:00Z');
const OWNER = 'team policy: only the owner runs this, from a terminal outside herdr; this call is lead';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: Claude Opus 5.5
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: Claude Opus 5.5
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: Claude Opus 5.5
    launch: claude --model claude-opus-5-5
    mode: shared
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

type Scene = { home: string; root: string; dir: string; teamFile: string; agentFile: string };

function lead(): Caller {
  return { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
}

function open(): Scene {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'leads-scope-')));
  made.push(home);
  const root = join(home, 'repo');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  // This team sets neither entity nor lobby, so the loader requires the machine-global lobby.
  const lobby = resolveLobby(home);
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  git(root, 'init', '-q', '-b', 'main');
  const teamFile = join(dir, 'team.yaml');
  writeFileSync(teamFile, TEAM.replace('workspace:\n', `trust:\n  - ${lobby}\n  - ${root}\nworkspace:\n`));
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops' };
    session.seats.worker = { stage: 'ready', pane: 'pane-worker' };
  });
  const agent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: 'worker', session: 'acme', pane: 'pane-worker', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'the test',
  });
  return { home, root, dir, teamFile, agentFile: join(agentsDir(home), `${agent.id}.yaml`) };
}

function files(scene: Scene): { team: string; agent: string } {
  return { team: readFileSync(scene.teamFile, 'utf8'), agent: readFileSync(scene.agentFile, 'utf8') };
}

async function setPolicy(scene: Scene, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(scene.root, lead());
  const code = await runPolicy(argv, io, { home: scene.home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

test('a placed lead is not admitted to the machine policies or the machine commands', () => {
  const scene = open();
  const team = { orchestrator: 'lead', operator: 'ops', seats: [{ name: 'lead' }, { name: 'ops' }, { name: 'worker' }] };
  const at = standingOf(scene.dir, 'acme', lead());
  for (const name of ['daemon.chores', 'daemon.heartbeat', 'daemon.broker', 'dev-mode', 'development-mode']) {
    expect(policyNeedsOwner(name)).toBe(true);
  }
  for (const command of ['development-mode', 'development-mode:set', 'daemon', 'daemon:chores']) {
    expect(leadsCommandExcluded(command)).toBe(true);
    expect(leadsOwnTeamAdmits({
      caller: lead(),
      team,
      at,
      home: scene.home,
      root: scene.root,
      command,
      now: NOW,
    })).toBeNull();
  }
  expect(leadsOwnTeamAdmits({
    caller: lead(),
    team,
    at,
    home: scene.home,
    root: scene.root,
    command: 'policy',
    now: NOW,
  })).not.toBeNull();
});

test('a placed lead cannot set daemon chores, the heartbeat, the broker, dev mode, or the development-mode switch', async () => {
  const scene = open();
  const before = files(scene);
  const sets: string[][] = [
    ['set', 'team', 'daemon.chores', 'inline'],
    ['set', 'team', 'daemon.heartbeat', '5'],
    ['set', 'team', 'daemon.broker', 'on'],
    ['set', 'team', 'dev-mode', 'on'],
    ['set', 'team', 'development-mode', 'local-fast'],
  ];
  for (const argv of sets) {
    const result = await setPolicy(scene, argv);
    expect(result.code, result.err + result.out).toBe(1);
    expect(result.err).toContain(OWNER);
  }
  expect(files(scene)).toEqual(before);
});

test('entity and project are not a default-rule admission, and a team write and an own seat are', async () => {
  const team = { seats: [{ name: 'lead' }, { name: 'ops' }, { name: 'worker' }] };
  expect(policyWriteOwnTeam('entity', undefined, team)).toBe(false);
  expect(policyWriteOwnTeam('project', undefined, team)).toBe(false);
  expect(policyWriteOwnTeam('team', undefined, team)).toBe(true);
  expect(policyWriteOwnTeam('seat', 'worker', team)).toBe(true);
  expect(policyWriteOwnTeam('seat:worker', undefined, team)).toBe(true);
  expect(policyWriteOwnTeam('seat', 'stranger', team)).toBe(false);
  expect(policyWriteOwnTeam('seat:stranger', undefined, team)).toBe(false);

  const refused = open();
  const before = files(refused);
  for (const argv of [
    ['set', 'entity', 'seats-cross-teams', 'off'],
    ['set', 'project', 'seats-cross-teams', 'off'],
    ['set', 'seat', 'seats-cross-teams', 'off', '--seat', 'stranger'],
  ]) {
    const result = await setPolicy(refused, argv);
    expect(result.code, result.err + result.out).toBe(1);
    expect(result.err).toContain(OWNER);
  }
  expect(files(refused)).toEqual(before);

  const teamScene = open();
  const teamResult = await setPolicy(teamScene, ['set', 'team', 'seats-cross-teams', 'off']);
  expect(teamResult.code).toBe(0);
  expect(teamResult.err).toContain('admitted as lead');
  const teamText = readFileSync(teamScene.teamFile, 'utf8');
  expect(teamText).toContain('seats-cross-teams');
  expect(teamText).toContain('off');

  const seatScene = open();
  const seatResult = await setPolicy(seatScene, ['set', 'seat', 'seats-cross-teams', 'off', '--seat', 'worker']);
  expect(seatResult.code).toBe(0);
  expect(seatResult.err).toContain('admitted as lead');
  const agentText = readFileSync(seatScene.agentFile, 'utf8');
  expect(agentText).toContain('seats-cross-teams');
  expect(agentText).toContain('off');
  expect(readFileSync(seatScene.teamFile, 'utf8').includes('seats-cross-teams')).toBe(false);
});
