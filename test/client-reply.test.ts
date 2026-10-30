// Client reply publication, end to end on synthetic homes: a client (grok-bot) sends to the
// orchestrator under an owner-issued grant with the inbox op, the orchestrator answers with
// `team reply`, and the client reads the answer with `team messages --client`. The scope is the
// grant's: only its recipient seat answers, only the client that opened the thread reads it, a
// send-only grant opens no conversation, and a revoked grant stops new replies.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientInboxFolder } from '../src/client/inbox.ts';
import { clientKeyDir, newClientKeyPair, appendClientRevocation, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import { runMessages } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T21:00:00Z');
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

function world(inbox: boolean) {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.client-reply-')));
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
    reach: { team: teamId, seat, session: 'acme', pane: seat === 'orchestrator' ? 'w1:p1' : 'w1:p2', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  const orch = agent('orchestrator', 'orchestrator');
  const builder = agent('builder', 'builder');
  upsertTeam(home, teamId, {
    project: 'floor', entity: 'floor', session: 'acme', root, lobby: join(base, 'lobby'),
    roster: [{ agent: orch.id, seat: 'orchestrator', role: 'orchestrator', leads: true }, { agent: builder.id, seat: 'builder', role: 'builder' }],
    lifecycle: 'running',
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { orchestrator: { stage: 'ready' as const, pane: 'w1:p1' }, builder: { stage: 'ready' as const, pane: 'w1:p2' } } } as never;
  });
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, 'grok-bot');
  const keys = writeClientKeyFiles(keyDir, pair);
  if (!keys.ok) throw new Error(keys.why);
  const grant = writeClientGrant(home, { clientId: 'grok-bot', entity: 'floor', publicKey: pair.publicKey, keyId: pair.keyId, keyDir, ...(inbox ? { inbox: true } : {}) }, { now: NOW, key: ownerKey });
  if (!grant.ok) throw new Error(grant.why);
  return { base, root, home, grantPath: grant.path, grantId: grant.grant.grantId, keyPath: join(keyDir, 'client.key') };
}

type World = ReturnType<typeof world>;
let ids = 0;
const nextId = () => `${String(++ids).padStart(8, '0')}-1111-4111-8111-111111111111`;

async function clientSend(w: World, text: string) {
  const io = testIo(w.root, { kind: 'owner' });
  const id = nextId();
  const host = { home: w.home, now: () => NOW, sendId: () => id } as unknown as SendHost;
  const code = await runSend(['--client', w.grantPath, '--key', w.keyPath, 'orchestrator@floor', text], io, host);
  return { code, id, out: io.out, err: io.err };
}

async function seatReply(w: World, seat: string, id: string, text: string) {
  const pane = seat === 'orchestrator' ? 'w1:p1' : 'w1:p2';
  const io = testIo(w.root, { kind: 'seat', name: seat, pane, session: 'acme' });
  const code = await runReply([id, text, '--json'], io, { home: w.home, now: () => new Date(NOW.getTime() + 60_000), newId: nextId });
  return { code, out: io.out, err: io.err, json: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null };
}

async function clientRead(w: World, extra: string[] = []) {
  const io = testIo(w.root);
  const code = await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--json', ...extra], io, { home: w.home, now: () => new Date(NOW.getTime() + 120_000) });
  return { code, out: io.out, err: io.err, json: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null };
}

describe('a client sends, the recipient seat replies, the client reads the reply', () => {
  test('the full round trip, then the client acks it', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'Atlas, can you hear me?');
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'Loud and clear, Iris.');
    expect(reply.err).toBe('');
    expect(reply.code).toBe(0);
    expect(reply.json).toMatchObject({ status: 'replied', to: 'client:grok-bot', thread: sent.id });
    expect(readdirSync(clientInboxFolder(w.root, 'acme', 'grok-bot'))).toContain(reply.json.record);
    const read = await clientRead(w);
    expect(read.err).not.toContain('refused');
    expect(read.code).toBe(0);
    expect(JSON.stringify(read.json)).toContain('Loud and clear, Iris.');
    expect(read.json.rows).toHaveLength(1);
    expect(read.json.rows[0]).toMatchObject({ id: reply.json.record, from: 'orchestrator', to: 'client:grok-bot', status: 'shown' });
    const acked = await clientRead(w, ['--ack', reply.json.record]);
    expect(acked.code).toBe(0);
  });

  test('a second reply on the same open thread is published too', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'two answers please');
    expect((await seatReply(w, 'orchestrator', sent.id, 'first')).code).toBe(0);
    expect((await seatReply(w, 'orchestrator', sent.id, 'second')).code).toBe(0);
    const read = await clientRead(w);
    expect(JSON.stringify(read.json)).toContain('first');
    expect(JSON.stringify(read.json)).toContain('second');
  });
});

describe('the client follows its thread', () => {
  test('--follow prints a reply as soon as a read finds it, once, and only new ones after', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'follow me');
    const io = testIo(w.root);
    let reads = 0;
    let firstId = '';
    const sources = {
      home: w.home,
      now: () => new Date(NOW.getTime() + 120_000),
      followReads: 4,
      // Between the first and second read the seat answers; after the third, a second answer.
      followWait: async () => {
        reads += 1;
        if (reads === 1) firstId = (await seatReply(w, 'orchestrator', sent.id, 'pong')).json.record;
        if (reads === 3) await seatReply(w, 'orchestrator', sent.id, 'pong again');
      },
    };
    const code = await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--follow'], io, sources);
    expect(code).toBe(0);
    const lines = io.out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`reply ${firstId} from orchestrator:`);
    expect(lines[0]).toEndWith(" pong");
    expect(lines[1]).toContain('pong again');
    expect(io.err.split('\n').filter((line) => line.startsWith('key isolation'))).toHaveLength(1);
  });

  test('--follow refuses --ack and stops with the read\'s own refusal', async () => {
    const w = world(true);
    const io = testIo(w.root);
    expect(await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--follow', '--ack', 'x'], io, { home: w.home, now: () => NOW })).toBe(2);
    const bad = testIo(w.root);
    const code = await runMessages(['--client', join(w.root, 'missing.json'), '--key', w.keyPath, '--follow'], bad, { home: w.home, now: () => NOW, followReads: 3, followWait: async () => {} });
    expect(code).not.toBe(0);
    expect(bad.err).toContain('follow stopped');
  });
});

describe('the reply is scoped by the grant; nothing widens it', () => {
  test('a send-only grant opens no conversation: the reply is refused and no inbox is written', async () => {
    const w = world(false);
    const sent = await clientSend(w, 'send only');
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'answer');
    expect(reply.code).toBe(1);
    expect(reply.out + reply.err).toContain('send-only');
    expect(existsSync(clientInboxFolder(w.root, 'acme', 'grok-bot'))).toBe(false);
  });

  test('another seat of the team cannot answer the client thread', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'for the orchestrator');
    const reply = await seatReply(w, 'builder', sent.id, 'I am not the recipient');
    expect(reply.code).toBe(1);
    expect(existsSync(clientInboxFolder(w.root, 'acme', 'grok-bot')) ? readdirSync(clientInboxFolder(w.root, 'acme', 'grok-bot')).filter((n) => !n.startsWith('.')) : []).toEqual([]);
  });

  test('the owner, outside a seat, cannot publish as the seat', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'hello');
    const io = testIo(w.root, { kind: 'owner' });
    expect(await runReply([sent.id, 'owner answer'], io, { home: w.home, now: () => NOW })).toBe(1);
  });

  test('a revoked grant stops new replies and the revoked client\'s reads', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'before revoke');
    expect((await seatReply(w, 'orchestrator', sent.id, 'kept')).code).toBe(0);
    const revoked = appendClientRevocation(w.home, w.grantId, { now: new Date(NOW.getTime() + 61_000), key: keyOf(w.home) });
    expect(revoked.ok).toBe(true);
    const after = await seatReply(w, 'orchestrator', sent.id, 'after revoke');
    expect(after.code).toBe(1);
    expect(after.out + after.err).toContain('not active');
    // The revoked client reads nothing more either: the read itself needs an active grant.
    const read = await clientRead(w);
    expect(read.code).toBe(1);
    expect(read.out).toContain('was revoked');
  });

  test('a reply record is not itself a thread a seat answers', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'hello');
    const first = await seatReply(w, 'orchestrator', sent.id, 'answer');
    expect(first.code).toBe(0);
    expect((await seatReply(w, 'orchestrator', first.json.record, 'reply to my reply')).code).not.toBe(0);
  });
});
