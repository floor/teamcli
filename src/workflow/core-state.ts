// The core's run-state contract. The dry core owns this type; the replay fold imports the same
// type and keeps no structural copy. Types only — this module has no runtime exports.
//
// Current dry scope only: no ledger head, no recorded execution mode, no child runs.
// `blocked` folds a terminal held/refused stop for replay; the core ignores it in slice 1.

import type { DecisionCode } from './codes.ts';
import type {
  DefinitionId,
  OccurrenceId,
  RequestId,
  Revision,
  RunId,
  WaitingOn,
} from './types.ts';

/** One effect occurrence the run has planned and recorded. */
export type OccurrenceRecord = {
  id: OccurrenceId; // `${runId}/${activation}/${effect}`
  effect: string; // effect name (the journal record's `name`)
  state: string; // the state whose hook produced it
  activation: number; // that state's activation
  payloadDigest: `sha256:${string}`; // canonicalEffectPayload, then payloadDigest
};

/** One used request id. `step` is the zero-based index into `journal.steps`. */
export type RequestRecord = {
  payloadDigest: `sha256:${string}`; // canonicalRequestPayload, then payloadDigest
  step: number;
};

/** One wait per state activation, flat. Kind, role and setting derive from the definition. */
export type RunWait = {
  state: string;
  activation: number;
  status: 'pending' | 'fired';
};

/** The fold of a terminal held/refused stop; replay reconstructs it. */
export type RunBlock = {
  decision: 'held' | 'refused';
  code: DecisionCode;
  state: string;
  revision: Revision;
  waitingOn?: WaitingOn;
};

/** The core's one run input contract. */
export type RunState = {
  runId: RunId;
  definitionId: DefinitionId; // the run's pinned definition
  state: string; // the current state
  revision: Revision; // accepted transitions so far
  activation: number; // the current state's activation, also the high-water mark
  occurrences: ReadonlyMap<OccurrenceId, OccurrenceRecord>;
  requests: ReadonlyMap<RequestId, RequestRecord>;
  waits: readonly RunWait[];
  blocked?: RunBlock;
};
