// A burst of signed drops must not wedge the channel server. The server is this test's own
// child. All 150 are delivered once, a drop written after the burst is delivered, a tool call
// on stdin is still answered, and no commit lock is left held. The child is stopped with kill.
// Screens, homes and pane names are synthetic. No live session is touched.
import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelCommitActive } from '../src/mcp/channel.ts';
import { listenerPath } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { paneShell } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const LAUNCH = `claude ${FLAG}`;
const BURST = 150;
const CANARY = 'b7500000-0000-4000-8000-000000001000';

const teamText = `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${LAUNCH}
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;

function idOf(n: number): string {
  return `b7500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(ready: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await sleep(50);
}

function channelIds(raw: string): string[] {
  const ids: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('notifications/claude/channel')) continue;
    try {
      const doc = JSON.parse(line) as { method?: string; params?: { meta?: { id?: string } } };
      if (doc.method === 'notifications/claude/channel' && typeof doc.params?.meta?.id === 'string') ids.push(doc.params.meta.id);
    } catch {
      // A chunk that split a line is completed by the next read.
    }
  }
  return ids;
}

function answered(raw: string, id: number): boolean {
  return raw.split('\n').some((line) => {
    try {
      return (JSON.parse(line) as { id?: unknown }).id === id;
    } catch {
      return false;
    }
  });
}

test('a burst of signed drops is each delivered once, and the server still answers', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-burst-')));
  const root = join(home, 'repo');
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  let child: ChildProcess | undefined;
  let err = '';
  try {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText);
    writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {} } } })}\n`);
    const teamId = teamIdOf(root);
    const agents = (['lead', 'worker'] as const).map((seat) => registerAgent(home, {
      name: seat,
      signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'worker' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: seat === 'lead' ? LAUNCH : 'claude',
      reach: { team: teamId, seat, session: SESSION, pane: `pane-${seat}`, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    }));
    upsertTeam(home, teamId, {
      project: 'acme',
      session: SESSION,
      root,
      roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
    });
    mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    const put = (id: string, tag: string): void => {
      const record = signRecord({
        kind: 'message',
        id,
        to: 'lead',
        to_id: agents[0]!.id,
        root,
        session: SESSION,
        at: '2026-10-22T09:00:00.000Z',
        body: `from a worker — admitted by: the owner\n\n${tag}`,
        from: 'worker',
        from_id: agents[1]!.id,
        rule: 'the owner',
        thread: id,
      }, home);
      writeFileSync(join(dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    };
    const runner = join(root, 'serve.ts');
    // The pane shell's environment places the seat. An empty env hides HERDR_PANE_ID, and the walk stops at the agent outside herdr.
    const serve = fileURLToPath(new URL('../src/mcp/serve.ts', import.meta.url));
    writeFileSync(runner, `import { runMcpServe } from ${JSON.stringify(serve)};
await runMcpServe(
  { seat: 'lead', session: process.env.TEAM_SESSION, file: process.env.TEAM_FILE },
  { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), cwd: process.cwd(), env: process.env, stdinIsTTY: false },
);
`);
    const shell = paneShell({ bin: join(root, 'bin'), dir: join(root, '.agents'), session: SESSION, seat: 'lead', pane: 'pane-lead', home });
    let out = '';
    child = spawn(process.execPath, [runner], {
      cwd: root,
      env: { ...shell.env, TEAM_SESSION: SESSION, TEAM_FILE: join(root, '.agents', 'team.yaml') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const counts = (): Map<string, number> => {
      const seen = new Map<string, number>();
      for (const id of channelIds(out)) seen.set(id, (seen.get(id) ?? 0) + 1);
      return seen;
    };
    await until(() => existsSync(listenerPath(dropDir)) || child?.exitCode !== null, 4_000);
    expect(child.exitCode, err).toBeNull();
    expect(existsSync(listenerPath(dropDir)), err).toBe(true);
    // The first tick records files already in the folder and does not push them. The burst
    // lands after that tick, so each file is a delivery.
    await sleep(400);
    const burst = Array.from({ length: BURST }, (_item, n) => idOf(n));
    for (const id of burst) put(id, `burst ${id}`);
    // Signing and verifying all 150 drops can exceed twelve seconds; poll delivery up to a bounded 45 seconds.
    await until(() => {
      const seen = counts();
      return burst.every((id) => (seen.get(id) ?? 0) >= 1);
    }, 45_000);
    await sleep(2_000);
    const once = counts();
    expect(burst.map((id) => once.get(id) ?? 0), err).toEqual(burst.map(() => 1));
    expect([...once.keys()].filter((id) => !burst.includes(id)), err).toEqual([]);
    put(CANARY, 'burst canary');
    await until(() => (counts().get(CANARY) ?? 0) >= 1 || child?.exitCode !== null, 5_000);
    await sleep(1_000);
    expect(counts().get(CANARY) ?? 0, err).toBe(1);
    expect(child.exitCode, err).toBeNull();
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'inbox_check', arguments: {} } })}\n`);
    await until(() => answered(out, 41) || child?.exitCode !== null, 2_000);
    expect(answered(out, 41), err).toBe(true);
    const locks = readdirSync(dropDir).filter((name) => name.endsWith('.channel-commit.lock'));
    expect(locks, err).toEqual([]);
    for (const id of [...burst, CANARY]) expect(channelCommitActive(dropDir, id), err).toBe(false);
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    if (child !== undefined && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        child?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(home, { recursive: true, force: true });
  }
  // Allow the capped delivery wait plus startup, duplicate observation, canary and cleanup.
}, 70_000);
