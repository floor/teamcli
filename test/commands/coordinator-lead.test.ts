// A lead written `role: coordinator` is that lead by the name the file resolves
// (`coordinator:` or `leads: true`). add and remove admit that seat, the same
// names up treats as leads. A non-lead does not. Removing the operator stays
// the owner's.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import type { Launch } from '../../src/commands/up.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { claudeBox, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-14T13:00:00Z');

function seat(name: string, role: string, stopped = false): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    stopped ? '    stopped: true' : '',
  ].filter(Boolean).join('\n');
}

function teamYaml(workerStopped: boolean): string {
  return `format: 1
project: acme
coordinator: coordinator
operator: operator
workspace:
  mode: shared
seats:
${seat('coordinator', 'coordinator')}
${seat('operator', 'operator')}
${seat('worker', 'implementer', workerStopped)}
`;
}

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-coordinator-lead-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return { base, root, home };
}

function trusted(text: string, root: string): string {
  return text.replace('workspace:', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:`);
}

function approve(text: string, root: string, home: string): void {
  const body = trusted(text, root);
  writeFileSync(join(root, '.agents/team.yaml'), body);
  const loaded = validateTeamFile(body);
  if (!loaded.ok) throw new Error(`refused: ${JSON.stringify(loaded.errors)}`);
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(loaded.team, root, NOW), file: body },
    loaded.team.seats,
    home,
  );
}

function record(root: string, panes: Record<string, string>): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    for (const [name, pane] of Object.entries(panes)) {
      session.seats[name] = { stage: 'ready', pane };
    }
  });
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

const launch: Launch = {
  sessionState: () => 'absent',
  startServer: () => true,
  sessionUp: () => false,
  createWorkspace: () => { throw new Error('a dry run created a workspace'); },
  paneRun: () => { throw new Error('a dry run ran a pane'); },
  renameAgent: () => { throw new Error('a dry run renamed an agent'); },
  closeWorkspace: () => true,
  agentPanes: () => [],
  agents: () => [],
  paneText: () => '',
  foreground: () => [],
  sleep: async () => {},
  now: () => NOW,
};

function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(home),
    now: () => NOW,
    launch,
  };
}

function removeSources(home: string, agents: HerdrAgent[]): RemoveSources {
  const launchHost: DownLaunch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: () => true,
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => ({ kind: 'unknown' }),
    screenText: () => claudeBox(''),
    status: () => 'idle',
    now: () => NOW,
    sleep: async () => {},
    launch: launchHost,
    foreground: () => [],
    shellBack: () => true,
  };
}

const coordinator = { kind: 'seat' as const, name: 'coordinator', pane: 'coordinator-pane', session: 'acme' };
const operator = { kind: 'seat' as const, name: 'operator', pane: 'operator-pane', session: 'acme' };
const worker = { kind: 'seat' as const, name: 'worker', pane: 'worker-pane', session: 'acme' };

describe('a lead written role: coordinator', () => {
  test('the coordinator seat may add another seat', async () => {
    const { base, root, home } = place();
    approve(teamYaml(true), root, home);
    record(root, { coordinator: coordinator.pane, operator: operator.pane });
    const io = testIo(root, coordinator);
    const code = await runAdd(['worker', '--dry-run'], io, addSources(home));
    expect(code, `${io.out}${io.err}`).toBe(0);
    expect(io.out).toContain('worker');
    expect(io.err).toBe('');
    rmSync(base, { recursive: true, force: true });
  });

  test('the coordinator seat may remove another seat', async () => {
    const { base, root, home } = place();
    approve(teamYaml(false), root, home);
    record(root, { coordinator: coordinator.pane, worker: worker.pane });
    const agents: HerdrAgent[] = [
      { name: 'worker', agent: 'claude', pane: worker.pane, workspace: 'worker-ws', status: 'idle', cwd: null },
    ];
    const io = testIo(root, coordinator);
    const code = await runRemove(['worker'], io, removeSources(home, agents));
    expect(code, `${io.out}${io.err}`).toBe(0);
    expect(io.out).toContain('removed worker');
    rmSync(base, { recursive: true, force: true });
  });

  test('a non-lead may not add or remove', async () => {
    const { base, root, home } = place();
    approve(teamYaml(true), root, home);
    record(root, { coordinator: coordinator.pane, worker: worker.pane });
    const add = testIo(root, worker);
    // A dry run explains the refusal on stdout instead of refusing bare; it still exits 1.
    expect(await runAdd(['worker', '--dry-run'], add, addSources(home))).toBe(1);
    expect(add.out).toContain('! add would refuse:');
    expect(add.out).toContain('only the owner, the orchestrator or the operator');
    const remove = testIo(root, worker);
    expect(await runRemove(['worker'], remove, removeSources(home, []))).toBe(1);
    expect(remove.err).toContain('only the owner, the orchestrator or the operator');
    rmSync(base, { recursive: true, force: true });
  });

  test('the operator may remove another seat, and only the owner removes the operator', async () => {
    const { base, root, home } = place();
    approve(teamYaml(false), root, home);
    record(root, { coordinator: coordinator.pane, operator: operator.pane, worker: worker.pane });
    const agents: HerdrAgent[] = [
      { name: 'worker', agent: 'claude', pane: worker.pane, workspace: 'worker-ws', status: 'idle', cwd: null },
    ];
    const byOperator = testIo(root, operator);
    expect(await runRemove(['worker'], byOperator, removeSources(home, agents)), `${byOperator.out}${byOperator.err}`).toBe(0);
    expect(byOperator.out).toContain('removed worker');
    const leadRemovesOperator = testIo(root, coordinator);
    expect(await runRemove(['operator'], leadRemovesOperator, removeSources(home, []))).toBe(1);
    expect(leadRemovesOperator.err).toBe(
      "team remove: only the owner removes the orchestrator's or the operator's seat; this call is coordinator\n",
    );
    rmSync(base, { recursive: true, force: true });
  });
});
