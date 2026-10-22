// The shared workflow contract: the definition a graph parses into, the run's identities, the
// envelope a live gate would consume and the dry journal slice 1 records. Slice 0/1 only:
// nothing here appends to the Kernel ledger, dispatches an effect or verifies a signature.

import type { EventKind } from '../bus/kinds.ts';
import type { YamlError } from '../yaml.ts';
import type { SignalName } from './signals.ts';

/** A parse or check observation, line-numbered. Never folded into an exit id. */
export type Finding = { level: 'refusal' | 'note'; code: string; line: number; message: string };

/** A definition pinned by its content digest; the schema number is not the pin. */
export type DefinitionId = { workflow: string; schemaVersion: 1; digest: `sha256:${string}` };

/** Stable and opaque; the dry runner generates `run-<uuid>`. */
export type RunId = string;

/** Accepted transitions so far; 0 at entry. */
export type Revision = number;

/** `${RunId}/${activation}/${effectName}`; assigned at activation, stable under replay. */
export type OccurrenceId = string;

/** Stable across retries; never reused with different canonical bytes. */
export type RequestId = string;

/** A record id (seq and digest), never an engine claim. */
export type EvidenceRef = string;

/** What a move runs against: nothing, one ref, or a tree. */
export type ArtifactRef =
  | { kind: 'none' }
  | { kind: 'ref'; value: string }
  | { kind: 'tree'; value: string };

/** The closed eight capability words (draft 6 §2.2). */
export type Capability = 'write' | 'read' | 'review' | 'gate' | 'merge' | 'deploy' | 'act-as' | 'use-broker';

/** A wait ends only by a named role's approval or by the clock reaching a setting. */
export type WorkflowWait =
  | { line: number; for: 'approval'; role: { name: string; line: number } }
  | { line: number; for: 'time'; at: { name: string; line: number } };

/** One state: its entry and cleanup effects, an optional child library reference and a wait. */
export type WorkflowState = {
  line: number;
  name: string;
  onEnter: Array<{ name: string; line: number }>;
  onLeave: Array<{ name: string; line: number }>;
  uses?: { name: string; line: number };
  wait?: WorkflowWait;
};

/** One transition, fired only by a transition signal. */
export type WorkflowTransition = {
  line: number;
  from: string;
  to: string;
  on: SignalName;
  guard?: { name: string; line: number };
  role: { name: string; line: number };
};

/** One effect a hook names; `capability` may be absent only on an act-as ref effect (U13). */
export type WorkflowEffect = {
  line: number;
  name: string;
  run: { name: string; line: number };
  role: { name: string; line: number };
  capability?: Capability;
  actAs?: { value: string; line: number };
  reach?: { value: 'outside-machine'; line: number };
};

/** A library entry: fixed mechanics, adjustable settings (commitment 23). Declarations only. */
export type WorkflowLibraryEntry = {
  line: number;
  name: string;
  mechanics: string[];
  settings: string[];
};

/**
 * One supplied evidence fixture (a record the script or evidence file provides, never one this
 * slice verifies). `unknown` is not a dry-mode value; a fixture claiming it is refused.
 */
export type EvidenceRecord = {
  type: string;
  result?: 'done' | 'refused';
  operation?: string;
  target?: string;
  artifact?: ArtifactRef;
  effect?: OccurrenceId;
  status?: 'completed' | 'held';
  at?: string;
  [key: string]: unknown;
};

/** A standalone evidence file: ref → fixture, the same form as the dry script's block. */
export type EvidenceDocument = Record<EvidenceRef, EvidenceRecord>;

/** A parsed, structurally valid definition. Whole-graph rules belong to the checker. */
export type Workflow = {
  line: number;
  name: string;
  version: 1;
  initial?: string;
  /** Event kinds only; each names the state a triggered run enters. */
  on: Array<{ kind: EventKind; state: string; line: number }>;
  inputs: string[];
  states: Record<string, WorkflowState>;
  transitions: WorkflowTransition[];
  effects: Record<string, WorkflowEffect>;
  library: Record<string, WorkflowLibraryEntry>;
  error?: string;
};

/**
 * What a dry runner proposes for one effect. Never dispatched: `dispatched` is the literal
 * false, and `outcome` only ever names supplied evidence, never an execution result.
 */
export type DryEffectRecord = {
  name: string;
  state: string;
  activation: number;
  occurrence: OccurrenceId;
  payloadDigest: `sha256:${string}`;
  outcome?: EvidenceRef;
  dispatched: false;
};

/** What a dry stop is waiting for. */
export type WaitingOn =
  | { kind: 'evidence'; ref: EvidenceRef }
  | { kind: 'setting'; name: string }
  | { kind: 'entry-effect'; occurrence: OccurrenceId };

/** The decision that stopped a dry run; it never advances the revision. */
export type DryStop = {
  decision: 'held' | 'refused';
  code: string;
  why: string;
  at: string;
  state: string;
  revision: Revision;
  waitingOn?: WaitingOn;
  signal?: SignalName;
  requestId?: RequestId;
  /**
   * The stopped request's own effective precondition, recorded unchanged even when it is stale.
   * Present on a request-derived stop (one naming a signal and a request id); a request-less stop
   * — the reachable `uses:` refusal — names no request and carries none.
   */
  expectedRevision?: Revision;
  evidence: EvidenceRef[];
  guard?: { name: string; answer: boolean; evidence: EvidenceRef[] };
};

/** The non-authoritative record slice 1 writes through output only; replay's input. */
export type DryRunJournal = {
  format: 1;
  kind: 'workflow-run-dry';
  authoritative: false;
  notice: string;
  definition: DefinitionId;
  run: RunId;
  target: string;
  artifact: ArtifactRef;
  inputs: Record<string, string>;
  settings: Record<string, string>;
  initial: string;
  start: {
    state: string;
    activation: 1;
    effects: DryEffectRecord[];
  };
  steps: Array<{
    revision: Revision;
    at: string;
    signal: SignalName;
    requestId: RequestId;
    requestDigest: `sha256:${string}`;
    transition: { from: string; to: string; on: SignalName };
    activation: number;
    evidence: EvidenceRef[];
    guard?: { name: string; answer: boolean; evidence: EvidenceRef[] };
    effects: DryEffectRecord[];
  }>;
  outcome: { kind: 'script-exhausted' } | ({ kind: 'stopped' } & DryStop);
};

/**
 * The envelope a gate would accept. No role or capability field exists here by construction:
 * authority is derived by the gate, never supplied. `expectedHead` is ledger-only and absent
 * in dry mode; `target`/`artifact` live only at the top level.
 */
export type WorkflowEnvelope = {
  format: 1;
  run: RunId;
  definition: DefinitionId;
  expectedRevision: Revision;
  expectedHead?: { seq: number; hash: string };
  requestId: RequestId;
  move:
    | { transition: { from: string; to: string; on: SignalName } }
    | { operation: { name: string } };
  target: string;
  artifact: ArtifactRef;
  evidence: EvidenceRef[];
};

/** The parse result: a definition and its pin, structural findings, or the parser's refusal. */
export type ParseWorkflowResult =
  | { workflow: Workflow; definition: DefinitionId }
  | { findings: Finding[] }
  | { invalid: YamlError };
