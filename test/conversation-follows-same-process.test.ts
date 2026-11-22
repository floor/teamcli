// A seat whose CLI process stays and whose conversation id changes (a compaction, a cleared
// conversation) is still that seat: the call runs inside the very process the record's socket
// names, so the record follows the conversation the pane reports. Any other caller still gets the
// refusal.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedConversationProblem } from '../src/commands/send.ts';
import { getAgent, registerAgent, type Agent } from '../src/registry/agents.ts';

const PANE = 'w3:p1';
let home: string;
let record: Agent;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'conv-follow-'));
  record = registerAgent(home, {
    name: 'orchestrator',
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: 'team1', seat: 'orchestrator', session: 'floor', pane: PANE, address: '/tmp/cc-socks/4304.sock', agent_session: 'old-conversation' },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
});

afterEach(() => {});

const live = (session: string) => ({
  home,
  agents: () => [{ name: 'orchestrator', pane: PANE, cli: 'claude', session }],
});

describe('a new conversation in the same CLI process', () => {
  test('the call inside the socket\'s own process stands, and the record follows the pane', () => {
    const said = reportedConversationProblem(record, PANE, live('new-conversation'), () => [{ pid: 4400 }, { pid: 4304 }, { pid: 1 }]);
    expect(said).toBeNull();
    expect(getAgent(home, record.id)?.reach.agent_session).toBe('new-conversation');
  });

  test('the seat\'s state follows with the record, so the next team up does not copy the old one back', () => {
    const dir = join(home, 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify({ format: 1, sessions: { floor: { seats: { orchestrator: { stage: 'ready', pane: PANE, agent_session: 'old-conversation' } } } } }));
    expect(reportedConversationProblem(record, PANE, live('new-conversation'), () => [{ pid: 4304 }], dir)).toBeNull();
    const state = JSON.parse(readFileSync(join(dir, 'team.state.json'), 'utf8')) as { sessions: { floor: { seats: { orchestrator: { agent_session: string } } } } };
    expect(state.sessions.floor.seats.orchestrator.agent_session).toBe('new-conversation');
  });

  test('a call from any other process is refused and the record is left as it was', () => {
    const said = reportedConversationProblem(record, PANE, live('new-conversation'), () => [{ pid: 4400 }, { pid: 1 }]);
    expect(said).toContain('does not match the registry\'s conversation');
    expect(getAgent(home, record.id)?.reach.agent_session).toBe('old-conversation');
  });

  test('without a home to write to, the refusal stands', () => {
    const said = reportedConversationProblem(record, PANE, { agents: live('x').agents }, () => [{ pid: 4304 }]);
    expect(said).toContain('does not match');
  });
});
