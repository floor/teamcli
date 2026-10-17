// The provenance a dev-mode registration leaves: the record `team register` writes with dev
// mode on carries `dev_mode: true` beside the caller, and `team check` says so as a difference —
// `registered by an agent, not by the owner`, repaired by `team register <seat>`, the
// same write with the caller gate in force. The check writes nothing, a record written in force
// is no finding, and a check with no home reads no registry at all — the same boundary every
// other registry read keeps. Fake herdr throughout: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { realSeatsSources, runSeats } from '../src/commands/seats.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readAgents, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');

const TEXT = `format: 1
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
    launch: claude --model claude-opus-5-5
    leads: true
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const seat = loaded.team.seats[0]!;
/** Line 1 as the file writes it, so a clean world carries no label drift. */
const TITLE = workspaceLabel(seat);
/** Line 2 as the file writes it, so a clean world carries no display drift. */
const DISPLAY = displayAgent(seat);
/** The caller a dev-mode run of `team register` kept: an unplaced call herdr did not name. */
const DEV_CALLER = 'unplaced (it runs under herdr)';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function place(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-dev-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  // The seat's pane as the launch recorded it, and a watch pass recent enough that the run
  // itself is no difference: the two ambient findings every clean check world seeds away.
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: { lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } },
      worktrees: {},
      watch: { pid: 1, heartbeat: NOW.toISOString() },
    };
  });
  return { root, home };
}

/** The live session as herdr answers it, with the seat's two sidebar lines as the file writes them. */
function live(): Live {
  return {
    running: true,
    agents: [
      {
        name: 'lead',
        agent: 'claude',
        pane: 'w1:p1',
        workspace: 'w1',
        status: 'idle',
        cwd: null,
        displayAgent: DISPLAY,
      },
    ],
    workspaces: [{ id: 'w1', label: TITLE }],
    // The seat's own pane, readable: a quiet seat on a screen no profile reads is a difference
    // of its own, and this world's only finding is meant to be the record's provenance.
    screens: { 'w1:p1': CLAUDE_IDLE },
  };
}

/** The seat's agent record as the run named by `by` wrote it, dev mark per `dev`. */
function record(home: string, root: string, options: { by: string; dev?: boolean }): string {
  const agent = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: options.by,
    devMode: options.dev === true,
  });
  return agent.id;
}

function check(root: string, home: string | undefined, session: Live = live()): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => session,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home ?? join(root, 'nowhere')),
    now: () => NOW,
    ...(home === undefined ? {} : { home }),
  });
  return { code, out: `${io.out}${io.err}` };
}

/** The registry as it stands on disk: every agent file's bytes, for the scene that proves the
 *  check read it and wrote nothing. */
function registryOnDisk(home: string): Record<string, string> {
  const dir = join(home, '.config', 'team', 'agents');
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), 'utf8');
  return out;
}

describe('the dev-mode mark on a record', () => {
  test('a record a dev-mode run wrote is a difference, and nothing is written', () => {
    const { root, home } = place();
    record(home, root, { by: DEV_CALLER, dev: true });
    const before = registryOnDisk(home);
    const { code, out } = check(root, home);
    expect(out).toContain('difference: lead: registered by an agent, not by the owner');
    expect(out).not.toContain(DEV_CALLER);
    expect(out).toContain('  repair: re-record the seat with the caller gate in force (team register lead)');
    expect(code).toBe(1);
    // The record is the finding's evidence, read only: the check writes nothing.
    expect(registryOnDisk(home)).toEqual(before);
  });

  test('a record a run in force wrote is no finding at all', () => {
    const { root, home } = place();
    record(home, root, { by: 'owner' });
    const { code, out } = check(root, home);
    expect(out).not.toContain('registered by an agent, not by the owner');
    expect(code).toBe(0);
    expect(out).toContain('0 difference(s)');
  });

  test('a record written again in force takes the mark off, and the finding with it', () => {
    const { root, home } = place();
    const id = record(home, root, { by: DEV_CALLER, dev: true });
    expect(check(root, home).out).toContain('registered by an agent, not by the owner');
    // The repair itself, as `team register` makes it: the same record, written again with the
    // caller gate in force.
    updateAgent(home, id, { provenance: { dev_mode: false } });
    const { code, out } = check(root, home);
    expect(out).not.toContain('registered by an agent, not by the owner');
    expect(code).toBe(0);
  });

  test('a re-registration under dev mode states the plain finding without the raw caller label', () => {
    const { root, home } = place();
    // The owner registered the seat first; a later run under dev mode, by a caller the gate did
    // not admit, wrote the record again. `registered_by` is still the owner's, and the finding
    // states plainly that the seat was registered by an agent, not by the owner.
    const id = record(home, root, { by: 'owner' });
    updateAgent(home, id, { provenance: { dev_mode: true, dev_mode_by: DEV_CALLER } });
    const { code, out } = check(root, home);
    expect(out).toContain('difference: lead: registered by an agent, not by the owner');
    expect(out).not.toContain(DEV_CALLER);
    expect(code).toBe(1);
  });

  test('the record keeps the registrant, and the dev-mode caller beside the mark', () => {
    const { root, home } = place();
    const id = record(home, root, { by: 'owner' });
    const marked = updateAgent(home, id, { provenance: { dev_mode: true, dev_mode_by: DEV_CALLER } });
    expect(marked.provenance.registered_by).toBe('owner');
    expect(marked.provenance.dev_mode_by).toBe(DEV_CALLER);
    expect(marked.provenance.dev_mode_at).toBeDefined();
    // The write in force takes the mark off, and the caller it named with it.
    const cleaned = updateAgent(home, id, { provenance: { dev_mode: false } });
    expect(cleaned.provenance.dev_mode).toBeUndefined();
    expect(cleaned.provenance.dev_mode_by).toBeUndefined();
    expect(cleaned.provenance.dev_mode_at).toBeUndefined();
  });

  test('the caller and the time are read back from the file, as a fresh command reads them', () => {
    const { root, home } = place();
    const id = record(home, root, { by: 'owner' });
    updateAgent(home, id, { provenance: { dev_mode: true, dev_mode_by: DEV_CALLER } });
    const read = readAgents(home).find((agent) => agent.id === id);
    expect(read?.provenance.registered_by).toBe('owner');
    expect(read?.provenance.dev_mode_by).toBe(DEV_CALLER);
    expect(read?.provenance.dev_mode_at).toBeDefined();
  });

  test('a record a dev-mode run registered first states the plain finding too', () => {
    const { root, home } = place();
    record(home, root, { by: DEV_CALLER, dev: true });
    const { out } = check(root, home);
    expect(out).toContain('difference: lead: registered by an agent, not by the owner');
    expect(out).not.toContain(DEV_CALLER);
  });

  test('a check with no home reads no registry: the mark is invisible to it', () => {
    const { root, home } = place();
    record(home, root, { by: DEV_CALLER, dev: true });
    const { code, out } = check(root, undefined);
    expect(out).not.toContain('registered by an agent, not by the owner');
    expect(code).toBe(0);
  });

  test('realSeatsSources carries home so team seats shows the dev mark in the table and --json', async () => {
    expect(typeof realSeatsSources.home).toBe('string');
    expect(realSeatsSources.home!.length).toBeGreaterThan(0);
    const { root, home } = place();
    record(home, root, { by: DEV_CALLER, dev: true });
    updateState(join(root, '.agents'), (state) => {
      state.sessions.acme!.seats.lead!.id = 'seat_111111111111';
    });
    const tableIo = testIo(root, { kind: 'owner' });
    const tableCode = await runSeats(['--file', '.agents/team.yaml'], tableIo, {
      ...realSeatsSources,
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    expect(tableCode).toBe(0);
    expect(tableIo.out).toContain('seat_111111111111 (dev)');

    const jsonIo = testIo(root, { kind: 'owner' });
    const jsonCode = await runSeats(['--file', '.agents/team.yaml', '--json'], jsonIo, {
      ...realSeatsSources,
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(jsonIo.out) as { seats: Array<{ name: string; dev_mode?: boolean }> };
    expect(parsed.seats[0]?.dev_mode).toBe(true);
  });
});
