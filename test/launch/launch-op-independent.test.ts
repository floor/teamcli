// The launch behaviours 0.5.10 fixed, pinned independently of the code-path tests: a refused
// rules write starts neither the managed endpoint nor the command; the runtime relaunch types
// only once the CLI has left the foreground; carriage comes from the plan's flag, never a
// search of the quoted command; and a wrapper's own process is not a CLI for readiness.
// Each scene fails on the release before the fix, where the behaviour differed.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import { upPlan, type Step } from '../../src/launch/plan.ts';
import { recordText } from '../../src/launch/progress.ts';
import { shellQuote } from '../../src/profiles/profile.ts';

const PATH = "/x/rules/o'brien.md";
const LINE = "Read /x/rules/o'brien.md (sha256 1f2e3d4c5b6a): your standing rules; reply ready.";

function baseHost(over: Partial<Host> = {}): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: (_s, _c, label) => ({ pane: 'p1', workspace: `w-${label}` }),
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
    record: () => {},
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
    ...over,
  };
}

describe('must-fix 4: a refused rules write starts neither endpoint nor command', () => {
  function launcher(write: boolean, carried: boolean) {
    const events: string[] = [];
    const out: string[] = [];
    const host = baseHost({
      deliverRules: async (_s, _p, _c, file) => {
        events.push(file.writeOnly === true ? 'write' : 'deliver');
        return write;
      },
      managedCodexEndpoint: async () => {
        events.push('endpoint');
        return { kind: 'up', url: 'unix:///tmp/t3.sock', started: true };
      },
      paneRun: (_s, _p, cmd) => {
        events.push(`run:${cmd.includes(LINE) ? 'with-line' : 'plain'}`);
        return true;
      },
      say: (line) => { out.push(line); },
      final: (seat, record) => { out.push(recordText(seat, record)); },
    });
    const steps: Step[] = [
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'launch', seat: 'coder', label: 'coder', command: `codex ${shellQuote(LINE)}`,
          pane: 'p1', cli: 'codex', cwd: '.', rulesCarried: carried,
          codexEndpoint: { dir: '/tmp/t3/.agents' },
        },
      },
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'deliver', seat: 'coder', label: 'coder', cli: 'codex', rules: 'Rules.',
          path: PATH, line: LINE, seconds: 1, pane: 'p1', launchCanCarryRules: true,
        },
      },
    ];
    return { events, out, done: executePlan(steps, 'acme', host) };
  }

  test('the line is quoted beyond a substring match, and a refused write leaves the endpoint and the pane untouched', async () => {
    expect(`codex ${shellQuote(LINE)}`.includes(LINE)).toBe(false);
    const { events, out, done } = launcher(false, true);
    await done;
    expect(events).toEqual(['write']);
    expect(out.join('\n')).toContain('its rules file was not written; nothing was launched');
    expect(out.join('\n')).not.toContain('ready');
  });

  test('a write that lands comes before the endpoint and the command, in that order', async () => {
    const { events, out, done } = launcher(true, true);
    await done;
    expect(events).toEqual(['write', 'endpoint', 'run:plain']);
    expect(out.join('\n')).toContain('ready');
  });

  test('a launch that carries nothing still starts its endpoint: the refusal is the write, not the carriage', async () => {
    const { events, done } = launcher(true, false);
    await done;
    expect(events.slice(0, 2)).toEqual(['endpoint', 'run:plain']);
  });

  test('through the real plan: a refused write on an endpoint launch starts no endpoint', async () => {
    const events: string[] = [];
    const host = baseHost({
      deliverRules: async (_s, _p, _c, file) => { events.push(file.writeOnly === true ? 'write' : 'deliver'); return false; },
      managedCodexEndpoint: async () => { events.push('endpoint'); return { kind: 'up', url: 'unix:///tmp/t3.sock', started: true }; },
      paneRun: () => { events.push('run'); return true; },
    });
    const steps = upPlan({
      root: '/tmp/acme', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      stateDir: '/tmp/acme/.agents',
      seats: [{
        name: 'coder', cli: 'codex', launch: 'codex', cwd: '/tmp/acme', label: 'coder', stopped: false,
        rules: 'Rules.', repairLine: 'repair', rulesFile: { path: PATH, line: LINE }, codexDaemon: 'on',
      }],
    });
    await executePlan(steps, 'acme', host);
    expect(events).toEqual(['write']);
  });
});

describe('must-fix 3: the relaunch types only once the CLI has left the foreground', () => {
  const SES = 'ses_9f8e7d6c5b4a';
  const MISSING = `claude --resume ${SES}`;
  const SCREEN = `${MISSING}\nNo conversation found with session ID: ${SES}\n❯ `;

  function relauncher(front: string[] | null | 'unread', back: boolean | null) {
    const runs: string[] = [];
    const typed: string[] = [];
    const host = baseHost({
      paneRun: (_s, _p, cmd) => { runs.push(cmd); return true; },
      typeLine: (_s, _p, text) => { typed.push(text); return false; },
      classify: () => 'unknown',
      paneText: () => SCREEN,
      shellBack: () => back,
      ...(front === 'unread' ? {} : { foreground: () => front }),
    });
    const steps: Step[] = [
      {
        kind: 'run',
        argv: [],
        do: { do: 'launch', seat: 'worker', label: 'worker', command: MISSING, pane: 'p1', cli: 'claude-code', cwd: '.' },
      },
      {
        kind: 'wait',
        text: 'until worker shows its idle prompt',
        do: {
          do: 'idle', seat: 'worker', label: 'worker', cli: 'claude-code', seconds: 1,
          command: MISSING, pane: 'p1', repairLine: 'repair',
        },
      },
    ];
    return { runs, typed, done: executePlan(steps, 'acme', host) };
  }

  test('the CLI itself in front keeps the relaunch away', async () => {
    const { runs, typed, done } = relauncher(['claude'], false);
    await done;
    expect(runs.length).toBe(1);
    expect(typed).toEqual([]);
  });

  test('one name of the profile among several in front is enough: the CLI has not left', async () => {
    const { runs, typed, done } = relauncher(['node', 'claude'], false);
    await done;
    expect(runs.length).toBe(1);
    expect(typed).toEqual([]);
  });

  test('a bare shell in front lets it run once, and the fresh line carries no resume', async () => {
    const { runs, typed, done } = relauncher(['zsh'], false);
    await done;
    expect(runs.length).toBe(2);
    expect(runs[1]).not.toContain('--resume');
    expect(typed).toEqual([]);
  });

  test('an empty foreground is the CLI gone: the relaunch runs', async () => {
    const { runs, typed, done } = relauncher([], false);
    await done;
    expect(runs.length).toBe(2);
    expect(runs[1]).not.toContain('--resume');
    expect(typed).toEqual([]);
  });

  test('an unreadable foreground is not taken as gone', async () => {
    const { runs, typed, done } = relauncher('unread', null);
    await done;
    expect(runs.length).toBe(1);
    expect(typed).toEqual([]);
  });

  test('the host reading the shell back is enough without a process read', async () => {
    const { runs, done } = relauncher('unread', true);
    await done;
    expect(runs.length).toBe(2);
    expect(runs[1]).not.toContain('--resume');
  });
});

describe('item 5: the plan decides carriage, never a search of the command text', () => {
  function plan() {
    return upPlan({
      root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [{
        name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false,
        rules: 'Rules.', repairLine: 'repair', rulesFile: { path: PATH, line: LINE },
      }],
    });
  }

  test('a message-mode seat with a launch prompt carries the line, and its deliver step says a launch can', () => {
    const steps = plan();
    const launch = steps.find((step) => step.do?.do === 'launch')?.do;
    if (launch?.do !== 'launch') throw new Error('no launch in the plan');
    // The built command never holds the line as a substring: shellQuote turns its apostrophe.
    expect(launch.command.includes(LINE)).toBe(false);
    expect(launch.rulesCarried).toBe(true);
    const deliver = steps.find((step) => step.do?.do === 'deliver');
    if (deliver?.do?.do !== 'deliver') throw new Error('no deliver in the plan');
    expect(deliver.do.launchCanCarryRules).toBe(true);
    expect(deliver.note ?? '').toContain('ride the launch line');
    expect(deliver.note ?? '').toContain('team restart');
  });

  test('executing that plan writes the file before the command although the quoted line is not found in it', async () => {
    const events: string[] = [];
    const host = baseHost({
      deliverRules: async (_s, _p, _c, file) => { events.push(file.writeOnly === true ? 'write' : 'deliver'); return true; },
      paneRun: (_s, _p, cmd) => { events.push(`run:${cmd.includes(LINE) ? 'with-line' : 'plain'}`); return true; },
    });
    await executePlan(plan(), 'acme', host);
    expect(events.slice(0, 2)).toEqual(['write', 'run:plain']);
  });

  // All eight shipped message-mode profiles name a launch prompt, so the plan's false flag is
  // only reachable through a hand-built op; the wording is still the contract.
  function unlaunched(canCarry: boolean) {
    const out: string[] = [];
    const host = baseHost({
      deliverRules: async (_s, _p, _c, file) => file.writeOnly === true,
      final: (seat, record) => { out.push(recordText(seat, record)); },
    });
    const steps: Step[] = [{
      kind: 'run',
      argv: [],
      do: {
        do: 'deliver', seat: 'reviewer', label: 'reviewer', cli: 'codex', rules: 'Rules.',
        path: PATH, line: LINE, seconds: 1, pane: 'p1', launchCanCarryRules: canCarry,
      },
    }];
    return { out, done: executePlan(steps, 'acme', host) };
  }

  test('with no launch prompt anywhere, the report says so and names no restart', async () => {
    const { out, done } = unlaunched(false);
    await done;
    const text = out.join('\n');
    expect(text).toContain('takes no initial prompt at launch, so no launch carries them');
    expect(text).toContain('its rules file is written');
    expect(text).not.toContain('restart');
  });

  test('where a launch can carry them, the report still names the restart', async () => {
    const { out, done } = unlaunched(true);
    await done;
    expect(out.join('\n')).toContain('run team restart reviewer');
  });
});

describe('wrapper scenes: a foreground pid is not a CLI', () => {
  function wrapper(processFront: number[], argv0s: string[] | null) {
    const out: string[] = [];
    let t = 0;
    const host = baseHost({
      createWorkspace: (_s, _c, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      agentPanes: () => ['alpha-pane'],
      classify: () => 'unknown',
      shellBack: () => null,
      agentStatus: () => 'idle',
      processInfo: () => ({ shell: 100, foreground: processFront }),
      ...(argv0s === null ? {} : { foreground: () => argv0s }),
      sleep: async () => { t += 1000; },
      now: () => t,
      final: (seat, record) => { out.push(recordText(seat, record)); },
    });
    const steps: Step[] = [
      { kind: 'run', argv: [], do: { do: 'create', seat: 'alpha', label: 'alpha', cwd: '.', repairLine: 'repair' } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'alpha', label: 'alpha', command: 'claude' } },
      {
        kind: 'wait',
        text: 'until alpha shows its idle prompt',
        do: {
          do: 'idle', seat: 'alpha', label: 'alpha', cli: 'claude-code', seconds: 1,
          command: 'claude', pane: 'alpha-pane', repairLine: 'repair',
        },
      },
      {
        kind: 'run',
        argv: [],
        do: { do: 'rename', seat: 'alpha', label: 'alpha', seconds: 5, rules: 'option', pane: 'alpha-pane' },
      },
    ];
    return { out, done: executePlan(steps, 'acme', host) };
  }

  test('a non-exec wrapper alive after its CLI exits is not a CLI: not ready', async () => {
    const { out, done } = wrapper([1081, 1082], ['zsh', 'sleep']);
    await done;
    expect(out.join('')).not.toContain('ready');
    expect(out.join('')).toContain('left out');
  });

  test('an exec wrapper, whose name is the CLI, is: ready', async () => {
    const { out, done } = wrapper([1081], ['claude']);
    await done;
    expect(out.join('')).toBe('alpha: ready');
  });

  test('a pane back at its shell is not ready whatever herdr reports', async () => {
    const { out, done } = wrapper([100], ['zsh']);
    await done;
    expect(out.join('')).toContain('left out');
    expect(out.join('')).not.toContain('ready');
  });

  test('the CLI in front of the pane is ready', async () => {
    const { out, done } = wrapper([1081], ['claude']);
    await done;
    expect(out.join('')).toBe('alpha: ready');
  });
});
