// The default rule leaves leads.authority unset, so a placed lead may remove and may stop
// the team. Abandon stays the owner's on both doors. With development mode off, that lead's
// remove --abandon and down --abandon are refused, and the team file, the session state and
// the approval record stay byte for byte as they were. The owner still passes both. The home,
// the panes and the team are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-09T09:30:00Z');
const PLACED_LEAD = { kind: 'seat' as const, name: 'lead', pane: 'pane-lead', session: 'main' };

const owned: string[] = [];
afterEach(() => {
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

function teamText(root: string, lobby: string): string {
  return `format: 1
project: crate
session: main
coordinator: lead
operator: helmsman
trust:
  - ${JSON.stringify(lobby)}
  - ${JSON.stringify(root)}
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: helmsman
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

type World = { root: string; home: string; file: string; state: string; record: string };

function world(): World {
  const base = fixtureBase('.leads-door-abandon-');
  owned.push(base);
  const root = join(base, 'crate');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const lobby = lobbyDir(home);
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, teamText(root, lobby));
  const state = join(dir, 'team.state.json');
  writeFileSync(state, `${JSON.stringify({
    format: 1,
    sessions: {
      main: {
        seats: {
          lead: { stage: 'ready', pane: 'pane-lead' },
          worker: { stage: 'ready', pane: 'pane-worker' },
        },
        workspaces: {},
      },
    },
  }, null, 2)}\n`);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const record = storePath(loaded.team.project, root, home);
  writeApproval(
    record,
    { approval: approvalOf(loaded.team, root, NOW), file: readFileSync(file, 'utf8') },
    loaded.team.seats,
    home,
    NOW,
  );
  upsertTeam(home, teamIdOf(root), { project: 'crate', session: 'main', root });
  return { root, home, file, state, record };
}

function recordBytes(w: World): { file: string; state: string; record: string } {
  const walk = (path: string): string => {
    if (statSync(path).isDirectory()) {
      return readdirSync(path).sort().map((name) => `${name}\n${walk(join(path, name))}`).join('\n');
    }
    return readFileSync(path).toString('base64');
  };
  return { file: readFileSync(w.file, 'utf8'), state: readFileSync(w.state, 'utf8'), record: walk(w.record) };
}

function sources(home: string): RemoveSources {
  let running = true;
  const launch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => ['pane-worker'],
    closeWorkspace: () => true,
    stopSession: () => {
      running = false;
      return true;
    },
    deleteSession: () => true,
    kill: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  const down: DownSources = {
    home,
    sessionRunning: () => running,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    launch,
  };
  return { ...down, foreground: () => [] };
}

test('a placed lead is refused both abandon doors under the default rule, and the owner still passes', async () => {
  const lead = world();
  const before = recordBytes(lead);
  const removeIo = testIo(lead.root, PLACED_LEAD);
  removeIo.env = { HOME: lead.home };
  expect(await runRemove(['worker', '--abandon', '--json'], removeIo, sources(lead.home)), `${removeIo.out}\n${removeIo.err}`).toBe(1);
  expect(removeIo.out).toContain('remove.abandon');
  expect(removeIo.out).toContain('only the owner abandons a seat, from a terminal outside herdr');
  expect(`${removeIo.out}\n${removeIo.err}`.includes('dev mode continues')).toBe(false);
  const downIo = testIo(lead.root, PLACED_LEAD);
  downIo.env = { HOME: lead.home };
  expect(await runDown(['--abandon', '--json'], downIo, sources(lead.home)), `${downIo.out}\n${downIo.err}`).toBe(1);
  expect(downIo.out).toContain('down.abandon');
  expect(downIo.out).toContain('only the owner abandons a team, from a terminal outside herdr');
  expect(`${downIo.out}\n${downIo.err}`.includes('dev mode continues')).toBe(false);
  expect(recordBytes(lead)).toEqual(before);
  expect(readFileSync(lead.file, 'utf8')).toContain('name: worker');

  const owner = world();
  const removeOwner = testIo(owner.root, { kind: 'owner' });
  removeOwner.env = { HOME: owner.home };
  expect(await runRemove(['worker', '--abandon', '--json'], removeOwner, sources(owner.home)), `${removeOwner.out}\n${removeOwner.err}`).toBe(0);
  expect(`${removeOwner.out}\n${removeOwner.err}`.includes('remove.abandon')).toBe(false);
  expect(readFileSync(owner.file, 'utf8').includes('name: worker')).toBe(false);
  const downOwner = testIo(owner.root, { kind: 'owner' });
  downOwner.env = { HOME: owner.home };
  expect(await runDown(['--abandon', '--json'], downOwner, sources(owner.home)), `${downOwner.out}\n${downOwner.err}`).toBe(0);
  expect(`${downOwner.out}\n${downOwner.err}`.includes('down.abandon')).toBe(false);
  expect(downOwner.out).toContain('stopped');
});
