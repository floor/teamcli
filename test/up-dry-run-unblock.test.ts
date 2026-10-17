// A caller the run does not admit, at the terminal: the real run is answered with the bare word
// on stderr and nothing else. The dry run is never denied — it names the refusal once, names the
// owner's own run of this folder with the flags this caller used, and then the plan it would
// make. An aimed run — `--session`, or a `--file` other than this folder's own — stops at the
// owner-only refusal, whatever the file's grant says: the flagged target is never read, so no
// plan prints for it. Nothing the launch could do happens, and both runs exit 1. The harness is
// the granted seat's own coverage (`up-deny-boundaries.test.ts`): a project under git, the
// approval the owner's `team approve` leaves, and the real placement walk.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

type Pane = { pane: string; name: string; root: number };
const LEAD = { pane: 'lead-pane', name: 'lead', root: 100 };
const PILOT = { pane: 'pilot-pane', name: 'pilot', root: 200 };
const WORKER = { pane: 'worker-pane', name: 'worker', root: 300 };
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
grant:
  session: alpha
  seat: lead
  scope:
    - up
    - down
`;
}

function setup(): void {
  const text = teamText();
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

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-dry-run-unblock-')));
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

describe("up's dry run: the refusal, the owner's command, the plan", () => {
  test('a real run by a caller the run does not admit is the bare word, and nothing else', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources } = upTrace();
    for (const argv of [[], ['--file', 'other.yaml']]) {
      const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
      const code = await runUp(argv, io, sources);
      expect(code, `exit for [${argv.join(' ')}]`).toBe(1);
      expect(io.err, `stderr for [${argv.join(' ')}]`).toBe('deny\n');
      expect(io.out, `stdout for [${argv.join(' ')}]`).toBe('');
    }
  });

  test('the dry run names the refusal once, the owner\'s own run, and the plan it would make', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);

    const code = await runUp(['--dry-run'], io, sources);

    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain(
      '! up would refuse: only the owner or `leads` starts the team; this call is pilot\n',
    );
    // The one spelling: the refusal is printed once, and the plan follows it.
    expect(io.out.split('! up would refuse:').length - 1, 'refusal printed once').toBe(1);
    expect(io.out.indexOf('! up would refuse:')).toBeLessThan(io.out.indexOf('dry run: nothing was run'));
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(io.out).toContain('+ ');
    // No flag named, so the owner's command is the bare one.
    expect(io.out).toContain('! to unblock: the owner runs `team up` from this folder, at a terminal outside herdr\n');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('the unblock line carries the caller\'s own flags, quoted, and the aimed file is never read', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);

    const code = await runUp(['--dry-run', '--file', 'other.yaml'], io, sources);

    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain(
      '! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it runs under herdr)\n',
    );
    expect(io.out).toContain(
      '! to unblock: the owner runs `team up --file other.yaml` from this folder, at a terminal outside herdr\n',
    );
    // The named file keeps its meaning for the owner's run and is never read here — the file's
    // grant does not make the aim ordinary — so there is no plan for this folder's own file.
    expect(io.out).not.toContain('dry run: nothing was run');
    expect(io.out).not.toContain('+ ');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });

  test('a named session rides the unblock line too, and no plan follows it', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);

    const code = await runUp(['--dry-run', '--session', 'beta'], io, sources);

    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain(
      '! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it runs under herdr)\n',
    );
    expect(io.out).toContain(
      '! to unblock: the owner runs `team up --session beta` from this folder, at a terminal outside herdr\n',
    );
    expect(io.out).not.toContain('dry run: nothing was run');
  });
});
