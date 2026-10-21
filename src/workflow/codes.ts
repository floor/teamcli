// The decision kinds and the one code table the core, the dry runner and their tests consume.
// Check-finding codes are separate (a finding never becomes an exit id); `workflow.uses-deferred`
// is the dry runner's slice-1 refusal for a reachable child reference.

export const DECISION_KINDS = ['step', 'duplicate', 'held', 'refused'] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_CODES = {
  requestConflict: 'core.request-conflict',
  revisionStale: 'core.revision-stale',
  headConflict: 'core.ledger-head-conflict',
  occurrencePayloadConflict: 'core.occurrence-payload-conflict',
  guardUnknown: 'core.guard-unknown',
  guardRefused: 'core.guard-refused',
  evidenceAmbiguous: 'core.evidence-ambiguous',
  evidenceNonAuthoritative: 'core.evidence-non-authoritative',
  waitNotReached: 'core.wait-not-reached',
  waitPending: 'core.wait-pending',
  entryEffectFailed: 'core.entry-effect-failed',
  // The accepted envelope identity checks, ahead of request acceptance (T3 G-IDENTITY).
  runMismatch: 'core.run-mismatch',
  definitionMismatch: 'core.definition-mismatch',
  // The one spelling for supplied evidence that is absent. No core.evidence-missing exists.
  evidenceMissing: 'evidence.missing',
  evidenceCorrupt: 'evidence.corrupt',
  evidenceUnknown: 'evidence.unknown',
  settingsMissing: 'settings.missing',
  usesDeferred: 'workflow.uses-deferred',
} as const;

export type DecisionCode = (typeof DECISION_CODES)[keyof typeof DECISION_CODES];
