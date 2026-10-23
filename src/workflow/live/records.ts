// The WF-MVP live journal record vocabulary: the versioned authoritative format a live run
// writes, one canonical-JSON line per event, plus the durable run-index shapes beside it. The dry
// journal's `authoritative: false` meaning is unchanged, and nothing here writes the Kernel
// ledger, dispatches an effect or verifies a signature.

import type { SignalName } from '../signals.ts';
import { isSignalName } from '../signals.ts';
import type {
  ArtifactRef,
  DefinitionId,
  DryEffectRecord,
  EvidenceDocument,
  EvidenceRecord,
  EvidenceRef,
  OccurrenceId,
  RequestId,
  Revision,
  RunId,
} from '../types.ts';

export const LIVE_FORMAT = 1 as const;
export const LIVE_KIND = 'workflow-run-live' as const;
export const LIVE_NOTICE =
  'live run journal — the run store is authoritative for this run; this is not the Kernel ledger';

/** The namespaced task identity an item key is built from, before encoding. */
export type ItemKey = { source: string; project: string; team: string; id: string };

export type Generation = number;

/** `encodeSegment`'s output alphabet plus the joining dot, and always a safe filename stem. */
const SEGMENT_MAX = 64;
const KEY_MAX = 180;

/**
 * Validate one raw segment. Dots are allowed and are encoded later, so `a.b` cannot alias the
 * `a`/`b` split; only emptiness, path separators and control characters are refused, plus a
 * length cap that keeps the item key a safe file name.
 */
export function validateSegment(segment: string): { ok: true } | { ok: false; why: string } {
  if (segment.length === 0) return { ok: false, why: 'a segment is empty' };
  if (segment.length > SEGMENT_MAX) return { ok: false, why: `a segment is longer than ${SEGMENT_MAX} characters` };
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return { ok: false, why: 'a segment holds a control character' };
    if (char === '/' || char === '\\') return { ok: false, why: 'a segment holds a path separator' };
  }
  return { ok: true };
}

/** Percent-encode one segment; the alphabet keeps letters, digits, `_` and `-` readable. */
export function encodeSegment(segment: string): string {
  const bytes = new TextEncoder().encode(segment);
  let encoded = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9_-]/.test(char)) encoded += char;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** Decode one encoded segment back to its source text; throws on a malformed escape. */
export function decodeSegment(encoded: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index]!;
    if (char !== '%') {
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const hex = encoded.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error('malformed percent escape');
    bytes.push(Number.parseInt(hex, 16));
    index += 2;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}

export type ItemKeyResult = { ok: true; key: string } | { ok: false; why: string };

/** Validate all four segments and return the collision-free key text. */
export function validateItemKey(item: ItemKey): ItemKeyResult {
  const parts = [item.source, item.project, item.team, item.id];
  for (const part of parts) {
    const decided = validateSegment(part);
    if (!decided.ok) return { ok: false, why: decided.why };
  }
  const key = parts.map(encodeSegment).join('.');
  if (key.length > KEY_MAX) return { ok: false, why: `the item key is longer than ${KEY_MAX} bytes` };
  return { ok: true, key };
}

/** The key text; throws when a segment cannot be encoded. Callers that report refusal use
 *  `validateItemKey` instead. */
export function itemKeyText(item: ItemKey): string {
  const decided = validateItemKey(item);
  if (!decided.ok) throw new Error(decided.why);
  return decided.key;
}

export function runIdFor(key: string, generation: Generation): RunId {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('a generation starts at 1 and is an integer');
  }
  return `${key}-${generation}`;
}

/** A hold excludes one seat from selection and binds an item until release or expiry. */
export type HoldKind = 'reservation' | 'next-claim';
export type HoldPhase = 'pending' | 'holder';

export type HoldRecord = {
  kind: HoldKind;
  item: string;
  owner: string;
  seat: string;
  phase: HoldPhase;
  at: string;
  /** Present while pending; absent on a holder, which stays excluded until release. */
  expiresAt?: string;
  run?: RunId;
  attempt?: number;
  thread?: string;
  receiver?: string;
  pane?: string;
  holder?: { seat: string; pane: string };
  messageId?: string;
};

/** The item slot in the durable index: generations, the live run, the terminal hold and the one
 *  hold. The index is the exclusion truth; journals are the state fold and audit. */
export type ItemRecord = {
  item: ItemKey;
  key: string;
  lastGeneration: Generation;
  live?: RunId;
  terminal?: { run: RunId; generation: Generation; outcome: 'done' | 'failed'; at: string };
  reopened?: { by: string; at: string; reason: string };
  hold?: HoldRecord;
};

export type RunIndex = {
  format: 1;
  kind: 'workflow-run-index';
  items: Record<string, ItemRecord>;
};

/** The effect shape a step records: the dry journal's, recorded at the transition. Delivery is a
 *  decision/intent record, never a mutated effect. */
export type LiveEffectRecord = DryEffectRecord;

/** The decision's error move, recorded verbatim on a step that takes the second engine rule: a
 *  refused state-entry effect moves the run to the definition's top-level `error` state. The
 *  occurrence is the refused effect's, at the state it was refused in. */
export type LiveErrorMove = {
  rule: 'entry-effect-refused';
  from: string;
  to: string;
  effect: string;
  occurrence: OccurrenceId;
};

type LiveHead = {
  format: typeof LIVE_FORMAT;
  kind: typeof LIVE_KIND;
  authoritative: true;
  seq: number;
  at: string;
};

export type LiveRunOpenRecord = LiveHead & {
  record: 'run-open';
  notice: string;
  run: RunId;
  item: ItemKey;
  generation: Generation;
  definition: DefinitionId;
  definitionPath: string;
  target: string;
  artifact: ArtifactRef;
  inputs: Record<string, string>;
  settings: Record<string, string>;
  initial: string;
  start: { state: string; activation: 1; effects: LiveEffectRecord[] };
};

export type LiveStepRecord = LiveHead & {
  record: 'step';
  revision: Revision;
  signal: SignalName;
  requestId: RequestId;
  requestDigest: `sha256:${string}`;
  transition: { from: string; to: string; on: SignalName };
  activation: number;
  /** The state the run is in after this step; absent means the transition's target. The error
   *  path names the definition's top-level `error` state here while `transition` stays the
   *  envelope's request. */
  next?: string;
  /** Present exactly on the error path: the decision's refused entry move, verbatim. */
  error?: LiveErrorMove;
  evidence: EvidenceRef[];
  /** The evidence records this step cited, keyed by ref: enough to re-derive the decision
   *  without any outside document. A step that cites no evidence writes `{}`. */
  evidenceRecords?: EvidenceDocument;
  guard?: { name: string; answer: boolean; evidence: EvidenceRef[] };
  effects: LiveEffectRecord[];
};

export type LiveEvidenceRecord = LiveHead & { record: 'evidence'; entries: EvidenceRecord[] };

/** The live-only outcome of a pending state-entry effect. A lead stop over a pending entry effect
 *  records `result: 'cancelled'` here, before the run ends failed; the dry evidence shape keeps
 *  its done/refused results, and this record is never cited as evidence. */
export type LiveEntryOutcomeRecord = LiveHead & {
  record: 'entry-outcome';
  result: 'cancelled';
  state: string;
  activation: number;
  effect: string;
  occurrence: OccurrenceId;
  why?: string;
  by?: string;
};

export type LiveIntentRecord = LiveHead & {
  record: 'intent';
  intentId: string;
  occurrence: OccurrenceId;
  attempt: number;
  receiver: string;
  messageId: string;
  leg: string;
  payloadDigest: `sha256:${string}`;
};

export type ResultOutcome = 'sent' | 'refused' | 'cancelled' | 'reconciled';

export type LiveResultRecord = LiveHead & {
  record: 'result';
  intentId: string;
  outcome: ResultOutcome;
  leg?: string;
  messageId?: string;
  why?: string;
  found?: string;
};

export type LiveHoldRecord = LiveHead & {
  record: 'hold';
  action: 'reserve' | 'convert' | 'release' | 'renew';
  hold: HoldRecord;
};

export const TIMER_KINDS = [
  'ack-timeout',
  'step-timeout-building',
  'step-timeout-testing',
  'step-timeout-installing',
  'merge-nudge',
] as const;
export type LiveTimerKind = (typeof TIMER_KINDS)[number];

export type LiveTimerRecord = LiveHead & {
  record: 'timer';
  action: 'arm' | 'fire' | 'cancel';
  timerId: string;
  timerKind: LiveTimerKind;
  state?: string;
  activation?: number;
  attempt?: number;
  deadline?: string;
  delivery?: string;
  why?: string;
};

export type LiveAttemptRecord = LiveHead & { record: 'attempt'; stage: string; attempt: number };

export type LiveMessageRecord = LiveHead & {
  record: 'message';
  messageId: string;
  thread?: string;
  attempt?: number;
  role?: string;
  accepted: boolean;
  why?: string;
};

export const LIVE_DECISION_KINDS = [
  'candidates',
  'acknowledgement',
  'delivery',
  'delivery-refused',
  'guard-refusal',
  'refusal',
  'ack',
  'report',
  'redispatch',
  'stop',
  'reconcile',
  'error-path',
] as const;
export type LiveDecisionKind = (typeof LIVE_DECISION_KINDS)[number];

export type LiveDecisionRecord = LiveHead & {
  record: 'decision';
  decision: LiveDecisionKind;
  stage?: string;
  attempt?: number;
  why?: string;
  detail?: Record<string, unknown>;
};

export type LiveOutcomeRecord = LiveHead & {
  record: 'outcome';
  outcome: 'done' | 'failed';
  why?: string;
  by?: string;
};

export type LiveReopenRecord = LiveHead & { record: 'reopen'; by: string; reason: string };

export type LiveRecord =
  | LiveRunOpenRecord
  | LiveStepRecord
  | LiveEvidenceRecord
  | LiveEntryOutcomeRecord
  | LiveIntentRecord
  | LiveResultRecord
  | LiveHoldRecord
  | LiveTimerRecord
  | LiveAttemptRecord
  | LiveMessageRecord
  | LiveDecisionRecord
  | LiveOutcomeRecord
  | LiveReopenRecord;

export type LiveStatus = 'live' | 'done' | 'failed';

/** The folded live run: the WF0 state entries plus the dispatch's durable state beside them. */
export type LiveState = {
  run: RunId;
  key: string;
  item: ItemKey;
  generation: Generation;
  definition: DefinitionId;
  status: LiveStatus;
  state: string;
  revision: Revision;
  activation: number;
  evidence: EvidenceRef[];
  evidenceRecords: EvidenceRecord[];
  entryOutcomes: LiveEntryOutcomeRecord[];
  holds: HoldRecord[];
  timers: LiveTimerRecord[];
  attempts: Record<string, number>;
  messages: LiveMessageRecord[];
  intents: LiveIntentRecord[];
  results: LiveResultRecord[];
  decisions: LiveDecisionRecord[];
  outcome?: { outcome: 'done' | 'failed'; why?: string; by?: string; at: string };
  reopened?: { by: string; reason: string; at: string };
  lastSeq: number;
};

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInt(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isArtifact(value: unknown): value is ArtifactRef {
  if (!isJson(value)) return false;
  if (value.kind === 'none') return true;
  if ((value.kind === 'ref' || value.kind === 'tree') && typeof value.value === 'string') return true;
  return false;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isJson(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEffect(value: unknown): value is LiveEffectRecord {
  if (!isJson(value)) return false;
  return (
    isText(value.name) &&
    isText(value.state) &&
    isInt(value.activation, 1) &&
    isText(value.occurrence) &&
    isDigest(value.payloadDigest) &&
    value.dispatched === false &&
    (value.outcome === undefined || isText(value.outcome))
  );
}

function isDefinition(value: unknown): value is DefinitionId {
  if (!isJson(value)) return false;
  return isText(value.workflow) && value.schemaVersion === 1 && isDigest(value.digest);
}

function isItemKey(value: unknown): value is ItemKey {
  if (!isJson(value)) return false;
  return (
    typeof value.source === 'string' &&
    typeof value.project === 'string' &&
    typeof value.team === 'string' &&
    typeof value.id === 'string' &&
    validateItemKey({
      source: value.source,
      project: value.project,
      team: value.team,
      id: value.id,
    }).ok
  );
}

export function isHoldRecord(value: unknown): value is HoldRecord {
  if (!isJson(value)) return false;
  if (value.kind !== 'reservation' && value.kind !== 'next-claim') return false;
  if (value.phase !== 'pending' && value.phase !== 'holder') return false;
  if (!isText(value.item) || !isText(value.owner) || !isText(value.seat)) return false;
  if (!isIso(value.at)) return false;
  if (value.phase === 'pending' && !isIso(value.expiresAt)) return false;
  if (value.phase === 'holder' && value.expiresAt !== undefined) return false;
  if (value.run !== undefined && !isText(value.run)) return false;
  if (value.attempt !== undefined && !isInt(value.attempt, 1)) return false;
  if (value.thread !== undefined && !isText(value.thread)) return false;
  if (value.receiver !== undefined && !isText(value.receiver)) return false;
  if (value.pane !== undefined && !isText(value.pane)) return false;
  if (value.messageId !== undefined && !isText(value.messageId)) return false;
  if (value.phase === 'holder') {
    if (!isJson(value.holder) || !isText(value.holder.seat) || typeof value.holder.pane !== 'string') {
      return false;
    }
  }
  return true;
}

export function isItemRecord(value: unknown): value is ItemRecord {
  if (!isJson(value)) return false;
  if (!isItemKey(value.item)) return false;
  // The key must be exactly the encoded item identity; anything else is a foreign record.
  const keyed = validateItemKey(value.item);
  if (!keyed.ok || keyed.key !== value.key) return false;
  if (!isInt(value.lastGeneration, 0)) return false;
  if (value.live !== undefined && !isText(value.live)) return false;
  if (value.terminal !== undefined) {
    if (!isJson(value.terminal)) return false;
    if (!isText(value.terminal.run) || !isInt(value.terminal.generation, 1)) return false;
    if (value.terminal.outcome !== 'done' && value.terminal.outcome !== 'failed') return false;
    if (!isIso(value.terminal.at)) return false;
  }
  if (value.reopened !== undefined) {
    if (!isJson(value.reopened)) return false;
    if (!isText(value.reopened.by) || !isIso(value.reopened.at) || typeof value.reopened.reason !== 'string') {
      return false;
    }
  }
  if (value.hold !== undefined && !isHoldRecord(value.hold)) return false;
  return true;
}

export function isRunIndex(value: unknown): value is RunIndex {
  if (!isJson(value)) return false;
  if (value.format !== 1 || value.kind !== 'workflow-run-index') return false;
  if (!isJson(value.items)) return false;
  return Object.entries(value.items).every(([key, item]) => {
    if (!isItemRecord(item)) return false;
    return item.key === key;
  });
}

/** Strict validation of one journal line, used on read and replay. */
export function validateRecord(raw: unknown): { ok: true; record: LiveRecord } | { ok: false; why: string } {
  if (!isJson(raw)) return { ok: false, why: 'the line is not a JSON object' };
  if (raw.format !== LIVE_FORMAT) return { ok: false, why: `the record format is not ${LIVE_FORMAT}` };
  if (raw.kind !== LIVE_KIND) return { ok: false, why: `the record kind is not ${LIVE_KIND}` };
  if (raw.authoritative !== true) return { ok: false, why: 'a live journal record must be authoritative' };
  if (!isInt(raw.seq, 1)) return { ok: false, why: 'the record sequence is not a positive integer' };
  if (!isIso(raw.at)) return { ok: false, why: 'the record instant is not an ISO timestamp' };
  const record = raw.record;
  switch (record) {
    case 'run-open': {
      if (!isText(raw.notice)) return { ok: false, why: 'the run-open notice is missing' };
      if (!isText(raw.run)) return { ok: false, why: 'the run id is missing' };
      if (!isItemKey(raw.item)) return { ok: false, why: 'the item key is invalid' };
      if (!isInt(raw.generation, 1)) return { ok: false, why: 'the generation is not a positive integer' };
      if (!isDefinition(raw.definition)) return { ok: false, why: 'the definition pin is invalid' };
      if (!isText(raw.definitionPath)) return { ok: false, why: 'the definition path is missing' };
      if (typeof raw.target !== 'string') return { ok: false, why: 'the target is missing' };
      if (!isArtifact(raw.artifact)) return { ok: false, why: 'the artifact is invalid' };
      if (!isStringRecord(raw.inputs)) return { ok: false, why: 'the inputs are invalid' };
      if (!isStringRecord(raw.settings)) return { ok: false, why: 'the settings are invalid' };
      if (!isText(raw.initial)) return { ok: false, why: 'the initial state is missing' };
      if (!isJson(raw.start)) return { ok: false, why: 'the start entry is missing' };
      if (!isText(raw.start.state)) return { ok: false, why: 'the start state is missing' };
      if (raw.start.activation !== 1) return { ok: false, why: 'the start activation is not 1' };
      if (!Array.isArray(raw.start.effects) || !raw.start.effects.every(isEffect)) {
        return { ok: false, why: 'a start effect is invalid' };
      }
      break;
    }
    case 'step': {
      if (!isInt(raw.revision, 1)) return { ok: false, why: 'the step revision is not a positive integer' };
      if (!isSignalName(raw.signal)) return { ok: false, why: 'the step signal is not a transition signal' };
      if (!isText(raw.requestId)) return { ok: false, why: 'the step request id is missing' };
      if (!isDigest(raw.requestDigest)) return { ok: false, why: 'the step request digest is invalid' };
      if (!isJson(raw.transition)) return { ok: false, why: 'the step transition is missing' };
      if (!isText(raw.transition.from) || !isText(raw.transition.to)) {
        return { ok: false, why: 'the step transition names no state' };
      }
      if (!isSignalName(raw.transition.on)) return { ok: false, why: 'the step transition signal is invalid' };
      if (!isInt(raw.activation, 2)) return { ok: false, why: 'the step activation is not above the start' };
      if (raw.next !== undefined && !isText(raw.next)) return { ok: false, why: 'the step next state is invalid' };
      if (raw.error !== undefined) {
        if (!isJson(raw.error)) return { ok: false, why: 'the step error move is invalid' };
        if (raw.error.rule !== 'entry-effect-refused') {
          return { ok: false, why: 'the step error rule is invalid' };
        }
        if (
          !isText(raw.error.from) ||
          !isText(raw.error.to) ||
          !isText(raw.error.effect) ||
          !isText(raw.error.occurrence)
        ) {
          return { ok: false, why: 'the step error move is missing its fields' };
        }
      }
      if (!isStringArray(raw.evidence)) return { ok: false, why: 'the step evidence is invalid' };
      if (raw.evidenceRecords !== undefined) {
        if (!isJson(raw.evidenceRecords)) {
          return { ok: false, why: 'the step evidence records are invalid' };
        }
        for (const [ref, entry] of Object.entries(raw.evidenceRecords)) {
          if (ref.length === 0 || !isJson(entry) || !isText(entry.type)) {
            return { ok: false, why: `the step evidence record for "${ref}" is invalid` };
          }
        }
      }
      if (raw.guard !== undefined) {
        if (!isJson(raw.guard)) return { ok: false, why: 'the step guard is invalid' };
        if (!isText(raw.guard.name) || typeof raw.guard.answer !== 'boolean') {
          return { ok: false, why: 'the step guard is invalid' };
        }
        if (!isStringArray(raw.guard.evidence)) return { ok: false, why: 'the step guard evidence is invalid' };
      }
      if (!Array.isArray(raw.effects) || !raw.effects.every(isEffect)) {
        return { ok: false, why: 'a step effect is invalid' };
      }
      break;
    }
    case 'evidence': {
      if (!Array.isArray(raw.entries) || !raw.entries.every(isJson)) {
        return { ok: false, why: 'the evidence entries are invalid' };
      }
      break;
    }
    case 'entry-outcome': {
      if (raw.result !== 'cancelled') return { ok: false, why: 'the entry outcome result is invalid' };
      if (!isText(raw.state) || !isText(raw.effect) || !isText(raw.occurrence)) {
        return { ok: false, why: 'the entry outcome is missing its effect' };
      }
      if (!isInt(raw.activation, 1)) return { ok: false, why: 'the entry outcome activation is invalid' };
      if (raw.why !== undefined && typeof raw.why !== 'string') {
        return { ok: false, why: 'the entry outcome why is invalid' };
      }
      if (raw.by !== undefined && typeof raw.by !== 'string') {
        return { ok: false, why: 'the entry outcome by is invalid' };
      }
      break;
    }
    case 'intent': {
      if (!isText(raw.intentId) || !isText(raw.occurrence)) return { ok: false, why: 'the intent id or occurrence is missing' };
      if (!isInt(raw.attempt, 1)) return { ok: false, why: 'the intent attempt is invalid' };
      if (!isText(raw.receiver) || !isText(raw.messageId) || !isText(raw.leg)) {
        return { ok: false, why: 'the intent receiver, message id or leg is missing' };
      }
      if (!isDigest(raw.payloadDigest)) return { ok: false, why: 'the intent payload digest is invalid' };
      break;
    }
    case 'result': {
      if (!isText(raw.intentId)) return { ok: false, why: 'the result intent id is missing' };
      if (
        raw.outcome !== 'sent' &&
        raw.outcome !== 'refused' &&
        raw.outcome !== 'cancelled' &&
        raw.outcome !== 'reconciled'
      ) {
        return { ok: false, why: 'the result outcome is invalid' };
      }
      for (const field of ['leg', 'messageId', 'why', 'found']) {
        if (raw[field] !== undefined && typeof raw[field] !== 'string') {
          return { ok: false, why: `the result ${field} is invalid` };
        }
      }
      break;
    }
    case 'hold': {
      if (raw.action !== 'reserve' && raw.action !== 'convert' && raw.action !== 'release' && raw.action !== 'renew') {
        return { ok: false, why: 'the hold action is invalid' };
      }
      if (!isHoldRecord(raw.hold)) return { ok: false, why: 'the hold record is invalid' };
      break;
    }
    case 'timer': {
      if (raw.action !== 'arm' && raw.action !== 'fire' && raw.action !== 'cancel') {
        return { ok: false, why: 'the timer action is invalid' };
      }
      if (!isText(raw.timerId)) return { ok: false, why: 'the timer id is missing' };
      if (!TIMER_KINDS.includes(raw.timerKind as LiveTimerKind)) return { ok: false, why: 'the timer kind is invalid' };
      if (raw.state !== undefined && !isText(raw.state)) return { ok: false, why: 'the timer state is invalid' };
      if (raw.activation !== undefined && !isInt(raw.activation, 1)) {
        return { ok: false, why: 'the timer activation is invalid' };
      }
      if (raw.attempt !== undefined && !isInt(raw.attempt, 1)) return { ok: false, why: 'the timer attempt is invalid' };
      if (raw.deadline !== undefined && !isIso(raw.deadline)) return { ok: false, why: 'the timer deadline is invalid' };
      for (const field of ['delivery', 'why']) {
        if (raw[field] !== undefined && typeof raw[field] !== 'string') {
          return { ok: false, why: `the timer ${field} is invalid` };
        }
      }
      break;
    }
    case 'attempt': {
      if (!isText(raw.stage)) return { ok: false, why: 'the attempt stage is missing' };
      if (!isInt(raw.attempt, 1)) return { ok: false, why: 'the attempt number is invalid' };
      break;
    }
    case 'message': {
      if (!isText(raw.messageId)) return { ok: false, why: 'the message id is missing' };
      if (typeof raw.accepted !== 'boolean') return { ok: false, why: 'the message acceptance is invalid' };
      if (raw.thread !== undefined && !isText(raw.thread)) return { ok: false, why: 'the message thread is invalid' };
      if (raw.role !== undefined && !isText(raw.role)) return { ok: false, why: 'the message role is invalid' };
      if (raw.attempt !== undefined && !isInt(raw.attempt, 1)) return { ok: false, why: 'the message attempt is invalid' };
      if (raw.why !== undefined && typeof raw.why !== 'string') return { ok: false, why: 'the message why is invalid' };
      break;
    }
    case 'decision': {
      if (!LIVE_DECISION_KINDS.includes(raw.decision as LiveDecisionKind)) {
        return { ok: false, why: 'the decision kind is invalid' };
      }
      if (raw.stage !== undefined && !isText(raw.stage)) return { ok: false, why: 'the decision stage is invalid' };
      if (raw.attempt !== undefined && !isInt(raw.attempt, 1)) return { ok: false, why: 'the decision attempt is invalid' };
      if (raw.why !== undefined && typeof raw.why !== 'string') return { ok: false, why: 'the decision why is invalid' };
      if (raw.detail !== undefined && !isJson(raw.detail)) return { ok: false, why: 'the decision detail is invalid' };
      break;
    }
    case 'outcome': {
      if (raw.outcome !== 'done' && raw.outcome !== 'failed') return { ok: false, why: 'the outcome is invalid' };
      for (const field of ['why', 'by']) {
        if (raw[field] !== undefined && typeof raw[field] !== 'string') {
          return { ok: false, why: `the outcome ${field} is invalid` };
        }
      }
      break;
    }
    case 'reopen': {
      if (!isText(raw.by)) return { ok: false, why: 'the reopen actor is missing' };
      if (typeof raw.reason !== 'string') return { ok: false, why: 'the reopen reason is invalid' };
      break;
    }
    default:
      return { ok: false, why: `the record kind ${String(record)} is unknown` };
  }
  return { ok: true, record: raw as unknown as LiveRecord };
}
