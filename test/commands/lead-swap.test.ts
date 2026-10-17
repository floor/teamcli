// The agent on a lead seat (the orchestrator's or the operator's) is swapped with
// `team remove <lead> --keep` then `team add <lead>`. The file is never edited for it — a lead
// is never `stopped:` — the stop keeps every safety of an ordinary stop, the swap is the owner's,
// the granted seat's (`grant.scope: [swap]`) or an approved delegate's (`commands: [swap]`), and a
// seat never swaps itself.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { swapFindings } from '../../src/commands/doctor.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { LOG_FILE, emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { Screen } from '../../src/watch/screen.ts';
import { claudeBox, testIo } from '../helpers.ts';

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
workspace:
  mode: shared
  base: main
seats:
${SEAT('lead', 'coordinator')}${SEAT('op', 'operator')}${SEAT('worker', 'implementer')}`;

const GRANTED = `${BASE}grant:
  session: acme
  seat: lead
  scope: [swap]
`;

const owner = { kind: 'owner' as const };
const lead = { kind: 'seat' as const, name: 'lead', pane: 'w0:p1', session: 'acme' };
const op = { kind: 'seat' as const, name: 'op', pane: 'w5:p1', session: 'acme' };

let dir: string;
let file: string;
let home: string;
let clock: number;

function approve(text: string): void {
  writeFileSync(file, text);
  const loaded = loadTeamFile(dir);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root), file: text }, loaded.team.seats, home);
}

function record(name: string, pane: string, workspace: string, id?: string): void {
  updateState(join(dir, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats[name] = { stage: 'ready', pane, workspace, ...(id ? { id } : {}) };
  });
}

function world(screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources; typed: string[]; closed: string[]; agents: HerdrAgent[];
} {
  const typed: string[] = [];
  const closed: string[] = [];
  let sent = false;
  let box: string | undefined = claudeBox('');
  const agents: HerdrAgent[] = [];
  clock = 0;
  const launch: DownLaunch = {
    typeText: (_s, _p, text) => { typed.push(text); box = claudeBox(text); return true; },
    sendKey: () => { box = claudeBox(''); return true; },
    pressEnter: () => { sent = true; return true; },
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_s, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const sources: RemoveSources = {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    screenText: () => box,
    status: () => status,
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    launch,
    foreground: () => (sent ? [] : ['claude']),
  };
  return { sources, typed, closed, agents };
}

function listed(made: ReturnType<typeof world>, name: string, pane: string, workspace: string, status = 'idle'): void {
  made.agents.push({ name, agent: 'claude', pane, workspace, status, cwd: null });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-swap-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  home = join(dir, 'home');
  approve(BASE);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('swapping a lead seat', () => {
  test('the owner stops the orchestrator for a swap: the file is untouched and the state records the swap', async () => {
    const id = 'seat_0123456789ab';
    record('lead', 'w0:p1', 'w0', id);
    const made = world();
    listed(made, 'lead', 'w0:p1', 'w0');
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--file', file], io, made.sources)).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('stopped lead for a swap');
    expect(io.out).toContain('`team add lead` starts its new agent');
    // The file is byte for byte the approved one: no `stopped:` on the lead, nothing re-signed.
    expect(readFileSync(file, 'utf8')).toBe(BASE);
    expect(validateTeamFile(readFileSync(file, 'utf8')).ok).toBe(true);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual(['w0']);
    const session = readState(join(dir, '.agents')).sessions.acme;
    expect(session?.seats.lead).toBeUndefined();
    expect(session?.retained_seats?.lead?.id).toBe(id);
    expect(session?.swapping?.lead?.by).toBe('owner');
    expect(readFileSync(join(dir, '.agents', LOG_FILE), 'utf8')).toContain('stopped lead for a swap');
  });

  test('a working lead is never swapped, by the owner either', async () => {
    record('lead', 'w0:p1', 'w0');
    const made = world({ kind: 'working' }, 'working');
    listed(made, 'lead', 'w0:p1', 'w0', 'working');
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toContain('lead is working; left as it is');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readState(join(dir, '.agents')).sessions.acme?.swapping).toBeUndefined();
  });

  test('a lead holding unsent text is not swapped', async () => {
    record('lead', 'w0:p1', 'w0');
    const made = world({ kind: 'unsent' } as Screen, 'idle');
    listed(made, 'lead', 'w0:p1', 'w0');
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toContain('holds unsent text');
    expect(made.typed).toEqual([]);
    expect(readState(join(dir, '.agents')).sessions.acme?.swapping).toBeUndefined();
  });

  test('a seat never swaps itself, even under a grant that lists swap', async () => {
    approve(GRANTED);
    record('lead', 'w0:p1', 'w0');
    const made = world();
    listed(made, 'lead', 'w0:p1', 'w0');
    const io = testIo(dir, lead);
    expect(await runRemove(['lead', '--keep'], io, made.sources)).toBe(1);
    expect(io.err).toContain("lead can't swap its own seat");
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(GRANTED);
  });

  test('the orchestrator swaps the operator under a grant that lists swap, and the grant line is logged', async () => {
    approve(GRANTED);
    record('lead', 'w0:p1', 'w0');
    record('op', 'w5:p1', 'w5');
    const made = world();
    listed(made, 'op', 'w5:p1', 'w5');
    const io = testIo(dir, lead);
    expect(await runRemove(['op', '--keep'], io, made.sources)).toBe(0);
    expect(made.closed).toEqual(['w5']);
    expect(readFileSync(file, 'utf8')).toBe(GRANTED);
    expect(readState(join(dir, '.agents')).sessions.acme?.swapping?.op?.by).toBe('lead');
    const log = readFileSync(join(dir, '.agents', LOG_FILE), 'utf8');
    expect(log).toContain('[grant] lead swap: op');
    expect(log).toContain('stopped op for a swap');
  });

  test('without a grant that lists swap, a lead seat may not swap the other', async () => {
    record('lead', 'w0:p1', 'w0');
    record('op', 'w5:p1', 'w5');
    const made = world();
    listed(made, 'op', 'w5:p1', 'w5');
    const io = testIo(dir, lead);
    expect(await runRemove(['op', '--keep'], io, made.sources)).toBe(1);
    expect(io.err).toBe("team remove: only the owner, the granted seat or an approved delegate swaps the orchestrator's or the operator's seat: the file grants nothing\n");
    expect(made.typed).toEqual([]);
  });

  test('a grant without swap does not admit it', async () => {
    approve(GRANTED.replace('scope: [swap]', 'scope: [up, down]'));
    record('lead', 'w0:p1', 'w0');
    record('op', 'w5:p1', 'w5');
    const made = world();
    listed(made, 'op', 'w5:p1', 'w5');
    const io = testIo(dir, lead);
    expect(await runRemove(['op', '--keep'], io, made.sources)).toBe(1);
    expect(io.err).toContain('the grant does not list `swap`');
    expect(made.closed).toEqual([]);
  });

  test('taking a lead out of the file stays the owner\'s, whatever the grant says', async () => {
    approve(GRANTED);
    record('lead', 'w0:p1', 'w0');
    const made = world();
    listed(made, 'op', 'w5:p1', 'w5');
    const io = testIo(dir, lead);
    expect(await runRemove(['op'], io, made.sources)).toBe(1);
    expect(io.err).toBe("team remove: only the owner removes the orchestrator's or the operator's seat; this call is lead\n");
  });

  test('an approved delegate swaps the orchestrator when the gate passes the swap', async () => {
    approve(`${BASE}delegates:\n  - pane: main/w1:p1\n    commands: [swap]\n`);
    record('lead', 'w0:p1', 'w0');
    const made = world();
    listed(made, 'lead', 'w0:p1', 'w0');
    const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w1:p1', session: 'main' };
    const asked: Array<{ command: string; swap?: boolean }> = [];
    const io = testIo(dir, pilot);
    const code = await runRemove(['lead', '--keep'], io, {
      ...made.sources,
      delegateGate: (input) => { asked.push({ command: input.command, swap: input.swap }); return { kind: 'passed', pane: 'main/w1:p1' }; },
    });
    expect(code).toBe(0);
    expect(asked).toEqual([{ command: 'remove', swap: true }]);
    expect(readState(join(dir, '.agents')).sessions.acme?.swapping?.lead?.by).toBe('pilot');
    expect(readFileSync(join(dir, '.agents', LOG_FILE), 'utf8')).toContain('[delegate] main/w1:p1 swap: lead');
  });

  test('doctor names a swap in progress, and says nothing once the seat runs again', () => {
    const agents = join(dir, '.agents');
    updateState(agents, (state) => {
      (state.sessions.acme ??= emptySession()).swapping = { lead: { by: 'owner', at: '2026-10-15T07:00:00.000Z' } };
    });
    const loaded = loadTeamFile(dir);
    if (!loaded.ok) throw new Error('fixture');
    expect(swapFindings(loaded.team, agents, 'acme')).toEqual([
      { level: 'warn', text: 'lead: stopped for a swap by owner at 2026-10-15T07:00:00.000Z; run `team add lead` to start its new agent' },
    ]);
    record('lead', 'w9:p1', 'w9');
    expect(swapFindings(loaded.team, agents, 'acme')).toEqual([]);
  });

  test('a stopped lead in a hand-edited file is still refused at validation', () => {
    const text = BASE.replace('    launch: claude --model claude-opus-5-5\n  - role: operator', '    launch: claude --model claude-opus-5-5\n    stopped: true\n  - role: operator');
    const parsed = validateTeamFile(text);
    expect(parsed.ok).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});
