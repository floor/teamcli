// Two agent files for one seat can share a millisecond. The id is random, so a later filename
// must not decide the tie. The record that names a conversation wins, then the monotonic seq.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAgent, registerAgent, updateAgent, type AgentInit } from '../src/registry/agents.ts';

const WHEN = '2026-11-06T10:00:00.000Z';
let home: string | null = null;

afterEach(() => {
  if (home !== null) rmSync(home, { recursive: true, force: true });
  home = null;
});

function plant(id: string, agentSession: string | null, updatedAt: string, seq?: number): void {
  if (home === null) home = mkdtempSync(join(tmpdir(), 'agent-tie-'));
  const dir = join(home, '.config', 'team', 'agents');
  mkdirSync(dir, { recursive: true });
  const lines = [
    `id: ${JSON.stringify(id)}`,
    'name: "worker"',
    'signing:',
    '  model: "m"',
    '  version: "1"',
    '  role: "implementer"',
    'lab: "lab"',
    'cli: "grok"',
    'launcher: null',
    'launch: "grok"',
    'reach:',
    '  team: "teamcli"',
    '  seat: "worker"',
    '  session: "teamcli"',
    `  agent_session: ${agentSession === null ? 'null' : JSON.stringify(agentSession)}`,
    '  pane: null',
    '  address: null',
    'mcp: []',
    'skills: []',
    'lifecycle: "running"',
    'provenance:',
    '  registered_by: "owner"',
    `  registered_at: ${JSON.stringify(WHEN)}`,
    `  updated_at: ${JSON.stringify(updatedAt)}`,
  ];
  if (seq !== undefined) lines.push(`  seq: ${String(seq)}`);
  writeFileSync(join(dir, `${id}.yaml`), `${lines.join('\n')}\n`);
}

test('two records in the same millisecond: the one that names a session wins', () => {
  // The session-less file sorts last, which is the tie the random id used to win.
  plant('agt_000000000001', 'ses_grok_live', WHEN);
  plant('agt_ffffffffffff', null, WHEN);
  expect(findAgent(home!, { team: 'teamcli', seat: 'worker' })?.reach.agent_session).toBe('ses_grok_live');
});

test('the same millisecond and the same session mark: the later seq wins, not the greater id', () => {
  plant('agt_000000000001', 'ses_first', WHEN, 2);
  plant('agt_ffffffffffff', 'ses_second', WHEN, 1);
  expect(findAgent(home!, { team: 'teamcli', seat: 'worker' })?.reach.agent_session).toBe('ses_first');
});

test('each write takes the next seq, and an update takes a later one', () => {
  home = mkdtempSync(join(tmpdir(), 'agent-tie-'));
  const init = (seat: string): AgentInit => ({
    name: seat,
    signing: { model: 'm', version: '1', role: 'implementer' },
    lab: 'lab',
    cli: 'grok',
    launcher: null,
    launch: 'grok',
    reach: { team: 'teamcli', seat, session: 'teamcli', pane: null, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  const first = registerAgent(home, init('one'));
  const second = registerAgent(home, init('two'));
  const rewritten = updateAgent(home, first.id, { name: 'one' });
  expect(first.provenance.seq).toBe(1);
  expect(second.provenance.seq).toBe(2);
  expect(rewritten.provenance.seq).toBe(3);
});

test('a newer updated_at still wins when the older record is the one that names a session', () => {
  plant('agt_000000000001', 'ses_old', WHEN);
  plant('agt_000000000002', null, '2026-11-06T10:00:00.001Z');
  expect(findAgent(home!, { team: 'teamcli', seat: 'worker' })?.id).toBe('agt_000000000002');
});
