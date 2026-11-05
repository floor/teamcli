// Independent scenes for the delivery-class lane (0.6, fix/delivery-class-socket-proof), written
// from the lane brief and the source, never from the builder's own tests.
//
// A seat whose box held the last socket frame is pull-on-turn until the declaration it was held
// under is re-confirmed. It still takes a record with no deadline at its next turn, but
// time-bound work is never dispatched to it: `team next` and the daemon both read the class
// before they order the queue, so a deadline record is not offered, and `team plan` says why
// beside the title. Neither CLI `next` nor `plan` reads the pane's processes, so both keep the
// conservative rule — a recorded address that still exists counts as a socket, and the hold is
// what takes it away. The daemon host does read the pane, so there its class counts only a
// socket the pane still owns; a pane the host could not answer for keeps the conservative rule.
// Every scene where the behaviour is new is red at 595284e54; the two controls that pin the
// conservative rule are green at both heads.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runNext } from '../src/commands/next.ts';
import { runPlan } from '../src/commands/plan.ts';
import { handleNext, type NextClaim } from '../src/daemon/next.ts';
import { routeOf } from '../src/daemon/routes.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { PaneProcesses } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const LAUNCH = 'claude --model claude-opus-5-5';

const TEAM = `format: 1
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
    version: "5.5"
    launch: ${LAUNCH}
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${LAUNCH}
`;

const PANE_LEAD = 'fixture-pane-lead';
const PANE_WORKER = 'fixture-pane-worker';
/** Pids no real session holds: the recorded socket's own pid and one the pane never runs. */
const SHELL_PID = 9_910_101;
const SOCKET_PID = 9_910_102;
const OTHER_PID = 9_910_103;

const lead: Caller = { kind: 'seat', name: 'lead', pane: PANE_LEAD, session: 'acme' };
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const DEADLINE = '2026-10-20T12:00:00.000Z';
const CTX = 'team acme, session "acme"\n';

let base: string;
let root: string;
let home: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

/** The checkout, its team file and the state that records both seats on their panes. */
function project(): TeamFile {
  if (base) rmSync(base, { recursive: true, force: true });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delivery-held-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: PANE_LEAD };
    session.seats.worker = { stage: 'ready', pane: PANE_WORKER };
  });
  const checked = validateTeamFile(TEAM);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  return checked.team;
}

function writeQueue(text: string): void {
  writeFileSync(join(root, '.agents', 'queue.yaml'), text);
}

function deadlineQueue(): string {
  return `- id: d1\n  title: the deadline task\n  deadline: ${DEADLINE}\n`;
}

function leaseNames(): string[] {
  const dir = join(root, '.agents', 'leases');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

/** The generated hook settings file a TeamCLI launch leaves, backdated so a socket written after
 *  it is the newer of the two and reads live. */
function declare(seat: string, secondsAgo = 120): string {
  const path = cliHookSettingsPath(join(root, '.agents'), 'acme', seat);
  if (path === null) throw new Error(`the fixture session has no generated settings path`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '{"crossSessionInbound":"accept"}\n');
  const past = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, past, past);
  return path;
}

/** A socket file named after the pid that carries it, written now, so it reads live. */
function socketFor(pid: number): string {
  const path = join(base, 'sock', `${pid}.sock`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

/** The registry record a launch leaves: the address its pane was measured to carry. */
function record(seat: string, pane: string, address: string | null, session = 'acme'): void {
  registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(root), seat, session, pane, address },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

/** The mark the box leaves when it held a socket frame: the declaration in force at that moment. */
function holdFrame(seat: string): void {
  const dir = join(root, '.agents');
  const declaration = declaredInboundOf({ dir, root, session: 'acme', seat, launch: LAUNCH });
  recordHeldSocket(heldSocketPath(dir, 'acme', seat), declaration, new Date(NOW - 60_000));
}

/** A lead seat whose generated settings declare accept and whose registry record names a live
 *  socket in its pane. */
function socketSeat(): string {
  declare('lead');
  const socket = socketFor(SOCKET_PID);
  record('lead', PANE_LEAD, socket);
  return socket;
}

async function next(argv: string[] = []) {
  const io = testIo(root, lead);
  const code = await runNext(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

async function plan(argv: string[] = []) {
  const io = testIo(root, lead);
  const code = await runPlan(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

function processes(foreground: number[]): PaneProcesses {
  return { shell: SHELL_PID, foreground };
}

async function daemon(team: TeamFile, paneProcesses: PaneProcesses | null | undefined, caller: NextClaim = { seat: 'lead', pane: PANE_LEAD }) {
  const route = routeOf(root, team.project, team.session, team.seats.map((seat) => seat.name));
  return handleNext({
    route,
    team,
    caller,
    action: 'claim',
    mine: false,
    now: NOW,
    home,
    ...(paneProcesses === undefined ? {} : { processes: paneProcesses }),
  });
}

const CLAIM_D1 = {
  ok: true as const,
  kind: 'claimed' as const,
  record: { id: 'd1', title: 'the deadline task', deadline: DEADLINE },
};

describe('a held seat takes no time-bound work from the CLI', () => {
  test('next offers nothing when the only record is a deadline one', async () => {
    project();
    writeQueue(deadlineQueue());
    socketSeat();
    holdFrame('lead');
    const run = await next();
    expect(run).toEqual({ code: 0, out: `${CTX}team next: nothing is takeable\n`, err: '' });
    expect(leaseNames()).toEqual([]);
  });

  test('without the hold the same fixture claims the deadline record (control)', async () => {
    project();
    writeQueue(deadlineQueue());
    socketSeat();
    const run = await next();
    expect(run).toEqual({
      code: 0,
      out: `${CTX}d1  the deadline task\n  deadline: ${DEADLINE}\nteam next: claimed d1\n`,
      err: '',
    });
    expect(leaseNames()).toEqual(['d1.json']);
  });

  test('a held seat still takes the untimed record beside the deadline one', async () => {
    project();
    writeQueue(`${deadlineQueue()}- id: u1\n  title: the untimed task\n`);
    socketSeat();
    holdFrame('lead');
    const run = await next();
    expect(run).toEqual({
      code: 0,
      out: `${CTX}u1  the untimed task\nteam next: claimed u1\n`,
      err: '',
    });
    expect(leaseNames()).toEqual(['u1.json']);
  });

  test('plan marks the deadline record with the reason and claims nothing', async () => {
    project();
    writeQueue(deadlineQueue());
    socketSeat();
    holdFrame('lead');
    const run = await plan();
    expect(run).toEqual({
      code: 0,
      out: `${CTX}  STEP  STATE  OWNER  TITLE\n  1     open   -      the deadline task (its seat cannot be woken while idle)\n1 task\n`,
      err: '',
    });
    expect(leaseNames()).toEqual([]);
  });

  test('plan prints the plain title without the hold (control)', async () => {
    project();
    writeQueue(deadlineQueue());
    socketSeat();
    const run = await plan();
    expect(run).toEqual({
      code: 0,
      out: `${CTX}  STEP  STATE  OWNER  TITLE\n  1     open   -      the deadline task\n1 task\n`,
      err: '',
    });
  });

  test('a hold whose declaration was re-confirmed no longer withholds the deadline record', async () => {
    project();
    writeQueue(deadlineQueue());
    declare('lead');
    const socket = socketFor(SOCKET_PID);
    record('lead', PANE_LEAD, socket);
    holdFrame('lead');
    // The seat restarted its CLI host: the generated settings file is rewritten after the mark.
    declare('lead', 30);
    const later = new Date();
    utimesSync(socket, later, later);
    const run = await next();
    expect(run).toEqual({
      code: 0,
      out: `${CTX}d1  the deadline task\n  deadline: ${DEADLINE}\nteam next: claimed d1\n`,
      err: '',
    });
  });
});

describe("the daemon's next reads the pane's ownership proof", () => {
  test('a held seat is offered no deadline record even while the pane still carries its socket', async () => {
    const team = project();
    writeQueue(deadlineQueue());
    socketSeat();
    holdFrame('lead');
    const answer = await daemon(team, processes([SOCKET_PID]));
    expect(answer).toEqual({ ok: true, kind: 'none', why: 'nothing-takeable' });
    expect(leaseNames()).toEqual([]);
  });

  test('a recorded socket whose pid the pane no longer runs is no evidence', async () => {
    const team = project();
    writeQueue(deadlineQueue());
    socketSeat();
    const answer = await daemon(team, processes([OTHER_PID]));
    expect(answer).toEqual({ ok: true, kind: 'none', why: 'nothing-takeable' });
    expect(leaseNames()).toEqual([]);
  });

  test('the pane that still runs the recorded socket claims the deadline record (control)', async () => {
    const team = project();
    writeQueue(deadlineQueue());
    socketSeat();
    const answer = await daemon(team, processes([SOCKET_PID]));
    expect(answer).toEqual(CLAIM_D1);
    expect(leaseNames()).toEqual(['d1.json']);
  });

  test('a pane the terminal host could not answer for keeps the conservative rule (control)', async () => {
    const team = project();
    writeQueue(deadlineQueue());
    socketSeat();
    const answer = await daemon(team, null);
    expect(answer).toEqual(CLAIM_D1);
    expect(leaseNames()).toEqual(['d1.json']);
  });

  test('a host that sends no process reading keeps the same rule (control)', async () => {
    const team = project();
    writeQueue(deadlineQueue());
    socketSeat();
    const answer = await daemon(team, undefined);
    expect(answer).toEqual(CLAIM_D1);
    expect(leaseNames()).toEqual(['d1.json']);
  });
});
