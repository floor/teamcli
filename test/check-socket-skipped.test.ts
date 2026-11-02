// The skipped-socket line `team check` owes a team: a live seat whose CLI profile promises a push
// delivery, whose launch declares the cross-session socket accepts, and whose send would still
// leave the socket out — so every message waits in its drop folder until its next turn. The
// reading is the send's own gate and address choice, and the walk is the send's own order: a
// declared order that names neither the socket nor the `typed` wake word chose its routes and is
// no finding. The reasons a team-file word or a restart fixes are differences (exit 1, one line
// per seat, the repair named). A socket that is nowhere is a note naming its delivery class in
// every shape — absence wins over any gate — and a pane that no longer holds the seat is not
// read at all: the comparison's own line already says the CLI ended.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalStanding } from '../src/store/store.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
// Neutral fixture ids: the host's pane shape is never written into a test, built or literal.
const PANE_ONE = 'fixture-pane-one';
const PANE_TWO = 'fixture-pane-two';
// Pids no real session can hold: the scenes' sockets folder is their own.
const SHELL_PID = 880001;
const SESSION_PID = 880002;
const OTHER_PID = 880004;
const SESSION_TWO_PID = 880005;

const made: string[] = [];
beforeEach(() => {
  // No pane of this machine's is behind a stray read; an unreadable terminal host is the reading
  // that leaves it alone.
  setHerdrRun(() => {
    throw new Error('the terminal host is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type SeatSpec = {
  name: string;
  role: string;
  cli?: 'claude-code' | 'codex';
  launch: string;
  inbound?: 'accept' | 'hold' | 'refuse';
  leads?: boolean;
};

type World = { base: string; root: string; dir: string; home: string; sockets: string };

function seatBlock(seat: SeatSpec): string {
  const model = seat.cli === 'codex' ? 'Test' : 'Claude Opus';
  const version = seat.cli === 'codex' ? '1' : '5.5';
  return `  - role: ${seat.role}
    name: ${seat.name}
    cli: ${seat.cli ?? 'claude-code'}
    vendor: test
    model: ${model}
    version: ${JSON.stringify(version)}
    launch: ${seat.launch}
${seat.inbound === undefined ? '' : `    inbound: ${seat.inbound}\n`}${seat.leads === true ? '    leads: true\n' : ''}`;
}

function teamText(seats: readonly SeatSpec[], order?: readonly string[]): string {
  const coordinator = seats[0]?.name ?? 'lead';
  return `format: 1
project: acme
operator: ${coordinator}
session: acme
workspace:
  mode: shared
${order === undefined ? '' : `delivery_order: [${order.join(', ')}]\n`}seats:
${seats.map(seatBlock).join('')}`;
}

/** One machine: the team's checkout with its file, a home with its lobby, a sockets folder of its
 *  own, and the registry record whose roster lists every seat. */
function world(seats: readonly SeatSpec[], order?: readonly string[]): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-socket-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = teamText(seats, order);
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeFileSync(join(dir, 'team.yaml'), text);
  const w: World = { base, root, dir, home, sockets };
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    at: NOW.toISOString(),
    roster: seats.map((seat, index) => ({ agent: `agt_${String(index).padStart(12, '0')}`, seat: seat.name, role: seat.role })),
  });
  return w;
}

/** The launch line in the shape a wrapper reports: this build did not generate the settings file
 *  on the line, so its accept alone attests nothing and the team file's word is what admits it.
 *  The settings file is backdated, so a socket written after it stands as the newer file. */
function wrapperLine(w: World, name: string): string {
  const wrapper = join(w.dir, 'wrapper');
  mkdirSync(wrapper, { recursive: true });
  const script = join(wrapper, 'launch.sh');
  writeFileSync(script, '#!/bin/sh\nexec fake-claude --model test "$@"\n', { mode: 0o700 });
  const settings = join(wrapper, `${name}.json`);
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const past = new Date(NOW.getTime() - 90_000);
  utimesSync(settings, past, past);
  return `FIXTURE_LAUNCH_FLAG=1 zsh ${script} --resume fixture-conversation --settings ${settings}`;
}

/** The fixture team file with one seat's launch line replaced in place: the line is one YAML
 *  plain scalar. */
function setLaunch(w: World, seat: string, line: string): void {
  const path = join(w.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8');
  const named = text.indexOf(`    name: ${seat}\n`);
  const at = named < 0 ? -1 : text.indexOf('    launch: ', named);
  const end = at < 0 ? -1 : text.indexOf('\n', at);
  if (at < 0 || end < 0) throw new Error(`the fixture names no seat ${seat} with a launch line`);
  writeFileSync(path, `${text.slice(0, at)}    launch: ${line}${text.slice(end)}`);
}

/** This build's generated settings file for the seat, declaring `crossSessionInbound` as given,
 *  backdated so a socket written after it stands as the newer file. */
function declare(w: World, seat: string, policy: string | null = 'accept'): string {
  const path = cliHookSettingsPath(w.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  const past = new Date(NOW.getTime() - 60_000);
  utimesSync(path, past, past);
  return path;
}

type Ready = { name: string; pane: string; launch: string; cli?: 'claude-code' | 'codex'; pid: number };

/** The state the launch leaves: the watch recorded and each seat ready on the pane it was given,
 *  its brief delivered and read. */
function ready(w: World, seats: readonly Ready[]): void {
  updateState(w.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    for (const seat of seats) {
      session.seats[seat.name] = {
        stage: 'ready',
        pane: seat.pane,
        workspace: 'fixture-workspace',
        cli: seat.cli ?? 'claude-code',
        // A current launch's record: a Codex seat's line carries its profile's pinned feature.
        launch_line: seat.cli === 'codex' ? `${seat.launch} -c features.mcp_oauth_refresh_coordination=false` : seat.launch,
      };
    }
  });
  deliverBriefs({ dir: w.dir, root: w.root, session: 'acme', seats: seats.map((seat) => seat.name), home: w.home, at: NOW.toISOString() });
}

/** The terminal host's reading: each seat idle on its recorded pane, its processes readable, its
 *  screen the captured idle one. */
function liveOn(seats: readonly Ready[], options: { screen?: boolean } = {}): Live {
  return {
    running: true,
    agents: seats.map((seat) => ({
      name: seat.name,
      agent: seat.cli === 'codex' ? 'codex' : 'claude',
      pane: seat.pane,
      workspace: 'fixture-workspace',
      status: 'idle',
      cwd: null,
    })),
    workspaces: [],
    screens: options.screen === false ? {} : Object.fromEntries(seats.map((seat) => [seat.pane, CLAUDE_IDLE])),
    processes: Object.fromEntries(seats.map((seat) => [seat.pane, { shell: SHELL_PID, foreground: [seat.pid] }])),
  };
}

/** The socket a seat's pane process exposes, in the fixture folder. */
function socketOf(w: World, seat: Ready): string {
  return join(w.sockets, `${String(seat.pid)}.sock`);
}

function writeSocket(w: World, seat: Ready, at: Date = new Date()): string {
  const path = socketOf(w, seat);
  writeFileSync(path, '');
  utimesSync(path, at, at);
  return path;
}

/** The registry record a plain-name send resolves, carrying the recorded socket address the
 *  delivery class and the send's own leg both read. */
function register(w: World, seat: Ready, address: string): void {
  registerAgent(w.home, {
    name: seat.name,
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'test',
    cli: seat.cli ?? 'claude-code',
    launcher: null,
    launch: seat.launch,
    reach: { team: teamIdOf(w.root), seat: seat.name, session: 'acme', pane: seat.pane, address },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

/** The scene's check, with the fixture's sockets folder named so no read touches this machine's. */
function check(w: World, live: Live): { code: number; out: string } {
  const io = testIo(w.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (root) => approvalStanding(root, w.home),
    now: () => NOW,
    home: w.home,
    sockets: w.sockets,
  });
  return { code, out: `${io.out}${io.err}` };
}

const NOT_SOCKET = 'sends go to its drop folder, not its socket';
const NO_SOCKET = 'no cross-session socket is live';

describe('team check names a live seat whose socket a send would skip', () => {
  test('a launch whose own settings accept, with no team-file word: the config word is the repair', () => {
    const w = world([{ name: 'wrapped', role: 'orchestrator', launch: 'claude', leads: true }]);
    const line = wrapperLine(w, 'wrapped');
    setLaunch(w, 'wrapped', line);
    const seat = { name: 'wrapped', pane: PANE_ONE, launch: line, pid: SESSION_PID };
    writeSocket(w, seat);
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).toContain(
      "difference: wrapped: sends go to its drop folder, not its socket: the receiving seat's team file does not declare inbound accept",
    );
    expect(out).toContain('  repair: team config set seats.wrapped.inbound accept');
    expect(code).toBe(1);
  });

  test('the same missing word with no socket anywhere: absence wins, and the note keeps the exit', () => {
    const w = world([{ name: 'wrapped', role: 'orchestrator', launch: 'claude', leads: true }]);
    const line = wrapperLine(w, 'wrapped');
    setLaunch(w, 'wrapped', line);
    const seat = { name: 'wrapped', pane: PANE_ONE, launch: line, pid: SESSION_PID };
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    // The wrapper's own `--settings` suppresses this build's hook, so the class is `none`; the
    // note names it and the exit does not move.
    expect(out).toContain(
      `note: wrapped: ${NO_SOCKET}, so sends go to its drop folder; its delivery class is none — nothing wakes wrapped while it is idle; a person or a restart must give it a turn`,
    );
    expect(out).not.toContain(NOT_SOCKET);
    expect(code).toBe(0);
  });

  test('the team-file word plus a live socket: nothing is named', () => {
    const w = world([{ name: 'accepted', role: 'orchestrator', launch: 'claude', inbound: 'accept', leads: true }]);
    const seat = { name: 'accepted', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'accepted');
    writeSocket(w, seat);
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).not.toContain(NOT_SOCKET);
    expect(out).not.toContain(NO_SOCKET);
    expect(code).toBe(0);
  });

  test('an explicit opt-out is the team\'s choice, not a finding', () => {
    const w = world([{ name: 'opted-out', role: 'orchestrator', launch: 'claude', inbound: 'hold', leads: true }]);
    const seat = { name: 'opted-out', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'opted-out');
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).not.toContain(NOT_SOCKET);
    expect(out).not.toContain(NO_SOCKET);
    expect(code).toBe(0);
  });

  test('a box that held a frame: the hold is named, and a restart re-confirms it', () => {
    const w = world([{ name: 'held', role: 'orchestrator', launch: 'claude', inbound: 'accept', leads: true }]);
    const seat = { name: 'held', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'held');
    const declaration = declaredInboundOf({ dir: w.dir, root: w.root, session: 'acme', seat: 'held', launch: seat.launch });
    recordHeldSocket(heldSocketPath(w.dir, 'acme', 'held'), declaration, NOW);
    writeSocket(w, seat);
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).toContain(`difference: held: ${NOT_SOCKET}: its last socket frame was held at its box`);
    expect(out).toContain('  repair: team restart held');
    expect(code).toBe(1);
  });

  test('a registered seat whose box held a frame: the hold is named, and a restart re-confirms it', () => {
    const w = world([{ name: 'heldreg', role: 'orchestrator', launch: 'claude', inbound: 'accept', leads: true }]);
    const seat = { name: 'heldreg', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'heldreg');
    // The registry names a recorded socket, and the box held a frame under the declaration in
    // force: the seat's class is no wake, and the send's own gate must still name the hold, so
    // the finding never depends on which class the seat reads.
    register(w, seat, writeSocket(w, seat));
    const declaration = declaredInboundOf({ dir: w.dir, root: w.root, session: 'acme', seat: 'heldreg', launch: seat.launch });
    recordHeldSocket(heldSocketPath(w.dir, 'acme', 'heldreg'), declaration, NOW);
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).toContain(`difference: heldreg: ${NOT_SOCKET}: its last socket frame was held at its box`);
    expect(out).toContain('  repair: team restart heldreg');
    expect(code).toBe(1);
  });

  test('a socket older than the settings that declare it: the restart is the repair', () => {
    const w = world([{ name: 'older', role: 'orchestrator', launch: 'claude', inbound: 'accept', leads: true }]);
    const seat = { name: 'older', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'older');
    // The running session started before its settings declared accept: the frame it exposes
    // predates the declaration, and a send there would be held.
    writeSocket(w, seat, new Date(NOW.getTime() - 120_000));
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).toContain(`difference: older: ${NOT_SOCKET}: the socket predates the settings that declare it accepts`);
    expect(out).toContain('  repair: team restart older');
    expect(code).toBe(1);
  });

  test('a seat with no socket at all is a note naming its class, and the exit is unchanged', () => {
    const w = world([{ name: 'nosock', role: 'orchestrator', launch: 'claude', inbound: 'accept', leads: true }]);
    const seat = { name: 'nosock', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'nosock');
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).toContain(`note: nosock: ${NO_SOCKET}, so sends go to its drop folder; its delivery class is pull-on-turn`);
    expect(out).not.toContain(NOT_SOCKET);
    expect(code).toBe(0);
  });

  test('a recorded socket the pane’s processes no longer carry is a note, not a finding', () => {
    const w = world([{ name: 'replaced', role: 'orchestrator', launch: 'claude', inbound: 'accept', leads: true }]);
    const seat = { name: 'replaced', pane: PANE_ONE, launch: 'claude --model claude-opus-5-5', pid: SESSION_PID };
    declare(w, 'replaced');
    // The registry names the socket of the pid the session had, and the file still stands. The
    // pane has been relaunched since: its processes are another pid, and no socket in the
    // folder is one the walk would dial. The class reads the same processes the send's leg
    // below reads, so it is no push class, and the absence is the class's ordinary state.
    register(w, seat, writeSocket(w, seat));
    ready(w, [seat]);
    const live = liveOn([seat]);
    const { code, out } = check(w, {
      ...live,
      processes: { [PANE_ONE]: { shell: OTHER_PID, foreground: [OTHER_PID + 1] } },
    });
    expect(out).toContain(
      `note: replaced: ${NO_SOCKET}, so sends go to its drop folder; its delivery class is pull-on-turn — replaced reads it at its next turn, and nothing here gives it one (pull-only)`,
    );
    expect(out).not.toContain(NOT_SOCKET);
    expect(code).toBe(0);
  });

  test('a declared order that leaves the socket out is a choice, not a skipped socket', () => {
    const w = world([{ name: 'bydrop', role: 'orchestrator', launch: 'claude', leads: true }], ['drop']);
    const line = wrapperLine(w, 'bydrop');
    setLaunch(w, 'bydrop', line);
    const seat = { name: 'bydrop', pane: PANE_ONE, launch: line, pid: SESSION_PID };
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat]));
    expect(out).not.toContain(NOT_SOCKET);
    expect(out).not.toContain(NO_SOCKET);
    expect(code).toBe(0);
  });

  test('a seat whose CLI profile promises no socket is never named', () => {
    const w = world([{ name: 'native', role: 'orchestrator', cli: 'codex', launch: 'codex -m test', leads: true }]);
    const seat = { name: 'native', pane: PANE_ONE, launch: 'codex -m test', cli: 'codex' as const, pid: OTHER_PID };
    ready(w, [seat]);
    const { code, out } = check(w, liveOn([seat], { screen: false }));
    expect(out).not.toContain(NOT_SOCKET);
    expect(out).not.toContain(NO_SOCKET);
    expect(code).toBe(0);
  });

  test('a CLI that ended in a retained pane: the comparison names it once, and no socket line is added', () => {
    const w = world([{ name: 'ended', role: 'orchestrator', launch: 'claude', leads: true }]);
    const line = wrapperLine(w, 'ended');
    setLaunch(w, 'ended', line);
    const seat = { name: 'ended', pane: PANE_ONE, launch: line, pid: SESSION_PID };
    ready(w, [seat]);
    // The launch recorded its process identity, and the reading finds only the pane's own shell:
    // the CLI ended, and the comparison's "its pane runs no CLI" line is the one that names it.
    updateState(w.dir, (state) => {
      state.sessions.acme!.seats.ended!.launched = { shell: SHELL_PID, cli: [SESSION_PID] };
    });
    const live = liveOn([seat]);
    const { code, out } = check(w, {
      ...live,
      processes: { [PANE_ONE]: { shell: SHELL_PID, foreground: [SHELL_PID] } },
    });
    expect(out).toContain('difference: ended: its pane runs no CLI (the CLI ended or the session was restored)');
    expect(out).not.toContain(NOT_SOCKET);
    expect(out).not.toContain(NO_SOCKET);
    expect(code).toBe(1);
  });

  test('a seat that is not running is not named', () => {
    const w = world([{ name: 'wrapped', role: 'orchestrator', launch: 'claude', leads: true }]);
    const line = wrapperLine(w, 'wrapped');
    setLaunch(w, 'wrapped', line);
    const seat = { name: 'wrapped', pane: PANE_ONE, launch: line, pid: SESSION_PID };
    ready(w, [seat]);
    // The check's own "in the file and is not running" row stands; it is not this finding.
    const { code, out } = check(w, { running: false, agents: [], workspaces: [], screens: {} });
    expect(out).not.toContain(NOT_SOCKET);
    expect(out).not.toContain(NO_SOCKET);
    expect(code).toBe(1);
  });
});
