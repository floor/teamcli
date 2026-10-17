// The swap's second half and the edges of its stop, at the sentences the pages carry: `add`
// closes the record the stop opened (and a launch that never reached ready keeps it), a prompt
// and an unrecognised screen are left as they are, an operator the map never admits to a swap
// (it is not a lead, so no grant is read), and an approved delegate's `remove` word never
// reaches a lead — only `swap` does.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { delegateGate } from '../src/delegate.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { LOG_FILE, emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Screen } from '../src/watch/screen.ts';
import { claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T10:00:00.000Z');
const SEAT = (name: string, role: string): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const BASE = `format: 1
project: acme
coordinator: lead
operator: op
session: acme
trust:
  - PLACEHOLDER_LOBBY
  - PLACEHOLDER_ROOT
workspace:
  mode: shared
  base: main
seats:
${SEAT('lead', 'coordinator')}${SEAT('op', 'operator')}${SEAT('worker', 'implementer')}`;

/** The grant names the orchestrator: the one seat whose swap it admits is lead's own caller. */
const GRANTED = `${BASE}grant:
  session: acme
  seat: lead
  scope: [swap]
`;

/** A delegate entry with `remove` and no `swap`: `remove` never reaches a lead. */
const DELEGATED = `${BASE}delegates:
  - pane: main/w1:p1
    commands: [up, remove]
`;

const owner = { kind: 'owner' as const };
const op = { kind: 'seat' as const, name: 'op', pane: 'w5:p1', session: 'acme' };
const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w1:p1', session: 'main' };

let dir: string;
let file: string;
let home: string;
let lobby: string;

/** The team file with its trust entries absolute, the lobby this fixture owns among them. */
function withTrust(text: string): string {
  return text.replaceAll('PLACEHOLDER_LOBBY', lobby).replaceAll('PLACEHOLDER_ROOT', dir);
}

function approve(text: string): void {
  writeFileSync(file, withTrust(text));
  const loaded = loadTeamFile(dir, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root), file: withTrust(text) }, loaded.team.seats, home);
}

function record(name: string, pane: string, workspace: string, id?: string): void {
  updateState(join(dir, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats[name] = { stage: 'ready', pane, workspace, ...(id ? { id } : {}) };
  });
}

function session() {
  return readState(join(dir, '.agents')).sessions.acme;
}

function stopWorld(screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources; typed: string[]; closed: string[]; agents: HerdrAgent[];
} {
  const typed: string[] = [];
  const closed: string[] = [];
  let sent = false;
  let box: string | undefined = claudeBox('');
  const agents: HerdrAgent[] = [];
  const launch: DownLaunch = {
    typeText: (_s, _p, text) => { typed.push(text); box = claudeBox(text); return true; },
    sendKey: () => { box = claudeBox(''); return true; },
    pressEnter: () => { sent = true; return true; },
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_s, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: RemoveSources = {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    screenText: () => box,
    status: () => status,
    now: () => NOW,
    sleep: async () => {},
    launch,
    foreground: () => (sent ? [] : ['claude']),
  };
  return { sources, typed, closed, agents };
}

/** The add-side launch host: a workspace that is created (or not), an agent that starts. */
function addWorld(make: boolean): AddSources {
  const panes = new Map<string, boolean>();
  let n = 0;
  const launch = {
    startServer: () => true,
    sessionState: () => 'running' as const,
    sessionUp: () => true,
    createWorkspace(_session: string, _cwd: string, _label: string) {
      if (!make) return null;
      n += 1;
      panes.set(`w${n + 10}:p1`, false);
      return { pane: `w${n + 10}:p1`, workspace: `w${n + 10}` };
    },
    paneRun(_session: string, pane: string) {
      if (panes.has(pane)) panes.set(pane, true);
      return true;
    },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, agent]) => agent).map(([id]) => id),
    agents: () => [] as HerdrAgent[],
    paneText: (_session: string, pane: string) => (panes.get(pane) ? claudeBox('') : ''),
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor = (): DoctorSources => ({
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  });
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch,
  };
}

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-swap-edge-')));
  dir = join(base, 'acme');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  file = join(dir, '.agents', 'team.yaml');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(home, { recursive: true });
  approve(BASE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The owner's stop of the operator for a swap, with the handle parked as a real stop parks it. */
async function stopOp(): Promise<ReturnType<typeof stopWorld>> {
  record('op', 'w5:p1', 'w5', 'seat_00000000000f');
  const made = stopWorld();
  made.agents.push({ name: 'op', agent: 'claude', pane: 'w5:p1', workspace: 'w5', status: 'idle', cwd: null });
  const io = testIo(dir, owner);
  const code = await runRemove(['op', '--keep', '--file', file], io, made.sources);
  expect(code, `remove said:\n${io.out}\n${io.err}`).toBe(0);
  expect(session()?.swapping?.op?.by).toBe('owner');
  return made;
}

describe('the swap across its two halves', () => {
  test('add starts the new agent, closes the record, and logs both lines', async () => {
    await stopOp();
    expect(session()?.retained_seats?.op?.id).toBe('seat_00000000000f');

    const io = testIo(dir, owner);
    const code = await runAdd(['op'], io, addWorld(true));
    expect(code, `add said:\n${io.out}\n${io.err}`).toBe(0);
    // The seat runs again under its own handle, and nothing of the swap is left open.
    expect(session()?.seats.op?.stage).toBe('ready');
    expect(session()?.seats.op?.id).toBe('seat_00000000000f');
    expect(session()?.retained_seats?.op).toBeUndefined();
    expect(session()?.swapping).toBeUndefined();
    const log = readFileSync(join(dir, '.agents', LOG_FILE), 'utf8');
    expect(log).toContain('stopped op for a swap');
    expect(log).toContain('op runs its new agent (swap started by owner at 2026-10-15T10:00:00.000Z)');
  });

  test('a launch that never reached ready keeps the record', async () => {
    await stopOp();
    // The workspace is never created: the seat is left at launched, not ready.
    const io = testIo(dir, owner);
    const code = await runAdd(['op'], io, addWorld(false));
    expect(code, `add said:\n${io.out}\n${io.err}`).not.toBe(0);
    expect(io.out).toContain('its workspace was not created');
    expect(session()?.seats.op?.stage).toBe('launched');
    // The gap is still a swap in progress, not a lost lead.
    expect(session()?.swapping?.op?.by).toBe('owner');
  });

  test('a lead at a prompt is left as it is, and no swap is recorded', async () => {
    record('op', 'w5:p1', 'w5');
    const made = stopWorld({ kind: 'question' }, 'idle');
    made.agents.push({ name: 'op', agent: 'claude', pane: 'w5:p1', workspace: 'w5', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['op', '--keep', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: op is blocked at a prompt, which team never answers\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(session()?.swapping).toBeUndefined();
  });

  test('a lead on an unrecognised screen is left as it is, with the owner\'s way out named', async () => {
    record('op', 'w5:p1', 'w5');
    const made = stopWorld({ kind: 'unknown' } as Screen, 'idle');
    made.agents.push({ name: 'op', agent: 'claude', pane: 'w5:p1', workspace: 'w5', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['op', '--keep', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toBe(
      'team remove: op shows a screen the profile does not recognise; left as it is (team remove op --abandon closes its workspace without typing)\n',
    );
    expect(made.typed).toEqual([]);
    expect(session()?.swapping).toBeUndefined();
  });

  test('the operator is not a lead: the map refuses it before any grant is read, and no swap is recorded', async () => {
    approve(GRANTED);
    record('lead', 'w0:p1', 'w0');
    record('op', 'w5:p1', 'w5');
    const made = stopWorld();
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const io = testIo(dir, op);
    expect(await runRemove(['lead', '--keep'], io, made.sources)).toBe(1);
    // The map admits the owner or this team's `leads`; the operator is neither, so the run
    // stops there and the grant's own swap gate is never asked.
    expect(io.err).toBe('team remove: only the owner or `leads` removes a seat; this call is op\n');
    expect(made.closed).toEqual([]);
    expect(session()?.swapping).toBeUndefined();
  });

  test('a delegate entry with `remove` and no `swap` never reaches a lead', async () => {
    approve(DELEGATED);
    record('lead', 'w0:p1', 'w0');
    const made = stopWorld();
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const io = testIo(dir, pilot);
    // The real gate, with only what it cannot know on its own: the approval-store home, and
    // the herdr answers a machine without herdr cannot give (an empty session, still running).
    const sources = {
      ...made.sources,
      delegateGate: (input: Parameters<typeof delegateGate>[0]) =>
        delegateGate({ ...input, home, sources: { agents: () => [], sessionRunning: () => true } }),
    };
    expect(await runRemove(['lead', '--keep'], io, sources)).toBe(1);
    expect(io.err).toBe(
      'team remove: the approved delegate main/w1:p1 may not swap a lead seat (`swap`); its approved commands are up, remove\n',
    );
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(session()?.swapping).toBeUndefined();
  });
});
