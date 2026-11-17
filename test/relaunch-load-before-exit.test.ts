// A seat stopped in place (`relaunch` exits its CLI, `repair` closes its pane) must never be left
// half stopped: the launch preconditions — the machine-load gate and the ceilings — are asked
// before the exit or the close, a refusal leaves the seat running with nothing typed, and the
// launch that follows an allowed exit is not refused by a later reading. Pane ids, processes and
// the clock are synthetic.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';

const SESSION = 'load-scene';
const SEAT = 'builder-5';
const PANE = 'w9:p1';
const WORKSPACE = 'w9';
const LOAD = 'the machine is loaded: 3.1 per core, over the 3 per core this file starts seats at';

function relaunch(): Step {
  return { kind: 'run', argv: [], do: { do: 'relaunch', seat: SEAT, cli: 'codex', pane: PANE, workspace: WORKSPACE,
    launched: { shell: 100, cli: [200] }, endpoint: true } };
}
function repair(): Step {
  return { kind: 'run', argv: [], do: { do: 'repair', seat: SEAT, cli: 'codex', pane: PANE, workspace: WORKSPACE,
    launched: { shell: 100, cli: [200] } } };
}

function world(allow: () => string | null) {
  const effects: string[] = [];
  const said: string[] = [];
  let asked = 0;
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => { effects.push('create'); return { pane: PANE, workspace: WORKSPACE }; },
    paneRun: () => { effects.push('run'); return true; },
    typeLine: async () => { effects.push('type'); return false; },
    typeText: () => { effects.push('type'); return false; },
    sendKey: () => { effects.push('key'); return false; },
    pressEnter: () => { effects.push('enter'); return false; },
    renameAgent: () => true,
    agentList: () => [{ name: SEAT, agent: 'codex', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: '/fixture/seat' }],
    closeWorkspace: () => { effects.push('close'); return true; },
    stopSession: () => true,
    kill: () => { effects.push('kill'); return true; },
    agentPanes: () => [PANE],
    foreground: () => ['codex'],
    processInfo: () => ({ shell: 100, foreground: [200] }),
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => { asked += 1; return allow(); },
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => { said.push(line); },
    log: () => {},
  };
  return { host, effects, said, asked: () => asked };
}

test('a relaunch the load gate refuses exits nothing: the seat keeps running, nothing typed', async () => {
  const made = world(() => LOAD);
  await executePlan([relaunch()], SESSION, made.host);
  expect(made.asked()).toBe(1);
  expect(made.effects).toEqual([]);
  expect(made.said.join('')).toContain('left running, nothing typed');
});

test('a repair the load gate refuses closes nothing', async () => {
  const made = world(() => LOAD);
  await executePlan([repair()], SESSION, made.host);
  expect(made.asked()).toBe(1);
  expect(made.effects).toEqual([]);
  expect(made.said.join('')).toContain('left running, nothing typed');
});

test('a relaunch the gate allows asks before any key, never after the exit', async () => {
  const order: string[] = [];
  const made = world(() => { order.push('allow'); return null; });
  const typeText = made.host.typeText!;
  made.host.typeText = (session, pane, text) => { order.push('type'); return typeText(session, pane, text); };
  await executePlan([relaunch()], SESSION, made.host);
  expect(order[0]).toBe('allow');
  expect(order.filter((item) => item === 'allow')).toHaveLength(1);
});

