// The launch argv is the declarative resolver's only when the caller asks. With the flag off,
// the pane runs the launch line it runs today. With the flag on, the pane runs the resolver's
// argv. A refused resolution is the resolver's own message, and that seat is not started.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { withLauncherCover } from '../src/launch/launcher-cover.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, recordRenames, testIo } from './helpers.ts';

const IDLE = {
  claude: CLAUDE_IDLE,
  codex: readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8'),
  grok: readFileSync(new URL('./fixtures/grok/1.0.70/idle.txt', import.meta.url), 'utf8'),
  agy: readFileSync(new URL('./fixtures/antigravity/1.4.12/idle.txt', import.meta.url), 'utf8'),
};

function idleFor(command: string): string {
  if (command.includes('codex')) return IDLE.codex;
  if (command.includes('grok')) return IDLE.grok;
  if (command.includes('agy')) return IDLE.agy;
  return IDLE.claude;
}

const NOW = new Date('2026-11-06T16:00:00Z');
const SESSION = 'scratch';
const OWNER = { kind: 'owner' } as const;
const PLACEHOLDER = 'a consumed placeholder requires nonempty inbox or session context';
const BLANK_SESSION = 'a supplied caller session must be a nonempty string';
const LAUNCH_WORDS = 'resolve-launch starts the launcher argv alone, and this profile has launch words to place';

type SeatFixture = {
  name: string;
  role: 'coordinator' | 'operator' | 'implementer';
  cli: string;
  launch: string;
  binary: string;
  model: string;
  version: string;
};

const CLIS: readonly SeatFixture[] = [
  { name: 'claude-lead', role: 'coordinator', cli: 'claude-code', launch: 'claude', binary: '/opt/fixture/claude-resolved', model: 'Example', version: '1' },
  { name: 'codex-op', role: 'operator', cli: 'codex', launch: 'codex', binary: '/opt/fixture/codex-resolved', model: 'GPT Terra', version: '5.6' },
  { name: 'grok-hand', role: 'implementer', cli: 'grok', launch: 'grok', binary: '/opt/fixture/grok-resolved', model: 'Example', version: '1' },
  { name: 'agy-hand', role: 'implementer', cli: 'antigravity', launch: 'agy', binary: '/opt/fixture/agy-resolved', model: 'Gemini Argon', version: '4' },
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
    `    model: "${seat.model}"`,
    `    version: "${seat.version}"`,
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
      panes.set(pane, { text: IDLE.claude, agent: false });
      return { pane, workspace: `fixture-ws-${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) {
        known.agent = true;
        known.text = idleFor(command);
      }
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

function approve(root: string, home: string, text: string, covered: boolean): void {
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const approval = approvalOf(loaded.team, loaded.root, NOW);
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: covered ? withLauncherCover(approval, root) : approval, file: text },
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

function prepare(seats: readonly SeatFixture[], word?: string, covered = false): { root: string; home: string; made: ReturnType<typeof world> } {
  scratch = fixtureBase('resolve-launch-');
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true });
  writeLaunchers(root, seats, word);
  approve(root, home, teamText(root, seats), covered);
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

  test('flag on refuses a profile that still has launch words to place', async () => {
    for (const seat of CLIS) {
      const one = alone(seat);
      const { root, home, made } = prepare([one], undefined, true);
      const io = testIo(root, OWNER);
      const code = await runUp(['--resolve-launch'], io, sources(home, made));
      expect(code, `${seat.name}\n${io.out}${io.err}`).not.toBe(0);
      expect(io.out + io.err).toContain(LAUNCH_WORDS);
      expect(made.runs.some((run) => run.command.includes(seat.binary))).toBe(false);
      release();
    }
  }, 30000);

  test('a missing placeholder refuses the launch and starts nothing', async () => {
    const seat = firstSeat();
    const { root, home, made } = prepare([seat], '{inbox}', true);
    const io = testIo(root, OWNER);
    const code = await runUp(['--resolve-launch'], io, sources(home, made));
    expect(code, io.out + io.err).not.toBe(0);
    expect(io.out + io.err).toContain(PLACEHOLDER);
    expect(made.runs.some((run) => run.command.includes(seat.binary))).toBe(false);
  });

  test('a blank caller session refuses the launch and starts nothing', async () => {
    const seat = firstSeat();
    const { root, home, made } = prepare([seat], undefined, true);
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

  test('flag off restarts on today\'s argv and flag on refuses a profile with launch words', async () => {
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

    const on = prepare([seat], undefined, true);
    const onIo = testIo(on.root, OWNER);
    const onCode = await runRestart([seat.name, '--resolve-launch'], onIo, restartSources(on.home, on.made));
    expect(onCode, onIo.out + onIo.err).not.toBe(0);
    expect(onIo.out + onIo.err).toContain(LAUNCH_WORDS);
    expect(on.made.runs.some((run) => run.command.includes(seat.binary))).toBe(false);
  });
});
