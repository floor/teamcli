// Independent verification of fix/c75-restart-declared-seat (436b41955).
//
// Behaviour covered:
// 1. A stale launched pointer to an older team file no longer refuses a seat the current team declares.
// 2. Each fallback step in order:
//    - Step 1: the launched pointer's own team when it already declares the seat (no fallback notice);
//    - Step 2: the folder's team when the launched pointer omits the seat (stderr, --dry-run, and --json notice);
//    - Step 3: the registry's team for the run's session, recorded lobby, or caller placement when session is absent.
// 3. A registry team whose record lacks the run session (or when multiple candidates match, or caller placement is absent) is refused.
// 4. A team file failing validation refuses with the configuration exit (exit code 2, restart.configuration) and never falls back.
// 5. --file stays owner-only for non-owner callers, and when used by the owner never falls back to folder or registry.
// 6. An undeclared seat is still refused with today's text ("<seat> is not a signed declared seat").
//
// Synthetic fixtures only; no live terminal host, process table, or real credential store.

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { noteLaunchedPane } from '../src/file/launched-file.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { setRoster, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, shortSocketBase, testIo } from './helpers.ts';
import { assertJsonErrorShape } from './helpers/output.ts';

const NOW = new Date('2026-11-05T02:00:00Z');
const IDLE = CLAUDE_IDLE;

const FULL_TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
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

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function olderTeamYaml(yaml: string): string {
  const cut = yaml.indexOf('\n  - role: implementer\n    name: worker');
  if (cut < 0) throw new Error('expected worker section');
  return yaml.slice(0, cut);
}

type Fixture = {
  base: string;
  root: string;
  home: string;
  lobby: string;
  file: string;
  olderFile: string;
  dir: string;
  yaml: string;
};

const tempBases: string[] = [];
afterEach(() => {
  for (const dir of tempBases.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(rawYaml = FULL_TEAM_YAML): Fixture {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'tr-ind-')));
  tempBases.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const lobby = join(home, '.config', 'team', 'lobby');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = rawYaml.replace(
    'workspace:\n',
    `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`,
  );
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  const olderFile = join(dir, 'team-old.yaml');
  writeFileSync(olderFile, olderTeamYaml(yaml));
  return { base, root, home, lobby, file, olderFile, dir, yaml };
}

function seedStalePointer(fixture: Fixture, session = 'acme'): void {
  updateState(fixture.dir, (state) => {
    const sess = (state.sessions[session] ??= emptySession());
    sess.launched_file = fixture.olderFile;
    sess.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    sess.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
  });
  noteLaunchedPane(fixture.home, fixture.olderFile, 'pane-lead', session);
}

function seedRegistryTeam(
  fixture: Fixture,
  options: {
    session?: string;
    lobbySession?: string;
    includeWorkerInRoster?: boolean;
    root?: string;
    project?: string;
  } = {},
): string {
  const root = options.root ?? fixture.root;
  const id = teamIdOf(root);
  const session = options.session ?? 'acme';
  upsertTeam(fixture.home, id, {
    project: options.project ?? 'acme',
    session,
    root,
    ...(options.lobbySession !== undefined
      ? { lobby: join(fixture.home, '.config', 'team', 'lobby') }
      : {}),
    at: NOW.toISOString(),
  });
  if (options.lobbySession !== undefined && options.lobbySession !== session) {
    upsertTeam(fixture.home, id, {
      project: options.project ?? 'acme',
      session: options.lobbySession,
      root,
      lobby: join(fixture.home, '.config', 'team', 'lobby'),
      at: NOW.toISOString(),
    });
    upsertTeam(fixture.home, id, {
      project: options.project ?? 'acme',
      session,
      root,
      at: NOW.toISOString(),
    });
  }
  const roster = [
    { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
    { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
    { agent: 'agt_333333333333', seat: 'helper', role: 'implementer' },
    ...(options.includeWorkerInRoster === false
      ? []
      : [{ agent: 'agt_222222222222', seat: 'worker', role: 'implementer' }]),
  ];
  setRoster(fixture.home, id, roster);
  return id;
}

function makeHarness(fixture: Fixture, initialRunning = false): {
  sources: RestartSources;
  did: { created: number; closed: string[]; runs: string[] };
} {
  const did = { created: 0, closed: [] as string[], runs: [] as string[] };
  let workerAlive = initialRunning;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({
        name: 'worker',
        agent: 'claude-code',
        pane: 'pane-old',
        workspace: 'ws-old',
        status: 'idle',
        cwd: fixture.root,
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({
          name: slot.name,
          agent: 'claude-code',
          pane,
          workspace: slot.workspace,
          status: 'idle',
          cwd: fixture.root,
        });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => currentAgents().map((a) => a.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === 'ws-old') workerAlive = false;
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
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => currentAgents().map((a) => a.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? IDLE,
    typeText(_session, pane, text) {
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) slot.text = IDLE;
      return true;
    },
    agentStatus: () => 'idle',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: fixture.home,
  };

  const sources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((a) => ({ id: a.workspace })),
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
  };

  return { sources, did };
}

function lobbyCallerSourcesIo(fixture: Fixture, sessionName = 'acme'): ReturnType<typeof testIo> {
  const baseIo = testIo(fixture.lobby);
  baseIo.callerSources = (session?: string) => ({
    ancestors: () => [
      { pid: 200, name: 'claude' },
      { pid: 100, name: 'herdr' },
    ],
    agents: () =>
      session === undefined || session === sessionName
        ? [
            {
              name: 'lead',
              agent: 'claude-code',
              pane: 'pane-lead',
              workspace: 'ws-lead',
              status: 'idle',
              cwd: fixture.lobby,
            },
          ]
        : [],
    paneRootPid: (pane: string) => (pane === 'pane-lead' ? 200 : null),
    env: { HERDR_PANE_ID: 'pane-lead' },
    stdinIsTTY: false,
  });
  return baseIo;
}

describe('1. a stale launched pointer to an older team file no longer refuses a seat the current team declares', () => {
  test('a seat added after the session was launched restarts cleanly when declared by the current team', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(io.err).not.toContain('not a signed declared seat');
  });

  test('a seat placed through real callerSources (process walk under the terminal host from a lobby, no io.caller override) restarts via the registry fallback', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const { sources, did } = makeHarness(fixture, false);
    const io = lobbyCallerSourcesIo(fixture, 'acme');

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(io.err).toContain(
      `note: worker is not in the team this session was launched from; reading the team registered for session acme (${fixture.root})\n`,
    );
  });

  test('when another registered team on a different session also has a seat with the same name, real callerSources from a lobby still resolves this session team', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const otherRoot = join(fixture.base, 'beta');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    writeFileSync(join(otherRoot, '.agents', 'team.yaml'), fixture.yaml.replace('project: acme', 'project: beta'));
    seedRegistryTeam(fixture, { root: otherRoot, project: 'beta', session: 'beta-sess' });

    const { sources, did } = makeHarness(fixture, false);
    const io = lobbyCallerSourcesIo(fixture, 'acme');

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(io.err).toContain(
      `note: worker is not in the team this session was launched from; reading the team registered for session acme (${fixture.root})\n`,
    );
  });
});

describe('2. each fallback step in order', () => {
  test('step 1 (launched pointer team): when the launched file itself declares the seat, no fallback notice is emitted', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    // "helper" is already declared in olderFile, so step 1 answers without falling back.
    const code = await runRestart(['helper'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted helper; pane none -> pane-new\n');
    expect(io.err).not.toContain('is not in the team this session was launched from');
  });

  test('step 2 (folder team): when launched file omits the seat, cwd folder team answers before registry and prints the folder notice across normal, --dry-run, and --json', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const expectedNotice = `note: worker is not in the team this session was launched from; reading the team this folder holds (${fixture.file})`;

    // Dry run: notice appears on stdout prefixed with "! ".
    const dryHarness = makeHarness(fixture, false);
    const dryIo = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker', '--dry-run'], dryIo, dryHarness.sources)).toBe(0);
    expect(dryIo.out).toContain(`! ${expectedNotice}\n`);
    expect(dryIo.err).toBe('');

    // JSON dry run: notice appears once in doc.notes.
    const jsonHarness = makeHarness(fixture, false);
    const jsonIo = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker', '--dry-run', '--json'], jsonIo, jsonHarness.sources)).toBe(0);
    const parsed = JSON.parse(jsonIo.out) as { notes: string[] };
    expect(parsed.notes.filter((n) => n === expectedNotice)).toHaveLength(1);

    // Live run: notice appears once on stderr.
    const liveHarness = makeHarness(fixture, false);
    const liveIo = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker'], liveIo, liveHarness.sources)).toBe(0);
    expect(liveIo.err).toContain(`${expectedNotice}\n`);
    expect(liveHarness.did.created).toBe(1);
  });

  test('step 3a (registry team by session): from outside the checkout folder, registry team for the session answers', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture, { session: 'acme' });

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.err).toContain(
      `note: worker is not in the team this session was launched from; reading the team registered for session acme (${fixture.root})\n`,
    );
  });

  test('step 3b (registry team by recorded lobby session): matches when record.lobbies[session] is defined', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture, 'acme');
    seedRegistryTeam(fixture, { session: 'primary-sess', lobbySession: 'acme' });

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.err).toContain(
      `note: worker is not in the team this session was launched from; reading the team registered for session acme (${fixture.root})\n`,
    );
  });
});

describe('3. a registry team whose record lacks the run session is refused', () => {
  test('when the registry team holds the seat in its roster but for another session, restart refuses', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture, 'acme');
    seedRegistryTeam(fixture, { session: 'unrelated-session' });

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    expect(io.err).toBe('team restart: worker is not a signed declared seat\n');
  });

  test('when multiple registry candidates match the seat and session, restart refuses rather than guessing', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture, 'acme');
    seedRegistryTeam(fixture, { session: 'acme' });

    const otherRoot = join(fixture.base, 'beta');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    writeFileSync(join(otherRoot, '.agents', 'team.yaml'), fixture.yaml);
    seedRegistryTeam(fixture, { root: otherRoot, project: 'beta', session: 'acme' });

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    expect(io.err).toBe('team restart: worker is not a signed declared seat\n');
  });

  test('when two registry candidates both name the session and one has an unreadable team file, the ambiguity does not collapse to the other candidate', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture, 'acme');
    seedRegistryTeam(fixture, { session: 'acme' });

    const brokenRoot = join(fixture.base, 'broken-beta');
    mkdirSync(join(brokenRoot, '.agents'), { recursive: true });
    // No team.yaml written in brokenRoot, so readTeamConfig fails on that candidate.
    seedRegistryTeam(fixture, { root: brokenRoot, project: 'beta', session: 'acme' });

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    expect(io.err).toBe('team restart: worker is not a signed declared seat\n');
  });
});

describe('4. a team file failing validation refuses with the configuration exit', () => {
  test('when the launched pointer file fails validation, restart refuses with exit 2 (configuration) and never falls back to folder or registry', async () => {
    const fixture = makeFixture();
    writeFileSync(fixture.olderFile, 'format: 99\nproject: acme\n');
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['worker', '--json'], io, sources);
    expect(code).toBe(2);
    expect(did.created).toBe(0);
    assertJsonErrorShape(io.out, { id: 'restart.configuration' });
  });

  test('when the lone registry candidate naming the session has an invalid team file, restart keeps configuration exit 2 instead of falling back to the pointer', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture, 'acme');
    seedRegistryTeam(fixture, { session: 'acme' });
    writeFileSync(fixture.file, 'format: 99\nproject: acme\n');

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.lobby, leadCaller);

    const code = await runRestart(['worker', '--json'], io, sources);
    expect(code).toBe(2);
    expect(did.created).toBe(0);
    assertJsonErrorShape(io.out, { id: 'restart.configuration' });
  });

  test('when --file names a team file that fails validation, owner gets configuration exit 2', async () => {
    const fixture = makeFixture();
    const invalidFile = join(fixture.dir, 'broken.yaml');
    writeFileSync(invalidFile, 'format: 1\nproject: acme\nseats: []\n');

    const { sources, did } = makeHarness(fixture, false);
    const ownerIo = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker', '--file', invalidFile, '--json'], ownerIo, sources);
    expect(code).toBe(2);
    expect(did.created).toBe(0);
    assertJsonErrorShape(ownerIo.out, { id: 'restart.configuration' });
  });
});

describe('5. --file stays owner-only and never falls back', () => {
  test('a lead seat passing --file is refused with owner-only exit 1', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['worker', '--file', fixture.file, '--json'], io, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    const doc = assertJsonErrorShape(io.out, { id: 'restart.caller' });
    expect(doc.error.message).toContain("--file is the owner's");
  });

  test('when the owner passes --file naming an older file, it never falls back to folder or registry', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const { sources, did } = makeHarness(fixture, false);
    const ownerIo = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker', '--file', fixture.olderFile], ownerIo, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    expect(ownerIo.err).toBe('team restart: worker is not a signed declared seat\n');
  });
});

describe('6. an undeclared seat is still refused with today text', () => {
  test('a seat absent from launched pointer, folder team, and registry team is refused with today text', async () => {
    const fixture = makeFixture();
    seedStalePointer(fixture);
    seedRegistryTeam(fixture);

    const { sources, did } = makeHarness(fixture, false);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['ghost'], io, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    expect(io.err).toBe('team restart: ghost is not a signed declared seat\n');
  });
});
