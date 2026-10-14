// Line 1 of a seat's workspace is its written label, or `<name> · <role>` when the file
// writes none. The model stays off that line. Line 2 is the pane's display_agent: the
// display, a space, and the effort, or `default` when the file sets none.
import { describe, expect, test } from 'bun:test';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { formatPlan, upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { liveDisplayAgent } from '../src/watch/seat-label.ts';

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
  test('display_agent is the display, a space, and the effort or default', () => {
    expect(displayAgent(seatNamed('lead', minimal))).toBe('Claude Opus 5.5 default');
    const effort = minimal.replace('    launch:', '    effort: high\n    launch:');
    expect(displayAgent(seatNamed('lead', effort))).toBe('Claude Opus 5.5 high');
    expect(displayAgent({ display: 'Grok 4.7', effort: 'high' })).toBe('Grok 4.7 high');
    expect(displayAgent({ display: 'Opus 5.5' })).toBe('Opus 5.5 default');
    expect(displayAgent({ display: 'Gemini 3.8 Flash' })).toBe('Gemini 3.8 Flash default');
    expect(displayAgent({ display: 'DeepSeek V4.1 Flash', effort: 'high' })).toBe('DeepSeek V4.1 Flash high');
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

const readySeat = (over: Partial<UpSeat> = {}): UpSeat => ({
  name: 'lead',
  cli: 'grok',
  launch: 'grok',
  cwd: '.',
  label: 'lead · coordinator',
  displayAgent: 'Grok 4.7 default',
  repairLine: '`team down` then `team up` (to restart the whole team)',
  stopped: false,
  rules: '',
  stage: 'ready',
  pane: 'p1',
  workspace: 'w1',
  ...over,
});

describe('a seat left ready', () => {
  test('up repaints both lines from the file and does not launch', () => {
    const plan = formatPlan(upPlan({
      root: '/work/acme',
      session: 'acme',
      sessionRunning: true,
      seats: [readySeat()],
      watchAlive: true,
    }));
    expect(plan).toContain("workspace rename w1 'lead · coordinator'");
    expect(plan).toContain("pane report-metadata p1 --source team --display-agent 'Grok 4.7 default'");
    expect(plan).toContain('skip lead: already ready; left as it is');
    expect(plan).not.toContain('pane run');
    expect(plan).not.toContain('workspace create');
    expect(plan).not.toContain('grok --');
  });

  test('a ready seat with no pane is left as it is', () => {
    const plan = formatPlan(upPlan({
      root: '/work/acme',
      session: 'acme',
      sessionRunning: true,
      seats: [readySeat({ pane: undefined, workspace: undefined })],
      watchAlive: true,
    }));
    expect(plan).not.toContain('workspace rename');
    expect(plan).not.toContain('report-metadata');
    expect(plan).toContain('skip lead: already ready; left as it is');
  });

  test('a failed repaint is one line each and the seat stays ready', async () => {
    const said: string[] = [];
    let typed = 0;
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => null,
      paneRun: () => {
        typed += 1;
        return true;
      },
      reportDisplayAgent: () => false,
      renameWorkspace: () => false,
      typeLine: () => {
        typed += 1;
        return false;
      },
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
    const steps: Step[] = [
      {
        kind: 'run',
        argv: [],
        do: { do: 'relabel', seat: 'lead', pane: 'p1', workspace: 'w1', title: 'lead · coordinator', displayAgent: 'Grok 4.7 default' },
      },
      {
        kind: 'skip',
        text: 'lead: already ready; left as it is',
        do: { do: 'record', seat: 'lead', record: { kind: 'ready' }, detail: '  already ready; left as it is\n' },
      },
    ];
    await executePlan(steps, 'acme', host);
    expect(said).toEqual([
      'lead: its title was not reported\n',
      'lead: its display was not reported\n',
      'lead: ready\n  already ready; left as it is\n',
    ]);
    expect(typed).toBe(0);
  });
});

describe('the live line', () => {
  const opus = { cli: 'claude-code', model: 'Claude Opus', version: '5.5', display: 'Opus 5.5' };

  test('a parsed pair equal to the file keeps the display, and the join is one space', () => {
    const screen = 'Opus 5.5\n';
    expect(liveDisplayAgent(opus, screen).line).toBe('Opus 5.5 default');
    expect(liveDisplayAgent({ ...opus, effort: 'high' }, screen).line).toBe('Opus 5.5 high');
    expect(liveDisplayAgent(opus, 'Opus 5.5 with high effort\n').line).toBe('Opus 5.5 high');
  });

  test('a different pair is the status rule\'s model and version, not the file\'s display', () => {
    expect(liveDisplayAgent(opus, 'Sonnet 4.5\n').line).toBe('Claude Sonnet 4.5 default');
  });

  test('an unreadable screen keeps the file display, including a grok footer', () => {
    const grok = { cli: 'grok', model: 'Grok', version: '4.7', display: 'Grok 4.7' };
    expect(liveDisplayAgent(grok, 'Grok 4.6 (xhigh) · always-approve').line).toBe('Grok 4.7 xhigh');
    expect(liveDisplayAgent(grok, 'Grok 4.6 (xhigh) · always-approve').line.startsWith('grok')).toBe(false);
    expect(liveDisplayAgent(grok, undefined).line).toBe('Grok 4.7 default');
  });

  test('codex, cursor and antigravity supply the effort word, and an unread model stays the file\'s', () => {
    const codex = { cli: 'codex', model: 'GPT Sol', version: '6', display: 'GPT-6 Sol' };
    expect(liveDisplayAgent(codex, '  GPT-6-Astra xhigh · Context 100% left').line).toBe('GPT Astra 6 xhigh');
    const cursor = { cli: 'cursor', model: 'Grok', version: '4.7', display: 'Grok 4.7' };
    expect(liveDisplayAgent(cursor, '  Grok 4.7 256K High').line).toBe('Grok 4.7 high');
    expect(liveDisplayAgent(cursor, '  Grok 4.7 256K Extra High  Run Everything').line).toBe('Grok 4.7 xhigh');
    const agy = { cli: 'antigravity', model: 'Gemini Flash', version: '3.8', display: 'Gemini 3.8 Flash' };
    expect(liveDisplayAgent(agy, 'Gemini 4 Argon · medium').line).toBe('Gemini 3.8 Flash medium');
  });

  test('a screen with no effort word keeps the last word this process saw', () => {
    expect(liveDisplayAgent(opus, 'Opus 5.5\n', 'high').line).toBe('Opus 5.5 high');
    expect(liveDisplayAgent(opus, 'no model here', 'max').line).toBe('Opus 5.5 max');
  });
});
