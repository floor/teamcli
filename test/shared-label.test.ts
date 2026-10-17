import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { formatPlan, upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { emptySession } from '../src/state.ts';
import { compare } from '../src/status/compare.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import type { Machine } from '../src/watch/machine.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';

const SHARED = `format: 1
project: acme
coordinator: coordinator
operator: coordinator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: coordinator
    label: claude opus 5.5
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: implementer
    label: claude opus 5.5
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function seat(name: string, label: string): UpSeat {
  return {
    name,
    cli: 'claude-code',
    launch: 'claude --model claude-opus-5-5',
    cwd: '.',
    label,
    repairLine: `\`team remove ${name} --keep\` then \`team add ${name}\``,
    stopped: false,
    rules: 'Rules.',
  };
}

describe('a shared label', () => {
  test("the repository's own team file validates", () => {
    const text = readFileSync(new URL('../.github/team.yaml', import.meta.url), 'utf8');
    const result = validateTeamFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.team.seats.map((item) => item.name)).toContain('claude-coordinator');
    expect(result.team.seats.map((item) => item.name)).toContain('claude-implementer');
    expect(result.team.seats.filter((item) => item.label === 'claude opus 5.5').length).toBeGreaterThan(1);
  });

  test('two seats may share a label, and each is found by its name', () => {
    const team = valid(SHARED);
    expect(team.seats.map((item) => item.name)).toEqual(['coordinator', 'implementer']);
    expect(team.seats.every((item) => item.label === 'claude opus 5.5')).toBe(true);
    expect(team.seats.find((item) => item.name === 'coordinator')?.name).toBe('coordinator');
    expect(team.seats.find((item) => item.name === 'implementer')?.name).toBe('implementer');
  });

  test('the plan titles a workspace with the label and looks the pane up by the name', () => {
    const plan = formatPlan(upPlan({
      root: '/work/acme',
      session: 'acme',
      sessionRunning: true,
      seats: [seat('coordinator', 'claude opus 5.5'), seat('implementer', 'claude opus 5.5')],
      watchAlive: true,
      watchLabel: 'Watch · scratch',
    }));
    expect(plan).toContain("--label 'claude opus 5.5'");
    expect(plan).toContain('<pane of coordinator>');
    expect(plan).toContain('<pane of implementer>');
    expect(plan).not.toContain('<pane of claude opus 5.5>');
  });

  test('a later step for one seat does not run in the other seat\'s pane', async () => {
    const made = new Map<string, { pane: string; workspace: string }>();
    const ran: { seat: string; pane: string; command: string }[] = [];
    let n = 0;
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => {
        n += 1;
        const place = { pane: `p${n}`, workspace: `w${n}` };
        made.set(label + n, place);
        return place;
      },
      paneRun: (_session, pane, command) => {
        ran.push({ seat: pane, pane, command });
        return true;
      },
      typeLine: () => false,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: () => {},
    };
    const steps: Step[] = [
      { kind: 'run', argv: [], do: { do: 'create', seat: 'coordinator', label: 'claude opus 5.5', cwd: '/a', repairLine: '`team down` then `team up` (to restart the whole team)' } },
      { kind: 'run', argv: [], do: { do: 'create', seat: 'implementer', label: 'claude opus 5.5', cwd: '/b', repairLine: '`team remove implementer --keep` then `team add implementer`' } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'coordinator', label: 'claude opus 5.5', command: 'echo coordinator' } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'implementer', label: 'claude opus 5.5', command: 'echo implementer' } },
    ];
    await executePlan(steps, 'acme', host);
    expect(ran).toEqual([
      { seat: 'p1', pane: 'p1', command: 'echo coordinator' },
      { seat: 'p2', pane: 'p2', command: 'echo implementer' },
    ]);
  });

  test('status keeps a row per name, and a stray agent stays in the workspace recorded for that name', () => {
    const team = valid(SHARED.replaceAll('    label: claude opus 5.5\n', ''));
    const shared = {
      ...team,
      seats: team.seats.map((item) => ({ ...item, label: 'claude opus 5.5' })),
    };
    const live = {
      running: true,
      agents: [
        { name: null, agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
      ],
      workspaces: [
        { id: 'w1', label: 'claude opus 5.5' },
        { id: 'w2', label: 'claude opus 5.5' },
      ],
      screens: {},
    };
    const state = emptySession();
    state.seats.implementer = { stage: 'launched', workspace: 'w2', pane: 'w2:p1' };
    state.seats.coordinator = { stage: 'launched', workspace: 'w1', pane: 'w1:p1' };
    const out = compare(shared, 'acme', state, live, new Date('2026-10-04T12:00:00Z'), team.watch);
    expect(out.rows.map((row) => row.name)).toEqual(['coordinator', 'implementer']);
    expect(out.rows.find((row) => row.name === 'coordinator')?.pane).toBe('-');
    expect(out.rows.find((row) => row.name === 'implementer')?.pane).toBe('w2:p1');
    expect(out.differences.some((item) => item.what.startsWith('coordinator:') && item.what.includes('unnamed'))).toBe(false);
  });

  test('the watch nudges the idle seat\'s pane, not the operator that shares its label', () => {
    const team = valid(SHARED);
    const idle = CLAUDE_IDLE;
    const live = {
      running: true,
      agents: [
        { name: 'coordinator', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
        { name: 'implementer', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
      ],
      workspaces: [
        { id: 'w1', label: 'claude opus 5.5' },
        { id: 'w2', label: 'claude opus 5.5' },
      ],
      screens: { 'w1:p1': idle, 'w2:p1': idle },
    };
    const memory = newMemory();
    memory.pending = ['coordinator asked a question'];
    memory.pendingSince = 0;
    const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
    const result = pass({
      team, state: emptySession(), live, machine: fine, now: 0, memory, approval: [], watch: team.watch,
    });
    expect(result.nudge?.pane).toBe(live.agents[1]?.pane);
  });
});

describe('down and remove with one label on two seats', () => {
  test('down types into each seat\'s own pane', async () => {
    const root = mkdtempSync(join(tmpdir(), 'team-shared-down-'));
    mkdirSync(join(root, '.agents'));
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, SHARED);
    const typed: string[] = [];
    const panes: string[] = [];
    // Each pane has its own box: one seat's typed text never sits in another seat's pane.
    const boxes = new Map<string, string>([['w1:p1', claudeBox('')], ['w2:p1', claudeBox('')]]);
    const agents: HerdrAgent[] = [
      { name: 'coordinator', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
      { name: 'implementer', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
    ];
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const home = join(root, 'home');
    mkdirSync(home);
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: SHARED },
      loaded.team.seats,
      home,
    );
    const sources: DownSources = {
      sessionRunning: () => true,
      agents: () => agents,
      alive: () => false,
      now: () => new Date(0),
      home,
      screen: () => ({ kind: 'idle' }),
      screenText: (_session, pane) => boxes.get(pane),
      status: () => 'idle',
      foreground: () => ['claude'],
      launch: {
        typeText: (_session, pane, text) => { typed.push(text); panes.push(pane); boxes.set(pane, claudeBox(text)); return true; },
        sendKey: () => true,
        pressEnter: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => new Date(0),
      },
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--file', file], io, sources);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(panes).toEqual(['w1:p1', 'w2:p1']);
    expect(typed).toEqual(['/exit', '/exit']);
  });

  test('remove types into the named seat\'s pane', async () => {
    const root = mkdtempSync(join(tmpdir(), 'team-shared-remove-'));
    mkdirSync(join(root, '.agents'));
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, SHARED);
    // The approval in force a run that stops a seat and edits the file needs.
    const home = join(root, 'home');
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: SHARED },
      loaded.team.seats,
      home,
    );
    const panes: string[] = [];
    let box: string | undefined = claudeBox('');
    const sources: RemoveSources = {
      home,
      sessionRunning: () => true,
      agents: () => [
        { name: 'coordinator', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
        { name: 'implementer', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
      ],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => box,
      status: () => 'idle',
      now: () => new Date(0),
      sleep: async () => {},
      foreground: () => ['claude'],
      launch: {
        typeText: (_session, pane, text) => { panes.push(`${pane}:${text}`); box = claudeBox(text); return true; },
        sendKey: () => true,
        pressEnter: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => new Date(0),
      },
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runRemove(['implementer', '--file', file], io, sources);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(panes).toEqual(['w2:p1:/exit']);
  });
});

describe('an approval from before shared labels', () => {
  test('a file that already wrote its labels still matches the approval', () => {
    const text = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
    const team = valid(text);
    expect(fingerprints(team).seats.lead).toBe(
      '21a216ffade36f87249b66e39ada2b3fdc849a73543e320e3ce5e1a5ceac3e2f',
    );
    const root = mkdtempSync(join(tmpdir(), 'team-shared-approve-'));
    const home = join(root, 'home');
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeApproval(storePath(team.project, root, home), { approval: approvalOf(team, root), file: text }, team.seats, home);
    expect(approvalDifferences(team, root, home)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
