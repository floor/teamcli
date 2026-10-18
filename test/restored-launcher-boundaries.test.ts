// A restored seat that runs outside its launcher is flagged, with the repair named — and nothing
// relaunches it. The boundaries around the flag: the process team launched is never flagged, a
// plain launch line is never called a launcher, and the restart a lead is told apart from an
// ordinary seat's. The scenes drive the real pass, never a hand-built observation.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { usesLauncher } from '../src/launch/line.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { watchLabel } from '../src/watch/pane.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

// The example with a second plain claude seat beside the coordinator, for the scenes that need a
// seat whose line names no launcher and is not the lead the file names.
const OPERATOR = `  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`;
const withOperator = example.replace('seats:\n', `seats:\n${OPERATOR}`).replace('  seats: 6', '  seats: 8');
// The coordinator — the file's one lead: both `coordinator` and `operator` name it — started
// through a launcher: the first word of its line is not the CLI's own binary, so a process team
// did not launch is the CLI without that program.
const withLauncherLead = withOperator.replace(
  '    launch: claude --model claude-opus-5-5\n    mode: shared               # the coordinator reads; it never implements',
  '    launch: team-claude\n    mode: shared               # the coordinator reads; it never implements',
);
// The deepseek seat's line rewritten to start at the CLI's own binary, with the file saying the
// launcher chooses the model: the flag then rests on `model_from`, not on the first word.
const withModelFrom = withOperator.replace(
  '    launch: team-deepseek',
  '    launch: claude --model deepseek-flash-v4.1\n    model_from: launcher',
);

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

describe('what counts as a launcher', () => {
  test('the CLI\'s own binary, bare or behind variable assignments, is not a launcher', () => {
    expect(usesLauncher({ cli: 'claude-code', launch: 'claude --model claude-opus-5-5' })).toBe(false);
    // A shell runs the assignments and then the binary: the program is still the CLI's own.
    expect(usesLauncher({ cli: 'claude-code', launch: 'TEAM_LOBBY=/x claude --model claude-opus-5-5' })).toBe(false);
    expect(usesLauncher({ cli: 'codex', launch: 'codex -m gpt-6-sol -c model_reasoning_effort=high' })).toBe(false);
  });

  test('another first word is a launcher, and so is a line the file says chooses the model there', () => {
    expect(usesLauncher({ cli: 'claude-code', launch: 'team-deepseek' })).toBe(true);
    expect(usesLauncher({ cli: 'claude-code', launch: 'claude --model deepseek-flash-v4.1', modelFrom: 'launcher' })).toBe(true);
  });
});

// The watch fixture: the example's team, everyone working, the operator at an empty prompt.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

function live(over: Partial<Record<string, { status?: string; screen?: string; session?: string }>> = {}): Live {
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
    const one = agent(name, workspace, change.status ?? status, name.startsWith('codex') ? 'codex' : 'claude');
    if (change.session !== undefined) one.session = change.session;
    agents.push(one);
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

/** The state of a seat team launched and recorded: pane `w:p1`, shell 400 or 600, the CLI at 401
 *  or 601, and — with `kept` — the agent session the launch stored, still answering on the pane. */
function recorded(name: string, workspace: string, shell: number, cli: number, kept?: string) {
  const state = emptySession();
  state.seats[name] = {
    stage: 'ready',
    pane: `${workspace}:p1`,
    workspace,
    launched: { shell, cli: [cli] },
    ...(kept === undefined ? {} : { agent_session: kept }),
  };
  return state;
}

function texts(
  team: TeamFile,
  state: ReturnType<typeof recorded>,
  scene: Live,
  memory: ReturnType<typeof newMemory>,
  processes: Record<string, { shell: number; foreground: number[] } | null>,
): string[] {
  return pass({
    team, watch: team.watch, state, live: scene, machine: fine, now: 0, memory, processes,
  }).reports.map((report) => report.text);
}

const GENERIC = 'is no longer the process team launched (its session was restored, or its CLI was restarted)';
const launcherLine = (seat: string, repair: string) =>
  `${seat}: its launch line starts a launcher, and the process in its pane is not the one team launched — ${repair}`;
const RESTART_SEAT = 'team remove deepseek-acme --keep, then team add deepseek-acme';
const RESTART_TEAM = 'team down, then team up (to restart the whole team)';

describe('a restored seat running outside its launcher', () => {
  test('is flagged with the repair line alone, and nothing starts it again', () => {
    const state = recorded('deepseek-acme', 'w3', 400, 401, 'kept');
    const scene = live({ 'deepseek-acme': { session: 'kept' } });
    const memory = newMemory();
    const result = pass({
      team: teamOf(withOperator), watch: teamOf(withOperator).watch, state, live: scene, machine: fine, now: 0, memory,
      processes: { 'w3:p1': { shell: 500, foreground: [501] } },
    });
    // The stored session is on the pane, so the generic line stays quiet: the flag is the
    // launcher's alone, and it names the restart — the pass reports, it launches nothing,
    // and the waiting report rides the nudge carrying that same repair line.
    expect(result.reports.map((report) => report.text)).toEqual([launcherLine('deepseek-acme', RESTART_SEAT)]);
    expect(result.nudge?.pending).toEqual([launcherLine('deepseek-acme', RESTART_SEAT)]);
    expect(result.fallback).toBeNull();
    expect(result.ring).toBeNull();
  });

  test('a lead\'s flag restarts the whole team, not the seat', () => {
    const state = recorded('claude-coordinator-acme', 'w1', 600, 601, 'kept');
    const scene = live({ 'claude-coordinator-acme': { session: 'kept' } });
    expect(texts(teamOf(withLauncherLead), state, scene, newMemory(), { 'w1:p1': { shell: 600, foreground: [602] } }))
      .toEqual([launcherLine('claude-coordinator-acme', RESTART_TEAM)]);
  });

  test('a line the file says picks the model in its launcher is flagged the same', () => {
    const state = recorded('deepseek-acme', 'w3', 400, 401, 'kept');
    const scene = live({ 'deepseek-acme': { session: 'kept' } });
    expect(texts(teamOf(withModelFrom), state, scene, newMemory(), { 'w3:p1': { shell: 500, foreground: [501] } }))
      .toEqual([launcherLine('deepseek-acme', RESTART_SEAT)]);
  });

  test('a model that drifted beside the launcher names both repairs', () => {
    const state = recorded('claude-coordinator-acme', 'w1', 600, 601);
    const drifted = busy.replaceAll('Opus 5.5', 'Fable 5.1');
    const scene = live({ 'claude-coordinator-acme': { screen: drifted } });
    expect(texts(teamOf(withLauncherLead), state, scene, newMemory(), { 'w1:p1': { shell: 600, foreground: [602] } }))
      .toEqual([
        `claude-coordinator-acme ${GENERIC}`,
        launcherLine('claude-coordinator-acme', RESTART_TEAM),
        'claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5: it signs with the wrong model — '
          + RESTART_TEAM,
      ]);
  });

  test('the flag is said once, and a reading herdr cannot give does not say it anew', () => {
    const state = recorded('deepseek-acme', 'w3', 400, 401, 'kept');
    const scene = live({ 'deepseek-acme': { session: 'kept' } });
    const team = teamOf(withOperator);
    const memory = newMemory();
    const at = (processes: Record<string, { shell: number; foreground: number[] } | null>) =>
      texts(team, state, scene, memory, processes);
    expect(at({ 'w3:p1': { shell: 500, foreground: [501] } })).toEqual([launcherLine('deepseek-acme', RESTART_SEAT)]);
    // herdr cannot read the pane: no change, and the mark must survive it.
    expect(at({ 'w3:p1': null })).toEqual([]);
    expect(at({ 'w3:p1': { shell: 500, foreground: [501] } })).toEqual([]);
    // The recorded process in front again: the condition cleared…
    expect(at({ 'w3:p1': { shell: 400, foreground: [401] } })).toEqual([]);
    // …so a process team did not launch, anew, is a new change and reported anew.
    expect(at({ 'w3:p1': { shell: 500, foreground: [501] } })).toEqual([launcherLine('deepseek-acme', RESTART_SEAT)]);
  });
});

describe('what the flag never touches', () => {
  test('the process team launched is never flagged, launcher or not', () => {
    const state = recorded('deepseek-acme', 'w3', 400, 401);
    const memory = newMemory();
    expect(texts(teamOf(withOperator), state, live(), memory, { 'w3:p1': { shell: 400, foreground: [401] } })).toEqual([]);
    // And it stays quiet on the next pass: no mark was ever set.
    expect(texts(teamOf(withOperator), state, live(), memory, { 'w3:p1': { shell: 400, foreground: [401] } })).toEqual([]);
  });

  test('a plain claude seat is not flagged as restored outside a launcher', () => {
    const state = recorded('claude-operator-acme', 'w0', 600, 601);
    expect(texts(teamOf(withOperator), state, live(), newMemory(), { 'w0:p1': { shell: 600, foreground: [602] } }))
      .toEqual([`claude-operator-acme ${GENERIC}`]);
  });

  test('a pane back at its shell is the generic line, never the launcher\'s', () => {
    const state = recorded('deepseek-acme', 'w3', 400, 401);
    expect(texts(teamOf(withOperator), state, live(), newMemory(), { 'w3:p1': { shell: 400, foreground: [400] } }))
      .toEqual([`deepseek-acme ${GENERIC}`]);
  });
});

// `status` names the same restart, and starts nothing: the lead's row stays the running seat.
describe('status names the whole-team restart for a lead outside its launcher', () => {
  const NOW = new Date('2026-10-03T14:10:00Z');
  const claudeScreen = (model: string) =>
    `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

  test('the lead is flagged, its row unchanged, and no repair starts the seat', async () => {
    const base = mkdtempSync(join(tmpdir(), 'team-restored-launcher-'));
    try {
      const dir = join(base, 'acme');
      mkdirSync(join(dir, '.agents'), { recursive: true });
      // The coordinator — operator and coordinator both — started through a launcher.
      const text = example.replace('    launch: claude --model claude-opus-5-5', '    launch: team-claude');
      const file = join(dir, '.agents', 'team.yaml');
      writeFileSync(file, text);
      const checked = validateTeamFile(text);
      if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
      updateState(join(dir, '.agents'), (state) => {
        const session = (state.sessions['acme-web'] ??= emptySession());
        session.watch = { pid: 1, heartbeat: '2026-10-03T14:09:00Z' };
        session.seats['claude-coordinator-acme'] = {
          stage: 'ready',
          pane: 'w1:p1',
          workspace: 'w1',
          launched: { shell: 400, cli: [401] },
          agent_session: 'kept',
        };
      });
      const lead: Live = {
        running: true,
        agents: [
          { ...agent('claude-coordinator-acme', 'w1', 'working'), session: 'kept' },
          agent('codex-acme', 'w2', 'idle', 'codex'),
          agent('deepseek-acme', 'w3', 'done'),
          agent('deepseek-acme-2', 'w4'),
        ],
        workspaces: [
          { id: 'w1', label: 'claude opus 5.5' }, { id: 'w2', label: 'gpt sol 6' },
          { id: 'w3', label: 'deepseek flash v4.1' }, { id: 'w4', label: 'deepseek flash v4.1-2' }, { id: 'w9', label: watchLabel('acme-web') },
        ],
        screens: { 'w1:p1': claudeScreen('Opus 5.5') },
        processes: { 'w1:p1': { shell: 500, foreground: [501] } },
      };
      const sources: StatusSources = {
        live: () => lead,
        branch: () => 'main',
        standing: () => verifiedOf(checked.team, text, dir, NOW),
        now: () => NOW,
      };
      const io = testIo(dir, { kind: 'owner' });
      const code = await runStatus(['--file', file], io, sources);
      // The seat is still the running one — the report says what is, and starts nothing.
      expect(code).toBe(1);
      expect(io.out).toMatch(/claude-coordinator-acme\s+working\s+Claude Opus 5\.5\s+w1:p1/);
      expect(io.out).not.toMatch(/claude-coordinator-acme\s+restored, not launched by team/);
      expect(io.out).toContain(
        'difference: claude-coordinator-acme: its launch line starts a launcher, and the process in its pane is not the one team launched\n'
          + '  repair: team down, then team up (to restart the whole team)\n',
      );
      expect(io.out).not.toContain('  repair: team up\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
