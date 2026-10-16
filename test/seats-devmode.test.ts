// The seats table's one mark out of the agent registry: a seat whose record a dev-mode
// registration wrote shows `(dev)` beside its id — `seat_<12 hex> (dev)` — and a record in force
// shows nothing. The mark is read, never written: a run leaves the registry exactly as it stood.
// Fake herdr and a temporary home throughout: no live registry and no live session are read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runSeats, type SeatsSources, type SeatsJson } from '../src/commands/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const LEAD_ID = 'seat_0123456789ab';
const WORKER_ID = 'seat_0fedcba98765';

function seatBlock(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
  ].join('\n');
}

function teamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
workspace:
  mode: shared
  base: main
seats:
${seatBlock('lead', 'coordinator')}
${seatBlock('worker', 'implementer')}
`;
}

function live(): Live {
  return {
    running: true,
    agents: [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
    ],
    workspaces: [
      { id: 'lead-ws', label: 'lead' },
      { id: 'worker-ws', label: 'worker' },
    ],
    screens: {},
  };
}

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** The team's file, state and home, and the two seats' records: `dev` is the lead's mark. */
function world(dev: boolean): { root: string; dir: string; home: string; leadRecord: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seats-dev-')));
  made.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml());
  updateState(dir, (state) => {
    state.sessions.alpha = {
      ...emptySession(),
      seats: {
        lead: { id: LEAD_ID, stage: 'ready', pane: 'lead-pane', workspace: 'lead-ws' },
        worker: { id: WORKER_ID, stage: 'ready', pane: 'worker-pane', workspace: 'worker-ws' },
      },
    };
  });
  const record = (name: string, pane: string, devMode: boolean): string =>
    registerAgent(home, {
      name,
      signing: { model: 'Claude Opus', version: '5.5', role: name === 'lead' ? 'coordinator' : 'implementer' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: { team: teamIdOf(root), seat: name, session: 'alpha', pane, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: devMode ? 'unplaced (it runs under herdr)' : 'owner',
      devMode,
    }).id;
  const leadRecord = record('lead', 'lead-pane', dev);
  record('worker', 'worker-pane', false);
  return { root, dir, home, leadRecord };
}

function sources(root: string, home: string): SeatsSources {
  const checked = validateTeamFile(teamYaml());
  if (!checked.ok) throw new Error('the fixture does not validate');
  const standing = verifiedOf(checked.team, teamYaml(), join(root, '.agents'), NOW);
  return { live: () => live(), branch: () => 'main', standing: () => standing, now: () => NOW, home };
}

/** The registry as it stands on disk: every agent file's bytes, for the scenes that prove a
 *  reading wrote nothing. */
function registryOnDisk(home: string): Record<string, string> {
  const dir = join(home, '.config', 'team', 'agents');
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), 'utf8');
  return out;
}

describe('the dev mark in the seats table', () => {
  test('a dev-mode record is marked beside the seat id, and the run writes nothing', async () => {
    const { root, home } = world(true);
    const io = testIo(root, { kind: 'owner' });
    const before = registryOnDisk(home);
    const code = await runSeats(['--all'], io, sources(root, home));
    expect(code).toBe(0);
    expect(io.out).toContain(`${LEAD_ID} (dev)`);
    expect(io.out).not.toContain(`${WORKER_ID} (dev)`);
    // The mark rides the reading only: the registry is exactly as it stood.
    expect(registryOnDisk(home)).toEqual(before);
  });

  test('a record in force carries no mark', async () => {
    const { root, home } = world(false);
    const io = testIo(root, { kind: 'owner' });
    const code = await runSeats(['--all'], io, sources(root, home));
    expect(code).toBe(0);
    expect(io.out).toContain(LEAD_ID);
    expect(io.out).not.toContain('(dev)');
  });

  test('--json carries dev_mode on the one row the registry marks, and nothing on the other', async () => {
    const { root, home } = world(true);
    const io = testIo(root, { kind: 'owner' });
    expect(await runSeats(['--all', '--json'], io, sources(root, home))).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const lead = doc.seats.find((seat) => seat.name === 'lead');
    const worker = doc.seats.find((seat) => seat.name === 'worker');
    expect(lead?.dev_mode).toBe(true);
    expect(worker?.dev_mode).toBeUndefined();
    expect(worker !== undefined && 'dev_mode' in worker).toBe(false);
  });

  test('a record written again in force takes the mark off the table too', async () => {
    const { root, home, leadRecord } = world(true);
    updateAgent(home, leadRecord, { provenance: { dev_mode: false } });
    const io = testIo(root, { kind: 'owner' });
    expect(await runSeats(['--all'], io, sources(root, home))).toBe(0);
    expect(io.out).toContain(LEAD_ID);
    expect(io.out).not.toContain('(dev)');
  });
});
