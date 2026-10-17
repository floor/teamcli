// The boundaries of a swap's second half and of the record it leaves. `team add <lead>` asks the
// delegate gate for the swap word only when the seat is a lead; a launch that never reaches
// ready keeps the swapping record (so `doctor` still names the gap as a swap, not a crash); a
// record for a seat the file no longer declares is said by no one; and a record that is not a
// who-and-when is dropped at the one door state enters through.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { swapFindings, type DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { LOG_FILE, STATE_FILE, emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = CLAUDE_IDLE;
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';
const SWAP_AT = '2026-10-15T07:00:00.000Z';

const SEAT = (name: string, role: string): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const BASE = `format: 1
project: acme
coordinator: lead
operator: op
workspace:
  mode: shared
  base: main
seats:
${SEAT('lead', 'coordinator')}${SEAT('op', 'operator')}${SEAT('worker', 'implementer')}`;

const owner = { kind: 'owner' as const };
const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w1:p1', session: 'main' };

let base: string;
let home: string;
let project: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function approve(text: string = BASE): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = text.includes('trust:')
    ? text
    : text.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\n`);
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root), file: yaml }, loaded.team.seats, home);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-swap-b-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'branch', 'fix/fresh');
  approve(BASE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

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

function world(): { launch: Launch; creates: string[]; renames: string[]; session: 'absent' | 'running' } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = { launch: {} as Launch, creates: [] as string[], renames: [] as string[], session: 'absent' as 'absent' | 'running' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

function sources(made: ReturnType<typeof world>, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

describe('the swap record and the add that closes it', () => {
  test('a delegated add asks the gate for the swap word only when the seat is a lead', async () => {
    approve(`${BASE}delegates:\n  - pane: main/w1:p1\n    commands: [add]\n`);
    const made = world();
    const asked: Array<{ command: string; swap?: boolean }> = [];
    const gate: NonNullable<AddSources['delegateGate']> = (input) => {
      asked.push({ command: input.command, swap: input.swap });
      return { kind: 'refused', id: 'add.delegate-command', text: 'the approved delegate main/w1:p1 may not run `add`; its approved commands are add' };
    };
    const lead = testIo(project, pilot);
    expect(await runAdd(['lead'], lead, sources(made, { delegateGate: gate }))).toBe(1);
    expect(lead.err).toContain('may not run `add`');
    const worker = testIo(project, pilot);
    expect(await runAdd(['worker'], worker, sources(made, { delegateGate: gate }))).toBe(1);
    // The lead's add is admitted by `swap` alone; a worker's never is, so the gate is not asked
    // for it — an entry listing only `swap` cannot start an ordinary seat through this door.
    expect(asked).toEqual([{ command: 'add', swap: true }, { command: 'add' }]);
    expect(made.creates).toEqual([]);
  });

  test('a launch that never reaches ready keeps the record, and doctor still names the gap', async () => {
    updateState(join(project, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).swapping = { lead: { by: 'owner', at: SWAP_AT } };
    });
    const before = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    const made = world();
    // The pane comes up at a dialog and never reaches its prompt: the seat is left out, and the
    // swap is still in progress — the owner finishes it, then runs `team add lead` again.
    made.launch.paneText = (_session, pane) => (pane === 'w1:p1' ? PERMISSION : IDLE);
    const io = testIo(project, owner);
    expect(await runAdd(['lead'], io, sources(made))).toBe(1);
    expect(io.out).toContain('lead: left out: permission\n');
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(before);
    const agents = join(project, '.agents');
    expect(readState(agents).sessions.acme?.swapping).toEqual({ lead: { by: 'owner', at: SWAP_AT } });
    expect(readFileSync(join(agents, LOG_FILE), 'utf8')).not.toContain('runs its new agent');
    // The seat's own record — here a pane left waiting at a dialog — keeps doctor quiet: the
    // gap line is for a seat with no record at all, which is the scene below.
    const loaded = loadTeamFile(project, { home });
    if (!loaded.ok) throw new Error('fixture');
    expect(swapFindings(loaded.team, agents, 'acme')).toEqual([]);
  });

  test('a swap record for a seat the file no longer declares is said by no one', () => {
    const agents = join(project, '.agents');
    updateState(agents, (state) => {
      (state.sessions.acme ??= emptySession()).swapping = {
        lead: { by: 'owner', at: SWAP_AT },
        ghost: { by: 'pilot', at: SWAP_AT },
      };
    });
    const loaded = loadTeamFile(project, { home });
    if (!loaded.ok) throw new Error('fixture');
    // `ghost` was taken out of the file by its owner: the gap is no longer a swap to finish.
    expect(swapFindings(loaded.team, agents, 'acme')).toEqual([
      { level: 'warn', text: `lead: stopped for a swap by owner at ${SWAP_AT}; run \`team add lead\` to start its new agent` },
    ]);
  });

  test('a swapping record that is not a who-and-when is dropped on read, beside a whole one', () => {
    const agents = join(project, '.agents');
    writeFileSync(join(agents, STATE_FILE), `${JSON.stringify({
      format: 1,
      sessions: {
        acme: { seats: {}, worktrees: {}, swapping: { lead: null, op: { by: 3, at: 'x' }, worker: { by: 'owner', at: SWAP_AT } } },
      },
    }, null, 2)}\n`);
    expect(readState(agents).sessions.acme?.swapping).toEqual({ worker: { by: 'owner', at: SWAP_AT } });
  });
});
