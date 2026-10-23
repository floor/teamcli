// The WF-MVP run store: the durable item/generation index, the append-only live journals and the
// serialized transactions both sit on. One store-wide lock section in the store root covers every
// mutation, so an item's hold and a receiver's exclusion across items are decided together. The
// index is the exclusion truth and is replaced atomically; the journal is the run's state fold and
// audit. Nothing here dispatches, sends, activates a run or claims the Kernel ledger.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LockBusyError, withLock } from '../../state.ts';
import { canonicalJson, definitionId, occurrenceId } from '../canonical.ts';
import { parseWorkflow } from '../schema.ts';
import type { ArtifactRef, DefinitionId, EvidenceRecord, OccurrenceId, RunId, Workflow } from '../types.ts';
import {
  appendJournal,
  createJournal,
  definitionsDir,
  indexPath,
  journalExists,
  journalPath,
  journalRunIdOf,
  parseJournalText,
  quarantineJournal,
  runsDir,
  writeAtomicMode,
} from './journal.ts';
import {
  LIVE_NOTICE,
  isRunIndex,
  runIdFor,
  validateItemKey,
  type Generation,
  type HoldKind,
  type HoldRecord,
  type ItemKey,
  type ItemRecord,
  type LiveDecisionKind,
  type LiveDecisionRecord,
  type LiveEntryOutcomeRecord,
  type LiveEvidenceRecord,
  type LiveHoldRecord,
  type LiveIntentRecord,
  type LiveMessageRecord,
  type LiveOutcomeRecord,
  type LiveRecord,
  type LiveResultRecord,
  type LiveReopenRecord,
  type LiveRunOpenRecord,
  type LiveState,
  type LiveStatus,
  type LiveStepRecord,
  type LiveTimerKind,
  type LiveTimerRecord,
  type ResultOutcome,
  type RunIndex,
} from './records.ts';
import { foldLive, startEffectsOf, stepFault, type StepInput } from './replay.ts';

export type LiveStoreErrorCode =
  | 'workflow.store.index-corrupt'
  | 'workflow.store.journal-corrupt'
  | 'workflow.store.journal-missing'
  | 'workflow.store.item-key'
  | 'workflow.store.live-run'
  | 'workflow.store.terminal'
  | 'workflow.store.conflict'
  | 'workflow.store.intent-conflict'
  | 'workflow.store.outcome-closed'
  | 'workflow.store.record-invalid'
  | 'workflow.store.busy'
  | 'workflow.store.not-found';

export class LiveStoreError extends Error {
  readonly code: LiveStoreErrorCode;
  readonly why: string;
  readonly path?: string;

  constructor(code: LiveStoreErrorCode, why: string, path?: string) {
    super(`${code}: ${why}`);
    this.name = 'LiveStoreError';
    this.code = code;
    this.why = why;
    if (path !== undefined) this.path = path;
  }
}

export type OpenRunStoreOptions = { root: string; now?: () => number; waitMs?: number };

export type RunSummary = {
  item: ItemKey;
  key: string;
  generation: Generation;
  run: RunId | null;
  status: LiveStatus | 'idle';
  held: boolean;
  hold?: HoldRecord;
};

export type ReadResult =
  | { ok: true; records: LiveRecord[]; live: LiveState }
  | { ok: false; damage: { why: string; seq?: number } };

export type RepairResult =
  | { repaired: true; quarantined: string; why: string }
  | { repaired: false; why?: string };

export type RecoveryResult = {
  recovered: Array<{ run: RunId; action: 'index-added' | 'terminal-adopted' | 'failed-missing-journal' }>;
  corrupt: Array<{ run: RunId; why: string; quarantined: string | null }>;
  pending: Array<{ run: RunId; intentId: string; messageId: string }>;
};

export type CreateRunInput = {
  item: ItemKey;
  definitionBytes: Uint8Array | string;
  definition: Workflow;
  definitionId?: DefinitionId;
  target: string;
  artifact: ArtifactRef;
  inputs: Record<string, string>;
  settings: Record<string, string>;
};

export type CreateRunResult = { record: LiveRunOpenRecord; liveState: LiveState };

export type ReopenInput = { item: ItemKey; by: string; at: string; reason: string };
export type ReopenResult = { record: LiveReopenRecord; appended: boolean; item: ItemRecord };

export type TryHoldInput = {
  item: ItemKey;
  kind: HoldKind;
  owner: string;
  seat: string;
  at: string;
  expiresAt: string;
  run?: RunId;
  attempt?: number;
  thread?: string;
  receiver?: string;
  pane?: string;
};

export type TryHoldReason = 'item-key' | 'run-live' | 'terminal' | 'hold-live' | 'receiver-busy';

export type TryHoldResult =
  | { ok: true; hold: HoldRecord }
  | {
      ok: false;
      reason: TryHoldReason;
      why?: string;
      run?: RunId;
      item?: string;
      hold?: HoldRecord;
    };

export type ConvertHoldInput = {
  item: ItemKey;
  owner: string;
  holder: { seat: string; pane: string };
  messageId: string;
  at: string;
  expect?: { attempt?: number; receiver?: string; thread?: string };
};

export type ConvertHoldReason =
  | 'no-hold'
  | 'owner-mismatch'
  | 'not-reservation'
  | 'already-holder'
  | 'stale-attempt'
  | 'wrong-receiver'
  | 'wrong-thread';

export type ConvertHoldResult =
  | { ok: true; hold: HoldRecord }
  | { ok: false; reason: ConvertHoldReason; hold?: HoldRecord };

export type ReleaseHoldInput = { item: ItemKey; owner: string; at: string };
export type ReleaseHoldResult =
  | { ok: true; hold: HoldRecord }
  | { ok: false; reason: 'no-hold' | 'owner-mismatch'; hold?: HoldRecord };

export type RenewHoldInput = { item: ItemKey; owner: string; expiresAt: string; at: string };
export type RenewHoldResult =
  | { ok: true; hold: HoldRecord }
  | { ok: false; reason: 'no-hold' | 'owner-mismatch' | 'holder'; hold?: HoldRecord };

export type StepRecordInput = StepInput & { at: string };

/** A pending state-entry effect cancelled by a lead stop, before the run ends failed. The state,
 *  activation and occurrence are the store's to derive from the live run. */
export type EntryOutcomeInput = { effect: string; why?: string; by?: string; at: string };

export type IntentInput = {
  intentId: string;
  occurrence: OccurrenceId;
  attempt: number;
  receiver: string;
  messageId: string;
  leg: string;
  payloadDigest: `sha256:${string}`;
  at: string;
};

export type ResultInput = {
  outcome: ResultOutcome;
  leg?: string;
  messageId?: string;
  why?: string;
  found?: string;
  at: string;
};

export type ArmTimerInput = {
  timerId: string;
  kind: LiveTimerKind;
  state: string;
  activation: number;
  attempt: number;
  deadline: string;
  delivery?: string;
  at: string;
};

export type FireTimerInput = {
  timerId: string;
  action: 'resend' | 'release' | 'redispatch' | 'step-failed' | 'nudge';
  at: string;
};

export type CancelTimerInput = { timerId: string; why: string; at: string };

export type AttemptInput = { stage: string; attempt: number; at: string };

export type MessageInput = {
  messageId: string;
  thread?: string;
  attempt?: number;
  role?: string;
  accepted: boolean;
  why?: string;
  at: string;
};

export type DecisionInput = {
  decision: LiveDecisionKind;
  stage?: string;
  attempt?: number;
  why?: string;
  detail?: Record<string, unknown>;
  at: string;
};

export type OutcomeInput = { outcome: 'done' | 'failed'; why?: string; by?: string; at: string };

/** The transaction surface; every method runs inside one store-wide serialized section. */
export type StoreTx = {
  entry(key: string): ItemRecord | null;
  items(): ItemRecord[];
  createRun(input: CreateRunInput): CreateRunResult;
  reopen(input: ReopenInput): ReopenResult;
  tryHold(input: TryHoldInput): TryHoldResult;
  convertHold(input: ConvertHoldInput): ConvertHoldResult;
  releaseHold(input: ReleaseHoldInput): ReleaseHoldResult;
  renewHold(input: RenewHoldInput): RenewHoldResult;
  holds(): HoldRecord[];
  busySeats(): string[];
  appendStep(runId: RunId, step: StepRecordInput): LiveStepRecord;
  appendEvidence(runId: RunId, input: { entries: EvidenceRecord[]; at: string }): LiveEvidenceRecord;
  recordEntryOutcome(runId: RunId, input: EntryOutcomeInput): LiveEntryOutcomeRecord;
  beginIntent(runId: RunId, input: IntentInput): LiveIntentRecord;
  finishIntent(runId: RunId, intentId: string, input: ResultInput): LiveResultRecord;
  armTimer(runId: RunId, input: ArmTimerInput): LiveTimerRecord;
  fireTimer(runId: RunId, input: FireTimerInput): LiveTimerRecord;
  cancelTimer(runId: RunId, input: CancelTimerInput): LiveTimerRecord;
  recordAttempt(runId: RunId, input: AttemptInput): { appended: boolean; attempt: number };
  seeMessage(runId: RunId, input: MessageInput): { duplicate: boolean; record?: LiveMessageRecord };
  appendDecision(runId: RunId, input: DecisionInput): LiveDecisionRecord;
  recordOutcome(runId: RunId, input: OutcomeInput): LiveOutcomeRecord;
  markDamaged(runId: RunId, why: string): void;
  repairJournal(runId: RunId): RepairResult;
  recoverIndex(): RecoveryResult;
};

export type RunStore = {
  readonly root: string;
  transact<T>(work: (tx: StoreTx) => T): T;
  read(runId: RunId): ReadResult;
  repair(runId: RunId): RepairResult;
  liveState(runId: RunId): LiveState;
  list(filter?: { status?: LiveStatus | 'idle' }): RunSummary[];
  entry(keyText: string): ItemRecord | null;
  keyText(item: ItemKey): string | null;
  pendingIntents(runId: RunId): LiveIntentRecord[];
  recover(): RecoveryResult;
};

export function openRunStore(options: OpenRunStoreOptions): RunStore {
  return new Store(options.root, options.now ?? Date.now, options.waitMs ?? 5000);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

class Store implements RunStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly waitMs: number;
  private active = false;

  constructor(root: string, now: () => number, waitMs: number) {
    this.root = root;
    this.now = now;
    this.waitMs = waitMs;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  transact<T>(work: (tx: StoreTx) => T): T {
    if (this.active) {
      throw new LiveStoreError('workflow.store.busy', 'a transaction is already open in this process', this.root);
    }
    this.active = true;
    try {
      return withLock(
        this.root,
        () => {
          const tx = new Transaction(this.root, this.now);
          const result = work(tx);
          tx.commit();
          return result;
        },
        { waitMs: this.waitMs },
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        throw new LiveStoreError('workflow.store.busy', error.message, error.path);
      }
      throw error;
    } finally {
      this.active = false;
    }
  }

  read(runId: RunId): ReadResult {
    const path = journalPath(this.root, runId);
    if (!existsSync(path)) return { ok: false, damage: { why: 'the journal is missing' } };
    const parsed = parseJournalText(readFileSync(path, 'utf8'));
    if (!parsed.ok) return { ok: false, damage: { why: parsed.why } };
    const folded = foldLive(parsed.records);
    if (!folded.ok) {
      return {
        ok: false,
        damage: { why: folded.why, ...(folded.seq !== undefined ? { seq: folded.seq } : {}) },
      };
    }
    return { ok: true, records: parsed.records, live: folded.live };
  }

  repair(runId: RunId): RepairResult {
    return this.transact((tx) => tx.repairJournal(runId));
  }

  liveState(runId: RunId): LiveState {
    const result = this.read(runId);
    if (!result.ok) {
      throw new LiveStoreError('workflow.store.journal-corrupt', result.damage.why, journalPath(this.root, runId));
    }
    return result.live;
  }

  list(filter: { status?: LiveStatus | 'idle' } = {}): RunSummary[] {
    const index = readIndexPure(this.root);
    const nowMs = this.now();
    const summaries: RunSummary[] = [];
    for (const item of Object.values(index.items)) {
      const status: LiveStatus | 'idle' = item.terminal?.outcome ?? (item.live !== undefined ? 'live' : 'idle');
      if (filter.status !== undefined && filter.status !== status) continue;
      const run = item.live ?? item.terminal?.run ?? null;
      const held = item.hold !== undefined && holdIsLive(item.hold, nowMs);
      summaries.push({
        item: item.item,
        key: item.key,
        generation: item.lastGeneration,
        run,
        status,
        held,
        ...(item.hold !== undefined ? { hold: item.hold } : {}),
      });
    }
    return summaries;
  }

  entry(keyText: string): ItemRecord | null {
    return readIndexPure(this.root).items[keyText] ?? null;
  }

  keyText(item: ItemKey): string | null {
    const decided = validateItemKey(item);
    return decided.ok ? decided.key : null;
  }

  pendingIntents(runId: RunId): LiveIntentRecord[] {
    const result = this.read(runId);
    if (!result.ok) {
      throw new LiveStoreError('workflow.store.journal-corrupt', result.damage.why, journalPath(this.root, runId));
    }
    return pendingOf(result.live);
  }

  recover(): RecoveryResult {
    return this.transact((tx) => tx.recoverIndex());
  }
}

function pendingOf(live: LiveState): LiveIntentRecord[] {
  const resolved = new Set<string>();
  for (const result of live.results) resolved.add(result.intentId);
  return live.intents.filter((intent) => !resolved.has(intent.intentId));
}

function emptyIndex(): RunIndex {
  return { format: 1, kind: 'workflow-run-index', items: {} };
}

/** A pure index read: never quarantines, never writes; corruption is an error the caller reports. */
function readIndexPure(root: string): RunIndex {
  const path = indexPath(root);
  if (!existsSync(path)) return emptyIndex();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LiveStoreError('workflow.store.index-corrupt', 'the run index is not JSON', path);
  }
  if (!isRunIndex(raw)) {
    throw new LiveStoreError('workflow.store.index-corrupt', 'the run index has an invalid shape', path);
  }
  return raw;
}

function sameDefinition(left: DefinitionId, right: DefinitionId): boolean {
  return left.workflow === right.workflow && left.schemaVersion === right.schemaVersion && left.digest === right.digest;
}

function holdIsLive(hold: HoldRecord, nowMs: number): boolean {
  if (hold.phase === 'holder') return true;
  if (hold.expiresAt === undefined) return true;
  return Date.parse(hold.expiresAt) > nowMs;
}

function holdSeat(hold: HoldRecord): string {
  return hold.holder?.seat ?? hold.seat;
}

class Transaction implements StoreTx {
  private readonly root: string;
  private readonly now: () => number;
  private index: RunIndex | undefined;
  private dirty = false;
  private readonly pendingJournal: Array<{ run: RunId; make: (seq: number) => LiveRecord }> = [];
  private readonly definitions = new Map<string, Workflow>();

  constructor(root: string, now: () => number) {
    this.root = root;
    this.now = now;
  }

  // ---- index -------------------------------------------------------------------------------

  private ensureIndex(): RunIndex {
    if (this.index !== undefined) return this.index;
    const path = indexPath(this.root);
    if (!existsSync(path)) {
      this.index = emptyIndex();
      return this.index;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      quarantineJournal(path);
      throw new LiveStoreError('workflow.store.index-corrupt', 'the run index is not JSON and was quarantined', path);
    }
    if (!isRunIndex(raw)) {
      quarantineJournal(path);
      throw new LiveStoreError('workflow.store.index-corrupt', 'the run index has an invalid shape and was quarantined', path);
    }
    this.index = raw;
    return raw;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  commit(): void {
    if (this.dirty) {
      const index = this.ensureIndex();
      writeAtomicMode(indexPath(this.root), canonicalJson(index));
      this.dirty = false;
    }
    this.flushJournal();
  }

  /**
   * Hold audit lines are buffered until the index replacement has committed: the index is the
   * exclusion truth and the one commit point, so a crash between the two can only lose an audit
   * line, never leave a journal line claiming a hold the index lacks.
   */
  private flushJournal(): void {
    if (this.pendingJournal.length === 0) return;
    const buffered = [...this.pendingJournal];
    this.pendingJournal.length = 0;
    const seqs = new Map<RunId, number>();
    for (const item of buffered) {
      if (!journalExists(this.root, item.run)) continue;
      let seq = seqs.get(item.run);
      if (seq === undefined) {
        const parsed = parseJournalText(readFileSync(journalPath(this.root, item.run), 'utf8'));
        if (!parsed.ok) continue;
        const folded = foldLive(parsed.records);
        if (!folded.ok) continue;
        seq = folded.live.lastSeq;
      }
      seq += 1;
      seqs.set(item.run, seq);
      appendJournal(journalPath(this.root, item.run), item.make(seq));
    }
  }

  entry(key: string): ItemRecord | null {
    return this.ensureIndex().items[key] ?? null;
  }

  items(): ItemRecord[] {
    return Object.values(this.ensureIndex().items);
  }

  markDamaged(runId: RunId, why: string): void {
    void why;
    const index = this.ensureIndex();
    for (const item of Object.values(index.items)) {
      if (item.live !== runId) continue;
      item.terminal = { run: runId, generation: generationOf(item, runId), outcome: 'failed', at: iso(this.now()) };
      delete item.live;
      this.markDirty();
      return;
    }
  }

  // ---- runs --------------------------------------------------------------------------------

  createRun(input: CreateRunInput): CreateRunResult {
    const keyed = validateItemKey(input.item);
    if (!keyed.ok) throw new LiveStoreError('workflow.store.item-key', keyed.why);
    const key = keyed.key;

    const source =
      typeof input.definitionBytes === 'string'
        ? input.definitionBytes
        : decodeDefinitionBytes(input.definitionBytes);
    if (source === undefined) {
      throw new LiveStoreError('workflow.store.conflict', 'the definition bytes are not UTF-8');
    }
    const parsed = parseWorkflow(source);
    if (!('workflow' in parsed)) {
      throw new LiveStoreError('workflow.store.conflict', 'the definition bytes do not parse');
    }
    const workflow = parsed.workflow;
    const pin = definitionId(workflow, source);
    if (input.definitionId !== undefined && !sameDefinition(input.definitionId, pin)) {
      throw new LiveStoreError('workflow.store.conflict', 'the supplied definition id does not match the bytes');
    }
    if (definitionId(input.definition, source).workflow !== pin.workflow) {
      throw new LiveStoreError('workflow.store.conflict', 'the supplied definition names another workflow');
    }
    const fault = definitionFault(workflow);
    if (fault !== undefined) throw new LiveStoreError('workflow.store.conflict', fault);

    const index = this.ensureIndex();
    const existing = index.items[key];
    if (existing?.live !== undefined) {
      throw new LiveStoreError('workflow.store.live-run', `the item already has a live run ${existing.live}`);
    }
    if (existing?.terminal !== undefined) {
      throw new LiveStoreError('workflow.store.terminal', `the item is held by terminal run ${existing.terminal.run}`);
    }

    const generation = (existing?.lastGeneration ?? 0) + 1;
    const runId = runIdFor(key, generation);
    const start = startEffectsOf(workflow, runId, workflow.initial ?? '', input.target, input.artifact);
    if (!start.ok) throw new LiveStoreError('workflow.store.conflict', start.why);

    const definitionPath = `definitions/${pin.digest.slice('sha256:'.length)}.yaml`;
    const absolute = join(this.root, definitionPath);
    mkdirSync(definitionsDir(this.root), { recursive: true, mode: 0o700 });
    const bytes = typeof input.definitionBytes === 'string' ? new TextEncoder().encode(source) : input.definitionBytes;
    if (existsSync(absolute)) {
      const held = readFileSync(absolute);
      if (!Buffer.from(bytes).equals(held)) {
        throw new LiveStoreError('workflow.store.conflict', 'the definition file already holds different bytes', absolute);
      }
    } else {
      writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
    }

    const record: LiveRunOpenRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: 1,
      at: iso(this.now()),
      record: 'run-open',
      notice: LIVE_NOTICE,
      run: runId,
      item: input.item,
      generation,
      definition: pin,
      definitionPath,
      target: input.target,
      artifact: input.artifact,
      inputs: { ...input.inputs },
      settings: { ...input.settings },
      initial: workflow.initial ?? '',
      start: { state: workflow.initial ?? '', activation: 1, effects: start.effects },
    };
    const path = journalPath(this.root, runId);
    if (existsSync(path)) {
      throw new LiveStoreError('workflow.store.conflict', 'the journal already exists', path);
    }
    createJournal(path, record);

    index.items[key] = {
      item: input.item,
      key,
      lastGeneration: generation,
      live: runId,
      ...(existing?.reopened !== undefined ? { reopened: existing.reopened } : {}),
      ...(existing?.hold !== undefined ? { hold: existing.hold } : {}),
    };
    this.markDirty();

    const folded = foldLive([record]);
    if (!folded.ok) throw new LiveStoreError('workflow.store.conflict', folded.why);
    return { record, liveState: folded.live };
  }

  reopen(input: ReopenInput): ReopenResult {
    const keyed = validateItemKey(input.item);
    if (!keyed.ok) throw new LiveStoreError('workflow.store.item-key', keyed.why);
    const item = this.ensureIndex().items[keyed.key];
    if (item === undefined) throw new LiveStoreError('workflow.store.not-found', 'the item has no run record');
    if (item.live !== undefined) {
      throw new LiveStoreError('workflow.store.conflict', `the item has a live run ${item.live}`);
    }
    const terminal = item.terminal;
    if (terminal === undefined) throw new LiveStoreError('workflow.store.conflict', 'the item has no terminal run to reopen');

    item.terminal = undefined;
    item.reopened = { by: input.by, at: input.at, reason: input.reason };
    this.markDirty();

    if (journalExists(this.root, terminal.run)) {
      const parsed = parseJournalText(readFileSync(journalPath(this.root, terminal.run), 'utf8'));
      if (parsed.ok) {
        const folded = foldLive(parsed.records);
        if (folded.ok) {
          const record: LiveReopenRecord = {
            format: 1,
            kind: 'workflow-run-live',
            authoritative: true,
            seq: folded.live.lastSeq + 1,
            at: input.at,
            record: 'reopen',
            by: input.by,
            reason: input.reason,
          };
          appendJournal(journalPath(this.root, terminal.run), record);
          return { record, appended: true, item };
        }
      }
    }
    const record: LiveReopenRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: 0,
      at: input.at,
      record: 'reopen',
      by: input.by,
      reason: input.reason,
    };
    return { record, appended: false, item };
  }

  // ---- holds -------------------------------------------------------------------------------

  tryHold(input: TryHoldInput): TryHoldResult {
    const keyed = validateItemKey(input.item);
    if (!keyed.ok) return { ok: false, reason: 'item-key', why: keyed.why };
    const key = keyed.key;
    const index = this.ensureIndex();
    const item = index.items[key];
    const nowMs = this.now();

    if (item?.live !== undefined && input.run !== item.live) {
      return { ok: false, reason: 'run-live', run: item.live };
    }
    if (item?.terminal !== undefined) {
      return { ok: false, reason: 'terminal', run: item.terminal.run };
    }
    const existing = item?.hold;
    if (existing !== undefined && holdIsLive(existing, nowMs)) {
      if (existing.owner === input.owner && existing.kind === input.kind) {
        // Idempotent retry: the hold already committed; ensuring its audit line is present is safe
        // because the fold accepts an identical repeated reservation.
        this.queueHoldAudit(existing.run, 'reserve', existing, input.at);
        return { ok: true, hold: existing };
      }
      return { ok: false, reason: 'hold-live', hold: existing };
    }

    // One seat works one item: a live hold of either kind excludes its seat from any other item,
    // so a seat holding or reserving one item can neither reserve nor next-claim another.
    const seat = input.seat;
    for (const candidate of Object.values(index.items)) {
      if (candidate.key === key) continue;
      const hold = candidate.hold;
      if (hold === undefined || !holdIsLive(hold, nowMs)) continue;
      if (holdSeat(hold) === seat) {
        return { ok: false, reason: 'receiver-busy', item: candidate.key, hold };
      }
    }

    const hold: HoldRecord = {
      kind: input.kind,
      item: key,
      owner: input.owner,
      seat: input.seat,
      phase: 'pending',
      at: input.at,
      expiresAt: input.expiresAt,
      ...(input.run !== undefined ? { run: input.run } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
      ...(input.receiver !== undefined ? { receiver: input.receiver } : {}),
      ...(input.pane !== undefined ? { pane: input.pane } : {}),
    };
    const record = item ?? { item: input.item, key, lastGeneration: 0 };
    record.hold = hold;
    index.items[key] = record;
    this.markDirty();
    if (existing !== undefined) this.queueHoldAudit(existing.run, 'release', existing, input.at);
    this.queueHoldAudit(hold.run, 'reserve', hold, input.at);
    return { ok: true, hold };
  }

  convertHold(input: ConvertHoldInput): ConvertHoldResult {
    const keyed = validateItemKey(input.item);
    if (!keyed.ok) throw new LiveStoreError('workflow.store.item-key', keyed.why);
    const item = this.ensureIndex().items[keyed.key];
    const hold = item?.hold;
    if (item === undefined || hold === undefined) return { ok: false, reason: 'no-hold' };
    if (hold.owner !== input.owner) return { ok: false, reason: 'owner-mismatch', hold };
    if (hold.kind !== 'reservation') return { ok: false, reason: 'not-reservation', hold };
    if (hold.phase === 'holder') return { ok: false, reason: 'already-holder', hold };
    const expect = input.expect;
    if (expect?.attempt !== undefined && hold.attempt !== expect.attempt) {
      return { ok: false, reason: 'stale-attempt', hold };
    }
    if (expect?.receiver !== undefined && hold.receiver !== expect.receiver) {
      return { ok: false, reason: 'wrong-receiver', hold };
    }
    if (expect?.thread !== undefined && hold.thread !== expect.thread) {
      return { ok: false, reason: 'wrong-thread', hold };
    }

    const converted: HoldRecord = {
      kind: hold.kind,
      item: hold.item,
      owner: hold.owner,
      seat: hold.seat,
      phase: 'holder',
      at: input.at,
      ...(hold.run !== undefined ? { run: hold.run } : {}),
      ...(hold.attempt !== undefined ? { attempt: hold.attempt } : {}),
      ...(hold.thread !== undefined ? { thread: hold.thread } : {}),
      ...(hold.receiver !== undefined ? { receiver: hold.receiver } : {}),
      ...(hold.pane !== undefined ? { pane: hold.pane } : {}),
      holder: { seat: input.holder.seat, pane: input.holder.pane },
      messageId: input.messageId,
    };
    item.hold = converted;
    this.markDirty();
    this.queueHoldAudit(converted.run, 'convert', converted, input.at);
    return { ok: true, hold: converted };
  }

  releaseHold(input: ReleaseHoldInput): ReleaseHoldResult {
    const keyed = validateItemKey(input.item);
    if (!keyed.ok) throw new LiveStoreError('workflow.store.item-key', keyed.why);
    const item = this.ensureIndex().items[keyed.key];
    const hold = item?.hold;
    if (item === undefined || hold === undefined) return { ok: false, reason: 'no-hold' };
    if (hold.owner !== input.owner) return { ok: false, reason: 'owner-mismatch', hold };
    delete item.hold;
    this.markDirty();
    this.queueHoldAudit(hold.run, 'release', hold, input.at);
    return { ok: true, hold };
  }

  renewHold(input: RenewHoldInput): RenewHoldResult {
    const keyed = validateItemKey(input.item);
    if (!keyed.ok) throw new LiveStoreError('workflow.store.item-key', keyed.why);
    const item = this.ensureIndex().items[keyed.key];
    const hold = item?.hold;
    if (item === undefined || hold === undefined) return { ok: false, reason: 'no-hold' };
    if (hold.owner !== input.owner) return { ok: false, reason: 'owner-mismatch', hold };
    if (hold.phase === 'holder') return { ok: false, reason: 'holder', hold };
    const renewed: HoldRecord = { ...hold, at: input.at, expiresAt: input.expiresAt };
    item.hold = renewed;
    this.markDirty();
    this.queueHoldAudit(renewed.run, 'renew', renewed, input.at);
    return { ok: true, hold: renewed };
  }

  private queueHoldAudit(run: RunId | undefined, action: LiveHoldRecord['action'], hold: HoldRecord, at: string): void {
    if (run === undefined) return;
    this.pendingJournal.push({ run, make: (seq) => holdRecord(seq, action, hold, at) });
  }

  holds(): HoldRecord[] {
    return this.items()
      .map((item) => item.hold)
      .filter((hold): hold is HoldRecord => hold !== undefined);
  }

  busySeats(): string[] {
    const nowMs = this.now();
    const seats = new Set<string>();
    for (const hold of this.holds()) {
      if (!holdIsLive(hold, nowMs)) continue;
      seats.add(holdSeat(hold));
    }
    return [...seats].sort();
  }

  // ---- journal appends ---------------------------------------------------------------------

  appendStep(runId: RunId, step: StepRecordInput): LiveStepRecord {
    const run = this.runForAppend(runId);
    if (run.live.status !== 'live') {
      throw new LiveStoreError('workflow.store.outcome-closed', `the run ended ${run.live.status}`, run.path);
    }
    const open = run.open;
    const definition = this.definitionOf(open);
    const fault = stepFault({
      definition,
      runId,
      target: open.target,
      artifact: open.artifact,
      state: run.live.state,
      previousRevision: run.live.revision,
      previousActivation: run.live.activation,
      step,
    });
    if (fault !== undefined) throw new LiveStoreError('workflow.store.record-invalid', fault);
    if (step.evidence.length > 0) {
      const records = step.evidenceRecords;
      if (records === undefined) {
        throw new LiveStoreError(
          'workflow.store.record-invalid',
          'the step cites evidence but records no evidence records',
          run.path,
        );
      }
      for (const ref of step.evidence) {
        if (!Object.prototype.hasOwnProperty.call(records, ref)) {
          throw new LiveStoreError(
            'workflow.store.record-invalid',
            `the step cites evidence "${ref}" but records no record for it`,
            run.path,
          );
        }
      }
    }
    const record: LiveStepRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: step.at,
      record: 'step',
      revision: step.revision,
      signal: step.signal,
      requestId: step.requestId,
      requestDigest: step.requestDigest,
      transition: step.transition,
      activation: step.activation,
      ...(step.next !== undefined ? { next: step.next } : {}),
      ...(step.error !== undefined ? { error: step.error } : {}),
      evidence: [...step.evidence],
      ...(step.evidenceRecords !== undefined ? { evidenceRecords: step.evidenceRecords } : {}),
      ...(step.guard !== undefined ? { guard: step.guard } : {}),
      effects: step.effects,
    };
    appendJournal(run.path, record);
    return record;
  }

  appendEvidence(runId: RunId, input: { entries: EvidenceRecord[]; at: string }): LiveEvidenceRecord {
    const run = this.runForAppend(runId);
    const record: LiveEvidenceRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'evidence',
      entries: input.entries,
    };
    appendJournal(run.path, record);
    return record;
  }

  recordEntryOutcome(runId: RunId, input: EntryOutcomeInput): LiveEntryOutcomeRecord {
    const run = this.runForAppend(runId);
    if (run.live.status !== 'live') {
      throw new LiveStoreError('workflow.store.outcome-closed', `the run ended ${run.live.status}`, run.path);
    }
    const definition = this.definitionOf(run.open);
    const state = run.live.state;
    const declared = definition.states[state];
    if (declared === undefined || !(declared.onEnter ?? []).some((hook) => hook.name === input.effect)) {
      throw new LiveStoreError(
        'workflow.store.record-invalid',
        `"${input.effect}" is not an entry effect of "${state}"`,
        run.path,
      );
    }
    const record: LiveEntryOutcomeRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'entry-outcome',
      result: 'cancelled',
      state,
      activation: run.live.activation,
      effect: input.effect,
      occurrence: occurrenceId(runId, run.live.activation, input.effect),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
    };
    appendJournal(run.path, record);
    return record;
  }

  beginIntent(runId: RunId, input: IntentInput): LiveIntentRecord {
    const run = this.runForAppend(runId);
    if (run.live.status !== 'live') {
      throw new LiveStoreError('workflow.store.outcome-closed', `the run ended ${run.live.status}`, run.path);
    }
    const existing = run.live.intents.find((intent) => intent.intentId === input.intentId);
    const record: LiveIntentRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'intent',
      intentId: input.intentId,
      occurrence: input.occurrence,
      attempt: input.attempt,
      receiver: input.receiver,
      messageId: input.messageId,
      leg: input.leg,
      payloadDigest: input.payloadDigest,
    };
    if (existing !== undefined) {
      if (intentBytes(existing) !== intentBytes(record)) {
        throw new LiveStoreError(
          'workflow.store.intent-conflict',
          `intent ${input.intentId} is already recorded with different bytes`,
          run.path,
        );
      }
      return existing;
    }
    appendJournal(run.path, record);
    return record;
  }

  finishIntent(runId: RunId, intentId: string, input: ResultInput): LiveResultRecord {
    const run = this.runForAppend(runId);
    const intent = run.live.intents.find((candidate) => candidate.intentId === intentId);
    if (intent === undefined) {
      throw new LiveStoreError('workflow.store.not-found', `intent ${intentId} is not recorded`, run.path);
    }
    const record: LiveResultRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'result',
      intentId,
      outcome: input.outcome,
      ...(input.leg !== undefined ? { leg: input.leg } : {}),
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.found !== undefined ? { found: input.found } : {}),
    };
    const existing = run.live.results.find((candidate) => candidate.intentId === intentId);
    if (existing !== undefined) {
      if (resultBytes(existing) !== resultBytes(record)) {
        throw new LiveStoreError(
          'workflow.store.conflict',
          `intent ${intentId} already has a different result`,
          run.path,
        );
      }
      return existing;
    }
    appendJournal(run.path, record);
    return record;
  }

  armTimer(runId: RunId, input: ArmTimerInput): LiveTimerRecord {
    const run = this.runForAppend(runId);
    const record: LiveTimerRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'timer',
      action: 'arm',
      timerId: input.timerId,
      timerKind: input.kind,
      state: input.state,
      activation: input.activation,
      attempt: input.attempt,
      deadline: input.deadline,
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    };
    appendJournal(run.path, record);
    return record;
  }

  fireTimer(runId: RunId, input: FireTimerInput): LiveTimerRecord {
    const run = this.runForAppend(runId);
    const armed = run.live.timers.find((timer) => timer.timerId === input.timerId);
    if (armed === undefined) {
      throw new LiveStoreError('workflow.store.not-found', `timer ${input.timerId} is not armed`, run.path);
    }
    const record: LiveTimerRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'timer',
      action: 'fire',
      timerId: input.timerId,
      timerKind: armed.timerKind,
      ...(armed.state !== undefined ? { state: armed.state } : {}),
      ...(armed.activation !== undefined ? { activation: armed.activation } : {}),
      ...(armed.attempt !== undefined ? { attempt: armed.attempt } : {}),
      ...(armed.deadline !== undefined ? { deadline: armed.deadline } : {}),
      ...(armed.delivery !== undefined ? { delivery: armed.delivery } : {}),
      why: input.action,
    };
    appendJournal(run.path, record);
    return record;
  }

  cancelTimer(runId: RunId, input: CancelTimerInput): LiveTimerRecord {
    const run = this.runForAppend(runId);
    const armed = run.live.timers.find((timer) => timer.timerId === input.timerId);
    if (armed === undefined) {
      throw new LiveStoreError('workflow.store.not-found', `timer ${input.timerId} is not armed`, run.path);
    }
    const record: LiveTimerRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'timer',
      action: 'cancel',
      timerId: input.timerId,
      timerKind: armed.timerKind,
      ...(armed.state !== undefined ? { state: armed.state } : {}),
      ...(armed.activation !== undefined ? { activation: armed.activation } : {}),
      ...(armed.attempt !== undefined ? { attempt: armed.attempt } : {}),
      ...(armed.deadline !== undefined ? { deadline: armed.deadline } : {}),
      ...(armed.delivery !== undefined ? { delivery: armed.delivery } : {}),
      why: input.why,
    };
    appendJournal(run.path, record);
    return record;
  }

  recordAttempt(runId: RunId, input: AttemptInput): { appended: boolean; attempt: number } {
    const run = this.runForAppend(runId);
    const current = run.live.attempts[input.stage];
    if (current !== undefined && input.attempt === current) return { appended: false, attempt: current };
    if (current !== undefined && input.attempt < current) {
      throw new LiveStoreError(
        'workflow.store.conflict',
        `attempt for ${input.stage} would fall from ${current} to ${input.attempt}`,
        run.path,
      );
    }
    const record: LiveAttemptRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'attempt',
      stage: input.stage,
      attempt: input.attempt,
    };
    appendJournal(run.path, record);
    return { appended: true, attempt: input.attempt };
  }

  seeMessage(runId: RunId, input: MessageInput): { duplicate: boolean; record?: LiveMessageRecord } {
    const run = this.runForAppend(runId);
    if (run.live.messages.some((message) => message.messageId === input.messageId)) {
      return { duplicate: true };
    }
    const record: LiveMessageRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'message',
      messageId: input.messageId,
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      accepted: input.accepted,
      ...(input.why !== undefined ? { why: input.why } : {}),
    };
    appendJournal(run.path, record);
    return { duplicate: false, record };
  }

  appendDecision(runId: RunId, input: DecisionInput): LiveDecisionRecord {
    const run = this.runForAppend(runId);
    const record: LiveDecisionRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq: run.live.lastSeq + 1,
      at: input.at,
      record: 'decision',
      decision: input.decision,
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    appendJournal(run.path, record);
    return record;
  }

  recordOutcome(runId: RunId, input: OutcomeInput): LiveOutcomeRecord {
    const run = this.runForAppend(runId);
    if (run.live.status !== 'live') {
      throw new LiveStoreError('workflow.store.outcome-closed', `the run already ended ${run.live.status}`, run.path);
    }
    let seq = run.live.lastSeq + 1;
    const item = Object.values(this.ensureIndex().items).find((candidate) => candidate.live === runId);
    const hold = item?.hold;
    if (hold !== undefined && hold.run === runId) {
      appendJournal(run.path, holdRecord(seq, 'release', hold, input.at));
      seq += 1;
      delete item!.hold;
    }
    const record: LiveOutcomeRecord = {
      format: 1,
      kind: 'workflow-run-live',
      authoritative: true,
      seq,
      at: input.at,
      record: 'outcome',
      outcome: input.outcome,
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
    };
    appendJournal(run.path, record);

    if (item !== undefined) {
      item.terminal = {
        run: runId,
        generation: run.open.generation,
        outcome: input.outcome,
        at: input.at,
      };
      delete item.live;
      this.markDirty();
    }
    return record;
  }

  // ---- repair and recovery -----------------------------------------------------------------

  repairJournal(runId: RunId): RepairResult {
    const path = journalPath(this.root, runId);
    if (!existsSync(path)) return { repaired: false, why: 'the journal is missing' };
    const parsed = parseJournalText(readFileSync(path, 'utf8'));
    if (parsed.ok) {
      const folded = foldLive(parsed.records);
      if (folded.ok) return { repaired: false };
      return this.damage(runId, path, folded.why);
    }
    return this.damage(runId, path, parsed.why);
  }

  private damage(runId: RunId, path: string, why: string): RepairResult {
    const quarantined = quarantineJournal(path);
    this.markDamaged(runId, why);
    return { repaired: true, quarantined, why };
  }

  recoverIndex(): RecoveryResult {
    const result: RecoveryResult = { recovered: [], corrupt: [], pending: [] };
    const index = this.ensureIndex();
    const directory = runsDir(this.root);
    const files = existsSync(directory) ? readdirSync(directory) : [];
    const seen = new Set<RunId>();

    for (const file of files) {
      const runId = journalRunIdOf(file);
      if (runId === undefined) {
        result.corrupt.push({ run: file, why: 'the file is not a run journal', quarantined: null });
        continue;
      }
      const path = join(directory, file);
      const parsed = parseJournalText(readFileSync(path, 'utf8'));
      if (!parsed.ok) {
        result.corrupt.push({ run: runId, why: parsed.why, quarantined: quarantineJournal(path) });
        this.markDamaged(runId, parsed.why);
        continue;
      }
      const folded = foldLive(parsed.records);
      if (!folded.ok) {
        result.corrupt.push({ run: runId, why: folded.why, quarantined: quarantineJournal(path) });
        this.markDamaged(runId, folded.why);
        continue;
      }
      const live = folded.live;
      seen.add(runId);
      const keyed = validateItemKey(live.item);
      if (!keyed.ok) {
        result.corrupt.push({ run: runId, why: 'the run-open item key is invalid', quarantined: null });
        continue;
      }
      const entry = index.items[keyed.key];
      if (entry === undefined) {
        index.items[keyed.key] = {
          item: live.item,
          key: keyed.key,
          lastGeneration: live.generation,
          ...(live.status === 'live'
            ? { live: runId }
            : {
                terminal: {
                  run: runId,
                  generation: live.generation,
                  outcome: live.status,
                  at: live.outcome?.at ?? iso(this.now()),
                },
              }),
        };
        this.markDirty();
        result.recovered.push({ run: runId, action: 'index-added' });
      } else {
        if (entry.lastGeneration < live.generation) {
          entry.lastGeneration = live.generation;
          this.markDirty();
        }
        if (entry.live === runId && live.status !== 'live') {
          entry.terminal = {
            run: runId,
            generation: live.generation,
            outcome: live.status,
            at: live.outcome?.at ?? iso(this.now()),
          };
          delete entry.live;
          // A finished run cannot keep a seat excluded: its hold goes with the terminal outcome.
          delete entry.hold;
          this.markDirty();
          result.recovered.push({ run: runId, action: 'terminal-adopted' });
        } else if (entry.live === undefined && entry.terminal === undefined && live.status === 'live') {
          entry.live = runId;
          this.markDirty();
          result.recovered.push({ run: runId, action: 'index-added' });
        }
      }
      for (const intent of pendingOf(live)) {
        result.pending.push({ run: runId, intentId: intent.intentId, messageId: intent.messageId });
      }
    }

    for (const item of Object.values(index.items)) {
      if (item.live === undefined) continue;
      if (journalExists(this.root, item.live)) continue;
      const run = item.live;
      item.terminal = { run, generation: generationOf(item, run), outcome: 'failed', at: iso(this.now()) };
      delete item.live;
      this.markDirty();
      result.recovered.push({ run, action: 'failed-missing-journal' });
      result.corrupt.push({ run, why: 'the journal is missing', quarantined: null });
    }
    return result;
  }

  // ---- internals ---------------------------------------------------------------------------

  private runForAppend(runId: RunId): { path: string; live: LiveState; open: LiveRunOpenRecord } {
    const path = journalPath(this.root, runId);
    if (!existsSync(path)) {
      throw new LiveStoreError('workflow.store.journal-missing', 'the run journal is missing', path);
    }
    const parsed = parseJournalText(readFileSync(path, 'utf8'));
    if (!parsed.ok) throw new LiveStoreError('workflow.store.journal-corrupt', parsed.why, path);
    const folded = foldLive(parsed.records);
    if (!folded.ok) throw new LiveStoreError('workflow.store.journal-corrupt', folded.why, path);
    const open = parsed.records[0];
    if (open === undefined || open.record !== 'run-open') {
      throw new LiveStoreError('workflow.store.journal-corrupt', 'the journal has no run-open record', path);
    }
    return { path, live: folded.live, open };
  }

  private definitionOf(open: LiveRunOpenRecord): Workflow {
    const cached = this.definitions.get(open.definition.digest);
    if (cached !== undefined) return cached;
    if (!open.definitionPath.startsWith('definitions/') || open.definitionPath.includes('..')) {
      throw new LiveStoreError('workflow.store.conflict', 'the pinned definition path escapes the store');
    }
    const path = join(this.root, open.definitionPath);
    if (!existsSync(path)) {
      throw new LiveStoreError('workflow.store.conflict', 'the pinned definition bytes are missing', path);
    }
    const text = readFileSync(path, 'utf8');
    const parsed = parseWorkflow(text);
    if (!('workflow' in parsed)) {
      throw new LiveStoreError('workflow.store.conflict', 'the pinned definition does not parse', path);
    }
    const pin = definitionId(parsed.workflow, text);
    if (!sameDefinition(pin, open.definition)) {
      throw new LiveStoreError('workflow.store.conflict', 'the pinned definition bytes do not match the run pin', path);
    }
    this.definitions.set(open.definition.digest, parsed.workflow);
    return parsed.workflow;
  }
}

type LiveAttemptRecord = Extract<LiveRecord, { record: 'attempt' }>;

function holdRecord(seq: number, action: LiveHoldRecord['action'], hold: HoldRecord, at: string): LiveHoldRecord {
  return {
    format: 1,
    kind: 'workflow-run-live',
    authoritative: true,
    seq,
    at,
    record: 'hold',
    action,
    hold,
  };
}

function intentBytes(record: LiveIntentRecord): string {
  return canonicalJson({
    intentId: record.intentId,
    occurrence: record.occurrence,
    attempt: record.attempt,
    receiver: record.receiver,
    messageId: record.messageId,
    leg: record.leg,
    payloadDigest: record.payloadDigest,
  });
}

function resultBytes(record: LiveResultRecord): string {
  return canonicalJson({
    intentId: record.intentId,
    outcome: record.outcome,
    leg: record.leg,
    messageId: record.messageId,
    why: record.why,
    found: record.found,
  });
}

function generationOf(item: ItemRecord, runId: RunId): Generation {
  const match = /-(\d+)$/.exec(runId);
  const parsed = match === null ? Number.NaN : Number.parseInt(match[1]!, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : item.lastGeneration;
}

function definitionFault(definition: Workflow): string | undefined {
  if (definition.version !== 1) return 'the definition is not schema version 1';
  if (definition.name === '') return 'the definition has no name';
  if (definition.initial === undefined) return 'the definition declares no initial state';
  if (definition.states[definition.initial] === undefined) {
    return `state "${definition.initial}" is not declared`;
  }
  if (definition.error !== undefined && definition.states[definition.error] === undefined) {
    return `error state "${definition.error}" is not declared`;
  }
  for (const hook of definition.states[definition.initial]!.onEnter) {
    if (definition.effects[hook.name] === undefined) return `effect "${hook.name}" is not declared`;
  }
  return undefined;
}

function decodeDefinitionBytes(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
