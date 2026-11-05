// Independent scenes for B5b: the delivery class a send reports, the idleness gate in `next`,
// `plan` and the watch dispatch, the `up` warning for a lead nothing can wake, the pull seat's
// rules and the restart line, and a stale recorded socket that is never dialed.
//
// My own fixtures, assertions and scene names; the subjects are the command surfaces, never an
// import of the delivery-class module, so the file also loads at int/0.5.10 and every scene can
// be read there for its own red.
//
// Two scenes are the round-2 probes operator-2 found: a seat whose launch settings declare
// `crossSessionInbound: accept` but which holds no usable socket must not be read as wakeable
// (`next` never leases it a deadline record), and `up` must warn for a lead that can only be
// reached at its next turn, not only for a CLI whose profile declares nothing at all. Round 3
// added the operator-2 shape behind the shipped commands: with no source named, the default
// registry home is the machine's, and a socket seat must read wakeable there too — through the
// exported `next` and `plan` in a child process with that home, and through `handleNext` with
// the home its host names.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runNext } from '../src/commands/next.ts';
import { runPlan } from '../src/commands/plan.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { handleNext } from '../src/daemon/next.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { quietRulesDelivery, rulesFileHash, rulesLine } from '../src/launch/rules-file.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { NO_PANE_MESSAGING } from '../src/send/no-pane-messaging.ts';
import { readHistory } from '../src/send/history.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { dispatchIdleWork, forgetIdleEpisodes, type IdleDispatchInput, type WorkPush, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { idleClaimOf } from '../src/watch/claim.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { StandInStore, standInKeyText } from './workflow/reservation-stand-in-store.ts';
import type { ItemIdentity } from '../src/workflow/reservation/index.ts';

const WINDOW = '5.5';

// ── a send's class words ────────────────────────────────────────────────────────────────────

const PUSH_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';

function sendTeam(root: string, home: string): string {
  return `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${resolveLobby(home, { entity: 'floor' })}
  - ${root}
delivery_order: [typed]
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: push-seat
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${PUSH_LAUNCH}
  - role: implementer
    name: pull-seat
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: codex-seat
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
  - role: implementer
    name: codex-plain
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
  - role: implementer
    name: cursor-seat
    cli: cursor
    vendor: test
    model: Test
    version: "1"
    launch: cursor-agent
  - role: implementer
    name: none-seat
    cli: muse
    vendor: test
    model: Muse
    version: "1"
    launch: muse --yolo
  - role: implementer
    name: recorder
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

const SEND_NOW = new Date('2026-10-31T09:00:00.000Z');
const BINDING = 'prs_0123456789ab';

type SendWorld = { base: string; root: string; dir: string; sockets: string; home: string };

function sendWorld(order: readonly string[] = ['typed']): SendWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b5b-send-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(resolveLobby(home, { entity: 'floor' }), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), sendTeam(root, home).replace('delivery_order: [typed]', `delivery_order: [${order.join(', ')}]`));
  return { base, root, dir: join(root, '.agents'), sockets, home };
}

function sendHost(made: SendWorld, patch: Partial<SendHost> = {}): SendHost & { frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    agents: () => [],
    processInfo: () => null,
    socketsDir: made.sockets,
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} },
    now: () => SEND_NOW,
    home: made.home,
    ...patch,
  };
}

function recordSeat(made: SendWorld, seat: string, fields: Record<string, unknown>): void {
  updateState(made.dir, (state) => {
    (state.sessions.acme ??= emptySession()).seats[seat] = { stage: 'ready', pane: `fixture-pane-${seat}`, ...fields } as never;
  });
}

let made: SendWorld | null = null;
afterEach(() => {
  if (made !== null) rmSync(made.base, { recursive: true, force: true });
  made = null;
});

describe('the class a send reports for its target', () => {
  test('a seat whose launch carries the event adapter is not woken when only the drop leg runs', async () => {
    made = sendWorld();
    const host = sendHost(made);
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['push-seat', 'hello'], io, host);
    expect(code).toBe(0);
    expect(io.out).toContain('push-seat: queued, not woken (drop, 0 ms)');
    expect(io.out).not.toContain('woken through');
    expect(host.frames).toEqual([]);
  });

  test('a codex seat with a bound managed endpoint and its recorded conversation reads at its next turn when the drop takes the send', async () => {
    made = sendWorld();
    // The seat records a managed endpoint and the conversation its queue is addressed by, so the
    // class read before the walk is between-turns. This world's walk carries no native leg: the
    // drop takes the send, and the line must follow the leg actually taken.
    recordSeat(made, 'codex-seat', {
      id: 'seat_0123456789ab',
      cli: 'codex',
      watcher: 'inbox',
      agent_session: 'ses_thread',
      presence_binding: BINDING,
      codex_endpoint: {
        url: `unix://${join(made.base, 'codex.sock')}`,
        binding: BINDING,
        pid: 4321,
        started_at: '2026-10-01T00:00:00Z',
      },
    });
    registerAgent(made.home, {
      name: 'codex-seat',
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test-lab',
      cli: 'codex',
      launcher: null,
      launch: 'codex -m test',
      reach: {
        team: teamIdOf(made.root), seat: 'codex-seat', session: 'acme',
        pane: 'fixture-pane-codex-seat', address: null, agent_session: 'ses_thread',
      },
      seat_handle: 'seat_0123456789ab',
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['codex-seat', 'hello'], io, sendHost(made));
    expect(code).toBe(0);
    // Codex declares the typed wake. This fixture names no live agent, so the wake did not run,
    // and the walk never reached the runtime queue the seat records: the drop took the send.
    // The line says both — the wake that did not run, then the next turn — never a queue nothing addressed.
    expect(io.out).toContain('codex-seat: queued, not woken (drop, 0 ms); queued; the typed wake did not run (no live agent carries that name in the session); codex-seat reads it at its next turn, and nothing here gives it one (pull-only)');
  });

  test('a codex seat whose endpoint names no conversation is read at its next turn, and the line says so', async () => {
    made = sendWorld();
    recordSeat(made, 'codex-seat', {
      cli: 'codex',
      watcher: 'inbox',
      presence_binding: BINDING,
      codex_endpoint: {
        url: `unix://${join(made.base, 'codex.sock')}`,
        binding: BINDING,
        pid: 4321,
        started_at: '2026-10-01T00:00:00Z',
      },
    });
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['codex-seat', 'hello'], io, sendHost(made));
    expect(code).toBe(0);
    // The endpoint binds no conversation, and no live agent carries the seat, so the typed wake
    // Codex declares did not run. The line stays the next turn.
    expect(io.out).toContain('codex-seat: queued, not woken (drop, 0 ms); queued; the typed wake did not run (no live agent carries that name in the session); codex-seat reads it at its next turn, and nothing here gives it one (pull-only)');
  });

  test('a codex seat with no managed endpoint has only its next turn, and the line says so', async () => {
    made = sendWorld();
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['codex-plain', 'hello'], io, sendHost(made));
    expect(code).toBe(0);
    // No managed endpoint and no live agent: the typed wake Codex declares did not run, and the
    // line names the next turn as the only read.
    expect(io.out).toContain('codex-plain: queued, not woken (drop, 0 ms); queued; the typed wake did not run (no live agent carries that name in the session); codex-plain reads it at its next turn, and nothing here gives it one (pull-only)');
  });

  test('an MCP-inbox seat is pull-only in its profile, and the line says so', async () => {
    made = sendWorld();
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['cursor-seat', 'hello'], io, sendHost(made));
    expect(code).toBe(0);
    // Cursor declares the typed wake, so the class's own sentence is preceded by what this run's
    // wake did: no live agent carried the seat's name, so nothing was typed.
    expect(io.out).toContain('cursor-seat: queued, not woken (drop, 0 ms); queued; the typed wake did not run (no live agent carries that name in the session); cursor-seat reads it at its next turn, and nothing here gives it one (pull-only)');
  });

  test('a seat with no adapter is only read at its next turn, and the line says so', async () => {
    made = sendWorld();
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['pull-seat', 'hello'], io, sendHost(made));
    expect(code).toBe(0);
    expect(io.out).toContain('pull-seat: queued, not woken (drop, 0 ms); queued; pull-seat reads it at its next turn, and nothing here gives it one (pull-only)');
  });

  test('a seat with no event adapter is read at its next turn, and the line says so', async () => {
    // The Muse seat declares a typed wake and no event adapter: this send ends in the bus inbox
    // because nothing woke the pane, so the line names the one route it has and says this run
    // never reached it, never a turn it cannot take.
    made = sendWorld();
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runSend(['none-seat', 'hello'], io, sendHost(made));
    console.log(`A4 code=${code} out=${JSON.stringify(io.out)} err=${JSON.stringify(io.err)}`);
    expect(code).toBe(0);
    expect(io.out).toContain('none-seat: queued, not woken (drop, 0 ms); queued; the typed wake did not run (no live agent carries that name in the session); nothing wakes none-seat while it is idle except a send-time typed wake and the watch\'s typed retry once a message passes its unread window, into an empty composer; a person or a restart must give it a turn');
  });
});

// ── the reservation take and the plan ──────────────────────────────────────────────────────

const NEXT_TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WINDOW}"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WINDOW}"
    launch: claude --model claude-opus-5-5
`;

const TIMED = '- id: m1\n  title: one\n  deadline: 2026-12-31T00:00:00Z\n- id: m2\n  title: two\n';
const NEXT_NOW = Date.parse('2026-10-31T09:00:00.000Z');
const CTX = 'team acme, session "acme"\n';

let base: string | null = null;
let root = '';
let home = '';

function nextWorld(): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'b5b-next-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), NEXT_TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), TIMED);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'fixture-pane-lead' };
    session.seats.worker = { stage: 'ready', pane: 'fixture-pane-worker' };
  });
}

afterEach(() => {
  if (base !== null) rmSync(base, { recursive: true, force: true });
  base = null;
});

function callerOf(seat: string): Extract<Caller, { kind: 'seat' }> {
  const record = readState(join(root, '.agents')).sessions.acme?.seats[seat];
  if (record?.pane === undefined) throw new Error(`the fixture records no pane for seat ${seat}`);
  return { kind: 'seat', name: seat, pane: record.pane, session: 'acme' };
}

function item(id: string): ItemIdentity {
  return { source: 'file', project: 'acme', team: 'acme', id };
}

function holdOf(store: StandInStore, id: string) {
  const key = standInKeyText(item(id));
  if (key === null) throw new Error('the fixture item is unkeyable');
  return store.index.get(key)?.hold;
}

function leased(id: string): boolean {
  return existsSync(join(root, '.agents', 'leases', `${id}.json`));
}

async function next(store: StandInStore, at = NEXT_NOW): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, callerOf('worker'));
  const code = await runNext([], io, { home, now: () => at, reservations: store });
  return { code, out: io.out, err: io.err };
}

describe('a reservation take refuses time-bound work to a seat nothing can wake', () => {
  test('a pull seat takes the ordinary record, and the deadline record is never offered', async () => {
    nextWorld();
    const store = new StandInStore();
    const answer = await next(store);
    expect(answer).toEqual({ code: 0, out: `${CTX}m2  two\nteam next: claimed m2\n`, err: '' });
    expect(leased('m2')).toBe(true);
    expect(leased('m1')).toBe(false);
    expect(holdOf(store, 'm1')).toBeUndefined();
  });

  test('a push seat is handed the deadline record, hold first', async () => {
    nextWorld();
    updateState(join(root, '.agents'), (state) => {
      const seats = state.sessions.acme!.seats;
      seats.worker = { ...seats.worker!, cli: 'claude-code', launch_line: PUSH_LAUNCH };
    });
    const store = new StandInStore();
    const answer = await next(store);
    console.log(`B push ${JSON.stringify(answer)}`);
    expect(answer.out).toBe(`${CTX}m1  one\n  deadline: 2026-12-31T00:00:00Z\nteam next: claimed m1\n`);
    expect(holdOf(store, 'm1')).toMatchObject({ kind: 'next-claim', seat: 'worker' });
    expect(holdOf(store, 'm2')).toBeUndefined();
  });

  test('probe: an accept setting with no usable socket is not a way to wake the seat', async () => {
    // operator-2: the class reader trusted the declaration alone, so the time-bound record was
    // leased to a seat its own socket could never reach.
    nextWorld();
    updateState(join(root, '.agents'), (state) => {
      const seats = state.sessions.acme!.seats;
      seats.worker = { ...seats.worker!, cli: 'claude-code', launch_line: 'claude --model claude-opus-5-5', watcher: 'hook' };
    });
    const settings = cliHookSettingsPath(join(root, '.agents'), 'acme', 'worker');
    if (settings === null) throw new Error('the fixture declares no settings path');
    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
    // No socket file, no registry address, no live process: the declaration has nothing behind it.
    const store = new StandInStore();
    const answer = await next(store);
    console.log(`P1 next ${JSON.stringify(answer)} hold-m1=${JSON.stringify(holdOf(store, 'm1'))} leased-m1=${leased('m1')}`);
    expect(answer).toEqual({ code: 0, out: `${CTX}m2  two\nteam next: claimed m2\n`, err: '' });
    expect(holdOf(store, 'm1')).toBeUndefined();
    expect(leased('m1')).toBe(false);
  });

  test('the plan marks the deadline row of a pull seat and leaves the ordinary row alone', async () => {
    nextWorld();
    const io = testIo(root, callerOf('worker'));
    const code = await runPlan([], io, { home, now: () => NEXT_NOW });
    console.log(`B plan ${JSON.stringify({ code, out: io.out })}`);
    expect(code).toBe(0);
    expect(io.out).toContain('  1     open   -      one (its seat cannot be woken while idle)\n');
    expect(io.out).toContain('  2     open   -      two\n');
    expect(io.out).not.toContain('two (its seat cannot be woken while idle)');
  });
});

// ── the shipped command's own sources ─────────────────────────────────────────────────────
//
// operator-2, round 3: the production commands never name the registry home, so in a real run
// the delivery-class reader proves no recorded socket address and a socket seat always reads
// pull-on-turn — the deadline record is never offered to a seat the socket could wake.
//
// The default home is `homedir()`, and Bun fixes that at process start: setting
// `process.env.HOME` mid-run does not move it (measured with a fresh `bun -e` — the first call
// with `process.env.HOME` already rewritten still read the login home, while the same value in
// the child's own environment read the synthetic home). So these scenes run the exported
// command with its default sources in a child process started with the synthetic HOME, the way
// the shipped CLI runs: no source, no clock, no reservation store.

/** A worker whose launch installed the socket route: the generated settings accept, the address
 *  the registry records is there, and no watcher claims anything else. */
function socketCommandWorld(): void {
  nextWorld();
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme!.seats.worker = {
      ...state.sessions.acme!.seats.worker!,
      cli: 'claude-code',
      launch_line: 'claude --model claude-opus-5-5',
      watcher: 'hook',
    };
  });
  const settings = cliHookSettingsPath(join(root, '.agents'), 'acme', 'worker');
  if (settings === null) throw new Error('the fixture declares no settings path');
  mkdirSync(join(settings, '..'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  // The socket is created after the declaration, so it is never older than the settings that
  // admit it: `inboundIsLive` reads a socket older than its file as a seat not yet restarted.
  const socket = join(base!, 'worker.sock');
  writeFileSync(socket, '');
  registerAgent(home, {
    name: 'worker',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: 'worker', session: 'acme', pane: 'fixture-pane-worker', address: socket },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

const SRC_DIR = join(import.meta.dir, '..', 'src');

/** The child runs the two exported commands with no sources at all, over its own io. */
const DEFAULT_SOURCES_RUNNER = `const { runNext } = await import(${JSON.stringify(pathToFileURL(join(SRC_DIR, 'commands', 'next.ts')).href)});
const { runPlan } = await import(${JSON.stringify(pathToFileURL(join(SRC_DIR, 'commands', 'plan.ts')).href)});
const [root, seat, pane] = process.argv.slice(2);
function ioOf() {
  const io = {
    out: '',
    err: '',
    stdout(text) { io.out += text; },
    stderr(text) { io.err += text; },
    cwd: root,
    env: { HOME: process.env.HOME },
    stdinIsTTY: false,
    caller: { kind: 'seat', name: seat, pane, session: 'acme' },
  };
  return io;
}
const planned = ioOf();
const planCode = await runPlan([], planned);
const taken = ioOf();
const nextCode = await runNext([], taken);
process.stdout.write(JSON.stringify({
  plan: { code: planCode, out: planned.out, err: planned.err },
  next: { code: nextCode, out: taken.out, err: taken.err },
}));
`;

type DefaultSourcesRun = {
  plan: { code: number; out: string; err: string };
  next: { code: number; out: string; err: string };
};

function runDefaultSources(): DefaultSourcesRun {
  const script = join(base!, 'default-sources.ts');
  writeFileSync(script, DEFAULT_SOURCES_RUNNER);
  const printed = execFileSync(process.execPath, [script, root, 'worker', 'fixture-pane-worker'], {
    cwd: root,
    env: { HOME: home, PATH: process.env.PATH ?? '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    encoding: 'utf8',
  });
  return JSON.parse(printed) as DefaultSourcesRun;
}

describe("the shipped command's default sources name the registry home", () => {
  test('next hands a socket seat the deadline record, as a real run now can', () => {
    socketCommandWorld();
    const run = runDefaultSources();
    console.log(`R3 next code=${run.next.code} out=${JSON.stringify(run.next.out)} err=${JSON.stringify(run.next.err)}`);
    expect(run.next.code).toBe(0);
    expect(run.next.out).toBe(`${CTX}m1  one\n  deadline: 2026-12-31T00:00:00Z\nteam next: claimed m1\n`);
    expect(leased('m1')).toBe(true);
    expect(leased('m2')).toBe(false);
  });

  test("plan leaves a socket seat's deadline row unmarked, as a real run now can", () => {
    socketCommandWorld();
    const run = runDefaultSources();
    console.log(`R3 plan code=${run.plan.code} out=${JSON.stringify(run.plan.out)} err=${JSON.stringify(run.plan.err)}`);
    expect(run.plan.code).toBe(0);
    expect(run.plan.out).toContain('  1     open   -      one\n');
    expect(run.plan.out).not.toContain('one (its seat cannot be woken while idle)');
  });

  test('control: the same world hands over the deadline record once the home is named', async () => {
    // The world itself is sound — settings accept, a live recorded address — so the default
    // sources are the only difference the grown-up scenes have to prove.
    socketCommandWorld();
    const io = testIo(root, callerOf('worker'));
    const code = await runNext([], io, { home, now: () => NEXT_NOW });
    console.log(`R3 control code=${code} out=${JSON.stringify(io.out)} err=${JSON.stringify(io.err)}`);
    expect(code).toBe(0);
    expect(io.out).toBe(`${CTX}m1  one\n  deadline: 2026-12-31T00:00:00Z\nteam next: claimed m1\n`);
    expect(leased('m1')).toBe(true);
  });

  test('guard: the default sources still refuse the deadline record with no recorded address', () => {
    // The twin with the registry record left out: naming the home must not make every accept
    // setting a socket. The seat stays pull-on-turn and m1 stays unoffered.
    socketCommandWorld();
    rmSync(join(home, '.config', 'team', 'agents'), { recursive: true, force: true });
    const run = runDefaultSources();
    console.log(`R3 guard plan=${JSON.stringify(run.plan.out)} next=${JSON.stringify(run.next.out)}`);
    expect(run.next.code).toBe(0);
    expect(run.next.out).toBe(`${CTX}m2  two\nteam next: claimed m2\n`);
    expect(leased('m1')).toBe(false);
    expect(run.plan.out).toContain('  1     open   -      one (its seat cannot be woken while idle)\n');
  });
});

// ── the hosted next handler ───────────────────────────────────────────────────────────────
//
// The daemon host threads the registry home its route's team was read in into the handler; a
// request that names none keeps the conservative reading — no record, no socket evidence.

function hostedRoute(): { team: TeamFile; route: ReturnType<typeof routeOf> } {
  const checked = validateTeamFile(NEXT_TEAM);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const team = checked.team;
  return { team, route: routeOf(realpathSync(root), team.project, team.session, team.seats.map((seat) => seat.name)) };
}

describe('the hosted next handler reads the home its route was read in', () => {
  test('a socket seat is handed the deadline record through handleNext', async () => {
    socketCommandWorld();
    const { team, route } = hostedRoute();
    const answer = await handleNext({
      route,
      team,
      caller: { seat: 'worker', pane: 'fixture-pane-worker' },
      action: 'claim',
      mine: false,
      now: NEXT_NOW,
      home,
    });
    console.log(`R3 handleNext ${JSON.stringify(answer)} leased-m1=${leased('m1')}`);
    expect(answer.ok).toBe(true);
    if (!answer.ok || answer.kind !== 'claimed') throw new Error('the handler did not claim');
    expect(answer.record.id).toBe('m1');
    expect(leased('m1')).toBe(true);
    expect(leased('m2')).toBe(false);
  });

  test('guard: a handler told no home keeps the conservative reading', async () => {
    socketCommandWorld();
    const { team, route } = hostedRoute();
    const answer = await handleNext({
      route,
      team,
      caller: { seat: 'worker', pane: 'fixture-pane-worker' },
      action: 'claim',
      mine: false,
      now: NEXT_NOW,
    });
    console.log(`R3 handleNext no-home ${JSON.stringify(answer)}`);
    expect(answer.ok).toBe(true);
    if (!answer.ok || answer.kind !== 'claimed') throw new Error('the handler did not claim');
    expect(answer.record.id).toBe('m2');
    expect(leased('m1')).toBe(false);
  });
});

// ── the watch's dispatch ───────────────────────────────────────────────────────────────────

const MIN = 60_000;
const WATCH_NOW = Date.parse('2026-10-31T04:00:00.000Z');

function watchTeam(worker1Launch: string, worker2Launch: string): string {
  return `format: 1
project: acme
session: crew
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WINDOW}"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WINDOW}"
    launch: ${worker1Launch}
  - role: worker
    name: worker-2
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WINDOW}"
    launch: ${worker2Launch}
`;
}

let watchBase: string | null = null;
let watchRoot = '';
let watchHome = '';

function watchWorld(worker1Launch: string, worker2Launch: string): TeamFile {
  watchBase = realpathSync(mkdtempSync(join(tmpdir(), 'b5b-watch-')));
  watchRoot = join(watchBase, 'crew');
  watchHome = join(watchBase, 'home');
  mkdirSync(join(watchRoot, '.agents'), { recursive: true });
  mkdirSync(watchHome);
  const result = validateTeamFile(watchTeam(worker1Launch, worker2Launch));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  writeFileSync(join(watchRoot, '.agents', 'queue.yaml'), '- id: t1\n  title: "First"\n');
  writeFileSync(join(watchRoot, '.agents', 'team.state.json'), JSON.stringify({
    format: 1,
    sessions: {
      crew: {
        seats: {
          'worker-1': { stage: 'ready', last_active: new Date(WATCH_NOW - 10 * MIN).toISOString() },
          'worker-2': { stage: 'ready', last_active: new Date(WATCH_NOW - 10 * MIN).toISOString() },
        },
        worktrees: {},
      },
    },
  }));
  return result.team;
}

afterEach(() => {
  forgetIdleEpisodes();
  if (watchBase !== null) rmSync(watchBase, { recursive: true, force: true });
  watchBase = null;
});

function dispatchInput(team: TeamFile, push: WorkPush): IdleDispatchInput {
  const state = readState(join(watchRoot, '.agents')).sessions.crew ?? emptySession();
  return {
    root: watchRoot,
    dir: join(watchRoot, '.agents'),
    team,
    state,
    live: {
      running: true,
      agents: [
        { name: 'worker-1', agent: 'claude', pane: 'fixture-pane-a', workspace: 'first', status: 'idle', cwd: null },
        { name: 'worker-2', agent: 'claude', pane: 'fixture-pane-b', workspace: 'second', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'first', label: 'worker-1' }, { id: 'second', label: 'worker-2' }],
      screens: { 'fixture-pane-a': CLAUDE_IDLE, 'fixture-pane-b': CLAUDE_IDLE },
    },
    now: new Date(WATCH_NOW),
    home: watchHome,
    body: (seat) => `body for ${seat}`,
    push,
  };
}

describe("the watch spends no attempt on a seat it cannot wake", () => {
  test('a pull crew is suppressed whole: no push and no idle claim', async () => {
    const team = watchWorld('claude', 'claude');
    const calls: WorkPushRequest[] = [];
    const result = await dispatchIdleWork(dispatchInput(team, async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'delivered' };
    }));
    expect(calls).toEqual([]);
    expect(result.pushed).toEqual([]);
    expect(result.suppressed?.sort()).toEqual(['worker-1', 'worker-2']);
    const state = readState(join(watchRoot, '.agents')).sessions.crew ?? emptySession();
    expect(idleClaimOf(state, 'worker-1')).toBeUndefined();
    expect(idleClaimOf(state, 'worker-2')).toBeUndefined();
  });

  test('the push seat beside it is still woken, and only it keeps a claim', async () => {
    const team = watchWorld(PUSH_LAUNCH, 'claude');
    const calls: WorkPushRequest[] = [];
    const result = await dispatchIdleWork(dispatchInput(team, async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'delivered' };
    }));
    expect(calls.map((one) => one.seat)).toEqual(['worker-1']);
    expect(result.pushed).toEqual([{ seat: 'worker-1', ok: true, outcome: 'delivered' }]);
    expect(result.suppressed?.sort()).toEqual(['worker-1', 'worker-2']);
    const state = readState(join(watchRoot, '.agents')).sessions.crew ?? emptySession();
    expect(idleClaimOf(state, 'worker-1')).toBeDefined();
    expect(idleClaimOf(state, 'worker-2')).toBeUndefined();
  });
});

// ── the up warning ─────────────────────────────────────────────────────────────────────────

const UP_NOW = new Date('2026-10-31T03:15:00Z');

let upBase: string | null = null;
let upRoot = '';
let upHome = '';
let upDir = '';

afterEach(() => {
  if (upBase !== null) rmSync(upBase, { recursive: true, force: true });
  upBase = null;
});

function upTeam(leadCli: string, leadLaunch: string, reviewer: { cli: string; launch: string } | null = null): string {
  const checker = reviewer === null ? '' : `  - role: reviewer
    name: checker
    cli: ${reviewer.cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${reviewer.launch}
`;
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(upHome)}
  - ${upRoot}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: ${leadCli}
    vendor: test
    model: Test
    version: "1"
    launch: ${leadLaunch}
${checker}`;
}

/** The scratch project, its git history and the lobby folder the team file trusts. */
function upDirs(): void {
  upBase = realpathSync(mkdtempSync(join(tmpdir(), 'b5b-up-')));
  upRoot = join(upBase, 'acme');
  upHome = join(upBase, 'home');
  upDir = join(upRoot, '.agents');
  mkdirSync(upDir, { recursive: true });
  mkdirSync(upHome);
  mkdirSync(lobbyDir(upHome), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: upRoot, stdio: 'ignore', env: gitEnv() });
  writeFileSync(join(upRoot, 'README.md'), 'acme\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { cwd: upRoot, env: gitEnv() });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], { cwd: upRoot, env: gitEnv() });
}

/** The team file and the approval the owner's `team approve` leaves for exactly this text. */
function upApprove(text: string): void {
  writeFileSync(join(upDir, 'team.yaml'), text);
  const loaded = loadTeamFile(upRoot, { file: join(upDir, 'team.yaml'), home: upHome });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, upHome),
    { approval: approvalOf(loaded.team, loaded.root, UP_NOW), file: text },
    loaded.team.seats,
    upHome,
  );
}

async function upDry(leadCli: string, leadLaunch: string, reviewer: { cli: string; launch: string } | null = null): Promise<string> {
  upDirs();
  upApprove(upTeam(leadCli, leadLaunch, reviewer));
  const sources: UpSources = { sessionRunning: () => true, agents: () => [], home: upHome, now: () => UP_NOW };
  const io = testIo(upRoot, { kind: 'owner' });
  const code = await runUp(['--dry-run'], io, sources);
  console.log(`D up code=${code} out=${JSON.stringify(io.out.slice(0, 400))}`);
  expect(code).toBe(0);
  return io.out;
}

describe('up warns about the lead it can never hand time-bound work to', () => {
  test('a lead whose CLI declares no route at all is warned about', async () => {
    const out = await upDry('jules', 'jules');
    expect(out).toContain('! lead is a lead seat and jules cannot be woken while it is idle; time-bound work is never dispatched to it\n');
  });

  test('probe: a lead launched pull-only is warned about, not only a declared-none CLI', async () => {
    // operator-2: up read the profile's declaration alone, so a Claude lead without the event
    // adapter — a seat that is pull-on-turn in fact — started without a word.
    const out = await upDry('claude-code', 'claude --model claude-opus-5-5');
    expect(out).toContain('! lead is a lead seat and claude-code cannot be woken while it is idle; time-bound work is never dispatched to it\n');
  });

  test('probe: a reviewer launched pull-only is warned about too', async () => {
    const out = await upDry('claude-code', PUSH_LAUNCH, { cli: 'cursor', launch: 'cursor-agent' });
    expect(out).toContain('! checker is a reviewer seat and cursor cannot be woken while it is idle; time-bound work is never dispatched to it\n');
    expect(out).not.toContain('! lead is a lead seat');
  });

  test('control: a lead the event adapter wakes is not warned about', async () => {
    const out = await upDry('claude-code', PUSH_LAUNCH);
    expect(out).not.toContain('cannot be woken while it is idle');
  });
});

// ── a pull seat's rules and the restart line ───────────────────────────────────────────────

const PULL_RULES = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WINDOW}"
    launch: claude
  - role: implementer
    name: reader
    cli: codex
    vendor: openai
    model: GPT
    version: "6.1"
    launch: codex
`;

const INBOX_SENTENCE = '- If your tools include `inbox_check`, call it at the start and the end of every turn and `inbox_read` for each message it lists, and act on what you read.';
const RESTART_NOTE = 'TeamCLI restart: read your inbox, act on what is addressed to you, and do not continue any earlier work unless a message asks for it.';

describe('the rules a pull seat reads', () => {
  test('the inbox sentence is on the codex seat’s rules once, and on no other seat’s', () => {
    const result = validateTeamFile(PULL_RULES);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const reader = result.team.seats.find((seat) => seat.name === 'reader');
    const lead = result.team.seats.find((seat) => seat.name === 'lead');
    if (reader === undefined || lead === undefined) throw new Error('the fixture seats are missing');
    const text = rulesOf(result.team, reader, '/nowhere', null);
    const lines = text.split('\n');
    expect(lines.filter((line) => line === INBOX_SENTENCE)).toHaveLength(1);
    expect(lines.findIndex((line) => line === INBOX_SENTENCE)).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith('- Never stop at a question:')),
    );
    expect(rulesOf(result.team, lead, '/nowhere', null)).not.toContain('inbox_check');
  });

  test('a quiet start reads the inbox and changes nothing earlier, and the typed line hashes that text', () => {
    const file = { text: 'Rules for this session, from the team file:\n\n- one\n', path: '/nowhere/rules/reader.md', line: 'stale' };
    const delivered = quietRulesDelivery(file);
    expect(delivered.text).toBe(`Rules for this session, from the team file:\n\n- one\n\n${RESTART_NOTE}\n`);
    expect(delivered.line).toBe(rulesLine(file.path, createHash('sha256').update(delivered.text).digest('hex').slice(0, 12)));
    expect(delivered.line).toBe(rulesFileHashLine(delivered.text, file.path));
  });
});

function rulesFileHashLine(text: string, path: string): string {
  return rulesLine(path, rulesFileHash(text));
}

// ── a stale recorded socket ────────────────────────────────────────────────────────────────

describe('a recorded socket that is gone is reported, never dialed', () => {
  test('the send falls back to the drop under the seat’s real class, and opens no socket', async () => {
    made = sendWorld(['socket', 'typed']);
    const world = made;
    const settings = cliHookSettingsPath(world.dir, 'acme', 'recorder');
    if (settings === null) throw new Error('the fixture declares no settings path');
    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
    const gone = join(world.sockets, '424242.sock');
    const id = teamIdOf(world.root);
    const record = registerAgent(world.home, {
      name: 'recorder',
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test-lab',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: id, seat: 'recorder', session: 'acme', pane: 'fixture-pane-recorder', address: gone },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
    upsertTeam(world.home, id, {
      project: 'acme',
      entity: 'floor',
      session: 'acme',
      root: world.root,
      lobby: resolveLobby(world.home, { entity: 'floor' }),
      roster: [{ agent: record.id, seat: 'recorder', role: 'implementer', leads: false }],
      lifecycle: 'running',
    });
    let dialed = 0;
    const io = testIo(world.root, { kind: 'owner' });
    const host = sendHost(world, {
      agents: () => [{ name: 'recorder', pane: 'fixture-pane-recorder' }],
      deliver: async () => {
        dialed += 1;
        return { ok: true };
      },
    });
    const code = await runSend(['recorder', 'hello'], io, host);
    console.log(`F send code=${code} out=${JSON.stringify(io.out)} err=${JSON.stringify(io.err)} address=${JSON.stringify(record.reach.address)} gone-exists=${existsSync(gone)} frames=${host.frames.length}`);
    expect(code).toBe(0);
    expect(dialed).toBe(0);
    expect(host.frames).toEqual([]);
    expect(existsSync(gone)).toBe(false);
    const history = readHistory('acme', world.root, world.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.at(-1)?.failed).toEqual([
      `typed: ${NO_PANE_MESSAGING}`,
      `socket: the socket recorded for recorder (${gone}) is gone; queued; recorder reads it at its next turn, and nothing here gives it one (pull-only)`,
    ]);
    const drops = join(world.dir, 'send-drops', 'acme', 'recorder');
    expect(readdirSync(drops).filter((name) => !name.includes('.')).length).toBe(1);
  });

  test('a stale socket on a seat whose launch carries the event adapter is not called a wake', async () => {
    made = sendWorld(['socket', 'typed']);
    const world = made;
    const settings = cliHookSettingsPath(world.dir, 'acme', 'push-seat');
    if (settings === null) throw new Error('the fixture declares no settings path');
    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
    const gone = join(world.sockets, '424242.sock');
    const id = teamIdOf(world.root);
    const record = registerAgent(world.home, {
      name: 'push-seat',
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test-lab',
      cli: 'claude-code',
      launcher: null,
      launch: PUSH_LAUNCH,
      reach: { team: id, seat: 'push-seat', session: 'acme', pane: 'fixture-pane-push-seat', address: gone },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
    upsertTeam(world.home, id, {
      project: 'acme',
      entity: 'floor',
      session: 'acme',
      root: world.root,
      lobby: resolveLobby(world.home, { entity: 'floor' }),
      roster: [{ agent: record.id, seat: 'push-seat', role: 'implementer', leads: false }],
      lifecycle: 'running',
    });
    recordSeat(world, 'push-seat', { cli: 'claude-code', launch_line: PUSH_LAUNCH });
    let dialed = 0;
    const io = testIo(world.root, { kind: 'owner' });
    const host = sendHost(world, {
      agents: () => [{ name: 'push-seat', pane: 'fixture-pane-push-seat' }],
      deliver: async () => {
        dialed += 1;
        return { ok: true };
      },
    });
    const code = await runSend(['push-seat', 'hello', '--json'], io, host);
    expect(code).toBe(0);
    expect(dialed).toBe(0);
    expect(host.frames).toEqual([]);
    const doc = assertMatchesOutputSchema<{ delivery?: { leg: string; reason?: string }[] }>(io.out, SEND_OUTPUT_SCHEMA);
    const reported = doc.delivery?.find((entry) => entry.leg === 'socket');
    expect(reported?.reason).toContain('is gone');
    expect(reported?.reason).not.toContain('woken through');
    const history = readHistory('acme', world.root, world.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const failed = history.entries.at(-1)?.failed ?? [];
    const socketLine = failed.find((line) => line.startsWith('socket:'));
    expect(socketLine).toBeDefined();
    expect(socketLine).toContain('is gone');
    expect(socketLine).not.toContain('woken through');
    expect(failed.join('\n')).not.toContain('woken through');
  });
});
