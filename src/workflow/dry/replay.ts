// WF1-DRY: the pure dry replay entry point. It reads the journal text with the shared reader,
// refuses a graph with a reachable `uses:` (slice 1's boundary), and hands the immutable inputs to
// the replay fold. It adds no step, dispatches nothing and reads no clock, file, bus or ledger.

import { decide } from '../core.ts';
import type { RunState } from '../core-state.ts';
import type { GuardCatalogue } from '../registry.ts';
import { readJournal, replay } from '../replay.ts';
import type { ReplayFailure, ReplayFailureCode } from '../replay.ts';
import type { EvidenceDocument, Workflow } from '../types.ts';
import { reachableUses, usesDeferredWhy } from './run.ts';

export type DryReplayInput = {
  /** The definition file's bytes; the digest is SHA-256 over CRLF-normalized UTF-8. */
  definitionBytes: Uint8Array;
  /** The parsed definition from the same file. */
  definition: Workflow;
  /** The journal document as JSON text; the reader refuses malformed or non-authoritative input. */
  journalText: string;
  /** The standalone ref → fixture document; supplied, never verified. */
  evidence: EvidenceDocument;
  /** The guard catalogue the runner used; guards read supplied evidence only. */
  guards: GuardCatalogue;
};

export type DryReplayResult =
  | { ok: true; run: RunState; exit: 0 }
  | { ok: false; fail: ReplayFailure; exit: 1 };

/** Re-evaluate a dry journal against the pinned definition and supplied evidence. */
export function dryReplay(input: DryReplayInput): DryReplayResult {
  const read = readJournal(input.journalText);
  if (!read.ok) return failed(read.code, read.why);

  const source = decodeDefinition(input.definitionBytes);
  if (source === undefined) {
    return failed('workflow.definition', 'the definition file is not valid UTF-8');
  }

  // Slice 1 refuses a graph with a reachable `uses:` before any step is read. The journal of such
  // a run is a refusal document, not a replayable history; the typed failure names the reason.
  const initial = input.definition.initial ?? read.journal.initial;
  const deferred = reachableUses(input.definition, initial);
  if (deferred !== undefined) return failed('workflow.uses-deferred', usesDeferredWhy(deferred));

  const result = replay({
    definitionBytes: input.definitionBytes,
    definition: input.definition,
    journal: read.journal,
    evidence: input.evidence,
    guards: input.guards,
    decide,
  });
  return result.ok
    ? { ok: true, run: result.run, exit: 0 }
    : { ok: false, fail: result.fail, exit: 1 };
}

function decodeDefinition(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM keeps the bytes the digest is over; the parser received the same text.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function failed(code: ReplayFailureCode, why: string): DryReplayResult {
  return { ok: false, fail: { code, why }, exit: 1 };
}
