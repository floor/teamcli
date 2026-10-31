import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step } from '../src/launch/plan.ts';
import { rulesLine } from '../src/launch/rules-file.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand, shellQuote } from '../src/profiles/profile.ts';

// 0.5.9: a seat's rules are never typed into its pane. A first-message CLI that takes an initial
// prompt at launch carries the one line that points at its rules file on its launch line; the
// file is written before the command runs.
const PATH = '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/coder.md';
const LINE = rulesLine(PATH, '5e1d0a9c4b2f');

describe('the launch line carries the rules line', () => {
  const cases: [string, string, string[]][] = [
    ['codex', 'codex', [shellQuote(LINE)]],
    ['cursor', 'cursor-agent', [shellQuote(LINE)]],
    ['muse', 'muse', [shellQuote(LINE)]],
    ['gemini', 'gemini', ['-i', shellQuote(LINE)]],
    ['antigravity', 'agy', ['--prompt-interactive', shellQuote(LINE)]],
  ];
  for (const [cli, binary, tail] of cases) {
    test(`${cli}: the line rides last, as the measured initial prompt`, () => {
      const profile = profileFor(cli)!;
      expect(profile.rulesMode).toBe('message');
      const command = launchCommand(profile, binary, 'Rules.', undefined, undefined, undefined, undefined, LINE);
      expect(command.endsWith(` ${tail.join(' ')}`)).toBe(true);
    });
  }
  test('an option CLI is unchanged: its rules ride its option, and no line is added', () => {
    const profile = profileFor('claude-code')!;
    const command = launchCommand(profile, 'claude', 'Rules.', undefined, undefined, undefined, undefined, LINE);
    expect(command).not.toContain(LINE);
    expect(command).toContain('--append-system-prompt');
  });
  test('the plan puts the line on the launch for a first-message seat', () => {
    const plan = upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [{ name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
        rulesFile: { path: PATH, line: LINE } }] });
    const launch = plan.find((step) => step.do?.do === 'launch')?.do;
    expect(launch && 'command' in launch ? launch.command : '').toContain(shellQuote(LINE));
  });
});

describe('executing a launch that carries the rules line', () => {
  function run(command: string) {
    const events: string[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: (_s, _p, cmd) => { events.push(`run:${cmd.includes(LINE) ? 'with-line' : 'plain'}`); return true; },
      typeLine: () => { events.push('typed'); return false; },
      deliverRules: async (_s, _p, _c, file) => { events.push(file.writeOnly === true ? 'write' : 'deliver'); return file.writeOnly === true ? true : false; },
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: (_seat, fields) => { if ('stage' in fields) events.push(`stage:${String(fields.stage)}`); },
      running: () => {},
      drop: () => {},
      say: () => {},
      log: () => {},
    };
    const steps: Step[] = [
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'coder', label: 'coder', command, pane: 'p1', cli: 'codex', cwd: '.' } },
      { kind: 'run', argv: [], do: { do: 'deliver', seat: 'coder', label: 'coder', cli: 'codex', rules: 'Rules.', path: PATH, line: LINE, seconds: 1, pane: 'p1' } },
    ];
    return { events, done: executePlan(steps, 'acme', host) };
  }

  test('the file is written before the command runs, and nothing is typed', async () => {
    const { events, done } = run(`codex ${shellQuote(LINE)}`);
    await done;
    expect(events.slice(0, 2)).toEqual(['write', 'run:with-line']);
    expect(events).not.toContain('typed');
    expect(events).not.toContain('deliver');
    expect(events).toContain('stage:ready');
  });

  test('a launch without the line is not taken as delivered, and its rules are never typed: the file is written, the seat left out', async () => {
    const { events, done } = run('codex');
    await done;
    expect(events).toContain('write');
    expect(events).not.toContain('deliver');
    expect(events).not.toContain('stage:ready');
    expect(events).not.toContain('typed');
  });
});

describe('a seat this run did not launch', () => {
  test('is never typed into for its rules: its file is written and it is left out with the restart that carries them', async () => {
    const events: string[] = [];
    const host = {
      sessionState: () => 'running' as const, startServer: () => true, sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: () => { events.push('run'); return true; },
      typeLine: () => { events.push('typed'); return true; },
      deliverRules: async (_s: string, _p: string, _c: string, file: { writeOnly?: boolean }) => {
        events.push(file.writeOnly === true ? 'write' : 'typed-rules');
        return true;
      },
      renameAgent: () => true, closeWorkspace: () => true, stopSession: () => true, kill: () => true,
      agentPanes: () => ['p1'], classify: () => 'idle' as const, sleep: async () => {}, now: () => 0,
      allow: () => null, record: (_seat: string, rec: { stage?: string }) => { if (rec.stage) events.push(`stage:${rec.stage}`); },
      running: () => {}, drop: () => {}, say: (line: string) => { events.push(`say:${line}`); }, log: () => {},
    } as unknown as Host;
    const steps: Step[] = [
      { kind: 'run', argv: [], do: { do: 'deliver', seat: 'reviewer-cursor', label: 'reviewer-cursor', cli: 'cursor', rules: 'Rules.', path: PATH, line: LINE, seconds: 1, pane: 'p1' } },
    ];
    await executePlan(steps, 'acme', host);
    expect(events).toContain('write');
    expect(events).not.toContain('typed-rules');
    expect(events).not.toContain('typed');
    expect(events).not.toContain('run');
    expect(events).not.toContain('stage:ready');
    expect(events.join('\n')).toContain('run team restart reviewer-cursor to carry them');
  });
});
