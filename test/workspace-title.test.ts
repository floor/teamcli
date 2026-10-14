// Line 1 of a seat's workspace is its written label, or `<name> · <role>` when the file
// writes none. The model stays off that line. Line 2 is the pane's display_agent: the
// display, and a space plus the effort when the file sets one.
import { describe, expect, test } from 'bun:test';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { formatPlan, upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';

const minimal = `format: 1
project: acme
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
`;

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.team;
}

function seatNamed(name: string, text: string) {
  const seat = valid(text).seats.find((candidate) => candidate.name === name);
  if (!seat) throw new Error(`fixture has no seat ${name}`);
  return seat;
}

describe('the workspace title', () => {
  test('a written label titles the workspace', () => {
    const text = minimal.replace('    launch:', '    label: Priam · coordinator\n    launch:');
    expect(workspaceLabel(seatNamed('lead', text))).toBe('Priam · coordinator');
  });

  test('a seat with no written label is titled with its name and role', () => {
    expect(workspaceLabel(seatNamed('lead', minimal))).toBe('lead · coordinator');
  });

  test('the model never appears on line 1', () => {
    const seat = seatNamed('lead', minimal);
    const title = workspaceLabel(seat);
    expect(title.includes(seat.model)).toBe(false);
    expect(title.includes(seat.display)).toBe(false);
  });

  test('a counted entry gives each instance its own line 1', () => {
    const counted = `format: 1
project: acme
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
    launch: claude
  - role: implementer
    name: maker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
    count: 2
  - role: implementer
    name: desk
    label: desk
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    launch: team-deepseek
    count: 2
`;
    const team = valid(counted);
    expect(team.seats.filter((seat) => seat.declared === 'maker').map(workspaceLabel)).toEqual([
      'maker · implementer',
      'maker-2 · implementer',
    ]);
    expect(team.seats.filter((seat) => seat.declared === 'desk').map(workspaceLabel)).toEqual(['desk', 'desk-2']);
  });
});

describe('the pane display', () => {
  test('display_agent is the display, and the effort when the file sets one', () => {
    expect(displayAgent(seatNamed('lead', minimal))).toBe('Claude Opus 5.5');
    const effort = minimal.replace('    launch:', '    effort: high\n    launch:');
    expect(displayAgent(seatNamed('lead', effort))).toBe('Claude Opus 5.5 high');
    expect(displayAgent({ display: 'Grok 4.7' })).toBe('Grok 4.7');
  });

  test('the plan reports display_agent after the seat is named', () => {
    const seat: UpSeat = {
      name: 'lead',
      cli: 'claude-code',
      launch: 'claude',
      cwd: '.',
      label: 'Priam · coordinator',
      displayAgent: 'Claude Opus 5.5 high',
      repairLine: '`team down` then `team up` (to restart the whole team)',
      stopped: false,
      rules: '',
    };
    const plan = formatPlan(upPlan({
      root: '/work/acme',
      session: 'acme',
      sessionRunning: true,
      seats: [seat],
      watchAlive: true,
    }));
    expect(plan).toContain("--label 'Priam · coordinator'");
    expect(plan).toContain("pane report-metadata <pane of lead> --source team --display-agent 'Claude Opus 5.5 high'");
    expect(plan).not.toContain("--label 'Claude Opus 5.5");
  });

  test('a failed report is one line and the seat stays', async () => {
    const said: string[] = [];
    let runs = 0;
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: () => {
        runs += 1;
        return true;
      },
      reportDisplayAgent: () => false,
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
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { said.push(line); },
      log: () => {},
    };
    const repair = '`team down` then `team up` (to restart the whole team)';
    const steps: Step[] = [
      { kind: 'run', argv: [], do: { do: 'create', seat: 'lead', label: 'Priam · coordinator', cwd: '/work', repairLine: repair } },
      { kind: 'run', argv: [], do: { do: 'rename', seat: 'lead', label: 'Priam · coordinator', seconds: 1, rules: 'message', displayAgent: 'Claude Opus 5.5 high' } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'lead', label: 'Priam · coordinator', command: 'claude' } },
    ];
    await executePlan(steps, 'acme', host);
    expect(said).toEqual(['lead: its display was not reported\n']);
    expect(runs).toBe(1);
  });
});
