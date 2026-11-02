// Every Codex seat launches with one pinned feature set, and the seat's recorded
// launch line carries it. Codex keeps one background server behind every seat; a second front end
// whose feature settings differ is refused with "background server has incompatible feature
// settings", and the seat that answers "Run without daemon" loses the route its drops arrive on.
// The scenes drive the real plan and the two report commands: the pin rides the launch and the
// record, `team doctor` and `team check` name a recorded line that lacks it (never a process's
// command line), and a record with no line says unknown.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan } from '../src/launch/plan.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { profileFor } from '../src/profiles/index.ts';
import { emptySession, updateState, type SeatState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { testIo, gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-02T09:00:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const CLI = 'zsh /w/as-floor.sh codex -m gpt-6.1-sol';
const PIN = 'features.mcp_oauth_refresh_coordination=false';
const PINNED = `${CLI} -c ${PIN}`;
// Neutral fixture ids: the host's pane and workspace shapes are never written into a test.
const PANE_ONE = 'fixture-pane-one';
const PANE_TWO = 'fixture-pane-two';
const WS_ONE = 'fixture-workspace-one';
const WS_TWO = 'fixture-workspace-two';

const TEAM = `format: 1
project: acme
session: acme
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

  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: zsh /w/as-floor.sh codex -m gpt-6.1-sol
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(): { root: string; home: string; dir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-codex-features-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  writeFileSync(join(dir, 'team.yaml'), TEAM);
  return { root, home, dir };
}

/** The seat's record as a launch before the pin left it: a base recipe with no feature words. */
function seed(dir: string, held: Partial<SeatState>): void {
  updateState(dir, (state) => {
    state.sessions[SESSION] = {
      ...emptySession(),
      seats: { [SEAT]: { stage: 'ready', pane: PANE_TWO, workspace: WS_TWO, ...held } },
    };
  });
}

function baseHost(records: { seat: string; patch: Record<string, unknown> }[]): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: () => true,
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => ['p1'],
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (seat, patch) => {
      records.push({ seat, patch });
    },
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
  };
}

describe('the launch line carries the pin', () => {
  test('the pin rides after the seat’s own words, including a resume, and before a rules line', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    const command = launchCommand(
      profile,
      'zsh /w/as-floor.sh codex -m gpt-6.1-sol resume 01a1',
      'Rules.',
      undefined,
      undefined,
      undefined,
      undefined,
      'Read /x/rules.md; reply ready.',
    );
    expect(command).toContain(`resume 01a1`);
    expect(command).toContain(`-c ${PIN}`);
    expect(command.indexOf(`-c ${PIN}`)).toBeGreaterThan(command.indexOf('resume 01a1'));
    expect(command.indexOf(`-c ${PIN}`)).toBeLessThan(command.indexOf('Read /x/rules.md'));
  });

  test('a line that sets the feature the other way is overridden by the trailing pin', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    const command = launchCommand(profile, 'codex -m gpt-6.1-sol -c features.mcp_oauth_refresh_coordination=true', 'Rules.');
    // The file's own word stays on the line; the pin is the last word for that key, and the last
    // value is the one the CLI reads (measured on codex-cli 0.161.0 in a scratch CODEX_HOME).
    expect(command).toContain('-c features.mcp_oauth_refresh_coordination=true');
    expect(command.lastIndexOf('features.mcp_oauth_refresh_coordination')).toBe(command.indexOf(`-c ${PIN}`) + 3);
  });

  test('a positional delimiter keeps the pin an option, in every spelling', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    for (const delimiter of ['--', "'--'", '"--"']) {
      const command = launchCommand(
        profile,
        `codex -m gpt-6.1-sol ${delimiter} 'an existing prompt'`,
        'Rules.',
        undefined,
        undefined,
        undefined,
        undefined,
        'Read /x/rules.md; reply ready.',
      );
      // The shell drops the quotes: the delimiter is the same word after parsing, and the pin
      // must stand before it to stay a config option rather than prompt text. The existing
      // prompt follows the delimiter; the rules line stays the last positional word.
      expect(command.indexOf(`-c ${PIN}`)).toBeLessThan(command.indexOf('an existing prompt'));
      expect(command.indexOf('an existing prompt')).toBeLessThan(command.indexOf('Read /x/rules.md'));
      expect(command).toContain('Read /x/rules.md; reply ready.');
    }
  });
});

describe('the plan and the record keep the pinned base recipe', () => {
  function planned(): { steps: ReturnType<typeof upPlan>; launch: Extract<NonNullable<ReturnType<typeof upPlan>[number]['do']>, { do: 'launch' }> } {
    const steps = upPlan({
      root: '/tmp/acme', session: SESSION, sessionRunning: true, watchAlive: true, watchLabel: 'Watch · acme',
      stateDir: '/tmp/acme/.agents',
      seats: [{
        name: SEAT, cli: 'codex', launch: CLI, cwd: '/tmp/acme', label: SEAT, stopped: false,
        rules: 'Rules.', repairLine: 'repair',
      }],
    });
    const launch = steps.map((step) => step.do).find((op) => op?.do === 'launch');
    if (launch?.do !== 'launch') throw new Error('the plan holds no launch');
    return { steps, launch };
  }

  test('the launch op carries the pinned base line, never the expanded command', () => {
    const { launch } = planned();
    expect(launch.recordLine).toBe(PINNED);
    expect(launch.recordLine).not.toContain('AGENT_UNATTENDED');
    // The expanded command carries the same pin, last among the profile's words.
    expect(launch.command.endsWith(`-c ${PIN}`)).toBe(true);
  });

  test('the run records the pinned line for the seat it launched', async () => {
    const { steps } = planned();
    const records: { seat: string; patch: Record<string, unknown> }[] = [];
    const upTo = steps.slice(0, steps.findIndex((step) => step.do?.do === 'launch') + 1);
    await executePlan(upTo, SESSION, baseHost(records));
    const lines = records.filter((entry) => entry.patch.launch_line !== undefined);
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of lines) {
      expect(entry.seat).toBe(SEAT);
      expect(entry.patch.launch_line).toBe(PINNED);
      expect(entry.patch.launch_line).not.toContain('AGENT_UNATTENDED');
    }
  });

  test('a plan whose seat is kept adds no launch line to its record', async () => {
    // A ready seat is left as it is: no launch, and the record it writes keeps whatever line,
    // pins included, an earlier launch stored.
    const steps = upPlan({
      root: '/tmp/acme', session: SESSION, sessionRunning: true, watchAlive: true, watchLabel: 'Watch · acme',
      stateDir: '/tmp/acme/.agents',
      seats: [{
        name: SEAT, cli: 'codex', launch: CLI, cwd: '/tmp/acme', label: SEAT, stopped: false,
        rules: 'Rules.', repairLine: 'repair', stage: 'ready', pane: PANE_TWO, workspace: WS_TWO,
      }],
    });
    const launch = steps.map((step) => step.do).find((op) => op?.do === 'launch');
    expect(launch).toBeUndefined();
    const records: { seat: string; patch: Record<string, unknown> }[] = [];
    await executePlan(steps, SESSION, baseHost(records));
    expect(records.some((entry) => entry.patch.launch_line !== undefined)).toBe(false);
  });
});

describe('team doctor names a recorded line that misses the pin', () => {
  function sources(home: string): DoctorSources {
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

  test('a recorded base line with no feature words is named with its relaunch', async () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: CLI });
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(home));
    expect(io.out).toContain(`${SEAT}: its recorded launch line does not pin ${PIN}`);
    expect(io.out).toContain(`run \`team restart ${SEAT}\``);
  });

  test('a record with no launch line says unknown, not a guess', async () => {
    const { root, home, dir } = place();
    seed(dir, {});
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(home));
    expect(io.out).toContain(`${SEAT}: its recorded launch line is unknown`);
    expect(io.out).toContain(`run \`team restart ${SEAT}\``);
  });

  test('a recorded pinned line draws nothing', async () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: PINNED });
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(home));
    expect(io.out).not.toContain('its recorded launch line');
  });

  test('a stopped seat is not named', async () => {
    const { root, home, dir } = place();
    writeFileSync(join(dir, 'team.yaml'), TEAM.replace(`    launch: zsh /w/as-floor.sh codex -m gpt-6.1-sol\n`, `    launch: zsh /w/as-floor.sh codex -m gpt-6.1-sol\n    stopped: true\n`));
    seed(dir, { launch_line: CLI });
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(home));
    expect(io.out).not.toContain('its recorded launch line');
  });
});

describe('team check names a recorded line that misses the pin', () => {
  function live(): Live {
    return {
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: PANE_ONE, workspace: WS_ONE, status: 'idle', cwd: null },
        { name: SEAT, agent: 'codex', pane: PANE_TWO, workspace: WS_TWO, status: 'idle', cwd: null },
      ],
      workspaces: [{ id: WS_ONE, label: 'lead' }, { id: WS_TWO, label: 'worker' }],
      screens: {},
    };
  }

  function check(root: string, home: string): { code: number; out: string } {
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    return { code, out: `${io.out}${io.err}` };
  }

  test('the missing pin is a difference, repaired by the relaunch', () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: CLI });
    const { code, out } = check(root, home);
    expect(out).toContain(`difference: ${SEAT}: its recorded launch line does not pin ${PIN}`);
    expect(out).toContain(`  repair: team restart ${SEAT}`);
    expect(code).toBe(1);
  });

  test('an unknown line is named as unknown', () => {
    const { root, home, dir } = place();
    seed(dir, {});
    const { out } = check(root, home);
    expect(out).toContain(`difference: ${SEAT}: its recorded launch line is unknown`);
  });

  test('a pinned record is not a difference', () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: PINNED });
    const { out } = check(root, home);
    expect(out).not.toContain('its recorded launch line');
  });
});
