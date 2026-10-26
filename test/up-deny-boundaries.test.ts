// The up page's `deny` answer, held to the binary that prints it. A caller the run does not
// admit — not the owner, not the granted seat, not a named delegate — is answered with the one
// word on a real run, and the page says so three ways: an admission row, an outcome row, two
// worked examples. A dry run is never denied: it names the refusal, the owner's own command and
// the plan. The pins hold each sentence to the page, and the promise itself to the command: the
// word alone on a real run, the two lines a dry run answers with, the named `--file` never read
// on either, no plan for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const PAGE = '../docs/internal/commands/up.md';
const UP_SRC = '../src/commands/up.ts';

// Whitespace runs collapse before the match, so a sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

// ── the harness of the granted seat's own coverage: a project under git, the approval an
// owner's `team approve` leaves, a state that records the seats, and the real placement walk.
// The deny answer is decided by that walk, never by a caller built by hand.
const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = CLAUDE_IDLE;

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

/** A launch whose every effect is recorded, and whose audit records too. A denied scene leaves
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-deny-boundaries-')));
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

describe('the deny answer on the up page', () => {
  test('the admission table promises the one word on a real run, and the reason on a dry run', () => {
    const page = prose(PAGE);
    expect(page.includes('a caller the run admits'), 'up.md lost the admitted-caller row').toBe(true);
    expect(
      page.includes(
        'a caller the run does not admit | a real run is answered with the one word `deny` on stderr and nothing on stdout — no reason, and no plan — and exit 1. A `--dry-run` is never denied: it prints `! up would refuse:` with that reason, `! to unblock:` with a `leads` seat\'s own run of this folder from its pane (or the owner\'s, from a terminal outside herdr), and — when no flag kept the file unread — the plan, and exits 1',
      ),
      'up.md lost the deny row',
    ).toBe(true);
  });

  test('the outcome table carries the bare word and the dry run\'s two lines', () => {
    expect(
      prose(PAGE).includes('a real run: `deny`, and nothing else: no `team up:` prefix, no reason, no plan'),
      'up.md lost the outcome row',
    ).toBe(true);
    // The word the page promises is the command's own write: the one line, no prefix.
    expect(raw(UP_SRC).includes("out.stderr('deny\\n')"), 'up.ts no longer prints the bare word').toBe(true);
  });

  test('the worked example shows the real run answered, and the dry run answered with the reason', () => {
    const page = raw(PAGE);
    expect(page.includes('team up --file other.yaml ; echo "exit $?"\ndeny\nexit 1'), 'up.md lost the real-run example').toBe(true);
    expect(
      page.includes(
        'team up --dry-run --file other.yaml ; echo "exit $?"\n' +
          '! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it is run by an agent (claude) outside herdr)\n' +
          '! to unblock: a `leads` seat runs `team up --file other.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\nexit 1',
      ),
      'up.md lost the dry-run example',
    ).toBe(true);
  });

  test('a dry run by a caller the run does not admit names the reason, the command and the plan', async () => {
    // The operator's seat, placed by the real walk on its own recorded pane: the run does not
    // admit it. A real run — bare, or with the worked examples' `--file` — is answered with the
    // word alone. A dry run is never denied: the reason, the one command that unblocks it, and,
    // when the run had a file of its own to plan, the plan. Nothing the launch could do happens.
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const { sources, trace } = upTrace();
    for (const argv of [[], ['--file', 'other.yaml']]) {
      const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
      const code = await runUp(argv, io, sources);
      expect(code, `exit for [${argv.join(' ')}]`).toBe(1);
      expect(io.err, `stderr for [${argv.join(' ')}]`).toBe('deny\n');
      expect(io.out, `stdout for [${argv.join(' ')}]`).toBe('');
    }
    // The own file's dry run plans the run: the reason, the one command that unblocks it, then
    // the plan it would make.
    const own = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
    expect(await runUp(['--dry-run'], own, sources)).toBe(1);
    expect(own.err).toBe('');
    expect(own.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is pilot\n');
    expect(own.out).toContain('! to unblock: a `leads` seat runs `team up` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(own.out).toContain('dry run: nothing was run\n');
    expect(own.out.indexOf('! up would refuse:')).toBeLessThan(own.out.indexOf('dry run: nothing was run'));
    expect(own.out).toContain('+ ');

    // The owner-only flag meets the walk's own sentence first: the flagged file is never read,
    // so no plan follows — the same answer a file with no grant gives.
    const aimed = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
    expect(await runUp(['--dry-run', '--file', 'other.yaml'], aimed, sources)).toBe(1);
    expect(aimed.err).toBe('');
    expect(aimed.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it runs under herdr)\n');
    expect(aimed.out).toContain('! to unblock: a `leads` seat runs `team up --file other.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(aimed.out).not.toContain('dry run: nothing was run');
    expect(trace).toMatchObject({ workspaces: [], closed: [], audits: [] });
  });
});
