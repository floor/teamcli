// Draft-7 delta coverage for the inert synthetic owner library: R3-1 (the whole approval
// family, grant-emission included), N1 (the challenge hashes the canonical payload, never the
// transcript), N2 (go barred from `always` until §4.2's replacement exists) and N3 (the record
// cases: `taken` only where a proof was taken, `rule` only for an auto-approval). Test-only; the
// library's exported interfaces and wire bytes stay as they are.
import { describe, expect, test } from 'bun:test';

import {
  evaluateInertNone, evaluateInertOwnerAnswer, evaluateInertTerminal, ownerActionRequirements,
  verifySyntheticPolicyApproval,
  type InertOwnerRecord, type InertOwnerRequest, type OwnerActionRequirements,
} from '../src/signing/owner-request.ts';
import {
  canonicalOwnerBytes, ownerValueHash, OWNER_STATEMENT_DOMAIN,
} from '../src/signing/owner-statement.ts';
import {
  independentCanonical, owner, ownerContext, ownerRequest, ownerTranscript,
  registeredOwner, sha256, signBytes, standingRule, terminalPlacement, terminalSigner, verifyHex,
} from './sign-method-owner-statement-fixture.ts';

// The approval family as the approvals spec's §6 registry lists it, with the two policies the
// reviewed text names beside it (`docs/projects/teamcli/specs/approvals.md` §6, `:121`).
const APPROVAL_FAMILY = [
  'sign-method', 'owner-signers', 'owner-signer-mode', 'approval-methods',
  'approval-min-assurance', 'approval-always-allowed', 'approval-rule-ttl', 'grant-emission',
] as const;

function policyRequest(name: string, operation: 'policy' | 'approval-policy' = 'approval-policy'): InertOwnerRequest {
  return ownerRequest({ operation, payload: { name } });
}

function requirementsOf(request: InertOwnerRequest): OwnerActionRequirements {
  return ownerActionRequirements(request.act, request.self_request);
}

function goRequest(): InertOwnerRequest {
  return ownerRequest({ operation: 'go', payload: { run_id: 'run-1' } });
}

/** Every object in a returned record, so a shape rule can be checked wherever a field lands. */
function objectsIn(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (value !== null && typeof value === 'object') {
    found.push(value as Record<string, unknown>);
    for (const item of Object.values(value as Record<string, unknown>)) objectsIn(item, found);
  }
  return found;
}

describe('R3-1 — the approval family is whole, grant-emission included', () => {
  for (const operation of ['policy', 'approval-policy'] as const) {
    test(`a ${operation} change to grant-emission is grant-of-grant: never none, never always`, () => {
      const requirements = requirementsOf(policyRequest('grant-emission', operation));
      expect(requirements.grantOfGrant).toBe(true);
      expect(requirements.freshHigh).toBe(true);
      expect(requirements.noneAllowed).toBe(false);
      expect(requirements.alwaysAllowed).toBe(false);
    });
  }

  test('every policy the §6 registry lists keeps the same exclusion', () => {
    for (const name of APPROVAL_FAMILY) {
      const requirements = requirementsOf(policyRequest(name));
      expect({ name, ...requirements }).toEqual({
        name, class: 'policy', authorityWrite: false, grantOfGrant: true,
        freshHigh: true, noneAllowed: false, alwaysAllowed: false,
      });
    }
  });

  test('none is refused for a grant-emission policy change, whatever the floor', () => {
    const request = policyRequest('grant-emission');
    const tool = owner();
    const outcome = evaluateInertNone(request, ownerContext(request, [registeredOwner(tool)], { method: 'none' }), {
      reference: { level: 'entity', value: 'none' }, verifyCurrent: () => true, toolKey: tool.privateKey,
    });
    expect(outcome).toEqual({ ok: false, reason: 'owner-answer.none-forbidden' });
  });

  test('a standing always answer for a grant-emission change is refused', () => {
    const request = policyRequest('grant-emission');
    const tool = owner();
    const transcript = ownerTranscript(request, tool, {
      choice: 'always',
      standingRule: standingRule({ kind: 'approval-policy', scope: { policy_name: 'grant-emission' } }),
    });
    const outcome = evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(tool)], {
      minAssurance: 'high', alwaysAllowed: true, standingRuleWithin: () => true,
    }));
    expect(outcome).toEqual({ ok: false, reason: 'owner-answer.rule-forbidden' });
  });

  test('a genuinely plain policy change is admitted to none where no floor stands', () => {
    const request = policyRequest('delivery-order', 'policy');
    const requirements = requirementsOf(request);
    expect(requirements.grantOfGrant).toBe(false);
    expect(requirements.freshHigh).toBe(false);
    expect(requirements.noneAllowed).toBe(true);
    expect(requirements.alwaysAllowed).toBe(true);
    const tool = owner();
    const outcome = evaluateInertNone(request, ownerContext(request, [registeredOwner(tool)], { method: 'none' }), {
      reference: { level: 'entity', value: 'none' }, verifyCurrent: () => true, toolKey: tool.privateKey,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision).toBe('policy');
    expect(outcome.record.type).toBe('policy-approval');
  });

  test('a validly signed none record for a grant-emission change fails the verifier', () => {
    const request = policyRequest('grant-emission');
    const tool = owner();
    const unsigned = { type: 'policy-approval', request, policy: { level: 'entity', value: 'none' } };
    const signature = Buffer.from(signBytes(tool.privateKey,
      Buffer.concat([Buffer.from('team-policy-approval-synthetic-v1\n'), canonicalOwnerBytes(unsigned)])), 'base64').toString('hex');
    expect(verifySyntheticPolicyApproval({ ...unsigned, signature }, tool.publicKey)).toBe(false);
  });

  test('the same hand-signed record verifies for a plain policy change', () => {
    const request = policyRequest('delivery-order', 'policy');
    const tool = owner();
    const unsigned = { type: 'policy-approval', request, policy: { level: 'entity', value: 'none' } };
    const signature = Buffer.from(signBytes(tool.privateKey,
      Buffer.concat([Buffer.from('team-policy-approval-synthetic-v1\n'), canonicalOwnerBytes(unsigned)])), 'base64').toString('hex');
    expect(verifySyntheticPolicyApproval({ ...unsigned, signature }, tool.publicKey)).toBe(true);
  });
});

describe('N1 — the challenge hashes the canonical payload, never the transcript', () => {
  test('the challenge is SHA-256 of the canonical payload, recomputed independently', () => {
    const transcript = ownerTranscript(ownerRequest(), owner());
    const payload = transcript.statement;
    expect(transcript.challenge).toBe(sha256(independentCanonical(payload)));
    expect(transcript.challenge).toBe(ownerValueHash(payload));
    expect(Object.keys(payload).sort()).toEqual([
      'act_digest', 'choice', 'format', 'nonce', 'params_hash', 'request_id',
      'signer_id', 'signer_type', 'standing_rule', 'time',
    ]);
    for (const selfField of ['challenge', 'signature', 'hash']) expect(Object.hasOwn(payload, selfField)).toBe(false);
  });

  test('the challenge is not the hash of the signed transcript or of its parts', () => {
    const request = ownerRequest();
    const tool = owner();
    const transcript = ownerTranscript(request, tool);
    expect(sha256(independentCanonical(transcript))).not.toBe(transcript.challenge);
    expect(sha256(independentCanonical({ statement: transcript.statement, signature: transcript.signature })))
      .not.toBe(transcript.challenge);
    expect(ownerValueHash({ ...transcript.statement, challenge: transcript.challenge })).not.toBe(transcript.challenge);
  });

  test('the nonce is inside the hashed payload; changing it changes the challenge', () => {
    const request = ownerRequest();
    const tool = owner();
    const first = ownerTranscript(request, tool, { nonce: 'ab'.repeat(32) });
    const second = ownerTranscript(request, tool, { nonce: 'cd'.repeat(32) });
    expect(first.challenge).not.toBe(second.challenge);
    expect(ownerValueHash({ ...first.statement, nonce: second.statement.nonce })).toBe(second.challenge);
  });

  test('the signature covers the domain-prefixed challenge; the challenge hash itself has no domain', () => {
    const request = ownerRequest();
    const tool = owner();
    const transcript = ownerTranscript(request, tool);
    const payloadBytes = Buffer.from(independentCanonical(transcript.statement), 'utf8');
    expect(sha256(Buffer.concat([Buffer.from(OWNER_STATEMENT_DOMAIN, 'utf8'), payloadBytes]))).not.toBe(transcript.challenge);
    expect(verifyHex(tool.publicKey,
      Buffer.concat([Buffer.from(OWNER_STATEMENT_DOMAIN, 'utf8'), Buffer.from(transcript.challenge, 'hex')]), transcript.signature)).toBe(true);
  });
});

describe('N2 — go is barred from always until §4.2 replacement', () => {
  test('requirements bar always for go and keep none as the ordinary row allows', () => {
    const requirements = requirementsOf(goRequest());
    expect(requirements.alwaysAllowed).toBe(false);
    expect(requirements.noneAllowed).toBe(true);
    expect(requirements.freshHigh).toBe(false);
    expect(requirements.authorityWrite).toBe(false);
    expect(requirements.grantOfGrant).toBe(false);
  });

  test('a signed always answer for go is refused even with permission and containment on', () => {
    const request = goRequest();
    const tool = owner();
    const transcript = ownerTranscript(request, tool, { choice: 'always', standingRule: standingRule({ kind: 'go' }) });
    const outcome = evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(tool)], {
      alwaysAllowed: true, standingRuleWithin: () => true,
    }));
    expect(outcome).toEqual({ ok: false, reason: 'owner-answer.rule-forbidden' });
  });

  test('go once still yields amendment 04s approval record with its run', () => {
    const request = goRequest();
    const tool = owner();
    const transcript = ownerTranscript(request, tool);
    const outcome = evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(tool)]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision).toBe('once');
    expect(outcome.record.type).toBe('approval');
    expect(outcome.record).toMatchObject({ run_id: 'run-1' });
    if (outcome.record.type !== 'approval' || !('attestation' in outcome.record)) throw new Error('unreachable');
    expect(outcome.record.attestation).toHaveLength(1);
  });

  test('publish always remains offered where the policy permits it', () => {
    const request = ownerRequest({ operation: 'publish' });
    const tool = owner();
    const transcript = ownerTranscript(request, tool, { choice: 'always', standingRule: standingRule({ kind: 'publish' }) });
    const outcome = evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(tool)], {
      alwaysAllowed: true, standingRuleWithin: () => true,
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision).toBe('always');
    expect(outcome.record.type).toBe('approval-answer');
  });
});

describe('N3 — taken only where a proof was taken, rule only for an auto-approval', () => {
  test('the none record carries neither taken, rule nor attestation', () => {
    const request = ownerRequest({ operation: 'publish' });
    const tool = owner();
    const outcome = evaluateInertNone(request, ownerContext(request, [registeredOwner(tool)], { method: 'none' }), {
      reference: { level: 'team', value: 'none' }, verifyCurrent: () => true, toolKey: tool.privateKey,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.record).sort()).toEqual(['policy', 'request', 'signature', 'type']);
  });

  test('a fresh signed answer names no rule', () => {
    const request = ownerRequest({ operation: 'publish' });
    const tool = owner();
    const outcome = evaluateInertOwnerAnswer(request, [ownerTranscript(request, tool)], ownerContext(request, [registeredOwner(tool)]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.record).sort()).toEqual(['attestation', 'request', 'type']);
  });

  test('a terminal record takes terminal with its placement and no attestation', () => {
    const request = ownerRequest({ operation: 'publish' });
    const outcome = evaluateInertTerminal(request, ownerContext(request, [terminalSigner()], {
      method: 'terminal', terminalPlacement: terminalPlacement(request),
    }), 'terminal-owner');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record).toMatchObject({ type: 'approval-answer', taken: 'terminal' });
    expect(Object.keys(outcome.record).sort()).toEqual(['placement', 'request', 'signer', 'taken', 'type']);
    expect(Object.hasOwn(outcome.record, 'attestation')).toBe(false);
    expect(Object.hasOwn(outcome.record, 'rule')).toBe(false);
  });

  test('no returned record both names a rule and claims a taken proof', () => {
    const tool = owner();
    const publish = ownerRequest({ operation: 'publish' });
    const signed = evaluateInertOwnerAnswer(publish, [ownerTranscript(publish, tool)], ownerContext(publish, [registeredOwner(tool)]));
    const noneRequest = ownerRequest({ operation: 'publish' });
    const none = evaluateInertNone(noneRequest, ownerContext(noneRequest, [registeredOwner(tool)], { method: 'none' }), {
      reference: { level: 'team', value: 'none' }, verifyCurrent: () => true, toolKey: tool.privateKey,
    });
    const terminalRequest = ownerRequest({ operation: 'publish' });
    const terminal = evaluateInertTerminal(terminalRequest, ownerContext(terminalRequest, [terminalSigner()], {
      method: 'terminal', terminalPlacement: terminalPlacement(terminalRequest),
    }), 'terminal-owner');
    const records: InertOwnerRecord[] = [];
    for (const outcome of [signed, none, terminal]) {
      expect(outcome.ok).toBe(true);
      if (outcome.ok) records.push(outcome.record);
    }
    expect(records).toHaveLength(3);
    for (const record of records) {
      for (const object of objectsIn(record)) {
        expect(Object.hasOwn(object, 'rule') && Object.hasOwn(object, 'taken')).toBe(false);
      }
    }
  });
});
