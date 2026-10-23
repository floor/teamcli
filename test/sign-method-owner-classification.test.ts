// Independent tester-3 coverage of the committed action classification (builder-3 a25bd1220,
// tree e7b95a6e): which operations need authority, which are fixed fresh HIGH, how an
// administrative delegation becomes a grant-of-grant, and the one ordinary policy row that none
// may consume only through a scoped standing rule.
import { describe, expect, test } from 'bun:test';

import {
  evaluateInertOwnerAnswer, ownerActionRequirements, OWNER_KIND_CLASSES,
  type InertOwnerEvaluation, type OwnerOperation,
} from '../src/signing/owner-request.ts';
import type { SignMethod } from '../src/policy/sign-method.ts';
import {
  grantOwnerAct, owner, ownerAct, ownerContext, ownerRequest, ownerTranscript, registeredOwner,
} from './sign-method-owner-statement-fixture.ts';

const ADMIN_WORDS = ['grant', 'create', 'agree', 'leads', 'delegate', 'revoke', 'init', 'signer', 'policy', 'approve', 'approval-policy'];

function accepted(result: InertOwnerEvaluation): Extract<InertOwnerEvaluation, { ok: true }> {
  if (!result.ok) throw new Error(`expected an inert record, refused: ${result.reason}`);
  return result;
}

function requirements(operation: OwnerOperation, payload: { [key: string]: unknown } = {}) {
  return ownerActionRequirements(ownerAct({ operation, payload: payload as never }), false);
}

describe('the operation matrix', () => {
  test('ordinary acts need no authority and may take both none and always', () => {
    for (const operation of ['publish', 'spend', 'go'] as const) {
      const requirementsFor = requirements(operation, operation === 'go' ? { run_id: 'run-054' } : {});
      expect(requirementsFor, operation).toStrictEqual({
        class: OWNER_KIND_CLASSES[operation],
        authorityWrite: false,
        grantOfGrant: false,
        freshHigh: false,
        noneAllowed: true,
        alwaysAllowed: true,
      });
    }
  });

  test('authority writes need a proof but only fixed grant-of-grant work needs fresh HIGH', () => {
    const plainGrant = requirements('grant', { commands: ['send'], capabilities: ['read'] });
    expect(plainGrant).toMatchObject({ authorityWrite: true, grantOfGrant: false, freshHigh: false, noneAllowed: false, alwaysAllowed: true });

    const plainDelegate = requirements('delegate', { commands: ['send'], capabilities: ['read'] });
    expect(plainDelegate).toMatchObject({ authorityWrite: true, grantOfGrant: false, freshHigh: false, noneAllowed: false, alwaysAllowed: true });

    const revoke = requirements('revoke', { subject: 'seat-1' });
    expect(revoke).toMatchObject({ authorityWrite: true, grantOfGrant: false, freshHigh: false, noneAllowed: false, alwaysAllowed: true });

    for (const operation of ['team-create', 'signer-add', 'signer-remove'] as const) {
      const fixed = requirements(operation, {});
      expect(fixed, operation).toMatchObject({ authorityWrite: true, freshHigh: true, noneAllowed: false, alwaysAllowed: false });
    }
    expect(requirements('team-create', {})).not.toHaveProperty('grantOfGrant', true);
    expect(requirements('signer-add', {})).toMatchObject({ grantOfGrant: true });
    expect(requirements('signer-remove', {})).toMatchObject({ grantOfGrant: true });
  });

  test('a plain policy change is ordinary, while an approval policy is grant-of-grant', () => {
    expect(requirements('policy', { name: 'shared-checkout-hygiene' })).toStrictEqual({
      class: 'policy', authorityWrite: false, grantOfGrant: false, freshHigh: false, noneAllowed: true, alwaysAllowed: true,
    });
    for (const name of ['sign-method', 'owner-signers', 'approval-methods', 'approval-min-assurance',
      'approval-always-allowed', 'owner-signer-mode', 'approval-rule-ttl',
      'approval-custom', 'owner-signer-extra']) {
      expect(requirements('policy', { name }), name).toMatchObject({
        class: 'policy', authorityWrite: false, grantOfGrant: true, freshHigh: true, noneAllowed: false, alwaysAllowed: false,
      });
    }
    expect(requirements('approval-policy', { name: 'shared-checkout-hygiene' })).toMatchObject({ grantOfGrant: false });
  });
});

describe('an administrative delegation is a grant-of-grant', () => {
  test('every administrative word refuses as either a command or a capability', () => {
    for (const word of ADMIN_WORDS) {
      const asCommand = requirements('delegate', { commands: [word], capabilities: ['read'] });
      expect(asCommand, `command ${word}`).toMatchObject({ grantOfGrant: true, freshHigh: true, noneAllowed: false, alwaysAllowed: false });
      const asCapability = requirements('delegate', { commands: ['send'], capabilities: [word] });
      expect(asCapability, `capability ${word}`).toMatchObject({ grantOfGrant: true, freshHigh: true, noneAllowed: false, alwaysAllowed: false });
      const asGrant = requirements('grant', { commands: [word], capabilities: ['read'] });
      expect(asGrant, `grant ${word}`).toMatchObject({ grantOfGrant: true, freshHigh: true, alwaysAllowed: false });
    }
  });

  test('a non-null grant scope is grant-of-grant even with ordinary words', () => {
    expect(requirements('delegate', { commands: ['send'], capabilities: ['read'], grant_scope: {} }))
      .toMatchObject({ grantOfGrant: true, freshHigh: true });
    expect(requirements('delegate', { commands: ['send'], capabilities: ['read'], grant_scope: 'project' }))
      .toMatchObject({ grantOfGrant: true, freshHigh: true });
    expect(requirements('delegate', { commands: ['send'], capabilities: ['read'], grant_scope: null }))
      .toMatchObject({ grantOfGrant: false, freshHigh: false });
  });

  test('unknown or malformed authority words refuse instead of degrading to a lower assurance', () => {
    const malformed: [string, { [key: string]: unknown }][] = [
      ['missing commands', { capabilities: ['read'] }],
      ['missing capabilities', { commands: ['send'] }],
      ['non-array commands', { commands: 'send', capabilities: ['read'] }],
      ['non-string word', { commands: [1], capabilities: ['read'] }],
      ['empty word', { commands: [''], capabilities: ['read'] }],
      ['padded word', { commands: [' send'], capabilities: ['read'] }],
    ];
    for (const [label, payload] of malformed) {
      expect(() => requirements('delegate', payload), label).toThrow('owner-request.invalid-authority-words');
    }
    expect(() => requirements('delegate', { commands: ['frobnicate'], capabilities: ['read'] })).toThrow('owner-request.unknown-authority-word');
    expect(() => requirements('delegate', { commands: ['send'], capabilities: ['frobnicate'] })).toThrow('owner-request.unknown-authority-word');
    // The known vocabulary the product already gates is accepted.
    expect(requirements('delegate', { commands: ['send', 'ack'], capabilities: ['read', 'write'] }))
      .toMatchObject({ grantOfGrant: false, freshHigh: false });
    expect(requirements('delegate', { commands: [], capabilities: [] }))
      .toMatchObject({ authorityWrite: true, grantOfGrant: false, freshHigh: false });
  });
});

describe('fresh HIGH is satisfied by a device proof only', () => {
  test('a grant-of-grant, team creation and signer changes are admitted at low by touch-id and phone', () => {
    const key = owner();
    const cases = [
      ['delegate', ownerRequest({ operation: 'delegate', payload: { commands: ['grant'], capabilities: ['read'] } })],
      ['team-create', ownerRequest({ operation: 'team-create', payload: { name: 'blue' } })],
      ['signer-add', ownerRequest({ operation: 'signer-add', payload: { signer: 'owner-2' } })],
    ] as const;
    for (const [label, request] of cases) {
      expect(ownerActionRequirements(request.act, false).freshHigh, label).toBe(true);
      const transcript = ownerTranscript(request, key);
      const result = accepted(evaluateInertOwnerAnswer(request, [transcript], ownerContext(request, [registeredOwner(key)])));
      expect(result.decision, label).toBe('once');
      const phoneKey = owner();
      const phone = accepted(evaluateInertOwnerAnswer(request,
        [ownerTranscript(request, phoneKey, { signerType: 'webauthn' })],
        ownerContext(request, [registeredOwner(phoneKey, 'webauthn', 'phone')], { method: 'phone' } as { method: SignMethod })));
      expect(phone.decision, label).toBe('once');
    }
  });

  test('a self-request or a mismatched class refuses before any proof is considered', () => {
    const request = ownerRequest({ operation: 'publish' }, { selfRequest: true });
    expect(ownerActionRequirements(request.act, true)).toMatchObject({ noneAllowed: false, alwaysAllowed: false });
    expect(() => ownerActionRequirements(ownerAct({ operation: 'publish', class: 'grant' }), false)).toThrow('owner-request.class-mismatch');
    expect(() => ownerActionRequirements(ownerAct({ operation: 'publish', level: 'sideways' as never }), false)).toThrow('owner-request.invalid-act');
    expect(() => ownerActionRequirements(ownerAct(), 'yes' as never)).toThrow('owner-request.invalid-act');
    expect(() => ownerActionRequirements(grantOwnerAct(['send'], ['read']), false)).not.toThrow();
  });
});
