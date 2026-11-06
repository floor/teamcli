// The launch argv is the declarative resolver's only when the caller asks. With the flag off,
// the pane runs the launch line it runs today. With the flag on, the resolver argv is the base
// line and the profile still places its launch words on it. A refused resolution is the
// resolver's own message, and that seat is not started. A Grok seat that is the lead starts at
// the shared project root, and that launch is refused in those words; beside a lead it starts
// in its own folder under the project, inside the trust grant.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { withLauncherCover } from '../src/launch/launcher-cover.ts';
import { upPlan } from '../src/launch/plan.ts';
import { loadTeamLaunchers } from '../src/launch/resolve-flag.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
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

function placedWord(cli: string): string {
  if (cli === 'codex') return 'mcp_servers.team_inbox';
  if (cli === 'grok') return '--rules';
  if (cli === 'antigravity') return '--prompt-interactive';
  return '--append-system-prompt';
}

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

function teamText(root: string, seats: readonly SeatFixture[], start?: string): string {
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
${start === undefined ? '' : `lobby: ${start}\n`}workspace:
  mode: shared
  base: main
trust:
  - ${lobbyDir(join(root, '..', 'home'))}
  - ${root}${start === undefined ? '' : `\n  - ${start}`}
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

function prepare(seats: readonly SeatFixture[], word?: string, covered = false, ownStart = false): { root: string; home: string; made: ReturnType<typeof world> } {
  scratch = fixtureBase('resolve-launch-');
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true });
  // The seat's own folder under the project. It is inside the root grant and is not the
  // shared project root, so a Grok seat that starts here is not refused.
  const start = ownStart ? join(root, 'worktrees', 'grok-hand') : undefined;
  if (start !== undefined) mkdirSync(start, { recursive: true, mode: 0o700 });
  writeLaunchers(root, seats, word);
  approve(root, home, teamText(root, seats, start), covered);
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
      // A Grok lead starts at the shared project root, which the sandbox refuses. Beside a
      // lead, this seat starts in its own folder under the project, inside the trust grant.
      const own = seat.cli === 'grok';
      const seats = own ? [firstSeat(), seat] : [alone(seat)];
      const { root, home, made } = prepare(seats, undefined, false, own);
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

  test('flag on places the profile words on the resolver argv', async () => {
    for (const seat of CLIS) {
      const one = alone(seat);
      const { root, home, made } = prepare([one], undefined, true);
      const io = testIo(root, OWNER);
      const code = await runUp(['--resolve-launch'], io, sources(home, made));
      const said = io.out + io.err;
      if (seat.cli === 'grok') {
        // This seat is the lead, so its start folder is the shared project root.
        expect(code, `${seat.name}\n${said}`).not.toBe(0);
        expect(said).toContain('its start folder is the shared project root, which would grant the whole checkout; give the seat its own worktree or clone');
        expect(made.runs.some((run) => run.command.includes(seat.binary))).toBe(false);
        release();
        continue;
      }
      const command = made.runs.map((run) => run.command).find((line) => line.includes(seat.binary));
      expect(command, `${seat.name}\n${said}`).toBeDefined();
      expect(command).toContain('--from-resolver');
      expect(command).toContain(placedWord(seat.cli));
      if (seat.cli === 'claude-code') {
        expect(code, `${seat.name}\n${said}`).toBe(0);
        const recorded = readState(join(root, '.agents')).sessions[SESSION]?.seats[seat.name]?.launch_line;
        expect(recorded, said).toContain(seat.binary);
      }
      release();
    }
  }, 30000);

  test('flag on refuses a seat that needs the managed Codex endpoint', () => {
    const seat = CLIS.find((one) => one.cli === 'codex');
    if (seat === undefined) throw new Error('a scene names no codex seat');
    const { root } = prepare([alone(seat)], undefined, true);
    const steps = upPlan({
      root,
      session: SESSION,
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'watch',
      stateDir: join(root, '.agents'),
      resolveLaunch: true,
      launcherDiscovery: loadTeamLaunchers(root),
      seats: [{
        name: seat.name,
        cli: 'codex',
        launch: 'codex',
        launcher: `${seat.name}-resolved`,
        cwd: root,
        label: seat.name,
        stopped: false,
        rules: 'Rules.',
        repairLine: 'repair',
        codexDaemon: 'on',
        rulesFile: { path: join(root, 'rules.md'), line: 'rules' },
      }],
    });
    const refusal = steps.find((step) => step.do?.do === 'refuse');
    const why = refusal?.do?.do === 'refuse' ? refusal.do.why : '';
    expect(why).toContain('managed Codex endpoint');
    expect(steps.some((step) => step.do?.do === 'launch')).toBe(false);
  });

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

  test('flag off restarts on today\'s argv and flag on places the profile words', async () => {
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
    const onCommand = on.made.runs.map((run) => run.command).find((line) => line.includes(seat.binary));
    expect(onCommand, onIo.out + onIo.err).toBeDefined();
    expect(onCommand).toContain('--from-resolver');
    expect(onCommand).toContain(placedWord(seat.cli));
    expect(onCode, onIo.out + onIo.err).toBe(0);
  });
});
