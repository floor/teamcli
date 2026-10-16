// How a send would reach each seat, as `team status` shows it: the word is `socket` while the
// seat's pane carries a live session socket, `typed` otherwise — for every seat that is not a
// Claude Code one, for a pane that is gone, and for one herdr could not read. The plain table
// prints it as its last column; the JSON row keeps the published shape it always had.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
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
let team: TeamFile;
let standing: Standing;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-reach-'));
  socks = mkdtempSync(join(tmpdir(), 'team-reach-socks-'));
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

function rows(live: Live) {
  return compare(team, 'acme-web', emptySession(), live, NOW, team.watch, socks).rows;
}

test('a claude-code seat whose pane carries a live socket file reads socket', () => {
  writeFileSync(join(socks, `${String(SESSION_PID)}.sock`), '');
  const found = rows(live({ 'w1:p1': processes(SESSION_PID) })).find((row) => row.name === 'claude-coordinator-acme');
  expect(found?.reach).toBe('socket');
});

test('a claude-code seat with no socket file in its pane reads typed', () => {
  const found = rows(live({ 'w1:p1': processes(SESSION_PID) })).find((row) => row.name === 'claude-coordinator-acme');
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

test('the plain table prints each seat how a send would reach it, as its last column', async () => {
  // The scene carries differences (agents the state never launched), so the table is what is
  // pinned here, not the exit code.
  const { out } = await status(live({ 'w1:p1': processes(SESSION_PID) }));
  const line = (name: string) => out.split('\n').find((candidate) => candidate.trimStart().startsWith(`${name} `)) ?? '';
  expect(line('claude-coordinator-acme')).toMatch(/  typed$/);
  expect(line('codex-acme')).toMatch(/  typed$/);
  expect(line('grok-acme')).toMatch(/  typed$/);
});

test('--json keeps the row shape it published: the reach word is the plain table\'s alone', async () => {
  const { out } = await status(live({ 'w1:p1': processes(SESSION_PID) }), '--json');
  const doc = JSON.parse(out) as { rows: Record<string, unknown>[] };
  for (const row of doc.rows) expect(Object.keys(row).sort()).toEqual(['model', 'name', 'pane', 'state']);
});
