// `up` and `register` on the permission map, through the commands themselves. The map's rows
// (`src/permissions/map.ts`) say `up` is `owner-or-leads` and `register` is `owner-or-own-team`;
// these scenes hold each command to its own row, decided by `gateVerdict` on the caller's real
// placement — the registry's roster line where the registry holds the team, the file's own
// declaration where it does not — and to the pane proof that follows an admission. The owner and
// the seats a row names are admitted; a seat the row refuses is answered by the bare word on a
// real run and, on a dry run, by the reason, the owner's own command and the plan; a seat the
// state does not record where it claims to stand is refused even where the row admits it; and a
// seat's `--file` is still the owner's. Registry and file disagree on purpose in one scene: the
// roster is the record, and the file does not widen it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import type { Caller } from '../../src/caller.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runRegister, type RegisterSources } from '../../src/commands/register.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { setHerdrRun, type HerdrAgent } from '../../src/herdr.ts';
import { readAgents } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { emptySession, LOG_FILE, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const IDLE = CLAUDE_IDLE;
const OWNER = { kind: 'owner' as const } as Caller;

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function seat(name: string, role: string, extra: string[] = []): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...extra,
  ].join('\n');
}

/** The live file both commands read: an orchestrator, an operator and a plain implementer. No
 *  `grant` and no `delegates`: the map's row is the whole admission under test. */
function teamText(): string {
  return `format: 1
project: acme
coordinator: lead
operator: pilot
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator', ['    mode: shared', '    cwd: .'])}
${seat('pilot', 'operator', ['    count: 1'])}
${seat('worker', 'implementer', ['    count: 1'])}
`;
}

/** Writes the file and the approval an owner's `team approve` of exactly that text leaves, so
 *  `up`'s standing is in force and only the caller gate decides. */
function approve(text: string): void {
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function setup(): void {
  approve(teamText());
}

/** The same file with a verified grant that names the lead and lists `scope` alone. The
 *  default refuses `up` for every caller, the lead included. */
function grantedText(scope: string[] = ['down']): string {
  return `${teamText()}grant:
  session: alpha
  seat: lead
  scope:
${scope.map((act) => `    - ${act}`).join('\n')}
`;
}

function record(seats: Record<string, { pane: string; workspace: string }>): void {
  updateState(dir, (file) => {
    file.sessions.alpha = {
      ...emptySession(),
      seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [
        name,
        { stage: 'ready' as const, pane: seat.pane, workspace: seat.workspace },
      ])),
    };
  });
}

function seatCaller(name: string, pane: string): Caller {
  return { kind: 'seat', name, pane, session: 'alpha' };
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

type UpTrace = { workspaces: { label: string; cwd: string }[]; closed: string[]; audits: { seat: string; act: string }[] };

/** A launch whose every effect is recorded. A refused scene leaves all three empty. */
function upTrace(): { sources: UpSources; trace: UpTrace } {
  const trace: UpTrace = { workspaces: [], closed: [], audits: [] };
  const panes = new Map<string, string>();
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, cwd, label) {
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, IDLE);
      trace.workspaces.push({ label, cwd });
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane) {
      panes.set(pane, IDLE);
      return true;
    },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane) ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: UpSources = {
    sessionRunning: () => session === 'running',
    sessionState: () => session,
    agents: () => [],
    home,
    doctor: doctor(),
    launch,
    now: () => NOW,
    logGranted(_dir, seat, act) {
      trace.audits.push({ seat, act });
    },
  };
  return { sources, trace };
}

/** The plan an admitted lead's run makes: the orchestrator and the operator in the project
 *  folder, the implementer in the lobby, and the watch in its own workspace last. */
const PLAN = [
  { label: 'lead', cwd: '' },
  { label: 'pilot', cwd: '' },
  { label: 'worker', cwd: '' },
  { label: 'Watch · acme', cwd: '' },
];

function agent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: 'ws-1', status: 'idle', cwd: null, session: 'claude-session-1' };
}

/** `register`'s reads, faked: the session is up, herdr lists the seats given, and every pane
 *  holds a `claude-code` process at its idle prompt. */
function registerSources(names: [string, string][]): RegisterSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => names.map(([name, pane]) => agent(name, pane)),
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-register-gates-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  setup();
  // The address refresh reads herdr on its own; no pane of this machine is behind it here, and
  // an unreadable pane leaves the record alone.
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});

afterEach(() => {
  setHerdrRun(null);
  rmSync(base, { recursive: true, force: true });
});

function withCwd(plan: { label: string; cwd: string }[]): { label: string; cwd: string }[] {
  return plan.map((one) => ({ ...one, cwd: one.label === 'worker' ? lobby : root }));
}

describe('the up row (owner-or-leads)', () => {
  test('the orchestrator starts the team, and the run writes no audit line', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace } = upTrace();
    const io = testIo(root, seatCaller('lead', 'lead-pane'));
    const code = await runUp([], io, sources);
    expect(code, io.err + io.out).toBe(0);
    expect(trace.workspaces).toEqual(withCwd(PLAN));
    expect(trace.closed).toEqual([]);
    expect(trace.audits).toEqual([]);
  });

  test("a seat that holds no `leads` is denied, and its dry run names the rule, the owner's run and the plan", async () => {
    record({ pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources, trace } = upTrace();

    const real = testIo(root, seatCaller('pilot', 'pilot-pane'));
    expect(await runUp([], real, sources)).toBe(1);
    expect(real.err).toBe('deny\n');
    expect(real.out).toBe('');

    const dry = testIo(root, seatCaller('pilot', 'pilot-pane'));
    expect(await runUp(['--dry-run'], dry, sources)).toBe(1);
    expect(dry.err).toBe('');
    expect(dry.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is pilot\n');
    expect(dry.out).toContain('! to unblock: a `leads` seat runs `team up` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(dry.out).toContain('dry run: nothing was run\n');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('the registry roster mark `leads` is the same row, whatever the file declares', async () => {
    // The registry holds this team, and its roster marks the plain implementer as leading: the
    // roster line is the record, so the map's row admits it exactly as it admits the file's lead.
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'alpha',
      root,
      roster: [
        { agent: 'agt_aaaaaaaaaaaa', seat: 'lead', role: 'coordinator' },
        { agent: 'agt_bbbbbbbbbbbb', seat: 'worker', role: 'implementer', leads: true },
      ],
    });
    record({ worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = testIo(root, seatCaller('worker', 'worker-pane'));
    const code = await runUp([], io, sources);
    expect(code, io.err + io.out).toBe(0);
    expect(trace.workspaces).toEqual(withCwd(PLAN));
    expect(trace.audits).toEqual([]);
  });

  test('the admission is also the standing: a lead the state places elsewhere is denied', async () => {
    // The row admits the orchestrator by its record; the pane proof is the standing's, and the
    // state is what says where the seat stands.
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace } = upTrace();
    const elsewhere = testIo(root, seatCaller('lead', 'ghost-pane'));
    expect(await runUp([], elsewhere, sources)).toBe(1);
    expect(elsewhere.err).toBe('deny\n');

    // A state that records no pane for the seat refuses it too — the same closed door.
    record({});
    const unrecorded = testIo(root, seatCaller('lead', 'lead-pane'));
    expect(await runUp([], unrecorded, sources)).toBe(1);
    expect(unrecorded.err).toBe('deny\n');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test("a lead's `--file` is still the owner's, and the flagged file is never read", async () => {
    // `other.yaml` does not exist: an exit 1 with the caller sentence (not the file's exit 2)
    // is the proof that the aimed run stopped before the flagged path was opened.
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources } = upTrace();
    const io = testIo(root, seatCaller('lead', 'lead-pane'));
    const code = await runUp(['--dry-run', '--file', 'other.yaml'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
    expect(io.out).toContain('! to unblock: a `leads` seat runs `team up --file other.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(io.out).not.toContain('dry run: nothing was run');
  });

  test("a lead's aimed flags are refused before a refusing grant is considered, and the flag never widens the target", async () => {
    // The verified grant names the lead and lists `down` alone, so it refuses `up` for this
    // roster lead. The map's row admits the run; the owner-only rule for `--session` and
    // `--file` still runs first, whatever the grant said, so the aim cannot fall back to
    // the file's own session.
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'alpha',
      root,
      roster: [
        { agent: 'agt_aaaaaaaaaaaa', seat: 'lead', role: 'coordinator' },
        { agent: 'agt_bbbbbbbbbbbb', seat: 'worker', role: 'implementer', leads: true },
      ],
    });
    approve(grantedText());
    record({ worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();

    const real = testIo(root, seatCaller('worker', 'worker-pane'));
    expect(await runUp(['--session', 'other'], real, sources)).toBe(1);
    expect(real.err).toBe('deny\n');
    expect(real.out).toBe('');

    const dry = testIo(root, seatCaller('worker', 'worker-pane'));
    expect(await runUp(['--dry-run', '--session', 'other'], dry, sources)).toBe(1);
    expect(dry.err).toBe('');
    expect(dry.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is worker\n');
    expect(dry.out).toContain('! to unblock: a `leads` seat runs `team up --session other` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(dry.out).not.toContain('dry run: nothing was run');

    // `other.yaml` does not exist: the caller sentence, not the file's exit 2, is the proof the
    // flagged path was never opened — with a grant in the file exactly as without one.
    const flagged = testIo(root, seatCaller('worker', 'worker-pane'));
    expect(await runUp(['--dry-run', '--file', 'other.yaml'], flagged, sources)).toBe(1);
    expect(flagged.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is worker\n');
    expect(flagged.out).toContain('! to unblock: a `leads` seat runs `team up --file other.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('an admitted lead is not constrained by a grant that leaves `up` out, and starts the team', async () => {
    // The row admits the orchestrator and the file's grant lists `down` alone: a grant is the
    // fallback for a caller the map refused, never a second gate on an admitted run.
    approve(grantedText(['down']));
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace } = upTrace();
    const io = testIo(root, seatCaller('lead', 'lead-pane'));
    const code = await runUp([], io, sources);
    expect(code, io.err + io.out).toBe(0);
    expect(trace.workspaces).toEqual(withCwd(PLAN));
    expect(trace.audits).toEqual([]);
  });

  test('an admitted lead writes no grant audit line even where the grant would have passed', async () => {
    // The grant names this lead and lists `up`: asked before the map rule, it would set the
    // granted seat and the run would log `grant ... up` beside the map's own admission.
    approve(grantedText(['up', 'down']));
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace } = upTrace();
    const io = testIo(root, seatCaller('lead', 'lead-pane'));
    const code = await runUp([], io, sources);
    expect(code, io.err + io.out).toBe(0);
    expect(trace.workspaces).toEqual(withCwd(PLAN));
    expect(trace.audits).toEqual([]);
  });
});

describe('the register row (owner-or-own-team)', () => {
  test('a plain seat of this team registers another seat of its session', async () => {
    // The implementer holds no `leads`; `register`'s own row admits it anyway — it belongs to
    // the team whose record it writes.
    record({ worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const io = testIo(root, seatCaller('worker', 'worker-pane'));
    const code = await runRegister(['pilot'], io, registerSources([['worker', 'worker-pane'], ['pilot', 'pilot-pane']]));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('pilot: registered — pane pilot-pane; nothing was launched\n');
    expect(readState(dir).sessions.alpha?.seats.pilot?.pane).toBe('pilot-pane');
    expect(readState(dir).sessions.alpha?.seats.pilot?.stage).toBe('ready');
  });

  test('a caller no record stands for is refused, and its dry run names the owner\'s run', async () => {
    const unplaced: Caller = { kind: 'unplaced', reason: 'it runs under herdr' };
    const line = 'only the owner or a seat of this team registers a running seat; this call is unplaced (it runs under herdr)';

    const real = testIo(root, unplaced);
    expect(await runRegister(['pilot'], real, registerSources([['pilot', 'pilot-pane']]))).toBe(1);
    expect(real.err).toBe(`team register: ${line}\n`);
    expect(real.out).toBe('');
    expect(readAgents(home)).toEqual([]);

    const dry = testIo(root, unplaced);
    expect(await runRegister(['pilot', '--dry-run'], dry, registerSources([['pilot', 'pilot-pane']]))).toBe(1);
    expect(dry.err).toBe('');
    expect(dry.out).toContain(`! register would refuse: ${line}\n`);
    expect(dry.out).toContain('! to unblock: a seat of this team runs `team register pilot` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(dry.out).not.toContain('would register');
    expect(readAgents(home)).toEqual([]);
  });

  test('a seat the registry roster does not list has no record, whatever the file declares', async () => {
    // The registry holds this team and lists the lead alone: the file declares the worker, and
    // the roster is still the record — the map refuses it before any pane is read.
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'alpha',
      root,
      roster: [{ agent: 'agt_aaaaaaaaaaaa', seat: 'lead', role: 'coordinator' }],
    });
    record({ worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const io = testIo(root, seatCaller('worker', 'worker-pane'));
    const code = await runRegister(['pilot'], io, registerSources([['pilot', 'pilot-pane']]));
    expect(code).toBe(1);
    expect(io.err).toBe('team register: only the owner or a seat of this team registers a running seat; this call is worker\n');
    expect(readAgents(home)).toEqual([]);
  });

  test('the owner is the owner whatever the registry holds', async () => {
    upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'alpha', root, roster: [] });
    const io = testIo(root, OWNER);
    const code = await runRegister(['pilot'], io, registerSources([['pilot', 'pilot-pane']]));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('pilot: registered — pane pilot-pane; nothing was launched\n');
  });

  test('an admitted orchestrator registers where a grant leaves `up` out, and logs no grant line', async () => {
    // The row lists the orchestrator; the grant lists `down` alone. Asked before the map rule,
    // its refusal would block this run while a plain worker's passes.
    approve(grantedText(['down']));
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const io = testIo(root, seatCaller('lead', 'lead-pane'));
    const code = await runRegister(['pilot'], io, registerSources([['lead', 'lead-pane'], ['pilot', 'pilot-pane']]));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('pilot: registered — pane pilot-pane; nothing was launched\n');
    expect(readState(dir).sessions.alpha?.seats.pilot?.pane).toBe('pilot-pane');
    const log = existsSync(join(dir, LOG_FILE)) ? readFileSync(join(dir, LOG_FILE), 'utf8') : '';
    expect(log).not.toContain('grant [grant]');
  });

  test('an admitted orchestrator writes no grant audit line even where the grant would have passed', async () => {
    approve(grantedText(['up']));
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const io = testIo(root, seatCaller('lead', 'lead-pane'));
    const code = await runRegister(['pilot'], io, registerSources([['lead', 'lead-pane'], ['pilot', 'pilot-pane']]));
    expect(code, io.err).toBe(0);
    const log = existsSync(join(dir, LOG_FILE)) ? readFileSync(join(dir, LOG_FILE), 'utf8') : '';
    expect(log).toContain('register [lead]');
    expect(log).not.toContain('grant [grant]');
  });
});
