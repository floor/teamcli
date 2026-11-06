// Independent scenes for the opt-in resolver. With no flag, each seat's pane command is the
// argv this launch builds today, byte for byte. With --resolve-launch, claude, codex and agy
// start with the resolver argv plus that profile's own words, and the line that was built is
// the line the record keeps. A Grok seat that starts at the shared project root, and a managed
// Codex seat, are refused by name, and nothing starts. A blank caller session and a placeholder
// with no context refuse the launch.
// Synthetic home, team, and host only.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { withLauncherCover } from '../src/launch/launcher-cover.ts';
import { loadTeamLaunchers } from '../src/launch/resolve-flag.ts';
import { upPlan, type Step } from '../src/launch/plan.ts';
import { discover, resolveLaunch, type LauncherHome, type ResolveContext } from '../src/launchers/resolve.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { shellQuote } from '../src/profiles/profile.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { parseYaml, toValue } from '../src/yaml.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, recordRenames, testIo } from './helpers.ts';

const IDLE = {
  claude: readFileSync(new URL('./fixtures/claude-code/2.1.302/idle.txt', import.meta.url), 'utf8'),
  codex: readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8'),
  grok: readFileSync(new URL('./fixtures/grok/1.0.70/idle.txt', import.meta.url), 'utf8'),
  agy: readFileSync(new URL('./fixtures/antigravity/1.4.2/idle.txt', import.meta.url), 'utf8'),
};

// The program word, past a leading `NAME=value` assignment. A later path that merely contains
// the launch word is not that program.
function programWord(command: string): string {
  for (const word of command.split(/[ \t]+/)) {
    if (word === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word;
  }
  return '';
}

function launchesSeat(command: string, seat: Seat): boolean {
  const program = programWord(command);
  const base = basename(program);
  return program === seat.binary || program === seat.launch
    || base === seat.launch || base === basename(seat.binary);
}

function idleFor(command: string): string {
  if (command.includes('codex')) return IDLE.codex;
  if (command.includes('grok')) return IDLE.grok;
  if (command.includes('agy')) return IDLE.agy;
  return IDLE.claude;
}

const NOW = new Date('2026-11-06T16:10:00Z');
const SESSION = 'scratch';
const PLACEHOLDER = 'a consumed placeholder requires nonempty inbox or session context';
const BLANK_SESSION = 'a supplied caller session must be a nonempty string';

const SEATS = [
  { name: 'claude-lead', role: 'coordinator', cli: 'claude-code', launch: 'claude', binary: '/opt/fixture/claude-resolved', model: 'Test', version: '1' },
  { name: 'codex-op', role: 'operator', cli: 'codex', launch: 'codex', binary: '/opt/fixture/codex-resolved', model: 'GPT Terra', version: '5.6' },
  { name: 'grok-hand', role: 'implementer', cli: 'grok', launch: 'grok', binary: '/opt/fixture/grok-resolved', model: 'Grok', version: '4.7' },
  { name: 'agy-hand', role: 'implementer', cli: 'antigravity', launch: 'agy', binary: '/opt/fixture/agy-resolved', model: 'Test', version: '1' },
] as const;

type Seat = (typeof SEATS)[number];

let scratch = '';

afterEach(() => {
  if (scratch !== '') discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = '';
});

function launcherText(seat: Seat, word: string): string {
  const spelled = word.startsWith('{') ? `"${word}"` : word;
  return `format: 1\nname: ${seat.name}-resolved\nkind: custom\nargv:\n  - ${seat.binary}\n  - ${spelled}\n`;
}

function teamText(root: string, seats: readonly Seat[], named: boolean): string {
  const lead = seats.find((seat) => seat.role === 'coordinator')?.name ?? seats[0]?.name ?? 'claude-lead';
  const operator = seats.find((seat) => seat.role === 'operator')?.name ?? lead;
  const rows = seats.map((seat) => [
    `  - role: ${seat.role}`,
    `    name: ${seat.name}`,
    `    label: ${seat.name}`,
    `    cli: ${seat.cli}`,
    '    vendor: test',
    `    model: "${seat.model}"`,
    `    version: "${seat.version}"`,
    `    launch: ${seat.launch}`,
    named ? `    launcher: ${seat.name}-resolved` : '',
  ].filter((line) => line !== '').join('\n')).join('\n');
  return `format: 1
project: acme
session: ${SESSION}
coordinator: ${lead}
operator: ${operator}
workspace:
  mode: shared
  base: main
trust:
  - ${lobbyDir(join(root, '..', 'home'))}
  - ${root}
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
    createWorkspace() {
      n += 1;
      const pane = `fixture-pane-${n}`;
      panes.set(pane, { text: '', agent: false });
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
    workspacePanes: () => ['fixture-pane-1'],
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

function prepare(seats: readonly Seat[], word = '--from-resolver', named = false): {
  root: string;
  home: string;
  made: ReturnType<typeof world>;
} {
  scratch = fixtureBase('resolve-launch-wiring-');
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true });
  if (named) {
    const dir = join(root, '.agents', 'launchers');
    mkdirSync(dir, { recursive: true });
    for (const seat of seats) {
      writeFileSync(join(dir, `${seat.name}-resolved.yaml`), launcherText(seat, word), { mode: 0o600 });
    }
  }
  const text = teamText(root, seats, named);
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: withLauncherCover(approvalOf(loaded.team, loaded.root, NOW), root), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
  return { root, home, made: world() };
}

function sources(home: string, made: ReturnType<typeof world>): UpSources {
  const doctor: DoctorSources = {
    version: () => '1.0.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor,
    launch: made.launch,
  };
}

function resolvedCommand(root: string, home: string, seat: Seat, seats: readonly Seat[], word: string): string {
  const files: Record<string, unknown> = {};
  for (const one of seats) {
    files[`${one.name}-resolved.yaml`] = toValue(parseYaml(launcherText(one, word)));
  }
  const found: LauncherHome = { level: 'team', files };
  const ctx: ResolveContext = {
    teamRoot: root,
    teamHome: home,
    cwd: root,
    parentEnv: {},
    existingPaths: [],
    seatNames: seats.map((one) => one.name),
  };
  const resolved = resolveLaunch({ launcher: `${seat.name}-resolved` }, discover([found]), ctx);
  expect(resolved.ok).toBe(true);
  return resolved.argv.map((part) => shellQuote(part)).join(' ');
}

test('flag off gives today\'s argv for claude, codex, grok and agy', async () => {
  const { root, home, made } = prepare(SEATS);
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp([], io, sources(home, made));
  expect(code, io.out + io.err).toBe(0);
  const commands = made.runs.map((run) => run.command);
  const today: Record<Seat['launch'], string> = {
    claude: '--dangerously-skip-permissions',
    codex: '--no-daemon',
    grok: '--trust',
    agy: '--prompt-interactive',
  };
  for (const seat of SEATS) {
    const command = commands.find((line) => line.startsWith(`AGENT_UNATTENDED=1 ${seat.launch} `));
    expect(command, seat.name).toBeDefined();
    expect(command).toContain(today[seat.launch]);
    expect(command).not.toContain(seat.binary);
    expect(command).not.toContain('--from-resolver');
  }
});

const PROFILE_WORDS: Record<'claude' | 'codex' | 'agy', readonly string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['-a never', '-s danger-full-access'],
  agy: ['--prompt-interactive'],
};

const STARTS = SEATS.filter((seat) => seat.launch !== 'grok');

test('flag on starts claude, codex and agy with the resolver argv plus their profile words, and records that line', async () => {
  const { root, home, made } = prepare(STARTS, '--from-resolver', true);
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(home, made));
  expect(code, io.out + io.err).toBe(0);
  const commands = made.runs.map((run) => run.command);
  const recorded = readState(join(root, '.agents')).sessions[SESSION]?.seats ?? {};
  for (const seat of STARTS) {
    const resolved = resolvedCommand(root, home, seat, STARTS, '--from-resolver');
    const prefix = `AGENT_UNATTENDED=1 ${resolved}`;
    const command = commands.find((line) => line === prefix || line.startsWith(`${prefix} `));
    expect(command, `${seat.name}\n${io.out}${io.err}`).toBeDefined();
    for (const word of PROFILE_WORDS[seat.launch]) expect(command).toContain(word);
    const line = recorded[seat.name]?.launch_line;
    expect(line, seat.name).toBeDefined();
    expect(line === prefix || line?.startsWith(`${prefix} `)).toBe(true);
    for (const word of PROFILE_WORDS[seat.launch]) expect(line).toContain(word);
    // The record keeps the line the plan built. The pane runs that line, plus a session id
    // when the CLI takes one, and check compares the stored line rather than the short launch.
    expect(command === line || command?.startsWith(`${line} `)).toBe(true);
    expect(line).not.toBe(seat.launch);
  }
});

test('flag on refuses a Grok seat by name and starts nothing', async () => {
  const seat = SEATS.find((one) => one.launch === 'grok');
  if (seat === undefined) throw new Error('a scene names no grok seat');
  const { root, home, made } = prepare([seat], '--from-resolver', true);
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(home, made));
  const said = io.out + io.err;
  expect(code, said).not.toBe(0);
  expect(said).toContain(`${seat.name}:`);
  // This seat is the only one, so it is the lead and starts at the shared project root.
  expect(said).toContain('its start folder is the shared project root, which would grant the whole checkout; give the seat its own worktree or clone');
  expect(made.runs.some((run) => launchesSeat(run.command, seat))).toBe(false);
});

test('flag on refuses a managed Codex seat by name and starts nothing', () => {
  const seat = SEATS.find((one) => one.launch === 'codex');
  if (seat === undefined) throw new Error('a scene names no codex seat');
  const { root } = prepare([seat], '--from-resolver', true);
  const steps = upPlan({
    root,
    session: SESSION,
    sessionRunning: true,
    watchAlive: true,
    watchLabel: 'watch',
    stateDir: join(root, '.agents'),
    resolveLaunch: true,
    launcherDiscovery: loadTeamLaunchers(root),
    home: join(root, '..', 'home'),
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
  const refusal = steps.find((step): step is Extract<Step, { kind: 'skip' }> => step.kind === 'skip' && step.do?.do === 'refuse');
  const why = refusal?.do?.do === 'refuse' ? refusal.do.why : '';
  expect(refusal?.text ?? '').toContain(`${seat.name}:`);
  expect(why).toContain('managed Codex endpoint');
  expect(steps.some((step) => step.do?.do === 'launch')).toBe(false);
});

test('a placeholder with no context refuses the launch and starts nothing', async () => {
  const seat = SEATS[0];
  const { root, home, made } = prepare([seat], '{inbox}', true);
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(home, made));
  expect(code, io.out + io.err).not.toBe(0);
  expect(io.out + io.err).toContain(PLACEHOLDER);
  expect(made.runs.some((run) => launchesSeat(run.command, seat))).toBe(false);
});

test('a blank caller session refuses the launch and starts nothing', async () => {
  const seat = SEATS[0];
  const { root, home, made } = prepare([seat], '--from-resolver', true);
  updateState(join(root, '.agents'), (state) => {
    const held = state.sessions[SESSION] ?? emptySession();
    held.seats[seat.name] = { stage: 'ready', agent_session: '' };
    state.sessions[SESSION] = held;
  });
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(home, made));
  expect(code, io.out + io.err).not.toBe(0);
  expect(io.out + io.err).toContain(BLANK_SESSION);
  expect(made.runs.some((run) => launchesSeat(run.command, seat))).toBe(false);
});
