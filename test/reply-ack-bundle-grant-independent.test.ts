// Independent verification of fix/reply-ack-bundle-grant (0116419b7).
//
// Coverage:
// 1. BUNDLE_OP_ROUTES and readClientThreadGrant distinguish verified plain client grants and
//    verified bundle grants, and refuse tampered or missing grants without cross-reader fallback.
// 2. A reply to a thread a bundle-grant client opened (manager or developer bundle carrying
//    `send` and `reply`) is delivered to that client's inbox, records seat receipts, and is
//    accepted by scanClientInbox (including after a later revocation of the bundle).
// 3. An ack on a thread a bundle-grant client opened (bundle carrying `send` and `ack`) is
//    admitted in the recipient seat's drop folder and is idempotent on repeat calls.
// 4. A bundle without `reply` is refused by `team reply`, and a bundle without `ack` is refused
//    by `team ack`, leaving the client inbox and seat receipts untouched.
// 5. A record naming another client inbox, another seat, a mismatched recipient agent id, or a
//    non-root thread record is refused on both `team reply` and `team ack`.
// 6. An expired or revoked bundle is refused on both `team reply` and `team ack` under the
//    publication lock.
// 7. Plain client grants are unchanged: an inbox-enabled plain grant still admits `team reply`
//    and `scanClientInbox`, a send-only plain grant is still refused by `team reply`, and every
//    plain-grant record is still refused by `team ack`.
//
// Synthetic fixtures, keys and grants only; never touches the machine's credential store.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discardFixtures } from './fixture-cleanup.ts';
import { BUNDLE_OP_ROUTES, type BundleName, type BundleOp } from '../src/client/bundle-ops.ts';
import { clientInboxFolder, ensureClientInbox, scanClientInbox, writeClientInboxFile } from '../src/client/inbox.ts';
import {
  appendClientRevocation,
  clientGrantPath,
  clientKeyDir,
  newClientKeyPair,
  readClientThreadGrant,
  writeClientBundleGrant,
  writeClientGrant,
  writeClientKeyFiles,
} from '../src/client/records.ts';
import { runAck } from '../src/commands/ack.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { keyOf, messageKeyOf } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const DAY = 86_400_000;
const SESSION = 'acme-bundle-session';

let suiteBase: string;
let seq = 0;
let recordSeq = 0;

beforeAll(() => {
  suiteBase = fixtureBase('.reply-ack-bundle-ind-');
});

afterAll(() => {
  discardFixtures([suiteBase], { roots: [dirname(suiteBase)] });
});

function nextUuid(): string {
  recordSeq += 1;
  return `${String(recordSeq).padStart(8, '0')}-2222-4222-8222-222222222222`;
}

const TEAM_YAML = `format: 1
project: floor
entity: floor
coordinator: orchestrator
operator: orchestrator
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: orchestrator
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

type GrantSpec =
  | {
      kind: 'bundle';
      bundle?: BundleName;
      ops: BundleOp[];
      seats?: string[];
      issued?: Date;
      clientId?: string;
    }
  | {
      kind: 'plain';
      inbox: boolean;
      issued?: Date;
      clientId?: string;
    };

function makeFixture(spec: GrantSpec) {
  seq += 1;
  const base = join(suiteBase, `case-${seq}`);
  const root = join(base, 'floor');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  const ownerKey = keyOf(home);
  const msgKey = messageKeyOf(home);
  const teamId = teamIdOf(root);

  const orchestratorAgent = registerAgent(home, {
    name: 'orchestrator',
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      team: teamId,
      seat: 'orchestrator',
      session: SESSION,
      pane: 'pane:orchestrator',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });

  const builderAgent = registerAgent(home, {
    name: 'builder',
    signing: { model: 'Claude Opus', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      team: teamId,
      seat: 'builder',
      session: SESSION,
      pane: 'pane:builder',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });

  upsertTeam(home, teamId, {
    project: 'floor',
    entity: 'floor',
    session: SESSION,
    root,
    lobby: join(base, 'lobby'),
    roster: [
      { agent: orchestratorAgent.id, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: builderAgent.id, seat: 'builder', role: 'builder' },
    ],
    lifecycle: 'running',
  });

  updateState(join(root, '.agents'), (state) => {
    state.sessions[SESSION] = {
      seats: {
        orchestrator: { stage: 'ready' as const, pane: 'pane:orchestrator' },
        builder: { stage: 'ready' as const, pane: 'pane:builder' },
      },
    } as never;
  });

  const clientId = spec.clientId ?? 'grok-bot';
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, clientId);
  const keys = writeClientKeyFiles(keyDir, pair);
  if (!keys.ok) throw new Error(keys.why);

  const written =
    spec.kind === 'bundle'
      ? writeClientBundleGrant(
          home,
          {
            clientId,
            entity: 'floor',
            publicKey: pair.publicKey,
            keyId: pair.keyId,
            keyDir,
            bundle: spec.bundle ?? 'manager',
            ops: spec.ops,
            seats: spec.seats ?? ['orchestrator'],
            up: { project: 'floor', teamId, root, fingerprints: { sections: {}, seats: {} } },
          },
          { now: spec.issued ?? NOW, key: ownerKey },
        )
      : writeClientGrant(
          home,
          {
            clientId,
            entity: 'floor',
            publicKey: pair.publicKey,
            keyId: pair.keyId,
            keyDir,
            inbox: spec.inbox,
          },
          { now: spec.issued ?? NOW, key: ownerKey },
        );
  if (!written.ok) throw new Error(written.why);

  return {
    base,
    root,
    home,
    teamId,
    clientId,
    grantPath: written.path,
    grantId: written.grant.grantId,
    keyPath: join(keyDir, 'client.key'),
    ownerKey,
    msgKey,
    orchestratorAgent,
    builderAgent,
  };
}

type Fixture = ReturnType<typeof makeFixture>;

function seatDropsDir(f: Fixture, seat: string): string {
  return join(f.root, '.agents', 'send-drops', SESSION, seat);
}

function listClientInboxFiles(f: Fixture, clientId = f.clientId): string[] {
  const dir = clientInboxFolder(f.root, SESSION, clientId);
  return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith('.')) : [];
}

async function sendFromClient(f: Fixture, targetSeat: string, body: string, at: Date = NOW) {
  const io = testIo(f.root, { kind: 'owner' });
  const id = nextUuid();
  const host = { home: f.home, now: () => at, sendId: () => id } as unknown as SendHost;
  const code = await runSend(
    ['--client', f.grantPath, '--key', f.keyPath, `${targetSeat}@floor`, body],
    io,
    host,
  );
  return { code, id, out: io.out, err: io.err };
}

async function replyFromSeat(
  f: Fixture,
  seat: 'orchestrator' | 'builder',
  recordId: string,
  text: string,
  at: Date = new Date(NOW.getTime() + 60_000),
) {
  const pane = seat === 'orchestrator' ? 'pane:orchestrator' : 'pane:builder';
  const io = testIo(f.root, { kind: 'seat', name: seat, pane, session: SESSION });
  const replyId = nextUuid();
  const code = await runReply([recordId, text, '--json'], io, {
    home: f.home,
    now: () => at,
    newId: () => replyId,
  });
  return {
    code,
    replyId,
    out: io.out,
    err: io.err,
    doc: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null,
  };
}

async function ackFromSeat(
  f: Fixture,
  seat: 'orchestrator' | 'builder',
  recordId: string,
  at: Date = new Date(NOW.getTime() + 60_000),
) {
  const pane = seat === 'orchestrator' ? 'pane:orchestrator' : 'pane:builder';
  const io = testIo(f.root, { kind: 'seat', name: seat, pane, session: SESSION });
  const code = await runAck([recordId, '--json'], io, { home: f.home, now: () => at });
  return {
    code,
    out: io.out,
    err: io.err,
    doc: io.out.trim().startsWith('{') ? JSON.parse(io.out) : null,
  };
}

describe('1. bundle route table and readClientThreadGrant origin verification', () => {
  test('BUNDLE_OP_ROUTES marks reply and ack as routed, and readClientThreadGrant distinguishes bundle vs plain grants', () => {
    expect(BUNDLE_OP_ROUTES.send).toBe(true);
    expect(BUNDLE_OP_ROUTES.reply).toBe(true);
    expect(BUNDLE_OP_ROUTES.ack).toBe(true);

    const bundleFix = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const bundleRead = readClientThreadGrant(bundleFix.home, bundleFix.grantId);
    expect(bundleRead.ok).toBe(true);
    if (bundleRead.ok) {
      expect(bundleRead.kind).toBe('bundle');
      expect(bundleRead.grant.grantId).toBe(bundleFix.grantId);
    }

    const plainFix = makeFixture({ kind: 'plain', inbox: true });
    const plainRead = readClientThreadGrant(plainFix.home, plainFix.grantId);
    expect(plainRead.ok).toBe(true);
    if (plainRead.ok) {
      expect(plainRead.kind).toBe('grant');
      expect(plainRead.grant.grantId).toBe(plainFix.grantId);
    }

    const badId = readClientThreadGrant(bundleFix.home, '../not-a-grant-id');
    expect(badId.ok).toBe(false);

    // Tampering with a bundle grant file in the canonical store fails verification cleanly.
    const canonPath = clientGrantPath(bundleFix.home, bundleFix.grantId);
    const raw = JSON.parse(readFileSync(canonPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(canonPath, `${JSON.stringify({ ...raw, ops: ['send', 'reply'] }, null, 2)}\n`);
    const tampered = readClientThreadGrant(bundleFix.home, bundleFix.grantId);
    expect(tampered.ok).toBe(false);
  });
});

describe('2. reply to a thread a bundle-grant client opened is delivered and verified in client inbox', () => {
  test('manager bundle carrying send and reply delivers the answer to the client inbox and records seat receipts', async () => {
    const f = makeFixture({ kind: 'bundle', bundle: 'manager', ops: ['send', 'reply'] });
    const sent = await sendFromClient(f, 'orchestrator', 'status update needed');
    expect(sent.code).toBe(0);

    const replied = await replyFromSeat(f, 'orchestrator', sent.id, 'all slices green');
    expect(replied.err).toBe('');
    expect(replied.code).toBe(0);
    expect(replied.doc).toMatchObject({
      status: 'replied',
      project: 'floor',
      session: SESSION,
      record: replied.replyId,
      thread: sent.id,
      in_reply_to: sent.id,
      to: `client:${f.clientId}`,
      reply: 'all slices green',
    });

    // Both read and replied receipts are written beside the opening record in the seat's drop folder.
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(true);
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.replied.json`))).toBe(true);

    // The reply is in the client's inbox and scanClientInbox verifies its bundle provenance.
    expect(listClientInboxFiles(f)).toEqual([replied.replyId]);
    const scanned = scanClientInbox({
      home: f.home,
      root: f.root,
      session: SESSION,
      clientId: f.clientId,
      key: f.msgKey,
    });
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.scan.refused).toEqual([]);
      expect(scanned.scan.shown).toHaveLength(1);
      expect(scanned.scan.shown[0]).toMatchObject({
        id: replied.replyId,
        from: 'orchestrator',
        from_id: f.orchestratorAgent.id,
        to: `client:${f.clientId}`,
        thread: sent.id,
        grantId: f.grantId,
      });
      expect(scanned.scan.shown[0]!.body).toContain('all slices green');
    }

    // Even after the bundle grant is later revoked, existing verified replies remain readable in history.
    const rev = appendClientRevocation(f.home, f.grantId, {
      now: new Date(NOW.getTime() + 120_000),
      key: f.ownerKey,
    });
    expect(rev.ok).toBe(true);
    const scannedAfterRevoke = scanClientInbox({
      home: f.home,
      root: f.root,
      session: SESSION,
      clientId: f.clientId,
      key: f.msgKey,
    });
    expect(scannedAfterRevoke.ok).toBe(true);
    if (scannedAfterRevoke.ok) {
      expect(scannedAfterRevoke.scan.shown).toHaveLength(1);
      expect(scannedAfterRevoke.scan.shown[0]!.id).toBe(replied.replyId);
    }
  });

  test('developer bundle (vocabulary 7) carrying send, reply and ack delivers both reply and ack for its declared seat', async () => {
    const f = makeFixture({
      kind: 'bundle',
      bundle: 'developer',
      ops: ['send', 'reply', 'ack'],
      seats: ['orchestrator'],
    });
    const sent1 = await sendFromClient(f, 'orchestrator', 'question under developer bundle');
    expect(sent1.code).toBe(0);

    const replied = await replyFromSeat(f, 'orchestrator', sent1.id, 'developer bundle answer');
    expect(replied.code).toBe(0);
    expect(replied.doc).toMatchObject({
      status: 'replied',
      to: `client:${f.clientId}`,
      thread: sent1.id,
    });

    const sent2 = await sendFromClient(f, 'orchestrator', 'heads up under developer bundle');
    expect(sent2.code).toBe(0);
    const acked = await ackFromSeat(f, 'orchestrator', sent2.id);
    expect(acked.code).toBe(0);
    expect(acked.doc).toMatchObject({
      status: 'read',
      record: sent2.id,
      to: 'orchestrator',
      thread: sent2.id,
      written: true,
    });
  });

  test('scanClientInbox refuses a forged reply naming a seat outside the bundle grant seats list', async () => {
    const f = makeFixture({
      kind: 'bundle',
      bundle: 'manager',
      ops: ['send', 'reply'],
      seats: ['orchestrator'],
    });
    const sent = await sendFromClient(f, 'orchestrator', 'for orchestrator');
    expect(sent.code).toBe(0);

    const inbox = ensureClientInbox(f.root, SESSION, f.clientId);
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) return;

    const forgedId = nextUuid();
    const forgedPayload: RecordPayload = {
      kind: 'message',
      id: forgedId,
      to: `client:${f.clientId}`,
      to_id: null,
      root: f.root,
      session: SESSION,
      at: NOW.toISOString(),
      body: 'forged from builder',
      from: 'builder',
      from_id: f.builderAgent.id,
      rule: 'a seat to the client that opened the thread',
      thread: sent.id,
      in_reply_to: sent.id,
      to_client: { client_id: f.clientId, grant_id: f.grantId },
    };
    const signed = signRecord(forgedPayload, f.home);
    expect(writeClientInboxFile(inbox.dir, forgedId, `${JSON.stringify(signed, null, 2)}\n`)).toBe('written');

    const scanned = scanClientInbox({
      home: f.home,
      root: f.root,
      session: SESSION,
      clientId: f.clientId,
      key: f.msgKey,
    });
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.scan.shown).toEqual([]);
      expect(scanned.scan.refused).toHaveLength(1);
      expect(scanned.scan.refused[0]!.why).toContain('not a seat the bundle grant');
    }
  });
});

describe('3. ack on a thread a bundle-grant client opened is admitted', () => {
  test('bundle carrying ack writes the signed read receipt in the seat folder and is idempotent on repeat calls', async () => {
    const f = makeFixture({ kind: 'bundle', ops: ['send', 'ack'] });
    const sent = await sendFromClient(f, 'orchestrator', 'fyi from bundle client');
    expect(sent.code).toBe(0);

    const first = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.doc).toMatchObject({
      status: 'read',
      record: sent.id,
      to: 'orchestrator',
      thread: sent.id,
      written: true,
    });
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(true);

    const second = await ackFromSeat(f, 'orchestrator', sent.id, new Date(NOW.getTime() + 90_000));
    expect(second.code).toBe(0);
    expect(second.doc).toMatchObject({
      status: 'read',
      record: sent.id,
      to: 'orchestrator',
      thread: sent.id,
      written: false,
    });
  });
});

describe('4. a bundle without reply or without ack is refused', () => {
  test('a bundle without reply is refused by team reply, writing nothing to the inbox or seat receipts', async () => {
    const f = makeFixture({ kind: 'bundle', ops: ['send', 'ack'] });
    const sent = await sendFromClient(f, 'orchestrator', 'no reply op in bundle');
    expect(sent.code).toBe(0);

    const replied = await replyFromSeat(f, 'orchestrator', sent.id, 'should be refused');
    expect(replied.code).toBe(1);
    expect(replied.doc.error.id).toBe('reply.client-refused');
    expect(replied.doc.error.message).toContain(`bundle grant ${f.grantId} carries send, ack, not reply`);
    expect(replied.doc.error.message).toContain('nothing was written');
    expect(listClientInboxFiles(f)).toEqual([]);
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.replied.json`))).toBe(false);
  });

  test('a bundle without ack is refused by team ack, writing no read receipt', async () => {
    const f = makeFixture({ kind: 'bundle', ops: ['send', 'reply'] });
    const sent = await sendFromClient(f, 'orchestrator', 'no ack op in bundle');
    expect(sent.code).toBe(0);

    const acked = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.doc.error.id).toBe('ack.refused');
    expect(acked.doc.error.message).toContain(`bundle grant ${f.grantId} carries send, reply, not ack`);
    expect(acked.doc.error.message).toContain('nothing was written');
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);
  });
});

describe('5. another client inbox, wrong seat, mismatched recipient, or roster change is refused', () => {
  test('a record naming another client inbox is refused by both team reply and team ack', async () => {
    const f = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'], clientId: 'grok-bot' });
    const sent = await sendFromClient(f, 'orchestrator', 'bound to grok-bot');
    expect(sent.code).toBe(0);

    const recordPath = join(seatDropsDir(f, 'orchestrator'), sent.id);
    const original = JSON.parse(readFileSync(recordPath, 'utf8')) as { payload: RecordPayload };
    const forgedPayload: RecordPayload = {
      ...original.payload,
      from: 'client:client-other',
      from_client: { client_id: 'client-other', grant_id: f.grantId },
    };
    writeFileSync(recordPath, `${JSON.stringify(signRecord(forgedPayload, f.home), null, 2)}\n`);

    const replied = await replyFromSeat(f, 'orchestrator', sent.id, 'must not land in either inbox');
    expect(replied.code).toBe(1);
    expect(replied.doc.error.message).toContain('this thread names client "client-other" and its grant names "grok-bot"');
    expect(replied.doc.error.message).toContain('nothing was written');
    expect(listClientInboxFiles(f, 'grok-bot')).toEqual([]);
    expect(listClientInboxFiles(f, 'client-other')).toEqual([]);

    const acked = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.doc.error.message).toContain('this record names client "client-other" and its grant names "grok-bot"');
    expect(acked.doc.error.message).toContain('nothing was written');
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);
  });

  test('a roster change replacing the recipient seat agent after send (or while waiting for the lock) is refused by both team reply and team ack', async () => {
    const rotateOrchestrator = (f: Fixture) => {
      updateAgent(f.home, f.orchestratorAgent.id, { lifecycle: 'retired' });
      const replacement = registerAgent(f.home, {
        name: 'orchestrator',
        signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
        lab: 'anthropic',
        cli: 'claude-code',
        launcher: null,
        launch: 'claude --model claude-opus-5-5',
        reach: {
          team: f.teamId,
          seat: 'orchestrator',
          session: SESSION,
          pane: 'pane:orchestrator',
          address: null,
        },
        mcp: [],
        skills: [],
        lifecycle: 'running',
        by: 'test',
      });
      upsertTeam(f.home, f.teamId, {
        project: 'floor',
        entity: 'floor',
        session: SESSION,
        root: f.root,
        lobby: join(f.base, 'lobby'),
        roster: [
          { agent: replacement.id, seat: 'orchestrator', role: 'orchestrator', leads: true },
          { agent: f.builderAgent.id, seat: 'builder', role: 'builder' },
        ],
        lifecycle: 'running',
      });
      return replacement;
    };

    // Part A: Roster changes before reply / ack is invoked.
    const f1 = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent1 = await sendFromClient(f1, 'orchestrator', 'addressed to original orchestrator agent');
    expect(sent1.code).toBe(0);

    rotateOrchestrator(f1);

    const preReply = await replyFromSeat(f1, 'orchestrator', sent1.id, 'after roster change');
    expect(preReply.code).toBe(1);
    expect(preReply.doc.error.id).toBe('reply.client-refused');
    expect(preReply.doc.error.message).toContain('not to the recipient the bundle grant reaches');
    expect(listClientInboxFiles(f1)).toEqual([]);

    const preAck = await ackFromSeat(f1, 'orchestrator', sent1.id);
    expect(preAck.code).toBe(1);
    expect(preAck.doc.error.id).toBe('ack.refused');
    expect(preAck.doc.error.message).toContain('not to the recipient the bundle grant reaches');
    expect(existsSync(join(seatDropsDir(f1, 'orchestrator'), `${sent1.id}.read.json`))).toBe(false);

    // Part B: Roster changes after the initial binding check, right before the grant-lock section.
    const f2 = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent2 = await sendFromClient(f2, 'orchestrator', 'addressed before in-flight roster change');
    expect(sent2.code).toBe(0);

    const replyIo = testIo(f2.root, { kind: 'seat', name: 'orchestrator', pane: 'pane:orchestrator', session: SESSION });
    const replyCode = await runReply([sent2.id, 'in-flight roster change', '--json'], replyIo, {
      home: f2.home,
      now: () => new Date(NOW.getTime() + 60_000),
      newId: () => {
        // Executed after the pre-lock resolveOriginBinding() check and immediately before withClientGrantLock.
        rotateOrchestrator(f2);
        return nextUuid();
      },
    });
    expect(replyCode).toBe(1);
    const replyDoc = JSON.parse(replyIo.out);
    expect(replyDoc.error.id).toBe('reply.client-refused');
    expect(replyDoc.error.message).toContain('changed while this call waited');
    expect(replyDoc.error.message).toContain('nothing was written');
    expect(listClientInboxFiles(f2)).toEqual([]);
    expect(existsSync(join(seatDropsDir(f2, 'orchestrator'), `${sent2.id}.replied.json`))).toBe(false);

    // Same in-flight roster change on team ack (triggered between pre-lock resolveBundleSendTarget and withClientGrantLock).
    const f3 = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent3 = await sendFromClient(f3, 'orchestrator', 'addressed before in-flight ack roster change');
    expect(sent3.code).toBe(0);

    const ackIo = testIo(f3.root, { kind: 'seat', name: 'orchestrator', pane: 'pane:orchestrator', session: SESSION });
    let ackNowCalls = 0;
    const ackCode = await runAck([sent3.id, '--json'], ackIo, {
      home: f3.home,
      now: () => {
        ackNowCalls += 1;
        // First now() call is at const at = host.now().toISOString() after pre-lock check; rotate before lock check.
        if (ackNowCalls === 1) rotateOrchestrator(f3);
        return new Date(NOW.getTime() + 60_000);
      },
    });
    expect(ackCode).toBe(1);
    const ackDoc = JSON.parse(ackIo.out);
    expect(ackDoc.error.id).toBe('ack.refused');
    expect(ackDoc.error.message).toContain("the bundle grant's recipient changed while this call waited");
    expect(existsSync(join(seatDropsDir(f3, 'orchestrator'), `${sent3.id}.read.json`))).toBe(false);
  });

  test('another seat or a record with a mismatched recipient agent id or non-root thread is refused by both routes', async () => {
    const f = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent = await sendFromClient(f, 'orchestrator', 'only orchestrator may answer or ack');
    expect(sent.code).toBe(0);

    // Another seat of the same team cannot reply or ack.
    const wrongSeatReply = await replyFromSeat(f, 'builder', sent.id, 'wrong seat');
    expect(wrongSeatReply.code).toBe(1);
    expect(listClientInboxFiles(f)).toEqual([]);

    const wrongSeatAck = await ackFromSeat(f, 'builder', sent.id);
    expect(wrongSeatAck.code).toBe(1);
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);

    // A record whose to_id does not match the registered agent id of the recipient seat is refused.
    const recordPath = join(seatDropsDir(f, 'orchestrator'), sent.id);
    const original = JSON.parse(readFileSync(recordPath, 'utf8')) as { payload: RecordPayload };
    const wrongToId: RecordPayload = {
      ...original.payload,
      to_id: 'agent_wrong_id',
    };
    writeFileSync(recordPath, `${JSON.stringify(signRecord(wrongToId, f.home), null, 2)}\n`);

    const badToIdReply = await replyFromSeat(f, 'orchestrator', sent.id, 'wrong to_id');
    expect(badToIdReply.code).toBe(1);
    expect(badToIdReply.doc.error.message).toContain('not to the recipient the bundle grant reaches');

    const badToIdAck = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(badToIdAck.code).toBe(1);
    expect(badToIdAck.doc.error.message).toContain('not to the recipient the bundle grant reaches');

    // A record that is not its own thread root (thread !== id) is refused.
    const nonRoot: RecordPayload = {
      ...original.payload,
      thread: nextUuid(),
    };
    writeFileSync(recordPath, `${JSON.stringify(signRecord(nonRoot, f.home), null, 2)}\n`);

    const nonRootReply = await replyFromSeat(f, 'orchestrator', sent.id, 'not thread root');
    expect(nonRootReply.code).toBe(1);
    expect(nonRootReply.doc.error.message).toContain("a client thread is the client's own opening record");

    const nonRootAck = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(nonRootAck.code).toBe(1);
    expect(nonRootAck.doc.error.message).toContain("a client thread is the client's own opening record");
  });
});

describe('6. expired or revoked bundle grants are refused on both reply and ack', () => {
  test('an expired bundle grant is refused by both team reply and team ack', async () => {
    // Issued 91 days before NOW (90-day default TTL -> expired 1 day before NOW);
    // message sent 2 days before NOW (before expiry, and still within the 72h thread TTL).
    const f = makeFixture({
      kind: 'bundle',
      ops: ['send', 'reply', 'ack'],
      issued: new Date(NOW.getTime() - 91 * DAY),
    });
    const sent = await sendFromClient(f, 'orchestrator', 'opened while active', new Date(NOW.getTime() - 2 * DAY));
    expect(sent.code).toBe(0);

    const replied = await replyFromSeat(f, 'orchestrator', sent.id, 'after expiry');
    expect(replied.code).toBe(1);
    expect(replied.doc.error.message).toContain(`the originating grant ${f.grantId} is not active`);
    expect(replied.doc.error.message).toContain('expired at');
    expect(replied.doc.error.message).toContain('nothing was written');
    expect(listClientInboxFiles(f)).toEqual([]);

    const acked = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.doc.error.message).toContain(`the originating grant ${f.grantId} is not active`);
    expect(acked.doc.error.message).toContain('expired at');
    expect(acked.doc.error.message).toContain('nothing was written');
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);
  });

  test('a revoked bundle grant is refused by both team reply and team ack', async () => {
    const f = makeFixture({ kind: 'bundle', ops: ['send', 'reply', 'ack'] });
    const sent = await sendFromClient(f, 'orchestrator', 'opened before revocation');
    expect(sent.code).toBe(0);

    const revoked = appendClientRevocation(f.home, f.grantId, {
      now: new Date(NOW.getTime() + 15_000),
      key: f.ownerKey,
    });
    expect(revoked.ok).toBe(true);

    const replied = await replyFromSeat(f, 'orchestrator', sent.id, 'after revocation');
    expect(replied.code).toBe(1);
    expect(replied.doc.error.message).toContain(`the originating grant ${f.grantId} is not active`);
    expect(replied.doc.error.message).toContain('was revoked');
    expect(replied.doc.error.message).toContain('nothing was written');
    expect(listClientInboxFiles(f)).toEqual([]);

    const acked = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.doc.error.message).toContain(`the originating grant ${f.grantId} is not active`);
    expect(acked.doc.error.message).toContain('was revoked');
    expect(acked.doc.error.message).toContain('nothing was written');
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);
  });
});

describe('7. plain client grants remain unchanged', () => {
  test('an inbox-enabled plain grant still admits team reply and scanClientInbox, and is still refused by team ack', async () => {
    const f = makeFixture({ kind: 'plain', inbox: true });
    const sent1 = await sendFromClient(f, 'orchestrator', 'plain grant with inbox');
    expect(sent1.code).toBe(0);

    // team ack still refuses every plain-grant client record.
    const acked = await ackFromSeat(f, 'orchestrator', sent1.id);
    expect(acked.code).toBe(1);
    expect(acked.doc.error.id).toBe('ack.refused');
    expect(acked.doc.error.message).toContain('its read belongs to the client inbox, not to this command');
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent1.id}.read.json`))).toBe(false);

    // team reply still delivers the answer to the plain-grant client inbox.
    const replied = await replyFromSeat(f, 'orchestrator', sent1.id, 'plain grant answer');
    expect(replied.code).toBe(0);
    expect(replied.doc).toMatchObject({
      status: 'replied',
      to: `client:${f.clientId}`,
      thread: sent1.id,
      record: replied.replyId,
    });
    expect(listClientInboxFiles(f)).toEqual([replied.replyId]);

    const scanned = scanClientInbox({
      home: f.home,
      root: f.root,
      session: SESSION,
      clientId: f.clientId,
      key: f.msgKey,
    });
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.scan.shown).toHaveLength(1);
      expect(scanned.scan.shown[0]!.id).toBe(replied.replyId);
    }
  });

  test('a send-only plain grant is still refused by both team reply and team ack', async () => {
    const f = makeFixture({ kind: 'plain', inbox: false });
    const sent = await sendFromClient(f, 'orchestrator', 'plain send-only');
    expect(sent.code).toBe(0);

    const replied = await replyFromSeat(f, 'orchestrator', sent.id, 'cannot answer send-only');
    expect(replied.code).toBe(1);
    expect(replied.doc.error.id).toBe('reply.client-refused');
    expect(replied.doc.error.message).toContain('is send-only; only a grant with send and messages opens a client thread a seat may answer');
    expect(listClientInboxFiles(f)).toEqual([]);

    const acked = await ackFromSeat(f, 'orchestrator', sent.id);
    expect(acked.code).toBe(1);
    expect(acked.doc.error.message).toContain('its read belongs to the client inbox, not to this command');
    expect(existsSync(join(seatDropsDir(f, 'orchestrator'), `${sent.id}.read.json`))).toBe(false);
  });
});
