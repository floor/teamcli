// Independent check that a Cursor pane herdr names `cursor` is the Cursor CLI, whose
// process is `cursor-agent` (src/launch/execute.ts, src/launch/restore-proof.ts).
// The pane, the process list and the agent list are synthetic. No live host or CLI runs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { HerdrAgent } from '../src/herdr.ts';
import { reportedAgentIsCli } from '../src/launch/agent.ts';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { restoreProof } from '../src/launch/restore-proof.ts';
import { profileFor } from '../src/profiles/index.ts';

const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const OTHER = 'fixture-pane-two';
const SPACE = 'fixture-space';
const LIVE = 'fixture-session-grok';
const LINE = 'cursor-agent --model grok-4.7-high';
const IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.16/idle.txt', import.meta.url), 'utf8');
const NAMES = profileFor('cursor')?.processNames ?? [];

type Listed = { name: string | null; agent: string | null; pane: string; session?: string };

function launchOf(agent: string | null, session: string | undefined, foreground: string[]): {
  host: Host;
  sessions: (string | undefined)[];
  finals: string[];
} {
  const sessions: (string | undefined)[] = [];
  const finals: string[] = [];
  let clock = 0;
  const listed = (): HerdrAgent => ({
    name: SEAT,
    agent,
    pane: PANE,
    workspace: SPACE,
    status: 'idle',
    cwd: null,
    ...(session === undefined ? {} : { session }),
  });
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: () => true,
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => [listed()],
    workspacePanes: () => [PANE],
    processInfo: () => ({ shell: 710, foreground: [910] }),
    classify: (): ScreenKind => 'idle',
    paneText: () => IDLE,
    foreground: () => foreground,
    shellBack: () => false,
    agentStatus: () => null,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    allow: () => null,
    record: (_seat, patch) => {
      if (patch.agent_session !== undefined) sessions.push(patch.agent_session);
    },
    running: () => {},
    drop: () => {},
    say: (line) => finals.push(line),
    final: (seat, record) => finals.push(`${seat}: ${record.kind}`),
    log: () => {},
  };
  return { host, sessions, finals };
}

function steps(): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: { do: 'launch', seat: SEAT, label: SEAT, command: LINE, pane: PANE, workspace: SPACE, cli: 'cursor', cwd: '.' },
    },
    {
      kind: 'wait',
      text: 'until the seat shows its idle prompt',
      do: { do: 'idle', seat: SEAT, label: SEAT, cli: 'cursor', seconds: 90, command: LINE, pane: PANE, workspace: SPACE, repairLine: 'team remove worker' },
    },
    {
      kind: 'run',
      argv: [],
      do: { do: 'rename', seat: SEAT, label: SEAT, cli: 'cursor', seconds: 90, rules: 'option', pane: PANE },
    },
  ];
}

function proof(over: {
  agents?: Listed[];
  foreground?: string[] | null;
  recordedSession?: string;
  live?: string;
  name?: string | null;
  screen?: string | null;
} = {}) {
  const live = over.live;
  const agents: HerdrAgent[] = (over.agents ?? [{
    name: over.name === undefined ? SEAT : over.name,
    agent: 'cursor',
    pane: PANE,
    session: live,
  }]).map((one) => ({
    name: one.name,
    agent: one.agent,
    pane: one.pane,
    workspace: SPACE,
    status: 'idle',
    cwd: null,
    ...(one.session === undefined ? {} : { session: one.session }),
  }));
  return restoreProof({
    seat: { name: SEAT, cli: 'cursor' },
    recorded: { stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 100, cli: [200] } },
    agents,
    process: { shell: 101, foreground: [201] },
    foreground: over.foreground === undefined ? ['cursor-agent'] : over.foreground,
    recordedSession: over.recordedSession,
    screen: over.screen === undefined ? IDLE : over.screen,
  });
}

test("a Cursor launch records the session herdr reports, and a kind that is another CLI's process name records none", async () => {
  expect(NAMES).toEqual(['cursor-agent']);
  expect(reportedAgentIsCli('cursor', 'cursor', NAMES)).toBe(true);
  expect(reportedAgentIsCli('node', 'cursor', NAMES)).toBe(false);
  expect(reportedAgentIsCli('cursor', 'gemini', profileFor('gemini')?.processNames ?? [])).toBe(false);

  const recorded = launchOf('cursor', LIVE, ['cursor-agent']);
  await executePlan(steps(), SESSION, recorded.host);
  expect(recorded.finals).toContain(`${SEAT}: ready`);
  expect([...new Set(recorded.sessions)]).toEqual([LIVE]);

  const foreign = launchOf('grok', 'fixture-session-other', ['cursor-agent']);
  await executePlan(steps(), SESSION, foreign.host);
  expect(foreign.sessions).toEqual([]);
});

test('a shell in front of the agent never becomes a ready Cursor seat', async () => {
  const front = launchOf('cursor', LIVE, ['zsh']);
  await executePlan(steps(), SESSION, front.host);
  expect(front.sessions).toEqual([]);
  expect(front.finals).not.toContain(`${SEAT}: ready`);

  const restored = proof({ foreground: ['zsh'] });
  expect(restored.kind).toBe('none');
  if (restored.kind === 'none') expect(restored.why).toContain('zsh');
});

test('the weak proof adopts a Cursor pane with no conversation on either side, and every wider shape is refused', () => {
  const adopted = proof();
  expect(adopted).toMatchObject({ kind: 'cli', pane: PANE });

  const owned = proof({ name: 'other-seat' });
  expect(owned.kind).toBe('none');
  if (owned.kind === 'none') expect(owned.why).toContain('another seat owns');

  const kind = proof({ agents: [{ name: SEAT, agent: 'node', pane: PANE }] });
  expect(kind.kind).toBe('none');
  if (kind.kind === 'none') expect(kind.why).toContain('node');

  const recordOnly = proof({ recordedSession: 'fixture-session-record' });
  expect(recordOnly.kind).toBe('none');
  if (recordOnly.kind === 'none') expect(recordOnly.why).toContain('reports no conversation');

  const paneOnly = proof({ live: 'fixture-session-live' });
  expect(paneOnly.kind).toBe('none');
  if (paneOnly.kind === 'none') expect(paneOnly.why).toContain('never named');

  const two = proof({
    agents: [
      { name: SEAT, agent: 'cursor', pane: PANE },
      { name: SEAT, agent: 'cursor', pane: OTHER },
    ],
  });
  expect(two.kind).toBe('none');
  if (two.kind === 'none') expect(two.why).toContain('another pane');
});
