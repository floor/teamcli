import { expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../../src/launch/execute.ts';
import { type Step } from '../../src/launch/plan.ts';
import { progressWriter } from '../../src/launch/progress.ts';

function steps(name: string, command: string): Step[] {
  const repairLine = `\`team remove ${name} --keep\` then \`team add ${name}\``;
  return [
    { kind: 'run', argv: [], do: { do: 'create', seat: name, label: name, cwd: '.', repairLine } },
    { kind: 'run', argv: [], do: { do: 'launch', seat: name, label: name, command, cli: 'claude-code' } as never },
    { kind: 'wait', text: 'idle', do: { do: 'idle', seat: name, label: name, cli: 'claude-code', seconds: 90, command, repairLine } },
  ];
}

test('a launch records the conversation id it carries, not only what herdr reads back', async () => {
  const recorded: Record<string, unknown> = {};
  const ran: Record<string, string> = {};
  const records = progressWriter({ stdout: () => {}, stderr: () => {}, isTTY: false });
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: (_s, _c, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
    paneRun: (_s, pane, command) => {
      ran[pane] = command;
      return true;
    },
    typeLine: () => true,
    deliverRules: async () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => ['fresh-pane', 'resumed-pane', 'herdr-pane'],
    // herdr reads nothing back for the first two, and a stale id for the third's pane is absent too.
    agentList: () => [{ pane: 'herdr-pane', session: 'herdr-read-id' } as never],
    processInfo: () => ({ shell: 1, foreground: [2] }),
    classify: (): ScreenKind => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (seat, patch) => {
      recorded[seat] = { ...(recorded[seat] as object), ...patch };
    },
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
    progress: (seat, state) => records.progress(seat, state),
    final: (seat, record) => records.final(seat, record),
    detail: (line) => records.detail(line),
  };
  const plan: Step[] = [...steps('fresh', 'claude'), ...steps('resumed', 'claude --resume 697cde83-cfd4-4811-8e01-4186093fd5e5'), ...steps('herdr', 'claude --continue')];
  await executePlan(plan, 'acme', host, { concurrency: 1 });
  const minted = /--session-id ([0-9a-f-]+)/.exec(ran['fresh-pane'] ?? '')?.[1];
  expect(minted).toBeDefined();
  expect((recorded.fresh as { agent_session?: string }).agent_session).toBe(minted);
  expect((recorded.resumed as { agent_session?: string }).agent_session).toBe('697cde83-cfd4-4811-8e01-4186093fd5e5');
  // A line that names no id falls back to herdr's reading.
  expect((recorded.herdr as { agent_session?: string }).agent_session).toBe('herdr-read-id');
});

test.each([
  { reportedCli: 'codex', replaced: false, expected: 'ses_live_endpoint' },
  { reportedCli: 'claude-code', replaced: false, expected: 'ses_recorded' },
  { reportedCli: 'codex', replaced: true, expected: 'ses_recorded' },
])('a late thread reading requires the launched process and CLI: $reportedCli, replaced=$replaced', async ({ reportedCli, replaced, expected }) => {
  const recorded: Record<string, unknown> = {};
  let named = false;
  let launched = false;
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: () => { launched = true; return true; },
    managedCodexEndpoint: async () => ({ kind: 'up', url: 'unix:///tmp/synthetic.sock', started: true }),
    typeLine: () => true,
    renameAgent: () => {
      // This host recognizes the agent only after its command runs.
      if (!launched) return false;
      named = true;
      return true;
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => ['p1'],
    agentList: () => [{
      name: named ? 'coder' : null, agent: named ? reportedCli : 'codex',
      pane: 'p1', workspace: 'w1', cwd: '.', status: 'idle',
      ...(named ? { session: 'ses_live_endpoint' } : {}),
    }],
    processInfo: () => ({ shell: 1, foreground: [named && replaced ? 3 : 2] }),
    classify: (): ScreenKind => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (_seat, patch) => { Object.assign(recorded, patch); },
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
  };
  const repairLine = 'repair the synthetic seat';
  await executePlan([
    { kind: 'run', argv: [], do: { do: 'create', seat: 'coder', label: 'coder', cwd: '.', repairLine } },
    { kind: 'run', argv: [], do: { do: 'launch', seat: 'coder', label: 'coder', command: 'codex resume ses_recorded', cli: 'codex', codexEndpoint: { dir: '/tmp/synthetic' } } },
    { kind: 'wait', text: 'idle', do: { do: 'idle', seat: 'coder', label: 'coder', cli: 'codex', command: 'codex resume ses_recorded', seconds: 90, repairLine } },
    { kind: 'run', argv: [], do: { do: 'rename', seat: 'coder', label: 'coder', cli: 'codex', seconds: 90, rules: 'option' } },
  ], 'scratch', host);
  // Only the same CLI's late reading wins. An explicitly foreign CLI supplies no id.
  expect(recorded.agent_session).toBe(expected);
  expect(recorded.stage).toBe('ready');
});
