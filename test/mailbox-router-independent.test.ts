import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askMailbox,
  BRIDGE_WAIT_MS,
  type MailboxAskInput,
  type MailboxAskLedger,
  type MailboxAskSync,
  type MailboxReplyRead,
  type MailboxSendResult,
} from '../src/daemon/mailbox/ask.ts';
import { commandMailboxSend } from '../src/daemon/mailbox/command-send.ts';
import {
  MAILBOX_ROUTER_DEFAULTS,
  readMailboxRouterPolicy,
  resolveMailboxRouterPolicy,
  type MailboxRouterPolicy,
} from '../src/daemon/mailbox/policy.ts';
import { signRecord, type RecordPayload, type SignedRecord } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRecordPayload(id: string, over: Partial<RecordPayload> = {}): RecordPayload {
  return {
    kind: 'message',
    id,
    to: 'iris',
    to_id: null,
    root: '/fixture/root',
    session: 'fixture',
    at: '2026-11-04T03:00:00.000Z',
    body: 'ask payload body\n',
    from: 'client-alpha',
    from_id: null,
    rule: 'the asking principal',
    thread: id,
    ...over,
  };
}

describe('mailbox router 0.5.13 (independent verification)', () => {
  test('1. wrong-key or tampered-record refusal occurs before any disk write or wake, and never triggers fallback', async () => {
    const principalHome = makeTempDir('mb-ind-principal-');
    const strangerHome = makeTempDir('mb-ind-stranger-');
    const noteHome = makeTempDir('mb-ind-note-');
    const dropDir = makeTempDir('mb-ind-drop-');

    const signedByStranger = signRecord(makeRecordPayload('msg-wrong-key'), strangerHome);
    const signedByPrincipal = signRecord(makeRecordPayload('msg-tampered'), principalHome);
    const tamperedRecord: SignedRecord = {
      payload: { ...signedByPrincipal.payload, body: 'tampered body\n' },
      signature: signedByPrincipal.signature,
    };

    let wakeCalls = 0;

    // (a) Wrong signing key is refused before any write
    const wrongKeyRes = await commandMailboxSend({
      signed: signedByStranger,
      publicKey: messageKeyOf(principalHome),
      dropDir,
      home: noteHome,
      project: 'fixture',
      now: () => new Date('2026-11-04T03:00:00.000Z'),
      wake: async () => {
        wakeCalls += 1;
        return true;
      },
    });
    expect(wrongKeyRes).toEqual({
      ok: false,
      why: 'the ask is not signed by the asking principal',
    });
    expect(wakeCalls).toBe(0);
    expect(readdirSync(dropDir)).toEqual([]);
    expect(readdirSync(noteHome)).toEqual([]);

    // (b) Tampered payload with principal's signature is refused before any write
    const tamperedRes = await commandMailboxSend({
      signed: tamperedRecord,
      publicKey: messageKeyOf(principalHome),
      dropDir,
      home: noteHome,
      project: 'fixture',
      now: () => new Date('2026-11-04T03:00:00.000Z'),
      wake: async () => {
        wakeCalls += 1;
        return true;
      },
    });
    expect(tamperedRes).toEqual({
      ok: false,
      why: 'the ask is not signed by the asking principal',
    });
    expect(wakeCalls).toBe(0);
    expect(readdirSync(dropDir)).toEqual([]);
    expect(readdirSync(noteHome)).toEqual([]);

    // (c) Wired through askMailbox on an alias with a fallback ('atlas' -> primary + fallback):
    // wrong-key refusal stops on the first send, writes nothing, and never attempts the fallback.
    const attemptedTargets: string[] = [];
    const mailboxWrites: unknown[] = [];
    let replyReads = 0;
    const askRes = await askMailbox(new Map(), {
      askId: 'ask-wrong-key',
      alias: 'atlas',
      body: 'ask payload body\n',
      principal: 'client-alpha',
      signed: signedByStranger,
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 30,
      now: () => 0,
      sleep: async () => {},
      send: async (item) => {
        attemptedTargets.push(item.to);
        return commandMailboxSend({
          signed: item.signed!,
          publicKey: messageKeyOf(principalHome),
          dropDir,
          home: noteHome,
          project: 'fixture',
          now: () => new Date('2026-11-04T03:00:00.000Z'),
          wake: async () => {
            wakeCalls += 1;
            return true;
          },
        });
      },
      readReply: () => {
        replyReads += 1;
        return { verified: true, bytes: 'should-not-be-read' };
      },
      writeMailbox: (item) => {
        mailboxWrites.push(item);
      },
    });

    expect(attemptedTargets).toEqual(['orchestrator@floor']);
    expect(askRes).toEqual({
      seat: null,
      wakeTaken: false,
      replyVerified: false,
      sync: { kind: 'refused', why: 'the ask is not signed by the asking principal' },
      mailbox: null,
    });
    expect(replyReads).toBe(0);
    expect(mailboxWrites).toEqual([]);
    expect(readdirSync(dropDir)).toEqual([]);

    // (d) Valid principal signature stages the exact signed record and wakes once
    const validSigned = signRecord(makeRecordPayload('msg-valid'), principalHome);
    const validRes = await commandMailboxSend({
      signed: validSigned,
      publicKey: messageKeyOf(principalHome),
      dropDir,
      home: noteHome,
      project: 'fixture',
      now: () => new Date('2026-11-04T03:00:00.000Z'),
      wake: async () => {
        wakeCalls += 1;
        return true;
      },
    });
    expect(validRes).toEqual({ ok: true, messageId: 'msg-valid', woken: true });
    expect(wakeCalls).toBe(1);
    const stagedDisk = JSON.parse(readFileSync(join(dropDir, 'msg-valid'), 'utf8')) as SignedRecord;
    expect(stagedDisk).toEqual(validSigned);
  });

  test('2. idempotency: concurrent and sequential calls with the same askId execute once and return the first result', async () => {
    const ledger: MailboxAskLedger = new Map();
    let clock = 0;
    const sends: Array<{ principal: string; to: string; body: string }> = [];
    const mailboxWrites: Array<{ principal: string; messageId: string; bytes: string }> = [];
    const syncEvents: MailboxAskSync[] = [];

    const makeInput = (over: Partial<MailboxAskInput> = {}): MailboxAskInput => ({
      askId: 'idempotent-ask-1',
      alias: 'iris',
      body: 'original body',
      principal: 'client-alpha',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 30,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      send: async (item): Promise<MailboxSendResult> => {
        sends.push(item);
        return { ok: true, messageId: `m-${sends.length}`, woken: true };
      },
      readReply: () => (clock >= 2_000 ? { verified: true, bytes: 'verified-answer-1' } : null),
      writeMailbox: (item) => {
        mailboxWrites.push(item);
      },
      onSync: (sync) => {
        syncEvents.push(sync);
      },
      ...over,
    });

    // Launch two concurrent calls with the same askId (second has different body and alias)
    const p1 = askMailbox(ledger, makeInput());
    const p2 = askMailbox(ledger, makeInput({ alias: 'atlas', body: 'duplicate concurrent body' }));
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);

    // Sequential third call after completion with the same askId
    const r3 = await askMailbox(ledger, makeInput({ body: 'duplicate sequential body' }));
    expect(r3).toEqual(r1);

    // Only one send, one mailbox write, and one onSync notification occurred
    expect(sends).toEqual([{ principal: 'client-alpha', to: 'iris@floor', body: 'original body' }]);
    expect(mailboxWrites).toEqual([
      { principal: 'client-alpha', messageId: 'm-1', bytes: 'verified-answer-1' },
    ]);
    expect(syncEvents).toEqual([
      { kind: 'reply', bytes: 'verified-answer-1', messageId: 'm-1' },
    ]);

    // A distinct askId in the same ledger executes normally
    const rOther = await askMailbox(ledger, makeInput({ askId: 'idempotent-ask-2', body: 'second distinct ask' }));
    expect(sends).toHaveLength(2);
    expect(rOther.sync).toEqual({ kind: 'reply', bytes: 'verified-answer-1', messageId: 'm-2' });
  });

  test('3. verify before return: only verified replies write to mailbox and return bytes; unverified or timed-out replies never return unverified bytes', async () => {
    // (a) Delayed verified reply: polls until verified, writes to mailbox once, then returns reply bytes
    let clockA = 0;
    const writesA: Array<{ principal: string; messageId: string; bytes: string }> = [];
    const syncsA: Array<{ at: number; sync: MailboxAskSync }> = [];
    let typedCalls = 0;

    const resA = await askMailbox(new Map(), {
      askId: 'verify-ok',
      alias: 'iris',
      body: 'check status',
      principal: 'client-alpha',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 10,
      now: () => clockA,
      sleep: async (ms) => {
        clockA += ms;
      },
      send: async () => ({ ok: true, messageId: 'm-verify-ok', woken: true }),
      readReply: (): MailboxReplyRead =>
        clockA >= 3_000 ? { verified: true, bytes: 'signed-verified-payload' } : null,
      writeMailbox: (item) => {
        writesA.push(item);
      },
      onSync: (sync) => {
        syncsA.push({ at: clockA, sync });
      },
      typeText: () => {
        typedCalls += 1;
        return true;
      },
    });

    expect(clockA).toBe(3_000);
    expect(writesA).toEqual([
      { principal: 'client-alpha', messageId: 'm-verify-ok', bytes: 'signed-verified-payload' },
    ]);
    expect(resA).toEqual({
      seat: 'iris@floor',
      wakeTaken: true,
      replyVerified: true,
      sync: { kind: 'reply', bytes: 'signed-verified-payload', messageId: 'm-verify-ok' },
      mailbox: { messageId: 'm-verify-ok', bytes: 'signed-verified-payload' },
    });
    expect(syncsA).toEqual([
      { at: 3_000, sync: { kind: 'reply', bytes: 'signed-verified-payload', messageId: 'm-verify-ok' } },
    ]);
    expect(typedCalls).toBe(0);

    // (b) Unverified reply (`{ verified: false }`): stops immediately without sleeping to bound,
    // never writes to mailbox, and returns `unanswered`.
    let clockB = 0;
    const writesB: unknown[] = [];
    const resB = await askMailbox(new Map(), {
      askId: 'verify-fail',
      alias: 'iris',
      body: 'check status',
      principal: 'client-alpha',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 30,
      now: () => clockB,
      sleep: async (ms) => {
        clockB += ms;
      },
      send: async () => ({ ok: true, messageId: 'm-verify-fail', woken: true }),
      readReply: (): MailboxReplyRead => (clockB >= 2_000 ? { verified: false } : null),
      writeMailbox: (item) => {
        writesB.push(item);
      },
    });

    expect(clockB).toBe(2_000);
    expect(writesB).toEqual([]);
    expect(resB).toEqual({
      seat: 'iris@floor',
      wakeTaken: true,
      replyVerified: false,
      sync: { kind: 'unanswered', messageId: 'm-verify-fail' },
      mailbox: null,
    });

    // (c) Bridge caller where reply arrives after BRIDGE_WAIT_MS (120s) but fails verification at 140s:
    // onSync announced 'not-yet' at 120s, and at 140s the unverified reply is rejected without writing to mailbox.
    let clockC = 0;
    const writesC: unknown[] = [];
    const syncsC: Array<{ at: number; sync: MailboxAskSync }> = [];
    const resC = await askMailbox(new Map(), {
      askId: 'bridge-late-unverified',
      alias: 'iris',
      body: 'check bridge',
      principal: 'client-alpha',
      caller: 'bridge',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 90,
      now: () => clockC,
      sleep: async (ms) => {
        clockC += ms;
      },
      send: async () => ({ ok: true, messageId: 'm-bridge-bad', woken: true }),
      readReply: (): MailboxReplyRead => (clockC >= 140_000 ? { verified: false } : null),
      writeMailbox: (item) => {
        writesC.push(item);
      },
      onSync: (sync) => {
        syncsC.push({ at: clockC, sync });
      },
    });

    expect(clockC).toBe(140_000);
    expect(syncsC).toEqual([
      { at: BRIDGE_WAIT_MS, sync: { kind: 'not-yet', messageId: 'm-bridge-bad', line: 'not answered yet' } },
    ]);
    expect(writesC).toEqual([]);
    expect(resC.replyVerified).toBe(false);
    expect(resC.mailbox).toBeNull();
  });

  test('4. fallback runs on a definite miss (ok: true, woken: false) only — never on a taken wake that times out or fails verification, and never on a send refusal', async () => {
    // (a) Primary wake is taken (`woken: true`), but reply never arrives before bound:
    // fallback ('iris@floor') is NEVER called.
    let clockTimeout = 0;
    const timeoutTargets: string[] = [];
    const resTimeout = await askMailbox(new Map(), {
      askId: 'woken-then-timeout',
      alias: 'atlas',
      body: 'question for atlas',
      principal: 'owner',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 5,
      now: () => clockTimeout,
      sleep: async (ms) => {
        clockTimeout += ms;
      },
      send: async (item) => {
        timeoutTargets.push(item.to);
        return { ok: true, messageId: 'm-primary-timeout', woken: true };
      },
      readReply: () => null,
      writeMailbox: () => {},
    });

    expect(timeoutTargets).toEqual(['orchestrator@floor']);
    expect(clockTimeout).toBe(10_000);
    expect(resTimeout).toEqual({
      seat: 'orchestrator@floor',
      wakeTaken: true,
      replyVerified: false,
      sync: { kind: 'not-woken', messageId: 'm-primary-timeout', line: 'queued, not woken' },
      mailbox: null,
    });

    // (b) Primary wake is taken (`woken: true`), and reply fails verification (`verified: false`):
    // fallback ('iris@floor') is NEVER called.
    const unverifiedTargets: string[] = [];
    const resUnverified = await askMailbox(new Map(), {
      askId: 'woken-then-unverified',
      alias: 'atlas',
      body: 'question for atlas',
      principal: 'owner',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 5,
      now: () => 0,
      sleep: async () => {},
      send: async (item) => {
        unverifiedTargets.push(item.to);
        return { ok: true, messageId: 'm-primary-unverified', woken: true };
      },
      readReply: () => ({ verified: false }),
      writeMailbox: () => {},
    });

    expect(unverifiedTargets).toEqual(['orchestrator@floor']);
    expect(resUnverified.seat).toBe('orchestrator@floor');
    expect(resUnverified.sync).toEqual({ kind: 'unanswered', messageId: 'm-primary-unverified' });

    // (c) Definite miss on primary (`woken: false`), fallback is tried ONCE and also misses (`woken: false`):
    // returns not-woken for the fallback messageId and does not loop further.
    const doubleMissTargets: string[] = [];
    const resDoubleMiss = await askMailbox(new Map(), {
      askId: 'double-miss',
      alias: 'atlas',
      body: 'question for atlas',
      principal: 'owner',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 5,
      now: () => 0,
      sleep: async () => {},
      send: async (item) => {
        doubleMissTargets.push(item.to);
        return { ok: true, messageId: `m-miss-${doubleMissTargets.length}`, woken: false };
      },
      readReply: () => ({ verified: true, bytes: 'unreachable' }),
      writeMailbox: () => {},
    });

    expect(doubleMissTargets).toEqual(['orchestrator@floor', 'iris@floor']);
    expect(resDoubleMiss).toEqual({
      seat: 'iris@floor',
      wakeTaken: false,
      replyVerified: false,
      sync: { kind: 'not-woken', messageId: 'm-miss-2', line: 'queued, not woken' },
      mailbox: null,
    });

    // (d) Definite miss on an alias with no fallback (`iris` has `fallback: null`):
    // sends once to `iris@floor` and returns not-woken immediately.
    const noFallbackTargets: string[] = [];
    const resNoFallback = await askMailbox(new Map(), {
      askId: 'miss-no-fallback',
      alias: 'iris',
      body: 'question for iris',
      principal: 'owner',
      caller: 'client',
      policy: MAILBOX_ROUTER_DEFAULTS,
      unreadWindowSeconds: 5,
      now: () => 0,
      sleep: async () => {},
      send: async (item) => {
        noFallbackTargets.push(item.to);
        return { ok: true, messageId: 'm-iris-miss', woken: false };
      },
      readReply: () => ({ verified: true, bytes: 'unreachable' }),
      writeMailbox: () => {},
    });

    expect(noFallbackTargets).toEqual(['iris@floor']);
    expect(resNoFallback).toEqual({
      seat: 'iris@floor',
      wakeTaken: false,
      replyVerified: false,
      sync: { kind: 'not-woken', messageId: 'm-iris-miss', line: 'queued, not woken' },
      mailbox: null,
    });

    // (e) Policy resolution and unreadable root refusal via readMailboxRouterPolicy
    const resolvedCustom = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'entity', alias: 'atlas', address: 'lead@acme', fallback: 'backup@acme' },
        { level: 'project', alias: 'helper', address: 'helper@acme', fallback: null },
      ],
      replyBounds: [{ level: 'project', seconds: 45 }],
    });
    expect(resolvedCustom.ok).toBe(true);
    if (resolvedCustom.ok) {
      expect(resolvedCustom.policy.replyBoundSeconds).toBe(45);
      expect(resolvedCustom.policy.routes.find((r) => r.alias === 'atlas')).toEqual({
        alias: 'atlas',
        address: 'lead@acme',
        fallback: 'backup@acme',
      });
      expect(resolvedCustom.policy.routes.find((r) => r.alias === 'helper')).toEqual({
        alias: 'helper',
        address: 'helper@acme',
        fallback: null,
      });
    }

    const illegalRetarget = resolveMailboxRouterPolicy({
      aliases: [{ level: 'project', alias: 'atlas', address: 'other@acme' }],
    });
    expect(illegalRetarget).toEqual({
      ok: false,
      why: 'the project level cannot retarget the entity alias atlas',
    });

    const emptyRoot = makeTempDir('mb-ind-empty-root-');
    const emptyHome = makeTempDir('mb-ind-empty-home-');
    const policyRead = readMailboxRouterPolicy(emptyRoot, emptyHome, new Date('2026-11-04T03:00:00Z'));
    expect(policyRead.ok).toBe(false);
  });
});
