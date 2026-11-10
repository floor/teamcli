// Independent scenes for the temporary seat's channel opt-out. A temporary add is quiet and its
// runtime line carries no TeamCLI channel option; a temporary clone of a Claude source whose own
// launch line spells the channel option gets that option erased with every other byte preserved;
// and a declared copy in the same file still starts with the default channel.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { importTeamFile } from '../src/file/team-import.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readState } from '../src/state.ts';
import { CLAUDE_IDLE, gitEnv, testIo, recordRenames } from './helpers.ts';

const NOW = new Date('2026-11-10T09:00:00Z');
const owner = { kind: 'owner' } as const;
const IDLE = CLAUDE_IDLE;
const CHANNEL_FLAG = '--dangerously-load-development-channels';

let base: string;
let project: string;
let home: string;
let lobby: string;

/** The team text this suite adds to: `worker` is a plain Claude source, `chan` spells the channel
 *  option in its own launch line. Trust and the lobby follow the current absolute-path form so a
 *  declared seat's channel prepares. */
function fileText(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
lobby: ${lobby}
trust:
  - ${project}
  - ${lobby}
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
    stopped: true
  - role: implementer
    name: chan
    label: chan
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5 --dangerously-load-development-channels server:team-inbox
    stopped: true
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'temporary-channel-off-')));
  home = join(base, 'home');
  lobby = join(home, 'lobby');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(lobby, { mode: 0o700 });
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
  writeFileSync(join(project, '.agents', 'team.yaml'), fileText());
  // The registry entry a channel seat's root resolves through: an imported team whose root is
  // this project and whose roster names the declared seats, so a declared seat's channel
  // prepares in the synthetic home.
  const imported = importTeamFile({ cwd: project, home, mode: 'migrate' });
  if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  upsertTeam(home, teamIdOf(project), {
    root: project, project: 'acme', session: 'acme', lobby,
    roster: ['lead', 'worker', 'chan'].map((seat, i) => ({ agent: `agt_${String(i + 1).padStart(12, '0')}`, seat, role: 'worker' })),
  });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

type Made = { launch: Launch; creates: string[]; renames: string[]; commands: string[]; session: 'absent' | 'running' };

/** A world whose launches reach an idle prompt; every runtime line a seat is started with is
 *  recorded in `commands`. */
function world(): Made {
  const panes = new Map<string, { text: string; agent: boolean }>();
  const paneOf = new Map<string, string>();
  let n = 0;
  let clock = NOW.getTime();
  const made: Made = { launch: {} as Launch, creates: [], renames: [], commands: [], session: 'absent' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`pane-${n}`, { text: IDLE, agent: false });
      paneOf.set(`ws-${n}`, `pane-${n}`);
      made.creates.push(label);
      return { pane: `pane-${n}`, workspace: `ws-${n}` };
    },
    paneRun(_session, pane, command) {
      made.commands.push(command);
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
      const pane = paneOf.get(workspace);
      return pane ? [pane] : [`${workspace}-pane1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  recordRenames(made.launch);
  return made;
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

function sources(made: Made, extra: Partial<AddSources> = {}): AddSources {
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

test('a temporary add is quiet and starts without the channel option', async () => {
  const made = world();
  const io = testIo(project, owner);
  expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], io, sources(made)), io.out + io.err).toBe(0);
  // Quiet: stdout holds the seat's one record and nothing else, and nothing warns.
  expect(io.out).toBe('worker-tmp-01: ready\n');
  expect(io.err).toBe('');
  expect(made.commands).toHaveLength(1);
  // The runtime line keeps the source's own launch bytes and carries no channel option.
  expect(made.commands[0]).toContain('claude --model claude-opus-5-5 --dangerously-skip-permissions');
  expect(made.commands[0]).not.toContain(CHANNEL_FLAG);
  expect(made.renames).toEqual(['worker-tmp-01']);
});

test('a temporary clone of a source that spells the channel option erases it and keeps every other byte', async () => {
  const made = world();
  const io = testIo(project, owner);
  expect(await runAdd(['--temporary', '--like', 'chan', '--until', 'merged:fix/fresh'], io, sources(made)), io.out + io.err).toBe(0);
  expect(io.out).toBe('chan-tmp-01: ready\n');
  expect(io.err).toBe('');
  expect(made.commands).toHaveLength(1);
  // The erased option leaves no residue: the source's launch bytes run straight into the standard
  // flags with a single space, and no development-channel flag or server name survives.
  expect(made.commands[0]).toContain('claude --model claude-opus-5-5 --dangerously-skip-permissions');
  expect(made.commands[0]).not.toContain(CHANNEL_FLAG);
  expect(made.commands[0]).not.toContain('team-inbox');
  expect(made.renames).toEqual(['chan-tmp-01']);
  const seat = readState(join(project, '.agents')).sessions.acme?.seats['chan-tmp-01'];
  expect(seat?.temporary).toEqual({ like: 'chan', until: 'merged:fix/fresh', own_commits: false });
  // The strip is runtime-only: the source's own entry in the file keeps its declared bytes.
  expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8'))
    .toContain('launch: claude --model claude-opus-5-5 --dangerously-load-development-channels server:team-inbox');
});

test('a declared seat started by add keeps the default channel', async () => {
  const made = world();
  const io = testIo(project, owner);
  expect(await runAdd(['worker'], io, sources(made)), io.out + io.err).toBe(0);
  expect(io.out).toBe('worker: ready\n');
  expect(made.commands).toHaveLength(1);
  // The declared path still prepares the channel: the default option rides the runtime line.
  expect(made.commands[0]).toContain(`${CHANNEL_FLAG} server:team-inbox`);
  expect(made.commands[0]).toContain('claude --model claude-opus-5-5');
  expect(made.renames).toEqual(['worker']);
});
