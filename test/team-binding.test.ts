// A command binds to the longest place that holds the cwd: a registered root, a seat's
// configured cwd, or a lobby no other team shares. A shared seat name never falls through
// to another team, and outside every place it is refused by id.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { realSources as downSources, runDown } from '../src/commands/down.ts';
import { runRemove } from '../src/commands/remove.ts';
import { realSources as restartSources, runRestart } from '../src/commands/restart.ts';
import { runConfig } from '../src/commands/config.ts';
import type { Launch } from '../src/commands/up.ts';
import { runSeat } from '../src/commands/seat.ts';
import { realSeatsSources } from '../src/commands/seats.ts';
import { runSettings } from '../src/commands/settings.ts';
import { runSwap } from '../src/commands/swap.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamBinding, rootHolds } from '../src/registry/binding.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { resolveTarget } from '../src/send/resolve.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const SEAT = 'operator-3';

function agentId(seat: string): string {
  return `agt_${createHash('sha256').update(seat).digest('hex').slice(0, 12)}`;
}

function streams(io: { err: string; out: string }): string {
  return io.err + io.out;
}

function projectOf(out: string): string | undefined {
  const start = out.indexOf('{');
  if (start < 0) return undefined;
  return (JSON.parse(out.slice(start)) as { project?: string }).project;
}

function gitInit(cwd: string): void {
  const ran = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, env: gitEnv() });
  if (ran.status !== 0) throw new Error(ran.stderr.toString() || 'git init failed');
}

function teamFile(project: string, session: string, extraSeat: string | null, cwd: string | null = null, root: string | null = null): string {
  const trust = root === null ? '' : `trust:
  - ~/.config/team/lobby
  - ${root}
`;
  const extra = extraSeat === null ? '' : `
  - role: operator
    name: ${extraSeat}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
  return `format: 1
project: ${project}
session: ${session}
coordinator: lead
operator: lead
${trust}workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: ${SEAT}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${cwd === null ? '' : `\n    cwd: ${cwd}`}${extra}
`;
}

function register(home: string, root: string, project: string, session: string, seats: readonly string[]): void {
  upsertTeam(home, teamIdOf(root), {
    project,
    entity: null,
    session,
    root,
    roster: seats.map((seat) => ({ agent: agentId(seat), seat, role: 'operator' })),
    at: '2026-11-08T00:00:00.000Z',
  });
}

function world() {
  const base = fixtureBase('team-binding-');
  const home = join(base, 'home');
  const outer = join(base, 'team');
  const inner = join(outer, 'nested');
  const sibling = join(base, 'team-other');
  const away = join(base, 'away');
  const beside = join(outer, 'notes');
  for (const folder of [home, outer, inner, sibling, away, beside]) mkdirSync(folder, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  chmodSync(lobbyDir(home), 0o700);
  for (const folder of [outer, inner, sibling]) gitInit(folder);
  const write = (root: string, project: string, session: string, extra: string | null) => {
    const path = join(root, '.agents', 'team.yaml');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, teamFile(project, session, extra, null, root));
  };
  write(outer, 'outer', 'outer-session', 'only-outer');
  write(inner, 'inner', 'inner-session', null);
  write(sibling, 'sibling', 'sibling-session', null);
  register(home, outer, 'outer', 'outer-session', [SEAT, 'only-outer']);
  register(home, inner, 'inner', 'inner-session', [SEAT]);
  register(home, sibling, 'sibling', 'sibling-session', ['lead']);
  placeSeat(home, outer, 'outer-session', SEAT, 'pane-outer');
  placeSeat(home, inner, 'inner-session', SEAT, 'pane-inner');
  symlinkSync(inner, join(base, 'link-inner'));
  return { base, home, outer, inner, sibling, away, beside };
}

function discard(base: string): void {
  discardFixtures([base], { roots: [dirname(base)] });
}

function placeSeat(home: string, root: string, session: string, seat: string, pane: string): void {
  registerAgent(home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'operator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat, session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function agent(name: string, pane: string): HerdrAgent {
  return { name, agent: null, pane, workspace: 'ws', status: 'idle', cwd: null };
}

test('the longest root that holds the cwd wins, and a shared prefix does not', () => {
  const held = world();
  try {
    const inner = teamBinding(held.home, held.inner);
    const outer = teamBinding(held.home, held.beside);
    const sibling = teamBinding(held.home, held.sibling);
    const linked = teamBinding(held.home, join(held.base, 'link-inner'));
    expect(inner.kind).toBe('bound');
    expect(outer.kind).toBe('bound');
    expect(sibling.kind).toBe('bound');
    expect(linked.kind).toBe('bound');
    if (inner.kind === 'bound') expect(inner.team.project).toBe('inner');
    if (outer.kind === 'bound') expect(outer.team.project).toBe('outer');
    if (sibling.kind === 'bound') expect(sibling.team.project).toBe('sibling');
    if (linked.kind === 'bound') expect(linked.team.project).toBe('inner');
    expect(rootHolds(held.outer, held.sibling)).toBe(false);
    expect(rootHolds(held.sibling, held.outer)).toBe(false);
  } finally {
    discard(held.base);
  }
});

const NOW = () => new Date('2026-11-08T00:00:00.000Z');

/** Every CLI and host read a launch can make. Absent members fall through to the real binary, the real login check, or herdr. */
function doctorOf(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    agentList: () => [],
    now: NOW,
    home,
    getuid: () => process.getuid?.() ?? 0,
    runCheck: () => null,
    standing: () => ({ kind: 'none' }),
    paneText: () => '',
    watchAlive: () => false,
    processComm: () => null,
    watchPane: () => null,
    command: () => ({ status: 0, stdout: '', stderr: '' }),
  };
}

function stubLaunch(): Launch {
  return {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => false,
    createWorkspace: () => ({ pane: 'pane-new', workspace: 'ws-new' }),
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: NOW,
    conversationExists: () => null,
    applySidebar: () => ({ kind: 'unchanged', reloaded: [], failed: [] }),
    checkSidebarConfig: () => ({ ok: true, text: '' }),
    reloadSidebar: () => ({ applied: true, text: '' }),
    recordSidebarReload: () => {},
    processStartOf: () => null,
    processInfo: () => null,
  };
}

function hostRestart(home: string) {
  const { machine: _machine, codexThreads: _threads, launch: _launch, codexEndpoint: _endpoint, inboxRemove: _inbox, ...base } = restartSources;
  return {
    ...base,
    home,
    sessionRunning: () => true,
    sessionState: () => 'running' as const,
    agents: () => [],
    workspaces: () => [],
    alive: () => false,
    commandOf: () => null,
    startOf: () => null,
    cwdOf: () => null,
    screen: () => ({ kind: 'idle' as const }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => ['claude'],
    shellBack: () => null,
    foregroundCwd: () => null,
    processes: () => null,
    workspacePanes: () => [],
    now: NOW,
    standing: () => ({ kind: 'none' as const }),
    doctor: doctorOf(home),
    upLaunch: stubLaunch(),
  };
}

function hostDown(home: string) {
  const { launch: _launch, codexEndpoint: _endpoint, inboxRemove: _inbox, ...base } = downSources;
  return {
    ...base,
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    commandOf: () => null,
    startOf: () => null,
    cwdOf: () => null,
    screen: () => ({ kind: 'idle' as const }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => ['claude'],
    shellBack: () => null,
    foregroundCwd: () => null,
    processes: () => null,
    workspacePanes: () => [],
    now: NOW,
    standing: () => ({ kind: 'none' as const }),
  };
}

function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctorOf(home),
    now: NOW,
    launch: stubLaunch(),
  };
}

test('a shared seat name outside every team root is refused and names every team that declares it', async () => {
  const held = world();
  try {
    // The sibling file declares the shared seat even though its roster lists only lead.
    const holders = [teamIdOf(held.inner), teamIdOf(held.outer), teamIdOf(held.sibling)].sort();
    const binding = teamBinding(held.home, held.away, SEAT);
    expect(binding.kind).toBe('ambiguous');
    if (binding.kind !== 'ambiguous') return;
    expect(binding.ids).toEqual(holders);
    for (const id of holders) expect(binding.message).toContain(id);
    const io = testIo(held.away, { kind: 'owner' });
    const code = await runSettings([SEAT, '--json'], io, { home: held.home });
    expect(code, streams(io)).toBe(2);
    for (const id of holders) expect(io.out).toContain(id);
    const sent = resolveTarget(held.home, SEAT, { cwd: held.away });
    expect('error' in sent).toBe(true);
    if ('error' in sent) {
      for (const id of holders) expect(sent.error).toContain(id);
    }
  } finally {
    discard(held.base);
  }
});

test('a shared name outside every place binds to the team the caller stands in', () => {
  const held = world();
  try {
    updateState(join(held.outer, '.agents'), (state) => {
      const session = (state.sessions['outer-session'] ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    });
    const io = testIo(held.away, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'outer-session' });
    const binding = teamBinding(held.home, held.away, SEAT, io);
    expect(binding.kind).toBe('bound');
    if (binding.kind !== 'bound') return;
    expect(binding.by).toBe('caller');
    expect(binding.team.root).toBe(held.outer);
    expect(binding.team.project).toBe('outer');
  } finally {
    discard(held.base);
  }
});

test('an unreadable registry keeps the command\'s own refusal and exit', async () => {
  const held = world();
  try {
    writeFileSync(join(held.home, '.config', 'team', 'teams.yaml'), 'teams:\n  broken: [\n');
    expect(teamBinding(held.home, held.inner, SEAT).kind).toBe('unbound');
    const io = testIo(held.inner, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'inner-session' });
    const code = await runRestart([SEAT, '--dry-run', '--json'], io, hostRestart(held.home));
    expect(code, streams(io)).toBe(1);
    expect(JSON.parse(io.out).error.id).toBe('restart.caller');
  } finally {
    discard(held.base);
  }
});

test('from the inner root each seat command binds to the inner team', async () => {
  const held = world();
  try {
    const owner = { kind: 'owner' as const };
    const settings = testIo(held.inner, owner);
    expect(await runSettings([SEAT, '--json'], settings, { home: held.home }), streams(settings)).toBe(0);
    expect(projectOf(settings.out)).toBe('inner');

    const swapped = testIo(held.inner, owner);
    expect(await runSwap(['now', 'only-outer', '--json'], swapped, {
      home: held.home,
      sources: hostRestart(held.home),
      credentialProbe: () => 'present',
    }), streams(swapped)).toBe(1);
    expect(swapped.out + swapped.err).toContain('declared in inner');

    const removed = testIo(held.inner, owner);
    expect(await runRemove(['only-outer', '--json'], removed, hostRestart(held.home)), streams(removed)).toBe(1);
    expect(removed.out + removed.err).toContain('only-outer');
    expect(removed.out + removed.err).toContain('no seat');

    const sent = resolveTarget(held.home, SEAT, { cwd: held.inner });
    expect('error' in sent, 'error' in sent ? sent.error : '').toBe(false);
    if (!('error' in sent)) expect(sent.team.project).toBe('inner');

    const configured = testIo(held.inner, owner);
    expect(await runConfig(['get', 'project', '--json'], configured, { home: held.home }), streams(configured)).toBe(0);
    expect((JSON.parse(configured.out) as { value?: string }).value).toBe('inner');

    const seat = testIo(held.inner, owner);
    expect(await runSeat([SEAT, '--json'], seat, {
      ...realSeatsSources,
      home: held.home,
      now: () => new Date('2026-11-08T00:00:00.000Z'),
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    }), streams(seat)).toBe(0);
    expect(projectOf(seat.out)).toBe('inner');

    const pane = 'pane-inner';
    const restarted = testIo(held.inner, owner);
    const restartCode = await runRestart([SEAT, '--dry-run', '--json'], restarted, {
      ...hostRestart(held.home),
      agents: () => [agent(SEAT, pane)],
      workspaces: () => [{ id: 'ws' }],
    });
    expect(restartCode, streams(restarted)).toBe(0);
    expect(projectOf(restarted.out)).toBe('inner');
    expect(restarted.out).toContain(pane);

    const added = testIo(held.inner, owner);
    const addCode = await runAdd(['reviewer-9', '--like', SEAT, '--dry-run', '--json'], added, addSources(held.home));
    expect(addCode, streams(added)).toBe(0);
    expect(projectOf(added.out)).toBe('inner');

    const down = testIo(held.inner, owner);
    const downCode = await runDown(['--dry-run', '--json'], down, {
      ...hostDown(held.home),
      agents: () => [agent(SEAT, pane)],
    });
    expect(downCode, streams(down)).toBe(0);
    expect(projectOf(down.out)).toBe('inner');
    expect(down.out).toContain(pane);
  } finally {
    discard(held.base);
  }
});

test('from the outer root, outside the inner team, the command binds to the outer team', async () => {
  const held = world();
  try {
    const owner = { kind: 'owner' as const };
    const settings = testIo(held.beside, owner);
    expect(await runSettings([SEAT, '--json'], settings, { home: held.home }), streams(settings)).toBe(0);
    expect(projectOf(settings.out)).toBe('outer');

    const pane = 'pane-outer';
    const restarted = testIo(held.beside, owner);
    const code = await runRestart([SEAT, '--dry-run', '--json'], restarted, {
      ...hostRestart(held.home),
      agents: () => [agent(SEAT, pane)],
      workspaces: () => [{ id: 'ws' }],
    });
    expect(code, streams(restarted)).toBe(0);
    expect(projectOf(restarted.out)).toBe('outer');
    expect(restarted.out).toContain(pane);

    const sent = resolveTarget(held.home, SEAT, { cwd: held.beside });
    if (!('error' in sent)) expect(sent.team.project).toBe('outer');
    else throw new Error(sent.error);
  } finally {
    discard(held.base);
  }
});

test('a seat cwd outside the inner root binds the inner team, and the outer root still binds the rest', () => {
  const base = fixtureBase('team-binding-cwd-');
  const home = join(base, 'home');
  const outer = join(base, 'x');
  const inner = join(outer, 'inner');
  const seatCwd = join(outer, 'wt', 's1');
  const sub = join(seatCwd, 'sub');
  const other = join(outer, 'other');
  try {
    for (const folder of [home, outer, inner, sub, other]) mkdirSync(folder, { recursive: true });
    const write = (root: string, project: string, session: string, cwd: string | null) => {
      const path = join(root, '.agents', 'team.yaml');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, teamFile(project, session, null, cwd));
    };
    write(outer, 'outer', 'outer-session', null);
    write(inner, 'inner', 'inner-session', '../wt/s1');
    register(home, outer, 'outer', 'outer-session', [SEAT]);
    register(home, inner, 'inner', 'inner-session', [SEAT]);
    const fromSeat = teamBinding(home, sub);
    const fromOther = teamBinding(home, other);
    expect(fromSeat.kind).toBe('bound');
    expect(fromOther.kind).toBe('bound');
    if (fromSeat.kind === 'bound') expect(fromSeat.team.project).toBe('inner');
    if (fromOther.kind === 'bound') expect(fromOther.team.project).toBe('outer');
  } finally {
    discard(base);
  }
});

test('a lobby only one team records binds that team, and a shared lobby binds no one', () => {
  const base = fixtureBase('team-binding-lobby-');
  const home = join(base, 'home');
  const ownLobby = join(base, 'own-lobby');
  const ownDesk = join(ownLobby, 'desk');
  const sharedLobby = join(base, 'shared-lobby');
  const sharedDesk = join(sharedLobby, 'desk');
  const common = lobbyDir(home);
  const commonDesk = join(common, 'desk');
  const rootA = join(base, 'a');
  const rootB = join(base, 'b');
  const rootC = join(base, 'c');
  try {
    for (const folder of [home, ownDesk, sharedDesk, commonDesk, rootA, rootB, rootC]) mkdirSync(folder, { recursive: true });
    register(home, rootA, 'own', 'own-session', ['lead']);
    upsertTeam(home, teamIdOf(rootA), { lobby: ownLobby });
    register(home, rootB, 'left', 'left-session', ['lead']);
    register(home, rootC, 'right', 'right-session', ['lead']);
    upsertTeam(home, teamIdOf(rootB), { lobby: sharedLobby });
    upsertTeam(home, teamIdOf(rootC), { lobby: sharedLobby });
    const own = teamBinding(home, ownDesk);
    expect(own.kind).toBe('bound');
    if (own.kind === 'bound') expect(own.team.project).toBe('own');
    expect(teamBinding(home, sharedDesk).kind).toBe('unbound');
    const commonRoot = join(base, 'common-root');
    mkdirSync(commonRoot, { recursive: true });
    register(home, commonRoot, 'common', 'common-session', ['lead']);
    upsertTeam(home, teamIdOf(commonRoot), { lobby: common });
    expect(teamBinding(home, commonDesk).kind).toBe('unbound');
  } finally {
    discard(base);
  }
});
