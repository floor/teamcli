// The launch argv is the declarative resolver's only when the caller asks. With the flag off,
// the pane runs the launch line it runs today. With the flag on, the pane runs the resolver's
// argv. A refused resolution is the resolver's own message, and that seat is not started.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { discover, resolveLaunch, type LauncherHome, type ResolveContext } from '../src/launchers/resolve.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { shellQuote } from '../src/profiles/profile.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { parseYaml, toValue } from '../src/yaml.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, recordRenames, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T16:00:00Z');
const SESSION = 'scratch';
const OWNER = { kind: 'owner' } as const;
const PLACEHOLDER = 'a consumed placeholder requires nonempty inbox or session context';
const BLANK_SESSION = 'a supplied caller session must be a nonempty string';

type SeatFixture = {
  name: string;
  role: 'coordinator' | 'operator' | 'implementer';
  cli: string;
  launch: string;
  binary: string;
};

const CLIS: readonly SeatFixture[] = [
  { name: 'claude-lead', role: 'coordinator', cli: 'claude-code', launch: 'claude', binary: '/opt/fixture/claude-resolved' },
  { name: 'codex-op', role: 'operator', cli: 'codex', launch: 'codex', binary: '/opt/fixture/codex-resolved' },
  { name: 'grok-hand', role: 'implementer', cli: 'grok', launch: 'grok', binary: '/opt/fixture/grok-resolved' },
  { name: 'agy-hand', role: 'implementer', cli: 'antigravity', launch: 'agy', binary: '/opt/fixture/agy-resolved' },
];

let scratch = '';

afterEach(() => {
  if (scratch !== '') discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = '';
});

function launcherText(name: string, binary: string, word: string): string {
  return [
    'format: 1',
    `name: ${name}`,
    'kind: custom',
    'argv:',
    `  - ${binary}`,
    `  - ${word.startsWith('{') ? `"${word}"` : word}`,
    '',
  ].join('\n');
}

function teamText(root: string, seats: readonly SeatFixture[]): string {
  const first = seats[0];
  if (first === undefined) throw new Error('a scene names no seat');
  const lead = seats.find((seat) => seat.role === 'coordinator')?.name ?? first.name;
  const operator = seats.find((seat) => seat.role === 'operator')?.name ?? lead;
  const rows = seats.map((seat) => [
    '  - role: ' + seat.role,
    `    name: ${seat.name}`,
    `    label: ${seat.name}`,
    `    cli: ${seat.cli}`,
    '    vendor: example',
    '    model: Example',
    '    version: "1"',
    `    launch: ${seat.launch}`,
    `    launcher: ${seat.name}-resolved`,
  ].join('\n')).join('\n');
  return `format: 1
project: acme
session: ${SESSION}
coordinator: ${lead}
operator: ${operator}
workspace:
  mode: shared
  base: main
trust:
  - ~/.config/team/lobby
  - ${root}
watch:
  interval: 120s
  checks:
    extra: off
    team-idle: off
    load: off
    memory: off
    disk: off
    swap-free: off
    swap-growth: off
    budget: off
    idle: off
    unsent: off
    restored: off
seats:
${rows}
`;
}

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const runs: { pane: string; command: string }[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, _label) {
      n += 1;
      const pane = n === 1 ? 'fixture-pane-one' : 'fixture-pane-two';
      panes.set(pane, { text: CLAUDE_IDLE, agent: false });
      return { pane, workspace: `fixture-ws-${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(workspace));
      return found.length > 0 ? found : ['fixture-pane-one'];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'grok', 'agy'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  recordRenames(launch);
  return { launch, runs };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '1.0.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function approve(root: string, home: string, text: string): void {
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function writeLaunchers(root: string, seats: readonly SeatFixture[], word = '--from-resolver'): void {
  const dir = join(root, '.agents', 'launchers');
  mkdirSync(dir, { recursive: true });
  for (const seat of seats) {
    writeFileSync(join(dir, `${seat.name}-resolved.yaml`), launcherText(`${seat.name}-resolved`, seat.binary, word), { mode: 0o600 });
  }
}

function prepare(seats: readonly SeatFixture[], word?: string): { root: string; home: string; made: ReturnType<typeof world> } {
  scratch = fixtureBase('resolve-launch-');
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true });
  writeLaunchers(root, seats, word);
  approve(root, home, teamText(root, seats));
  return { root, home, made: world() };
}

/** The owner's terminal is already closed. A seat whose screen is not idle is left out at once,
 *  after the pane command has run. The closed stream is this fixture's, never the process stdin. */
function closedTerminal(): Terminal {
  return { key: async () => 'eof', drain() {} };
}

function sources(home: string, made: ReturnType<typeof world>): UpSources {
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor: doctor(home),
    launch: made.launch,
    terminal: closedTerminal,
  };
}

function expectedCommand(root: string, home: string, seat: SeatFixture, seats: readonly SeatFixture[]): string {
  const files: Record<string, unknown> = {};
  for (const one of seats) {
    const name = `${one.name}-resolved.yaml`;
    files[name] = toValue(parseYaml(launcherText(`${one.name}-resolved`, one.binary, '--from-resolver')));
  }
  const homeFiles: LauncherHome = { level: 'team', files };
  const ctx: ResolveContext = {
    teamRoot: root,
    teamHome: home,
    cwd: root,
    parentEnv: {},
    existingPaths: [],
    seatNames: seats.map((one) => one.name),
  };
  const resolved = resolveLaunch({ launcher: `${seat.name}-resolved` }, discover([homeFiles]), ctx);
  expect(resolved.ok).toBe(true);
  return resolved.argv.map((word) => shellQuote(word)).join(' ');
}

function alone(seat: SeatFixture): SeatFixture {
  return { ...seat, role: 'coordinator' };
}

function firstSeat(): SeatFixture {
  const seat = CLIS[0];
  if (seat === undefined) throw new Error('a scene names no seat');
  return seat;
}

function release(): void {
  if (scratch === '') return;
  discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = '';
}

describe('resolve-launch stays off unless named', () => {
  test('flag off runs today\'s argv for claude, codex, grok and agy', async () => {
    for (const seat of CLIS) {
      const { root, home, made } = prepare([alone(seat)]);
      const io = testIo(root, OWNER);
      const code = await runUp([], io, sources(home, made));
      const command = made.runs.map((run) => run.command).find((line) => line.includes(`${seat.launch} `) || line.endsWith(seat.launch) || line.includes(` ${seat.launch} `));
      expect(command, `${seat.name}\n${io.out}${io.err}`).toBeDefined();
      expect(command).toContain('AGENT_UNATTENDED=1');
      expect(command).toContain(seat.launch);
      expect(command).not.toContain(seat.binary);
      expect(command).not.toContain('--from-resolver');
      if (seat.cli === 'claude-code') expect(code, `${seat.name}\n${io.out}${io.err}`).toBe(0);
      release();
    }
  }, 30000);

  test('flag on runs the resolved argv', async () => {
    for (const seat of CLIS) {
      const one = alone(seat);
      const { root, home, made } = prepare([one]);
      const io = testIo(root, OWNER);
      const code = await runUp(['--resolve-launch'], io, sources(home, made));
      expect(made.runs.map((run) => run.command), `${seat.name}\n${io.out}${io.err}`).toContain(expectedCommand(root, home, one, [one]));
      if (seat.cli === 'claude-code') expect(code, `${seat.name}\n${io.out}${io.err}`).toBe(0);
      release();
    }
  }, 30000);

  test('a missing placeholder refuses the launch and starts nothing', async () => {
    const seat = firstSeat();
    const { root, home, made } = prepare([seat], '{inbox}');
    const io = testIo(root, OWNER);
    const code = await runUp(['--resolve-launch'], io, sources(home, made));
    expect(code, io.out + io.err).not.toBe(0);
    expect(io.out + io.err).toContain(PLACEHOLDER);
    expect(made.runs.some((run) => run.command.includes(seat.binary))).toBe(false);
  });

  test('a blank caller session refuses the launch and starts nothing', async () => {
    const seat = firstSeat();
    const { root, home, made } = prepare([seat]);
    updateState(join(root, '.agents'), (state) => {
      const held = state.sessions[SESSION] ?? emptySession();
      held.seats[seat.name] = { stage: 'launched', agent_session: '' };
      state.sessions[SESSION] = held;
    });
    const io = testIo(root, OWNER);
    const code = await runUp(['--resolve-launch'], io, sources(home, made));
    expect(code, io.out + io.err).not.toBe(0);
    expect(io.out + io.err).toContain(BLANK_SESSION);
    expect(made.runs.some((run) => run.command.includes(seat.binary))).toBe(false);
  });
});

describe('team restart uses the same flag', () => {
  function restartSources(home: string, made: ReturnType<typeof world>): RestartSources {
    return {
      home,
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => null,
      foreground: () => ['claude'],
      now: () => NOW,
      sleep: async () => {},
      workspaces: () => [],
      upLaunch: made.launch,
      doctor: doctor(home),
    };
  }

  test('flag off restarts on today\'s argv and flag on restarts on the resolved argv', async () => {
    const seat = firstSeat();
    const off = prepare([seat]);
    const offIo = testIo(off.root, OWNER);
    const offCode = await runRestart([seat.name], offIo, restartSources(off.home, off.made));
    expect(offCode, offIo.out + offIo.err).toBe(0);
    const offCommand = off.made.runs.map((run) => run.command).find((line) => line.includes(seat.launch));
    expect(offCommand).toBeDefined();
    expect(offCommand).toContain('AGENT_UNATTENDED=1');
    expect(offCommand).not.toContain('--from-resolver');
    discardFixtures([scratch], { roots: [dirname(scratch)] });
    scratch = '';

    const on = prepare([seat]);
    const onIo = testIo(on.root, OWNER);
    const onCode = await runRestart([seat.name, '--resolve-launch'], onIo, restartSources(on.home, on.made));
    expect(onCode, onIo.out + onIo.err).toBe(0);
    expect(on.made.runs.map((run) => run.command)).toContain(expectedCommand(on.root, on.home, seat, [seat]));
  });
});
