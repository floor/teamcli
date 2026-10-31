// Independent tester-3 coverage of the committed inert record shapes and the policy-consumer
// minimum (builder-3 a25bd1220, tree e7b95a6e): run-bound go approval, runless answer, tool-signed
// policy approval for none, and the refusal to stretch either record into the other's authority.
import { describe, expect, test } from 'bun:test';

import {
  evaluateInertNone, evaluateInertOwnerAnswer, OWNER_POLICY_DOMAIN, verifySyntheticPolicyApproval,
  type InertOwnerEvaluation,
} from '../src/signing/owner-request.ts';
import { verifySyntheticOwnerTranscript } from '../src/signing/owner-statement.ts';
import {
  frozen, independentCanonical, owner, ownerContext, ownerRequest, ownerTranscript, registeredOwner,
  verifyHex, OWNER_AT,
} from './sign-method-owner-statement-fixture.ts';

function accepted(result: InertOwnerEvaluation): Extract<InertOwnerEvaluation, { ok: true }> {
  if (!result.ok) throw new Error(`expected an inert record, refused: ${result.reason}`);
  return result;
}

/** Change the last hex nibble to a different one, whatever it was. */
function flipLastHex(hex: string): string {
  return `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
}

function expectRefusal(result: InertOwnerEvaluation, reason: string): void {
  expect(result.ok, reason).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

/** A synthetic host-owned stand-in for a verified policy declaration and its signing tool. */
function policyHost() {
  const tool = owner();
  const reference = { name: 'shared-checkout-hygiene', version: 3, declaration: { mode: 'plain' } };
  return {
    tool,
    reference,
    evaluate: (request: Parameters<typeof evaluateInertNone>[0], context: Parameters<typeof evaluateInertNone>[1], options: { verifyCurrent?: () => boolean } = {}) =>
      evaluateInertNone(request, context, {
        reference,
        verifyCurrent: options.verifyCurrent ?? (() => true),
        toolKey: tool.privateKey,
      }),
  };
}

describe('the go approval and the runless answer', () => {
  test('a go answer records the request run id, and go without a run is never a request', () => {
    const key = owner();
    const request = ownerRequest({ operation: 'go', payload: { run_id: 'run-054' } });
    const transcript = ownerTranscript(request, key);
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])));
    expect(result.decision).toBe('once');
    expect(result.record.type).toBe('approval');
    if (result.record.type !== 'approval') throw new Error('unreachable');
    expect(result.record.run_id).toBe('run-054');
    expect('attestation' in result.record).toBe(true);
    expect(Object.keys(result.record).sort()).toStrictEqual(['attestation', 'request', 'run_id', 'type']);

    expect(() => ownerRequest({ operation: 'go' })).toThrow('owner-request.missing-run');
    expect(() => ownerRequest({ operation: 'go', payload: { run_id: '  ' } })).toThrow('owner-request.missing-run');
  });

  test('a non-go answer carries no run id and invents no approval', () => {
    const key = owner();
    for (const spec of [
      { operation: 'publish' as const },
      { operation: 'spend' as const, payload: { amount: 1 } },
    ]) {
      const request = ownerRequest(spec);
      const transcript = ownerTranscript(request, key);
      const result = accepted(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])));
      expect(result.record.type).toBe('approval-answer');
      expect('run_id' in result.record).toBe(false);
      expect(Object.keys(result.record).sort()).toStrictEqual(['attestation', 'request', 'type']);
    }
  });

  test('the attestation is the one verified transcript per signer, copied not re-signed', () => {
    const key = owner();
    const request = ownerRequest({ operation: 'go', payload: { run_id: 'run-054' } });
    const transcript = ownerTranscript(request, key);
    const result = accepted(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])));
    if (result.record.type !== 'approval' || !('attestation' in result.record)) throw new Error('unreachable');
    expect(result.record.attestation).toHaveLength(1);
    expect(result.record.attestation[0]).toStrictEqual(transcript);
    expect(result.record.attestation[0]!.signature).toBe(transcript.signature);
    expect(verifySyntheticOwnerTranscript(result.record.attestation[0], key.publicKey)).toBe(true);
    expect('signature' in result.record).toBe(false);
    expect('challenge' in result.record).toBe(false);
    expect('nonce' in result.record).toBe(false);
  });
});

describe('the tool-signed policy approval for none', () => {
  test('a plain non-approval policy change produces the policy record, not an owner answer', () => {
    const request = ownerRequest({ operation: 'policy', payload: { name: 'shared-checkout-hygiene' } });
    const host = policyHost();
    const context = ownerContext(request, null, { method: 'none', floor: null });
    const result = accepted(host.evaluate(request, context));
    expect(result.inert).toBe(true);
    expect(result.decision).toBe('policy');
    expect(result.record.type).toBe('policy-approval');
    if (result.record.type !== 'policy-approval') throw new Error('unreachable');
    expect(result.record.request).toStrictEqual(request);
    expect(result.record.policy).toStrictEqual(host.reference);
    expect(Object.keys(result.record).sort()).toStrictEqual(['policy', 'request', 'signature', 'type']);
    expect('run_id' in result.record).toBe(false);
    expect('attestation' in result.record).toBe(false);
    expect(verifySyntheticPolicyApproval(result.record, host.tool.publicKey)).toBe(true);
    expect(result.nextSpentRequestIds).toStrictEqual([request.request_id]);
  });

  test('the tool signature covers the domain and the exact canonical record bytes', () => {
    const request = ownerRequest({ operation: 'publish' });
    const host = policyHost();
    const result = accepted(host.evaluate(request, ownerContext(request, null, { method: 'none' })));
    if (result.record.type !== 'policy-approval') throw new Error('unreachable');
    const unsigned = { type: 'policy-approval', request: result.record.request, policy: result.record.policy };
    const bytes = Buffer.concat([Buffer.from(OWNER_POLICY_DOMAIN, 'utf8'), Buffer.from(independentCanonical(unsigned), 'utf8')]);
    expect(verifyHex(host.tool.publicKey, bytes, result.record.signature)).toBe(true);
    expect(result.record.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  test('a none approval is refused everywhere a signature or a standing rule would be needed', () => {
    const host = policyHost();
    const requests = [
      ['grant', ownerRequest({ operation: 'grant', payload: { commands: ['send'], capabilities: ['read'] } })],
      ['delegate', ownerRequest({ operation: 'delegate', payload: { commands: ['send'], capabilities: ['read'] } })],
      ['revoke', ownerRequest({ operation: 'revoke', payload: { subject: 'seat-1' } })],
      ['team-create', ownerRequest({ operation: 'team-create', payload: { name: 'blue' } })],
      ['signer-add', ownerRequest({ operation: 'signer-add', payload: { signer: 'owner-2' } })],
      ['approval policy', ownerRequest({ operation: 'policy', payload: { name: 'approval-methods' } })],
    ] as const;
    for (const [label, request] of requests) {
      expectRefusal(host.evaluate(request, ownerContext(request, null, { method: 'none' })), 'owner-answer.none-forbidden');
      expect(label.length).toBeGreaterThan(0);
    }

    const self = ownerRequest({ operation: 'publish' }, { selfRequest: true });
    expectRefusal(host.evaluate(self, ownerContext(self, null, { method: 'none' })), 'owner-answer.none-forbidden');

    const publish = ownerRequest({ operation: 'publish' });
    expectRefusal(host.evaluate(publish, ownerContext(publish, null, { method: 'touch-id' })), 'owner-answer.none-forbidden');
    expectRefusal(host.evaluate(publish, ownerContext(publish, null, { method: 'none', floor: 'touch-id' })), 'owner-answer.none-forbidden');
    expectRefusal(host.evaluate(publish, ownerContext(publish, null, { method: 'none', minAssurance: 'high' })), 'owner-answer.none-forbidden');

    expectRefusal(host.evaluate(publish, ownerContext(publish, null, { method: 'none' }), { verifyCurrent: () => false }), 'owner-answer.policy');
    const publicKeyOnly = evaluateInertNone(publish, ownerContext(publish, null, { method: 'none' }), {
      reference: host.reference, verifyCurrent: () => true, toolKey: host.tool.publicKey,
    });
    expectRefusal(publicKeyOnly, 'owner-answer.policy');
  });

  test('policy approval verification refuses any edited byte, another key or another record type', () => {
    const request = ownerRequest({ operation: 'publish' });
    const host = policyHost();
    const result = accepted(host.evaluate(request, ownerContext(request, null, { method: 'none' })));
    if (result.record.type !== 'policy-approval') throw new Error('unreachable');
    const record = result.record;
    expect(verifySyntheticPolicyApproval(record, host.tool.publicKey)).toBe(true);
    expect(verifySyntheticPolicyApproval(record, owner().publicKey)).toBe(false);
    expect(verifySyntheticPolicyApproval(record, host.tool.privateKey)).toBe(false);
    expect(verifySyntheticPolicyApproval({ ...record, policy: { changed: true } }, host.tool.publicKey)).toBe(false);
    expect(verifySyntheticPolicyApproval({ ...record, signature: flipLastHex(record.signature) }, host.tool.publicKey)).toBe(false);
    expect(verifySyntheticPolicyApproval({ ...record, extra: 1 }, host.tool.publicKey)).toBe(false);
    expect(verifySyntheticPolicyApproval({ ...record, type: 'approval' }, host.tool.publicKey)).toBe(false);
    const otherRequest = frozen(record);
    (otherRequest.request.act as { payload: unknown }).payload = { changed: true };
    expect(verifySyntheticPolicyApproval(otherRequest, host.tool.publicKey)).toBe(false);
  });

  test('a policy approval is never accepted as an owner answer, and go keeps the policy record', () => {
    const key = owner();
    const goRequest = ownerRequest({ operation: 'go', payload: { run_id: 'run-054' } });
    const host = policyHost();
    const policy = accepted(host.evaluate(goRequest, ownerContext(goRequest, null, { method: 'none' })));
    expect(policy.decision).toBe('policy');
    expect(policy.record.type).toBe('policy-approval');
    expect('run_id' in policy.record).toBe(false);
    expect(verifySyntheticPolicyApproval(policy.record, host.tool.publicKey)).toBe(true);

    expectRefusal(evaluateInertOwnerAnswer(goRequest, [policy.record], ownerContext(goRequest, [registeredOwner(key)])), 'owner-answer.invalid');
    expect(OWNER_AT).toBe('2026-10-23T08:00:01.000Z');
  });
});
