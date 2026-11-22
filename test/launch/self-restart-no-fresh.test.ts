// A queued self-restart resumes its conversation or fails (src/launch/execute.ts noFreshFallback):
// a resume the CLI refuses at runtime is never relaunched fresh for such a seat, and the run says
// which seat lost continuity. The host, its pane, screen and clock are synthetic.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import { recordText } from '../../src/launch/progress.ts';

const SEAT = 'worker';
const PANE = 'fixture-pane';
const SPACE = 'fixture-space';
const CONV = '5f1c2e3a-0b4d-4e6f-8a9b-1c2d3e4f5a6b';
const LINE = `claude --resume ${CONV}`;

function scene() {
  let clock = 0;
  const runs: string[] = [];
  let screen = '~ >\n';
  const finals: string[] = [];
  const logs: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: (_session, _pane, command) => {
      runs.push(command);
      // The CLI prints its refusal and exits: the pane is back at its shell.
      if (command.includes('--resume')) screen = `~ > ${command}\nNo conversation found with session ID: ${CONV}\n~ >\n`;
      return true;
    },
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => [],
    workspacePanes: () => [PANE],
    processInfo: () => ({ shell: 700, foreground: [700] }),
    classify: () => 'unknown',
    paneText: () => screen,
    foreground: () => ['zsh'],
    shellBack: () => true,
    agentStatus: () => null,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => { finals.push(line); },
    final: (seat, record) => { finals.push(recordText(seat, record)); },
    log: (_seat, line) => { logs.push(line); },
  };
  return { host, runs, finals, logs };
}

const steps: Step[] = [
  { kind: 'run', argv: [], do: { do: 'launch', seat: SEAT, label: SEAT, command: LINE, pane: PANE, workspace: SPACE, cli: 'claude-code', cwd: '.' } },
  { kind: 'wait', text: 'until the seat shows its idle prompt', do: { do: 'idle', seat: SEAT, label: SEAT, cli: 'claude-code', seconds: 30, command: LINE, pane: PANE, workspace: SPACE, repairLine: 'team remove worker' } },
];

test('a self-restart seat whose resume the CLI refuses is left out, never relaunched fresh', async () => {
  const one = scene();
  const resumeRefused = new Set<string>();
  await executePlan(steps, 'acme', one.host, { noFreshFallback: new Set([SEAT]), resumeRefused });
  expect(one.runs).toEqual([LINE]);
  expect([...resumeRefused]).toEqual([SEAT]);
  expect(one.logs).toContain('its recorded conversation was not found by the CLI; no fresh conversation was started');
});

test('without the rule, the same refusal is relaunched fresh as before', async () => {
  const one = scene();
  await executePlan(steps, 'acme', one.host);
  expect(one.runs).toHaveLength(2);
  expect(one.runs[1]).not.toContain('--resume');
});
