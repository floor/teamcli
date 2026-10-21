// The narrow, injected seams the checker and the dry runner read through, plus the provisional
// catalogues the accepted sketches name. Nothing here can grant anything: a resolver answers
// "does this name exist", never "is this allowed".

import { isEventKind } from '../bus/kinds.ts';
import type { RecordSelector } from './signals.ts';
import type { ArtifactRef, Capability, EvidenceRecord, EvidenceRef } from './types.ts';

export interface RoleResolver {
  resolve(name: string): 'owner' | 'round-role' | 'team-role' | undefined;
}

export type OperationDescriptor = {
  kernelOperation: string;
  capabilities: readonly Capability[];
  scopes: readonly string[];
  account?: string;
  confirmationClass: 'none' | 'owner' | 'grant';
  reach: 'local' | 'outside-machine';
  provisional: boolean;
};

export interface OperationResolver {
  descriptor(name: string): OperationDescriptor | undefined;
}

export type GuardScope = { target: string; artifact: ArtifactRef };

export type Guard = {
  name: string;
  reads: RecordSelector;
  evaluate(record: EvidenceRecord, scope: GuardScope): { ok: true } | { ok: false; why: string };
};

export interface GuardCatalogue {
  guard(name: string): Guard | undefined;
}

export interface EventKindRegistry {
  has(name: string): boolean;
}

export interface SettingSource {
  get(name: string): string | undefined;
}

export interface EvidenceSource {
  record(ref: EvidenceRef): EvidenceRecord | undefined;
}

export type WorkflowResolvers = {
  roles: RoleResolver;
  operations: OperationResolver;
  guards: GuardCatalogue;
  eventKinds: EventKindRegistry;
};

export type DryResolvers = WorkflowResolvers & { settings: SettingSource; evidence: EvidenceSource };

// ---------------------------------------------------------------------------------------------
// Provisional catalogues. NOT authority and not registry rows: every descriptor here carries
// `provisional: true`, the checker emits a note for each use, and the note disappears when the
// real descriptors land. The names are the twelve operations and three guards of the accepted
// sketches (draft 6 §2.8, maps B3/B5); capabilities and reach are the sketch's assertions.
// ---------------------------------------------------------------------------------------------

function provisional(
  kernelOperation: string,
  capabilities: readonly Capability[],
  reach: 'local' | 'outside-machine' = 'local',
  confirmationClass: 'none' | 'owner' | 'grant' = 'none',
): OperationDescriptor {
  return { kernelOperation, capabilities, scopes: [], confirmationClass, reach, provisional: true };
}

const PROVISIONAL_OPERATION_TABLE: Readonly<Record<string, OperationDescriptor>> = {
  'changelog-stamp': provisional('changelog-stamp', ['write']),
  'size-refresh': provisional('size-refresh', ['write']),
  'merge-verify': provisional('merge-verify', ['review']),
  'release-gate': provisional('release-gate', ['gate']),
  'release-tag': provisional('release-tag', [], 'outside-machine', 'owner'),
  'release-publish': provisional('release-publish', ['deploy'], 'outside-machine', 'owner'),
  'site-deploy': provisional('site-deploy', ['deploy'], 'outside-machine', 'owner'),
  'release-notes': provisional('release-notes', ['write']),
  'goals-session': provisional('goals-session', ['write']),
  'round-open': provisional('round-open', ['write']),
  'round-close-hold': provisional('round-close-hold', ['write']),
  'review-morning': provisional('review-morning', ['review']),
};

function outcomeGuard(name: string, selector: RecordSelector, why: string): Guard {
  return {
    name,
    reads: selector,
    evaluate(record) {
      return record.result === 'done' ? { ok: true } : { ok: false, why };
    },
  };
}

const PROVISIONAL_GUARD_TABLE: Readonly<Record<string, Guard>> = {
  'ci-green-on-head': outcomeGuard(
    'ci-green-on-head',
    { type: 'outcome', operation: 'ci-suite' },
    'the suite outcome for this head is not done',
  ),
  'registry-shows-version': outcomeGuard(
    'registry-shows-version',
    { type: 'outcome', operation: 'registry-check' },
    'the registry check outcome is not done',
  ),
  'round-complete-or-held': {
    name: 'round-complete-or-held',
    reads: { type: 'child-completion' },
    evaluate(record) {
      return record.status === 'completed' || record.status === 'held'
        ? { ok: true }
        : { ok: false, why: 'the child run has neither completed nor been recorded held' };
    },
  },
};

export const PROVISIONAL_OPERATIONS: readonly string[] = Object.keys(PROVISIONAL_OPERATION_TABLE);

export const PROVISIONAL_GUARDS: readonly string[] = Object.keys(PROVISIONAL_GUARD_TABLE);

/**
 * The scratch wiring tests and the checker's default: `owner` and the round roles by name, the
 * supplied seat role strings as team roles, the twelve provisional operations, the three
 * provisional guards and the closed event-kind set.
 */
export function provisionalResolvers(teamRoles: readonly string[] = []): WorkflowResolvers {
  const roles: RoleResolver = {
    resolve(name) {
      if (name === 'owner') return 'owner';
      if (name === 'lead' || name === 'integrator') return 'round-role';
      if (teamRoles.includes(name)) return 'team-role';
      return undefined;
    },
  };
  return {
    roles,
    operations: { descriptor: (name) => PROVISIONAL_OPERATION_TABLE[name] },
    guards: { guard: (name) => PROVISIONAL_GUARD_TABLE[name] },
    eventKinds: { has: (name) => isEventKind(name) },
  };
}
