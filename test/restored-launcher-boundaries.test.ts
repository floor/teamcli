// A restored seat that runs outside its launcher is flagged, with the repair named — and nothing
// relaunches it. The boundaries around the flag: the process team launched is never flagged, a
// plain launch line is never called a launcher, and the restart a lead is told apart from an
// ordinary seat's. The scenes drive the real pass, never a hand-built observation.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import type { CheckSources } from '../src/check/team.ts';
import { check, loadConfig } from '../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
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
import { deliverBriefs, testIo } from './helpers.ts';

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
const leadNote = (seat: string) =>
  `${seat}: started by a launcher; team cannot tell its process from the one it launched`;
const RESTART_SEAT = 'team restart deepseek-acme';
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
    // launcher's alone, and it names the restart — the pass reports, it launches nothing and
    // types nothing.
    expect(result.reports.map((report) => report.text)).toEqual([launcherLine('deepseek-acme', RESTART_SEAT)]);
    expect(result.work).toEqual([]);
    expect(result.ring).toBeNull();
  });

  test('a lead\'s flag is a note, and no command stops the team', () => {
    const state = recorded('claude-coordinator-acme', 'w1', 600, 601, 'kept');
    const scene = live({ 'claude-coordinator-acme': { session: 'kept' } });
    expect(texts(teamOf(withLauncherLead), state, scene, newMemory(), { 'w1:p1': { shell: 600, foreground: [602] } }))
      .toEqual([leadNote('claude-coordinator-acme')]);
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
        leadNote('claude-coordinator-acme'),
        'claude-coordinator-acme runs Claude Fable 5.1; the registry says Claude Opus 5.5: it signs with the wrong model — '
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
    // …for a second pass in a row, so the one-pass flicker grace is over and the mark is gone.
    expect(at({ 'w3:p1': { shell: 400, foreground: [401] } })).toEqual([]);
    // A process team did not launch, anew, is a new change and reported anew.
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

// The same fact through all three readings: a lead's own seat draws a note in `status`, no
// difference in `status` or `check`, and only the launcher warning in `doctor`; an ordinary seat
// draws the per-seat restart everywhere, never the whole-team one.
describe('a restored seat outside its launcher, in status, check and doctor', () => {
  const NOW = new Date('2026-10-03T14:10:00Z');
  const claudeScreen = (model: string) =>
    `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

  function doctorSources(home: string): DoctorSources {
    return {
      version: () => '2.1.288 (Claude Code)',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
    };
  }

  /** The example's team with `seat` recorded as launched and the pane holding a process team did
   *  not launch under the session its launch stored: the restored seat, through the real passes. */
  function scene(text: string, seat: string, workspace: string) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restored-launcher-')));
    const dir = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    mkdirSync(home);
    const file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, text);
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.watch = { pid: 1, heartbeat: '2026-10-03T14:09:00Z' };
      session.seats[seat] = {
        stage: 'ready',
        pane: `${workspace}:p1`,
        workspace,
        launched: { shell: 400, cli: [401] },
        agent_session: 'kept',
      };
    });
    // The launch delivered the general brief before it typed: the seat's record and its state entry.
    deliverBriefs({ dir: join(dir, '.agents'), root: dir, session: 'acme-web', seats: [seat], home, at: NOW.toISOString() });
    const agentAt = (name: string, pane: string, status: string, kind = 'claude'): HerdrAgent => ({
      name,
      agent: kind,
      pane,
      workspace: pane.split(':')[0]!,
      status,
      cwd: null,
      ...(name === seat ? { session: 'kept' } : {}),
    });
    const live: Live = {
      running: true,
      agents: [
        agentAt('claude-coordinator-acme', 'w1:p1', 'working'),
        agentAt('codex-acme', 'w2:p1', 'idle', 'codex'),
        agentAt('deepseek-acme', 'w3:p1', 'working'),
        agentAt('deepseek-acme-2', 'w4:p1', 'done'),
      ],
      // The labels the file's own seats give, so `check` has nothing to register.
      workspaces: [
        { id: 'w1', label: 'claude-coordinator-acme · project coordinator' },
        { id: 'w2', label: 'codex-acme · implementer' },
        { id: 'w3', label: 'deepseek-acme · implementer' },
        { id: 'w4', label: 'deepseek-acme-2 · implementer' },
        { id: 'w9', label: watchLabel('acme-web') },
      ],
      screens: { 'w1:p1': claudeScreen('Opus 5.5') },
      processes: { [`${workspace}:p1`]: { shell: 500, foreground: [501] } },
    };
    const checked = validateTeamFile(text);
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    return { base, dir, home, file, text, live, team: checked.team };
  }

  function statusSources(s: ReturnType<typeof scene>): StatusSources {
    return {
      live: () => s.live,
      branch: () => 'main',
      standing: () => verifiedOf(s.team, s.text, s.dir, NOW),
      now: () => NOW,
    };
  }

  function checkSources(s: ReturnType<typeof scene>): CheckSources {
    return {
      live: () => s.live,
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
      home: s.home,
    };
  }

  test('a lead\'s own seat: a note in status, no difference in status or check, and no restart in doctor', async () => {
    // The coordinator — both `coordinator` and `operator` name it — started through a launcher.
    const s = scene(example.replace('    launch: claude --model claude-opus-5-5', '    launch: team-claude'), 'claude-coordinator-acme', 'w1');
    try {
      const statusIo = testIo(s.dir, { kind: 'owner' });
      const statusCode = await runStatus(['--file', s.file], statusIo, statusSources(s));
      // The seat is still the running one — the reading is a note, not a difference, and starts
      // nothing. No command in it stops the team.
      expect(statusCode).toBe(0);
      expect(statusIo.out).toMatch(/claude-coordinator-acme\s+working\s+Claude Opus 5\.5\s+w1:p1/);
      expect(statusIo.out).toContain(`note: ${leadNote('claude-coordinator-acme')}\n`);
      expect(statusIo.out).toEndWith('no differences\n');
      expect(statusIo.out).not.toContain('difference:');
      expect(statusIo.out).not.toContain('team restart');
      expect(statusIo.out).not.toContain('team down, then team up');

      const checkIo = testIo(s.dir, { kind: 'owner' });
      const checkCode = await check(['--file', s.file], checkIo, loadConfig, checkSources(s));
      expect(checkCode).toBe(0);
      expect(checkIo.out).toEndWith('no differences\n');
      expect(checkIo.out).not.toContain('difference:');
      expect(checkIo.out).not.toContain('team restart');
      expect(checkIo.out).not.toContain('team down, then team up');

      // Doctor sees the same launcher and answers with its model_from warning alone: no reading
      // sends a lead to a restart of anything.
      const doctorIo = testIo(s.dir, { kind: 'owner' });
      await runDoctor(['--file', '.agents/team.yaml'], doctorIo, doctorSources(s.home));
      expect(doctorIo.out).toContain('claude-coordinator-acme: the launch runs team-claude, not claude, and names no model');
      expect(doctorIo.out).not.toContain('team restart');
      expect(doctorIo.out).not.toContain('team down, then team up');
      expect(doctorIo.out).not.toContain('to restart the whole team');
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test('an ordinary seat: the per-seat restart in status and check, and no restart in doctor', async () => {
    const s = scene(example, 'deepseek-acme', 'w3');
    try {
      const block = 'difference: deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched\n'
        + '  repair: team restart deepseek-acme\n'
        + '  who: the team\'s lead\n';
      const statusIo = testIo(s.dir, { kind: 'owner' });
      const statusCode = await runStatus(['--file', s.file], statusIo, statusSources(s));
      expect(statusCode).toBe(1);
      expect(statusIo.out).toContain(block);
      expect(statusIo.out).toContain('1 difference\n');
      expect(statusIo.out).not.toContain('team down, then team up');

      const checkIo = testIo(s.dir, { kind: 'owner' });
      const checkCode = await check(['--file', s.file], checkIo, loadConfig, checkSources(s));
      expect(checkCode).toBe(1);
      expect(checkIo.out).toContain(block);
      expect(checkIo.out).toContain('1 difference\n');
      expect(checkIo.out).not.toContain('team down, then team up');

      // Doctor names the launcher and stops at the model warning: the repair is the reading's,
      // never a restart doctor would add.
      const doctorIo = testIo(s.dir, { kind: 'owner' });
      await runDoctor(['--file', '.agents/team.yaml'], doctorIo, doctorSources(s.home));
      expect(doctorIo.out).toContain('deepseek-acme: the launch runs team-deepseek, not claude, and names no model');
      expect(doctorIo.out).not.toContain('team restart');
      expect(doctorIo.out).not.toContain('team down, then team up');
      expect(doctorIo.out).not.toContain('to restart the whole team');
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });
});
