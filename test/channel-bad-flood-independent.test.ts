// A flood of id-shaped files with invalid bodies must not wedge the channel server. The server
// is this test's own child. After the flood, one signed drop is delivered, a tool call on stdin
// is answered, and kill stops the child. Screens, homes and pane names are synthetic. No live
// session is touched.
import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenerPath } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { paneShell } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const LAUNCH = `claude ${FLAG}`;
const FLOOD = 300;
const VALID = 'e7500000-0000-4000-8000-000000000001';

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

function badId(n: number): string {
  return `f7500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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

test('a flood of invalid id-shaped files still delivers one signed drop, and kill stops the server', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-bad-flood-')));
  const root = join(home, 'repo');
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  let child: ChildProcess | undefined;
  let err = '';
  let stopped = false;
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
    await until(() => existsSync(listenerPath(dropDir)) || child?.exitCode !== null, 4_000);
    expect(child.exitCode, err).toBeNull();
    expect(existsSync(listenerPath(dropDir)), err).toBe(true);
    // The first tick records files already in the folder and does not push them. The flood
    // lands after that tick.
    await sleep(400);
    const bad = Array.from({ length: FLOOD }, (_item, n) => badId(n + 1));
    for (const id of bad) {
      writeFileSync(join(dropDir, id), '{"kind":"message","body":"unsigned"}\n', { mode: 0o600 });
    }
    const record = signRecord({
      kind: 'message',
      id: VALID,
      to: 'lead',
      to_id: agents[0]!.id,
      root,
      session: SESSION,
      at: '2026-10-22T09:00:00.000Z',
      body: 'from a worker — admitted by: the owner\n\nvalid after the flood',
      from: 'worker',
      from_id: agents[1]!.id,
      rule: 'the owner',
      thread: VALID,
    }, home);
    writeFileSync(join(dropDir, VALID), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await until(() => channelIds(out).includes(VALID) || child?.exitCode !== null, 8_000);
    const delivered = channelIds(out);
    expect(delivered.filter((id) => id === VALID), err).toEqual([VALID]);
    expect(delivered.filter((id) => bad.includes(id)), err).toEqual([]);
    expect(child.exitCode, err).toBeNull();
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'inbox_check', arguments: {} } })}\n`);
    await until(() => answered(out, 42) || child?.exitCode !== null, 3_000);
    expect(answered(out, 42), err).toBe(true);
    expect(child.exitCode, err).toBeNull();
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      child?.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    child.kill();
    expect(await exited, err).toBe(true);
    stopped = true;
  } finally {
    if (!stopped && child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
