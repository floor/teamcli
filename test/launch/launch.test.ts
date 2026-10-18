import { describe, expect, test } from 'bun:test';
import { executePlan, paneExcerpt, type Host } from '../../src/launch/execute.ts';
import { plainLine, plainPaneText, plainText, stripControlStrings } from '../../src/launch/plain.ts';
import { downPlan, formatPlan, herdr, upPlan, type DownSeat, type Step, type UpSeat } from '../../src/launch/plan.ts';
import { rulesText, seatRules, type RulesInput } from '../../src/launch/rules.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, parseVersion, shellQuote, versionVerdict } from '../../src/profiles/profile.ts';

const rulesInput: RulesInput = {
  orchestrator: 'claude-coordinator-acme',
  rules: ['Run the tests your change touches, not the whole suite.'],
  signature: {
    commit: 'Agent: Claude Opus 5.5 · implementer',
    pullRequest: '**Agent:** Claude Opus 5.5 · implementer',
    commitPosition: 'trailer',
  },
  workspace: { mode: 'worktree', protected: ['.'], branch: '{kind}/{task}' },
};

const claudeCode = profileFor('claude-code');
if (!claudeCode) throw new Error('claude-code has no profile');

describe('profiles', () => {
  test('every shipped CLI has a launch profile: claude-code, codex, cursor, antigravity, grok', () => {
    expect(profileFor('claude-code')).toBe(claudeCode);
    expect(profileFor('codex')?.cli).toBe('codex');
    expect(profileFor('cursor')?.cli).toBe('cursor');
    expect(profileFor('antigravity')?.cli).toBe('antigravity');
    expect(profileFor('grok')?.cli).toBe('grok');
    expect(profileFor('constructor')).toBeNull();
  });

  test('a version is read from the CLI output', () => {
    expect(parseVersion('2.1.288 (Claude Code)')).toEqual([2, 1, 288]);
    expect(parseVersion('herdr 0.7.1')).toEqual([0, 7, 1]);
    expect(parseVersion('no version')).toBeNull();
  });

  test('a version is placed against the tested range', () => {
    const tested = { from: '2.1.200', to: '2.1.288' };
    expect(versionVerdict('2.1.288 (Claude Code)', tested)).toBe('tested');
    expect(versionVerdict('2.1.200', tested)).toBe('tested');
    expect(versionVerdict('2.1.99', tested)).toBe('older');
    expect(versionVerdict('2.2', tested)).toBe('newer');
    expect(versionVerdict('2.1.288.1', tested)).toBe('newer');
    expect(versionVerdict('?', tested)).toBe('unread');
  });

  test('a model id maps to the model and version of the file', () => {
    expect(claudeCode.modelOf('claude --model claude-opus-5-5')).toEqual({ model: 'Claude Opus', version: '5.5' });
    expect(claudeCode.modelOf('claude --model=claude-fable-5-1 --verbose')).toEqual({
      model: 'Claude Fable',
      version: '5.1',
    });
    expect(claudeCode.modelOf('claude --model claude-haiku-4-5-20251001')).toEqual({
      model: 'Claude Haiku',
      version: '4.5',
    });
    expect(claudeCode.modelOf('claude --model claude-opus-5')).toEqual({ model: 'Claude Opus', version: '5' });
    expect(claudeCode.modelOf('claude --model foo --model claude-opus-5-5')).toEqual({ model: 'Claude Opus', version: '5.5' });
  });

  test('an unknown model id or a launcher maps to nothing', () => {
    expect(claudeCode.modelOf('team-deepseek')).toBeNull();
    expect(claudeCode.modelOf('claude --model claude-nova-9-1')).toBeNull();
    expect(claudeCode.modelOf('claude --model opus')).toBeNull();
  });

  test('shell words are quoted only when they need it', () => {
    expect(shellQuote('--model')).toBe('--model');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's $HOME; rm")).toBe("'it'\\''s $HOME; rm'");
    expect(shellQuote('')).toBe("''");
  });

  test('the launch gets the unattended flag, the option and the rules, quoted', () => {
    expect(launchCommand(claudeCode, 'claude --model claude-opus-5-5 ', "Don't stop.\n- two")).toBe(
      "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt 'Don'\\''t stop.\n- two'",
    );
  });

  test('an unattended flag the launch line already carries is not appended again', () => {
    expect(launchCommand(claudeCode, 'claude --model claude-opus-5-5 --dangerously-skip-permissions', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules.',
    );
  });
});

describe('the rules of a seat', () => {
  test("come in order: the profile's, the file's, the signature, the workspace's", () => {
    expect(seatRules(rulesInput)).toEqual([
      'End every commit message and every pull request body with your signature, given below.',
      'Never stop at a question: tell the orchestrator (claude-coordinator-acme) in one line and keep working.',
      'Never run `team grant`, `team delegate` or `team revoke`, and never edit `trust:` in the team file.',
      'In a protected checkout, never switch the branch, reset or commit.',
      'Run the tests your change touches, not the whole suite.',
      'Your signature in a commit message, as a trailer, in a last paragraph of its own that holds trailers only: Agent: Claude Opus 5.5 · implementer',
      'Your signature in a pull request body, as its last line: **Agent:** Claude Opus 5.5 · implementer',
      'Protected checkouts, relative to the project root: .',
      'Work on the code in the worktree your brief names, never in the checkout you started in. Branches are named {kind}/{task}.',
    ]);
  });

  test('the inbox sentence is asked only of a seat whose CLI registers the inbox', () => {
    const withInbox = seatRules({ ...rulesInput, inbox: true });
    expect(withInbox.slice(0, 4)).toEqual([
      'End every commit message and every pull request body with your signature, given below.',
      'Never stop at a question: tell the orchestrator (claude-coordinator-acme) in one line and keep working.',
      'If your tools include `inbox_check`, call it at the start of every turn and `inbox_read` for each message it lists, and act on what you read.',
      'Never run `team grant`, `team delegate` or `team revoke`, and never edit `trust:` in the team file.',
    ]);
    // A seat whose CLI carries no measured route is asked for nothing: its rules are the ones
    // earlier builds wrote, byte for byte.
    expect(seatRules(rulesInput)).toEqual(seatRules({ ...rulesInput, inbox: false }));
    expect(seatRules(rulesInput).some((line) => line.includes('inbox_check'))).toBe(false);
  });

  test('a shared seat gets no worktree rule, and the position is said as the file has it', () => {
    const rules = seatRules({
      ...rulesInput,
      signature: { ...rulesInput.signature, commitPosition: 'last-line' },
      workspace: { mode: 'shared', protected: [] },
    });
    expect(rules).toHaveLength(7);
    expect(rules[5]).toStartWith('Your signature in a commit message, as its last line: ');
  });

  test('are one text, a rule per line', () => {
    const text = rulesText(rulesInput, 'message');
    expect(text.split('\n')).toHaveLength(11);
    expect(text).toStartWith('Rules for this session, from the team file:\n- End every commit');
  });

  const closingMessage = 'These are standing rules, not a task: reply ready and wait for your brief.';
  const closingOption = 'These are standing rules, not a task.';

  test('a first message ends with the standing-rules line, whatever the file holds', () => {
    const lastLine = (input: RulesInput) => rulesText(input, 'message').split('\n').at(-1);
    // A seat with rules, a seat with only signature lines, and a team file with an empty `rules:`.
    expect(lastLine(rulesInput)).toBe(closingMessage);
    expect(lastLine({ ...rulesInput, rules: [] })).toBe(closingMessage);
    expect(lastLine({ ...rulesInput, rules: [], workspace: { mode: 'shared', protected: [] } })).toBe(closingMessage);
  });

  test('a launch option ends with only the standing-rules line, whatever the file holds', () => {
    const lastLine = (input: RulesInput) => rulesText(input, 'option').split('\n').at(-1);
    // A system prompt stays in force on every later turn, so it never asks for the ready reply.
    expect(lastLine(rulesInput)).toBe(closingOption);
    expect(lastLine({ ...rulesInput, rules: [] })).toBe(closingOption);
    expect(lastLine({ ...rulesInput, rules: [], workspace: { mode: 'shared', protected: [] } })).toBe(closingOption);
  });

  test('a file whose rules already end with the closing line gets it once, last', () => {
    const message = rulesText({ ...rulesInput, rules: [...rulesInput.rules, closingMessage] }, 'message');
    expect(message.split(closingMessage)).toHaveLength(2);
    expect(message.split('\n').at(-1)).toBe(closingMessage);
    expect(message).not.toContain(`- ${closingMessage}`);

    const option = rulesText({ ...rulesInput, rules: [...rulesInput.rules, closingOption] }, 'option');
    expect(option.split(closingOption)).toHaveLength(2);
    expect(option.split('\n').at(-1)).toBe(closingOption);
    expect(option).not.toContain(`- ${closingOption}`);
  });
});

describe('up --dry-run', () => {
  const seat = (name: string, overrides: Partial<UpSeat> = {}): UpSeat => ({
    name,
    cli: 'claude-code',
    launch: 'claude --model claude-opus-5-5',
    cwd: '.',
    label: name,
    displayAgent: 'Claude Opus 5.5 default',
    repairLine: `\`team remove ${name} --keep\` then \`team add ${name}\``,
    stopped: false,
    rules: 'Rules.',
    ...overrides,
  });

  test('a session other than default is named in every command', () => {
    expect(herdr('acme-web', 'agent', 'list')).toEqual(['herdr', '--session', 'acme-web', 'agent', 'list']);
    expect(herdr('default', 'agent', 'list')).toEqual(['herdr', 'agent', 'list']);
  });

  test('prints every herdr command in order and says nothing was run', () => {
    const plan = upPlan({
      root: '/work/acme-web',
      session: 'acme-web',
      sessionRunning: false,
      seats: [
        seat('claude-coordinator-acme'),
        seat('grok-acme', { cli: 'grok', launch: 'grok' }),
        seat('constructor-acme', { cli: 'constructor' }),
        seat('grok-acme', { stopped: true }),
        seat('claude-docs', { cwd: 'docs', label: 'docs' }),
      ],
      watchLabel: 'Watch · acme-web',
    });
    expect(formatPlan(plan)).toBe(
      [
        '+ env -i HOME=$HOME USER=$USER LOGNAME=$LOGNAME PATH=$PATH SHELL=$SHELL TERM=$TERM LANG=$LANG herdr --session acme-web server',
        '    (detached, in a clean environment; SSH_AUTH_SOCK is passed too when it is set)',
        '  wait until session acme-web is running (30 s at most)',
        '+ herdr --session acme-web workspace create --cwd /work/acme-web --label claude-coordinator-acme --no-focus',
        "+ herdr --session acme-web pane run <pane of claude-coordinator-acme> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules.'",
        '    (reads its drops at each turn start)',
        '  wait until claude-coordinator-acme shows its idle prompt (90 s at most); anything else is reported, its workspace closed without input, and the seat left out',
        '+ herdr --session acme-web agent rename <pane of claude-coordinator-acme> claude-coordinator-acme',
        "+ herdr --session acme-web pane report-metadata <pane of claude-coordinator-acme> --source team --display-agent 'Claude Opus 5.5 default'",
        '+ herdr --session acme-web workspace create --cwd /work/acme-web --label grok-acme --no-focus',
        "+ herdr --session acme-web pane run <pane of grok-acme> 'AGENT_UNATTENDED=1 grok --always-approve --rules Rules.'",
        '    (reads its drops through its MCP inbox)',
        '  wait until grok-acme shows its idle prompt (90 s at most); anything else is reported, its workspace closed without input, and the seat left out',
        '+ herdr --session acme-web agent rename <pane of grok-acme> grok-acme',
        "+ herdr --session acme-web pane report-metadata <pane of grok-acme> --source team --display-agent 'Claude Opus 5.5 default'",
        '  skip constructor-acme: no launch profile for `constructor` in this version; left out',
        '  skip grok-acme: stopped in the file; start it with `team add grok-acme`',
        '+ herdr --session acme-web workspace create --cwd /work/acme-web/docs --label docs --no-focus',
        "+ herdr --session acme-web pane run <pane of claude-docs> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules.'",
        '    (reads its drops at each turn start)',
        '  wait until claude-docs shows its idle prompt (90 s at most); anything else is reported, its workspace closed without input, and the seat left out',
        '+ herdr --session acme-web agent rename <pane of claude-docs> claude-docs',
        "+ herdr --session acme-web pane report-metadata <pane of claude-docs> --source team --display-agent 'Claude Opus 5.5 default'",
        "+ herdr --session acme-web workspace create --cwd /work/acme-web --label 'Watch · acme-web' --no-focus",
        "+ herdr --session acme-web pane run <pane of Watch · acme-web> 'team watch --session acme-web'",
        '    (a desktop notification follows when the watch exits)',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test('a running session is not started again', () => {
    const plan = upPlan({ root: '/work/a', session: 'a', sessionRunning: true, seats: [], watchLabel: 'Watch · a' });
    expect(plan.map((step) => step.kind)).toEqual(['run', 'run']);
    expect(plan[0]).toMatchObject({
      argv: ['herdr', '--session', 'a', 'workspace', 'create', '--cwd', '/work/a', '--label', 'Watch · a', '--no-focus'],
    });
  });

  test('a state hook the run installed rides at the end of the line it would print', () => {
    const plan = upPlan({
      root: '/work/acme-web',
      session: 'acme-web',
      sessionRunning: true,
      seats: [seat('worker'), seat('grok-acme', { cli: 'grok', launch: 'grok' })],
      watchLabel: 'Watch · acme-web',
      cliHooks: {
        worker: '/work/acme-web/.agents/hooks/worker.json',
        'grok-acme': '/work/acme-web/.agents/hooks/grok-acme.json',
      },
    });
    const commands = plan.flatMap((step) => (step.kind === 'run' ? [step.argv.at(-1) ?? ''] : []));
    expect(commands).toContain(
      'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules. --settings /work/acme-web/.agents/hooks/worker.json',
    );
    // The map is by seat, and only a CLI that reads the file is ever named one.
    expect(commands.some((command) => command.includes('grok') && command.includes('--settings'))).toBe(false);
  });

  test('the dry run names how each seat will learn a drop is waiting', () => {
    const plan = upPlan({
      root: '/work/acme-web',
      session: 'acme-web',
      sessionRunning: true,
      seats: [
        seat('hooked'),
        seat('inboxed', { cli: 'codex', launch: 'codex' }),
        seat('blind', { cli: 'muse', launch: 'muse' }),
        // A claude-code seat the run's map does not hold: the hook does not land, and there is
        // no MCP inbox behind it, so the launch says it watches nothing.
        seat('unhooked'),
      ],
      watchLabel: 'Watch · acme-web',
      startWatch: false,
      cliHooks: { hooked: '/work/acme-web/.agents/hooks/hooked.json' },
    });
    const notes = plan.flatMap((step) => (step.do?.do === 'launch' ? [step.note ?? ''] : []));
    expect(notes).toEqual([
      'reads its drops at each turn start',
      'reads its drops through its MCP inbox',
      'watches nothing: a drop sent here is never read',
      'watches nothing: a drop sent here is never read',
    ]);
  });

  test('the launch records the watcher it leaves beside the seat', async () => {
    // The record is what a later reading asks; the plan's own words are the dry run's answer.
    // A hook named in the run's map lands; a hook the map leaves out does not, and a seat with
    // no inbox behind it records that it watches nothing.
    const records: { seat: string; watcher: string }[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: () => true,
      typeLine: () => false,
      renameAgent: () => true,
      reportDisplayAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: (_seat, patch) => {
        if (patch.watcher) records.push({ seat: _seat, watcher: patch.watcher });
      },
      running: () => {},
      drop: () => {},
      say: () => {},
      log: () => {},
    };
    const plan = upPlan({
      root: '/work/acme-web',
      session: 'acme-web',
      sessionRunning: true,
      seats: [seat('hooked'), seat('inboxed', { cli: 'codex', launch: 'codex' }), seat('unhooked')],
      watchLabel: 'Watch · acme-web',
      startWatch: false,
      cliHooks: { hooked: '/work/acme-web/.agents/hooks/hooked.json' },
    });

    await executePlan(plan, 'acme-web', host);

    expect(new Set(records.map((record) => `${record.seat}:${record.watcher}`))).toEqual(
      new Set(['hooked:hook', 'inboxed:inbox', 'unhooked:none']),
    );
  });

  test('never holds a command that answers, closes or deletes', () => {
    const plan = upPlan({ root: '/work/a', session: 'a', sessionRunning: false, seats: [seat('one'), seat('two')], watchLabel: 'Watch · a' });
    const verbs = plan.flatMap((step) => {
      if (step.kind !== 'run') return [];
      return [step.argv, ...(step.also ? [step.also] : [])]
        .filter((argv) => argv[0] === 'herdr')
        .map((argv) => argv.slice(3, 5).join(' '));
    });
    expect(new Set(verbs)).toEqual(new Set(['workspace create', 'pane run', 'pane report-metadata', 'agent rename']));
  });

  test("a seat the file marks as a human's is not launched into or typed into", () => {
    const plan = upPlan({
      root: '/work/a',
      session: 'a',
      sessionRunning: true,
      seats: [seat('desk', { human: true })],
      watchLabel: 'Watch · a',
      startWatch: false,
    });
    // No workspace, no launch, no wait, no rules line: the skip is the whole of this seat.
    expect(plan).toEqual([
      { kind: 'skip', text: "desk: the pane is a human's; nothing is launched into it or typed into it; left as it is" },
    ]);
  });
});

describe('down --dry-run', () => {
  const seat = (name: string, state: DownSeat['state'] = 'free'): DownSeat => ({
    name,
    cli: 'claude-code',
    pane: `${name}:p1`,
    workspace: name,
    state,
  });

  test('stops each free seat, then the watch, then the empty session', () => {
    const plan = downPlan({ session: 'acme-web', seats: [seat('w1'), seat('w2')], extra: 0, watchPid: 4242, keep: [] });
    expect(formatPlan(plan)).toBe(
      [
        '+ herdr --session acme-web pane run w1:p1 /exit',
        "  wait until w1's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close w1',
        '+ herdr --session acme-web pane run w2:p1 /exit',
        "  wait until w2's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close w2',
        '+ kill 4242',
        '    (the watch)',
        '+ herdr session stop acme-web',
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test('a seat already at its exit question is left, and abandon closes it without asking', () => {
    const sitting = { ...seat('w1', 'blocked'), atExitQuestion: true };
    const left = downPlan({
      session: 's',
      seats: [sitting],
      extra: 0,
      watchPid: null,
      keep: [],
      closeUnasked: true,
      unasked: 'team down --abandon closes it',
    });
    expect(left).toEqual([
      { kind: 'skip', text: 'w1: sits at its own exit question; left running (team down --abandon closes it)' },
      { kind: 'skip', text: 'session s: not stopped, 1 agent left in it' },
    ]);
    const abandoned = downPlan({
      session: 's',
      seats: [sitting],
      extra: 0,
      watchPid: null,
      keep: [],
      abandon: true,
      closeUnasked: true,
      unasked: 'team down --abandon closes it',
    });
    expect(abandoned.map((step) => step.do && 'do' in step.do ? step.do.do : step.kind)).toEqual(['close', 'stop']);
    expect(abandoned[0]).toMatchObject({
      note: 'abandoned: nothing was typed',
      do: { do: 'close', seat: 'w1', workspace: 'w1' },
    });
  });

  test.each([
    ['working', 'w1: is working (`--wait` waits for it); left running'],
    ['blocked', 'w1: is blocked at a prompt, which `team` never answers; left running'],
    ['unknown', 'w1: shows a screen the profile does not recognise; left running'],
    ['unsent', 'w1: holds unsent text in its input box; left running'],
  ] as const)('a %s seat is left running and the session with it', (state, text) => {
    const plan = downPlan({ session: 's', seats: [seat('w1', state)], extra: 0, watchPid: null, keep: [] });
    expect(plan).toEqual([
      { kind: 'skip', text },
      { kind: 'skip', text: 'session s: not stopped, 1 agent left in it' },
    ]);
  });

  test("a seat the file marks as a human's is not typed into, even with --abandon", () => {
    const human = { ...seat('w1'), human: true as const };
    const left: Step[] = [
      { kind: 'skip', text: "w1: the pane is a human's; nothing is typed into it; left running" },
      { kind: 'skip', text: 'session s: not stopped, 1 agent left in it' },
    ];
    expect(downPlan({ session: 's', seats: [human], extra: 0, watchPid: null, keep: [] })).toEqual(left);
    // The owner's abandon closes unasked panes; a human's pane is not one it may close.
    expect(
      downPlan({ session: 's', seats: [human], extra: 0, watchPid: null, keep: [], abandon: true, closeUnasked: true }),
    ).toEqual(left);
  });

  test('a seat whose CLI exited is closed without typing, and the session follows it down', () => {
    const plan = downPlan({ session: 'acme-web', seats: [seat('w1', 'exited')], extra: 0, watchPid: null, keep: [] });
    expect(plan).toEqual([
      {
        kind: 'run',
        argv: ['herdr', '--session', 'acme-web', 'workspace', 'close', 'w1'],
        note: 'its CLI had exited; closed without typing',
        do: { do: 'close', seat: 'w1', workspace: 'w1', said: 'its CLI had exited; its workspace was closed' },
      },
      {
        kind: 'run',
        argv: ['herdr', 'session', 'stop', 'acme-web'],
        note: 'stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning',
        do: { do: 'stop', session: 'acme-web' },
      },
    ]);
  });

  test('--abandon on an exited seat takes the same close, not the abandon line', () => {
    const plan = downPlan({
      session: 'acme-web',
      seats: [seat('w1', 'exited')],
      extra: 0,
      watchPid: null,
      keep: [],
      abandon: true,
      closeUnasked: true,
      unasked: 'team down --abandon closes it',
    });
    expect(plan[0]).toMatchObject({
      note: 'its CLI had exited; closed without typing',
      do: { do: 'close', said: 'its CLI had exited; its workspace was closed' },
    });
  });

  test("a seat's call leaves an exited coordinator's seat alone, and the session with it", () => {
    const plan = downPlan({ session: 'acme-web', seats: [seat('lead', 'exited')], extra: 0, watchPid: null, keep: ['lead'] });
    expect(plan).toEqual([
      { kind: 'skip', text: "lead: left running; only the owner stops the orchestrator's or the operator's seat" },
      { kind: 'skip', text: 'session acme-web: not stopped, 1 agent left in it' },
    ]);
  });

  test("a seat's call leaves the coordinator, the operator and the session", () => {
    const plan = downPlan({
      session: 's',
      seats: [seat('lead'), seat('w1')],
      extra: 0,
      watchPid: null,
      keep: ['lead'],
    });
    expect(plan.map((step) => step.kind)).toEqual(['skip', 'run', 'wait', 'run', 'skip']);
    expect(plan.at(-1)).toEqual({ kind: 'skip', text: 'session s: not stopped, 1 agent left in it' });
  });

  test('agents the file does not name are never closed, and keep the session up', () => {
    const plan = downPlan({ session: 's', seats: [seat('w1')], extra: 2, watchPid: null, keep: [] });
    expect(plan.at(-1)).toEqual({ kind: 'skip', text: 'session s: not stopped, 2 agents left in it' });
  });

  test('the default session is never stopped', () => {
    const plan = downPlan({ session: 'default', seats: [seat('w1')], extra: 0, watchPid: null, keep: [] });
    expect(plan[0]).toMatchObject({ kind: 'run', argv: ['herdr', 'pane', 'run', 'w1:p1', '/exit'] });
    expect(plan.at(-1)).toEqual({ kind: 'skip', text: "session default: herdr's default session is never stopped" });
  });

  test('a seat of a CLI without a profile is left running', () => {
    const plan = downPlan({
      session: 's',
      seats: [{ ...seat('constructor-acme'), cli: 'constructor' }],
      extra: 0,
      watchPid: null,
      keep: [],
    });
    expect(plan[0]).toEqual({
      kind: 'skip',
      text: 'constructor-acme: no launch profile for `constructor` in this version; left running',
    });
  });
});

describe('the pane lines a report carries', () => {
  const command =
    "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 'Run the tests your change touches, not the whole suite.'";

  test("starts at the launch line's own echo when it is within reach", () => {
    const screen = `❯ ${command}\nzsh: no such file or directory\n~ ❯`;
    expect(paneExcerpt(screen, command)).toBe(
      `  | ❯ ${command}\n  | zsh: no such file or directory\n  | ~ ❯\n`,
    );
  });

  test('a failure naming the program is not taken for the echo', () => {
    // The launch line of the capture behind this: the error repeats its program and its path,
    // the echo holds the line itself.
    const short = 'zsh ../tools/x.sh --agent';
    const screen = `❯ ${short}\nzsh: can't open input file: ../tools/x.sh\n~ ❯`;
    expect(paneExcerpt(screen, short)).toBe(
      `  | ❯ ${short}\n  | zsh: can't open input file: ../tools/x.sh\n  | ~ ❯\n`,
    );
  });

  test('keeps the newest six lines when the echo scrolled out of reach', () => {
    const lines = ['one', 'two', command, 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const newest = lines.slice(-6).map((line) => `  | ${line}\n`).join('');
    expect(paneExcerpt(lines.join('\n'), command)).toBe(newest);
    expect(paneExcerpt(lines.join('\n'), command)).toContain('  | four\n');
  });

  test('styling is stripped and empty lines are dropped', () => {
    expect(paneExcerpt(`\n\n\u001b[31m❯ ${command}\u001b[0m\n \n`, command)).toBe(`  | ❯ ${command}\n`);
  });

  test('nothing to show reads as an empty excerpt', () => {
    expect(paneExcerpt(null, command)).toBe('');
    expect(paneExcerpt('', command)).toBe('');
    expect(paneExcerpt('\n \t\n', command)).toBe('');
  });

  test('a command too short to look for leaves the screen as it is', () => {
    expect(paneExcerpt('one\ntwo', 'x')).toBe('  | one\n  | two\n');
  });

  test('every control character and escape sequence is out of the lines', () => {
    // The reviewer's probe, one sample each: a carriage return would overwrite the report on the
    // terminal, and a private CSI, a backspace, a bell, a two-character escape and a DCS payload
    // must not survive as control or as the sequence's own text.
    const screens = [
      `❯ ${command}\rfake-overwrite`,
      `❯ ${command}\n\u001b[?25lhidden\u001b[?25h`,
      `❯ ${command}\n\u0008\u0008\u0008gone`,
      `❯ ${command}\n\u0007bell`,
      `❯ ${command}\n\u001b=keypad`,
      `❯ ${command}\n\u001bP1;2|payload\u001b\\after`,
    ];
    for (const screen of screens) {
      const out = paneExcerpt(screen, command);
      expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(out).not.toContain('?25l');
      expect(out).not.toContain('payload');
    }
  });

  test('string sequences are removed whole whichever introducer and terminator are mixed', () => {
    // The reviewer's mixed probe: an ESC-introduced OSC or DCS ended by the C1 ST, and a
    // C1-introduced one ended by `ESC \`, each left its payload behind. Every string sequence —
    // OSC, DCS, APC, PM, SOS — is removed with its payload whichever introducer began it
    // (7-bit `ESC x` or the 8-bit C1) and whichever terminator ends it (`ESC \`, the C1 ST, or
    // BEL for an OSC), in any mix.
    const cases = [
      '\u001b]0;secret\u009cafter', // ESC OSC, C1 ST
      '\u009d0;secret\u001b\\after', // C1 OSC, ESC \
      '\u001bP1|secret\u009cafter', // ESC DCS, C1 ST
      '\u0090q|secret\u001b\\after', // C1 DCS, ESC \
      '\u001b]0;secret\u0007after', // ESC OSC, BEL
      '\u009d0;secret\u0007after', // C1 OSC, BEL
      '\u001bP1|secret\u001b\\after', // ESC DCS, ESC \
      '\u0090q|secret\u009cafter', // C1 DCS, C1 ST
      '\u001b_q|secret\u001b\\after', // ESC APC
      '\u009eQ|secret\u009cafter', // C1 PM
      '\u001bXq|secret\u001b\\after', // ESC SOS
      '\u0098Q|secret\u009cafter', // C1 SOS
    ];
    for (const one of cases) {
      const out = paneExcerpt(`❯ ${command}\n${one}\n~ ❯`, command);
      expect(out).not.toContain('secret');
      expect(out).toContain('  | after\n');
    }
  });

  test('a string sequence spanning the six-line cut is removed whole', () => {
    // The reviewer's cut-spanning probe: an OSC begins before the eventual six-line tail and ends
    // with `ESC \` in the tail. The entire sequence and its payload must be removed whole.
    const lines = [
      `❯ ${command}`,
      'old line',
      '\u001b]0;secret-one',
      'secret-two',
      'secret-three',
      'secret-four',
      'secret-five',
      'secret-six\u001b\\after',
    ];
    const out = paneExcerpt(lines.join('\n'), command);
    expect(out).not.toContain('secret');
    expect(out).toContain('  | after\n');
  });

  test('an opener in the dropped part and its terminator in the kept part are removed whole', () => {
    const lines = [
      'dropped line 1',
      '\u001b]0;secret-dropped',
      'dropped line 2',
      'dropped line 3',
      'dropped line 4',
      'dropped line 5',
      `❯ ${command}`,
      'kept line 1',
      'kept line 2\u001b\\after-terminator',
    ];
    const out = paneExcerpt(lines.join('\n'), command);
    expect(out).not.toContain('secret');
    expect(out).toContain('  | after-terminator\n');
  });

  test('an opener in the kept part with no terminator is removed to the end of the text', () => {
    const lines = [
      `❯ ${command}`,
      'kept line 1',
      '\u001b]0;secret-unterminated',
      'kept line 2',
      'kept line 3',
    ];
    const out = paneExcerpt(lines.join('\n'), command);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('kept line 2');
    expect(out).not.toContain('kept line 3');
    expect(out).toContain('  | kept line 1\n');
  });

  test('an unterminated string sequence is removed to the end of the text', () => {
    const out = paneExcerpt(`❯ ${command}\n\u001b]0;secret-no-end\nnext line\n~ ❯`, command);
    expect(out).not.toContain('secret-no-end');
    expect(out).not.toContain('next line');
    expect(out).toBe(`  | ❯ ${command}\n`);
  });

  test('a line longer than the bound is cut to 200 characters and marked', () => {
    const out = paneExcerpt(`❯ ${command}\n${'x'.repeat(200_000)}\n~ ❯`, command);
    expect(out).toContain(`  | ${'x'.repeat(200)}…\n`);
    const longest = Math.max(...out.split('\n').map((line) => line.length));
    expect(longest).toBe('  | '.length + 200 + '…'.length);
  });

  test('every kind of string sequence, in 7-bit and C1 forms, is removed whole with its legal terminators', () => {
    // 5 kinds × 2 opener forms × each legal terminator:
    // OSC ends at BEL (\x07), 7-bit ST (\x1b\\), or C1 ST (\x9c).
    // DCS, APC, PM, SOS end at 7-bit ST (\x1b\\) or C1 ST (\x9c).
    const kinds = [
      { name: 'OSC', openers: ['\x1b]', '\x9d'], terminators: ['\x07', '\x1b\\', '\x9c'] },
      { name: 'DCS', openers: ['\x1bP', '\x90'], terminators: ['\x1b\\', '\x9c'] },
      { name: 'SOS', openers: ['\x1bX', '\x98'], terminators: ['\x1b\\', '\x9c'] },
      { name: 'PM',  openers: ['\x1b^', '\x9e'], terminators: ['\x1b\\', '\x9c'] },
      { name: 'APC', openers: ['\x1b_', '\x9f'], terminators: ['\x1b\\', '\x9c'] },
    ];
    for (const { openers, terminators } of kinds) {
      for (const op of openers) {
        for (const term of terminators) {
          const input = `before${op}hidden-payload${term}after`;
          expect(plainPaneText(input)).toBe('beforeafter');
        }
      }
    }
  });

  test('BEL inside DCS, APC, PM, SOS is not a terminator and the payload is removed up to ST', () => {
    // For non-OSC sequences, BEL is payload: opener + a + BEL + b + ST + visible yields visible only.
    const nonOscOpeners = [
      '\x1bP', '\x90', // DCS
      '\x1bX', '\x98', // SOS
      '\x1b^', '\x9e', // PM
      '\x1b_', '\x9f', // APC
    ];
    const terminators = ['\x1b\\', '\x9c'];
    for (const op of nonOscOpeners) {
      for (const term of terminators) {
        const input = `${op}hidden-a\x07hidden-b${term}visible`;
        const out = plainPaneText(input);
        expect(out).toBe('visible');
        expect(out).not.toContain('hidden-a');
        expect(out).not.toContain('hidden-b');
      }
    }
  });

  test('mixed and nested sequences, lone escapes and STs', () => {
    // An opener inside a payload
    expect(plainPaneText('before\x1bPouter\x1b]0;inner\x07still-outer\x1b\\after')).toBe('beforeafter');
    expect(plainPaneText('before\x1b]0;outer\x1bPinner\x07after')).toBe('beforeafter');
    expect(plainPaneText('before\x1b]0;outer\x1bPinner\x1b\\after')).toBe('beforeafter');
    expect(plainPaneText('before\x1bPouter\x90inner\x1b\\after')).toBe('beforeafter');
    expect(plainPaneText('before\x1b]0;outer\x1b]0;inner\x07after')).toBe('beforeafter');

    // An OSC ended by BEL followed by plain text
    expect(plainPaneText('\x1b]0;title\x07plain text')).toBe('plain text');

    // A sequence spanning newlines
    expect(plainPaneText('line 1\n\x1b]0;multi\nline\x07line 2')).toBe('line 1\nline 2');

    // An unterminated sequence is removed to the end of the text
    expect(plainPaneText('visible\x1b]0;no-end\nmore lines')).toBe('visible');
    expect(plainPaneText('visible\x1bPno-end\nmore lines')).toBe('visible');

    // A lone ESC at the end of the text
    expect(plainPaneText('plain text\x1b')).toBe('plain text');

    // A lone ST (7-bit and C1) in plain text
    expect(plainPaneText('plain\x1b\\text')).toBe('plaintext');
    expect(plainPaneText('plain\x9ctext')).toBe('plaintext');
  });

  test('a C1 CSI written as its introducer plus the 7-bit tail is removed whole, tail included', () => {
    // `\x9b` is the 8-bit CSI introducer; a mangled writing puts the 7-bit `[` after it. The
    // introducer, the bracket and the sequence's own tail are one sequence: the whole of it goes,
    // and none of it is left in the line as if it were text.
    expect(plainPaneText('a\x9b[2Jb')).toBe('ab');
    expect(plainPaneText('r\x9b[31mX')).toBe('rX');
    expect(plainPaneText('  d\x9b[2Je')).toBe('  de');
    // A lone introducer, with no tail to introduce, goes and its neighbours stay.
    expect(plainPaneText('x\x9b\u202ey')).toBe('xy');
    // A 7-bit CSI, the same sequence written with ESC, is removed whole as before.
    expect(plainPaneText('a\x1b[2Jb')).toBe('ab');
  });

  test('the invisible format characters are removed from a pane line, and letters of any script stay', () => {
    // The same class the writer removes of every field: the bidi embeddings, overrides and
    // isolates, the direction marks, the zero-width characters and the byte-order mark. Each
    // reorders or hides what a line shows, so a report row could display other words than it
    // holds. Ordinary letters — Arabic, Hebrew — are text, not format, and are kept as written.
    const invisible = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061c\u200b\u200c\u200d\u2060\ufeff';
    expect(plainPaneText(`before${invisible}after`)).toBe('beforeafter');
    for (const character of invisible) expect(plainPaneText(character)).toBe('');
    expect(plainPaneText('مراجعة: لا صلاحية للكتابة')).toBe('مراجعة: لا صلاحية للكتابة');
    expect(plainPaneText('ביקורת: לא אושר')).toBe('ביקורת: לא אושר');
  });

  test('the rule’s newer classes: soft hyphen, U+180E, the tag block, the separators folded like LF, selectors kept', () => {
    // The rule at `plainText` rather than a list of characters: every Cf character goes — the
    // soft hyphen U+00AD and U+180E among them, and the assigned tag characters U+E0001–U+E007F
    // — and the tag block goes whole, because U+E0000 and U+E001F are unassigned, not Cf. U+2028
    // and U+2029 fold to LF exactly as a line feed does, so `plainLine` folds all three alike.
    // The variation selectors stay: they only choose how the character before them is drawn.
    // U+200D goes with the Cf class: a joiner-joined emoji prints as the parts the string holds.
    const tags = '\u{e0000}\u{e0001}\u{e001f}\u{e0020}\u{e007f}';
    expect(plainPaneText(`before\u00ad\u180e${tags}after`)).toBe('beforeafter');
    expect(plainPaneText('a\u2028b\u2029c')).toBe('a\nb\nc');
    expect(plainLine('a\u2028b\u2029c')).toBe('a b c');
    expect(plainLine('a\n\u2028\u2029b')).toBe('a b');
    expect(plainPaneText('a\u{fe0e}b\u{fe0f}c\u{e0100}d')).toBe('a\u{fe0e}b\u{fe0f}c\u{e0100}d');
    expect(plainPaneText('👩\u200d💻')).toBe('👩💻');
    // The cleaning is idempotent: over its own output a second pass changes nothing, so a value
    // cleaned at the call site and again at the writer (or at the log) is cleaned once, really.
    const mixed = 'a\u00ad\u2028\x1b[31mb\u202ec\u{e0001}\u{fe0f}d\r';
    expect(plainLine(plainLine(mixed))).toBe(plainLine(mixed));
    expect(plainText(plainText(mixed))).toBe(plainText(mixed));
  });

  test('stress test: 200-line 2 MB text with unterminated openers finishes in well under 1000 ms', () => {
    // Guards against quadratic backtracking: the previous regular expressions searched from
    // every unterminated opener to the end of the text before the second regex dropped it,
    // taking nearly a second on 2 MB and 9 s on 20 MB. The linear state machine finishes in
    // well under 100 ms.
    const line = '\x1b]0;unterminated-payload-' + 'x'.repeat(10_000) + '\n';
    const text = line.repeat(200);
    const start = performance.now();
    const out = plainPaneText(text);
    const duration = performance.now() - start;
    expect(out).toBe('');
    expect(duration).toBeLessThan(1000);
  });

  test('a pending ESC does not reach across a removed string to consume text or form new control sequences', () => {
    // When a lone ESC is followed by a string opener, the ESC is dropped so it never reaches
    // across the removed string to consume plain text in subsequent passes.
    expect(plainPaneText('\x1b\x9dhidden\x9cafter')).toBe('after');

    // For each of ], P, X, ^, _: ESC + C1 OSC + ST + that character + visible
    // produces that character + visible; the same without the leading ESC.
    const probeChars = [']', 'P', 'X', '^', '_'];
    for (const ch of probeChars) {
      expect(plainPaneText(`\x1b\x9d\x9c${ch}visible`)).toBe(`${ch}visible`);
      expect(plainPaneText(`\x9d\x9c${ch}visible`)).toBe(`${ch}visible`);
    }

    // Path probe: text starting with P after a removed sequence is preserved intact.
    expect(plainPaneText('\x1b\x9dx\x9cPath: /tmp')).toBe('Path: /tmp');

    // Multiple ESCs before a string opener are all dropped before the removed sequence.
    expect(plainPaneText('\x1b\x1b]0;title\x07after')).toBe('after');
  });

  test('randomised comparison: scanner and independent range-oriented reference agree on all cases', () => {
    // Independent reference: walks the text, searches forward from each opener for its
    // legal terminator only, drops the run of ESC immediately before the opener, opener,
    // payload, and terminator, and copies all other characters. No shared helper with scanner.
    function referenceStrip(text: string): string {
      let result = '';
      let i = 0;
      while (i < text.length) {
        const escStart = i;
        while (i < text.length && text[i] === '\x1b') {
          i++;
        }
        const escCount = i - escStart;

        const c = text[i];
        let isOsc = false;
        let isOther = false;
        let openerLen = 0;

        if (escCount > 0) {
          if (c === ']') {
            isOsc = true;
            openerLen = 1;
          } else if (c === 'P' || c === 'X' || c === '^' || c === '_') {
            isOther = true;
            openerLen = 1;
          } else if (c === '\x9d') {
            isOsc = true;
            openerLen = 1;
          } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
            isOther = true;
            openerLen = 1;
          }
        } else {
          if (c === '\x9d') {
            isOsc = true;
            openerLen = 1;
          } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
            isOther = true;
            openerLen = 1;
          }
        }

        if (!isOsc && !isOther) {
          if (escCount > 0) {
            result += '\x1b'.repeat(escCount);
          }
          if (i < text.length) {
            result += c;
            i++;
          }
          continue;
        }

        const payloadStart = i + openerLen;
        let termEnd = -1;

        let j = payloadStart;
        while (j < text.length) {
          const ch = text[j];
          if (isOsc && (ch === '\x07' || ch === '\x9c')) {
            termEnd = j + 1;
            break;
          }
          if (isOther && ch === '\x9c') {
            termEnd = j + 1;
            break;
          }
          if (ch === '\x1b') {
            let k = j;
            while (k < text.length && text[k] === '\x1b') {
              k++;
            }
            if (k < text.length) {
              const next = text[k];
              if (isOsc && (next === '\\' || next === '\x07' || next === '\x9c')) {
                termEnd = k + 1;
                break;
              }
              if (isOther && (next === '\\' || next === '\x9c')) {
                termEnd = k + 1;
                break;
              }
            }
            j = k;
            continue;
          }
          j++;
        }

        if (termEnd === -1) {
          break;
        } else {
          i = termEnd;
        }
      }
      return result;
    }

    function mulberry32(seed: number) {
      return function() {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const rand = mulberry32(0x12345678);
    const alphabet = [
      'a', 'b', 'c', '\n', '\x1b', '\x07',
      ']', 'P', 'X', '^', '_',
      '\x9d', '\x90', '\x98', '\x9e', '\x9f',
      '\\', '\x9c',
    ];

    const trials = 5000;
    for (let t = 0; t < trials; t++) {
      const len = Math.floor(rand() * 40);
      let str = '';
      for (let i = 0; i < len; i++) {
        const idx = Math.floor(rand() * alphabet.length);
        str += alphabet[idx];
      }
      const fast = stripControlStrings(str);
      const ref = referenceStrip(str);
      expect(fast).toBe(ref);
    }
  });
});

describe('the row a stopped delivery prints', () => {
  // The first mismatching row is pane text, whatever the box drew: control characters and all.
  // It goes to the terminal alone — stripped of every control character and cut to 200 — and
  // never to the log, which holds the report only (a BEL would ring and a CR would overwrite
  // the report, and an unbounded row would flood the terminal).
  const ROW_SAYED = 'coder: first row of its box that is not the rules line: ';

  function stoppedOn(row: string) {
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: () => true,
      typeLine: () => false,
      deliverRules: async () => ({ stop: 'read-back', typed: true, sent: false, kind: 'unsent' as const, row }),
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { said.push(line); },
      log: (who, what) => { logged.push({ who, what }); },
    };
    const steps: Step[] = [{
      kind: 'run',
      argv: [],
      do: {
        do: 'deliver', seat: 'coder', label: 'coder', cli: 'codex', rules: 'Rules.',
        path: '/x/rules/coder.md',
        line: 'Read /x/rules/coder.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.',
        seconds: 1, pane: 'p1',
      },
    }];
    return { said, logged, run: () => executePlan(steps, 'acme', host) };
  }

  test('a BEL, a CR and escape sequences are stripped; the row never reaches the log', async () => {
    const row = '\u0007bad-row\r\u001b]0;secret\u0007after\u001b[?25l';
    const { said, logged, run } = stoppedOn(row);
    await run();
    // One say for the seat: its record, then — on the next line, as the record's detail — the row.
    expect(said.length).toBe(1);
    const lines = (said[0] ?? '').split('\n');
    expect(lines[0]).toContain("rules typed, not sent: the read-back didn't match");
    expect(lines[1]).toBe(`${ROW_SAYED}bad-rowafter`);
    expect(said.join('')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(said.join('')).not.toContain('secret');
    expect(logged).toEqual([{ who: 'coder', what: expect.stringContaining("rules typed, not sent: the read-back didn't match") }]);
    expect(logged[0]?.what).not.toContain('bad-row');
  });

  test('a 5,000-character row is cut to 200 characters and marked', async () => {
    const row = `${'x'.repeat(4_994)}\u0007${'y'.repeat(5)}`;
    const { said, logged, run } = stoppedOn(row);
    await run();
    const lines = (said[0] ?? '').split('\n');
    expect(lines[1]).toBe(`${ROW_SAYED}${'x'.repeat(200)}…`);
    expect(lines[1]?.length).toBe(ROW_SAYED.length + 200 + '…'.length);
    expect(said.join('')).not.toContain('y'.repeat(5));
    expect(logged[0]?.what).not.toMatch(/x{10}/);
  });
});
