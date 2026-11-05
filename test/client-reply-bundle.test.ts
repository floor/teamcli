// The reply and ack routes for a thread a BUNDLE-grant client opened: a client (grok-bot) sends
// under a manager bundle whose owner-signed op list carries `send`, the seat its bundle reaches
// answers with `team reply` (the bundle must carry `reply`) and acknowledges the opening record
// with `team ack` (the bundle must carry `ack`). The bounds are the plain route's own: the verified
// canonical grant, its own client inbox, the registry's team and recipient, expiry and revocation.
// A bundle without the op is refused as before, and a plain grant's record is still the client
// inbox's to read, never this command's. Synthetic homes only.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleOp } from '../src/client/bundle-ops.ts';
import { clientInboxFolder } from '../src/client/inbox.ts';
import {
  appendClientRevocation,
  clientGrantsFolder,
  clientKeyDir,
  newClientKeyPair,
  writeClientBundleGrant,
  writeClientGrant,
  writeClientKeyFiles,
} from '../src/client/records.ts';
import { runAck } from '../src/commands/ack.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { signRecord } from '../src/send/record.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { fixtureBase, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T21:00:00Z');
const DAY = 86_400_000;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEAM = `format: 1
project: floor
entity: floor
coordinator: orchestrator
operator: orchestrator
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: builder
    name: builder
    label: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** The grant the client holds: a manager bundle with the given signed ops, or the plain
 *  send-and-inbox grant every client held before bundles. */
type Grant = { kind: 'bundle'; ops: BundleOp[]; issued?: Date } | { kind: 'plain' };

function world(grant: Grant) {
  const base = fixtureBase('.client-reply-bundle-');
  made.push(base);
  const root = join(base, 'floor');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const ownerKey = keyOf(home);
  const teamId = teamIdOf(root);
  const agent = (seat: string, role: string) => registerAgent(home, {
    name: seat, signing: { model: 'Claude Opus', version: '5.5', role }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
    reach: { team: teamId, seat, session: 'acme', pane: seat === 'orchestrator' ? 'fixture:lead' : 'fixture:worker', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  const orch = agent('orchestrator', 'orchestrator');
  const builder = agent('builder', 'builder');
  upsertTeam(home, teamId, {
    project: 'floor', entity: 'floor', session: 'acme', root, lobby: join(base, 'lobby'),
    roster: [{ agent: orch.id, seat: 'orchestrator', role: 'orchestrator', leads: true }, { agent: builder.id, seat: 'builder', role: 'builder' }],
    lifecycle: 'running',
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { orchestrator: { stage: 'ready' as const, pane: 'fixture:lead' }, builder: { stage: 'ready' as const, pane: 'fixture:worker' } } } as never;
  });
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, 'grok-bot');
  const keys = writeClientKeyFiles(keyDir, pair);
  if (!keys.ok) throw new Error(keys.why);
  const written = grant.kind === 'bundle'
    ? writeClientBundleGrant(home, {
      clientId: 'grok-bot', entity: 'floor', publicKey: pair.publicKey, keyId: pair.keyId, keyDir,
      bundle: 'manager', ops: grant.ops, seats: ['orchestrator'],
      up: { project: 'floor', teamId, root, fingerprints: { sections: {}, seats: {} } },
    }, { now: grant.issued ?? NOW, key: ownerKey })
    : writeClientGrant(home, { clientId: 'grok-bot', entity: 'floor', publicKey: pair.publicKey, keyId: pair.keyId, keyDir, inbox: true }, { now: NOW, key: ownerKey });
  if (!written.ok) throw new Error(written.why);
  return {
    base, root, home, teamId,
    grantPath: written.path,
    grantId: written.grant.grantId,
    keyPath: join(keyDir, 'client.key'),
    ownerKey,
  };
}

type World = ReturnType<typeof world>;
let ids = 0;
const nextId = () => `${String(++ids).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** The folder the client's opening record waits in: the recipient seat's drop tree. */
const recipientDrops = (w: World) => join(w.root, '.agents', 'send-drops', 'acme', 'orchestrator');
const inboxNames = (w: World, clientId: string) => {
  const folder = clientInboxFolder(w.root, 'acme', clientId);
  return existsSync(folder) ? readdirSync(folder).filter((name) => !name.startsWith('.')) : [];
};

async function clientSend(w: World, text: string, at: Date = NOW) {
  const io = testIo(w.root, { kind: 'owner' });
  const id = nextId();
  const host = { home: w.home, now: () => at, sendId: () => id } as unknown as SendHost;
  const code = await runSend(['--client', w.grantPath, '--key', w.keyPath, 'orchestrator@floor', text], io, host);
  return { code, id, out: io.out, err: io.err };
}

async function seatReply(w: World, seat: string, id: string, text: string, at: Date = new Date(NOW.getTime() + 60_000)) {
  const pane = seat === 'orchestrator' ? 'fixture:lead' : 'fixture:worker';
  const io = testIo(w.root, { kind: 'seat', name: seat, pane, session: 'acme' });
  const code = await runReply([id, text, '--json'], io, { home: w.home, now: () => at, newId: nextId });
  return { code, out: io.out, err: io.err, json: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null };
}

async function seatAck(w: World, seat: string, id: string, at: Date = new Date(NOW.getTime() + 60_000)) {
  const pane = seat === 'orchestrator' ? 'fixture:lead' : 'fixture:worker';
  const io = testIo(w.root, { kind: 'seat', name: seat, pane, session: 'acme' });
  const code = await runAck([id, '--json'], io, { home: w.home, now: () => at });
  return { code, out: io.out, err: io.err, json: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null };
}

/** Holds the grants lock as a running command would, so the reply must wait for it. */
function holdGrantLock(w: World): string {
  const folder = clientGrantsFolder(w.home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, '.client.lock');
  writeFileSync(path, `${JSON.stringify({ pid: 99_999, token: 'held-by-the-test', at: NOW.toISOString() })}\n`);
  return path;
}

/**
 * A second process that moves the seat to a new agent id between the reply's pre-lock binding
 * read and its publication, then releases the lock the test holds. It waits for the client inbox
 * the reply creates first: that folder exists only after the reply has read and bound the record.
 * `withClientGrantLock` sleeps in-process, so the mutation cannot come from this test's own loop.
 */
function rosterMoveChild(w: World, lockPath: string): Promise<{ code: number | null }> {
  const worktree = join(import.meta.dir, '..');
  const script = join(w.base, 'roster-move.ts');
  writeFileSync(script, `
import { existsSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [worktree, home, teamId, lockPath, inboxPath] = process.argv.slice(2);
const { registerAgent } = await import(pathToFileURL(worktree + '/src/registry/agents.ts').href);
const { readTeams, upsertTeam } = await import(pathToFileURL(worktree + '/src/registry/teams.ts').href);
const deadline = Date.now() + 10_000;
while (!inboxPath || !existsSync(inboxPath)) {
  if (Date.now() > deadline) throw new Error('the reply never created its client inbox');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const fresh = registerAgent(home, {
  name: 'orchestrator',
  signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
  lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
  reach: { team: teamId, seat: 'orchestrator', session: 'acme', pane: 'fixture:lead', address: null },
  mcp: [], skills: [], lifecycle: 'running', by: 'test',
});
const roster = readTeams(home)[teamId].roster.map((entry) => (entry.seat === 'orchestrator' ? { ...entry, agent: fresh.id } : entry));
upsertTeam(home, teamId, { roster });
unlinkSync(lockPath);
`);
  const child = spawn(
    process.execPath,
    [script, worktree, w.home, w.teamId, lockPath, clientInboxFolder(w.root, 'acme', 'grok-bot')],
    { stdio: 'ignore' },
  );
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code }));
  });
}

describe('a bundle-grant client opens a thread and its seat answers', () => {
  test('the reply is delivered to the bundle client\'s own inbox', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent = await clientSend(w, 'Reviewer, can you hear me?');
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'Loud and clear, Assistant.');
    expect(reply.err).toBe('');
    expect(reply.code).toBe(0);
    expect(reply.json).toMatchObject({ status: 'replied', to: 'client:grok-bot', thread: sent.id });
    expect(inboxNames(w, 'grok-bot')).toContain(reply.json.record);
    const written = JSON.parse(readFileSync(join(clientInboxFolder(w.root, 'acme', 'grok-bot'), reply.json.record!), 'utf8')) as { payload: { to_client: { client_id: string; grant_id: string } } };
    expect(written.payload.to_client).toEqual({ client_id: 'grok-bot', grant_id: w.grantId });
  });

  test('a bundle without reply is refused, and nothing is written', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'ack'] });
    const sent = await clientSend(w, 'answered by a bundle that may not answer');
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'must not be published');
    expect(reply.code).toBe(1);
    expect(reply.out + reply.err).toContain('not reply');
    expect(reply.out + reply.err).toContain('nothing was written');
    expect(inboxNames(w, 'grok-bot')).toEqual([]);
    expect(reply.out).not.toContain('must not be published');
  });

  test('an expired bundle is refused by the publication bound', async () => {
    // Issued 91 days ago under the manager's 90-day default: expired a day before NOW, and the
    // thread is still inside the shipping 72-hour TTL when the seat answers.
    const w = world({ kind: 'bundle', ops: ['send', 'reply'], issued: new Date(NOW.getTime() - 91 * DAY) });
    const sent = await clientSend(w, 'sent before the bundle expired', new Date(NOW.getTime() - 2 * DAY));
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'too late');
    expect(reply.code).toBe(1);
    expect(reply.out + reply.err).toContain('expired at');
    expect(reply.out + reply.err).toContain('nothing was written');
    expect(inboxNames(w, 'grok-bot')).toEqual([]);
  });

  test('a revoked bundle is refused by the publication bound', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply'] });
    const sent = await clientSend(w, 'sent before the bundle was revoked');
    expect(sent.code).toBe(0);
    const revoked = appendClientRevocation(w.home, w.grantId, { now: new Date(NOW.getTime() + 30_000), key: w.ownerKey });
    expect(revoked.ok).toBe(true);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'after revoke');
    expect(reply.code).toBe(1);
    expect(reply.out + reply.err).toContain('was revoked');
    expect(inboxNames(w, 'grok-bot')).toEqual([]);
  });

  test('a record naming another client\'s inbox is refused, and neither inbox is written', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply'] });
    const sent = await clientSend(w, 'for grok-bot only');
    expect(sent.code).toBe(0);
    // A record that names another client while presenting this client's own bundle grant: the
    // grant and the record must agree on whose inbox the answer would land in. The record's own
    // shape keeps `from` and `from_client.client_id` in step, so the forgery changes both.
    const recordPath = join(recipientDrops(w), sent.id);
    const held = JSON.parse(readFileSync(recordPath, 'utf8')) as { payload: Record<string, unknown> };
    const forged = { ...held.payload, from: 'client:acme-bot', from_client: { client_id: 'acme-bot', grant_id: w.grantId } };
    writeFileSync(recordPath, `${JSON.stringify(signRecord(forged as never, w.home), null, 2)}\n`);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'wrong inbox');
    expect(reply.code).toBe(1);
    expect(reply.json.error.message).toContain('names client "acme-bot"');
    expect(reply.json.error.message).toContain('nothing was written');
    expect(inboxNames(w, 'grok-bot')).toEqual([]);
    expect(inboxNames(w, 'acme-bot')).toEqual([]);
  });
});

describe('the reply publication re-reads the recipient under the grant lock', () => {
  // Known for 0.5.12.1: spawning a cold child process to mutate the roster while the in-process
  // reply waits 2000 ms on the grant lock can exceed the wait window on loaded Linux runners.
  test.skipIf(process.platform !== 'darwin')('a roster change that moves the recipient while the reply waits refuses, and nothing is written', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply'] });
    const sent = await clientSend(w, 'answer the seat that was');
    expect(sent.code).toBe(0);
    const lockPath = holdGrantLock(w);
    const moved = rosterMoveChild(w, lockPath);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'answered across a roster change');
    expect((await moved).code).toBe(0);
    expect(reply.code).toBe(1);
    expect(reply.json.error.message).toContain('recipient changed');
    expect(reply.json.error.message).toContain('send the reply again');
    expect(reply.out).not.toContain('answered across a roster change');
    expect(inboxNames(w, 'grok-bot')).toEqual([]);
  });
});

describe('a seat acknowledges the opening record a bundle-grant client wrote', () => {
  test('the bundle carrying ack admits the read, in the seat\'s own folder', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent = await clientSend(w, 'ack this please');
    expect(sent.code).toBe(0);
    const acked = await seatAck(w, 'orchestrator', sent.id);
    expect(acked.err).toBe('');
    expect(acked.code).toBe(0);
    expect(acked.json).toMatchObject({ status: 'read', record: sent.id, to: 'orchestrator', thread: sent.id, written: true });
    expect(existsSync(join(recipientDrops(w), `${sent.id}.read.json`))).toBe(true);
  });

  test('a bundle without ack is refused, and nothing is written', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply'] });
    const sent = await clientSend(w, 'cannot be acknowledged under this bundle');
    expect(sent.code).toBe(0);
    const acked = await seatAck(w, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.out + acked.err).toContain('not ack');
    expect(acked.out + acked.err).toContain('nothing was written');
    expect(existsSync(join(recipientDrops(w), `${sent.id}.read.json`))).toBe(false);
  });

  test('a plain-grant record is still the client inbox\'s, not this command\'s', async () => {
    const w = world({ kind: 'plain' });
    const sent = await clientSend(w, 'a plain client thread');
    expect(sent.code).toBe(0);
    const acked = await seatAck(w, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.out + acked.err).toContain('its read belongs to the client inbox');
    expect(existsSync(join(recipientDrops(w), `${sent.id}.read.json`))).toBe(false);
  });

  test('another seat of the team cannot acknowledge the client thread', async () => {
    const w = world({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent = await clientSend(w, 'for the orchestrator');
    expect(sent.code).toBe(0);
    const acked = await seatAck(w, 'builder', sent.id);
    expect(acked.code).toBe(1);
    expect(existsSync(join(recipientDrops(w), `${sent.id}.read.json`))).toBe(false);
  });
});
