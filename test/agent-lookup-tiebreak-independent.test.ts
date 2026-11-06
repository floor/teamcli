// Independent scenes for the agent lookup tiebreak. Two records share a seat name.
// The one that names a conversation wins a same-millisecond tie, a pair that names none
// follows the write count, and an older record never beats a newer one. The agent id
// does not decide. Synthetic registry files only.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAgent } from '../src/registry/agents.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const homes: string[] = [];
afterAll(() => discardFixtures(homes));

function registry(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-tiebreak-'));
  homes.push(home);
  mkdirSync(join(home, '.config', 'team', 'agents'), { recursive: true });
  return home;
}

function record(home: string, agent: {
  id: string;
  session: string;
  agentSession: string | null;
  updatedAt: string;
  seq: number;
}): void {
  const sessionLine = agent.agentSession === null ? 'null' : JSON.stringify(agent.agentSession);
  writeFileSync(join(home, '.config', 'team', 'agents', `${agent.id}.yaml`), `id: ${agent.id}
name: ${agent.id}
signing:
  model: Test
  version: "1"
  role: implementer
lab: example
cli: grok
launcher: null
launch: grok
reach:
  team: acme
  seat: helper
  session: ${agent.session}
  agent_session: ${sessionLine}
  pane: null
  address: null
mcp: []
skills: []
lifecycle: running
provenance:
  registered_by: owner
  registered_at: "2026-11-06T12:00:00.000Z"
  updated_at: "${agent.updatedAt}"
  seq: ${String(agent.seq)}
`);
}

test('two records of one seat prefer the one that names a conversation', () => {
  const home = registry();
  record(home, {
    id: 'agt_fffffffffff2', session: 'session-other', agentSession: null,
    updatedAt: '2026-11-06T12:00:00.000Z', seq: 9,
  });
  record(home, {
    id: 'agt_000000000001', session: 'session-named', agentSession: 'conv-named',
    updatedAt: '2026-11-06T12:00:00.000Z', seq: 1,
  });
  const found = findAgent(home, { team: 'acme', seat: 'helper' });
  expect(found?.id).toBe('agt_000000000001');
  expect(found?.reach.agent_session).toBe('conv-named');
});

test('with no named conversation the higher write count wins, never the agent id', () => {
  const home = registry();
  record(home, {
    id: 'agt_fffffffffff2', session: 'session-late', agentSession: '   ',
    updatedAt: '2026-11-06T12:00:00.000Z', seq: 1,
  });
  record(home, {
    id: 'agt_000000000001', session: 'session-early', agentSession: null,
    updatedAt: '2026-11-06T12:00:00.000Z', seq: 4,
  });
  const first = findAgent(home, { team: 'acme', seat: 'helper' });
  const second = findAgent(home, { team: 'acme', seat: 'helper' });
  expect(first?.id).toBe('agt_000000000001');
  expect(second?.id).toBe(first?.id);
  expect(first?.provenance.seq).toBe(4);
});

test('a stale record never wins over a newer one', () => {
  const home = registry();
  record(home, {
    id: 'agt_fffffffffff2', session: 'session-stale', agentSession: 'conv-stale',
    updatedAt: '2026-11-06T12:00:00.000Z', seq: 9,
  });
  record(home, {
    id: 'agt_000000000001', session: 'session-live', agentSession: null,
    updatedAt: '2026-11-06T12:00:01.000Z', seq: 1,
  });
  const found = findAgent(home, { team: 'acme', seat: 'helper' });
  expect(found?.id).toBe('agt_000000000001');
  expect(found?.reach.session).toBe('session-live');
});
