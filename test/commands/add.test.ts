import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { delegateGate } from '../../src/delegate.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { readAgents } from '../../src/registry/agents.ts';
import { readLedger, storePath, writeApproval } from '../../src/store/store.ts';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { rulesFilePath } from '../../src/launch/rules-file.ts';
import { seatLockPath } from '../../src/launch/seat-lock.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { profileFor, resolveEffortOverride, resolveModelOverride, withLaunchOverrides } from '../../src/profiles/profile.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = CLAUDE_IDLE;
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';

let base: string;
let project: string;
let home: string;

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
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
  - role: implementer
    name: scribe
    label: scribe
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
    stopped: true
`;

// A file whose worker works in worktrees: it would start in the lobby, never the project root.
const WORKTREE_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
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
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: zsh ../tools/x.sh
    stopped: true
`;

function file(path: string, text = 'x\n'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function approve(text: string = FILE): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = text.includes('trust:')
    ? text
    : text.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\n`);
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
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

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'branch', 'fix/fresh');
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const owner = { kind: 'owner' } as const;

describe('team add', () => {
  test('starts a stopped seat and drops only its stopped line', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(0);
    expect(made.creates).toEqual(['worker']);
    expect(made.renames).toEqual(['worker']);
    const text = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    expect(text).not.toMatch(/# the seat stays in this order\n    stopped: true/);
    expect(text).toContain('# the seat stays in this order');
    expect(text.indexOf('name: worker')).toBeLessThan(text.indexOf('# the seat stays in this order'));
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker?.stage).toBe('ready');
    const loaded = loadTeamFile(project, { home });
    expect(loaded.ok && approvalDifferences(loaded.team, project, home)).toEqual([]);
  });

  test('a file where builder-1 and builder-01 are one number is refused at load, before anything starts', async () => {
    const clashing = FILE.replace('name: worker', 'name: builder-1').replace('name: scribe', 'name: builder-01');
    writeFileSync(join(project, '.agents', 'team.yaml'), clashing);
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['builder-1'], io, sources(made))).toBe(2);
    expect(io.err).toContain('two seats have the same role and number: "builder-1" on line');
    expect(io.err).toContain('and "builder-01" here');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(clashing);
  });

  test('the next temporary number is two digits by default and numeric past 9', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:notes/out.md'], io, sources(made))).toBe(0);
    expect(made.creates).toEqual(['worker-tmp-01']);
    // The same team again: the taken number is 1, so the next mint is 2.
    const again = world();
    const ioAgain = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:notes/out.md'], ioAgain, sources(again))).toBe(0);
    expect(again.creates).toEqual(['worker-tmp-02']);
  });

  test('a dev-mode add records the mark and the caller it admitted', async () => {
    const made = world();
    const io = testIo(project, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runAdd(['worker'], io, sources(made))).toBe(0);
    expect(io.err).toContain('team add: warning: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is helper; dev mode continues\n');
    // The launch's write says the run was folded and who it admitted: the record a later
    // `team check` reads names the helper, and the owner's own write is what takes it off.
    const record = readAgents(home).find((agent) => agent.reach.seat === 'worker');
    expect(record?.provenance.dev_mode).toBe(true);
    expect(record?.provenance.dev_mode_by).toBe('helper');
    expect(record?.provenance.registered_by).toBe('helper');
  });

  test('a dry run previews a launch-line refusal, creates nothing, and edits nothing', async () => {
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: team-deepseek --key x\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker', '--dry-run'], io, sources(made, {
      doctor: { ...doctor(), onPath: (binary) => binary !== 'team-deepseek' },
    }));
    // The refusal is previewed as the plan's own line, and the run exits as the real add would:
    // nothing was made and the file was not touched — the seat would be started, and its line can't run.
    expect(code).toBe(1);
    expect(io.out).toContain(
      '  skip worker: would refuse: its launch line starts `team-deepseek`, which is not on the PATH\n',
    );
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a real add refuses that seat with the file left as it was', async () => {
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: team-deepseek --key x\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      doctor: { ...doctor(), onPath: (binary) => binary !== 'team-deepseek' },
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('team add: worker: its launch line starts `team-deepseek`, which is not on the PATH\n');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a file error carries the file\'s own string cleaned: no escape byte reaches the terminal', async () => {
    // The coordinator names no declared seat, refused while the file is loaded. The name the file
    // holds carries ESC — a YAML escape inside the double-quoted scalar — and the sentence the
    // terminal shows is the name cleaned.
    writeFileSync(
      join(project, '.agents/team.yaml'),
      FILE.replace('coordinator: lead\n', 'coordinator: "x\\u001b[31my"\n'),
    );
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(world()));
    expect(code).toBe(2);
    expect(io.err).toBe('team add: line 3: coordinator "xy" names no declared seat\n');
    expect(io.err).not.toContain('\x1b');
    expect(io.out).toBe('');
  });

  test('a refusal names the file\'s own launch word cleaned: no escape byte reaches the terminal', async () => {
    // The launch line starts a word the check cannot find, and the word holds ESC: the refusal
    // the terminal shows names the cleaned word, and no escape byte reaches stdout or stderr.
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: "./aa\\ebb"\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(1);
    expect(io.err).toBe('team add: worker: its launch line starts `./aab`, not found from its start folder .\n');
    expect(io.err).not.toContain('\x1b');
    expect(io.out).not.toContain('\x1b');
    expect(made.creates).toEqual([]);
  });

  test('a dry run plan carries the file\'s own launch word cleaned: no escape byte in the plan', async () => {
    // The launch line's last word holds ESC and is only an argument, so the plan prints the seat's
    // `pane run` command with the word cleaned.
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: "claude --model claude-opus-5-5 ./aa\\ebb"\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker', '--dry-run'], io, sources(made));
    expect(code).toBe(0);
    expect(io.out).toContain('./aab');
    expect(io.out).not.toContain('\x1b');
    expect(made.creates).toEqual([]);
  });

  test('a line for an existing unnamed pane is checked where that pane runs', async () => {
    // The adopted pane: the state records the seat at pane `w9:p1` with `start_cwd` at the
    // project root — where `../tools/x.sh` is a file — and the fresh seat would start in the
    // lobby, where it is not. The seat is adopted into the pane, not launched, so the recorded
    // folder is where its line is read: the line resolves, nothing is refused, nothing is made.
    approve(WORKTREE_FILE);
    file(join(base, 'tools', 'x.sh'));
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', start_cwd: '.' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).not.toContain('would refuse');
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['worker']);
  });

  test('a line for an existing pane whose state records no start folder is noted, not checked', async () => {
    approve(WORKTREE_FILE);
    file(join(base, 'tools', 'x.sh'));
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).toContain(
      '  note worker: its launch line was not checked: the seat is resumed and its state records no start folder\n',
    );
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['worker']);
  });

  test('a miss at the recorded folder does not refuse a seat that is adopted, not launched', async () => {
    // The pane runs in the lobby, where the line does not resolve: a miss there keeps `up`'s
    // rule — a seat that is not launched is not refused for its line — and the seat is renamed.
    approve(WORKTREE_FILE);
    file(join(base, 'tools', 'x.sh'));
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', start_cwd: '../worktrees/acme/.lobby' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).not.toContain('would refuse');
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['worker']);
  });

  test('a line the check cannot read is noted once, and the seat still starts', async () => {
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: claude --model claude-opus-5-5 --append-system-prompt "be terse"\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(0);
    expect(io.err.split('  note worker: its launch line was not checked').length).toBe(2);
    expect(io.out).not.toContain('note worker');
    expect(made.creates).toEqual(['worker']);
    // the added seat is unstopped; the fixture's other stopped seat keeps its flag
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).not.toMatch(/# the seat stays in this order\n    stopped: true/);
  });

  test('add after a clean remove --keep leaves no drift', async () => {
    approve(FILE.replace('\n    stopped: true', ''));
    const removeSources: RemoveSources = {
      sessionRunning: () => true,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      sleep: async () => {},
      launch: {
        typeText: () => true,
        sendKey: () => true,
        pressEnter: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => NOW,
      },
      foreground: () => [],
      home,
    };
    expect(await runRemove(['worker', '--keep'], testIo(project, owner), removeSources)).toBe(0);
    const kept = loadTeamFile(project, { home });
    expect(kept.ok && approvalDifferences(kept.team, project, home)).toEqual([]);
    expect(await runAdd(['worker'], testIo(project, owner), sources(world()))).toBe(0);
    const after = loadTeamFile(project, { home });
    expect(after.ok && approvalDifferences(after.team, project, home)).toEqual([]);
    expect(after.ok && after.team.seats.find((seat) => seat.name === 'worker')?.stopped).toBe(false);
  });

  // The reach seam's command paths: `add` and `remove` write the team file, then regenerate the
  // projection the bridge and the seat-shuttle daemon read (`src/reach/projection.ts`). The
  // writer itself is covered in test/seat-reach.test.ts; these two hold the call sites.
  const REACHED = FILE.replace(
    '    # the seat stays in this order',
    '    reach:\n      to: [grokbot]\n    # the seat stays in this order',
  );

  function reachLobby(): string {
    const lobby = join(home, '.config', 'team', 'lobby');
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    return lobby;
  }

  function projected(lobby: string): string[] {
    const file = JSON.parse(readFileSync(join(lobby, 'reach-roster.json'), 'utf8')) as { seats: { alias: string }[] };
    return file.seats.map((seat) => seat.alias);
  }

  test('an added grant lands in the reach projection, keyed by the seat name', async () => {
    const lobby = reachLobby();
    approve(REACHED);
    expect(await runAdd(['worker'], testIo(project, owner), sources(world()))).toBe(0);
    expect(JSON.parse(readFileSync(join(lobby, 'reach-roster.json'), 'utf8'))).toEqual({
      version: 1,
      seats: [{ alias: 'worker', route: 'worker', key_id: 'seat-worker-1', guard_dir: join(lobby, 'guard-floor-worker'), reach: ['grokbot'] }],
    });
  });

  test('the projection follows the file across --keep and a full removal', async () => {
    const lobby = reachLobby();
    approve(REACHED.replace('\n    stopped: true', ''));
    const removeSources: RemoveSources = {
      sessionRunning: () => true,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      sleep: async () => {},
      launch: {
        typeText: () => true,
        sendKey: () => true,
        pressEnter: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => NOW,
      },
      foreground: () => [],
      home,
    };
    // `--keep` stops the seat but keeps its line: the grant is the file's, so it stays projected.
    expect(await runRemove(['worker', '--keep'], testIo(project, owner), removeSources)).toBe(0);
    expect(projected(lobby)).toEqual(['worker']);
    // The removed seat leaves the file, and the projection with it: omission is the revocation.
    expect(await runRemove(['worker'], testIo(project, owner), removeSources)).toBe(0);
    expect(projected(lobby)).toEqual([]);
  });

  test('refuses a seat the approved file does not hold, and a caller who may not change the team', async () => {
    const missing = testIo(project, owner);
    expect(await runAdd(['nobody'], missing, sources(world()))).toBe(1);
    expect(missing.err).toContain('no seat');
    const seat = testIo(project, { kind: 'seat', name: 'stranger', pane: 'w1:p1' });
    expect(await runAdd(['worker'], seat, sources(world()))).toBe(1);
    expect(seat.err).toContain('only the owner or a standing grant (delegate)');
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a refused caller is refused before any record: the plain sentence, no seat record, no log line', async () => {
    // The gate sits before the writer is built: a refused caller prints the refusal exactly as
    // main prints it — the sentence, nothing wrapped around it — and nothing that reads as a
    // progress record is written anywhere: stdout is empty, and the log file's bytes are what
    // they were before the run.
    const io = testIo(project, { kind: 'seat', name: 'stranger', pane: 'w1:p1' });
    const log = join(project, '.agents', 'team.log');
    const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : null);
    const before = logged();
    expect(await runAdd(['worker'], io, sources(world()))).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is stranger\n');
    expect(logged()).toBe(before);
  });

  test('a temporary seat is recorded, not written into the file, keeps its own-commits flag, and the log holds its record alone', async () => {
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], io, sources(made));
    expect(code).toBe(0);
    // A redirected stdout holds the seat's one record, and records alone.
    expect(io.out).toBe('worker-tmp-01: ready\n');
    expect(made.renames).toEqual(['worker-tmp-01']);
    const text = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    const loaded = loadTeamFile(project, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('\n'));
    expect(loaded.team.seats.map((seat) => seat.name)).not.toContain('worker-tmp-01');
    expect(text).toContain('stopped: true');
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-01'];
    expect(seat?.temporary).toEqual({ like: 'worker', until: 'merged:fix/fresh', own_commits: false });
    expect(readLedger(storePath('acme', project, home)).some((entry) => entry.display === 'Claude Opus 5.5')).toBe(true);
    // One line per final record: the log holds the seat's record alone, never the separate
    // `started <seat>` line `add` used to write beside it. The temporary facts stay in the
    // state file and the seat's doctor/status reading.
    const log = readFileSync(join(project, '.agents', 'team.log'), 'utf8');
    const mine = log.split('\n').filter((line) => line.includes('worker-tmp-01'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('worker-tmp-01: ready');
    expect(log).not.toContain('started worker-tmp-01');
    expect(log).not.toContain('until merged:fix/fresh');
  });

  test('a temporary message seat at a dialog waits for its owner', async () => {
    const made = world();
    // The pane comes up at a trust question. §6: `add` never prompts and never closes — the
    // workspace is kept, the seat is recorded as waiting for its owner, nothing is sent into
    // the pane, and the owner finishes it with `team up`.
    const trust = readFileSync(new URL('../fixtures/codex/0.157.0/trust.txt', import.meta.url), 'utf8');
    const plain = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      const text = plain(session, pane);
      return text === IDLE ? trust : text;
    };
    const closes: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
    // The rules file is written only when the rules are delivered, and this seat never reached
    // its prompt: nothing was typed, so no file exists. It is the `team up` finish that types.
    const file = rulesFilePath('acme', project, home, 'scribe-tmp-01') as string;
    const io = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'scribe', '--until', 'merged:fix/fresh'], io, sources(made))).toBe(1);
    expect(io.out).toContain('scribe-tmp-01: left out: trust\n');
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(closes).toEqual([]);
    expect(existsSync(file)).toBe(false);
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['scribe-tmp-01'];
    expect(seat?.waiting).toMatchObject({ state: 'waiting-owner', classification: 'trust' });
    expect(seat?.temporary).toMatchObject({ like: 'scribe', until: 'merged:fix/fresh' });
  });

  test('refuses a result that already exists and a merged branch that does not', async () => {
    writeFileSync(join(project, 'done.md'), 'done\n');
    const exists = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:done.md'], exists, sources(world()))).toBe(1);
    expect(exists.err).toContain('already exists');
    const gone = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:fix/missing'], gone, sources(world()))).toBe(1);
    expect(gone.err).toContain("doesn't exist");
  });

  test('refuses a result path that is absolute or contains ..', async () => {
    const absolute = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:/tmp/out.md'], absolute, sources(world()))).toBe(1);
    expect(absolute.err).toContain('relative to the project');
    expect(readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-01']).toBeUndefined();

    // `../outside.md` is outside this project (home/acme). `notes/../../outside.md` contains
    // `..` and lands in the same place. Neither may be stored, and no seat is recorded.
    const escaped = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:../outside.md'], escaped, sources(world()))).toBe(1);
    expect(escaped.err).toContain('relative to the project');
    expect(existsSync(join(home, 'outside.md'))).toBe(false);
    const nested = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:notes/../../outside.md'], nested, sources(world()))).toBe(1);
    expect(nested.err).toContain('relative to the project');
    expect(readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-01']).toBeUndefined();
  });

  test('refuses a merged branch that starts with a dash', async () => {
    const io = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:-not-a-branch'], io, sources(world()))).toBe(1);
    expect(io.err).toContain('is not a branch name');
    expect(readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-01']).toBeUndefined();
  });

  test('each start limit refuses with its figure before the file is edited', async () => {
    const cases: { machine: Machine; text: string }[] = [
      { machine: { ...fine, loadPerCore: 9 }, text: 'the load is 9.0 per core, above 3' },
      { machine: { ...fine, memoryFree: 10 }, text: 'free memory is 10%, below 25%' },
      { machine: { ...fine, swapFree: 1.1e9 }, text: 'free swap is 1.1 GB, below 2.0 GB' },
    ];
    for (const item of cases) {
      const made = world();
      const io = testIo(project, owner);
      expect(await runAdd(['worker'], io, sources(made, { machine: () => item.machine }))).toBe(1);
      expect(io.err).toContain(item.text);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
    }
  });

  test('a machine refusal writes one line with the printed refusal and its readings', async () => {
    const made = world();
    const io = testIo(project, owner);
    const machine: Machine = { loadPerCore: 1, memoryFree: 69, diskFree: 200e9, swapTotal: 8.2e9, swapFree: 1.2e9, swapUsed: 7e9 };
    expect(await runAdd(['worker'], io, sources(made, { machine: () => machine }))).toBe(1);
    expect(io.err).toContain('team add: free swap is 1.2 GB, below 2.0 GB');
    const lines = readFileSync(join(project, '.agents', 'team.log'), 'utf8').split('\n')
      .filter((line) => line.includes('refused: free swap is '));
    expect(lines).toEqual([
      '2026-10-03T14:02:00.000Z add [owner] refused: free swap is 1.2 GB, below 2.0 GB — readings: load 1.0/core, memory 69%, disk 200000000000 B free, swap used 7000000000 B of 8200000000 B (free 1200000000 B)',
    ]);
  });

  test('a dry run and a caller refused before the gate write no line', async () => {
    const refusing = { ...fine, swapFree: 1.2e9 };
    const log = join(project, '.agents', 'team.log');
    const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : null);
    // A dry run decides nothing and writes nothing, though its refusal reads as the real one's.
    const dry = testIo(project, owner);
    expect(await runAdd(['--dry-run', 'worker'], dry, sources(world(), { machine: () => refusing }))).toBe(1);
    expect(dry.err).toContain('team add: free swap is 1.2 GB, below 2.0 GB');
    expect(logged()).toBeNull();
    // A caller the caller gate refuses returns before the machine gate is even read.
    const seat = testIo(project, { kind: 'seat', name: 'stranger', pane: 'w1:p1' });
    expect(await runAdd(['worker'], seat, sources(world(), { machine: () => refusing }))).toBe(1);
    expect(seat.err).toContain('only the owner or a standing grant (delegate)');
    expect(logged()).toBeNull();
  });

  test('swap that grows before the launch is refused, the file stays, and the line says so', async () => {
    let reads = 0;
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      machine: () => {
        reads += 1;
        return { ...fine, swapUsed: reads >= 2 ? 3e9 : 1e9 };
      },
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('swap grew by 2.0 GB in 10 minutes, above 1.0 GB');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
    // The second reading is the one refused on, and it is the one written.
    const lines = readFileSync(join(project, '.agents', 'team.log'), 'utf8').split('\n')
      .filter((line) => line.includes('refused: swap grew by '));
    expect(lines).toEqual([
      '2026-10-03T14:02:00.000Z add [owner] refused: swap grew by 2.0 GB in 10 minutes, above 1.0 GB — readings: load 1.0/core, memory 50%, disk 200000000000 B free, swap used 3000000000 B of 9000000000 B (free 8000000000 B)',
    ]);
  });

  test('readings inside every limit still start the seat', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made, { machine: () => fine }))).toBe(0);
    expect(made.creates).toEqual(['worker']);
  });

  test('names an unnamed agent already in the seat\'s workspace instead of launching another', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['lead']);
  });

  test('does not adopt an unnamed agent when another seat claims the workspace or the pane differs', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'ws-shared', pane: 'pane-lead' };
      session.seats.worker = { stage: 'ready', workspace: 'ws-shared', pane: 'pane-worker' };
      state.sessions.acme = session;
    });
    const made = world();
    const stray: HerdrAgent = { name: null, agent: 'claude', pane: 'pane-other', workspace: 'ws-shared', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [stray],
      workspaces: () => [{ id: 'ws-shared' }],
    }));
    expect(code).toBe(0);
    expect(made.creates).toEqual(['lead']);
  });

  test('counts live undeclared agents against seat, temporary and vendor ceilings when removed from state', async () => {
    const yaml = `${readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')}limits:\n  seats: 2\n  temporary: 1\n  vendors:\n    anthropic: 1\n    openai: 1\n`;
    approve(yaml);
    const liveTemp: HerdrAgent = {
      name: 'worker-tmp-01',
      agent: 'claude',
      pane: 'pane-temp',
      workspace: 'ws-temp',
      status: 'idle',
      cwd: null,
    };
    const made = world();
    const ioTemp = testIo(project, owner);
    const tempCode = await runAdd(
      ['--temporary', '--like', 'scribe', '--until', 'merged:fix/fresh'],
      ioTemp,
      sources(made, {
        sessionState: () => 'running',
        agents: () => [liveTemp],
        workspaces: () => [{ id: 'ws-temp' }],
      }),
    );
    expect(tempCode).toBe(1);
    expect(ioTemp.err).toContain('the file allows 1 temporary seats; 2 would be running');

    const ioVendor = testIo(project, owner);
    const vendorCode = await runAdd(
      ['worker'],
      ioVendor,
      sources(made, {
        sessionState: () => 'running',
        agents: () => [liveTemp],
        workspaces: () => [{ id: 'ws-temp' }],
      }),
    );
    expect(vendorCode).toBe(1);
    expect(ioVendor.err).toContain('the file allows 1 anthropic seats; 2 would be running');
  });

  test('a new seat found at a dialog waits for its owner: nothing is closed, and it exits 1', async () => {
    const made = world();
    const closed: string[] = [];
    made.launch.paneText = (_session, pane) => (pane === 'w1:p1' ? PERMISSION : IDLE);
    made.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(1);
    // §6: the workspace is kept for its owner — `team up` finishes the seat — and the record,
    // its stderr detail and the log all name the reading without claiming any close.
    const line = 'worker: left out: permission';
    expect(io.out).toContain(`${line}\n`);
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toContain(line);
    expect(closed).toEqual([]);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker)
      .toMatchObject({ waiting: { state: 'waiting-owner', classification: 'permission' } });
  });

  test('a new seat found at a question waits for its owner: kept, recorded, nothing typed', async () => {
    const made = world();
    // §6 covers each dialog the same way, and a question is one of them. The identity of the
    // pane's process is read then and goes in the same write, for the owner's later `team up`.
    const question = readFileSync(new URL('../fixtures/claude-code/2.1.289/question-plain.txt', import.meta.url), 'utf8');
    const plain = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      const text = plain(session, pane);
      return text === IDLE ? question : text;
    };
    const closed: string[] = [];
    const sent: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
    made.launch.typeText = (_session, pane, text) => { sent.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { sent.push(`enter ${pane}`); return true; };
    made.launch.processInfo = () => ({ shell: 100, foreground: [101] });
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(1);
    expect(io.out).toContain('worker: left out: question\n');
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(closed).toEqual([]);
    expect(sent).toEqual([]);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toMatchObject({
      waiting: { state: 'waiting-owner', classification: 'question' },
      launched: { shell: 100, cli: [101] },
    });
  });

  test('a temporary seat found at a vendor notice waits for its owner, and nothing is typed', async () => {
    const made = world();
    // The Codex update screen is the vendor's own notice: still a dialog, still the owner's,
    // and never typed into.
    const notice = readFileSync(new URL('../fixtures/codex/0.157.0/startup.txt', import.meta.url), 'utf8');
    const plain = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      const text = plain(session, pane);
      return text === IDLE ? notice : text;
    };
    const closed: string[] = [];
    const sent: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
    made.launch.typeText = (_session, pane, text) => { sent.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { sent.push(`enter ${pane}`); return true; };
    made.launch.processInfo = () => ({ shell: 200, foreground: [201] });
    const io = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'scribe', '--until', 'merged:fix/fresh'], io, sources(made))).toBe(1);
    expect(io.out).toContain('scribe-tmp-01: left out: vendor notice\n');
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(closed).toEqual([]);
    expect(sent).toEqual([]);
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['scribe-tmp-01'];
    expect(seat?.waiting).toMatchObject({ state: 'waiting-owner', classification: 'vendor notice' });
    expect(seat?.launched).toEqual({ shell: 200, cli: [201] });
  });

  test('a replaced seat with no stored session is left, not closed and not launched', async () => {
    // The recorded pane holds a CLI, and the record has no agent session to tie it to the launch.
    // `add` does not close it and does not start another.
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', launched: { shell: 400, cli: [401] } };
      state.sessions.acme = session;
    });
    const made = world();
    const closes: string[] = [];
    const keys: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
    made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
    made.launch.typeText = (_session, pane, text) => { keys.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { keys.push(`enter ${pane}`); return true; };
    const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    // The repair re-reads herdr immediately before the close: the list still names the seat on
    // its pane, and its screen reads idle, so the replaced seat's workspace may be closed.
    made.launch.agents = () => [listed];
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w9:p1' ? IDLE : text(session, pane));
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [listed],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
    expect(keys).toEqual([]);
    expect(closes).toEqual([]);
    expect(made.creates).toEqual([]);
    const seats = readState(join(project, '.agents')).sessions.acme?.seats ?? {};
    expect(seats.worker).toMatchObject({ stage: 'launched', pane: 'w9:p1', launched: { shell: 400, cli: [401] } });
  });

  test('a matching agent session is rebased and not closed', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'ready', workspace: 'w9', pane: 'w9:p1', launched: { shell: 400, cli: [401] }, agent_session: 'kept' };
      state.sessions.acme = session;
    });
    const made = world();
    const closes: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
    made.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null, session: 'kept' };
    made.launch.agents = () => [listed];
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [listed],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('already running');
    expect(closes).toEqual([]);
    expect(made.creates).toEqual([]);
    const seats = readState(join(project, '.agents')).sessions.acme?.seats ?? {};
    expect(seats.worker).toMatchObject({ pane: 'w9:p1', launched: { shell: 900, cli: [901] }, agent_session: 'kept' });
  });

  test('a shell in front is still closed without input and launched fresh', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', launched: { shell: 400, cli: [401] }, agent_session: 'kept' };
      state.sessions.acme = session;
    });
    const made = world();
    const closes: string[] = [];
    const keys: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
    made.launch.processInfo = (_session, pane) => pane === 'w9:p1'
      ? { shell: 400, foreground: [400] }
      : { shell: 700, foreground: [700, 701] };
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null, session: 'kept' };
    made.launch.agents = () => [listed];
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w9:p1' ? IDLE : text(session, pane));
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [listed],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(keys).toEqual([]);
    expect(closes).toEqual(['w9']);
    expect(io.err).toContain('  its pane held no CLI; closed without input and launched again\n');
  });

  describe('a replaced seat with no stored session is left before any close', () => {
    function setupReadySeat() {
      approve(WORKTREE_FILE);
      updateState(join(project, '.agents'), (state) => {
        const session = state.sessions.acme ?? emptySession();
        session.seats.worker = { stage: 'ready', workspace: 'w9', pane: 'w9:p1', launched: { shell: 400, cli: [401] } };
        state.sessions.acme = session;
      });
      const before = readFileSync(join(project, '.agents/team.state.json'), 'utf8');
      const made = world();
      const closes: string[] = [];
      made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
      const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
      made.launch.agents = () => [listed];
      made.launch.paneText = () => IDLE;
      return { made, closes, listed, before };
    }

    test('agent list binding failed', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.agents = () => [];
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('workspace holds other panes', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.workspacePanes = () => ['w9:p1', 'w9:p2'];
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('workspace read failed', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.workspacePanes = () => null;
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('process read failed', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      let reads = 0;
      made.launch.processInfo = () => {
        reads += 1;
        return reads === 1 ? { shell: 400, foreground: [500] } : null;
      };
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('process working', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.paneText = () => 'esc to interrupt';
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('process unsent', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      const unsentText = readFileSync(join(import.meta.dir, '../fixtures/claude-code/2.1.289/unsent-typed-ansi.txt'), 'utf8');
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.paneText = () => unsentText;
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker: its pane holds a process this record cannot tie to the launch\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('already running: answers as it does today for a seat that is already running', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toBe('team add: worker is already running\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    const UNKNOWN = 'nothing this profile reads\n';

    test('an unrecognised screen names abandon to the owner', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
      made.launch.paneText = () => UNKNOWN;
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toBe('team add: worker is already running (team remove worker --abandon closes its workspace without typing)\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('an unrecognised screen tells the approved delegate that the owner runs abandon', async () => {
      // The map's row stops every seat before the already-running line, so the one caller who
      // still reads its non-owner wording in 0.5.0 is the approved delegate: the verdict below
      // passes, and the run reaches the running seat — the refusal that names the owner's repair.
      const { made, closes, listed } = setupReadySeat();
      approve(DELEGATE_FILE);
      const before = readFileSync(join(project, '.agents/team.state.json'), 'utf8');
      made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
      made.launch.paneText = () => UNKNOWN;
      const io = testIo(project, pilot);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
        delegateGate: () => passed,
      }));
      expect(code).toBe(1);
      expect(io.err).toBe('team add: worker is already running (the owner runs team remove worker --abandon, which closes its workspace without typing)\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('an unrecognised screen still names abandon when the pane is the seat\'s again', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      let reads = 0;
      made.launch.processInfo = () => {
        reads += 1;
        return reads === 1 ? { shell: 400, foreground: [400] } : { shell: 400, foreground: [400, 401] };
      };
      made.launch.paneText = () => UNKNOWN;
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker is already running (team remove worker --abandon closes its workspace without typing)\n');
      expect(io.out).not.toContain("worker: its pane is the seat's again; left as it is\n");
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('restarts to same between plan and close', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      let reads = 0;
      made.launch.processInfo = () => {
        reads += 1;
        return reads === 1 ? { shell: 400, foreground: [400] } : { shell: 400, foreground: [400, 401] };
      };
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker is already running\n');
      expect(io.out).not.toContain("worker: its pane is the seat's again; left as it is\n");
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });
  });
});

// The delegated runs: the file names a delegate — a pane outside the team's session — and the
// caller is a named agent standing on that pane, a seat of another session the ordinary rule
// refuses. The gate itself is faked here (the contract's verdicts, handed in through
// `sources.delegateGate`); its own tests cover what the real one reads to decide.
const DELEGATES = `delegates:
  - pane: main/w1:p1
    commands: [add, remove]
`;
const DELEGATE_FILE = FILE + DELEGATES;
const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w1:p1', session: 'main' };
const passed = { kind: 'passed' as const, pane: 'main/w1:p1' };
const EDIT_REFUSAL = 'team add: the approved delegate adds only a same-copy seat: the live file\'s own stanza, hash for hash; a missing, stopped or changed seat is the owner\'s\n';
// A gate that fails the test the moment it is asked where the run must not ask it: the ordinary
// rule's own callers never reach the delegate branch, and neither does a file with no delegates.
const THROWING_GATE: NonNullable<AddSources['delegateGate']> = () => {
  throw new Error('the gate is asked only after the ordinary rule refused, and only when the file names a delegate');
};

describe('team add delegated', () => {
  test('no delegates in the file: the map\'s refusal, and the gate is never asked', async () => {
    const made = world();
    const io = testIo(project, pilot);
    let asked = 0;
    const code = await runAdd(['worker'], io, sources(made, {
      delegateGate: () => { asked += 1; return passed; },
    }));
    expect(code).toBe(1);
    expect(io.err).toBe('team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is pilot\n');
    expect(asked).toBe(0);
  });

  test('a refused verdict takes the ordinary refusal\'s place, on a real run and on a dry run', async () => {
    approve(DELEGATE_FILE);
    for (const argv of [['worker'], ['worker', '--dry-run']] as const) {
      const made = world();
      const io = testIo(project, pilot);
      const code = await runAdd([...argv], io, sources(made, {
        delegateGate: () => ({
          kind: 'refused' as const,
          id: 'add.delegate-command',
          text: 'the approved delegate main/w1:p1 may not run `add`; its approved commands are remove',
        }),
      }));
      // `add --dry-run` stays behind the caller gate: no plan, no would-refuse line, exit 1.
      expect(code).toBe(1);
      expect(io.err).toBe('team add: the approved delegate main/w1:p1 may not run `add`; its approved commands are remove\n');
      expect(io.out).toBe('');
      expect(made.creates).toEqual([]);
    }
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('the gate is asked once, with the live file, the project and the flags the caller passed', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const io = testIo(project, pilot);
    const asked: Parameters<NonNullable<AddSources['delegateGate']>>[0][] = [];
    const code = await runAdd(['--temporary', '--like', 'lead', '--until', 'result:notes/r.md'], io, sources(made, {
      delegateGate: (input) => {
        asked.push(input);
        return { kind: 'refused' as const, id: 'add.delegate-flag', text: '--temporary is the owner\'s; the approved delegate cannot use it' };
      },
    }));
    expect(code).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.command).toBe('add');
    expect(asked[0]!.team.delegates).toEqual([{ pane: 'main/w1:p1', commands: ['add', 'remove'] }]);
    expect(asked[0]!.root).toBe(project);
    expect(asked[0]!.dir).toBe(join(project, '.agents'));
    expect(asked[0]!.flags).toEqual(['temporary', 'like', 'until']);
    expect(asked[0]!.io).toBe(io);
  });

  test('a delegated add that would clear stopped is refused before any write or signing', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const record = readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8');
    const io = testIo(project, pilot);
    const code = await runAdd(['worker'], io, sources(made, { delegateGate: () => passed }));
    expect(code).toBe(1);
    expect(io.err).toBe(EDIT_REFUSAL);
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).toContain('stopped: true');
    expect(readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8')).toBe(record);
    expect(made.creates).toEqual([]);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('a delegated add cannot restore a seat absent from the live file', async () => {
    // `limits.seats` is fixed in the file, so a seat taken out of the live file is not drift —
    // a seat taken out needs no new approval — and putting it back is still the owner's: the
    // entry returns only with the approval.
    const LIMITS = 'limits:\n  seats: 5\n  temporary: 2\n';
    approve(FILE.replace('seats:\n', `${LIMITS}seats:\n`) + DELEGATES);
    const path = join(project, '.agents', 'team.yaml');
    const live = readFileSync(path, 'utf8');
    const from = live.indexOf('  - role: implementer\n    name: worker');
    const to = live.indexOf('  - role: implementer\n    name: scribe');
    writeFileSync(path, live.slice(0, from) + live.slice(to));
    const made = world();
    const record = readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8');
    const io = testIo(project, pilot);
    const code = await runAdd(['worker'], io, sources(made, { delegateGate: () => passed }));
    expect(code).toBe(1);
    expect(io.err).toBe('team add: the file has no seat "worker"\n');
    expect(readFileSync(path, 'utf8')).not.toContain('name: worker');
    expect(readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8')).toBe(record);
    expect(made.creates).toEqual([]);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('a delegated add of a declared, not-stopped seat starts it, writes no file, signs nothing', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const record = readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8');
    const before = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    const io = testIo(project, pilot);
    const code = await runAdd(['lead'], io, sources(made, { delegateGate: () => passed }));
    expect(code).toBe(0);
    expect(made.creates).toEqual(['lead']);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(before);
    expect(readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8')).toBe(record);
    // The audit line is the log's first line: the run is attributed before its effects.
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8').startsWith(
      `${NOW.toISOString()} delegate [delegate] main/w1:p1 add\n`,
    )).toBe(true);
  });

  test('a delegated dry run plans and never logs the delegate line', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const io = testIo(project, pilot);
    const code = await runAdd(['lead', '--dry-run'], io, sources(made, { delegateGate: () => passed }));
    expect(code).toBe(0);
    expect(io.out).toContain('lead');
    expect(made.creates).toEqual([]);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('the coordinator\'s restoring add is the owner\'s too: even a passed delegate verdict refuses it', async () => {
    // The map's `add` row is the owner's alone in 0.5.0: a seat of this team never reaches a
    // restoring add any more, whatever the file's `delegates` section says. The gate below is
    // the widest reading of a delegated run — a verdict that passed — and the add still refuses
    // it, because the one seat a delegate may start is the live file's own stanza and
    // `worker` is stopped: starting it would edit the file. Nothing is written, signed or
    // started, and the run is not attributed to the delegate.
    approve(DELEGATE_FILE);
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'ready', pane: 'w0:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    const store = storePath('acme', project, home);
    const before = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(project, { kind: 'seat', name: 'lead', pane: 'w0:p1', session: 'acme' });
    const code = await runAdd(['worker'], io, sources(made, { delegateGate: () => passed }));
    expect(code).toBe(1);
    expect(io.err).toBe(EDIT_REFUSAL);
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(before);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('the owner\'s ordinary restoring add runs as today too: the gate is not for it', async () => {
    // The finding's own words: the ordinary owner, coordinator or operator rule runs first. The
    // owner's restoring `add` is the widest of those paths, and it too must run with a `delegates`
    // section in the file as though the section were not there.
    approve(DELEGATE_FILE);
    const made = world();
    const store = storePath('acme', project, home);
    const before = readFileSync(join(store, 'approval.json'), 'utf8');
    const code = await runAdd(['worker'], testIo(project, owner), sources(made, { delegateGate: THROWING_GATE }));
    expect(code).toBe(0);
    expect(made.creates).toEqual(['worker']);
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).not.toBe(before);
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).not.toContain('delegate [delegate]');
  });

  test('a delegate\'s --file and --session are the gate\'s to refuse, before either is read', async () => {
    // The reviewer's finding on down and up, checked here: once the file names a delegate, the
    // owner-only flags are the gate's too, and the refusal still comes before the flagged file
    // or the flag's session is read — the `--file` below names a path that does not exist, so a
    // run that opened it would print the loader's refusal, not the gate's. Eligibility is the
    // default live file's, never the flagged one's.
    approve(DELEGATE_FILE);
    const asked: Parameters<NonNullable<AddSources['delegateGate']>>[0][] = [];
    const gate: NonNullable<AddSources['delegateGate']> = (input) => {
      asked.push(input);
      const flag = input.flags.includes('file') ? 'file' : 'session';
      return { kind: 'refused' as const, id: 'add.delegate-flag', text: `--${flag} is the owner's; the approved delegate cannot use it` };
    };
    for (const argv of [['worker', '--file', join(project, 'elsewhere.yaml')], ['worker', '--session', 'other']] as const) {
      const made = world();
      const io = testIo(project, pilot);
      const code = await runAdd([...argv], io, sources(made, { delegateGate: gate }));
      expect(code).toBe(1);
      expect(io.err).toBe(`team add: --${argv[2] === 'other' ? 'session' : 'file'} is the owner's; the approved delegate cannot use it\n`);
      expect(made.creates).toEqual([]);
    }
    expect(asked).toHaveLength(2);
    expect(asked[0]!.team.delegates).toEqual([{ pane: 'main/w1:p1', commands: ['add', 'remove'] }]);
    expect(asked[0]!.root).toBe(project);
    expect(asked[0]!.dir).toBe(join(project, '.agents'));
    expect(asked[0]!.flags).toContain('file');
    expect(asked[1]!.flags).toContain('session');
    expect(existsSync(join(project, 'elsewhere.yaml'))).toBe(false);
  });

  test('with no delegates in the default file, a non-owner\'s --file and --session are today\'s, byte for byte', async () => {
    // The finding's other half: eligibility is the default live file's alone. The flagged file
    // below names a delegate and is never read for it; the refusals stay today's sentences, in
    // today's order, and the gate is never asked.
    approve();
    writeFileSync(join(project, 'elsewhere.yaml'), DELEGATE_FILE);
    for (const [argv, text] of [
      [['worker', '--file', join(project, 'elsewhere.yaml')], '--file is the owner\'s, from a terminal outside herdr; this call is pilot'],
      [['worker', '--session', 'other'], '--session is the owner\'s, from a terminal outside herdr; this call is pilot'],
    ] as const) {
      const io = testIo(project, pilot);
      const code = await runAdd([...argv], io, sources(world(), { delegateGate: THROWING_GATE }));
      expect(code).toBe(1);
      expect(io.err).toBe(`team add: ${text}\n`);
    }
  });

  test('a delegate named like the coordinator gets no restoring add', async () => {
    // Amendment 3: a delegate does not reach the role path by being named like a lead. This
    // caller carries the coordinator's name — recorded at its own pane elsewhere — but stands
    // on the delegate's pane in another session: the run is a delegated one, and an add that
    // would edit the file is refused whatever name it brought.
    approve(DELEGATE_FILE);
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'ready', pane: 'w0:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    const store = storePath('acme', project, home);
    const before = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(project, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'main' });
    const code = await runAdd(['worker'], io, sources(made, { delegateGate: () => passed }));
    expect(code).toBe(1);
    expect(io.err).toBe(EDIT_REFUSAL);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(before);
    expect(made.creates).toEqual([]);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  // The three states a target session can be in, with the REAL gate: only its two herdr reads
  // about the team's session are faked, with the answers herdr 0.7.1 gives — a stopped or absent
  // session fails `agent list` while `session list` still reports it, running false, and an
  // unreachable herdr answers neither. The approval the gate verifies is the real one `approve()`
  // wrote into `home`.
  type GateInput = Parameters<NonNullable<AddSources['delegateGate']>>[0];
  const gateReading = (running: boolean | null) => (input: GateInput) =>
    delegateGate({ ...input, sources: { agents: () => null, sessionRunning: () => running } });

  test('a delegated add on a stopped session: the gate passes, and the session is the refusal', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const io = testIo(project, pilot);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => 'stopped',
      delegateGate: gateReading(false),
    }));
    expect(code).toBe(1);
    expect(io.err).toBe('team add: session acme is stopped; clear it with `herdr session delete acme`\n');
    expect(made.creates).toEqual([]);
  });

  test('a delegated add on an absent session passes the gate and starts the seat', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const io = testIo(project, pilot);
    const code = await runAdd(['lead'], io, sources(made, { delegateGate: gateReading(false) }));
    expect(code).toBe(0);
    expect(made.creates).toEqual(['lead']);
  });

  test('a delegated add with herdr not answering is the gate\'s refusal, and nothing is started', async () => {
    approve(DELEGATE_FILE);
    const made = world();
    const io = testIo(project, pilot);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => null,
      delegateGate: gateReading(null),
    }));
    expect(code).toBe(1);
    expect(io.err).toBe(`team add: delegation cannot verify its placement or seats: herdr doesn't answer\n`);
    expect(made.creates).toEqual([]);
  });
});


// The session mutator lock, `add`'s side: the same `.run` under `seat-locks/<session>/` that
// `up`, `down` and `remove` take — one file per session, shared by every mutator — taken before
// this run's first effect (the lobby make, the audit line, the file edit, the launch) and
// released on every exit path. A dry run and a refusal decided above the lock never take one; a
// lock a killed run left is taken over by the next one.
describe('team add, the session mutator lock', () => {
  const lockFile = (): string => seatLockPath(join(project, '.agents'), 'acme', '.run');
  const hold = (token: string): void => {
    mkdirSync(join(project, '.agents', 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(lockFile(), token);
  };

  test("a held lock refuses the add, with the holder's pid, before any effect", async () => {
    hold(`${process.pid} 0a1b2c3d\n`);
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(1);
    expect(io.err).toBe(
      `team add: another session-mutating run is holding session acme (pid ${process.pid}); try again when it is done\n`,
    );
    expect(io.out).toBe('');
    expect(made.session).toBe('absent');
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual([]);
    // Nothing was written: the seat's stopped line is still exactly where the file had it, the
    // state records no seat, and the lock a live holder owns is left as it was.
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toBeUndefined();
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('the lock is held from the launch to the audit line, and released at the end', async () => {
    const made = world();
    const held: boolean[] = [];
    const create = made.launch.createWorkspace;
    made.launch.createWorkspace = (session, cwd, label) => {
      held.push(existsSync(lockFile()));
      return create(session, cwd, label);
    };
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(0);
    expect(held).toEqual([true]);
    expect(held).not.toContain(false);
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a lock left by a dead run is taken over and released by this one', async () => {
    const dead = spawnSync('sh', ['-c', 'exit 0']).pid;
    expect(typeof dead).toBe('number');
    hold(`${dead} 0a1b2c3d\n`);
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(0);
    expect(made.creates).toEqual(['worker']);
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a dry run takes no lock while another run holds one', async () => {
    hold(`${process.pid} 0a1b2c3d\n`);
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker', '--dry-run'], io, sources(made))).toBe(0);
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(made.creates).toEqual([]);
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('a refusal decided above the lock leaves no lock behind', async () => {
    const made = world();
    const io = testIo(project, owner);
    // `missing` is not in the file: the refusal is decided long before the lock site, so this
    // run must not leave a lock file the next real run would meet.
    expect(await runAdd(['missing'], io, sources(made))).toBe(1);
    expect(io.err).toContain('no seat "missing"');
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a lock that cannot be read refuses with the file to clear', async () => {
    hold('not a token\n');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(1);
    expect(io.err).toBe(
      'team add: another session-mutating run may be holding session acme, and its lock cannot be read; '
        + `if no run is using it, delete ${lockFile()}\n`,
    );
    expect(made.creates).toEqual([]);
  });
});

describe('team add --model and --effort', () => {
  test('profile override helpers validate models, effort levels, and rewrite launch lines', () => {
    const claudeProfile = profileFor('claude-code')!;
    const codexProfile = profileFor('codex')!;

    expect(resolveModelOverride(claudeProfile, 'claude-sonnet-5-5')).toEqual({
      id: 'claude-sonnet-5-5',
      model: 'Claude Sonnet',
      version: '5.5',
    });
    expect(resolveModelOverride(claudeProfile, 'Claude Sonnet 5.5')).toEqual({
      id: 'claude-sonnet-5-5',
      model: 'Claude Sonnet',
      version: '5.5',
    });
    expect(resolveModelOverride(claudeProfile, 'unknown-model')).toBeNull();

    expect(resolveEffortOverride('claude-code', 'anthropic', 'high')).toEqual({ effort: 'high' });
    expect(resolveEffortOverride('codex', 'openai', 'xhigh')).toEqual({ effort: 'xhigh' });
    expect(resolveEffortOverride('claude-code', 'anthropic', 'extreme')).toEqual({
      error: 'effort "extreme" is not one of anthropic\'s: low, medium, high, xhigh, max',
    });
    expect(resolveEffortOverride('cursor', 'cursor', 'high')).toEqual({
      error: 'cursor does not take an --effort flag on launch',
    });

    expect(
      withLaunchOverrides(claudeProfile, 'claude --model claude-opus-5-5', {
        modelId: 'claude-sonnet-5-5',
        effort: 'high',
      }),
    ).toBe('claude --model claude-sonnet-5-5 --effort high');

    expect(
      withLaunchOverrides(codexProfile, 'codex -m gpt-6-sol -c model_reasoning_effort=high', {
        modelId: 'gpt-6-terra',
        effort: 'xhigh',
      }),
    ).toBe('codex -m gpt-6-terra -c model_reasoning_effort=xhigh');
  });

  test('owner overrides model and effort on a declared seat without breaking approval', async () => {
    const made = world();
    const typed: string[] = [];
    const baseRun = made.launch.paneRun;
    made.launch.paneRun = (session, pane, command) => {
      typed.push(command);
      return baseRun(session, pane, command);
    };
    made.launch.paneText = () => IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5');

    const io = testIo(project, owner);
    expect(await runAdd(['worker', '--model', 'claude-sonnet-5-5', '--effort', 'high'], io, sources(made))).toBe(0);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('claude --model claude-sonnet-5-5 --effort high');

    const recorded = readState(join(project, '.agents')).sessions.acme?.seats.worker;
    expect(recorded?.id).toMatch(/^seat_[0-9a-f]{12}$/);
    expect(recorded?.model).toBe('Claude Sonnet');
    expect(recorded?.version).toBe('5.5');
    expect(recorded?.effort).toBe('high');
    expect(recorded?.launch_line).toBe('claude --model claude-sonnet-5-5 --effort high');

    const loaded = loadTeamFile(project, { home });
    expect(loaded.ok && approvalDifferences(loaded.team, project, home)).toEqual([]);
  });

  test('overrides model and effort on a temporary --like seat', async () => {
    const made = world();
    const typed: string[] = [];
    const baseRun = made.launch.paneRun;
    made.launch.paneRun = (session, pane, command) => {
      typed.push(command);
      return baseRun(session, pane, command);
    };
    made.launch.paneText = () => IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5');

    const io = testIo(project, owner);
    const code = await runAdd(
      ['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh', '--model', 'claude-sonnet-5-5', '--effort', 'medium'],
      io,
      sources(made),
    );
    expect(code).toBe(0);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('claude --model claude-sonnet-5-5 --effort medium');

    const recorded = readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-01'];
    expect(recorded?.id).toMatch(/^seat_[0-9a-f]{12}$/);
    expect(recorded?.model).toBe('Claude Sonnet');
    expect(recorded?.version).toBe('5.5');
    expect(recorded?.effort).toBe('medium');
    expect(recorded?.launch_line).toBe('claude --model claude-sonnet-5-5 --effort medium');
  });

  test('refuses non-owner --model or --effort on a declared seat, and refuses unknown model or effort', async () => {
    // The one way a seat reaches the flags' own refusal in 0.5.0 is as a delegated add: the map
    // refuses every seat of this team at the caller gate, the delegate verdict below is what
    // opens a seat's run, and the same-copy gate lets this one through — `lead` is the approved
    // file's own stanza, hash for hash. The `--model` on it is what stops the run.
    approve(DELEGATE_FILE);
    const nonOwnerIo = testIo(project, pilot);
    expect(await runAdd(['lead', '--model', 'claude-sonnet-5-5'], nonOwnerIo, sources(world(), { delegateGate: () => passed }))).toBe(1);
    expect(nonOwnerIo.err).toBe(
      "team add: --model and --effort on a declared seat are the owner's; use --temporary --like <seat> for a temporary seat\n",
    );

    const badModelIo = testIo(project, owner);
    expect(await runAdd(['worker', '--model', 'nope'], badModelIo, sources(world()))).toBe(2);
    expect(badModelIo.err).toBe('team add: worker: unknown model "nope" for claude-code\n');

    const badEffortIo = testIo(project, owner);
    expect(await runAdd(['worker', '--effort', 'extreme'], badEffortIo, sources(world()))).toBe(2);
    expect(badEffortIo.err).toBe("team add: worker: effort \"extreme\" is not one of anthropic's: low, medium, high, xhigh, max\n");
  });
});


// The second half of a swap. The lead is declared and not stopped, so the add launches
// it without editing the file or the approval, and the swap's record goes once it runs.
describe('team add after a lead swap', () => {
  test('starts the lead, leaves the file as approved, and clears the swap record', async () => {
    const agents = join(project, '.agents');
    updateState(agents, (state) => {
      (state.sessions.acme ??= emptySession()).swapping = { lead: { by: 'owner', at: '2026-10-15T07:00:00.000Z' } };
    });
    const before = readFileSync(join(agents, 'team.yaml'), 'utf8');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['lead'], io, sources(made))).toBe(0);
    expect(made.creates).toEqual(['lead']);
    expect(readFileSync(join(agents, 'team.yaml'), 'utf8')).toBe(before);
    const session = readState(agents).sessions.acme;
    expect(session?.seats.lead?.stage).toBe('ready');
    expect(session?.swapping).toBeUndefined();
    expect(readFileSync(join(agents, 'team.log'), 'utf8')).toContain('lead runs its new agent (swap started by owner at 2026-10-15T07:00:00.000Z)');
  });
});
