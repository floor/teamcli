// The modular watch core must report, nudge and remember exactly what the pass it replaced did.
// `oldPass` below is src/watch/pass.ts as it stood before the checks were split into modules
// (the merge of #45), copied in unchanged — except the one field read the lead's rename moved,
// `team.coordinator` to `team.orchestrator`, the same value under the section's canonical name,
// the unrecognised-screen fail-safe's quiet-unknown line, added to both sides below,
// the model-drift line's restart, which the check now names,
// and the nudge, which now types into the idle seat rather than the operator —
// and used by this file alone. Every scenario runs both
// implementations over the same fixtures, step for step, and demands equal PassResults and equal
// pending state — for a team file without `watch.checks`, which is every fixture here.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Seen } from '../src/budgets/readings.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { SessionState } from '../src/state.ts';
import { WATCH_LABEL } from '../src/status/compare.ts';
import type { Live } from '../src/status/compare.ts';
import { seatModel } from '../src/status/statusline.ts';
import { gb, recordSwap } from '../src/watch/machine.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';
import { withWas } from './helpers.ts';

// --- The pass this branch replaces, verbatim, from src/watch/pass.ts at the merge of #45. ---

type OldMemory = {
  idleSince: Record<string, number>;
  lastWorking: Record<string, number>;
  idleTold: Record<string, number>;
  unsentSince: Record<string, number>;
  active: Set<string>;
  teamIdleSince: number | null;
  teamIdleTold: boolean;
  swap: { at: number; used: number }[];
  pending: string[];
  pendingSince: number | null;
};

function oldNewMemory(): OldMemory {
  return { idleSince: {}, lastWorking: {}, idleTold: {}, unsentSince: {}, active: new Set(), teamIdleSince: null, teamIdleTold: false, swap: [], pending: [], pendingSince: null };
}

type OldReport = { key: string; text: string; to: 'operator' | 'owner' };

const OLD_NUDGE_TEXT = 'Team watch: reports are waiting in .agents/team.log';

type OldPassResult = {
  reports: OldReport[];
  nudge: { pane: string; text: string; pending: string[]; seat: string; cli: string } | null;
  fallback: string | null;
};

const oldMinutes = (ms: number) => Math.floor(ms / 60_000);

function oldPass(
  team: TeamFile, state: SessionState, live: Live, machine: Machine, now: number, memory: OldMemory,
  approval?: string[] | null,
): OldPassResult {
  const reports: OldReport[] = [];
  const current = new Set<string>();
  const once = (key: string, text: string, to: OldReport['to'] = 'operator') => {
    current.add(key);
    if (!memory.active.has(key)) reports.push({ key, text, to });
  };

  const labels = new Map(live.workspaces.map((workspace) => [workspace.id, workspace.label]));
  const known = new Set<string>();
  const workers: { idle: boolean }[] = [];

  const seats = [
    ...team.seats.map((seat) => ({
      name: seat.name,
      cli: seat.cli,
      parked: seat.parked || seat.stopped,
      stopped: seat.stopped,
      seat,
    })),
    ...Object.entries(state.seats).filter(([, recorded]) => recorded.temporary).map(([name, recorded]) => ({
      name,
      cli: team.seats.find((seat) => seat.name === recorded.temporary?.like)?.cli ?? '',
      parked: false,
      stopped: false,
      seat: undefined,
    })),
  ];

  for (const { name, cli, parked, stopped, seat } of seats) {
    const agent = live.agents.find((candidate) => candidate.name === name);
    if (!agent) {
      delete memory.idleSince[name];
      delete memory.lastWorking[name];
      delete memory.unsentSince[name];
      if (live.running && !stopped) once(`missing:${name}`, `${name} is in the file and is not running`);
      continue;
    }
    known.add(agent.pane);
    const lead = name === team.orchestrator || name === team.operator;
    const screen = readScreen(cli, live.screens[agent.pane]);
    const quiet = agent.status === 'idle' || agent.status === 'done';
    const working = agent.status === 'working' || screen.kind === 'working';
    const prompt = screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question';
    if (!lead && !parked) workers.push({ idle: quiet && !working && !prompt });

    if (seat) {
      const running = seatModel(seat, live.screens[agent.pane]);
      if (running && (running.model !== seat.model || running.version !== seat.version)) {
        const repair = name === team.orchestrator || name === team.operator
          ? 'team down, then team up (to restart the whole team)'
          : `team remove ${name} --keep, then team add ${name}`;
        once(`model:${name}`, `${name} runs ${running.model} ${running.version}; the file says ${seat.display}: it signs with the wrong model — ${repair}`);
      }
    }

    if (screen.kind === 'permission' || screen.kind === 'trust') {
      once(`blocked:${name}`, `${name} waits at a permission prompt: its owner's to answer`, 'owner');
    } else if (screen.kind === 'question') {
      once(`question:${name}`, `${name} asked a question: the operator's to act on`);
    } else if (agent.status === 'blocked') {
      once(`blocked:${name}`, `${name} is blocked, and its screen is not one the watch recognises`, 'owner');
    } else if (quiet && screen.kind === 'unknown') {
      once(`unknown:${name}`, `${name}: herdr reports the status "${agent.status}"`);
    } else if (!quiet && agent.status !== 'working') {
      once(`unknown:${name}`, `${name}: herdr reports the status "${agent.status}"`);
    }

    if (!quiet || working || prompt) {
      delete memory.idleTold[name];
      delete memory.unsentSince[name];
      if (working) {
        memory.lastWorking[name] = now;
        delete memory.idleSince[name];
      }
      continue;
    }

    if (screen.kind === 'unsent') {
      memory.unsentSince[name] ??= now;
      if (now - (memory.unsentSince[name] as number) >= team.watch.unsentAfter * 1000) {
        once(`unsent:${name}`, `${name} holds text in its input box that was never sent`);
      }
    } else delete memory.unsentSince[name];

    if (lead || parked) continue;
    const worked = memory.lastWorking[name];
    if (worked === undefined) memory.idleSince[name] ??= now;
    const since = now - (worked ?? (memory.idleSince[name] as number));
    const told = memory.idleTold[name];
    const repeat = team.watch.idleRepeat;
    if (since >= team.watch.idleFirst * 1000 && (told === undefined || (repeat !== undefined && now - told >= repeat * 1000))) {
      memory.idleTold[name] = now;
      reports.push({
        key: `idle:${name}`,
        text: worked === undefined
          ? `${name} has been idle since the watch started`
          : `${name} has been idle for ${oldMinutes(since)} minutes`,
        to: 'operator',
      });
    }
  }

  for (const agent of live.agents) {
    if (known.has(agent.pane) || labels.get(agent.workspace) === WATCH_LABEL) continue;
    once(`extra:${agent.pane}`, `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane}) is running and is not in the file`);
  }

  if (workers.length && workers.every((worker) => worker.idle)) {
    memory.teamIdleSince ??= now;
    if (!memory.teamIdleTold && now - memory.teamIdleSince >= team.watch.teamIdle * 1000) {
      memory.teamIdleTold = true;
      reports.push({ key: 'team-idle', text: 'every agent is idle', to: 'operator' });
    }
  } else {
    memory.teamIdleSince = null;
    memory.teamIdleTold = false;
  }

  // A file with no approval record (`null`) is not a report of its own, here as in the core:
  // the never-approved line was a leftover, and only a difference is the owner's to answer.
  if (approval?.length) once('approval', `the file has changed since the last approval: ${approval.join('; ')}`, 'owner');

  const limits = team.machine;
  if (machine.loadPerCore !== null && machine.loadPerCore > limits.loadMax) {
    once('load', `the load is ${machine.loadPerCore.toFixed(1)} per core, above ${limits.loadMax}`, 'owner');
  }
  if (machine.memoryFree !== null && machine.memoryFree < limits.memoryMin) {
    once('memory', `free memory is ${Math.round(machine.memoryFree)}%, below ${limits.memoryMin}%`, 'owner');
  }
  if (machine.diskFree !== null && machine.diskFree < limits.diskMin) {
    once('disk', `free disk is ${gb(machine.diskFree)}, below ${gb(limits.diskMin)}`, 'owner');
  }
  if (machine.swapFree !== null && machine.swapFree < limits.swapFreeMin) {
    once('swap-free', `free swap is ${gb(machine.swapFree)}, below ${gb(limits.swapFreeMin)}`, 'owner');
  }
  if (machine.swapUsed !== null) {
    const growth = recordSwap(memory.swap, machine.swapUsed, now, limits.swapGrowthWindow);
    if (growth > limits.swapGrowthMax) {
      once('swap-growth', `swap grew by ${gb(growth)} in ${oldMinutes(limits.swapGrowthWindow * 1000)} minutes, above ${gb(limits.swapGrowthMax)}`, 'owner');
    }
  }

  memory.active = current;

  for (const report of reports) {
    if (report.to === 'operator' && !memory.pending.includes(report.text)) {
      memory.pending.push(report.text);
    }
  }
  let nudge: OldPassResult['nudge'] = null;
  let fallback: string | null = null;
  if (memory.pending.length) {
    memory.pendingSince ??= now;
    // The nudge target moved off the operator onto the idle seat. This copy follows that
    // rule; the rest of oldPass is still the pass from the merge of #45.
    const choices: { pane: string; cli: string; seat: string; since: number }[] = [];
    for (const seat of team.seats) {
      if (seat.name === team.operator || seat.name === team.orchestrator || seat.parked || seat.stopped) continue;
      const named = live.agents.filter((agent) => agent.name === seat.name);
      if (named.length !== 1) continue;
      const agent = named[0]!;
      const screen = readScreen(seat.cli, live.screens[agent.pane]);
      if (!((agent.status === 'idle' || agent.status === 'done') && screen.kind === 'idle')) continue;
      choices.push({
        pane: agent.pane,
        cli: seat.cli,
        seat: seat.name,
        since: memory.lastWorking[seat.name] ?? memory.idleSince[seat.name] ?? now,
      });
    }
    choices.sort((a, b) => a.since - b.since || a.seat.localeCompare(b.seat));
    const chosen = choices[0];
    if (chosen) {
      nudge = { pane: chosen.pane, text: OLD_NUDGE_TEXT, pending: memory.pending.slice(), seat: chosen.seat, cli: chosen.cli };
    } else if (now - memory.pendingSince >= team.watch.nudgeWait * 1000) {
      fallback = `no idle seat could be nudged for ${oldMinutes(now - memory.pendingSince)} minutes; ${memory.pending.length} report(s) wait: ${memory.pending.join('; ')}`;
    }
    if (nudge || fallback) {
      memory.pending = [];
      memory.pendingSince = null;
    }
  }
  return { reports, nudge, fallback };
}

// --- The two implementations over the same steps. ---

type Step = {
  live: Live;
  at: number;
  machine?: Machine;
  team?: TeamFile;
  state?: SessionState;
  approval?: string[] | null;
  readings?: Seen[];
};

/** Runs both implementations over one sequence and demands the same result, every step. */
function both(name: string, team: TeamFile, steps: Step[]): void {
  const before = oldNewMemory();
  const after = newMemory();
  for (const step of steps) {
    const file = step.team ?? team;
    const state = step.state ?? emptySession();
    const machine = step.machine ?? fine;
    const was = oldPass(file, state, step.live, machine, step.at, before, step.approval);
    const now = pass({ team: file, watch: file.watch, state, live: step.live, machine, now: step.at, memory: after, approval: step.approval, readings: step.readings });
    // `readings` is the one field the old pass had no idea of (#46, #50); every fixture here
    // names no budget account, so it stays empty and the rest must be equal as before. A step
    // that hands the pass a cache gets it back as it handed it over.
    expect({ name, at: step.at, reports: now.reports, nudge: now.nudge, fallback: now.fallback })
      .toEqual({ name, at: step.at, reports: was.reports, nudge: was.nudge, fallback: was.fallback });
    expect(now.readings).toEqual(step.readings ?? []);
    expect({ name, at: step.at, pending: after.pending, since: after.pendingSince })
      .toEqual({ name, at: step.at, pending: before.pending, since: before.pendingSince });
  }
}

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`).replace('  seats: 6', '  seats: 8');

function valid(source: string): TeamFile {
  const result = validateTeamFile(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const team = () => valid(example);
// The example with codex-acme stopped instead of parked — a stopped seat whose screen the watch
// can read. (The example's own stopped seat, grok-acme, was a CLI with no screens at all to read
// before the grok profile shipped; the captures these tests read are codex's either way.)
const stoppedTeam = () => valid(example.replace('parked: true', 'stopped: true'));

// Screens of Claude Code, as the live team shows them.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const unsent = `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`;
const permission = 'Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n';
const question = 'Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const tight: Machine = { loadPerCore: 6.5, memoryFree: 10, diskFree: 5e9, swapTotal: 23.3e9, swapFree: 0.3e9, swapUsed: 23e9 };
const blind: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null };
const MIN = 60_000;

function agent(name: string | null, workspace: string, status: string, kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team, everyone working, the operator at an empty prompt.
function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle', idle],
    ['claude-coordinator-acme', 'w1', 'working', busy],
    ['codex-acme', 'w2', 'working', ''],
    ['deepseek-acme', 'w3', 'working', busy],
    ['deepseek-acme-2', 'w4', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, name.startsWith('codex') ? 'codex' : 'claude'));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
const codexWorking = readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8');
const codexPermission = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
const codexUnsent = readFileSync(new URL('./fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8')
  .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
const agyIdle = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
const agyWorking = readFileSync(new URL('./fixtures/antigravity/1.2.16/working.txt', import.meta.url), 'utf8');

// One worker per CLI profile, so the idle clock is pinned the same way for each.
const anchorExample = `
format: 1
project: anchor
workspace:
  mode: shared
coordinator: claude-lead
operator: claude-lead
seats:
  - role: coordinator
    name: claude-lead
    label: claude-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: claude-worker
    label: claude-worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: codex-worker
    cli: codex
    vendor: openai
    model: GPT Terra
    version: "5.6"
    launch: codex
  - role: implementer
    name: agy-worker
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
`;

const anchorTeam = () => valid(anchorExample);

function anchorScene(over: Record<string, { status?: string; screen?: string }> = {}): Live {
  const workers = ['claude-worker', 'codex-worker', 'agy-worker'];
  const agents: HerdrAgent[] = [
    { name: 'claude-lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null },
    ...workers.map((name, index) => ({
      name, agent: null, pane: `w${index + 1}:p1`, workspace: `w${index + 1}`, status: 'working', cwd: null,
    })),
  ];
  const screens: Record<string, string> = { 'w0:p1': idle, 'w1:p1': busy, 'w2:p1': codexWorking, 'w3:p1': agyWorking };
  for (const one of agents) {
    const change = over[one.name as string];
    if (!change) continue;
    if (change.status !== undefined) one.status = change.status;
    if (change.screen !== undefined) screens[one.pane] = change.screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('the modular core against the pass it replaced', () => {
  test('a working team reports nothing', () => {
    both('a working team', team(), [{ live: live(), at: 0 }]);
  });

  test('the idle cadence, and work that resets it', () => {
    const quiet = live({ 'deepseek-acme': { status: 'done', screen: idle } });
    both('idle cadence', team(), [
      { live: quiet, at: 0 },
      { live: quiet, at: 9 * MIN },
      { live: quiet, at: 10 * MIN },
      { live: quiet, at: 12 * MIN },
      { live: quiet, at: 29 * MIN },
      { live: quiet, at: 30 * MIN },
      { live: live(), at: 31 * MIN },
      { live: quiet, at: 39 * MIN },
      { live: quiet, at: 41 * MIN },
      { live: quiet, at: 61 * MIN },
    ]);
  });

  test('a parked seat: unsent text and drift are reported, idle is not', () => {
    both('a parked seat', team(), [
      { live: live({ 'codex-acme': { status: 'idle', screen: codexUnsent } }), at: 0 },
      { live: live({ 'codex-acme': { status: 'idle', screen: codexUnsent } }), at: MIN },
      { live: live({ 'codex-acme': { status: 'working', screen: codexWorking } }), at: 2 * MIN },
      { live: live({ 'codex-acme': { status: 'idle' }, 'deepseek-acme': { status: 'idle', screen: idle } }), at: 10 * MIN },
      { live: live({ 'codex-acme': { status: 'idle' }, 'deepseek-acme': { status: 'idle', screen: idle } }), at: 60 * MIN },
    ]);
  });

  test('a stopped seat that runs', () => {
    both('a stopped seat', stoppedTeam(), [
      { live: live({ 'codex-acme': { status: 'idle', screen: codexPermission } }), at: 0 },
      { live: live({ 'codex-acme': { status: 'idle', screen: codexPermission } }), at: MIN },
      { live: live({ 'codex-acme': { status: 'working', screen: codexUnsent } }), at: 2 * MIN },
      { live: live({ 'codex-acme': { status: 'idle', screen: idle } }), at: 30 * MIN },
    ]);
  });

  test('permission, question, blocked and unknown: each once, each again after it clears', () => {
    const stuck = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    const asked = live({ 'deepseek-acme-2': { status: 'blocked', screen: question } });
    const odd = live({ 'deepseek-acme': { status: 'flustered' } });
    // The fail-safe's case: herdr says done, and the profile reads no composer — a stalled seat
    // must be reported, not taken for a free one.
    const stalled = live({ 'codex-acme': { status: 'done', screen: 'Some unknown output without composer\n' } });
    both('attention', team(), [
      { live: stuck, at: 0 },
      { live: stuck, at: MIN },
      { live: live(), at: 2 * MIN },
      { live: stuck, at: 3 * MIN },
      { live: asked, at: 4 * MIN },
      { live: live({ 'codex-acme': { status: 'blocked', screen: '' } }), at: 5 * MIN },
      { live: odd, at: 6 * MIN },
      { live: live(), at: 7 * MIN },
      { live: stalled, at: 8 * MIN },
      { live: stalled, at: 9 * MIN },
      { live: live(), at: 10 * MIN },
    ]);
  });

  test('a missing seat, an agent the file doesn\'t hold, and a wrong model', () => {
    const now = live({ 'claude-coordinator-acme': { screen: busy.replace('Opus 5.5', 'Fable 5.1') } });
    now.agents = now.agents.filter((one) => one.name !== 'deepseek-acme-2');
    now.agents.push(agent('stranger', 'w8', 'working'), agent(null, 'w9', 'working'));
    now.workspaces.push({ id: 'w8', label: 'x' }, { id: 'w9', label: 'watchdog' });
    both('missing and extra', team(), [
      { live: now, at: 0 },
      { live: now, at: MIN },
      { live: live(), at: 2 * MIN },
      { live: { ...live(), running: false }, at: 3 * MIN },
    ]);
  });

  test('a temporary seat of the state is watched as a seat', () => {
    const state = {
      ...emptySession(),
      seats: { 'deepseek-acme-tmp-1': { stage: 'ready' as const, temporary: { like: 'deepseek-acme', until: 'result:out.md' } } },
    };
    const now = live();
    now.agents.push(agent('deepseek-acme-tmp-1', 'w7', 'idle'));
    now.screens['w7:p1'] = permission;
    // The last step leaves through the state, not through the agent: a seat seen running and then
    // gone now says so in its own words ("was running and is gone"), a deliberate change this file
    // cannot compare against the pre-#45 pass — it is pinned in watch.test.ts.
    both('a temporary seat', team(), [
      { live: now, at: 0, state },
      { live: now, at: MIN, state },
      { live: now, at: 2 * MIN, state: emptySession() },
    ]);
  });

  test('a fully idle team is reported once, and again after work', () => {
    const all = live({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'done', screen: idle },
    });
    both('team-idle', team(), [
      { live: all, at: 0 },
      { live: all, at: 10 * MIN },
      { live: all, at: 15 * MIN },
      { live: live(), at: 16 * MIN },
      { live: all, at: 20 * MIN },
      { live: all, at: 31 * MIN },
    ]);
  });

  test('a file that differs from the approved one, never approved, and clean', () => {
    both('approval', team(), [
      { live: live(), at: 0, approval: ['`rules` changed'] },
      { live: live(), at: MIN, approval: ['`rules` changed'] },
      { live: live(), at: 2 * MIN, approval: [] },
      { live: live(), at: 3 * MIN, approval: null },
      { live: live(), at: 4 * MIN },
    ]);
  });

  test('the machine tight, blind, and tight again', () => {
    both('machine', team(), [
      { live: live(), at: 0, machine: tight },
      { live: live(), at: MIN, machine: tight },
      { live: live(), at: 2 * MIN, machine: blind },
      { live: live(), at: 3 * MIN, machine: tight },
      { live: live(), at: 70 * MIN, machine: blind },
    ]);
  });

  test('swap that grows fast, and swap that grows slowly', () => {
    both('swap growth', team(), [
      { live: live(), at: 0, machine: { ...fine, swapUsed: 1e9 } },
      { live: live(), at: 5 * MIN, machine: { ...fine, swapUsed: 1.8e9 } },
      { live: live(), at: 8 * MIN, machine: { ...fine, swapUsed: 2.4e9 } },
      { live: live(), at: 60 * MIN, machine: { ...fine, swapUsed: 1e9 } },
      { live: live(), at: 75 * MIN, machine: { ...fine, swapUsed: 2.4e9 } },
      { live: live(), at: 90 * MIN, machine: { ...fine, swapUsed: 1e9 } },
    ]);
  });

  test('the nudge: delivered, kept while the operator is busy, and the fallback', () => {
    const asked = live({ 'deepseek-acme-2': { status: 'blocked', screen: question } });
    const askedBusy = live({
      'deepseek-acme-2': { status: 'blocked', screen: question },
      'claude-operator-acme': { status: 'working', screen: busy },
    });
    both('the nudge', team(), [
      { live: askedBusy, at: 0 },
      { live: askedBusy, at: 5 * MIN },
      { live: asked, at: 6 * MIN },
      { live: asked, at: 7 * MIN },
      { live: live(), at: 8 * MIN },
      { live: asked, at: 9 * MIN },
    ]);
    both('the nudge fallback', team(), [
      { live: askedBusy, at: 0 },
      { live: askedBusy, at: 9 * MIN },
      { live: askedBusy, at: 10 * MIN },
      { live: askedBusy, at: 20 * MIN },
      { live: asked, at: 21 * MIN },
    ]);
  });

  test('the watch section changes mid-sequence', () => {
    const brisk = valid(example.replace('  idle_first: 10m', '  idle_first: 1m').replace('  idle_repeat: 20m', '  idle_repeat: 2m'));
    const quiet = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    both('a changed watch section', team(), [
      { live: quiet, at: 0 },
      { live: quiet, at: 2 * MIN, team: brisk },
      { live: quiet, at: 5 * MIN, team: brisk },
      { live: quiet, at: 20 * MIN, team: brisk },
      { live: quiet, at: 25 * MIN },
    ]);
  });

  test.each([
    ['claude-worker', busy, idle],
    ['codex-worker', codexWorking, codexIdle],
    ['agy-worker', agyWorking, agyIdle],
  ])('the idle anchor for %s counts from the last working observation', (name, workingScreen, idleScreen) => {
    both(`the idle anchor for ${name}`, anchorTeam(), [
      { live: anchorScene({ [name]: { status: 'working', screen: workingScreen } }), at: 5 * MIN },
      { live: anchorScene({ [name]: { status: 'idle', screen: idleScreen } }), at: 15 * MIN },
      // Herdr lags the transition: its status stays idle while the screen shows the turn running.
      { live: anchorScene({ [name]: { status: 'idle', screen: workingScreen } }), at: 20 * MIN },
      { live: anchorScene({ [name]: { status: 'idle', screen: idleScreen } }), at: 35 * MIN },
      { live: anchorScene({ [name]: { status: 'idle', screen: idleScreen } }), at: 45 * MIN },
    ]);
  });

  test('an unsent coordinator, and a seat that works through it', () => {
    const typed = live({ 'claude-coordinator-acme': { status: 'idle', screen: unsent } });
    both('unsent input', team(), [
      { live: typed, at: 0 },
      { live: typed, at: MIN },
      { live: live(), at: 2 * MIN },
      { live: typed, at: 3 * MIN },
    ]);
  });

  test('a cached reading carrying a point rides both implementations the same way', () => {
    // § 5: this file's whole job is implementation-for-implementation equality, figure for
    // figure. The same step runs twice — with a cache as `observe` leaves it, and with one
    // carrying § 5's valid point — and both implementations report, nudge and remember the same
    // either way, carrying the reading forward exactly as it was handed over.
    const cached: Seen = {
      account: 'openai', window: 'weekly', left: 80, used: 20,
      changedAt: 0, resetsAt: null, seat: 'codex-acme',
      source: 'status_line', confirmed: true,
    };
    const steps = (readings: Seen[]): Step[] => [{ live: live(), at: 0, readings }];
    both('a cache of one plain reading', team(), steps([cached]));
    both('a cache of one reading with a point', team(), steps([withWas(cached)]));
    // Side by side over the pass's own result: the same reports, nudge and fallback, and the
    // same reading record for record — the point is the one field that differs, and it is there.
    const run = (readings: Seen[]) => pass({
      team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine,
      now: 0, memory: newMemory(), approval: null, readings,
    });
    const plain = run([cached]);
    const pointed = run([withWas(cached)]);
    expect(pointed.reports).toEqual(plain.reports);
    expect(pointed.nudge).toEqual(plain.nudge);
    expect(pointed.fallback).toEqual(plain.fallback);
    const bare = (one: Seen) => Object.fromEntries(Object.entries(one).filter(([field]) => field !== 'was'));
    expect(pointed.readings.map(bare)).toEqual(plain.readings.map(bare));
    // Non-vacuity: the reading really was handed to the pass and came back, the pointed one's
    // point is valid and distinct from the figure beside it, and the plain one carries none.
    expect(plain.readings).toHaveLength(1);
    expect(plain.readings.every((one) => !('was' in one))).toBe(true);
    expect(pointed.readings.some((one) => 'was' in one)).toBe(true);
    expect(withWas(cached).was).toEqual({ left: 87, at: -30 * MIN });
  });
});
