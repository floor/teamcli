// Independent tester-3 coverage of the committed synthetic owner-statement wire
// (builder-3 2543c1072, tree 612c6a49): canonical payload, challenge-before-signature binding,
// one signature, and request identity. Tests only; no production code is imported for editing.
import { describe, expect, test } from 'bun:test';

import {
  canonicalOwnerBytes, ownerStatementChallenge, ownerValueHash, signSyntheticOwnerStatement,
  validOwnerStatement, verifySyntheticOwnerTranscript,
  OWNER_STATEMENT_DOMAIN, OWNER_TRANSCRIPT_FORMAT,
} from '../src/signing/owner-statement.ts';
import { validInertOwnerRequest, evaluateInertOwnerAnswer } from '../src/signing/owner-request.ts';
import {
  independentCanonical, frozen, owner, ownerContext, ownerRequest, ownerStatement, ownerTranscript,
  registeredOwner, sha256, standingRule, verifyHex, OWNER_NONCE,
} from './sign-method-owner-statement-fixture.ts';

/** Change the last hex nibble to a different one, whatever it was. */
function flipLastHex(hex: string): string {
  return `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
}

describe('canonical owner payload bytes', () => {
  test('are sorted, dense UTF-8 JSON and match an independently written encoder', () => {
    const value = { z: 1, a: [true, null, 'é'], m: { b: 2, a: 1 } };
    expect(canonicalOwnerBytes(value).toString('utf8')).toBe(independentCanonical(value));
    expect(ownerValueHash(value)).toBe(sha256(independentCanonical(value)));
    expect(canonicalOwnerBytes({ a: 1, b: 2 }).equals(canonicalOwnerBytes({ b: 2, a: 1 }))).toBe(true);
    expect(canonicalOwnerBytes({ text: 'é' }).toString('utf8')).toBe('{"text":"é"}');
  });

  test('refuse shapes JSON would silently rewrite, rather than signing a lossy payload', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const extraArrayProperty: unknown[] & { extra?: number } = [1];
    extraArrayProperty.extra = 2;
    const accessor = Object.defineProperty({}, 'a', { get: () => 1, enumerable: true });
    let deep: unknown = 1;
    for (let index = 0; index < 40; index += 1) deep = { next: deep };
    const cases: [string, unknown][] = [
      ['undefined', { a: undefined }],
      ['negative zero', { a: -0 }],
      ['not a number', { a: Number.NaN }],
      ['infinite', { a: Number.POSITIVE_INFINITY }],
      ['unsafe integer', { a: Number.MAX_SAFE_INTEGER + 1 }],
      ['function', { a: () => 1 }],
      ['accessor', accessor],
      ['cycle', cyclic],
      ['extra array property', extraArrayProperty],
      ['non-plain object', new Map([['a', 1]])],
      ['too deep', deep],
    ];
    for (const [label, value] of cases) {
      expect(() => canonicalOwnerBytes(value), label).toThrow('owner-wire.invalid-json');
    }
  });

  test('accept a null-prototype record as a plain object', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 });
    expect(canonicalOwnerBytes(value).toString('utf8')).toBe('{"a":1,"b":2}');
  });
});

describe('the one statement payload', () => {
  test('carries exactly the wire fields, with an explicit null rule and no challenge or hash', () => {
    const request = ownerRequest();
    const key = owner();
    const statement = ownerStatement(request, key);
    expect(Object.keys(statement).sort()).toStrictEqual([
      'act_digest', 'choice', 'format', 'nonce', 'params_hash', 'request_id',
      'signer_id', 'signer_type', 'standing_rule', 'time',
    ]);
    expect(statement.standing_rule).toBeNull();
    expect('challenge' in statement).toBe(false);
    expect('hash' in statement).toBe(false);
    const challenge = ownerStatementChallenge(statement);
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalOwnerBytes(statement).toString('utf8')).not.toContain(challenge);
    expect(validOwnerStatement({ ...statement, challenge })).toBe(false);
    expect(validOwnerStatement({ ...statement, hash: challenge })).toBe(false);
    expect(validOwnerStatement({ ...statement, extra: 1 })).toBe(false);
    const { nonce: _nonce, ...missingNonce } = statement;
    expect(validOwnerStatement(missingNonce)).toBe(false);
  });

  test('hashes the complete canonical payload with the nonce inside', () => {
    const request = ownerRequest();
    const key = owner();
    const first = ownerStatement(request, key, { nonce: 'ab'.repeat(32) });
    const second = ownerStatement(request, key, { nonce: 'cd'.repeat(32) });
    expect(ownerStatementChallenge(first)).toBe(ownerValueHash(first));
    // Independent computation: same bytes, same SHA-256, no domain prefix.
    expect(ownerStatementChallenge(first)).toBe(sha256(independentCanonical(first)));
    expect(ownerStatementChallenge(first)).not.toBe(ownerStatementChallenge(second));
    expect(OWNER_NONCE).toMatch(/^[0-9a-f]{64}$/);
  });

  test('requires a rule only for always, and an expiry after the statement time', () => {
    const request = ownerRequest();
    const key = owner();
    expect(() => ownerStatement(request, key, { choice: 'once', standingRule: standingRule() }))
      .toThrow('owner-wire.invalid-statement');
    expect(() => ownerStatement(request, key, { choice: 'deny', standingRule: standingRule() }))
      .toThrow('owner-wire.invalid-statement');
    expect(() => ownerStatement(request, key, { choice: 'always', standingRule: null }))
      .toThrow('owner-wire.invalid-statement');
    expect(() => ownerStatement(request, key, {
      choice: 'always', standingRule: standingRule({ expires_at: '2026-10-23T08:00:01.000Z' }),
    })).toThrow('owner-wire.invalid-statement');
    const always = ownerStatement(request, key, { choice: 'always', standingRule: standingRule() });
    expect(validOwnerStatement(always)).toBe(true);
  });
});

describe('the single synthetic signature', () => {
  test('signs domain plus the decoded challenge bytes, once', () => {
    const request = ownerRequest();
    const key = owner();
    const transcript = ownerTranscript(request, key);
    expect(verifySyntheticOwnerTranscript(transcript, key.publicKey)).toBe(true);
    const input = Buffer.concat([
      Buffer.from(OWNER_STATEMENT_DOMAIN, 'utf8'),
      Buffer.from(transcript.challenge, 'hex'),
    ]);
    expect(verifyHex(key.publicKey, input, transcript.signature)).toBe(true);
    expect(transcript.format).toBe(OWNER_TRANSCRIPT_FORMAT);
    expect(transcript.scheme).toBe('synthetic-ed25519');
    expect(transcript.challenge).toBe(ownerStatementChallenge(transcript.statement));
    expect(transcript.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(Object.keys(transcript).sort()).toStrictEqual(['challenge', 'format', 'scheme', 'signature', 'statement']);
    expect(transcript.statement).toStrictEqual(ownerStatement(request, key));
    expect(transcript.statement).not.toBe(ownerStatement(request, key));
    expect(Object.isFrozen(transcript)).toBe(true);
    expect(Object.isFrozen(transcript.statement)).toBe(true);
  });

  test('one signature binds every payload field: a changed field fails even with a recomputed challenge', () => {
    const request = ownerRequest();
    const key = owner();
    const signed = ownerTranscript(request, key);
    const recompute = (statement: typeof signed.statement) => ({
      ...signed,
      statement,
      challenge: ownerStatementChallenge(statement),
    });
    const validTamper = (patch: Partial<typeof signed.statement>) => recompute({ ...signed.statement, ...patch });
    const cases: [string, ReturnType<typeof recompute>][] = [
      ['choice', validTamper({ choice: 'deny' })],
      ['nonce', validTamper({ nonce: 'ef'.repeat(32) })],
      ['act digest', validTamper({ act_digest: '0'.repeat(64) })],
      ['parameter hash', validTamper({ params_hash: '0'.repeat(64) })],
      ['request id', validTamper({ request_id: 'req-other' })],
      ['signer id', validTamper({ signer_id: 'other-owner' })],
      ['signer type', validTamper({ signer_type: 'webauthn' })],
      ['time', validTamper({ time: '2026-10-23T08:00:02.000Z' })],
    ];
    for (const [label, tampered] of cases) {
      expect(verifySyntheticOwnerTranscript(tampered, key.publicKey), label).toBe(false);
    }

    const always = ownerTranscript(request, key, { choice: 'always', standingRule: standingRule() });
    const changedRule = recompute({ ...always.statement, standing_rule: standingRule({ bounds: { count: 2 } }) });
    expect(verifySyntheticOwnerTranscript(changedRule, key.publicKey)).toBe(false);

    expect(verifySyntheticOwnerTranscript(signed, owner().publicKey)).toBe(false);
    expect(verifySyntheticOwnerTranscript({ ...signed, signature: flipLastHex(signed.signature) }, key.publicKey)).toBe(false);
    expect(verifySyntheticOwnerTranscript({ ...signed, challenge: '0'.repeat(64) }, key.publicKey)).toBe(false);
    expect(verifySyntheticOwnerTranscript({ ...signed, extra: 1 }, key.publicKey)).toBe(false);
    expect(verifySyntheticOwnerTranscript({ ...signed, scheme: 'synthetic-rsa' }, key.publicKey)).toBe(false);
  });
});

describe('the inert request binds its bytes', () => {
  test('hashes the payload and the complete request, with an exact fifteen-minute life', () => {
    const request = ownerRequest();
    expect(validInertOwnerRequest(request)).toBe(true);
    expect(Date.parse(request.expires_at) - Date.parse(request.created)).toBe(15 * 60_000);
    expect(request.params_hash).toBe(ownerValueHash(request.act.payload));
    expect(ownerValueHash(request)).toBe(ownerValueHash(frozen(request)));
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.act)).toBe(true);
  });

  test('a changed payload, time, id or requester changes what the trusted hash covers', () => {
    const request = ownerRequest();
    const payload = frozen(request);
    (payload.act as { payload: { [key: string]: unknown } }).payload = { other: 1 };
    expect(validInertOwnerRequest(payload)).toBe(false);

    const short = frozen(request);
    short.expires_at = '2026-10-23T08:14:59.999Z';
    expect(validInertOwnerRequest(short)).toBe(false);

    const wrongId = frozen(request);
    wrongId.request_id = 'req-other';
    expect(validInertOwnerRequest(wrongId)).toBe(false);

    const requester = frozen(request);
    requester.requester = 'forged-seat';
    const state = frozen(request);
    (state.act as { input_state: unknown }).input_state = { state: 'two' };
    for (const forged of [requester, state]) {
      expect(ownerValueHash(forged)).not.toBe(ownerValueHash(request));
    }
  });

  test('a statement signed for one request refuses against another request', () => {
    const key = owner();
    const first = ownerRequest();
    const second = ownerRequest();
    const transcript = ownerTranscript(first, key);
    const refused = evaluateInertOwnerAnswer(second, [transcript], ownerContext(second, [registeredOwner(key)]));
    expect(refused).toMatchObject({ ok: false, reason: 'owner-answer.binding' });
  });
});
