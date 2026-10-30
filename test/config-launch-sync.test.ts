import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncAgentLaunches } from '../src/config/edit.ts';
import { getAgent, registerAgent } from '../src/registry/agents.ts';

const team = (launch: string) => `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${launch}
`;

function agentFor(home: string, launch: string) {
  return registerAgent(home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch,
    reach: { team: 'team123', seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
}

test('a config edit of a seat launch line updates the agent record, so up and restart run it', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sync-')));
  const agent = agentFor(home, 'claude --model glm');
  const synced = syncAgentLaunches(home, 'team123', team('claude --model glm'), [{ name: 'lead', launch: 'claude --model opus' }]);
  expect(synced).toEqual(['lead']);
  expect(getAgent(home, agent.id)?.launch).toBe('claude --model opus');
});

test('an edit that leaves the launch line alone leaves the agent record alone', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sync-')));
  const agent = agentFor(home, 'claude --registered');
  expect(syncAgentLaunches(home, 'team123', team('claude --model opus'), [{ name: 'lead', launch: 'claude --model opus' }])).toEqual([]);
  expect(getAgent(home, agent.id)?.launch).toBe('claude --registered');
});
