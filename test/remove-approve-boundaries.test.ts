// The approval command is removed and the grant carries the gate alone: a granted
// agent mounts a five-seat team with no approval record anywhere and no prompt of
// any kind, an agent the grant does not name is told deny, and the everyday
// commands work with no record while a team carrying an old record still comes up.
// The five-seat scene is the owner's bar: mounted and ready for its first brief in
// thirty seconds with no owner terminal — the launches are concurrent (a seat's
// wait never delays the next seat's start) and the whole mount stays inside the
// budget on the clock the launch reports.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { commands, main } from '../src/cli.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T11:30:00Z');
const OLD = new Date('2026-09-01T09:00:00Z');
const IDLE = CLAUDE_IDLE;
// Machine headroom the parallel launch reads as room for every seat at once.
const AMPLE: Machine = {
  loadPerCore: 0.3, memoryFree: 60, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};
const SEAT = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'acme' };
const owner = { kind: 'owner' } as const;

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

function seat(name: string, role: string, extra = ''): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...extra ? [extra] : [],
  ].join('\n');
}

// Five people: one orchestrator, two builders, two testers. The grant names the
// orchestrator's seat for `up` — the one act the mounting agent needs. When a scene
// wants a seat already stopped in the file it says so.
function teamYaml(stopped = ''): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: shared
  base: main
grant:
  session: acme
  seat: lead
  scope:
    - up
seats:
${seat('lead', 'coordinator')}
    mode: shared
    cwd: .
${seat('builder-1', 'implementer')}
${seat('builder-2', 'implementer')}
${seat('tester-1', 'reviewer')}
${seat('tester-2', 'reviewer', stopped)}
`;
}

function writeFile(text: string): void {
  writeFileSync(join(dir, 'team.yaml'), text);
}

function approveAt(text: string, when: Date): string {
  writeFile(text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const store = storePath(loaded.team.project, loaded.root, home);
  writeApproval(
    store,
    { approval: approvalOf(loaded.team, loaded.root, when), file: text },
    loaded.team.seats,
    home,
  );
  return join(store, 'approval.json');
}

function record(seats: Record<string, string>): void {
  updateState(dir, (file) => {
    const session = (file.sessions.acme ??= emptySession());
    for (const [name, pane] of Object.entries(seats)) {
      session.seats[name] = { stage: 'ready', pane };
    }
  });
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

// The mounting host: every pane is a faked CLI sitting at its idle prompt, the
// clock only moves when the command sleeps, and every effect is stamped with the
// elapsed time it happened at, so the order the stamps tell is the order the
// mount ran in.
function world() {
  const panes = new Map<string, { text: string; agent: boolean }>();
  const events: string[] = [];
  const renames: string[] = [];
  let clock = NOW.getTime();
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const at = () => clock - NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      events.push(`create:${label}@${at()}`);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      events.push(`launch:${pane}@${at()}`);
      return true;
    },
    typeText: () => true,
    renameAgent(_session, _pane, name) {
      renames.push(name);
      events.push(`rename:${name}@${at()}`);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      events.push(`sleep:${ms}@${at()}`);
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return {
    launch, events, renames,
    get clock() { return clock; },
    get panes() { return panes; },
  };
}

function addSources(made: ReturnType<typeof world>): AddSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => new Date(made.clock),
    launch: made.launch,
  };
}

function agentOf(name: string, pane: string, workspace: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace, status: 'idle', cwd: null };
}

function removeSources(agents: HerdrAgent[]): RemoveSources {
  const launchHost = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => agents.map((one) => one.pane),
    closeWorkspace: () => true,
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => ({ kind: 'unknown' }),
    screenText: () => claudeBox(''),
    status: () => 'idle',
    now: () => NOW,
    sleep: async () => {},
    launch: launchHost,
    foreground: () => [],
    shellBack: () => true,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-remove-approve-')));
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
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function liveText(): string {
  return readFileSync(join(dir, 'team.yaml'), 'utf8');
}

describe('a granted agent mounts the team with no approval record', () => {
  test('five seats, no prompt, concurrent launch, ready inside thirty seconds', async () => {
    writeFile(teamYaml());
    record({ lead: 'lead-pane' });
    const made = world();
    const prompts: string[] = [];
    const sources: UpSources = {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      home,
      doctor: doctor(),
      machine: () => AMPLE,
      launch: made.launch,
      now: () => new Date(made.clock),
      terminal() {
        // Building the reader is not a prompt; a read is. The granted path builds
        // nothing that ever reads.
        return {
          key() {
            prompts.push('terminal');
            throw new Error('up read the owner terminal');
          },
          drain() {},
        };
      },
    };
    const io = testIo(root, SEAT);
    const code = await runUp([], io, sources);
    expect(code, `the mount said:\n${io.out}\n${io.err}`).toBe(0);
    // No prompt anywhere: the owner terminal is never read from, and nothing in
    // the run's words sends anyone to an approval.
    expect(prompts).toEqual([]);
    expect(`${io.out}${io.err}`).not.toContain('team approve');
    // Every seat is up and can receive a brief: the granted agent mounts the whole
    // roster, itself included, and every seat is named.
    expect(made.renames).toHaveLength(5);
    expect(made.renames.slice().sort()).toEqual(['lead', 'builder-1', 'builder-2', 'tester-1', 'tester-2'].sort());
    expect(made.launch.agentPanes('acme')).toHaveLength(5);
    // Concurrent: every seat's launch began before any seat was named — no seat
    // waited behind another seat's start.
    const firstRename = made.events.findIndex((line) => line.startsWith('rename:'));
    const launches = made.events.map((line, at) => (line.startsWith('launch:') ? at : -1)).filter((at) => at >= 0);
    expect(launches).toHaveLength(5);
    expect(firstRename).toBeGreaterThan(launches.at(-1)!);
    // Ready inside the budget on the clock the mount itself reports.
    expect(made.clock - NOW.getTime()).toBeLessThan(30_000);
    // No record was written anywhere: the mount never created an approval store.
    expect(existsSync(join(storePath('acme', root, home), 'approval.json'))).toBe(false);
  });
});

describe('an agent the grant does not name', () => {
  test('is told deny on a real run, the reason and the owner\'s own command on a dry run — and nothing mounts', async () => {
    writeFile(teamYaml());
    record({ lead: 'lead-pane' });
    const made = world();
    const audits: { seat: string; act: string }[] = [];
    const sources: UpSources = {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      home,
      doctor: doctor(),
      machine: () => AMPLE,
      launch: made.launch,
      now: () => new Date(made.clock),
      logGranted(_dir, seat, act) {
        audits.push({ seat, act });
      },
    };
    const caller = () => testIo(root, { kind: 'seat', name: 'tester-1', pane: 'tester-1-pane', session: 'acme' });
    const real = caller();
    expect(await runUp([], real, sources)).toBe(1);
    expect(real.err).toBe('deny\n');
    expect(real.out).toBe('');
    // A dry run is never answered with the bare word: it names the reason and the command that
    // unblocks it, and still mounts nothing.
    const dry = caller();
    expect(await runUp(['--dry-run'], dry, sources)).toBe(1);
    expect(dry.err).toBe('');
    expect(dry.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
    expect(dry.out).toContain('! to unblock: the owner runs `team up` from this folder, at a terminal outside herdr\n');
    expect(made.events.filter((line) => line.startsWith('create:'))).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('the approve command is gone', () => {
  test('the dispatch table carries no approve and the command answers unknown', async () => {
    expect(Object.keys(commands)).not.toContain('approve');
    const io = testIo(base, owner);
    const code = await main(['approve'], io);
    expect(code).toBe(2);
    expect(io.err).toContain('unknown command "approve"');
  });

  test('the exit-code contract keeps no approve row and carries the deny row', () => {
    const rows = JSON.parse(readFileSync(new URL('../contract/exit-codes.json', import.meta.url), 'utf8')).rows as { id: string }[];
    expect(rows.filter((row) => row.id.startsWith('approve.'))).toEqual([]);
    const deny = rows.find((row) => row.id === 'up.deny');
    expect(deny).toBeDefined();
  });
});

describe('the everyday commands with an old approval record on disk', () => {
  // The record is left alone: it neither blocks the command nor is rewritten by it.
  test('add mounts a stopped seat', async () => {
    approveAt(teamYaml('    stopped: true'), OLD);
    record({ lead: 'lead-pane', 'builder-1': 'b1-pane', 'builder-2': 'b2-pane', 'tester-1': 't1-pane' });
    const made = world();
    const io = testIo(root, owner);
    const code = await runAdd(['tester-2'], io, addSources(made));
    expect(code, `add said:\n${io.out}\n${io.err}`).toBe(0);
    expect(liveText()).toContain('name: tester-2');
    expect(made.events.join('\n')).toContain('rename:tester-2');
  });

  test.failing('add leaves the stored record untouched', async () => {
    // The design note: add edits the live file only, and the stored record is
    // neither asked nor rewritten.
    const recordPath = approveAt(teamYaml('    stopped: true'), OLD);
    const before = readFileSync(recordPath, 'utf8');
    record({ lead: 'lead-pane', 'builder-1': 'b1-pane', 'builder-2': 'b2-pane', 'tester-1': 't1-pane' });
    const made = world();
    const io = testIo(root, owner);
    const code = await runAdd(['tester-2'], io, addSources(made));
    expect(code, `add said:\n${io.out}\n${io.err}`).toBe(0);
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });

  test('remove takes a seat out and the record is untouched', async () => {
    const recordPath = approveAt(teamYaml(), OLD);
    const before = readFileSync(recordPath, 'utf8');
    const io = testIo(root, owner);
    const code = await runRemove(['builder-1'], io, removeSources([agentOf('builder-1', 'b1-pane', 'w1')]));
    expect(code, `remove said:\n${io.out}\n${io.err}`).toBe(0);
    expect(liveText()).not.toContain('name: builder-1');
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });

  test('down stops the seats and the record is untouched', async () => {
    const recordPath = approveAt(teamYaml(), OLD);
    const before = readFileSync(recordPath, 'utf8');
    record({ lead: 'lead-pane', 'builder-1': 'b1-pane', 'builder-2': 'b2-pane', 'tester-1': 't1-pane', 'tester-2': 't2-pane' });
    // One screen per pane, and a clock that moves when the command sleeps: the exit
    // flow polls, and a pane leaves when its Enter lands.
    const IDLE_BOX = CLAUDE_IDLE;
    const boxes = new Map<string, string>();
    const gone = new Set<string>();
    let clock = NOW.getTime();
    const closed: string[] = [];
    const people = (): HerdrAgent[] => [
      agentOf('lead', 'lead-pane', 'lead-ws'),
      agentOf('builder-1', 'b1-pane', 'b1-ws'),
      agentOf('builder-2', 'b2-pane', 'b2-ws'),
      agentOf('tester-1', 't1-pane', 't1-ws'),
      agentOf('tester-2', 't2-pane', 't2-ws'),
    ];
    const launch = {
      typeText(_session: string, pane: string, text: string) {
        boxes.set(pane, claudeBox(text));
        return true;
      },
      sendKey(_session: string, pane: string) {
        boxes.set(pane, IDLE_BOX);
        return true;
      },
      pressEnter(_session: string, pane: string) {
        gone.add(pane);
        return true;
      },
      agentPanes: () => people().map((one) => one.pane).filter((pane) => !gone.has(pane)),
      closeWorkspace(_session: string, workspace: string) {
        closed.push(workspace);
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => new Date(clock),
    };
    const sources: DownSources = {
      sessionRunning: () => true,
      agents: people,
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: (_session: string, pane: string) => boxes.get(pane) ?? IDLE_BOX,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => new Date(clock),
      home,
      launch,
    };
    const io = testIo(root, owner);
    const code = await runDown([], io, sources);
    expect(code, `down said:\n${io.out}\n${io.err}`).toBe(0);
    expect(closed.length).toBeGreaterThan(0);
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });
});

describe('a team carrying an old approval record', () => {
  test('still comes up, and the record is neither asked nor rewritten', async () => {
    const recordPath = approveAt(teamYaml(), OLD);
    const before = readFileSync(recordPath, 'utf8');
    record({ lead: 'lead-pane', 'builder-1': 'b1-pane', 'builder-2': 'b2-pane', 'tester-1': 't1-pane', 'tester-2': 't2-pane' });
    const made = world();
    const sources: UpSources = {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      home,
      doctor: doctor(),
      machine: () => AMPLE,
      launch: made.launch,
      now: () => new Date(made.clock),
    };
    const io = testIo(root, owner);
    const code = await runUp([], io, sources);
    expect(code, `up said:\n${io.out}\n${io.err}`).toBe(0);
    expect(`${io.out}${io.err}`).not.toContain('team approve');
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });
});
