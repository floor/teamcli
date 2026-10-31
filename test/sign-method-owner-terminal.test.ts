// Independent tester-3 coverage of the draft-6 terminal placement exception (builder-3
// a25bd1220, tree e7b95a6e): a trusted low placement with no statement, nonce or signature,
// refused wherever high assurance is demanded.
import { describe, expect, test } from 'bun:test';

import { evaluateInertTerminal, type InertOwnerEvaluation } from '../src/signing/owner-request.ts';
import {
  owner, ownerContext, ownerRequest, registeredOwner, terminalPlacement, terminalSigner,
} from './sign-method-owner-statement-fixture.ts';

function accepted(result: InertOwnerEvaluation): Extract<InertOwnerEvaluation, { ok: true }> {
  if (!result.ok) throw new Error(`expected an inert terminal record, refused: ${result.reason}`);
  return result;
}

function expectRefusal(result: InertOwnerEvaluation, reason: string): void {
  expect(result.ok, reason).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('a trusted terminal placement', () => {
  test('records an inert once answer without a statement, nonce, challenge or signature', () => {
    const request = ownerRequest({ operation: 'publish' });
    const context = ownerContext(request, [terminalSigner()], {
      method: 'terminal', terminalPlacement: terminalPlacement(request),
    });
    const result = accepted(evaluateInertTerminal(request, context, 'terminal-owner'));
    expect(result.inert).toBe(true);
    expect(result.decision).toBe('once');
    expect(result.record.type).toBe('approval-answer');
    if (result.record.type !== 'approval-answer') throw new Error('unreachable');
    if (!('taken' in result.record)) throw new Error('unreachable');
    expect(result.record.taken).toBe('terminal');
    expect(result.record.signer).toStrictEqual({ id: 'terminal-owner', type: 'terminal' });
    expect(result.record.placement).toStrictEqual(terminalPlacement(request));
    expect(Object.keys(result.record).sort()).toStrictEqual(['placement', 'request', 'signer', 'taken', 'type']);
    expect('attestation' in result.record).toBe(false);
    expect('signature' in result.record).toBe(false);
    expect('nonce' in result.record).toBe(false);
    expect('challenge' in result.record).toBe(false);
    expect(Object.isFrozen(result.record.placement)).toBe(true);
    expect(result.nextSpentRequestIds).toStrictEqual([request.request_id]);
  });

  test('a go placement keeps the run id, and no expected nonce is needed', () => {
    const request = ownerRequest({ operation: 'go', payload: { run_id: 'run-054' } });
    const result = accepted(evaluateInertTerminal(request, ownerContext(request, [terminalSigner()], {
      method: 'terminal', expectedNonce: undefined, terminalPlacement: terminalPlacement(request),
    }), 'terminal-owner'));
    expect(result.record.type).toBe('approval');
    if (result.record.type !== 'approval') throw new Error('unreachable');
    expect(result.record.run_id).toBe('run-054');
    expect('taken' in result.record).toBe(true);
    expect('attestation' in result.record).toBe(false);
  });

  test('a placement that does not name this request and act exactly refuses', () => {
    const request = ownerRequest({ operation: 'publish' });
    const good = terminalPlacement(request);
    const placements: [string, ...unknown[]][] = [
      ['another request', { ...good, request_id: 'req-other' }],
      ['another act', { ...good, act_digest: '0'.repeat(64) }],
      ['owner false', { ...good, owner: false }],
      ['terminal false', { ...good, terminal: false }],
      ['unattended', { ...good, unattended: true }],
      ['extra key', { ...good, extra: 1 }],
    ];
    for (const [label, placement] of placements) {
      const context = ownerContext(request, [terminalSigner()], {
        method: 'terminal', terminalPlacement: placement as never,
      });
      expectRefusal(evaluateInertTerminal(request, context, 'terminal-owner'), 'owner-answer.placement');
      expect(label.length).toBeGreaterThan(0);
    }
    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [terminalSigner()], { method: 'terminal' }), 'terminal-owner'), 'owner-answer.placement');
  });

  test('only a registered terminal signer without a public key can be placed', () => {
    const request = ownerRequest({ operation: 'publish' });
    const good = { method: 'terminal' as const, terminalPlacement: terminalPlacement(request) };
    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [terminalSigner('another-terminal')], good), 'terminal-owner'), 'owner-answer.signer-policy');
    const device = owner();
    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [registeredOwner(device)], good), device.keyId), 'owner-answer.signer-policy');
    expectRefusal(evaluateInertTerminal(request, ownerContext(request, [], good), 'terminal-owner'), 'owner-answer.signer-policy');
    const withKey = { id: 'terminal-owner', type: 'terminal' as const, method: 'terminal' as const, publicKey: device.publicKey };
    expectRefusal(evaluateInertTerminal(request, ownerContext(request, [withKey], good), 'terminal-owner'), 'owner-answer.signer-policy');
  });
});

describe('the terminal placement cannot raise assurance', () => {
  test('a high demand, a fresh-HIGH act and a method without a terminal branch all refuse', () => {
    const request = ownerRequest({ operation: 'publish' });
    const placement = terminalPlacement(request);
    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [terminalSigner()], { method: 'terminal', minAssurance: 'high', terminalPlacement: placement }), 'terminal-owner'),
    'owner-answer.assurance');

    const teamCreate = ownerRequest({ operation: 'team-create', payload: { name: 'blue' } });
    expectRefusal(evaluateInertTerminal(teamCreate,
      ownerContext(teamCreate, [terminalSigner()], { method: 'terminal', terminalPlacement: terminalPlacement(teamCreate) }), 'terminal-owner'),
    'owner-answer.assurance');

    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [terminalSigner()], { method: 'touch-id', terminalPlacement: placement }), 'terminal-owner'),
    'owner-answer.method');
    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [terminalSigner()], { method: 'terminal', floor: 'phone', terminalPlacement: placement }), 'terminal-owner'),
    'owner-answer.floor');
  });

  test('an any-of terminal branch stays low, and all-mode cannot pair it with a device', () => {
    const request = ownerRequest({ operation: 'publish' });
    const placement = terminalPlacement(request);
    const context = (spec = {}) => ownerContext(request, [terminalSigner()], {
      method: 'any-of(terminal, touch-id)', terminalPlacement: placement, ...spec,
    });
    expect(accepted(evaluateInertTerminal(request, context(), 'terminal-owner')).decision).toBe('once');
    expectRefusal(evaluateInertTerminal(request, context({ minAssurance: 'high' }), 'terminal-owner'), 'owner-answer.assurance');

    const device = owner();
    expectRefusal(evaluateInertTerminal(request,
      ownerContext(request, [terminalSigner(), registeredOwner(device)], {
        method: 'terminal', signerMode: 'all', terminalPlacement: placement,
      }), 'terminal-owner'), 'owner-answer.missing-signers');
  });
});
