// Inert, synthetic request/answer evaluation. This module has no filesystem, CLI, enrollment,
// production signer or authority-effect dependency. Its output is NOT an execution permit.
import { sign, verify, type KeyObject } from 'node:crypto';
import { COMMAND_GATES } from '../permissions/map.ts';
import { GRANT_CAPABILITIES, TEAM_GRANT_FORBIDDEN } from '../permissions/grants.ts';
import { signMethodAlternatives, signMethodSatisfies, parseSignMethodValue, type SignMethod, type SignProof } from '../policy/sign-method.ts';
import type { Json } from '../store/keys.ts';
import {
  canonicalOwnerBytes, ownerExactKeys, ownerHash, ownerId, ownerObject, ownerSnapshot,
  ownerTime, ownerValueHash, validOwnerStatement,
  verifySyntheticOwnerTranscript, OWNER_PROOF_MAX_AGE_MS, OWNER_PROOF_FUTURE_SKEW_MS,
  OWNER_STATEMENT_FORMAT, type OwnerDecision, type OwnerSignerType, type OwnerStandingRule,
  type OwnerStatement, type OwnerTranscript,
} from './owner-statement.ts';

export const OWNER_REQUEST_FORMAT = 'team-owner-request-v1';
export const OWNER_REQUEST_TTL_MS = 15 * 60_000;
export const OWNER_POLICY_DOMAIN = 'team-policy-approval-synthetic-v1\n';
export const OWNER_CLASSES = ['grant', 'revoke', 'create', 'publish', 'spend', 'policy', 'go'] as const;
export type OwnerClass = (typeof OWNER_CLASSES)[number];
export const OWNER_KIND_CLASSES = { grant: 'grant', delegate: 'grant', revoke: 'revoke',
  'team-create': 'create', 'signer-add': 'policy', 'signer-remove': 'policy',
  'approval-policy': 'policy', policy: 'policy', publish: 'publish', spend: 'spend', go: 'go' } as const;
export type OwnerOperation = keyof typeof OWNER_KIND_CLASSES;
export type OwnerAct = {
  class: OwnerClass;
  operation: OwnerOperation;
  level: 'entity' | 'project' | 'team';
  target: string;
  artifact: Json;
  payload: { [key: string]: Json };
  input_state: Json;
  request_id: string;
};
export type InertOwnerRequest = {
  format: typeof OWNER_REQUEST_FORMAT;
  request_id: string;
  requester: string;
  self_request: boolean;
  created: string;
  expires_at: string;
  params_hash: string;
  act: OwnerAct;
};
export type OwnerActionRequirements = {
  class: OwnerClass;
  authorityWrite: boolean;
  grantOfGrant: boolean;
  freshHigh: boolean;
  noneAllowed: boolean;
  alwaysAllowed: boolean;
};

const ADMIN_WORDS = new Set<string>([...TEAM_GRANT_FORBIDDEN, 'delegate', 'revoke', 'init', 'signer', 'policy', 'approve', 'approval-policy']);
const APPROVAL_POLICIES = new Set(['sign-method', 'owner-signers', 'approval-methods', 'approval-min-assurance',
  'approval-always-allowed', 'owner-signer-mode', 'approval-rule-ttl']);
function words(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((word) => typeof word !== 'string' || word === '' || word.trim() !== word)) throw new Error('owner-request.invalid-authority-words');
  return raw as string[];
}

/** The synthetic v1 parameter projection requires commands AND capabilities for authority
 * operations, even when empty. Unknown vocabulary refuses, never downgrades assurance. */
export function ownerActionRequirements(act: OwnerAct, selfRequest: boolean): OwnerActionRequirements {
  if (!validOwnerAct(act) || typeof selfRequest !== 'boolean') throw new Error('owner-request.invalid-act');
  const expected = OWNER_KIND_CLASSES[act.operation];
  if (act.class !== expected) throw new Error('owner-request.class-mismatch');
  let grantOfGrant = act.operation === 'signer-add' || act.operation === 'signer-remove';
  const authorityWrite = ['grant', 'delegate', 'revoke', 'team-create', 'signer-add', 'signer-remove'].includes(act.operation);
  if (['grant', 'delegate'].includes(act.operation)) {
    const commands = words(act.payload.commands);
    const capabilities = words(act.payload.capabilities);
    for (const word of commands) {
      if (!ADMIN_WORDS.has(word) && COMMAND_GATES[word] === undefined) throw new Error('owner-request.unknown-authority-word');
    }
    for (const word of capabilities) {
      if (!ADMIN_WORDS.has(word) && !(GRANT_CAPABILITIES as readonly string[]).includes(word)) throw new Error('owner-request.unknown-authority-word');
    }
    grantOfGrant ||= [...commands, ...capabilities].some((word) => ADMIN_WORDS.has(word))
      || (act.payload.grant_scope !== undefined && act.payload.grant_scope !== null);
  }
  if (act.operation === 'policy' || act.operation === 'approval-policy') {
    if (typeof act.payload.name !== 'string' || act.payload.name.trim() === '') throw new Error('owner-request.invalid-policy-name');
    grantOfGrant = APPROVAL_POLICIES.has(act.payload.name) || act.payload.name.startsWith('approval-') || act.payload.name.startsWith('owner-signer');
  }
  if (act.class === 'go' && (typeof act.payload.run_id !== 'string' || act.payload.run_id.trim() === '')) throw new Error('owner-request.missing-run');
  const freshHigh = act.operation === 'team-create' || grantOfGrant;
  return { class: act.class, authorityWrite, grantOfGrant, freshHigh,
    noneAllowed: !authorityWrite && !freshHigh && !selfRequest,
    alwaysAllowed: !freshHigh && !selfRequest };
}

export function validOwnerAct(raw: unknown): raw is OwnerAct {
  try {
    canonicalOwnerBytes(raw);
    return ownerObject(raw) && ownerExactKeys(raw, ['class', 'operation', 'level', 'target', 'artifact', 'payload', 'input_state', 'request_id'])
      && (OWNER_CLASSES as readonly unknown[]).includes(raw.class)
      && typeof raw.operation === 'string' && Object.hasOwn(OWNER_KIND_CLASSES, raw.operation)
      && ['entity', 'project', 'team'].includes(raw.level as string)
      && typeof raw.target === 'string' && raw.target.trim() !== '' && ownerId(raw.request_id) && ownerObject(raw.payload);
  } catch { return false; }
}

/** requester and selfRequest must be derived by a trusted host from actual admission and
 * placement. This constructor does not resolve a caller and confers no authority. */
export function createInertOwnerRequest(act: OwnerAct, host: { requester: string; selfRequest: boolean; now: Date }): InertOwnerRequest {
  ownerActionRequirements(act, host.selfRequest);
  if (!ownerId(host.requester) || !Number.isFinite(host.now.getTime())) throw new Error('owner-request.invalid-host');
  return ownerSnapshot({ format: OWNER_REQUEST_FORMAT, request_id: act.request_id, requester: host.requester,
    self_request: host.selfRequest, created: host.now.toISOString(),
    expires_at: new Date(host.now.getTime() + OWNER_REQUEST_TTL_MS).toISOString(), params_hash: ownerValueHash(act.payload), act });
}
export function validInertOwnerRequest(raw: unknown): raw is InertOwnerRequest {
  try {
    canonicalOwnerBytes(raw);
    if (!ownerObject(raw) || !ownerExactKeys(raw, ['format', 'request_id', 'requester', 'self_request', 'created', 'expires_at', 'params_hash', 'act'])
      || raw.format !== OWNER_REQUEST_FORMAT || !ownerId(raw.request_id) || !ownerId(raw.requester)
      || typeof raw.self_request !== 'boolean' || !ownerTime(raw.created) || !ownerTime(raw.expires_at)
      || Date.parse(raw.expires_at) - Date.parse(raw.created) !== OWNER_REQUEST_TTL_MS
      || !ownerHash(raw.params_hash) || !validOwnerAct(raw.act) || raw.act.request_id !== raw.request_id
      || ownerValueHash(raw.act.payload) !== raw.params_hash) return false;
    ownerActionRequirements(raw.act, raw.self_request);
    return true;
  } catch { return false; }
}
export function createOwnerStatement(request: InertOwnerRequest, answer: {
  nonce: string; choice: OwnerDecision; standingRule: OwnerStandingRule | null;
  signerId: string; signerType: OwnerSignerType; time: string;
}): OwnerStatement {
  if (!validInertOwnerRequest(request)) throw new Error('owner-request.invalid');
  const statement: OwnerStatement = { format: OWNER_STATEMENT_FORMAT, request_id: request.request_id,
    params_hash: request.params_hash, act_digest: ownerValueHash(request.act), nonce: answer.nonce,
    choice: answer.choice, standing_rule: answer.standingRule, signer_id: answer.signerId,
    signer_type: answer.signerType, time: answer.time };
  if (!validOwnerStatement(statement)) throw new Error('owner-wire.invalid-statement');
  return ownerSnapshot(statement);
}

export type SyntheticTerminalPlacement = { request_id: string; act_digest: string; owner: true; terminal: true; unattended: false };
export type SyntheticRegisteredOwnerSigner = {
  id: string;
  type: OwnerSignerType;
  method: SignProof;
  publicKey: KeyObject | null;
};
export type InertOwnerRecord =
  | { type: 'approval'; run_id: string; request: InertOwnerRequest; attestation: readonly OwnerTranscript[] }
  | { type: 'approval-answer'; request: InertOwnerRequest; attestation: readonly OwnerTranscript[] }
  | { type: 'approval'; run_id: string; request: InertOwnerRequest; taken: 'terminal'; signer: { id: string; type: 'terminal' }; placement: SyntheticTerminalPlacement }
  | { type: 'approval-answer'; request: InertOwnerRequest; taken: 'terminal'; signer: { id: string; type: 'terminal' }; placement: SyntheticTerminalPlacement }
  | { type: 'policy-approval'; request: InertOwnerRequest; policy: Json; signature: string };
export type InertOwnerContext = {
  now: Date;
  /** Captured by the trusted host from its verified request, not copied from an incoming
   * answer. This proposal does not implement a durable signed-request store. */
  verifiedRequestHash: string;
  currentAct: OwnerAct;
  expectedNonce?: string;
  signers: readonly SyntheticRegisteredOwnerSigner[] | null;
  method: SignMethod;
  floor: SignMethod | null;
  minAssurance: 'low' | 'high';
  alwaysAllowed: boolean;
  signerMode: 'any' | 'all';
  spentRequestIds: readonly string[];
  /** Trusted synthetic host observation, never taken from the answer being evaluated. */
  terminalPlacement?: SyntheticTerminalPlacement;
  /** Host decides current scope/bounds/TTL containment; absence refuses always. */
  standingRuleWithin?: (rule: OwnerStandingRule, request: InertOwnerRequest) => boolean;
};
export type InertOwnerEvaluation =
  | { ok: false; reason: string }
  | { ok: true; inert: true; decision: OwnerDecision | 'policy'; record: InertOwnerRecord; nextSpentRequestIds: readonly string[] };

function requestProblem(request: InertOwnerRequest, context: InertOwnerContext, nonceRequired = true): string | null {
  if (!validInertOwnerRequest(request)) return 'owner-request.invalid';
  if (!ownerHash(context.verifiedRequestHash) || context.verifiedRequestHash !== ownerValueHash(request)) return 'owner-request.unverified';
  if (!Number.isFinite(context.now.getTime()) || !validOwnerAct(context.currentAct)
    || ownerValueHash(context.currentAct) !== ownerValueHash(request.act)) return 'owner-request.changed-act';
  if (Date.parse(request.created) > context.now.getTime() + OWNER_PROOF_FUTURE_SKEW_MS
    || Date.parse(request.expires_at) <= context.now.getTime()) return 'owner-request.expired';
  if (context.spentRequestIds.includes(request.request_id)) return 'owner-request.spent';
  if (nonceRequired && !ownerHash(context.expectedNonce)) return 'owner-answer.challenge';
  // create is new in this proposal; the frozen policy parser does not yet expose its row.
  const probe = request.act.class === 'create' ? 'grant' : request.act.class;
  if (parseSignMethodValue(`${probe}=${context.method}`) === null
    || (context.floor !== null && parseSignMethodValue(`${probe}>=${context.floor}`) === null)) return 'owner-answer.floor';
  if (!['low', 'high'].includes(context.minAssurance) || !['any', 'all'].includes(context.signerMode)
    || typeof context.alwaysAllowed !== 'boolean') return 'owner-answer.invalid-context';
  return null;
}
function signerMethodMatches(signer: SyntheticRegisteredOwnerSigner): boolean {
  return signer.type === 'terminal' ? signer.method === 'terminal' && signer.publicKey === null
    : signer.type === 'mac-keystore' ? signer.method === 'touch-id'
      : signer.method === 'phone';
}

/** Signature/membership -> digest/challenge/time -> floor -> assurance. This evaluates fresh
 * answers only; it neither matches nor installs a standing rule. Single use is a pure state
 * transition over injected ids, NOT a durable claim or an authorization to execute. */
export function evaluateInertOwnerAnswer(request: InertOwnerRequest, answers: readonly unknown[], context: InertOwnerContext): InertOwnerEvaluation {
  const refuse = (reason: string): InertOwnerEvaluation => ({ ok: false, reason });
  try {
    request = ownerSnapshot(request);
    answers = ownerSnapshot(answers);
    const problem = requestProblem(request, context);
    if (problem) return refuse(problem);
    const requirements = ownerActionRequirements(request.act, request.self_request);
    if (context.method === 'none') return refuse('owner-answer.proof-required');
    if (!context.signers || context.signers.length === 0
      || new Set(context.signers.map((signer) => signer.id)).size !== context.signers.length
      || context.signers.some((signer) => !ownerId(signer.id) || !signerMethodMatches(signer))) return refuse('owner-answer.signer-policy');
    if (!Array.isArray(answers) || answers.length === 0) return refuse('owner-answer.missing');
    const captured: OwnerTranscript[] = [];
    const seen = new Set<string>();
    const proofs = new Set<SignProof>();
    let reference: OwnerStatement | undefined;
    for (const raw of answers) {
      canonicalOwnerBytes(raw);
      if (!ownerObject(raw) || !validOwnerStatement(raw.statement)) return refuse('owner-answer.invalid');
      const statement = raw.statement;
      const signer = context.signers.find((candidate) => candidate.id === statement.signer_id && candidate.type === statement.signer_type);
      if (!signer || seen.has(signer.id)) return refuse('owner-answer.signer-policy');
      if (signer.type === 'terminal' || !signer.publicKey || !verifySyntheticOwnerTranscript(raw, signer.publicKey)) return refuse('owner-answer.signature');
      if (statement.request_id !== request.request_id || statement.params_hash !== request.params_hash
        || statement.act_digest !== ownerValueHash(request.act)) return refuse('owner-answer.binding');
      if (statement.nonce !== context.expectedNonce) return refuse('owner-answer.challenge');
      const at = Date.parse(statement.time);
      if (at < Date.parse(request.created) - OWNER_PROOF_FUTURE_SKEW_MS || at > context.now.getTime() + OWNER_PROOF_FUTURE_SKEW_MS
        || context.now.getTime() - at > OWNER_PROOF_MAX_AGE_MS) return refuse('owner-answer.stale');
      // all-of signers share the same act/nonce/choice/rule. Identity and time belong to each
      // signer's own single statement; neither can change the common decision projection.
      if (reference && (reference.choice !== statement.choice || ownerValueHash(reference.standing_rule) !== ownerValueHash(statement.standing_rule))) return refuse('owner-answer.disagreement');
      reference = statement;
      seen.add(signer.id);
      proofs.add(signer.method);
      captured.push(ownerSnapshot(raw) as OwnerTranscript);
    }
    if (context.signerMode === 'all' && context.signers.some((signer) => !seen.has(signer.id))) return refuse('owner-answer.missing-signers');
    if (!signMethodSatisfies(context.method, context.floor ?? undefined)) return refuse('owner-answer.floor');
    if (!signMethodAlternatives(context.method).some((branch) => branch.length === proofs.size && branch.every((proof) => proofs.has(proof)))) return refuse('owner-answer.method');
    const needHigh = requirements.freshHigh || context.minAssurance === 'high';
    // any-of has the lowest assurance of its branches; all-of checks every part. The same
    // terminal-low rule therefore applies even when a high branch was selected for any-of.
    if (needHigh && signMethodAlternatives(context.method).some((branch) => branch.includes('terminal'))) return refuse('owner-answer.assurance');
    if (!reference) return refuse('owner-answer.missing');
    if (reference.choice === 'always') {
      if (!requirements.alwaysAllowed || !context.alwaysAllowed || !reference.standing_rule
        || reference.standing_rule.kind !== request.act.operation || Date.parse(reference.standing_rule.expires_at) <= context.now.getTime()
        || !context.standingRuleWithin || !context.standingRuleWithin(reference.standing_rule, request)) return refuse('owner-answer.rule-forbidden');
      if (request.act.class === 'policy' && reference.standing_rule.scope.policy_name !== request.act.payload.name) return refuse('owner-answer.rule-scope');
    }
    const record: InertOwnerRecord = request.act.class === 'go'
      ? { type: 'approval', run_id: request.act.payload.run_id as string, request, attestation: captured }
      : { type: 'approval-answer', request, attestation: captured };
    return ownerSnapshot({ ok: true, inert: true, decision: reference.choice, record,
      nextSpentRequestIds: [...context.spentRequestIds, request.request_id] });
  } catch { return refuse('owner-answer.invalid'); }
}

/** Draft 6 terminal exception: trusted placement, no statement, nonce, challenge, signature
 * or device-answer object. This still produces only an inert record, never an effect. */
export function evaluateInertTerminal(request: InertOwnerRequest, context: InertOwnerContext, signerId: string): InertOwnerEvaluation {
  try {
    request = ownerSnapshot(request);
    const problem = requestProblem(request, context, false);
    if (problem) return { ok: false, reason: problem };
    if (!context.signers || context.signers.length === 0 || new Set(context.signers.map((signer) => signer.id)).size !== context.signers.length
      || context.signers.some((signer) => !ownerId(signer.id) || !signerMethodMatches(signer))) return { ok: false, reason: 'owner-answer.signer-policy' };
    const signer = context.signers.find((entry) => entry.id === signerId && entry.type === 'terminal');
    if (!signer) return { ok: false, reason: 'owner-answer.signer-policy' };
    const placement = ownerSnapshot(context.terminalPlacement);
    if (!ownerObject(placement) || !ownerExactKeys(placement, ['request_id', 'act_digest', 'owner', 'terminal', 'unattended'])
      || placement.owner !== true || placement.terminal !== true || placement.unattended !== false
      || placement.request_id !== request.request_id || placement.act_digest !== ownerValueHash(request.act)) return { ok: false, reason: 'owner-answer.placement' };
    if (context.signerMode === 'all' && context.signers.length !== 1) return { ok: false, reason: 'owner-answer.missing-signers' };
    if (!signMethodSatisfies(context.method, context.floor ?? undefined)) return { ok: false, reason: 'owner-answer.floor' };
    if (!signMethodAlternatives(context.method).some((branch) => branch.length === 1 && branch[0] === 'terminal')) return { ok: false, reason: 'owner-answer.method' };
    if (ownerActionRequirements(request.act, request.self_request).freshHigh || context.minAssurance === 'high') return { ok: false, reason: 'owner-answer.assurance' };
    const common = { request, taken: 'terminal' as const, signer: { id: signerId, type: 'terminal' as const }, placement };
    const record: InertOwnerRecord = request.act.class === 'go'
      ? { type: 'approval', run_id: request.act.payload.run_id as string, ...common }
      : { type: 'approval-answer', ...common };
    return ownerSnapshot({ ok: true, inert: true, decision: 'once', record, nextSpentRequestIds: [...context.spentRequestIds, request.request_id] });
  } catch { return { ok: false, reason: 'owner-answer.placement' }; }
}

/** Policy authority is a separate synthetic tool signature, never an owner-proof transcript.
 * The host supplies a verified current declaration/chain, not an untrusted boolean in JSON. */
export function evaluateInertNone(request: InertOwnerRequest, context: InertOwnerContext, policy: {
  reference: Json; verifyCurrent: (reference: Json, request: InertOwnerRequest) => boolean; toolKey: KeyObject;
}): InertOwnerEvaluation {
  try {
    request = ownerSnapshot(request);
    const problem = requestProblem(request, context, false);
    if (problem) return { ok: false, reason: problem };
    if (context.method !== 'none' || context.floor !== null || context.minAssurance === 'high'
      || !ownerActionRequirements(request.act, request.self_request).noneAllowed) return { ok: false, reason: 'owner-answer.none-forbidden' };
    const reference = ownerSnapshot(policy.reference);
    if (!policy.verifyCurrent(reference, request) || policy.toolKey.type !== 'private' || policy.toolKey.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'owner-answer.policy' };
    const unsigned = { type: 'policy-approval' as const, request, policy: reference };
    const signature = sign(null, Buffer.concat([Buffer.from(OWNER_POLICY_DOMAIN), canonicalOwnerBytes(unsigned)]), policy.toolKey).toString('hex');
    return ownerSnapshot({ ok: true, inert: true, decision: 'policy', record: { ...unsigned, signature }, nextSpentRequestIds: [...context.spentRequestIds, request.request_id] });
  } catch { return { ok: false, reason: 'owner-answer.policy' }; }
}
export function verifySyntheticPolicyApproval(record: unknown, toolKey: KeyObject): boolean {
  try {
    canonicalOwnerBytes(record);
    if (!ownerObject(record) || !ownerExactKeys(record, ['type', 'request', 'policy', 'signature']) || record.type !== 'policy-approval'
      || !validInertOwnerRequest(record.request) || !ownerActionRequirements(record.request.act, record.request.self_request).noneAllowed
      || typeof record.signature !== 'string' || !/^[0-9a-f]{128}$/.test(record.signature)
      || toolKey.type !== 'public' || toolKey.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.concat([Buffer.from(OWNER_POLICY_DOMAIN), canonicalOwnerBytes({ type: record.type, request: record.request, policy: record.policy })]), toolKey, Buffer.from(record.signature, 'hex'));
  } catch { return false; }
}
