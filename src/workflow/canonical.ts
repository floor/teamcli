// The one canonical spelling of a request/effect payload and of the identities derived from it.
// Sorted keys, no whitespace, UTF-8: two runs that mean the same bytes produce the same digest.

import { createHash } from 'node:crypto';
import type {
  ArtifactRef,
  DefinitionId,
  OccurrenceId,
  RunId,
  Workflow,
  WorkflowEnvelope,
} from './types.ts';

/** Serialize a JSON value with recursively sorted keys and no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      sorted[key] = sortValue(item);
    }
    return sorted;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
}

/** The one activation allocator: a monotonically increasing per-run state-entry counter. */
export function nextActivation(activation: number): number {
  return activation + 1;
}

export function occurrenceId(run: RunId, activation: number, effect: string): OccurrenceId {
  return `${run}/${activation}/${effect}`;
}

/**
 * Request identity is exactly these four fields. `operation` moves name only their operation,
 * and revision/head/request id are preconditions, so target and artifact have one home.
 */
export function canonicalRequestPayload(
  req: Pick<WorkflowEnvelope, 'move' | 'target' | 'artifact' | 'evidence'>,
): string {
  return canonicalJson({ move: req.move, target: req.target, artifact: req.artifact, evidence: req.evidence });
}

export function canonicalEffectPayload(
  effect: string,
  operation: string,
  target: string,
  artifact: ArtifactRef,
): string {
  return canonicalJson({ effect, operation, target, artifact });
}

export function payloadDigest(canonical: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** The definition pin: SHA-256 over the file bytes, CRLF normalized to LF, comments included. */
export function definitionDigest(source: string): `sha256:${string}` {
  return payloadDigest(source.replace(/\r\n/g, '\n'));
}

export function definitionId(workflow: Workflow, source: string): DefinitionId {
  return { workflow: workflow.name, schemaVersion: 1, digest: definitionDigest(source) };
}
