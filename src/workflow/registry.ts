// The narrow, injected seams the checker and the dry runner read through, plus the provisional
// catalogues the accepted sketches name. Nothing here can grant anything: a resolver answers
// "does this name exist", never "is this allowed".

import { isEventKind } from '../bus/kinds.ts';
import type { RecordSelector } from './signals.ts';
import type { ArtifactRef, Capability, EvidenceRecord, EvidenceRef } from './types.ts';

/**
 * The role words a definition may name. `base-role` is the roles specification's base function
 * (the workflow MVP registers `builder` and `tester`); `daemon` is the role the definition names
 * and the daemon's enrolled identity holds (workflow-mvp-spec-draft-4 §2.1).
 */
export interface RoleResolver {
  resolve(name: string): 'owner' | 'base-role' | 'daemon' | 'round-role' | 'team-role' | undefined;
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
  scopes: readonly string[] = [],
): OperationDescriptor {
  return { kernelOperation, capabilities, scopes, confirmationClass, reach, provisional: true };
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
  // The workflow MVP's module action: no Kernel operation exists (workflow-mvp-spec-draft-4 §2.6).
  'dispatch': provisional('dispatch', ['write'], 'local', 'none', ['run']),
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

// ---------------------------------------------------------------------------------------------
// The workflow MVP's three evidence guards (workflow-mvp-spec-draft-4 §2.1.2, §2.6). Each reads
// one record and compares what the hand-off asked for with what the hand-off observed; none reads
// a tree, a clock or a store, and none grants anything.
// ---------------------------------------------------------------------------------------------

/**
 * The `type: 'step'` record `tested-head-equals-built` reads. `head` is the head the tester
 * tested; `builtHead` is the head the builder's accepted step recorded, stamped on the record by
 * the daemon when it composed the tester's report.
 */
export type TestedStepRecord = EvidenceRecord & {
  type: 'step';
  head: string;
  builtHead: string;
};

/**
 * The `type: 'outcome', operation: 'merge', result: 'done'` record `merge-matches-request` reads.
 * The flat fields are the observed merge; `request` is the merge the run asked for.
 */
export type MergeOutcomeRecord = EvidenceRecord & {
  type: 'outcome';
  operation: 'merge';
  result: 'done';
  repository: string;
  destinationBranch: string;
  sourceCommit: string;
  mergeCommit: string;
  parents: string[];
  fastForwardHead?: string;
  request: { repository: string; destinationBranch: string; sourceCommit: string };
};

/**
 * The `type: 'outcome', operation: 'install', result: 'done'` record `install-matches-merge` reads.
 * `observedMergeCommit` is the merge the run observed; `mergeCommit` is the merge the install
 * record names; `successLine` is the install's verifiable success line.
 */
export type InstallOutcomeRecord = EvidenceRecord & {
  type: 'outcome';
  operation: 'install';
  result: 'done';
  mergeCommit: string;
  observedMergeCommit: string;
  successLine: string;
};

function recordField(record: EvidenceRecord, name: string): string | undefined {
  const value = (record as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function testedHeadEqualsBuilt(record: EvidenceRecord): { ok: true } | { ok: false; why: string } {
  const head = recordField(record, 'head');
  const builtHead = recordField(record, 'builtHead');
  if (head === undefined || builtHead === undefined) {
    return { ok: false, why: 'the step record names no tested head and no built head' };
  }
  if (head !== builtHead) {
    return { ok: false, why: `the tested head "${head}" is not the built head "${builtHead}"` };
  }
  return { ok: true };
}

function mergeMatchesRequest(record: EvidenceRecord): { ok: true } | { ok: false; why: string } {
  const request = (record as Record<string, unknown>).request;
  if (typeof request !== 'object' || request === null) {
    return { ok: false, why: 'the merge outcome names no request to match' };
  }
  const requested = request as Record<string, unknown>;
  const repository = recordField(record, 'repository');
  const destinationBranch = recordField(record, 'destinationBranch');
  const sourceCommit = recordField(record, 'sourceCommit');
  const mergeCommit = recordField(record, 'mergeCommit');
  if (
    repository === undefined ||
    destinationBranch === undefined ||
    sourceCommit === undefined ||
    mergeCommit === undefined
  ) {
    return {
      ok: false,
      why: 'the merge outcome names no repository, destination branch, source commit or merge commit',
    };
  }
  const requestRepository = requested.repository;
  const requestDestination = requested.destinationBranch;
  const requestSource = requested.sourceCommit;
  if (requestRepository !== repository) {
    return {
      ok: false,
      why: `the request's repository "${String(requestRepository)}" is not the observed "${repository}"`,
    };
  }
  if (requestDestination !== destinationBranch) {
    return {
      ok: false,
      why: `the request's destination "${String(requestDestination)}" is not the observed "${destinationBranch}"`,
    };
  }
  if (requestSource !== sourceCommit) {
    return {
      ok: false,
      why: `the request's tested commit "${String(requestSource)}" is not the observed "${sourceCommit}"`,
    };
  }
  const parents = Array.isArray(record.parents)
    ? record.parents.filter((parent): parent is string => typeof parent === 'string')
    : [];
  const fastForwardHead = recordField(record, 'fastForwardHead');
  if (parents.includes(sourceCommit) || fastForwardHead === sourceCommit) {
    return { ok: true };
  }
  return {
    ok: false,
    why: `the tested commit "${sourceCommit}" is neither among the merge commit's parents nor the fast-forward head`,
  };
}

function installMatchesMerge(record: EvidenceRecord): { ok: true } | { ok: false; why: string } {
  const mergeCommit = recordField(record, 'mergeCommit');
  const observedMergeCommit = recordField(record, 'observedMergeCommit');
  const successLine = (record as Record<string, unknown>).successLine;
  if (mergeCommit === undefined || observedMergeCommit === undefined) {
    return { ok: false, why: 'the install record names no merge commit and no observed merge commit' };
  }
  if (mergeCommit !== observedMergeCommit) {
    return {
      ok: false,
      why: `the install record names merge commit "${mergeCommit}", not the observed "${observedMergeCommit}"`,
    };
  }
  if (typeof successLine !== 'string' || successLine.trim() === '') {
    return { ok: false, why: 'the install record carries no success line' };
  }
  return { ok: true };
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
  'tested-head-equals-built': {
    name: 'tested-head-equals-built',
    reads: { type: 'step' },
    evaluate: testedHeadEqualsBuilt,
  },
  'merge-matches-request': {
    name: 'merge-matches-request',
    reads: { type: 'outcome', operation: 'merge', result: 'done' },
    evaluate: mergeMatchesRequest,
  },
  'install-matches-merge': {
    name: 'install-matches-merge',
    reads: { type: 'outcome', operation: 'install', result: 'done' },
    evaluate: installMatchesMerge,
  },
};

export const PROVISIONAL_OPERATIONS: readonly string[] = Object.keys(PROVISIONAL_OPERATION_TABLE);

export const PROVISIONAL_GUARDS: readonly string[] = Object.keys(PROVISIONAL_GUARD_TABLE);

/**
 * The scratch wiring tests and the checker's default: `owner`, the `builder` and `tester` base
 * roles, the daemon, and the round roles by name, then the supplied seat role strings as team
 * roles; the provisional operations (including the workflow MVP's `dispatch`), the six guards and
 * the closed event-kind set.
 */
export function provisionalResolvers(teamRoles: readonly string[] = []): WorkflowResolvers {
  const roles: RoleResolver = {
    resolve(name) {
      if (name === 'owner') return 'owner';
      if (name === 'builder' || name === 'tester') return 'base-role';
      if (name === 'daemon') return 'daemon';
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
