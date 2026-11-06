// An ordinary channel record that names no recipient is not a notification. The seat stays
// running. Synthetic team and signed record only. No herdr runs.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.ts';
import { channelEmitted, channelPushed } from '../src/mcp/channel.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import type { BuildIdentity } from '../src/version.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c51';
const EPOCH = 'run_0123456789ab';
const CHANNEL = 'notifications/claude/channel';
const BUILD: BuildIdentity = { version: 'fixture', build: 'b'.repeat(16), builtAt: 0, head: null };
const bases: string[] = [];

afterAll(() => discardFixtures(bases));

test('a record with a null recipient sends no notification', async () => {
  const base = mkdtempSync(join(tmpdir(), 'publication-null-recipient-'));
  bases.push(base);
  const root = join(base, 'project');
  const home = join(base, 'home');
  const lobby = join(base, 'lobby');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  const file = join(root, '.agents/team.yaml');
  writeFileSync(file, `format: 1
project: fixture-team
session: fixture-session
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
  - role: worker
    name: worker
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: claude --dangerously-load-development-channels server:team-inbox
`);
  writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
    format: 1,
    sessions: {
      'fixture-session': {
        seats: { worker: { stage: 'ready', pane: 'fixture-pane' } },
        worktrees: {},
        briefs: {
          worker: {
            id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
            at: '2026-11-02T00:00:00Z',
            incarnation: 'inc_0123456789ab',
            epoch: EPOCH,
            sha256: 'a'.repeat(64),
            stage: 'claimed',
          },
        },
      },
    },
  }));
  const teamId = teamIdOf(root);
  const lead = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'codex',
    reach: { team: teamId, seat: 'lead', session: 'fixture-session', pane: 'fixture-pane', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  const worker = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Test', version: '1', role: 'worker' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'claude --dangerously-load-development-channels server:team-inbox',
    reach: { team: teamId, seat: 'worker', session: 'fixture-session', pane: 'fixture-pane', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  upsertTeam(home, teamId, {
    project: 'fixture-team',
    session: 'fixture-session',
    root,
    roster: [
      { agent: lead.id, seat: 'lead', role: 'coordinator' },
      { agent: worker.id, seat: 'worker', role: 'worker' },
    ],
  });
  const drop = join(root, '.agents/send-drops/fixture-session/worker');
  mkdirSync(drop, { recursive: true, mode: 0o700 });
  const replies: unknown[] = [];
  const io: Io = {
    cwd: lobby,
    env: {},
    stdinIsTTY: false,
    stdout: () => {},
    stderr: () => {},
    callerSources: () => ({
      env: {},
      stdinIsTTY: false,
      ancestors: () => [
        { pid: 301, name: 'codex' },
        { pid: 302, name: 'sh' },
        { pid: 303, name: 'sh' },
        { pid: 304, name: 'herdr' },
        { pid: 1, name: 'init' },
      ],
      agents: () => [
        { name: 'worker', agent: 'codex', pane: 'fixture-pane', workspace: 'fixture', status: 'idle', cwd: null },
      ],
      paneRootPid: () => 303,
      managedEndpointSeat: () => null,
    }),
  };
  const lines = (async function* () {
    yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const record = signRecord({
      kind: 'message',
      id: ID,
      to: 'worker',
      to_id: null,
      root,
      session: 'fixture-session',
      at: '2026-11-02T00:00:00Z',
      body: `SYNTHETIC_MESSAGE:${ID}`,
      from: 'lead',
      from_id: lead.id,
      rule: 'the owner',
      thread: ID,
    }, home);
    writeFileSync(join(drop, ID), JSON.stringify(record), { mode: 0o600 });
    await Bun.sleep(700);
  })();
  const code = await runMcpServe(
    { seat: 'worker', session: 'fixture-session', file, epoch: EPOCH },
    io,
    { lines, write: (line: string) => replies.push(JSON.parse(line)) },
    { home, build: BUILD },
  );
  const pushed = replies.filter((reply) => (reply as { method?: string }).method === CHANNEL);
  expect(code).toBe(0);
  expect(pushed).toEqual([]);
  expect(channelPushed(drop, ID)).toBe(false);
  expect(channelEmitted(drop, ID)).toBe(false);
  expect(JSON.stringify(replies)).not.toContain(`SYNTHETIC_MESSAGE:${ID}`);
});
