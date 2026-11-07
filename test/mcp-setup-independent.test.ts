// Hand-started channel setup. The command, the pair writer and the placement proof are real.
// The terminal host is stubbed, and every folder is a synthetic home.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { runMcp, realSources as mcpSources } from '../src/commands/mcp.ts';
import type { RegisterSources } from '../src/commands/register.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { setHerdrRun } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { currentBriefClaim } from '../src/launch/general-brief.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { selfRunner } from '../src/mcp/register.ts';
import { placementAtStart } from '../src/mcp/serve.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readState } from '../src/state.ts';
import { installKey } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, gitEnv, testIo } from './helpers.ts';

const SESSION = 'hour';
const SEAT = 'guide';
const PANE = 'fixture-pane-one';
const NOW = new Date('2026-11-07T12:00:00Z');
const FLAG = '--dangerously-load-development-channels server:team-inbox';

type World = {
  base: string;
  home: string;
  root: string;
  cwd: string;
  file: string;
  sources: ReturnType<typeof sourcesOf>;
};

function sourcesOf(home: string) {
  const register: RegisterSources = {
    home,
    sessionState: () => 'running',
    agents: () => [],
    processInfo: () => ({ shell: 7001, foreground: [7002] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
    renameAgent: () => true,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    refreshAddress: () => ({ address: null }),
  };
  return {
    ...mcpSources,
    home: () => home,
    setup: { register, config: { home, env: {}, now: () => NOW } },
  };
}

function world(inLobby = false): World {
  const base = fixtureBase('mcp-setup-independent-');
  const home = join(base, 'home');
  const root = join(base, 'project');
  const lobby = join(root, 'lobby');
  const cwd = inLobby ? join(lobby, SEAT) : root;
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, '.agents'), { mode: 0o700 });
  if (inLobby) {
    mkdirSync(lobby, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
  } else {
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'init', '-q'], {
      cwd: root, env: gitEnv(), stdio: 'ignore',
    });
  }
  const file = join(root, '.agents', 'team.yaml');
  const trust = inLobby ? `lobby: ${lobby}\ntrust:\n  - ${root}\n  - ${lobby}\n` : '';
  writeFileSync(file, `format: 1
project: harbor
session: ${SESSION}
coordinator: ${SEAT}
operator: ${SEAT}
${trust}workspace:
  mode: shared
seats:
  - name: ${SEAT}
    role: guide
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude --model fixture
`);
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/key.json'), 'utf8')));
  upsertTeam(home, teamIdOf(root), {
    root, project: 'harbor', session: SESSION, ...(inLobby ? { lobby } : {}),
    roster: [{ agent: 'agt_000000000001', seat: SEAT, role: 'guide' }],
  });
  setHerdrRun(() => { throw new Error('a synthetic test must not reach a live terminal host'); });
  return { base, home, root, cwd, file, sources: sourcesOf(home) };
}

function discard(base: string): void {
  setHerdrRun(null);
  discardFixtures([base], { roots: [dirname(base)] });
}

function snapshot(base: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      entries[relative(base, path)] = stat.isSymbolicLink()
        ? `link:${readlinkSync(path)}`
        : stat.isDirectory() ? 'directory' : readFileSync(path).toString('base64');
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
    }
  };
  visit(base);
  return entries;
}

async function setup(
  scene: World,
  args: string[] = [],
  caller: Io['caller'] = { kind: 'owner' },
  seat = SEAT,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(scene.cwd, caller);
  io.env.HERDR_PANE_ID = PANE;
  const code = await runMcp(['setup', seat, ...args], io, scene.sources);
  return { code, out: io.out, err: io.err };
}

function pair(scene: World): [string, string] {
  return [join(scene.cwd, '.mcp.json'), join(scene.cwd, '.claude', 'settings.local.json')];
}

function plant(scene: World, mcp: string, approval: string): void {
  mkdirSync(join(scene.cwd, '.claude'), { mode: 0o700 });
  const [config, settings] = pair(scene);
  writeFileSync(config, mcp, { mode: 0o600 });
  writeFileSync(settings, approval, { mode: 0o600 });
}

test('a dry run names the three changes and writes nothing', async () => {
  const scene = world();
  try {
    const before = snapshot(scene.base);
    const ran = await setup(scene, ['--dry-run', '--json']);
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out).changes).toHaveLength(3);
    expect(snapshot(scene.base)).toEqual(before);
  } finally {
    discard(scene.base);
  }
});

test('the published pair matches the launch writer for the claim registration created', async () => {
  const scene = world(true);
  try {
    expect((await setup(scene)).code).toBe(0);
    const written = pair(scene).map((path) => readFileSync(path, 'utf8'));
    const entry = JSON.parse(written[0]!).mcpServers['team-inbox'];
    const epoch = currentBriefClaim(readState(join(scene.root, '.agents')).sessions[SESSION]?.briefs?.[SEAT])?.epoch;
    expect(entry.command).toBe(selfRunner().command);
    expect(entry.args).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', SEAT, '--session', SESSION, '--epoch', epoch]);
    expect(readState(join(scene.root, '.agents')).sessions[SESSION]?.seats[SEAT]?.pane).toBe(PANE);
    expect(readFileSync(scene.file, 'utf8')).toContain(FLAG);
    expect(JSON.parse(written[1]!).enabledMcpjsonServers).toEqual(['team-inbox']);
    expect(existsSync(join(scene.home, '.claude'))).toBe(false);
    for (const path of pair(scene)) unlinkSync(path);
    const launch = prepareChannelConfig({
      root: scene.root, home: scene.home, seat: SEAT, session: SESSION, cwd: scene.cwd, epoch,
    });
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error(launch.reason);
    launch.lease.check();
    launch.lease.release();
    expect(pair(scene).map((path) => readFileSync(path, 'utf8'))).toEqual(written);
  } finally {
    discard(scene.base);
  }
});

test('unrelated settings survive and off restores both files byte for byte', async () => {
  const scene = world();
  try {
    const mcp = '{ \n "note" : "keep", "mcpServers" : {"other" : { "command" : "fixture", "args": ["a"] }} }\n';
    const approval = '{\n  "env" : { "SYNTHETIC": "keep" },\n "enabledMcpjsonServers" : [ "other" ], "permissions" : { "allow" : ["Read"] }\n}\n';
    plant(scene, mcp, approval);
    const before = readTeamConfig(scene.root, { home: scene.home });
    expect((await setup(scene)).code).toBe(0);
    expect(readFileSync(pair(scene)[0]!, 'utf8')).toContain('"other" : { "command" : "fixture", "args": ["a"] }');
    expect(readFileSync(pair(scene)[1]!, 'utf8')).toContain('"env" : { "SYNTHETIC": "keep" }');
    expect(readFileSync(pair(scene)[1]!, 'utf8')).toContain('"permissions" : { "allow" : ["Read"] }');
    expect((await setup(scene, ['--off'])).code).toBe(0);
    expect(pair(scene).map((path) => readFileSync(path, 'utf8'))).toEqual([mcp, approval]);
    const restored = readTeamConfig(scene.root, { home: scene.home });
    expect(restored.ok && restored.team.seats[0]?.launch).toBe(before.ok && before.team.seats[0]?.launch);
    expect(existsSync(join(scene.cwd, '.team-channel-setup.json'))).toBe(false);
  } finally {
    discard(scene.base);
  }
});

test('a second setup adds the channel flag once', async () => {
  const scene = world();
  try {
    writeFileSync(scene.file, readFileSync(scene.file, 'utf8').replace(
      'claude --model fixture',
      'claude --model fixture --dangerously-load-development-channels server:other',
    ));
    expect((await setup(scene)).code).toBe(0);
    expect((await setup(scene)).code).toBe(0);
    const loaded = readTeamConfig(scene.root, { home: scene.home });
    const launch = loaded.ok ? loaded.team.seats[0]?.launch ?? '' : '';
    expect(launch).toBe('claude --model fixture --dangerously-load-development-channels server:other,server:team-inbox');
    expect(launch.split('server:team-inbox')).toHaveLength(2);
    expect(JSON.parse(readFileSync(pair(scene)[1]!, 'utf8')).enabledMcpjsonServers).toEqual(['team-inbox']);
  } finally {
    discard(scene.base);
  }
});

test('serve placement accepts the pane setup recorded', async () => {
  const scene = world();
  try {
    expect((await setup(scene)).code).toBe(0);
    const io = testIo(scene.cwd);
    io.env = { HERDR_PANE_ID: PANE };
    io.callerSources = () => ({
      ancestors: () => [
        { pid: 7003, name: 'team' },
        { pid: 7002, name: 'claude' },
        { pid: 7001, name: 'shell' },
        { pid: 1, name: 'init' },
      ],
      agents: () => [{ name: SEAT, agent: 'claude', pane: PANE, workspace: 'workspace', status: 'idle', cwd: scene.cwd }],
      paneRootPid: () => 7001,
      env: io.env,
      stdinIsTTY: false,
      paneProcesses: () => ({ shell: 7001, foreground: [7002] }),
      processStartOf: () => null,
    });
    expect(await placementAtStart(io, join(scene.root, '.agents'), SESSION, SEAT, {
      sleep: async () => { throw new Error('placement was not waiting'); },
    })).toEqual({ ok: true });
  } finally {
    discard(scene.base);
  }
});

function refuses(title: string, change: (scene: World) => void, seat = SEAT): void {
  test(title, async () => {
    const scene = world();
    try {
      change(scene);
      const before = snapshot(scene.base);
      const ran = await setup(scene, ['--json'], { kind: 'owner' }, seat);
      expect(ran.code).toBe(1);
      expect(snapshot(scene.base)).toEqual(before);
      expect(`${ran.out}${ran.err}`).not.toContain('fixture-only-do-not-print');
    } finally {
      discard(scene.base);
    }
  });
}

refuses('an unknown seat writes nothing', () => {}, 'missing');
refuses('a stopped seat writes nothing', (scene) => {
  writeFileSync(scene.file, readFileSync(scene.file, 'utf8').replace('    cli:', '    stopped: true\n    cli:'));
});
refuses('another cli writes nothing', (scene) => {
  writeFileSync(scene.file, readFileSync(scene.file, 'utf8').replace('cli: claude-code', 'cli: codex'));
});
refuses('a linked folder writes nothing', (scene) => {
  const alias = join(scene.base, 'alias');
  symlinkSync(scene.cwd, alias);
  scene.cwd = alias;
});
refuses('a malformed file writes nothing', (scene) => {
  plant(scene, '{}\n', '{ "marker": "fixture-only-do-not-print",');
});
refuses('an unowned entry writes nothing', (scene) => {
  plant(scene, '{"mcpServers":{"team-inbox":{"command":"foreign"}}}\n', '{}\n');
});

test('another seat is refused and the named seat does not gain a new admission', async () => {
  const scene = world();
  try {
    const before = snapshot(scene.base);
    const own = await setup(scene, ['--json'], { kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
    expect(own.code).not.toBe(0);
    expect(JSON.parse(own.out).error.id).toBe('mcp.setup-config');
    expect(snapshot(scene.base)).toEqual(before);
    const other = await setup(scene, ['--json'], { kind: 'seat', name: 'scout', pane: PANE, session: SESSION });
    expect(other.code).toBe(1);
    expect(JSON.parse(other.out).error.id).toBe('mcp.setup-caller');
    expect(snapshot(scene.base)).toEqual(before);
  } finally {
    discard(scene.base);
  }
});

test('the starting folder selects one team when several teams share a seat name', async () => {
  const base = fixtureBase('mcp-setup-independent-');
  try {
    const home = join(base, 'home');
    mkdirSync(home, { mode: 0o700 });
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/key.json'), 'utf8')));
    setHerdrRun(() => { throw new Error('a synthetic test must not reach a live terminal host'); });
    const seat = 'orchestrator';
    const teams = ['a', 'b', 'c'].map((mark, index) => {
      const root = join(base, `team-${mark}`);
      const session = `hour-${mark}`;
      mkdirSync(root, { mode: 0o700 });
      mkdirSync(join(root, '.agents'), { mode: 0o700 });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'init', '-q'], {
        cwd: root, env: gitEnv(), stdio: 'ignore',
      });
      const file = join(root, '.agents', 'team.yaml');
      writeFileSync(file, `format: 1
project: harbor-${mark}
session: ${session}
coordinator: ${seat}
operator: ${seat}
workspace:
  mode: shared
seats:
  - name: ${seat}
    role: guide
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude --model fixture
`);
      upsertTeam(home, teamIdOf(root), {
        root, project: `harbor-${mark}`, session, roster: [{ agent: `agt_${String(index + 1).padStart(12, '0')}`, seat, role: 'guide' }],
      });
      return { root, file };
    });
    const [first, second, third] = teams;
    if (!first || !second || !third) throw new Error('three teams');
    const beforeFirst = snapshot(first.root);
    const beforeThird = snapshot(third.root);
    const scene: World = { base, home, root: second.root, cwd: second.root, file: second.file, sources: sourcesOf(home) };
    expect((await setup(scene, ['--json'], { kind: 'owner' }, seat)).code).toBe(0);
    expect(readFileSync(second.file, 'utf8')).toContain(FLAG);
    expect(existsSync(join(second.root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(second.root, '.claude', 'settings.local.json'))).toBe(true);
    expect(snapshot(first.root)).toEqual(beforeFirst);
    expect(snapshot(third.root)).toEqual(beforeThird);
  } finally {
    discard(base);
  }
});

test('a folder outside every registered team is refused and the base stays byte-identical', async () => {
  const scene = world();
  try {
    const outside = join(scene.base, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    scene.cwd = outside;
    const before = snapshot(scene.base);
    const ran = await setup(scene, ['--json']);
    expect(ran.code).toBe(1);
    expect(JSON.parse(ran.out).error.id).toBe('mcp.setup-team');
    expect(snapshot(scene.base)).toEqual(before);
  } finally {
    discard(scene.base);
  }
});
