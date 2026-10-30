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
