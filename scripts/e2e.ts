// The end-to-end run, local only: CI has no herdr. It creates its own herdr session
// ("team-test-e2e"), drives the real commands against fake seats it starts
// (scripts/fake-seat.ts), checks the log lines and the state file after each, and stops and
// deletes the session on every path. Nothing here touches a live session or the owner's home:
// the project and the approval store are fresh folders under the system's temporary directory.
//
//   bun run e2e
//
// It refuses to start without herdr, with the machine over its gate, or when the session
// already exists. The steps and what each check means are in README, under "The end-to-end run".
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { standingSource } from '../src/commands/status.ts';
import { realSources as addReal, runAdd, type AddSources } from '../src/commands/add.ts';
import { runApprove } from '../src/approve/command.ts';
import { realSources as downReal, runDown } from '../src/commands/down.ts';
import { realSources as removeReal, runRemove } from '../src/commands/remove.ts';
import { realSources as statusReal, runStatus } from '../src/commands/status.ts';
import { realWatchSources, runWatch } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { agentList, herdrVersion, paneRead, sessionState, workspaceList } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { shellQuote } from '../src/profiles/profile.ts';
import { LOG_FILE, STATE_FILE, readState, type SeatState } from '../src/state.ts';
import { readApproval, storePath } from '../src/store/store.ts';
import { parseMemoryPressure, parseSwapUsage } from '../src/watch/machine.ts';
import { NUDGE_TEXT } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';

export const SESSION = 'team-test-e2e';
export const PROJECT = 'e2e';

/** How long the gate watches the swap before it decides, as the live tests do. */
const GATE_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// The pieces checked on their own (test/e2e.test.ts), with no herdr anywhere.

export type GateReading = { load: number | null; memoryFree: number | null; swapUsed: number | null };

/** The machine's figures as the gate reads them. Each is null when it can't be read here. */
export function readGate(): GateReading {
  const command = (name: string, args: string[]): string | null => {
    try {
      return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    } catch {
      return null;
    }
  };
  const uptime = command('uptime', []);
  const load = /load averages?: ([\d.]+)/.exec(uptime ?? '')?.[1];
  const pressure = command('memory_pressure', []);
  const swap = parseSwapUsage(command('sysctl', ['-n', 'vm.swapusage']) ?? '');
  return {
    load: load === undefined ? null : Number(load),
    memoryFree: pressure === null ? null : parseMemoryPressure(pressure),
    swapUsed: swap?.used ?? null,
  };
}

/** Why the machine is over its gate, or null. Two swap readings, `GATE_WAIT_MS` apart. */
export function gateProblem(first: GateReading, second: GateReading): string | null {
  if (first.load === null || first.memoryFree === null || first.swapUsed === null || second.swapUsed === null) {
    return 'the load, the free memory or the swap can\'t be read here';
  }
  if (!(first.load < 60)) return `the load is ${first.load}, not under 60`;
  if (first.memoryFree < 25) return `free memory is ${Math.round(first.memoryFree)}%, not 25% or more`;
  if (second.swapUsed > first.swapUsed) {
    return `swap used grew from ${first.swapUsed} to ${second.swapUsed} in ${GATE_WAIT_MS / 1000} s: the machine is paging`;
  }
  return null;
}

/** Whether a `status` row reads as this seat, in this state, on this model. */
export function rowShown(out: string, name: string, state: string, model: string): boolean {
  return out.split('\n').some((line) => {
    const cells = line.trim().split(/\s{2,}/);
    return cells[0] === name && cells[1] === state && cells[2] === model;
  });
}

/** Whether any line holds this text. Log files and captured output are matched line-wise. */
export function hasLine(lines: readonly string[], needle: string): boolean {
  return lines.some((line) => line.includes(needle));
}

// ---------------------------------------------------------------------------------------------
// The run itself.

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class Checks {
  private total = 0;
  private failed = 0;
  begin(where: string): Step {
    console.log(`\n== ${where}`);
    return new Step(this);
  }
  record(condition: boolean, text: string): boolean {
    this.total++;
    if (condition) {
      console.log(`  ok    ${text}`);
      return true;
    }
    this.failed++;
    console.log(`  FAIL  ${text}`);
    return false;
  }
  note(text: string): void {
    console.log(`  --    ${text}`);
  }
  summary(): { total: number; failed: number } {
    return { total: this.total, failed: this.failed };
  }
}

/** The checks of one step. `ok` is false once one of them failed. */
class Step {
  ok = true;
  private readonly checks: Checks;
  constructor(checks: Checks) {
    this.checks = checks;
  }
  check(condition: boolean, text: string): void {
    if (!this.checks.record(condition, text)) this.ok = false;
  }
}

type Context = {
  checks: Checks;
  /** The project root. */
  project: string;
  /** The project's `.agents`, where `team.state.json` and `team.log` live. */
  dir: string;
  /** The path passed as `--file`. */
  file: string;
  /** The scratch home the approval store lives in. */
  home: string;
};

function ownerIo(cwd: string): Io & { out: string; err: string } {
  const io = {
    cwd,
    env: {},
    stdinIsTTY: false,
    caller: { kind: 'owner' as const },
    out: '',
    err: '',
    stdout(text: string) {
      io.out += text;
    },
    stderr(text: string) {
      io.err += text;
    },
  };
  return io;
}

/** Prints a command's own output, indented, so the run reads as the commands saw it. */
function show(io: { out: string; err: string }, last: number = Number.POSITIVE_INFINITY): void {
  const lines = (io.out + io.err).split('\n').filter((line) => line !== '');
  const kept = lines.slice(-last);
  for (const line of kept) console.log(`      | ${line}`);
  if (lines.length > kept.length) console.log(`      | … ${lines.length - kept.length} more line(s)`);
}

function seatRecord(ctx: Context, name: string): SeatState | undefined {
  return readState(ctx.dir).sessions[SESSION]?.seats[name];
}

function logLines(ctx: Context): string[] {
  try {
    return readFileSync(join(ctx.dir, LOG_FILE), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function logHas(ctx: Context, needle: string): boolean {
  return hasLine(logLines(ctx), needle);
}

/** The input log of one seat's fake, named for the pane herdr gave it. Null with no such seat. */
function seatLog(ctx: Context, name: string): string | null {
  const pane = seatRecord(ctx, name)?.pane;
  if (!pane) return null;
  return join(ctx.dir, 'seats', `${pane}.log`);
}

/** The bytes one fake seat received, as the text they made. Its log holds one JSON chunk a line. */
function receivedBytes(log: string): string {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
      .join('');
  } catch {
    return '';
  }
}

function addSources(ctx: Context): AddSources {
  return { ...addReal, home: ctx.home, doctor: { ...addReal.doctor, home: ctx.home } };
}

/** A seat's launch line: bash runs the fake with argv0 "claude", which herdr's profile matches.
 * Its log is named for the pane herdr gives it — a shell variable the pane's shell sets — so a
 * seat cloned with `--temporary --like` still logs its own bytes in a file of its own. */
function fakeLaunch(seats: string): string {
  const script = join(import.meta.dir, 'fake-seat.ts');
  const inner =
    `exec -a claude ${shellQuote(process.execPath)} ${shellQuote(script)} idle ` +
    `${shellQuote(seats)}/"$HERDR_PANE_ID".log`;
  return `bash -c ${shellQuote(inner)}`;
}

/** The team file the run drives: two fake seats, one coordinator and one worker (tested in CI,
 * where the real run cannot go, so a broken file is caught before it needs herdr). */
export function teamFile(launches: { coordinator: string; worker: string }): string {
  return `format: 1
project: ${PROJECT}
visibility: private
session: ${SESSION}
coordinator: fake-coordinator
operator: fake-coordinator

identity:
  signature:
    template: "Agent: {display} · {role}"

rules:
  - "Every seat here is scripts/fake-seat.ts: no model runs, and nothing reaches the network."

watch:
  interval: 1s
  idle_first: 0s
  idle_repeat: 1m
  team_idle: 0s
  nudge_wait: 1m
  unsent_after: 1m

machine:
  load_start: 60
  load_max: 60
  memory_start: 0%
  memory_min: 0%
  disk_min: 1MB
  swap_free_min: 1MB
  swap_growth_max: 1GB
  swap_growth_window: 1m

limits:
  seats: 4
  temporary: 2
  vendors: { anthropic: 4 }

workspace:
  mode: shared

seats:
  - role: operator
    name: fake-coordinator
    label: fake-coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${launches.coordinator}
  - role: implementer
    name: fake-work
    label: fake-work
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${launches.worker}
`;
}

/** Starts the session and its two declared seats, through the real `add`. */
async function startSeats(ctx: Context): Promise<boolean> {
  const step = ctx.checks.begin('setup: the session and its declared seats (the real `add`)');
  for (const name of ['fake-coordinator', 'fake-work']) {
    const io = ownerIo(ctx.project);
    const code = await runAdd([name, '--file', ctx.file], io, addSources(ctx));
    show(io);
    step.check(code === 0, `add ${name} exits 0 (it exited ${code})`);
    step.check(seatRecord(ctx, name)?.stage === 'ready', `${name} is recorded ready in ${STATE_FILE}`);
    step.check(logHas(ctx, `add [owner] ${name}: ready`), `the log holds: add [owner] ${name}: ready`);
  }
  const names = (agentList(SESSION) ?? []).map((agent) => agent.name);
  step.check(names.includes('fake-coordinator') && names.includes('fake-work'), 'herdr lists both seats under their names');
  return step.ok;
}

async function stepStatus(ctx: Context): Promise<boolean> {
  const step = ctx.checks.begin('1. status: the seats, and the watch that has not run yet');
  const io = ownerIo(ctx.project);
  const code = await runStatus(['--file', ctx.file], io, {
    ...statusReal,
    standing: standingSource(ctx.home),
  });
  show(io);
  step.check(code === 1, `status exits 1: one difference (it exited ${code})`);
  step.check(rowShown(io.out, 'fake-coordinator', 'idle', 'Claude Opus 5.5'), 'a row reads: fake-coordinator, idle, Claude Opus 5.5');
  step.check(rowShown(io.out, 'fake-work', 'idle', 'Claude Opus 5.5'), 'a row reads: fake-work, idle, Claude Opus 5.5');
  step.check(io.out.includes('difference: no watch has run for this session'), 'the difference is the missing watch');
  step.check(
    Object.keys(readState(ctx.dir).sessions[SESSION]?.seats ?? {}).length === 2,
    `the state records both seats, ready (${STATE_FILE})`,
  );
  return step.ok;
}

async function stepWatch(ctx: Context): Promise<boolean> {
  const step = ctx.checks.begin('2. watch: one pass, its reports, and the nudge');
  const io = ownerIo(ctx.project);
  const code = await runWatch(['--file', ctx.file], io, {
    ...realWatchSources,
    standing: standingSource(ctx.home),
    notify: () => {},
    // One pass, then the wait says stop: the watch takes its own state away in its `finally`.
    wait: async () => false,
  });
  show(io);
  step.check(code === 0, `watch exits 0 (it exited ${code})`);
  step.check(io.out.includes('fake-work has been idle since the watch started'), 'the report: the idle seat, named');
  step.check(io.out.includes('every agent is idle'), 'the report: every agent is idle');
  step.check(io.out.includes('nudged the operator:'), 'the nudge was typed');
  step.check(io.out.includes(`the watch of "${SESSION}" stopped`), 'the watch stopped and said so');
  step.check(logHas(ctx, 'watch [watch] every agent is idle'), 'the log holds the report: watch [watch] every agent is idle');
  step.check(logHas(ctx, 'watch [watch] nudged the operator:'), 'the log holds the nudge');
  step.check(readState(ctx.dir).sessions[SESSION]?.watch === undefined, 'the state holds no watch after it stopped');
  const operatorLog = seatLog(ctx, 'fake-coordinator');
  step.check(
    operatorLog !== null && receivedBytes(operatorLog).includes(`${NUDGE_TEXT}\r`),
    'the operator\'s pane received the nudge line and the Enter',
  );
  return step.ok;
}

async function stepAddTemporary(ctx: Context): Promise<boolean> {
  const step = ctx.checks.begin('3. add --temporary --like fake-work --until result:result.md');
  const io = ownerIo(ctx.project);
  const code = await runAdd(
    ['--temporary', '--like', 'fake-work', '--until', 'result:result.md', '--file', ctx.file],
    io,
    addSources(ctx),
  );
  show(io);
  step.check(code === 0, `add exits 0 (it exited ${code})`);
  const record = seatRecord(ctx, 'fake-work-tmp-1');
  step.check(record?.stage === 'ready', 'the state records fake-work-tmp-1 ready');
  step.check(
    record?.temporary?.like === 'fake-work' && record?.temporary?.until === 'result:result.md',
    'the state records it temporary, like fake-work, until result:result.md',
  );
  step.check(
    logHas(ctx, 'add [owner] fake-work-tmp-1: ready'),
    'the log holds: add [owner] fake-work-tmp-1: ready',
  );
  const agent = (agentList(SESSION) ?? []).find((candidate) => candidate.name === 'fake-work-tmp-1');
  step.check(agent !== undefined, 'herdr lists it under its name');
  step.check(
    agent !== undefined && readScreen('claude-code', paneRead(agent.pane, 12, SESSION) ?? undefined).kind === 'idle',
    'its pane draws the idle prompt',
  );
  step.check(
    (workspaceList(SESSION) ?? []).some((workspace) => workspace.label === 'fake-work-tmp-1'),
    'its workspace carries its name',
  );
  return step.ok;
}

async function stepRemove(ctx: Context): Promise<boolean> {
  const step = ctx.checks.begin('4. remove: the temporary seat');
  const log = seatLog(ctx, 'fake-work-tmp-1'); // Its pane, read before the record goes.
  const io = ownerIo(ctx.project);
  const code = await runRemove(['fake-work-tmp-1', '--file', ctx.file], io, removeReal);
  show(io);
  step.check(code === 0, `remove exits 0 (it exited ${code})`);
  step.check(io.out.includes('removed temporary fake-work-tmp-1'), 'remove says what it removed');
  step.check(logHas(ctx, 'remove [owner] removed temporary fake-work-tmp-1'), 'the log holds the removal');
  step.check(logHas(ctx, 'remove [owner] fake-work-tmp-1: stopped'), 'the log holds the seat leaving its pane');
  step.check(seatRecord(ctx, 'fake-work-tmp-1') === undefined, 'the state no longer records it');
  step.check(
    (agentList(SESSION) ?? []).every((agent) => agent.name !== 'fake-work-tmp-1'),
    'herdr no longer lists it',
  );
  step.check(
    log !== null && receivedBytes(log).endsWith('/exit\r'),
    'its pane received the exit line, then the Enter',
  );
  return step.ok;
}

async function stepDown(ctx: Context): Promise<boolean> {
  const step = ctx.checks.begin('5. down: both seats and the session');
  const log = seatLog(ctx, 'fake-work'); // Its pane, read before the record goes.
  const io = ownerIo(ctx.project);
  const code = await runDown(['--file', ctx.file], io, downReal);
  show(io);
  step.check(code === 0, `down exits 0 (it exited ${code})`);
  step.check(io.out.includes('fake-coordinator: stopped') && io.out.includes('fake-work: stopped'), 'both seats stopped');
  step.check(io.out.includes(`session ${SESSION}: stopped`), 'the session stopped');
  step.check(
    logHas(ctx, 'down [owner] fake-coordinator: stopped') && logHas(ctx, 'down [owner] fake-work: stopped'),
    'the log holds both seats stopping',
  );
  step.check(Object.keys(readState(ctx.dir).sessions[SESSION]?.seats ?? {}).length === 0, 'the state holds no seat after down');
  step.check(sessionState(SESSION) === 'stopped', 'herdr says the session is stopped, not deleted');
  step.check(log !== null && receivedBytes(log).endsWith('/exit\r'), 'that seat received the exit line, then the Enter');
  return step.ok;
}

/** Stops and deletes the scratch session, whatever happened. The only place that deletes one. */
function teardown(): void {
  const state = sessionState(SESSION);
  if (state !== 'running' && state !== 'stopped') return;
  const herdr = (args: string[]) => {
    try {
      execFileSync('herdr', args, { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // The session is named in the closing lines, so it can be cleared by hand.
    }
  };
  if (state === 'running') herdr(['session', 'stop', SESSION]);
  herdr(['session', 'delete', SESSION]);
}

/** The five commands, in order. Stops at the first step whose checks failed. */
async function runCommands(ctx: Context): Promise<void> {
  for (const step of [stepStatus, stepWatch, stepAddTemporary, stepRemove, stepDown]) {
    if (await step(ctx)) continue;
    ctx.checks.note('a step failed: the steps after it were skipped');
    return;
  }
}

async function main(): Promise<number> {
  console.log(`team e2e: the real commands against fake seats, in the session "${SESSION}"\n`);

  if (herdrVersion() === null) {
    console.error('team e2e: herdr is not on the PATH; this script needs a machine with herdr');
    return 2;
  }

  const first = readGate();
  console.log(`the machine: load ${first.load ?? '?'}, ${first.memoryFree === null ? '?' : Math.round(first.memoryFree)}% memory free, swap used ${first.swapUsed ?? '?'}`);
  console.log(`the gate: waiting ${GATE_WAIT_MS / 1000} s to see the swap hold still…`);
  await sleep(GATE_WAIT_MS);
  const second = readGate();
  const overGate = gateProblem(first, second);
  if (overGate !== null) {
    console.error(`team e2e: ${overGate}; nothing was run`);
    return 2;
  }
  console.log(`the gate: the swap used ${first.swapUsed} then ${second.swapUsed}: it holds\n`);

  const existing = sessionState(SESSION);
  if (existing !== 'absent') {
    console.error(
      `team e2e: session "${SESSION}" is ${existing}; clear it first:\n` +
        `  herdr session stop ${SESSION}\n  herdr session delete ${SESSION}`,
    );
    return 2;
  }

  const before = agentList();
  const names = (list: typeof before) => (list ?? []).map((agent) => agent.name ?? `${agent.agent ?? 'an agent'} (unnamed)`);
  console.log(`the default session: ${before === null ? 'unreadable' : `${before.length} agent(s)`}`);
  if (before?.length) console.log(`  --    ${names(before).join(', ')}`);

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-e2e-')));
  const project = join(base, PROJECT);
  const home = join(base, 'home');
  const dir = join(project, '.agents');
  mkdirSync(dir, { recursive: true });
  const seats = join(dir, 'seats');
  mkdirSync(seats);
  mkdirSync(home);
  const file = join(dir, 'team.yaml');

  const text = teamFile({ coordinator: fakeLaunch(seats), worker: fakeLaunch(seats) });
  const valid = validateTeamFile(text);
  if (!valid.ok) {
    console.error(`team e2e: its own team file is invalid: ${valid.errors.map((problem) => `line ${problem.line}: ${problem.message}`).join('; ')}`);
    return 2;
  }
  writeFileSync(file, text);
  console.log(`the project: ${project}  (the file, the state, the log, the fake seats' input logs)`);
  console.log(`the store:   ${home}  (the approval; the owner's home is never written)`);

  const checks = new Checks();
  const ctx: Context = { checks, project, dir, file, home };
  try {
    const approvals = checks.begin('setup: the file is approved (the real `approve`)');
    const io = ownerIo(project);
    const code = await runApprove(['--file', file], io, { ask: async () => '2', waiting: () => 'empty', now: () => new Date(), home });
    show(io, 2);
    approvals.check(code === 0, `approve exits 0 (it exited ${code})`);
    approvals.check(readApproval(storePath(PROJECT, project, home)) !== null, 'the store holds the approval');
    if (approvals.ok) {
      if (await startSeats(ctx)) await runCommands(ctx);
      else checks.note('a step failed: the five commands were skipped');
    } else {
      checks.note('a step failed: the five commands were skipped');
    }
  } catch (problem) {
    // A command that threw where this script did not expect it: the run is a failure, and the
    // lines below still say where the scratch is and what became of the session.
    checks.note(`the run threw: ${problem instanceof Error ? (problem.stack ?? problem.message) : String(problem)}`);
    checks.record(false, 'the run ran to its end without throwing');
  } finally {
    teardown();
  }

  const after = agentList();
  const step = checks.begin('the default session, again');
  step.check(
    before !== null && after !== null && before.length === after.length,
    `it holds ${before?.length ?? '?'} agent(s), and held that before the run (now ${after?.length ?? '?'})`,
  );
  if (after !== null && names(after).join(',') !== names(before).join(',')) {
    checks.note(`its agents now: ${names(after).join(', ')}`);
  }

  const { total, failed } = checks.summary();
  console.log(failed === 0 ? `\nall ${total} checks passed` : `\n${failed} of ${total} checks failed`);
  const left = sessionState(SESSION);
  console.log(
    left === 'absent'
      ? `the session "${SESSION}" is stopped and deleted`
      : `the session "${SESSION}" is still ${left}: clear it by hand`,
  );
  console.log(`the scratch is left at ${base}: remove it with \`trash ${base}\``);
  return failed === 0 && left === 'absent' ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
