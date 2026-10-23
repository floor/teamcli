// Independent tester-3 coverage of the committed inert owner-answer evaluation
// (builder-3 a25bd1220, tree e7b95a6e): tamper invalidation, freshness and single use,
// floor and assurance ordering, all-of agreement, and the no once-to-always rule.
import { describe, expect, test } from 'bun:test';

import type { SignMethod } from '../src/policy/sign-method.ts';
import { evaluateInertOwnerAnswer, type InertOwnerEvaluation } from '../src/signing/owner-request.ts';
import { ownerStatementChallenge, signSyntheticOwnerStatement } from '../src/signing/owner-statement.ts';
import {
  owner, ownerContext, ownerRequest, ownerStatement, ownerTranscript, registeredOwner, standingRule,
  OWNER_AT, OWNER_NONCE,
} from './sign-method-owner-statement-fixture.ts';

function accepted(result: InertOwnerEvaluation): Extract<InertOwnerEvaluation, { ok: true }> {
  if (!result.ok) throw new Error(`expected an inert answer, refused: ${result.reason}`);
  return result;
}

function expectRefusal(result: InertOwnerEvaluation, reason: string): void {
  expect(result.ok, reason).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('a verified inert answer', () => {
  test('returns once, the answer record and the in-memory spent transition', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])));
    expect(result.inert).toBe(true);
    expect(result.decision).toBe('once');
    expect(result.record.type).toBe('approval-answer');
    if (result.record.type !== 'approval-answer' || !('attestation' in result.record)) throw new Error('unreachable');
    expect(result.record.attestation).toHaveLength(1);
    expect(result.record.attestation[0]!.signature).toBe(transcript.signature);
    expect(result.record.attestation[0]!.challenge).toBe(transcript.challenge);
    expect('run_id' in result.record).toBe(false);
    expect(result.nextSpentRequestIds).toStrictEqual([request.request_id]);
  });

  test('a deny is verified, records its choice, and approves nothing', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key, { choice: 'deny' });
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])));
    expect(result.decision).toBe('deny');
    expect(result.record.type).toBe('approval-answer');
    if (result.record.type !== 'approval-answer') throw new Error('unreachable');
    expect('standing_rule' in result.record).toBe(false);
    expect(result.nextSpentRequestIds).toStrictEqual([request.request_id]);
  });

  test('appends to the injected spent ids without dropping them', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, [registeredOwner(key)], { spentRequestIds: ['older-request'] })));
    expect(result.nextSpentRequestIds).toStrictEqual(['older-request', request.request_id]);
  });
});

describe('a tampered statement', () => {
  test('fails the one signature even when the challenge is recomputed', () => {
    const key = owner();
    const request = ownerRequest();
    const signed = ownerTranscript(request, key);
    const reChallenge = (patch: Partial<typeof signed.statement>) => {
      const statement = { ...signed.statement, ...patch };
      return { ...signed, statement, challenge: ownerStatementChallenge(statement) };
    };
    const cases: [string, ReturnType<typeof reChallenge>][] = [
      ['choice', reChallenge({ choice: 'deny' })],
      ['nonce', reChallenge({ nonce: 'ef'.repeat(32) })],
      ['act digest', reChallenge({ act_digest: '0'.repeat(64) })],
      ['parameter hash', reChallenge({ params_hash: '0'.repeat(64) })],
      ['request id', reChallenge({ request_id: 'req-other' })],
      ['time', reChallenge({ time: '2026-10-23T08:00:02.000Z' })],
    ];
    for (const [label, tampered] of cases) {
      expectRefusal(evaluateInertOwnerAnswer(request, [tampered], ownerContext(request, [registeredOwner(key)])), 'owner-answer.signature');
      expect(label.length).toBeGreaterThan(0);
    }

    const always = ownerTranscript(request, key, { choice: 'always', standingRule: standingRule() });
    const statement = { ...always.statement, standing_rule: standingRule({ bounds: { count: 7 } }) };
    const changedRule = { ...always, statement, challenge: ownerStatementChallenge(statement) };
    expectRefusal(evaluateInertOwnerAnswer(request, [changedRule], ownerContext(request, [registeredOwner(key)])), 'owner-answer.signature');
  });

  test('a fresh signature over the wrong request, act digest or parameter hash fails the binding', () => {
    const key = owner();
    const request = ownerRequest();
    const signAs = (patch: Partial<ReturnType<typeof ownerStatement>>) =>
      signSyntheticOwnerStatement({ ...ownerStatement(request, key), ...patch }, key.privateKey);
    for (const [label, transcript] of [
      ['act digest', signAs({ act_digest: '0'.repeat(64) })],
      ['parameter hash', signAs({ params_hash: '0'.repeat(64) })],
      ['request id', signAs({ request_id: 'req-other' })],
    ] as const) {
      expectRefusal(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])), 'owner-answer.binding');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('a changed current input state invalidates the answer', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const changed = { ...request.act, input_state: { state: 'two' } };
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, [registeredOwner(key)], { currentAct: changed })), 'owner-request.changed-act');
  });
});

describe('freshness, lifetime and single use', () => {
  test('a proof older than thirty seconds or more than five seconds in the future refuses', () => {
    const key = owner();
    const request = ownerRequest();
    const signers = [registeredOwner(key)];
    const late = ownerTranscript(request, key, { time: '2026-10-23T08:00:01.000Z' });
    expectRefusal(evaluateInertOwnerAnswer(request, [late],
      ownerContext(request, signers, { now: new Date('2026-10-23T08:00:31.001Z') })), 'owner-answer.stale');
    expect(accepted(evaluateInertOwnerAnswer(request, [late],
      ownerContext(request, signers, { now: new Date('2026-10-23T08:00:31.000Z') }))).decision).toBe('once');

    const future = ownerTranscript(request, key, { time: '2026-10-23T08:00:07.000Z' });
    expectRefusal(evaluateInertOwnerAnswer(request, [future], ownerContext(request, signers)), 'owner-answer.stale');

    const withinSkew = ownerTranscript(request, key, { time: '2026-10-23T08:00:05.000Z' });
    expect(accepted(evaluateInertOwnerAnswer(request, [withinSkew], ownerContext(request, signers))).decision).toBe('once');
  });

  test('a request at or past its fifteen-minute expiry, or created in the future, refuses', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const signers = [registeredOwner(key)];
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { now: new Date('2026-10-23T08:15:00.000Z') })), 'owner-request.expired');

    const futureRequest = ownerRequest({}, { now: new Date('2026-10-23T08:00:10.000Z') });
    const futureTranscript = ownerTranscript(futureRequest, key);
    expectRefusal(evaluateInertOwnerAnswer(futureRequest, [futureTranscript], ownerContext(futureRequest, signers)), 'owner-request.expired');
  });

  test('a spent id refuses a replay, and an unverified or malformed trusted hash refuses', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const signers = [registeredOwner(key)];
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { spentRequestIds: [request.request_id] })), 'owner-request.spent');
    for (const hash of ['', 'not-a-hash', 'f'.repeat(63)]) {
      expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
        ownerContext(request, signers, { verifiedRequestHash: hash })), 'owner-request.unverified');
    }
  });
});

describe('signer membership and method', () => {
  test('a missing, empty, duplicated or mismatched signer policy refuses', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key, { signerType: 'webauthn' });
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, null)), 'owner-answer.signer-policy');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [])), 'owner-answer.signer-policy');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, [registeredOwner(key), registeredOwner(key)])), 'owner-answer.signer-policy');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, [registeredOwner(key, 'mac-keystore', 'phone')])), 'owner-answer.signer-policy');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, [{ id: key.keyId, type: 'terminal', method: 'terminal', publicKey: key.publicKey }])), 'owner-answer.signer-policy');
    const honest = ownerTranscript(request, key);
    expectRefusal(evaluateInertOwnerAnswer(request, [honest, honest], ownerContext(request, [registeredOwner(key)])), 'owner-answer.signer-policy');
  });

  test('a method outside the vocabulary, a floor the method misses, and none-with-a-signature refuse', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const signers = [registeredOwner(key)];
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { method: 'touchid' as SignMethod })), 'owner-answer.floor');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { floor: 'nonee' as SignMethod })), 'owner-answer.floor');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { floor: 'phone' })), 'owner-answer.floor');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, signers, { method: 'none' })), 'owner-answer.proof-required');
    expectRefusal(evaluateInertOwnerAnswer(request, [], ownerContext(request, signers)), 'owner-answer.missing');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { method: 'terminal' })), 'owner-answer.method');
  });

  test('an any-of proof is admitted, but a terminal branch keeps its low assurance', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const signers = [registeredOwner(key)];
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { method: 'any-of(terminal, touch-id)' })));
    expect(result.decision).toBe('once');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { method: 'any-of(terminal, touch-id)', minAssurance: 'high' })), 'owner-answer.assurance');
  });

  test('an all-of needs every signer, agreeing on the common decision', () => {
    const first = owner();
    const second = owner();
    const request = ownerRequest();
    const signers = [registeredOwner(first), registeredOwner(second, 'webauthn', 'phone')];
    const context = (spec = {}) => ownerContext(request, signers, {
      method: 'all-of(touch-id, phone)', signerMode: 'all', ...spec,
    });
    const one = ownerTranscript(request, first);
    const two = ownerTranscript(request, second, { signerType: 'webauthn' });
    const result = accepted(evaluateInertOwnerAnswer(request, [one, two], context()));
    expect(result.decision).toBe('once');
    if (result.record.type !== 'approval-answer' || !('attestation' in result.record)) throw new Error('unreachable');
    expect(result.record.attestation).toHaveLength(2);
    expect(result.record.attestation.map((entry) => entry.signature).sort())
      .toStrictEqual([one.signature, two.signature].sort());

    expectRefusal(evaluateInertOwnerAnswer(request, [one], context()), 'owner-answer.missing-signers');

    const disagree = ownerTranscript(request, second, { signerType: 'webauthn', choice: 'deny' });
    expectRefusal(evaluateInertOwnerAnswer(request, [one, disagree], context()), 'owner-answer.disagreement');

    const ruleOne = ownerTranscript(request, first, { choice: 'always', standingRule: standingRule({ kind: 'publish' }) });
    const ruleTwo = ownerTranscript(request, second, { signerType: 'webauthn', choice: 'always', standingRule: standingRule({ kind: 'publish', bounds: { count: 2 } }) });
    expectRefusal(evaluateInertOwnerAnswer(request, [ruleOne, ruleTwo],
      context({ alwaysAllowed: true, standingRuleWithin: () => true })), 'owner-answer.disagreement');
  });
});

describe('no once-to-always upgrade', () => {
  const alwaysContext = (overrides = {}) => ({ alwaysAllowed: true, standingRuleWithin: () => true, ...overrides });

  test('a once answer stays once even where a rule would be admitted', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key, { choice: 'once' });
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, [registeredOwner(key)], alwaysContext())));
    expect(result.decision).toBe('once');
    expect('standing_rule' in result.record).toBe(false);
  });

  test('always needs current permission, a matching kind, a live expiry and a contained scope', () => {
    const key = owner();
    const request = ownerRequest();
    const signers = [registeredOwner(key)];
    const rule = standingRule({ kind: 'publish' });
    const transcript = ownerTranscript(request, key, { choice: 'always', standingRule: rule });
    const admit = accepted(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, alwaysContext())));
    expect(admit.decision).toBe('always');

    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, alwaysContext({ alwaysAllowed: false }))), 'owner-answer.rule-forbidden');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, { alwaysAllowed: true })), 'owner-answer.rule-forbidden');
    expectRefusal(evaluateInertOwnerAnswer(request, [transcript],
      ownerContext(request, signers, alwaysContext({ standingRuleWithin: () => false }))), 'owner-answer.rule-forbidden');

    const wrongKind = ownerTranscript(request, key, { choice: 'always', standingRule: standingRule({ kind: 'spend' }) });
    expectRefusal(evaluateInertOwnerAnswer(request, [wrongKind],
      ownerContext(request, signers, alwaysContext())), 'owner-answer.rule-forbidden');

    const shortRule = ownerTranscript(request, key, {
      choice: 'always', standingRule: standingRule({ kind: 'publish', expires_at: '2026-10-23T08:00:01.500Z' }),
    });
    expectRefusal(evaluateInertOwnerAnswer(request, [shortRule],
      ownerContext(request, signers, alwaysContext({ now: new Date('2026-10-23T08:00:02.000Z') }))), 'owner-answer.rule-forbidden');
  });

  test('a self-request or a grant-of-grant never takes always', () => {
    const key = owner();
    const signers = [registeredOwner(key)];
    const self = ownerRequest({}, { selfRequest: true });
    const selfTranscript = ownerTranscript(self, key, { choice: 'always', standingRule: standingRule({ kind: 'publish' }) });
    expectRefusal(evaluateInertOwnerAnswer(self, [selfTranscript],
      ownerContext(self, signers, alwaysContext())), 'owner-answer.rule-forbidden');

    const delegated = ownerRequest({ operation: 'delegate', payload: { commands: ['grant'], capabilities: ['read'] } });
    const delegatedTranscript = ownerTranscript(delegated, key, { choice: 'always', standingRule: standingRule({ kind: 'delegate' }) });
    expectRefusal(evaluateInertOwnerAnswer(delegated, [delegatedTranscript],
      ownerContext(delegated, signers, alwaysContext())), 'owner-answer.rule-forbidden');
  });

  test('a policy rule must name the exact policy in its scope', () => {
    const key = owner();
    const signers = [registeredOwner(key)];
    const request = ownerRequest({ operation: 'policy', payload: { name: 'shared-checkout-hygiene' } });
    const scoped = standingRule({ kind: 'policy', scope: { policy_name: 'shared-checkout-hygiene' } });
    const wrong = standingRule({ kind: 'policy', scope: { policy_name: 'pane-conduct' } });
    const right = ownerTranscript(request, key, { choice: 'always', standingRule: scoped });
    expect(accepted(evaluateInertOwnerAnswer(request, [right],
      ownerContext(request, signers, alwaysContext()))).decision).toBe('always');
    const refused = ownerTranscript(request, key, { choice: 'always', standingRule: wrong });
    expectRefusal(evaluateInertOwnerAnswer(request, [refused],
      ownerContext(request, signers, alwaysContext())), 'owner-answer.rule-scope');
  });

  test('context fields outside their domain refuse instead of being coerced', () => {
    const key = owner();
    const request = ownerRequest();
    const transcript = ownerTranscript(request, key);
    const signers = [registeredOwner(key)];
    for (const spec of [
      { minAssurance: 'medium' as never },
      { signerMode: 'each' as never },
      { alwaysAllowed: 'yes' as never },
    ]) {
      expectRefusal(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, signers, spec)), 'owner-answer.invalid-context');
    }
    expect(OWNER_AT).toBe('2026-10-23T08:00:01.000Z');
    expect(OWNER_NONCE).toHaveLength(64);
  });
});
