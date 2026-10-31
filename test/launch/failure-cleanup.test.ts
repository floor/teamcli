import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import { endpointCleanupHost } from '../../src/launch/endpoint-cleanup.ts';

function scene(input: { stopped?: boolean; started?: boolean; kind?: 'idle' | 'permission' | 'trust' | 'provider error'; alive?: boolean } = {}) {
  const events: string[] = [];
  const records: unknown[] = [];
  let retained = true;
  let clock = 0;
  const host: Host = {
    startServer: () => true, sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    managedCodexEndpoint: async () => { events.push('start'); return { kind: 'up', url: 'unix:///tmp/synthetic.sock', started: input.started ?? true }; },
    stopManagedCodexEndpoint: () => { events.push('stop'); return { stopped: input.stopped ?? true, why: 'ownership could not be proven' }; },
    paneRun: () => { events.push('run'); return true; },
    typeLine: () => false, renameAgent: () => true,
    closeWorkspace: () => { events.push('close'); return true; },
    stopSession: () => true, kill: () => true,
    agentPanes: () => ['p1'],
    agentList: () => [{ name: 'coder', agent: 'codex', pane: 'p1', workspace: 'w1', status: 'idle', cwd: '.' }],
    workspaces: () => [{ id: 'w1', label: 'coder' }],
    workspacePanes: () => ['p1'],
    seatStates: () => ({ coder: { stage: 'launched', pane: 'p1', workspace: 'w1', launched: { shell: 100, cli: [200] } } }),
    classify: () => input.kind ?? 'permission',
    shellBack: () => input.alive === false,
    foreground: () => input.alive === false ? ['synthetic-shell'] : ['codex'],
    processInfo: () => ({ shell: 100, foreground: input.alive === false ? [100] : [200] }),
    sleep: async (ms) => { clock += ms; }, now: () => clock,
    allow: () => null, record: () => {}, running: () => {},
    drop: () => { events.push('drop'); retained = false; },
    say: () => {}, log: () => {}, final: (_seat, record) => { records.push(record); },
  };
  const plan: Step[] = [
    { kind: 'run', argv: [], do: { do: 'create', seat: 'coder', label: 'coder', cwd: '.', repairLine: 'repair' } },
    { kind: 'run', argv: [], do: { do: 'launch', seat: 'coder', label: 'coder', command: 'codex', cli: 'codex', cwd: '.', codexEndpoint: { dir: '/tmp/synthetic' } } },
    { kind: 'wait', text: 'idle', do: { do: 'idle', seat: 'coder', label: 'coder', cli: 'codex', seconds: 1, command: 'codex', repairLine: 'repair' } },
    { kind: 'run', argv: [], do: { do: 'rename', seat: 'coder', label: 'coder', cli: 'codex', seconds: 1, rules: 'option' } },
  ];
  return { host, plan, events, records, retained: () => retained };
}

test.each(['permission', 'trust', 'provider error'] as const)('a %s failure stops its new endpoint before dropping the record', async (kind) => {
  const run = scene({ kind });
  await executePlan(run.plan, 'scratch', run.host);
  expect(run.events).toEqual(['start', 'run', 'close', 'stop', 'drop']);
  expect(run.retained()).toBe(false);
});

test('an unproven endpoint stop retains the record and holds the run', async () => {
  const run = scene({ stopped: false });
  const result = await executePlan(run.plan, 'scratch', run.host);
  expect(run.events).toEqual(['start', 'run', 'close', 'stop']);
  expect(run.retained()).toBe(true);
  expect(result.held).toBe(true);
});

test('a reused endpoint is not stopped or forgotten by a failed launch', async () => {
  const run = scene({ started: false });
  await executePlan(run.plan, 'scratch', run.host);
  expect(run.events).toEqual(['start', 'run', 'close']);
  expect(run.retained()).toBe(true);
});

test.each([true, false])('a dialog outside execute also guards the record drop: stopped=%s', async (stopped) => {
  const run = scene({ stopped });
  const wrapped = endpointCleanupHost(run.host);
  wrapped.dialog = {
    mode: 'prompt',
    run: async () => {
      wrapped.closeWorkspace('scratch', 'w1');
      return wrapped.drop('coder') ? { kind: 'skipped' }
        : { kind: 'left out', reason: 'endpoint not stopped', detail: '' };
    },
  };
  const report = await executePlan(run.plan, 'scratch', wrapped);
  expect(run.events).toEqual(['start', 'run', 'close', 'stop', ...(stopped ? ['drop'] : [])]);
  expect(run.retained()).toBe(!stopped);
  expect(report.held).toBe(!stopped);
});

test('an absent stop operation also retains endpoint identity', async () => {
  const run = scene();
  delete run.host.stopManagedCodexEndpoint;
  const result = await executePlan(run.plan, 'scratch', run.host);
  expect(run.events).toEqual(['start', 'run', 'close']);
  expect(run.retained()).toBe(true);
  expect(result.held).toBe(true);
});

test.each(['close-no-terminal', 'stop'] as const)('a %s dialog cleans its owned endpoint before dropping state', async (mode) => {
  const run = scene();
  run.host.dialog = mode === 'stop'
    ? { mode: 'prompt', run: async () => ({ kind: 'stopped' }) }
    : { mode: 'close-no-terminal' };
  await executePlan(run.plan, 'scratch', run.host);
  expect(run.events).toEqual(['start', 'run', 'close', 'stop', 'drop']);
  expect(run.retained()).toBe(false);
});
