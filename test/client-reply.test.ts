// Client reply publication, end to end on synthetic homes: a client (grok-bot) sends to the
// orchestrator under an owner-issued grant with the inbox op, the orchestrator answers with
// `team reply`, and the client reads the answer with `team messages --client`. The scope is the
// grant's: only its recipient seat answers, only the client that opened the thread reads it, a
// send-only grant opens no conversation, and a revoked grant stops new replies.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientInboxFolder } from '../src/client/inbox.ts';
import { clientGrantsFolder, clientKeyDir, newClientKeyPair, appendClientRevocation, withClientGrantLock, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import { clientReplayFolder } from '../src/client/replay.ts';
import { runMessages } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { fixtureBase, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T21:00:00Z');
const made: string[] = [];
// Folders a test made unwritable, given their write bit back before the fixture is removed.
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700);
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
  const base = fixtureBase('.client-reply-');
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
  const pane = seat === 'orchestrator' ? 'fixture:lead' : 'fixture:worker';
  const io = testIo(w.root, { kind: 'seat', name: seat, pane, session: 'acme' });
  const code = await runReply([id, text, '--json'], io, { home: w.home, now: () => new Date(NOW.getTime() + 60_000), newId: nextId });
  return { code, out: io.out, err: io.err, json: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null };
}

async function clientRead(w: World, extra: string[] = []) {
  // Model the client's own external caller, as clientSend already does. An omitted caller
  // invokes the real parent-process walk and inherits the host running this synthetic suite.
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--json', ...extra], io, { home: w.home, now: () => new Date(NOW.getTime() + 120_000) });
  return { code, out: io.out, err: io.err, json: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null };
}

describe('a client sends, the recipient seat replies, the client reads the reply', () => {
  test('the full round trip, then the client acks it', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'Reviewer, can you hear me?');
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'Loud and clear, Assistant.');
    expect(reply.err).toBe('');
    expect(reply.code).toBe(0);
    expect(reply.json).toMatchObject({ status: 'replied', to: 'client:grok-bot', thread: sent.id });
    expect(readdirSync(clientInboxFolder(w.root, 'acme', 'grok-bot'))).toContain(reply.json.record);
    const read = await clientRead(w);
    expect(read.err).not.toContain('refused');
    expect(read.code).toBe(0);
    expect(JSON.stringify(read.json)).toContain('Loud and clear, Assistant.');
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
    const io = testIo(w.root, { kind: 'owner' });
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
    const io = testIo(w.root, { kind: 'owner' });
    expect(await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--follow', '--ack', 'x'], io, { home: w.home, now: () => NOW })).toBe(2);
    const bad = testIo(w.root, { kind: 'owner' });
    const code = await runMessages(['--client', join(w.root, 'missing.json'), '--key', w.keyPath, '--follow'], bad, { home: w.home, now: () => NOW, followReads: 3, followWait: async () => {} });
    expect(code).not.toBe(0);
    expect(bad.err).toContain('follow stopped');
  });
});

describe('the reply is scoped by the grant; nothing widens it', () => {
  test('a client read from a seat is still refused before grant or key access', async () => {
    const w = world(true);
    const io = testIo(w.root, { kind: 'seat', name: 'orchestrator', pane: 'fixture:lead', session: 'acme' });
    const code = await runMessages(['--client', join(w.base, 'missing-grant'), '--key', join(w.base, 'missing-key'), '--json'], io, { home: w.home, now: () => NOW });
    expect(code).toBe(1);
    expect(JSON.parse(io.out).error.code).toBe('messages.client-pane');
    expect(io.out).not.toContain('client-grant');
    expect(existsSync(clientInboxFolder(w.root, 'acme', 'grok-bot'))).toBe(false);
  });

  test('revocation between the initial check and publication prevents the reply', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'synthetic publication freshness check');
    expect(sent.code).toBe(0);
    const io = testIo(w.root, { kind: 'seat', name: 'orchestrator', pane: 'fixture:lead', session: 'acme' });
    let replyId = '';
    const code = await runReply([sent.id, 'must not be published', '--json'], io, {
      home: w.home,
      now: () => new Date(NOW.getTime() + 60_000),
      newId: () => {
        const revoked = appendClientRevocation(w.home, w.grantId, { now: new Date(NOW.getTime() + 60_000), key: keyOf(w.home) });
        expect(revoked.ok).toBe(true);
        replyId = nextId();
        return replyId;
      },
    });
    expect(replyId).not.toBe('');
    expect(code).toBe(1);
    expect(io.out + io.err).toContain('nothing was written');
    const inbox = clientInboxFolder(w.root, 'acme', 'grok-bot');
    expect(existsSync(inbox) ? readdirSync(inbox) : []).not.toContain(replyId);
    expect(io.out).not.toContain('must not be published');
  });

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


test('client listings ignore watcher sidecars and still refuse a corrupt record', async () => {
  const w = world(true);
  const sent = await clientSend(w, 'reply around sidecars');
  expect(sent.code).toBe(0);
  const reply = await seatReply(w, 'orchestrator', sent.id, 'the signed answer');
  expect(reply.code, reply.err).toBe(0);
  const inbox = clientInboxFolder(w.root, 'acme', 'grok-bot');
  for (const suffix of ['wake', 'woken', 'reported', 'new']) {
    writeFileSync(join(inbox, `${reply.json.record}.${suffix}`), JSON.stringify({ unsigned: true }));
  }
  const read = await clientRead(w);
  expect(read.code, read.out + read.err).toBe(0);
  expect(read.json.rows.map((row: { id: string }) => row.id)).toEqual([reply.json.record]);
  writeFileSync(join(inbox, `${reply.json.record}-corrupt`), '{}');
  const corrupt = await clientRead(w);
  expect(corrupt.code).toBe(1);
  expect(corrupt.out).toContain(`${reply.json.record}-corrupt`);
});

describe('a client read from a caller that may not write the grants folder or the team (a sandboxed seat)', () => {
  // A sandbox refuses the writes with EPERM; a folder without its write bit refuses them with
  // EACCES. Either way the old read failed at the grant lock, before any row.
  function confine(w: World): void {
    for (const dir of [clientGrantsFolder(w.home), join(w.root, '.agents')]) {
      chmodSync(dir, 0o500);
      locked.push(dir);
    }
  }

  async function replied(w: World) {
    const sent = await clientSend(w, 'are you there?');
    expect(sent.code).toBe(0);
    const reply = await seatReply(w, 'orchestrator', sent.id, 'here');
    expect(reply.code).toBe(0);
    return reply.json.record as string;
  }

  test('the lock the read used to take cannot be taken there', async () => {
    const w = world(true);
    await replied(w);
    confine(w);
    expect(() => withClientGrantLock(w.home, () => 0)).toThrow(/cannot be taken \(EACCES\)/);
  });

  test('the read succeeds, returns the inbox, and writes nothing', async () => {
    const w = world(true);
    const id = await replied(w);
    const claimsBefore = readdirSync(join(clientReplayFolder(w.root), 'grok-bot')).length;
    confine(w);
    const read = await clientRead(w);
    expect(read.err).not.toContain('refused');
    expect(read.code).toBe(0);
    expect(read.json.rows).toHaveLength(1);
    expect(read.json.rows[0]).toMatchObject({ id, from: 'orchestrator', status: 'shown' });
    expect(readdirSync(join(clientReplayFolder(w.root), 'grok-bot'))).toHaveLength(claimsBefore);
    expect(existsSync(join(clientGrantsFolder(w.home), '.client.lock'))).toBe(false);
    const since = await clientRead(w, ['--since', id, '--limit', '5']);
    expect(since.code).toBe(0);
    expect(since.json.rows).toHaveLength(0);
  });

  test('a read with no inbox folder yet is an empty reading, and creates none', async () => {
    const w = world(true);
    // The send makes the message key; no reply has made the inbox.
    expect((await clientSend(w, 'anyone?')).code).toBe(0);
    expect(existsSync(clientInboxFolder(w.root, 'acme', 'grok-bot'))).toBe(false);
    confine(w);
    const read = await clientRead(w);
    expect(read.code).toBe(0);
    expect(read.json.rows).toHaveLength(0);
    expect(existsSync(clientInboxFolder(w.root, 'acme', 'grok-bot'))).toBe(false);
  });

  test('an ack there is refused with the cause named, writes no receipt, and the read still works', async () => {
    const w = world(true);
    const id = await replied(w);
    confine(w);
    const acked = await clientRead(w, ['--ack', id]);
    expect(acked.code).toBe(1);
    expect(acked.json.error.code).toBe('messages.client-refused');
    expect(acked.json.error.message).toContain('cannot be taken (EACCES)');
    expect(acked.json.error.message).toContain('A read without --ack writes nothing');
    expect(existsSync(join(clientInboxFolder(w.root, 'acme', 'grok-bot'), `${id}.read.json`))).toBe(false);
    const read = await clientRead(w);
    expect(read.code).toBe(0);
    expect(read.json.rows).toHaveLength(1);
  });
});

describe('the grant lock guards mutations, never a read', () => {
  function hold(w: World): void {
    writeFileSync(join(clientGrantsFolder(w.home), '.client.lock'), `${JSON.stringify({ pid: 1, token: 'held', at: NOW.toISOString() })}\n`);
  }

  test('a held lock does not block a read', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'ping');
    const reply = await seatReply(w, 'orchestrator', sent.id, 'pong');
    hold(w);
    const started = Date.now();
    const read = await clientRead(w);
    expect(read.code).toBe(0);
    expect(read.json.rows[0]).toMatchObject({ id: reply.json.record, status: 'shown' });
    // The lock's wait is two seconds; a read never waits on it.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('an ack and a client send still take the lock, and a held one refuses both', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'ping');
    const reply = await seatReply(w, 'orchestrator', sent.id, 'pong');
    hold(w);
    const acked = await clientRead(w, ['--ack', reply.json.record]);
    expect(acked.code).toBe(1);
    expect(acked.json.error.message).toContain('another command holds the client grant lock');
    expect(existsSync(join(clientInboxFolder(w.root, 'acme', 'grok-bot'), `${reply.json.record}.read.json`))).toBe(false);
    const again = await clientSend(w, 'second');
    expect(again.code).not.toBe(0);
    expect(again.out + again.err).toContain('another command holds the client grant lock');
  });

  test('with the lock free the ack writes its receipt once', async () => {
    const w = world(true);
    const sent = await clientSend(w, 'ping');
    const reply = await seatReply(w, 'orchestrator', sent.id, 'pong');
    const acked = await clientRead(w, ['--ack', reply.json.record]);
    expect(acked.code).toBe(0);
    expect(acked.json.ack).toMatchObject({ id: reply.json.record, status: 'acknowledged', written: true });
    expect(existsSync(join(clientInboxFolder(w.root, 'acme', 'grok-bot'), `${reply.json.record}.read.json`))).toBe(true);
  });
});
