import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step } from '../src/launch/plan.ts';
import { rulesLine } from '../src/launch/rules-file.ts';
import { profileFor } from '../src/profiles/index.ts';
import { cliWordList, launchCommand, pinnedRecordLine, shellQuote } from '../src/profiles/profile.ts';

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

  function planOf(launch: string): Step[] {
    return upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [{ name: 'coder', cli: 'codex', launch, cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
        rulesFile: { path: PATH, line: LINE } }] });
  }

  function planFor(launch: string) {
    return planOf(launch).find((step) => step.do?.do === 'launch')?.do;
  }

  test('a quoted script that runs the CLI carries the line as the CLI’s own last word', () => {
    const launch = planFor("/bin/sh -c 'codex'");
    const command = launch && 'command' in launch ? launch.command : '';
    // The CLI's decoded words end with the line, inside the script it runs; the plan's carry
    // flag follows that proof rather than the line's existence.
    expect(cliWordList('codex', command)?.at(-1)).toBe(LINE);
    expect(launch && 'rulesCarried' in launch ? launch.rulesCarried : undefined).toBe(true);
  });

  test('a line the scope cannot read reports no carry, and says where the line went', () => {
    // Nothing refuses to launch: the line keeps 0.5.10's placement after the whole line, and
    // the plan does not tell the file write that the CLI was given it.
    const launch = planFor("codex 'unclosed");
    expect(launch && 'rulesCarried' in launch ? launch.rulesCarried : undefined).not.toBe(true);
    expect(launch && 'notice' in launch ? launch.notice : '').toContain('its rules line is after the line, where the CLI may not read it');
  });

  // A counterexample from an independent tester: an ANSI-C word after the CLI's own `--` used
  // to make the whole line unreadable, so the options were appended after the delimiter and the
  // CLI read them as prompt text. The word holds no escape, so every shell that reads it reads
  // the same text; it decodes, and the options stand before the delimiter again.
  const DELIMITED = "codex -- $'prompt'";
  test('an ANSI-C word after the delimiter takes the options before it and the rules after', () => {
    const launch = planFor(DELIMITED);
    const command = launch && 'command' in launch ? launch.command : '';
    const words = cliWordList('codex', command);
    expect(words).not.toBeNull();
    const at = words!.indexOf('--');
    expect(at).toBeGreaterThan(0);
    expect(words!.slice(at)).toEqual(['--', 'prompt', LINE]);
    expect(words!.slice(0, at)).toContain('never');
    expect(launch && 'rulesCarried' in launch ? launch.rulesCarried : undefined).toBe(true);
  });
  test('the record line places the pin before the delimiter too', () => {
    const record = pinnedRecordLine('codex', DELIMITED, profileFor('codex')!.features);
    expect(record.indexOf('features.mcp_oauth_refresh_coordination=false')).toBeLessThan(record.indexOf('--'));
  });

  // The second counterexample: the options are placed inside the inner script, and the rules
  // must be placed inside it too rather than after the outer closing quote, where the CLI never
  // reads them.
  test('a nested quoted script keeps the rules inside, as the CLI’s last word', () => {
    const launch = planFor(`/bin/sh -c 'sh -c "codex -- prompt"'`);
    const command = launch && 'command' in launch ? launch.command : '';
    const words = cliWordList('codex', command);
    expect(words).not.toBeNull();
    expect(words!.at(-1)).toBe(LINE);
    expect(words!).toContain('--');
    expect(launch && 'rulesCarried' in launch ? launch.rulesCarried : undefined).toBe(true);
  });

  // An unreadable line that names, or may name, the delimiter can never take the appended words
  // safely: they would land after it. Those launches refuse; one that cannot name it keeps the
  // old placement with its notice, as the scene above shows.
  test('a line that names the delimiter before the part it cannot read refuses the launch', () => {
    const steps = planOf("codex -- $'a\\nb'");
    expect(steps.find((step) => step.do?.do === 'launch')).toBeUndefined();
    const refusal = steps.find((step) => step.do?.do === 'refuse');
    expect(refusal && 'text' in refusal ? refusal.text : '').toContain('would refuse');
    expect(refusal && 'text' in refusal ? refusal.text : '').toContain('delimiter');
  });
  test('a line whose unreadable word could itself spell the delimiter refuses too', () => {
    // The escapes read as two hyphens in every shell that decodes this word, so the shell runs a
    // real delimiter this reader never saw.
    const steps = planOf("codex $'\\55\\55'");
    expect(steps.find((step) => step.do?.do === 'launch')).toBeUndefined();
    expect(steps.find((step) => step.do?.do === 'refuse')).toBeDefined();
  });
  test('a line that names the delimiter after the part it cannot read refuses too', () => {
    const steps = planOf("codex $'a\\nb' -- prompt");
    expect(steps.find((step) => step.do?.do === 'launch')).toBeUndefined();
    expect(steps.find((step) => step.do?.do === 'refuse')).toBeDefined();
  });
  test('an unread word that cannot be the delimiter keeps the old placement, with its notice', () => {
    const launch = planFor("codex $'a\\nb'");
    const command = launch && 'command' in launch ? launch.command : '';
    expect(command).toContain("$'a\\nb'");
    expect(launch && 'rulesCarried' in launch ? launch.rulesCarried : undefined).toBe(false);
  });
});

describe('executing a launch that carries the rules line', () => {
  function run(command: string, carried: boolean, line = LINE) {
    const events: string[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: (_s, _p, cmd) => { events.push(`run:${cmd.includes(line) ? 'with-line' : 'plain'}`); return true; },
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
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'coder', label: 'coder', command, pane: 'p1', cli: 'codex', cwd: '.', rulesCarried: carried } },
      { kind: 'run', argv: [], do: { do: 'deliver', seat: 'coder', label: 'coder', cli: 'codex', rules: 'Rules.', path: PATH, line, seconds: 1, pane: 'p1' } },
    ];
    return { events, done: executePlan(steps, 'acme', host) };
  }

  test('the file is written before the command runs, and nothing is typed', async () => {
    const { events, done } = run(`codex ${shellQuote(LINE)}`, true);
    await done;
    expect(events.slice(0, 2)).toEqual(['write', 'run:with-line']);
    expect(events).not.toContain('typed');
    expect(events).not.toContain('deliver');
    expect(events).toContain('stage:ready');
  });

  test('the plan flag decides, not the built command: a line shell-quoted with an apostrophe is still carried', async () => {
    // `shellQuote` turns the line's own apostrophe into '\'', so the built command never holds
    // the line as a substring. The plan's flag, which follows the line it gave the launch, does.
    const quoted = "Read /x/rules/o'brien.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.";
    const command = `codex ${shellQuote(quoted)}`;
    expect(command.includes(quoted)).toBe(false);
    expect(command).toContain(`o'\\''brien`);
    const { events, done } = run(command, true, quoted);
    await done;
    expect(events.slice(0, 2)).toEqual(['write', 'run:plain']);
    expect(events).not.toContain('typed');
    expect(events).not.toContain('deliver');
    expect(events).toContain('stage:ready');
  });

  test('a launch without the line is not taken as delivered, and its rules are never typed: the file is written, the seat left out', async () => {
    const { events, done } = run('codex', false);
    await done;
    expect(events).toContain('write');
    expect(events).not.toContain('deliver');
    expect(events).not.toContain('stage:ready');
    expect(events).not.toContain('typed');
  });

  test('the plan says a launch line carries them, but this seat was not launched: the file is written, the seat left out', async () => {
    const said: string[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: () => true,
      typeLine: () => false,
      deliverRules: async (_s, _p, _c, file) => file.writeOnly === true,
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
    const steps: Step[] = [{
      kind: 'run',
      argv: [],
      do: { do: 'deliver', seat: 'reviewer-codex', label: 'reviewer-codex', cli: 'codex', rules: 'Rules.', path: PATH, line: LINE, seconds: 1, pane: 'p1', launchCanCarryRules: true },
    }];
    await executePlan(steps, 'acme', host);
    expect(said.join('')).toContain('run team restart reviewer-codex to carry them');
  });

  test('a profile with no launch prompt can never carry them: the report says so and names no restart', async () => {
    const said: string[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: () => true,
      typeLine: () => false,
      deliverRules: async (_s, _p, _c, file) => file.writeOnly === true,
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
    const steps: Step[] = [{
      kind: 'run',
      argv: [],
      do: { do: 'deliver', seat: 'reviewer-codex', label: 'reviewer-codex', cli: 'codex', rules: 'Rules.', path: PATH, line: LINE, seconds: 1, pane: 'p1', launchCanCarryRules: false },
    }];
    await executePlan(steps, 'acme', host);
    expect(said.join('')).toContain('its CLI takes no initial prompt at launch, so no launch carries them');
    expect(said.join('')).toContain('its rules file is written');
    expect(said.join('')).not.toContain('restart');
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
      { kind: 'run', argv: [], do: { do: 'deliver', seat: 'reviewer-agent', label: 'reviewer-agent', cli: 'cursor', rules: 'Rules.', path: PATH, line: LINE, seconds: 1, pane: 'p1' } },
    ];
    await executePlan(steps, 'acme', host);
    expect(events).toContain('write');
    expect(events).not.toContain('typed-rules');
    expect(events).not.toContain('typed');
    expect(events).not.toContain('run');
    expect(events).not.toContain('stage:ready');
    expect(events.join('\n')).toContain('run team restart reviewer-agent to carry them');
  });
});
