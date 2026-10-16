// The adoption half of the same record checks, at the edge the merged unsigned-state file
// leaves out: the record carries a launch fingerprint and the pane holds a DIFFERENT process
// — not an unreadable pane (that launches fresh) and not the recorded one (that adopts), but
// a stranger. The add answers with the session-doubt refusal, whole, and launches nothing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T14:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

let base: string;
let project: string;
let home: string;

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - PROJECT_PLACEHOLDER
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
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
    # the seat stays in this order
    stopped: true
`;

const owner = { kind: 'owner' } as const;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-adoption-')));
  home = join(base, 'home');
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  const env = gitEnv();
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.com'],
  ] as const) {
    execFileSync('git', [...args], { cwd: project, stdio: 'ignore', env });
  }
  writeFileSync(join(project, 'README.md'), 'acme\n');
  execFileSync('git', ['add', 'README.md'], { cwd: project, stdio: 'ignore', env });
  execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: project, stdio: 'ignore', env });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: project, stdio: 'ignore', env });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: project, stdio: 'ignore', env });

  const yaml = FILE.replace('PROJECT_PLACEHOLDER', project);
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
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
    agents: () => [] as HerdrAgent[],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
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

/** The live unnamed agent in the seat's recorded workspace, on the seat's recorded pane. */
const stray = (): HerdrAgent => ({ name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });

describe('the record checks that gate an adoption', () => {
  test('a recorded fingerprint the pane no longer holds refuses the add outright', async () => {
    // The record carries the identity of the process it launched; the pane now runs another.
    // Not the unreadable-pane case (that quietly launches fresh): a readable pane whose
    // foreground is a stranger refuses the whole add as session-doubt.
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', launched: { shell: 100, cli: [101] } };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.processInfo = () => ({ shell: 100, foreground: [999] });
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [stray()],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code, `add said:\n${io.out}\n${io.err}`).toBe(1);
    expect(io.err).toBe('team add: lead: its pane holds a process this record cannot tie to the launch\n');
    expect(made.creates).toEqual([]);
  });
});
