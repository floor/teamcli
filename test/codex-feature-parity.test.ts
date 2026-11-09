// FLO-1368 retires the fixed false override: proven launch recipes shed it, true stays,
// and a profile with no required feature pins emits no pin diagnostic.
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

/** A recorded recipe may predate the retired pin or omit the launch line entirely. */
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

describe('the launch line removes only the obsolete false override', () => {
  test('removing the false pair keeps the seat’s resume and trailing rules line', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    const command = launchCommand(
      profile,
      `zsh /w/as-floor.sh codex -m gpt-6.1-sol resume 01a1 -c ${PIN}`,
      'Rules.',
      undefined,
      undefined,
      undefined,
      undefined,
      'Read /x/rules.md; reply ready.',
    );
    expect(command).toContain(`resume 01a1`);
    // FLO-1368 removes the legacy false pair without changing resume or rules placement.
    expect(command).not.toContain(PIN);
    expect(command).toContain('Read /x/rules.md; reply ready.');
    expect(command.indexOf('resume 01a1')).toBeLessThan(command.indexOf('Read /x/rules.md'));
  });

  test('a line that sets the feature true keeps it when the legacy false pair is removed', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    const command = launchCommand(profile, `codex -m gpt-6.1-sol -c features.mcp_oauth_refresh_coordination=true -c ${PIN}`, 'Rules.');
    // FLO-1368 removes false only; the caller's explicit true value remains the sole setting.
    expect(command).toContain('-c features.mcp_oauth_refresh_coordination=true');
    expect(command.lastIndexOf('features.mcp_oauth_refresh_coordination')).toBe(command.indexOf('features.mcp_oauth_refresh_coordination=true'));
    expect(command).not.toContain(PIN);
  });

  test('removing the false option preserves the positional delimiter in every spelling', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    for (const delimiter of ['--', "'--'", '"--"']) {
      const command = launchCommand(
        profile,
        `codex -m gpt-6.1-sol -c ${PIN} ${delimiter} 'an existing prompt'`,
        'Rules.',
        undefined,
        undefined,
        undefined,
        undefined,
        'Read /x/rules.md; reply ready.',
      );
      // FLO-1368 removes the option before -- while preserving both positional words.
      expect(command).not.toContain(PIN);
      expect(command.indexOf('an existing prompt')).toBeLessThan(command.indexOf('Read /x/rules.md'));
      expect(command).toContain('Read /x/rules.md; reply ready.');
    }
  });
});

describe('the plan and the record keep the migrated base recipe', () => {
  function planned(): { steps: ReturnType<typeof upPlan>; launch: Extract<NonNullable<ReturnType<typeof upPlan>[number]['do']>, { do: 'launch' }> } {
    const steps = upPlan({
      root: '/tmp/acme', session: SESSION, sessionRunning: true, watchAlive: true, watchLabel: 'Watch · acme',
      stateDir: '/tmp/acme/.agents',
      seats: [{
        name: SEAT, cli: 'codex', launch: PINNED, cwd: '/tmp/acme', label: SEAT, stopped: false,
        rules: 'Rules.', repairLine: 'repair',
      }],
    });
    const launch = steps.map((step) => step.do).find((op) => op?.do === 'launch');
    if (launch?.do !== 'launch') throw new Error('the plan holds no launch');
    return { steps, launch };
  }

  test('the launch op carries the migrated base line, never the expanded command', () => {
    const { launch } = planned();
    expect(launch.recordLine).toBe(CLI);
    expect(launch.recordLine).not.toContain('AGENT_UNATTENDED');
    // FLO-1368 strips the false pair from the stored recipe and the expanded command.
    expect(launch.command).not.toContain(PIN);
  });

  test('the run records the migrated line for the seat it launched', async () => {
    const { steps } = planned();
    const records: { seat: string; patch: Record<string, unknown> }[] = [];
    const upTo = steps.slice(0, steps.findIndex((step) => step.do?.do === 'launch') + 1);
    await executePlan(upTo, SESSION, baseHost(records));
    const lines = records.filter((entry) => entry.patch.launch_line !== undefined);
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of lines) {
      expect(entry.seat).toBe(SEAT);
      expect(entry.patch.launch_line).toBe(CLI);
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

describe('team doctor requires no retired feature pin', () => {
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

  test('a recorded base line with no feature words needs no feature relaunch', async () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: CLI });
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(home));
    // FLO-1368 has no profile pin requirement, including for an older unpinned recipe.
    expect(io.out).not.toContain(`${SEAT}: its recorded launch line`);
    expect(io.out).not.toContain(`run \`team restart ${SEAT}\``);
  });

  test('a record with no launch line does not invent a retired feature requirement', async () => {
    const { root, home, dir } = place();
    seed(dir, {});
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(home));
    // With no required pin, an unknown recipe warrants no guessed feature repair.
    expect(io.out).not.toContain(`${SEAT}: its recorded launch line is unknown`);
    expect(io.out).not.toContain(`run \`team restart ${SEAT}\``);
  });

  test('a legacy false record draws no profile pin diagnostic', async () => {
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

describe('team check requires no retired feature pin', () => {
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

  test('the missing retired pin creates no feature difference or relaunch advice', () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: CLI });
    const { code, out } = check(root, home);
    // FLO-1368 no longer requires the false pair; unrelated differences still determine exit1.
    expect(out).not.toContain(`difference: ${SEAT}: its recorded launch line`);
    expect(out).not.toContain(`  repair: team restart ${SEAT}`);
    expect(code).toBe(1);
  });

  test('an unknown line creates no guessed retired feature difference', () => {
    const { root, home, dir } = place();
    seed(dir, {});
    const { out } = check(root, home);
    expect(out).not.toContain(`difference: ${SEAT}: its recorded launch line is unknown`);
  });

  test('a legacy false record is not a profile pin difference', () => {
    const { root, home, dir } = place();
    seed(dir, { launch_line: PINNED });
    const { out } = check(root, home);
    expect(out).not.toContain('its recorded launch line');
  });
});
