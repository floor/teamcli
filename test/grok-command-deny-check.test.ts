// End-to-end check output with a signed policy and a synthetic home. No agent CLI is run.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { cursorCommandDenyConfig, type GrokCommandDeny } from '../src/settings/grok-command-deny.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T21:00:00Z');
const made: string[] = [];
const originalSource = process.env.TEAM_CONFIG_SOURCE;
beforeEach(() => {
  process.env.TEAM_CONFIG_SOURCE = 'file';
  setHerdrRun(() => { throw new Error('no terminal host belongs to this fixture'); });
});
afterEach(() => {
  setHerdrRun(null);
  if (originalSource === undefined) delete process.env.TEAM_CONFIG_SOURCE;
  else process.env.TEAM_CONFIG_SOURCE = originalSource;
  const held = made.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function world(mode: GrokCommandDeny, model = 'Grok') {
  const base = fixtureBase('grok-command-check-'); made.push(base);
  const home = join(base, 'home'); const root = join(base, 'project'); const folder = join(base, 'worker');
  mkdirSync(home); mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(folder);
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const text = `format: 1
project: acme
session: morning
coordinator: captain
operator: captain
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: captain
    leads: true
    human: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: worker
    cli: cursor
    vendor: test
    model: ${model}
    version: "4.7"
    launch: cursor-agent
`;
  const file = join(root, '.agents', 'team.yaml'); writeFileSync(file, text);
  const loaded = validateTeamFile(text, { home, root });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath('acme', root, home), { approval: approvalOf(loaded.team, root, NOW), file: text }, loaded.team.seats, home, NOW);
  const wrote = writePolicySet(home, { level: 'team', target: teamIdOf(root), teamRoot: root, name: 'grok-command-deny', value: mode }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
  updateState(join(root, '.agents'), (state) => {
    const session = state.sessions.morning ??= emptySession();
    session.seats.worker = { stage: 'ready', pane: 'fixture-worker', start_cwd: folder, launch_line: 'cursor-agent' };
  });
  return { home, root, folder, file };
}

function check(w: ReturnType<typeof world>): string {
  const io = testIo(w.root, { kind: 'owner' });
  runTeamCheck({ file: w.file }, io, {
    home: w.home,
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => 'main', standing: (root) => approvalStanding(root, w.home), now: () => NOW,
    alive: () => false, sockets: join(w.home, 'no-sockets'),
  });
  expect(io.err).toBe('');
  return io.out + io.err;
}

test('team check names the Grok seat with missing rules and clears that note when its own file has them', () => {
  const w = world('git-and-tests'); const before = readFileSync(w.file);
  expect(check(w)).toContain('worker: grok-command-deny git-and-tests');
  expect(readFileSync(w.file)).toEqual(before);
  mkdirSync(join(w.folder, '.cursor'));
  const file = join(w.folder, '.cursor', 'cli.json');
  const bytes = JSON.stringify(cursorCommandDenyConfig('git-and-tests', { permissions: { allow: ['Shell(git)'] } }));
  writeFileSync(file, bytes);
  expect(check(w)).not.toContain('worker: grok-command-deny');
  expect(readFileSync(file, 'utf8')).toBe(bytes);
});

test('team check refuses to treat a shared recorded folder as the seat deny file', () => {
  const w = world('git');
  mkdirSync(join(w.root, '.cursor'));
  writeFileSync(join(w.root, '.cursor', 'cli.json'), JSON.stringify(cursorCommandDenyConfig('git')));
  updateState(join(w.root, '.agents'), (state) => {
    state.sessions.morning!.seats.worker!.start_cwd = w.root;
  });
  expect(check(w)).toContain('worker: grok-command-deny git: its recorded launch folder cannot be checked');
});

for (const [declared, bound, needsRules] of [['Example', 'Grok', true], ['Grok', 'Example', false]] as const) {
  test(`team check follows the verified launch binding from ${declared} to ${bound}`, () => {
    const w = world('git', declared);
    const handle = 'seat_0123456789ab', conversation = '12345678-1234-4234-8234-123456789abc';
    registerAgent(w.home, { name: 'worker', signing: { role: 'implementer', model: bound, version: '4.7' },
      lab: 'fixture', cli: 'cursor', launcher: null, launch: `cursor-agent --model ${bound}`,
      reach: { team: teamIdOf(w.root), seat: 'worker', session: 'morning', pane: 'fixture-worker', address: null, agent_session: conversation },
      seat_handle: handle, mcp: [], skills: [], lifecycle: 'running', by: 'scene' });
    updateState(join(w.root, '.agents'), (state) => {
      Object.assign(state.sessions.morning!.seats.worker!, { id: handle, agent_session: conversation });
    });
    expect(check(w).includes('worker: grok-command-deny git:')).toBe(needsRules);
  });
}

test('off adds no config note, and a tampered signed word is refused rather than trusted', () => {
  const off = world('off');
  expect(check(off)).not.toContain('worker: grok-command-deny');
  const w = world('git');
  const text = readFileSync(w.file, 'utf8');
  const tampered = text.replace(/((?:"value"|value):\s*)(?:"git"|'git'|git)(?=\s|,|}|$)/, '$1git-and-tests');
  expect(tampered).not.toBe(text);
  writeFileSync(w.file, tampered);
  const out = check(w);
  expect(out).toContain('signature');
  expect(out).not.toContain('worker: grok-command-deny git-and-tests');
});
