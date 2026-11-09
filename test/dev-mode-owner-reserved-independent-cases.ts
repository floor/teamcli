// Independent scenes for the owner-reserved actions under development mode. Development mode
// lifts development checks only: a placed lead with the mode on is still refused by every
// owner-reserved action — abandoning a seat, abandoning a team, adding back an undeclared seat,
// grant, delegate, revoke, a trust edit of the record and forget — with the refusal's own
// sentence, id and exit code, and the record stays byte for byte as it was. The owner is still
// admitted, and two development checks (a non-trust record edit and a settings write) still
// lift. The team sets `leads.authority: owner-asks`, the reporting team's state, so the default
// map no longer admits its own lead and every owner gate stands on its own. Every file, caller
// and pane below is synthetic; nothing here reads a real store.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runConfig } from '../src/commands/config.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runForget } from '../src/commands/forget.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runSettings } from '../src/commands/settings.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { assertIndependentHome } from './independent-home-fixture.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const PLACED_LEAD = { kind: 'seat' as const, name: 'lead', pane: 'pane1', session: 'main' };
const owned: string[] = [];

afterEach(() => {
  const paths = owned.splice(0).filter(p => fs.existsSync(p));
  if (paths.length) discardFixtures(paths);
});

function teamText(root: string) { return `format: 1
project: reserved
session: main
coordinator: lead
operator: helmsman
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
  base: main
rules:
  - original reserved-scene rule
seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: helmsman
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`; }

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dmor-'))); owned.push(base);
  const root = join(base, 'reserved'), home = join(base, 'home');
  const dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const file = join(dir, 'team.yaml'); fs.writeFileSync(file, teamText(root));
  fs.writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { main: { seats: { lead: { stage: 'ready', pane: 'pane1' }, worker: { stage: 'ready', pane: 'pane2' } }, workspaces: {} } },
  }, null, 2)}\n`);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(loaded.team, root, NOW), file: fs.readFileSync(file, 'utf8') },
    loaded.team.seats, home, NOW,
  );
  upsertTeam(home, teamIdOf(root), { project: 'reserved', session: 'main', root });
  // The reporting team had withdrawn its lead's default-map admission, so every owner gate
  // below stands on its own instead of being answered by the map's own-team row.
  writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'leads.authority', value: 'owner-asks' }, { now: NOW });
  return { base, root, home, dir, file, state: join(dir, 'team.state.json'), record: storePath(loaded.team.project, root, home) };
}
type World = ReturnType<typeof world>;

/** Byte identity and timestamps over the whole synthetic base and the global product store. */
function snapshot(w: World) {
  const result: Record<string, unknown> = {};
  const walk = (path: string): void => {
    const stat = fs.lstatSync(path, { bigint: true });
    result[path] = { kind: stat.isDirectory() ? 'dir' : 'file', ino: String(stat.ino), mode: String(stat.mode),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), ...(stat.isFile() ? { bytes: fs.readFileSync(path).toString('base64') } : {}) };
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) walk(join(path, name));
  };
  walk(w.base);
  const globalStore = join(homedir(), '.config', 'team');
  if (fs.existsSync(globalStore)) walk(globalStore); else result[globalStore] = { kind: 'missing' };
  return result;
}

/** The record alone: the team file, the session state and the approval record. The abandon
 *  scenes print a development-check warning whose audit line the dir legitimately gains, so
 *  they pin the record's bytes, not the whole tree. */
function recordSnapshot(w: World) {
  const read = (path: string): unknown => {
    if (!fs.existsSync(path)) return 'missing';
    if (fs.statSync(path).isDirectory()) {
      const entries: Record<string, unknown> = {};
      for (const name of fs.readdirSync(path).sort()) entries[name] = read(join(path, name));
      return entries;
    }
    return fs.readFileSync(path).toString('base64');
  };
  return { file: read(w.file), state: read(w.state), record: read(w.record) };
}

function leadIo(w: World, dev = true) {
  const io = testIo(w.root, PLACED_LEAD);
  io.env = { ...io.env, HOME: w.home, ...(dev ? { TEAMCLI_DEV_MODE: '1' } : {}) };
  return io;
}

function removeSources(home: string): RemoveSources {
  const agents = [{ name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-space', status: 'idle', cwd: null }];
  return {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    now: () => NOW,
    sleep: async () => {},
    launch: {
      typeText: () => true, sendKey: () => true, pressEnter: () => true,
      agentPanes: () => agents.map((agent) => agent.pane),
      closeWorkspace: () => true, stopSession: () => false, deleteSession: () => false, kill: () => false,
      sleep: async () => {}, now: () => NOW,
    },
    foreground: () => [],
  };
}

function downSources(home: string): DownSources {
  return {
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    launch: {
      typeText: () => true, sendKey: () => true, pressEnter: () => true, agentPanes: () => [],
      closeWorkspace: () => true, stopSession: () => false, deleteSession: () => false, kill: () => false,
      sleep: async () => {}, now: () => NOW,
    },
  };
}

function launchStub() {
  return {
    sessionState: (): 'running' => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'added-seat-pane', workspace: 'added-seat' }),
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [] as string[],
    agents: () => [] as never[],
    paneText: () => null,
    foreground: () => null,
    sleep: async () => {},
    now: () => NOW,
  };
}

function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: {
      version: () => '2.1.288', onPath: () => true, loggedIn: () => true,
      herdrVersion: () => '0.7.1', sessionRunning: () => false, now: () => NOW, home,
    },
    now: () => NOW,
    launch: launchStub(),
  };
}

test('the suite and all module defaults use the internally created HOME', () => { assertIndependentHome(); });

test('a placed lead with the mode on cannot abandon a seat', async () => {
  const w = world(); const before = recordSnapshot(w);
  const io = leadIo(w);
  const code = await runRemove(['worker', '--abandon'], io, removeSources(w.home));
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner abandons a seat, from a terminal outside herdr');
  // The development check ahead of the refusal still lifts; the reserved abandon does not.
  expect(io.err).toContain('dev mode continues');
  expect(recordSnapshot(w)).toEqual(before);
  expect(fs.readFileSync(w.file, 'utf8')).toContain('name: worker');
  const jsonIo = leadIo(w);
  expect(await runRemove(['worker', '--abandon', '--json'], jsonIo, removeSources(w.home))).toBe(1);
  expect(jsonIo.out).toContain('remove.abandon');
});

test('a placed lead with the mode on cannot abandon a team', async () => {
  const w = world(); const before = recordSnapshot(w);
  const io = leadIo(w);
  const code = await runDown(['--abandon'], io, downSources(w.home));
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner abandons a team, from a terminal outside herdr');
  expect(io.err).toContain('dev mode continues');
  expect(recordSnapshot(w)).toEqual(before);
  expect(fs.readFileSync(w.file, 'utf8')).toContain('name: worker');
});

test('a placed lead with the mode on cannot add back an undeclared seat', async () => {
  const w = world(); const before = snapshot(w);
  const io = leadIo(w);
  const code = await runAdd(['newcomer'], io, addSources(w.home));
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner or a standing grant (delegate) runs this');
  expect(io.err).not.toContain('dev mode continues');
  expect(snapshot(w)).toEqual(before);
  const jsonIo = leadIo(w);
  expect(await runAdd(['newcomer', '--json'], jsonIo, addSources(w.home))).toBe(1);
  expect(jsonIo.out).toContain('add.caller');
});

test('a placed lead with the mode on cannot grant, delegate or revoke', async () => {
  const w = world(); const before = snapshot(w);
  const grantIo = leadIo(w);
  expect(await runGrant(['lead', '--scope', 'up'], grantIo, { home: w.home })).toBe(1);
  expect(grantIo.err).toBe('team grant: only the owner runs this, from a terminal outside herdr; this call is lead\n');
  expect(grantIo.err).not.toContain('dev mode continues');
  const delegateIo = leadIo(w);
  expect(await runDelegate(['main/other-seat-pane', '--commands', 'up'], delegateIo, { home: w.home })).toBe(1);
  expect(delegateIo.err).toContain('team delegate: only the owner runs this, from a terminal outside herdr');
  expect(delegateIo.err).not.toContain('dev mode continues');
  const revokeIo = leadIo(w);
  expect(await runRevoke(['grant'], revokeIo, { home: w.home })).toBe(1);
  expect(revokeIo.err).toContain('team revoke: only the owner runs this, from a terminal outside herdr');
  expect(revokeIo.err).not.toContain('dev mode continues');
  expect(snapshot(w)).toEqual(before);
});

test('a placed lead with the mode on cannot edit the record\'s trust', async () => {
  const w = world(); const before = snapshot(w);
  const io = leadIo(w);
  const code = await runConfig(['set', 'trust.1', join(w.base, 'elsewhere')], io, {
    home: w.home, env: io.env, now: () => NOW, present: false,
  });
  expect(code).toBe(1);
  expect(io.err).toContain("only the owner edits the team's record");
  expect(io.err).not.toContain('dev mode continues');
  expect(snapshot(w)).toEqual(before);
  expect(fs.readFileSync(w.file, 'utf8')).toContain('- ~/.config/team/lobby');
  const jsonIo = leadIo(w);
  expect(await runConfig(['set', 'trust.1', join(w.base, 'elsewhere'), '--json'], jsonIo, {
    home: w.home, env: jsonIo.env, now: () => NOW, present: false,
  })).toBe(1);
  expect(jsonIo.out).toContain('config.not-owner');
});

test('a placed lead with the mode on cannot forget a team record', async () => {
  const w = world(); const before = snapshot(w);
  const io = leadIo(w);
  const code = await runForget([teamIdOf(w.root)], io, { home: w.home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner forgets a team record, from a terminal outside herdr');
  expect(io.err).not.toContain('dev mode continues');
  expect(snapshot(w)).toEqual(before);
});

test('the owner is still admitted with the mode on', async () => {
  const w = world();
  const io = testIo(w.root, { kind: 'owner' });
  io.env = { ...io.env, HOME: w.home, TEAMCLI_DEV_MODE: '1' };
  const code = await runRemove(['worker', '--abandon'], io, removeSources(w.home));
  expect(code).toBe(0);
  expect(fs.readFileSync(w.file, 'utf8')).not.toContain('name: worker');
});

test('kept: a non-trust record edit still lifts under the mode', async () => {
  const w = world();
  const io = leadIo(w);
  const code = await runConfig(['edit'], io, {
    home: w.home, env: io.env, now: () => NOW, present: false,
    editor: path => {
      fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace('original reserved-scene rule', 'updated reserved-scene rule'));
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(io.err).toContain('dev mode continues');
  expect(fs.readFileSync(w.file, 'utf8')).toContain('updated reserved-scene rule');
});

test('kept: a settings write still lifts under the mode', async () => {
  const w = world();
  const io = leadIo(w);
  const code = await runSettings(['set', 'worker', 'nickname=ChangedWorker'], io, { home: w.home, now: NOW });
  expect(code).toBe(0);
  expect(io.err).toContain('dev mode continues');
});
