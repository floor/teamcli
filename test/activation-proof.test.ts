// The channel proof probe (the Claude adapter §2.1–2.2, before activation).
//
// A Claude seat whose pane is protected (the entity's main orchestrator runs in the owner's pane)
// has no typed-pointer proof, and on a dark root nothing is stamped, so its live channel server
// never pushes an offer token: `team queues activate` refused it forever. `team queues prove`
// places one signed, stamped probe; the seat's real channel server pushes it with a token; the
// seat's ack with that token proves the channel and activation then passes. An ack without the
// token settles the probe and proves nothing. Fixtures only: a synthetic root, home and launch line.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueues } from '../src/commands/queues.ts';
import { listenerKeyOf, offerAcks } from '../src/comms/offer.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { listenerPath, readListener } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { CHANNEL_PROBE_BODY, pendingProbe, placeChannelProbe } from '../src/queue/channel-probe.ts';
import { takeCopyNumber } from '../src/queue/handover.ts';
import { floorState } from '../src/queue/floor.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { isRead } from '../src/send/record.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import type { TypedPaneSources } from '../src/launch/identity.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';

/** The entity's own team: its orchestrator `lead` is the entity's main orchestrator, whose pane
 *  is protected by role, and it runs a live channel listener. */
function teamText(): string {
  return `format: 1
project: acme
entity: acme
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
    launch: claude ${FLAG}
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

type Place = { root: string; home: string; dropDir: string; cleanup(): void };

function place(): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-proof-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText());
  const seat = { stage: 'ready', agent_session: 'session-of-lead', launched: { shell: 111, cli: [222], cli_start: [1_700_000_000_500] }, pane_shell: 111, pane_shell_start: 1_700_000_000_000 };
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { ...seat, pane: 'pane-lead' }, worker: { ...seat, pane: 'pane-worker' } }, worktrees: {} } } })}\n`,
  );
  const home = join(root, 'home');
  messageKeyOf(home);
  const teamId = teamIdOf(root);
  const agents = (['lead', 'worker'] as const).map((name) => registerAgent(home, {
    name,
    signing: { model: 'Test', version: '1', role: name === 'lead' ? 'coordinator' : 'worker' },
    lab: 'test', cli: 'claude-code', launcher: null,
    launch: name === 'lead' ? `claude ${FLAG}` : 'claude',
    reach: { team: teamId, seat: name, session: SESSION, pane: `pane-${name}`, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }));
  upsertTeam(home, teamId, { project: 'acme', session: SESSION, root, roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })) });
  const now = new Date().toISOString();
  writeDaemonState(home, {
    format: 1, pid: process.pid, uid: process.getuid!(), since: now, heartbeatAt: now,
    startedBy: 'manual', version: 'b', socket: join(home, 'daemon.sock'),
    features: { broker: 'off' }, stuck: [], roots: [], floorLevel: 3,
  });
  return { root, home, dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Only the lead runs; its pane's processes are provable, so only its protection refuses a pointer. */
function paneOwner(): TypedPaneSources {
  return {
    agents: () => [{ name: 'lead', pane: 'pane-lead', session: 'session-of-lead' }],
    processes: () => ({ shell: 111, foreground: [222] }),
    processStart: (pid: number) => pid === 111 ? 1_700_000_000_000 : 1_700_000_000_500,
  };
}

function queue(): { lines: AsyncIterable<string>; write(line: string): void; push(line: string): void; end(): void; replies: string[] } {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return { lines, write: (line) => replies.push(line), push: (line) => { pending.push(line); bump(); }, end: () => { ended = true; bump(); }, replies };
}

function notices(replies: readonly string[]): Record<string, any>[] {
  return replies.map((line) => JSON.parse(line) as Record<string, any>).filter((one) => one.method === 'notifications/claude/channel');
}

async function until(check: () => boolean, limit = 1200): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function tool(feed: ReturnType<typeof queue>, request: string, name: string, args?: Record<string, unknown>): Promise<Record<string, any>> {
  feed.push(JSON.stringify({ jsonrpc: '2.0', id: request, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } }));
  await until(() => feed.replies.some((line) => JSON.parse(line).id === request));
  return feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === request)!.result;
}

async function served() {
  const at = place();
  const feed = queue();
  const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION }), feed, { home: at.home });
  await until(() => existsSync(listenerPath(at.dropDir)));
  const listener = readListener(at.dropDir);
  if (listener === null) throw new Error('no listener');
  return { at, feed, running, key: listenerKeyOf(listener) };
}

function binding(at: Place) {
  const key = messageKeyState(at.home);
  if (key.kind !== 'key') throw new Error('no key');
  return { root: at.root, session: SESSION, seat: 'lead', key: key.key };
}

async function queues(at: Place, argv: string[], owner: TypedPaneSources = paneOwner()): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runQueues(argv, io, { home: at.home, paneOwner: owner });
  return { code, out: io.out, err: io.err };
}

function probeIdOf(out: string): string {
  const match = /lead: probe ([0-9a-f-]{36}) placed/.exec(out);
  if (match === null) throw new Error(`no probe placed: ${out}`);
  return match[1]!;
}

describe('a protected seat with a live channel, before activation', () => {
  test('refused with no acks; a probe is pushed with an offer, acked with it, and activation then passes', async () => {
    const { at, feed, running, key } = await served();
    try {
      expect(floorState(at.root, at.home).kind).toBe('dark');
      // The deadlock as it stood: no stamped push, no token, a protected pane, no proof.
      const refused = await queues(at, ['activate']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('lead: unproven since launch; the typed pointer is protected');
      expect(refused.err).toContain('team queues prove');
      expect(existsSync(seatMailDirs(at.root, SESSION, 'lead').stamped)).toBe(false);
      expect(floorState(at.root, at.home).kind).toBe('dark');

      const proved = await queues(at, ['prove']);
      expect(proved.code).toBe(0);
      const id = probeIdOf(proved.out);
      // Placed once: a second run while it waits for this listener's ack places nothing.
      const again = await queues(at, ['prove', 'lead']);
      expect(again.out).toContain(`lead: probe ${id} is waiting for its ack`);
      expect(readdirSync(seatMailDirs(at.root, SESSION, 'lead').stamped).filter((name) => /^[0-9a-f-]{36}$/.test(name))).toEqual([id]);

      await until(() => notices(feed.replies).some((one) => one.params.meta.id === id));
      const pushed = notices(feed.replies).find((one) => one.params.meta.id === id)!;
      expect(pushed.params.meta.offer).toMatch(/^[0-9a-f]{32}$/);
      expect(pushed.params.content).toContain(CHANNEL_PROBE_BODY);
      expect(offerAcks(at.dropDir, key, binding(at))).toEqual([]);

      const answer = await tool(feed, 'ack-1', 'ack', { id, offer: pushed.params.meta.offer });
      expect(answer.isError).toBeUndefined();
      expect(isRead(seatMailDirs(at.root, SESSION, 'lead').stamped, id, { to: 'lead', root: at.root, session: SESSION }, binding(at).key)).toBe(true);
      expect(offerAcks(at.dropDir, key, binding(at))).toEqual([expect.objectContaining({ id, n: 1 })]);

      const activated = await queues(at, ['activate']);
      expect(activated.err).toBe('');
      expect(activated.code).toBe(0);
      expect(activated.out).toContain('activated at level 3');
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('an ack without the offer settles the probe and proves nothing; activation stays refused', async () => {
    const { at, feed, running, key } = await served();
    try {
      const id = probeIdOf((await queues(at, ['prove'])).out);
      await until(() => notices(feed.replies).some((one) => one.params.meta.id === id));
      const answer = await tool(feed, 'ack-1', 'ack', { id });
      expect(answer.isError).toBeUndefined();
      expect(isRead(seatMailDirs(at.root, SESSION, 'lead').stamped, id, { to: 'lead', root: at.root, session: SESSION }, binding(at).key)).toBe(true);
      expect(offerAcks(at.dropDir, key, binding(at))).toEqual([]);
      // A forged offer proves nothing either.
      const second = probeIdOf((await queues(at, ['prove'])).out);
      expect(second).not.toBe(id);
      await until(() => notices(feed.replies).some((one) => one.params.meta.id === second));
      expect((await tool(feed, 'ack-2', 'ack', { id: second, offer: 'f'.repeat(32) })).isError).toBeUndefined();
      expect(offerAcks(at.dropDir, key, binding(at))).toEqual([]);
      const refused = await queues(at, ['activate']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('lead: unproven since launch');
      expect(floorState(at.root, at.home).kind).toBe('dark');
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('a seat refused for another reason gets no probe', async () => {
    const at = place();
    try {
      // No listener at all: the probe could never be pushed, so none is placed.
      const proved = await queues(at, ['prove']);
      expect(proved.code).toBe(1);
      expect(proved.err).toContain('lead: no probe: no listener');
      expect(existsSync(seatMailDirs(at.root, SESSION, 'lead').stamped)).toBe(false);
    } finally {
      at.cleanup();
    }
  });
});

/** Every file and folder under a tree, by relative name, with each file's bytes. */
function tree(folder: string): string {
  if (!existsSync(folder)) return '-';
  return JSON.stringify(readdirSync(folder, { recursive: true }).map(String).sort().map((name) => {
    try { return [name, readFileSync(join(folder, name), 'base64')]; } catch { return [name, 'folder']; }
  }));
}

describe('review round 1: the probe binds to the listener incarnation and refuses before any write', () => {
  test('an unoffered probe placed before the current listener started is not pending; one placed after it, or pushed by it, is', () => {
    const at = place();
    try {
      const key = binding(at).key;
      const now = new Date();
      const placed = placeChannelProbe({ home: at.home, root: at.root, session: SESSION, seat: 'lead', now });
      if (!placed.ok) throw new Error(placed.reason);
      const ask = (listenerKey: string, listenerSinceMs: number) => pendingProbe({ root: at.root, session: SESSION, seat: 'lead', key, listenerKey, listenerSinceMs, nowMs: now.getTime() + 1_000, lead: 'lead' });
      // The listener started before the probe was placed: its watch will offer it.
      expect(ask('1@then', now.getTime() - 60_000)).toBe(placed.id);
      // A replacement listener started after the placement primed past it and never offers it.
      expect(ask('2@later', now.getTime() + 500)).toBeNull();
      // Pushed by one listener: pending for that incarnation only.
      expect(takeCopyNumber(seatMailDirs(at.root, SESSION, 'lead').stamped, placed.id, 'channel', Date.now(), { token: 'c'.repeat(32), listener: '1@then' })).not.toBeNull();
      expect(ask('1@then', now.getTime() + 500)).toBe(placed.id);
      expect(ask('2@later', now.getTime() - 60_000)).toBeNull();
    } finally {
      at.cleanup();
    }
  });

  test('one seat that cannot take a probe refuses the whole run and writes nothing for the other', async () => {
    const { at, feed, running } = await served();
    try {
      const both: TypedPaneSources = {
        ...paneOwner(),
        agents: () => [{ name: 'lead', pane: 'pane-lead', session: 'session-of-lead' }, { name: 'worker', pane: 'pane-worker', session: 'session-of-worker' }],
        // The worker's pane cannot be proven, so it has no pointer either: it blocks activation.
        processes: (pane: string) => pane === 'pane-lead' ? { shell: 111, foreground: [222] } : null,
      };
      const agents = join(at.root, '.agents');
      const before = [tree(join(agents, 'send-stamped')), tree(join(agents, 'queues'))];
      const proved = await queues(at, ['prove'], both);
      expect(proved.code).toBe(1);
      expect(proved.err).toContain('nothing probed; the checkout is unchanged');
      expect(proved.err).toContain('worker: no probe: no listener');
      expect(proved.out).not.toContain('placed');
      expect([tree(join(agents, 'send-stamped')), tree(join(agents, 'queues'))]).toEqual(before);
      // The seat that can take one gets it when it is named alone.
      expect(probeIdOf((await queues(at, ['prove', 'lead'], both)).out)).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });
});
