// Independent verification for live delivery address rebind (852299cac + 508ccd7b5):
//
// Claims under test:
//  (2) `team up` records the socket address for every declared claude-code seat whose record
//      holds a pane, gated by record identity, with `team register` repairing a pane the record
//      cannot name.
//  (4) `team check` names a live seat that is wakeable only through its pane processes, with the
//      repair `team up` or `team register <seat>`.
//
// Adversarial synthetic scenes:
//  - `up` must never record an address for a pane another seat owns;
//  - `up` must never record or clear an address on a registry record from another session or pane;
//  - a stale record naming a dead process (both bare-shell `gone` and `replaced` by an unknown PID);
//  - two seats claiming one pane;
//  - `check` must not suggest a repair that rebinds the wrong pane or a repair (`team register`)
//    that refuses a restored session (`verdict === 'replaced'`, `continuity === 'restored'`).
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runRegister } from '../src/commands/register.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, deliverBriefs, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SESSION = 'acme';
const MODEL = 'Claude Opus';
const VERSION = '5.5';
const LAUNCH = 'claude --model claude-opus-5-5';

const tempRoots: string[] = [];

afterEach(() => {
  discardFixtures(tempRoots.splice(0));
});

type World = {
  base: string;
  root: string;
  dir: string;
  home: string;
  lobby: string;
  sockets: string;
  sock: (pid: number, at?: Date) => string;
  addressOf: (seat: string) => string | null;
  sessionOf: (seat: string) => string | null;
  paneOfRecord: (seat: string) => string | null;
  stateOf: (seat: string) => SeatState | undefined;
};

function createWorld(seatNames: readonly string[] = ['worker', 'peer']): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'live-rebind-ind-')));
  tempRoots.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const lobby = join(home, '.config', 'team', 'lobby');
  const sockets = join(base, 'socks');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    stdio: 'ignore',
    env: gitEnv(),
  });
  writeFileSync(join(root, 'README.md'), 'acme\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore', env: gitEnv() });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd: root, stdio: 'ignore', env: gitEnv() },
  );

  const seatsYaml = [
    `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
    human: true`,
    ...seatNames.map(
      (name) => `  - role: implementer
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
    inbound: accept`,
    ),
  ].join('\n');

  const yaml = `format: 1
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
${seatsYaml}
`;
  writeFileSync(join(dir, 'team.yaml'), yaml);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: yaml },
    loaded.team.seats,
    home,
  );
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: SESSION,
    root,
    at: NOW.toISOString(),
    roster: [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator' },
      ...seatNames.map((seat, idx) => ({
        agent: `agt_${String(idx + 1).padStart(12, '0')}`,
        seat,
        role: 'implementer',
      })),
    ],
  });

  return {
    base,
    root,
    dir,
    home,
    lobby,
    sockets,
    sock: (pid: number, at: Date = NOW) => {
      const p = join(sockets, `${String(pid)}.sock`);
      writeFileSync(p, '');
      utimesSync(p, at, at);
      return p;
    },
    addressOf: (seat: string) => findAgent(home, { team: teamIdOf(root), seat })?.reach.address ?? null,
    sessionOf: (seat: string) => findAgent(home, { team: teamIdOf(root), seat })?.reach.session ?? null,
    paneOfRecord: (seat: string) => findAgent(home, { team: teamIdOf(root), seat })?.reach.pane ?? null,
    stateOf: (seat: string) => readState(dir).sessions[SESSION]?.seats[seat],
  };
}

function declareInboundAccept(w: World, seat: string, at: Date = new Date(NOW.getTime() - 60_000)): void {
  const path = cliHookSettingsPath(w.dir, SESSION, seat);
  if (path === null) throw new Error(`no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ crossSessionInbound: 'accept' }, null, 2)}\n`);
  utimesSync(path, at, at);
}

function defaultHandle(seat: string): string {
  const hex = Buffer.from(seat, 'utf8').toString('hex').padEnd(12, '0').slice(0, 12);
  return `seat_${hex}`;
}

function recordSeatState(
  w: World,
  seat: string,
  spec: {
    stage: 'ready' | 'launched';
    pane: string;
    workspace: string;
    handle?: string;
    agentSession?: string;
    launched?: { shell: number; cli: number[] };
  },
): void {
  const held: SeatState = {
    stage: spec.stage,
    id: spec.handle ?? defaultHandle(seat),
    pane: spec.pane,
    workspace: spec.workspace,
    ...(spec.launched === undefined ? {} : { launched: spec.launched }),
    agent_session: spec.agentSession ?? `ses_${seat}`,
    model: MODEL,
    version: VERSION,
    launch_line: LAUNCH,
  };
  updateState(w.dir, (file) => {
    const s = (file.sessions[SESSION] ??= emptySession());
    s.seats[seat] = held;
    s.watch = { heartbeat: NOW.toISOString(), pane: 'fixture-watch-pane' };
  });
}

function registerSeatAgent(
  w: World,
  seat: string,
  spec: {
    session?: string;
    pane: string | null;
    address: string | null;
    handle?: string;
    agentSession?: string;
  },
): void {
  registerAgent(w.home, {
    name: seat,
    signing: { model: MODEL, version: VERSION, role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: LAUNCH,
    reach: {
      team: teamIdOf(w.root),
      seat,
      session: spec.session ?? SESSION,
      pane: spec.pane,
      address: spec.address,
      agent_session: spec.agentSession ?? `ses_${seat}`,
    },
    seat_handle: spec.handle ?? defaultHandle(seat),
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function makeUpSources(
  w: World,
  scene: {
    agents: Array<{ name: string | null; pane: string; workspace: string; status?: string; session?: string }>;
    processes: Record<string, { shell: number; foreground: number[] } | null>;
    screens?: Record<string, string>;
    workspaces?: Array<{ id: string; label: string }>;
  },
): { sources: UpSources; runs: string[]; created: string[]; closed: string[] } {
  const runs: string[] = [];
  const created: string[] = [];
  const closed: string[] = [];
  const paneList = Array.from(
    new Set([
      ...scene.agents.map((a) => a.pane),
      ...Object.keys(scene.processes),
    ]),
  );
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      created.push(label);
      return { pane: `pane-new-${String(created.length)}`, workspace: `space-new-${String(created.length)}` };
    },
    paneRun(_session, pane, command) {
      runs.push(`${pane}: ${command}`);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => paneList,
    agents: () =>
      scene.agents.map((a) => ({
        name: a.name,
        agent: 'claude',
        pane: a.pane,
        workspace: a.workspace,
        status: a.status ?? 'idle',
        cwd: w.root,
        ...(a.session === undefined ? {} : { session: a.session }),
      })),
    workspacePanes: (_session, ws) => scene.agents.filter((a) => a.workspace === ws).map((a) => a.pane),
    paneText: (_session, pane) => scene.screens?.[pane] ?? CLAUDE_IDLE,
    foreground: (_session, pane) => (scene.processes[pane] === null || scene.processes[pane] === undefined ? null : ['claude']),
    processInfo: (_session, pane) => scene.processes[pane] ?? null,
    shellBack: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.289',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: w.home,
  };
  const workspaces =
    scene.workspaces ??
    Array.from(new Set(scene.agents.map((a) => a.workspace))).map((id) => ({ id, label: id }));
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => launch.agents(SESSION),
      workspaces: () => workspaces,
      home: w.home,
      doctor,
      launch,
      sockets: w.sockets,
      now: () => NOW,
      sleep: async () => {},
    },
    runs,
    created,
    closed,
  };
}

function runCheck(w: World, live: Live): { code: number; out: string } {
  const io = testIo(w.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (root) => approvalStanding(root, w.home),
    now: () => NOW,
    home: w.home,
    sockets: w.sockets,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('live-delivery-rebind independent scenes', () => {
  test('1. baseline claims (2) and (4): up records socket for ready and launched seats with matching identity, and check names pane-only socket seats with team up vs team register', async () => {
    const w = createWorld(['worker', 'peer']);
    declareInboundAccept(w, 'worker');
    declareInboundAccept(w, 'peer');
    const workerSock = w.sock(200);
    const peerSock = w.sock(300);

    // worker has recorded process identity; peer has none (predates process identity).
    recordSeatState(w, 'worker', {
      stage: 'ready',
      pane: 'pane-worker',
      workspace: 'space-worker',
      launched: { shell: 100, cli: [200] },
    });
    recordSeatState(w, 'peer', {
      stage: 'ready',
      pane: 'pane-peer',
      workspace: 'space-peer',
    });
    registerSeatAgent(w, 'worker', { pane: 'pane-worker', address: null });
    registerSeatAgent(w, 'peer', { pane: 'pane-peer', address: null });

    // Before `up`, `team check` names both live seats whose socket is proven only by their pane:
    // - `worker` (matching process identity + same session) gets `repair: team up`
    // - `peer` (no recorded process identity) gets `repair: team register peer`
    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'space-lead', status: 'idle', cwd: w.root },
        { name: 'worker', agent: 'claude', pane: 'pane-worker', workspace: 'space-worker', status: 'idle', cwd: w.root },
        { name: 'peer', agent: 'claude', pane: 'pane-peer', workspace: 'space-peer', status: 'idle', cwd: w.root },
      ],
      workspaces: [
        { id: 'space-lead', label: 'lead' },
        { id: 'space-worker', label: 'worker' },
        { id: 'space-peer', label: 'peer' },
      ],
      screens: {
        'pane-lead': CLAUDE_IDLE,
        'pane-worker': CLAUDE_IDLE,
        'pane-peer': CLAUDE_IDLE,
      },
      processes: {
        'pane-worker': { shell: 100, foreground: [200] },
        'pane-peer': { shell: 101, foreground: [300] },
      },
    };
    deliverBriefs({
      dir: w.dir,
      root: w.root,
      session: SESSION,
      seats: ['worker', 'peer'],
      home: w.home,
      at: NOW.toISOString(),
    });
    const checked = runCheck(w, live);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain(
      "difference: worker: a reader without its pane sees pull-on-turn, not push: only the socket its pane's processes carry proves it, and its agent record holds no address this session can dial\n  repair: team up",
    );
    expect(checked.out).toContain(
      "difference: peer: a reader without its pane sees pull-on-turn, not push: only the socket its pane's processes carry proves it, and its agent record holds no address this session can dial\n  repair: team register peer",
    );

    // Running `team up` records `worker`'s socket and leaves `peer`'s address null (telling the user to run `team register peer`).
    const upScene = makeUpSources(w, {
      agents: [
        { name: 'worker', pane: 'pane-worker', workspace: 'space-worker' },
        { name: 'peer', pane: 'pane-peer', workspace: 'space-peer' },
      ],
      processes: {
        'pane-worker': { shell: 100, foreground: [200] },
        'pane-peer': { shell: 101, foreground: [300] },
      },
    });
    const upIo = testIo(w.root, { kind: 'owner' });
    expect(await runUp([], upIo, upScene.sources)).toBe(0);
    expect(w.addressOf('worker')).toBe(workerSock);
    expect(w.addressOf('peer')).toBeNull();
    expect(peerSock).toContain('300.sock');
  });

  test('2. stale record naming a dead process: bare-shell gone clears stale address, while replaced process (unknown PID) never records the stranger socket and clears or refuses rebind', async () => {
    const w = createWorld(['worker', 'peer']);
    const staleWorkerSock = w.sock(200);
    const strangerPeerSock = w.sock(999);

    // `worker` is at `launched`, its CLI (200) exited leaving only shell (100), and its registry record still holds `200.sock`.
    recordSeatState(w, 'worker', {
      stage: 'launched',
      pane: 'pane-worker',
      workspace: 'space-worker',
      launched: { shell: 100, cli: [200] },
    });
    registerSeatAgent(w, 'worker', { pane: 'pane-worker', address: staleWorkerSock });

    // `peer` is at `ready`, its recorded CLI (300) died and its pane now holds an unrelated PID (999) listening on `999.sock`.
    recordSeatState(w, 'peer', {
      stage: 'ready',
      pane: 'pane-peer',
      workspace: 'space-peer',
      launched: { shell: 101, cli: [300] },
    });
    registerSeatAgent(w, 'peer', { pane: 'pane-peer', address: null });

    const upScene = makeUpSources(w, {
      agents: [
        { name: null, pane: 'pane-worker', workspace: 'space-worker' },
        { name: 'peer', pane: 'pane-peer', workspace: 'space-peer', session: 'ses_stranger' },
      ],
      processes: {
        'pane-worker': { shell: 100, foreground: [100] },
        'pane-peer': { shell: 101, foreground: [999] },
      },
      screens: {
        'pane-worker': 'unrecognised shell prompt',
        'pane-peer': CLAUDE_IDLE,
      },
    });
    const upIo = testIo(w.root, { kind: 'owner' });
    await runUp([], upIo, upScene.sources, { nonInteractive: true });

    // `worker`'s dead address was cleared because verdict === 'gone' and shell 100 has no socket.
    expect(w.addressOf('worker')).toBeNull();
    // `peer` must NEVER be given stranger PID 999's socket (`999.sock`).
    expect(w.addressOf('peer')).not.toBe(strangerPeerSock);
    expect(w.addressOf('peer')).toBeNull();
  });

  test('3. adversarial: up must never record an address for a pane another seat owns, or when two seats claim one pane', async () => {
    const w = createWorld(['worker', 'peer']);
    const peerSock = w.sock(300);

    // `peer` genuinely owns `pane-peer` (process { shell: 101, cli: [300] }, socket `300.sock`).
    // `worker`'s state record was left pointing at `pane-peer` with `{ shell: 101, cli: [300] }`.
    // The terminal host's agent list explicitly says `pane-peer` is named `peer` (owned by `peer`, NOT `worker`).
    recordSeatState(w, 'worker', {
      stage: 'launched',
      pane: 'pane-peer',
      workspace: 'space-peer',
      launched: { shell: 101, cli: [300] },
    });
    recordSeatState(w, 'peer', {
      stage: 'ready',
      pane: 'pane-peer',
      workspace: 'space-peer',
      launched: { shell: 101, cli: [300] },
    });
    registerSeatAgent(w, 'worker', { pane: 'pane-peer', address: null });
    registerSeatAgent(w, 'peer', { pane: 'pane-peer', address: null });

    const upScene = makeUpSources(w, {
      agents: [{ name: 'peer', pane: 'pane-peer', workspace: 'space-peer' }],
      processes: {
        'pane-peer': { shell: 101, foreground: [300] },
      },
    });
    const upIo = testIo(w.root, { kind: 'owner' });
    await runUp([], upIo, upScene.sources, { nonInteractive: true });

    // `peer` gets its own socket, and `worker` must NEVER be given `peer`'s socket address on `pane-peer`!
    expect(w.addressOf('peer')).toBe(peerSock);
    expect(w.addressOf('worker')).toBeNull();
  });

  test('4. adversarial: up must never overwrite or clear an address on a registry record from another session or pane', async () => {
    const w = createWorld(['worker', 'peer']);
    w.sock(200);
    const foreignPeerSock = w.sock(900);

    // `worker` in session `acme` is at `stage: launched` (not ready, not started in this run) with live PID 200.
    // Its registry record belongs to `other-session` on `other-pane` with `address: null`.
    recordSeatState(w, 'worker', {
      stage: 'launched',
      pane: 'pane-worker',
      workspace: 'space-worker',
      launched: { shell: 100, cli: [200] },
    });
    registerSeatAgent(w, 'worker', {
      session: 'other-session',
      pane: 'other-pane',
      address: null,
    });

    // `peer` in session `acme` has a stale state record at `stage: launched` whose local pane is at bare shell (`gone`),
    // while `peer` is running live in `other-session` on `other-peer-pane` with socket `900.sock`.
    recordSeatState(w, 'peer', {
      stage: 'launched',
      pane: 'pane-peer',
      workspace: 'space-peer',
      launched: { shell: 101, cli: [300] },
    });
    registerSeatAgent(w, 'peer', {
      session: 'other-session',
      pane: 'other-peer-pane',
      address: foreignPeerSock,
    });

    const upScene = makeUpSources(w, {
      agents: [
        { name: 'worker', pane: 'pane-worker', workspace: 'space-worker' },
        { name: null, pane: 'pane-peer', workspace: 'space-peer' },
      ],
      processes: {
        'pane-worker': { shell: 100, foreground: [200] },
        'pane-peer': { shell: 101, foreground: [101] },
      },
      screens: {
        'pane-worker': 'still starting up, no prompt yet',
        'pane-peer': 'shell prompt',
      },
    });
    const upIo = testIo(w.root, { kind: 'owner' });
    await runUp([], upIo, upScene.sources, { nonInteractive: true });

    // Because both registry records still belong to `other-session`, `up` in `acme` must neither
    // attach `acme`'s socket to `worker` nor clear `peer`'s live `other-session` socket!
    expect(w.sessionOf('worker')).toBe('other-session');
    expect(w.addressOf('worker')).toBeNull();
    expect(w.sessionOf('peer')).toBe('other-session');
    expect(w.addressOf('peer')).toBe(foreignPeerSock);
  });

  test('5. adversarial: check must not suggest a repair that rebinds the wrong pane when two seats claim one pane or when a registry record points to another pane', () => {
    const w = createWorld(['worker', 'peer']);
    declareInboundAccept(w, 'worker');
    declareInboundAccept(w, 'peer');
    w.sock(200);

    // Both `worker` and `peer` claim `pane-shared` in state.json!
    recordSeatState(w, 'worker', {
      stage: 'ready',
      pane: 'pane-shared',
      workspace: 'space-shared',
      launched: { shell: 100, cli: [200] },
    });
    recordSeatState(w, 'peer', {
      stage: 'ready',
      pane: 'pane-shared',
      workspace: 'space-shared',
      launched: { shell: 100, cli: [200] },
    });
    registerSeatAgent(w, 'worker', { pane: 'pane-shared', address: null });
    registerSeatAgent(w, 'peer', { pane: 'pane-other', address: null });

    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'space-lead', status: 'idle', cwd: w.root },
        { name: 'worker', agent: 'claude', pane: 'pane-shared', workspace: 'space-shared', status: 'idle', cwd: w.root },
        { name: 'peer', agent: 'claude', pane: 'pane-shared', workspace: 'space-shared', status: 'idle', cwd: w.root },
      ],
      workspaces: [
        { id: 'space-lead', label: 'lead' },
        { id: 'space-shared', label: 'shared' },
      ],
      screens: {
        'pane-lead': CLAUDE_IDLE,
        'pane-shared': CLAUDE_IDLE,
      },
      processes: {
        'pane-shared': { shell: 100, foreground: [200] },
      },
    };
    const checked = runCheck(w, live);

    // `check` must never tell BOTH `worker` and `peer` to bind `pane-shared`'s socket via `team up` / `team register`!
    const bindsWorker =
      checked.out.includes('difference: worker: a reader without its pane sees pull-on-turn, not push') &&
      (checked.out.includes('repair: team up') || checked.out.includes('repair: team register worker'));
    const bindsPeer =
      checked.out.includes('difference: peer: a reader without its pane sees pull-on-turn, not push') &&
      (checked.out.includes('repair: team up') || checked.out.includes('repair: team register peer'));
    expect(bindsWorker && bindsPeer).toBe(false);
  });

  test('6. adversarial: when a ready seat is restored with a new PID and matching session continuity, check must suggest team up (which adopts and rebinds), not team register (which refuses)', async () => {
    const w = createWorld(['worker']);
    declareInboundAccept(w, 'worker');
    const restoredSock = w.sock(999);

    // `worker` was launched with PID 200 and session `ses_worker`, then restored by the terminal host
    // under PID 999 with the same `ses_worker` (`verdict === 'replaced'`, `continuity === 'restored'`).
    recordSeatState(w, 'worker', {
      stage: 'ready',
      pane: 'pane-worker',
      workspace: 'space-worker',
      agentSession: 'ses_worker',
      launched: { shell: 100, cli: [200] },
    });
    registerSeatAgent(w, 'worker', {
      pane: 'pane-worker',
      address: null,
      agentSession: 'ses_worker',
    });
    deliverBriefs({
      dir: w.dir,
      root: w.root,
      session: SESSION,
      seats: ['worker'],
      home: w.home,
      at: NOW.toISOString(),
    });

    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'space-lead', status: 'idle', cwd: w.root },
        {
          name: 'worker',
          agent: 'claude',
          pane: 'pane-worker',
          workspace: 'space-worker',
          status: 'idle',
          cwd: w.root,
          session: 'ses_worker',
        },
      ],
      workspaces: [
        { id: 'space-lead', label: 'lead' },
        { id: 'space-worker', label: 'worker' },
      ],
      screens: {
        'pane-lead': CLAUDE_IDLE,
        'pane-worker': CLAUDE_IDLE,
      },
      processes: {
        'pane-worker': { shell: 101, foreground: [999] },
      },
    };

    // Calling `team register worker` on this scene refuses (`register.replaced`) because `held.launched` is set and `continuity !== 'same'`.
    const regIo = testIo(w.root, { kind: 'owner' });
    const regCode = await runRegister(['worker'], regIo, {
      home: w.home,
      sessionState: () => 'running',
      agents: () => live.agents,
      processInfo: (_s, p) => live.processes?.[p] ?? null,
      foreground: () => ['claude'],
      paneText: (_s, p) => live.screens[p] ?? null,
      now: () => NOW,
    });
    expect(regCode).toBe(1);
    expect(regIo.err).toContain('holds a process other than the one its record\'s launch started');

    // `team up` ALREADY adopts `{ shell: 101, cli: [999] }` in place (`restored` / `adopted`) and records `999.sock`
    // in a single `team up` run, without any `team restart` and without any `machine.load_start` gate!
    const checked = runCheck(w, live);
    expect(checked.code).toBe(1);

    const upScene = makeUpSources(w, {
      agents: [{ name: 'worker', pane: 'pane-worker', workspace: 'space-worker', session: 'ses_worker' }],
      processes: {
        'pane-worker': { shell: 101, foreground: [999] },
      },
    });
    const upIo = testIo(w.root, { kind: 'owner' });
    expect(await runUp([], upIo, upScene.sources)).toBe(0);
    expect(w.addressOf('worker')).toBe(restoredSock);
    expect(w.stateOf('worker')?.launched).toEqual({ shell: 101, cli: [999] });

    // Therefore `team check` must suggest `repair: team up` (which adopts the restored process and rebinds the socket in place),
    // NOT `team register worker` (which refuses) and NOT `team restart worker, then team up` (which needlessly restarts a live
    // restored session and refuses on a lead seat or above `machine.load_start`)!
    expect(checked.out).toContain(
      "difference: worker: a reader without its pane sees pull-on-turn, not push: only the socket its pane's processes carry proves it, and its agent record holds no address this session can dial\n  repair: team up",
    );
  });
});
