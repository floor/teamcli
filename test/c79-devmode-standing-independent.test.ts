// C7.9, third lab: a stored approval that does not verify, in and out of dev mode.
//
// The scene plants two records of its own. A legacy format-1 copy stores a four-line text the
// live file no longer matches, so the sentence's line count proves it quotes the stored copy and
// never the live file. A signed copy has its last signature byte flipped after approval, so the
// standing is `refused` with the signature's own line. In dev mode `team restart`, `team order`
// and `team worktree list` each name the record, say standing cannot be renewed and the owner is
// to be told, and continue; none of them signs, rewrites or re-generates the record, and none
// names the removed `team approve`. Outside dev mode each command keeps its own refusal.
//
// The restart cases run the real `performRestart`: its doctor preflight builds the standing's own
// blocking `miss` finding, so a green restart proves the dev-mode skip in the preflight as well
// as the caller's fold. A dry run is the preflight alone — it reaches the doctor block and stops
// before any stop — which is why one scene checks it on its own.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runOrder, type OrderSources } from '../src/commands/order.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { runWorktree } from '../src/commands/worktree.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { recordedGeneration } from '../src/store/keys.ts';
import { approvalStanding, LEGACY_LINE, storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T09:00:00Z');
const RENEW = 'standing cannot be renewed in this build, and the owner is to be told';
const SIGNATURE_WHY = 'the record does not carry a valid signature: it was changed after approval, or written without the key';
const PREVIEW = '("format: 1"; "project: acme"; "coordinator: lead")';

function seatBlock(role: string, name: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead')}
${seatBlock('operator', 'ops')}
${seatBlock('implementer', 'worker')}`;

// The legacy copy's own text: four non-empty lines, the first three quoted by the sentence. The
// live team.yaml is far longer, so a sentence quoting the live file would count different lines.
const STORED_COPY = 'format: 1\nproject: acme\ncoordinator: lead\napproved: the march copy\n';
const LEGACY_SENTENCE = `acme's approval record does not verify: 4 unverified lines ${PREVIEW}; ${RENEW}`;

type Fixture = { base: string; root: string; home: string; dir: string; yaml: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'c79-stand-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  // The restart and order gates read the team's trust; the fixture trusts its own lobby and root.
  const yaml = TEAM_YAML.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
  writeFileSync(join(dir, 'team.yaml'), yaml);
  return { base, root, home, dir, yaml };
}

type LoadedTeam = Extract<ReturnType<typeof loadTeamFile>, { ok: true }>;

function loaded(fixture: Fixture): LoadedTeam {
  const read = loadTeamFile(fixture.root, { home: fixture.home });
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  return read;
}

function storeOf(fixture: Fixture): string {
  const read = loaded(fixture);
  const store = storePath(read.team.project, read.root, fixture.home);
  mkdirSync(store, { recursive: true });
  return store;
}

// The approval files the store holds — the record, the ledger and the approved copy. A run that
// signs, rewrites or re-generates an approval changes one of them; the restart's own session log
// (sessions.jsonl, which every relaunch writes) is not an approval and is not counted.
const APPROVAL_FILES = ['approval.json', 'approved.yaml', 'ledger.json'] as const;

function storeBytes(store: string): string {
  return APPROVAL_FILES.map((name) => {
    try {
      return `${name}\n${readFileSync(join(store, name), 'utf8')}`;
    } catch {
      return `${name}\n(absent)`;
    }
  }).join('\n---\n');
}

/** A legacy format-1 record: the stored copy is STORED_COPY, not the live file. */
function plantLegacy(fixture: Fixture): { store: string; approval: string; bytes: string } {
  const read = loaded(fixture);
  const store = storeOf(fixture);
  const record = { ...approvalOf(read.team, read.root, NOW), format: 1 as const, file: STORED_COPY };
  delete record.lead;
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  const approval = join(store, 'approval.json');
  writeFileSync(approval, bytes);
  const standing = approvalStanding(read.root, fixture.home);
  if (standing.kind !== 'legacy') throw new Error(`planted standing is ${JSON.stringify(standing)}`);
  return { store, approval, bytes };
}

/** A signed record written by the store, then one flipped signature byte. */
function plantTampered(fixture: Fixture): { store: string; approval: string; bytes: string; generation: number } {
  const read = loaded(fixture);
  const store = storeOf(fixture);
  const generation = writeApproval(
    store,
    { approval: approvalOf(read.team, read.root, NOW), file: fixture.yaml },
    read.team.seats,
    fixture.home,
    NOW,
  );
  const approval = join(store, 'approval.json');
  const parsed = JSON.parse(readFileSync(approval, 'utf8')) as { signature?: unknown };
  if (typeof parsed.signature !== 'string' || parsed.signature.length === 0) {
    throw new Error('the planted approval carries no signature');
  }
  const at = parsed.signature.length - 1;
  const last = parsed.signature.charAt(at) === 'a' ? 'b' : 'a';
  parsed.signature = `${parsed.signature.slice(0, at)}${last}`;
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  writeFileSync(approval, bytes);
  const standing = approvalStanding(read.root, fixture.home);
  if (standing.kind !== 'refused' || standing.why !== SIGNATURE_WHY) {
    throw new Error(`planted standing is ${JSON.stringify(standing)}`);
  }
  return { store, approval, bytes, generation };
}

// ---------------------------------------------------------------------------------------------
// `team restart`: a real performRestart over one recorded idle seat. Everything the run reads
// from the pane host is answered here; the old pane is closed, a new workspace is created, and
// the launch's rules paste is drawn in the new composer so the read-back verifies, as it does
// on a real CLI.

type RestartDid = { typed: string[]; pasted: string[]; closed: string[]; created: number };

function restartWorld(fixture: Fixture): { sources: RestartSources; did: RestartDid } {
  updateState(fixture.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
  });
  const did: RestartDid = { typed: [], pasted: [], closed: [], created: 0 };
  let workerAlive = true;
  let boxed = claudeBox('');
  let shelled = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null }>();

  const agentsNow = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [];
    if (workerAlive) {
      list.push({ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: fixture.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name, agent: 'claude-code', pane, workspace: 'ws-new', status: 'idle', cwd: fixture.root });
      }
    }
    return list;
  };

  const closeWorkspace = (_session: string, workspace: string): boolean => {
    did.closed.push(workspace);
    if (workspace === 'ws-old') workerAlive = false;
    return true;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      boxed = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => agentsNow().map((agent) => agent.pane),
    closeWorkspace,
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
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${String(did.created)}`;
      newPanes.set(pane, { text: CLAUDE_IDLE, agent: false, name: null });
      return { pane, workspace: 'ws-new' };
    },
    paneRun(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agentsNow().map((agent) => agent.pane),
    agents: () => agentsNow(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? CLAUDE_IDLE,
    // A bracketed paste draws its text as the composer rows, so the delivery's read-back verifies.
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) slot.text = CLAUDE_IDLE;
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
    agents: () => agentsNow(),
    workspaces: () => [{ id: 'ws-old' }, ...(newPanes.size > 0 ? [{ id: 'ws-new' }] : [])],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => boxed,
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
  };

  return { sources, did };
}

// ---------------------------------------------------------------------------------------------
// `team order`: the sidebar reads lead, worker, ops against the roster lead, ops, worker, so the
// pass must re-create the tail. The delegated restart is this scene's own act — it closes the
// workspace, creates one at the end and records the new pane — so the pass's divergence and
// verification are exercised, not mocked away.

type OrderWorld = { workspaces: string[]; agents: HerdrAgent[]; restarts: string[]; next: number };

function placeForOrder(fixture: Fixture): void {
  updateState(fixture.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane1', workspace: 'w1' };
    session.seats.worker = { stage: 'ready', pane: 'pane2', workspace: 'w2' };
    session.seats.ops = { stage: 'ready', pane: 'pane3', workspace: 'w3' };
  });
}

function orderWorld(): OrderWorld {
  return {
    workspaces: ['w1', 'w2', 'w3'],
    agents: [
      { name: 'lead', agent: 'claude-code', pane: 'pane1', workspace: 'w1', status: 'idle', cwd: '/tmp' },
      { name: 'worker', agent: 'claude-code', pane: 'pane2', workspace: 'w2', status: 'idle', cwd: '/tmp' },
      { name: 'ops', agent: 'claude-code', pane: 'pane3', workspace: 'w3', status: 'idle', cwd: '/tmp' },
    ],
    restarts: [],
    next: 4,
  };
}

function orderSources(fixture: Fixture, world: OrderWorld): OrderSources {
  return {
    home: fixture.home,
    now: () => NOW,
    sessionState: () => 'running',
    workspaces: () => world.workspaces.map((id) => ({ id })),
    agents: () => world.agents,
    state: (dir) => readState(dir),
    restart: async (argv, io) => {
      const name = argv[0] ?? '';
      world.restarts.push(name);
      const flag = argv.indexOf('--session');
      const session = (flag >= 0 ? argv[flag + 1] : undefined) ?? 'acme';
      const held = readState(fixture.dir).sessions[session]?.seats[name];
      const oldWorkspace = held?.workspace ?? world.agents.find((agent) => agent.name === name)?.workspace;
      const created = `w${String(world.next)}`;
      if (oldWorkspace !== undefined) {
        world.workspaces = world.workspaces.filter((workspace) => workspace !== oldWorkspace);
        const agent = world.agents.find((one) => one.workspace === oldWorkspace);
        if (agent !== undefined) agent.workspace = created;
      }
      world.workspaces.push(created);
      const pane = `pane${String(world.next)}`;
      updateState(fixture.dir, (state) => {
        const record = (state.sessions[session] ??= emptySession());
        record.seats[name] = { stage: 'ready', pane, workspace: created };
      });
      world.next += 1;
      io.stdout(`team restart: restarted ${name}; pane -> ${pane}\n`);
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------

describe('a stored approval that does not verify, third lab', () => {
  test('dev mode restart names the legacy record, restarts the seat, and signs nothing', async () => {
    const fixture = makeFixture();
    const planted = plantLegacy(fixture);
    const before = storeBytes(planted.store);
    const generation = recordedGeneration(loaded(fixture).root, fixture.home);
    const { sources, did } = restartWorld(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };

    expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
    expect(io.err).toBe(`team restart: ${LEGACY_SENTENCE}\n`);
    expect(io.err).not.toContain('team approve');
    expect(io.out).not.toContain('team approve');
    expect(io.out).toContain('restarted worker');

    // The real relaunch happened: the old pane closed and the state records the new one.
    expect(did.created).toBe(1);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-new');

    // Nothing signed, rewrote or re-generated the record.
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(storeBytes(planted.store)).toBe(before);
    expect(recordedGeneration(loaded(fixture).root, fixture.home)).toEqual(generation);
  });

  test('outside dev mode the legacy record still refuses restart, and nothing is stopped', async () => {
    const fixture = makeFixture();
    const planted = plantLegacy(fixture);
    const { sources, did } = restartWorld(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, sources), io.err).toBe(1);
    expect(io.err).toBe(`team restart: ${LEGACY_LINE}\n`);
    expect(io.err).not.toContain(RENEW);
    expect(did.created).toBe(0);
    expect(did.typed).toEqual([]);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-old');
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
  });

  test('dev mode restart clears the doctor preflight for the same record: a dry run plans past a tampered copy', async () => {
    const fixture = makeFixture();
    const planted = plantTampered(fixture);
    const { sources, did } = restartWorld(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };

    expect(await runRestart(['worker', '--dry-run'], io, sources), io.err).toBe(0);
    expect(io.err).toBe('');
    const first = io.out.split('\n')[0] ?? '';
    expect(first.startsWith("! acme's approval record does not verify: ")).toBe(true);
    expect(first).toContain(PREVIEW);
    expect(first).toContain(RENEW);
    expect(first).not.toContain('team approve');
    // The preflight ran — the plan it let through names the stop — and the dry run made none.
    expect(io.out).toContain('stop worker in pane-old');
    expect(did.created).toBe(0);
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(recordedGeneration(loaded(fixture).root, fixture.home)?.generation).toBe(planted.generation);
  });

  test('dev mode restart past a tampered record reaches ready, and the record stays as it was', async () => {
    const fixture = makeFixture();
    const planted = plantTampered(fixture);
    const before = storeBytes(planted.store);
    const { sources, did } = restartWorld(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };

    expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
    expect(io.err.startsWith("team restart: acme's approval record does not verify: ")).toBe(true);
    expect(io.err).toContain(PREVIEW);
    expect(io.err).toContain(`${RENEW}\n`);
    expect(io.err).not.toContain('team approve');
    expect(io.out).toContain('restarted worker');
    expect(did.created).toBe(1);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-new');
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(storeBytes(planted.store)).toBe(before);
    expect(recordedGeneration(loaded(fixture).root, fixture.home)?.generation).toBe(planted.generation);
  });

  test('dev mode order names the legacy record and still re-creates the out-of-order tail', async () => {
    const fixture = makeFixture();
    const planted = plantLegacy(fixture);
    const before = storeBytes(planted.store);
    placeForOrder(fixture);
    const world = orderWorld();
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };

    expect(await runOrder([], io, orderSources(fixture, world)), io.err).toBe(0);
    expect(io.err).toBe(`team order: ${LEGACY_SENTENCE}\n`);
    expect(io.err).not.toContain('team approve');
    expect(world.restarts).toEqual(['ops', 'worker']);
    expect(world.workspaces).toEqual(['w1', 'w4', 'w5']);
    expect(io.out).toContain('team order: closing and re-creating ops, worker in roster order, each through team restart\n');
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(storeBytes(planted.store)).toBe(before);
  });

  test('outside dev mode the legacy record still refuses order, and no seat is re-created', async () => {
    const fixture = makeFixture();
    const planted = plantLegacy(fixture);
    placeForOrder(fixture);
    const world = orderWorld();
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runOrder([], io, orderSources(fixture, world)), io.err).toBe(1);
    expect(io.err).toBe(`team order: ${LEGACY_LINE}\n`);
    expect(io.err).not.toContain(RENEW);
    expect(world.restarts).toEqual([]);
    expect(world.workspaces).toEqual(['w1', 'w2', 'w3']);
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
  });

  test('dev mode worktree list names a tampered record and writes nothing', async () => {
    const fixture = makeFixture();
    const planted = plantTampered(fixture);
    const before = storeBytes(planted.store);
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };

    expect(await runWorktree(['list'], io, { home: fixture.home, now: () => NOW }), io.err).toBe(0);
    expect(io.err.startsWith("team worktree: acme's approval record does not verify: ")).toBe(true);
    expect(io.err).toContain(PREVIEW);
    expect(io.err).toContain(`${RENEW}\n`);
    expect(io.err).not.toContain('team approve');
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(storeBytes(planted.store)).toBe(before);
    expect(recordedGeneration(loaded(fixture).root, fixture.home)?.generation).toBe(planted.generation);
  });

  test('outside dev mode a tampered record still refuses worktree with its own line', async () => {
    const fixture = makeFixture();
    const planted = plantTampered(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runWorktree(['list'], io, { home: fixture.home, now: () => NOW })).toBe(1);
    expect(io.err).toBe(`team worktree: ${SIGNATURE_WHY}\n`);
    expect(io.err).not.toContain(RENEW);
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
  });
});
