// Adversarial coverage for the granted orchestrator seat's `up` and `down`: the placement is
// the real walk — the agent list a session answers with, the pane roots the caller's process
// chain descends from, and the pane the state records — never a caller built by hand, because
// a spoof is an attack on the walk. A refused scene ends at its sentence, exit 1, with no
// effect: no workspace made or closed, no audit line. A granted `down` keeps both lead seats,
// whatever herdr's name for their panes is, and the audit line lands before the first effect.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { anotherPaneRefusal, noPaneRefusal } from '../src/caller.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { canonicalLanding } from '../src/file/paths.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { LOG_FILE, emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = CLAUDE_IDLE;

// The panes of the fixture: the caller's process chain descends from the root of the pane it
// runs on, and only the sessions whose list names a pane can place it.
type Pane = { pane: string; name: string; root: number };
const LEAD = { pane: 'lead-pane', name: 'lead', root: 100 };
const PILOT = { pane: 'pilot-pane', name: 'pilot', root: 200 };
const WORKER = { pane: 'worker-pane', name: 'worker', root: 300 };
const GHOST = { pane: 'ghost-pane', name: 'lead', root: 500 };
const OTHER_SESSION = { pane: 'far-pane', name: 'lead', root: 400 };
const ALPHA = ['lead-pane', 'pilot-pane', 'worker-pane'];

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

function teamText(opts: { scope?: string[]; grant?: boolean } = {}): string {
  const scope = opts.scope ?? ['up', 'down'];
  const grant = opts.grant === false ? '' : [
    'grant:',
    '  session: alpha',
    '  seat: lead',
    '  scope:',
    ...scope.map((act) => `    - ${act}`),
    '',
  ].join('\n');
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
${grant}`;
}

/** Writes the live file and, unless the scene says otherwise, the approval an owner's
 *  `team approve` of exactly that text leaves on this machine. */
function setup(opts: { scope?: string[]; grant?: boolean; approve?: boolean; live?: string } = {}): void {
  const text = opts.live ?? teamText(opts);
  writeFileSync(join(dir, 'team.yaml'), text);
  if (opts.approve === false) return;
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
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

/** The real placement walk, driven per session: the agents a session lists, the pane roots it
 *  answers for, the caller's ancestor chain, and the pane the environment hints at. */
function placeIo(
  panes: Pane[],
  lists: Record<string, string[]>,
  chain: number[],
  hint?: string,
): ReturnType<typeof testIo> {
  const io = testIo(root);
  io.env = hint === undefined ? {} : { HERDR_PANE_ID: hint };
  io.callerSources = (session: string | undefined) => ({
    ancestors: () => [{ pid: 1, name: 'herdr' }, ...chain.map((pid) => ({ pid, name: `step-${pid}` }))],
    agents: () => (session === undefined ? [] : (lists[session] ?? []).flatMap((pane) => {
      const found = panes.find((one) => one.pane === pane);
      return found ? [{ pane: found.pane, name: found.name, agent: null, workspace: '', status: '', cwd: null }] : [];
    })),
    paneRootPid: (pane: string) => (session !== undefined && (lists[session] ?? []).includes(pane)
      ? panes.find((one) => one.pane === pane)?.root ?? null
      : null),
    env: io.env,
    stdinIsTTY: false,
  });
  return io;
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

/** A launch whose every effect is recorded, and whose audit records too. A refused scene leaves
 *  all three empty. */
function upTrace(): { sources: UpSources; trace: UpTrace; session: () => 'absent' | 'running' } {
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
  return { sources, trace, session: () => session };
}

type DownTrace = { closed: string[]; typed: string[]; audits: { seat: string; act: string }[] };

/** The stop side: a worker that answers its box, workspaces that record their close, and an
 *  audit that records. `people` is the agent list the run reads — the name a pane carries is
 *  the scene's to choose. */
function downTrace(makePeople: () => HerdrAgent[]): { sources: DownSources; trace: DownTrace } {
  const trace: DownTrace = { closed: [], typed: [], audits: [] };
  let workerLive = true;
  let box = claudeBox('');
  const launch: DownLaunch = {
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      box = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      workerLive = false;
      return true;
    },
    agentPanes: () => makePeople()
      .filter((agent) => agent.pane !== 'worker-pane' || workerLive)
      .map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: DownSources = {
    sessionRunning: () => true,
    agents: () => makePeople().filter((agent) => !trace.closed.includes(agent.workspace)),
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => box,
    status: () => 'idle',
    foreground: () => (workerLive ? ['claude'] : ['zsh']),
    now: () => NOW,
    home,
    launch,
    grantAudit(_dir, seat, act) {
      trace.audits.push({ seat, act });
    },
  };
  return { sources, trace };
}

/** The named people of a running session, the shape herdr answers with. An override replaces
 *  the agent its pane carries — another name, or none at all. */
function people(...overrides: Array<Omit<Partial<HerdrAgent>, 'name'> & { pane: string; name: string | null }>): HerdrAgent[] {
  const stock: Record<string, HerdrAgent> = {
    'lead-pane': { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
    'pilot-pane': { name: 'pilot', agent: 'claude', pane: 'pilot-pane', workspace: 'pilot-ws', status: 'idle', cwd: null },
    'worker-pane': { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
  };
  const byPane = new Map(overrides.map((one) => [one.pane, one]));
  return Object.entries(stock).flatMap(([pane, agent]) => {
    const override = byPane.get(pane);
    return [override ? { ...agent, ...override } : agent];
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-boundaries-')));
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
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the placement walk decides the granted seat', () => {
  test('up refuses the orchestrator\'s name on a pane the state does not record', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER, GHOST], { alpha: ['ghost-pane', 'lead-pane', 'pilot-pane', 'worker-pane'] }, [GHOST.root], GHOST.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('up refuses the orchestrator\'s name placed in another session', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo(
      [LEAD, PILOT, WORKER, OTHER_SESSION],
      { alpha: ALPHA, beta: ['far-pane'] },
      [OTHER_SESSION.root],
      OTHER_SESSION.pane,
    );
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('up refuses the granted name on a pane no record holds', async () => {
    record({ worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('up refuses the operator\'s seat', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('down refuses the orchestrator\'s name on a pane the state does not record', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER, GHOST], { alpha: ['ghost-pane', ...ALPHA] }, [GHOST.root], GHOST.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${anotherPaneRefusal('lead', 'lead-pane')}\n`);
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });

  test('down refuses a caller placed in another session', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo(
      [LEAD, PILOT, WORKER, OTHER_SESSION],
      { alpha: ALPHA, beta: ['far-pane'] },
      [OTHER_SESSION.root],
      OTHER_SESSION.pane,
    );
    const code = await runDown([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain('team down: only the owner, the orchestrator or the operator stops the team; this call is ');
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });

  test('down refuses the granted name on a pane no record holds', async () => {
    record({ worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${noPaneRefusal('lead')}\n`);
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });

  test('down of the operator\'s seat keeps today\'s rule and writes no grant line', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(0);
    expect(trace.closed).toEqual(['worker-ws']);
    expect(io.out).toContain("skip lead: left running; only the owner stops the orchestrator's or the operator's seat\n");
    expect(io.out).toContain("skip pilot: left running; only the owner stops the orchestrator's or the operator's seat\n");
    expect(trace.audits).toEqual([]);
  });
});

describe('the scope the approval signed', () => {
  test('up is refused when the grant lists no `up`', async () => {
    setup({ scope: ['down'] });
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('down is refused when the grant lists no `down`', async () => {
    setup({ scope: ['up'] });
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('team down: the grant does not list `down`\n');
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });

  test('up with no grant section denies a seat', async () => {
    setup({ grant: false });
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('down with no grant section stays the seat\'s own run', async () => {
    setup({ grant: false });
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(0);
    expect(trace.closed).toEqual(['worker-ws']);
    expect(trace.audits).toEqual([]);
  });
});

describe('the approval the grant rides on', () => {
  test('the granted seat is admitted with no approval record', async () => {
    setup({ approve: false });
    rmSync(storePath('acme', root, home), { recursive: true, force: true });
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code, io.err + io.out).toBe(0);
    expect(io.err).not.toContain('never approved');
    expect(io.err).not.toContain('deny');
    // The session starts down, so the ready records are not kept and the three seats launch.
    expect(trace.workspaces).toEqual([
      { label: 'lead', cwd: root },
      { label: 'pilot', cwd: root },
      { label: 'worker', cwd: lobby },
    ]);
    expect(trace.closed).toEqual([]);
    expect(trace.audits).toEqual([]);
  });

  test('an edited grant admits the granted seat, and doctor does not name approve', async () => {
    setup();
    writeFileSync(join(dir, 'team.yaml'), teamText({ scope: ['up', 'down', 'approve'] }));
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code, io.err + io.out).toBe(0);
    expect(io.err).not.toContain('not the approved one');
    expect(io.err).not.toContain('team approve');
    expect(io.err).not.toContain('deny');
    expect(trace.workspaces).toEqual([
      { label: 'pilot', cwd: root },
      { label: 'worker', cwd: lobby },
    ]);
    expect(trace.audits).toEqual([{ seat: 'lead', act: 'up' }]);
    const doctorIo = testIo(root);
    await runDoctor([], doctorIo, doctor());
    expect(doctorIo.out + doctorIo.err).not.toContain('team approve');
  });

  test('an edited grant admits down', async () => {
    setup();
    writeFileSync(join(dir, 'team.yaml'), teamText({ scope: ['up', 'down', 'approve'] }));
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code, io.err).toBe(0);
    expect(io.err).not.toContain('not the approved one');
    expect(io.err).not.toContain('team approve');
    expect(trace.closed).toEqual(['worker-ws']);
  });
});

describe('the owner-only flags', () => {
  test('up refuses --file before the flagged path is read', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp(['--file', join(base, 'no-such-file.yaml')], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe("team up: --file is the owner's; the granted seat cannot use it\n");
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('up refuses --session before the named session is read', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp(['--session', 'beta'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe("team up: --session is the owner's; the granted seat cannot use it\n");
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('down refuses --file before the flagged path is read', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown(['--file', join(base, 'no-such-file.yaml')], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe("team down: --file is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n");
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });

  test('down refuses --session before the named session is read', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown(['--session', 'beta'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe("team down: --session is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n");
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });

  test('down refuses --abandon for the granted seat', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown(['--abandon'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('team down: only the owner abandons a team, from a terminal outside herdr\n');
    expect(trace).toMatchObject({ closed: [], typed: [], audits: [] });
  });
});

describe('the seats a granted down keeps', () => {
  test('a granted down keeps the orchestrator and a distinct operator', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(0);
    expect(trace.closed).toEqual(['worker-ws']);
    expect(trace.closed).not.toContain('lead-ws');
    expect(trace.closed).not.toContain('pilot-ws');
    expect(io.out).toContain("skip lead: left running; only the owner stops the orchestrator's or the operator's seat\n");
    expect(io.out).toContain("skip pilot: left running; only the owner stops the orchestrator's or the operator's seat\n");
    expect(trace.audits).toEqual([{ seat: 'lead', act: 'down' }]);
  });

  test('a granted down keeps the operator\'s pane when herdr shows no name for it', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources, trace } = downTrace(() => people({ pane: 'pilot-pane', name: '' }));
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(0);
    expect(trace.closed).toEqual(['worker-ws']);
    expect(trace.closed).not.toContain('pilot-ws');
  });

  test('a granted down keeps the orchestrator\'s pane when herdr shows another name for it', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    // The placement read still names the caller's pane; the stop list the run then reads carries
    // another name for it.
    const { sources, trace } = downTrace(() => people({ pane: 'lead-pane', name: 'ghost' }));
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(0);
    expect(trace.closed).toEqual(['worker-ws']);
    expect(trace.closed).not.toContain('lead-ws');
  });
});

describe('the audit line', () => {
  test('a dry granted up writes no audit line', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace, session } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp(['--dry-run'], io, sources);
    expect(code).toBe(0);
    expect(trace.audits).toEqual([]);
    expect(trace.workspaces).toEqual([]);
    expect(session()).toBe('absent');
  });

  test('a granted up writes its line through the real writer', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace } = upTrace();
    delete (sources as { logGranted?: unknown }).logGranted;
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(0);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    const lines = log.split('\n').filter((line) => line.includes('grant [grant]'));
    expect(lines).toEqual(['2026-10-14T09:00:00.000Z grant [grant] lead up']);
  });

  test('a granted down writes its line through the real writer', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const { sources } = downTrace(() => people());
    delete (sources as { grantAudit?: unknown }).grantAudit;
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code).toBe(0);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    const lines = log.split('\n').filter((line) => line.includes('grant [grant]'));
    expect(lines).toEqual(['2026-10-14T09:00:00.000Z grant [grant] lead down']);
  });

  test('a granted up that would repair the orchestrator\'s seat closes nothing of it', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code).toBe(0);
    expect(io.err).toContain("skip lead: left as it is; a granted up does not relaunch or close the orchestrator's seat\n");
    expect(trace.closed).toEqual([]);
    const workerAt = canonicalLanding(lobby).landing;
    expect(trace.workspaces).toContainEqual({ label: 'worker', cwd: workerAt });
    // The operator starts in the project; the orchestrator's own seat does not: one workspace
    // at the root, never two.
    expect(trace.workspaces.filter((one) => one.label === 'pilot' && one.cwd === root)).toHaveLength(1);
  });
});
