// How a send would reach each seat, as `team status` shows it: the word is `socket` only while the
// send's own gate admits the seat's socket — the receiving session's launch-effective settings
// declare `crossSessionInbound: accept`, the team file authorizes the route, its box holds no
// unconfirmed frame, and the pane carries a live session socket — and `typed` otherwise: another
// CLI, a launch that does not admit the frame, a pane that is gone or one the terminal host could
// not read. The plain table prints it in its own REACH column, with the WAKE cell after it; the
// JSON row keeps the published shape it always had, and adds the seat's wakeability as `seat_wake`.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import type { Standing } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { compare, type Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');

// Pids no real session can hold: the default sockets folder is the machine's own.
const SHELL_PID = 990001;
const SESSION_PID = 990002;
const CODEX_PID = 990003;

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

const processes = (pid: number): PaneProcesses => ({ shell: SHELL_PID, foreground: [pid] });

let dir: string;
let file: string;
let socks: string;
let altSocks: string;
let home: string;
let team: TeamFile;
let standing: Standing;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-reach-'));
  socks = mkdtempSync(join(tmpdir(), 'team-reach-socks-'));
  altSocks = mkdtempSync(join(tmpdir(), 'team-reach-socks-alt-'));
  // The store the route names: empty, so an unregistered seat reads no record here.
  home = mkdtempSync(join(tmpdir(), 'team-reach-home-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  team = checked.team;
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(socks, { recursive: true, force: true });
  rmSync(altSocks, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function live(processes?: Record<string, PaneProcesses | null>): Live {
  return {
    running: true,
    agents: [agent('claude-coordinator-acme', 'w1', 'working'), agent('deepseek-acme', 'w3'), agent('codex-acme', 'w2', 'idle', 'codex')],
    workspaces: [],
    screens: {},
    ...(processes ? { processes } : {}),
  };
}

// The comparison's own route input: the store home, and the state folder and root `team status`
// reads the seat's launch-effective settings and held-frame marks under.
const route = () => ({ dir: join(dir, '.agents'), root: dir, home });

function rows(live: Live, sockets: string | readonly string[] = socks) {
  return compare(team, 'acme-web', emptySession(), live, NOW, team.watch, sockets, false, undefined, undefined, route()).rows;
}

/** The live world with the coordinator's own pane processes, keyed by the pane the fixture's own
 *  agent names: a scene never writes a pane id of its own. */
function coordinatorLive(): Live {
  const world = live();
  const pane = world.agents.find((one) => one.name === 'claude-coordinator-acme')?.pane ?? '';
  return live({ [pane]: processes(SESSION_PID) });
}

/** This build's generated settings file for the seat, declaring `crossSessionInbound` as given.
 *  Backdated so a socket written after it stands as the newer file (`inboundIsLive`). */
function declareSeat(seat: string, policy: string | null = 'accept'): string {
  const path = cliHookSettingsPath(join(dir, '.agents'), 'acme-web', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  const past = new Date(NOW.getTime() - 60_000);
  utimesSync(path, past, past);
  return path;
}

test('a claude-code seat whose launch admits a socket, and whose pane carries one, reads socket', () => {
  declareSeat('claude-coordinator-acme');
  writeFileSync(join(socks, `${String(SESSION_PID)}.sock`), '');
  const found = rows(live({ 'w1:p1': processes(SESSION_PID) })).find((row) => row.name === 'claude-coordinator-acme');
  expect(found?.reach).toBe('socket');
});

// The two folders discovery walks: the temp folder's own and `/tmp/cc-socks`, where this Mac's
// sessions were seen to write while `tmpdir()` answered the per-user folder.
test('a socket that sits only in the fallback folder also reads socket', () => {
  declareSeat('claude-coordinator-acme');
  writeFileSync(join(altSocks, `${String(SESSION_PID)}.sock`), '');
  const found = rows(live({ 'w1:p1': processes(SESSION_PID) }), [socks, altSocks]).find((row) => row.name === 'claude-coordinator-acme');
  expect(found?.reach).toBe('socket');
});

test('a claude-code seat with no socket file in its pane reads typed', () => {
  const found = rows(live({ 'w1:p1': processes(SESSION_PID) })).find((row) => row.name === 'claude-coordinator-acme');
  expect(found?.reach).toBe('typed');
});

test('a socket with no accepting declaration behind it reads typed: the word is the send\'s own gate', () => {
  // The pane carries a live socket, but the seat's effective settings declare nothing, so the send
  // would never dial it. Status must not promise the route the walk refuses.
  writeFileSync(join(socks, `${String(SESSION_PID)}.sock`), '');
  const found = rows(coordinatorLive()).find((row) => row.name === 'claude-coordinator-acme');
  expect(found?.reach).toBe('typed');
});

test('a seat whose settings declare hold reads typed though its pane carries a socket', () => {
  declareSeat('claude-coordinator-acme', 'hold');
  writeFileSync(join(socks, `${String(SESSION_PID)}.sock`), '');
  const found = rows(coordinatorLive()).find((row) => row.name === 'claude-coordinator-acme');
  expect(found?.reach).toBe('typed');
});

test('a seat whose box held a frame reads typed until its declaration is re-confirmed', () => {
  // The send would not dial again on the same word, so the row says `typed`; rewriting the
  // declaration (or restarting the host) is what puts the socket back in reach.
  const settings = declareSeat('claude-coordinator-acme');
  const seatRoute = route();
  const seat = 'claude-coordinator-acme';
  const launch = team.seats.find((one) => one.name === seat)?.launch ?? '';
  const declaration = declaredInboundOf({ ...seatRoute, session: 'acme-web', seat, launch });
  expect(declaration.source).toBe(settings);
  recordHeldSocket(heldSocketPath(seatRoute.dir, 'acme-web', seat), declaration, NOW);
  writeFileSync(join(socks, `${String(SESSION_PID)}.sock`), '');
  const found = rows(coordinatorLive()).find((row) => row.name === seat);
  expect(found?.reach).toBe('typed');
});

test('a pane herdr could not read, and a pane it never listed, read typed', () => {
  const found = rows(live({ 'w1:p1': null })).filter((row) => row.name === 'claude-coordinator-acme' || row.name === 'deepseek-acme');
  expect(found.map((row) => row.reach)).toEqual(['typed', 'typed']);
});

test('a seat that is not a Claude Code one is typed even with a live socket in its pane', () => {
  writeFileSync(join(socks, `${String(CODEX_PID)}.sock`), '');
  const found = rows(live({ 'w2:p1': processes(CODEX_PID) })).find((row) => row.name === 'codex-acme');
  expect(found?.reach).toBe('typed');
});

test('a stopped seat with no pane is typed', () => {
  const found = rows(live()).find((row) => row.name === 'grok-acme');
  expect(found?.state).toBe('stopped');
  expect(found?.reach).toBe('typed');
});

const sources = (current: Live): StatusSources => ({ live: () => current, branch: () => 'main', standing: () => standing, now: () => NOW });

async function status(current: Live, ...argv: string[]) {
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file, ...argv], io, sources(current));
  return { code, out: io.out, err: io.err };
}

/** One cell of the plain table, found by its header name rather than by position: the WAKE cell
 *  follows REACH, so the last column is not the reach word. */
function cellOf(out: string, seat: string, column: string): string {
  const lines = out.split('\n');
  const heads = (lines.find((line) => line.trimStart().startsWith('SEAT ')) ?? '').trim().split(/\s{2,}/);
  const row = lines.find((line) => line.trimStart().startsWith(`${seat} `)) ?? '';
  return row.trim().split(/\s{2,}/)[heads.indexOf(column)] ?? '';
}

test('the plain table prints each active seat\'s reach under its own header, and its wake after', async () => {
  // The scene carries differences (agents the state never launched), so the table is what is
  // pinned here, not the exit code. Stopped seats are hidden from the default table.
  const { out } = await status(live({ 'w1:p1': processes(SESSION_PID) }));
  expect(cellOf(out, 'claude-coordinator-acme', 'REACH')).toBe('typed');
  expect(cellOf(out, 'codex-acme', 'REACH')).toBe('typed');
  expect(out.split('\n').find((candidate) => candidate.trimStart().startsWith('grok-acme '))).toBeUndefined();
});

test('--json keeps the reach word out of the rows: it is the plain table\'s alone', async () => {
  const { out } = await status(live({ 'w1:p1': processes(SESSION_PID) }), '--json');
  const doc = JSON.parse(out) as { rows: Record<string, unknown>[] };
  // The published keys stand, the seat's own readings riding beside them additively; `reach`
  // never crosses over, and no row here is blind (each reads a word), so no `blind` key either.
  for (const row of doc.rows) {
    expect(Object.keys(row).sort()).toEqual(['model', 'name', 'pane', 'seat_state', 'seat_state_source', 'seat_wake', 'state']);
  }
});
