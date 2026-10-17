import type { Io } from '../io.ts';
import { whoOfDifference, type DifferenceWho, type OutputDifference } from './text.ts';

/** Top-level schema identifier required on every 0.5.0 `--json` document. */
export interface OutputSchemaTag {
  name: string;
  version: number;
}

export type JsonEnvelope<T extends Record<string, unknown>> = {
  schema: OutputSchemaTag;
} & T;

export interface JsonErrorPayload {
  id: string;
  message: string;
  repair: string | null;
}

export interface JsonErrorEnvelope {
  schema: OutputSchemaTag;
  error: JsonErrorPayload;
}

export interface JsonDifference {
  what: string;
  repair: string;
  who: DifferenceWho;
}

/** Normalizes a difference for JSON output, including `what`, `repair`, and `who`. */
export function toJsonDifference(diff: OutputDifference): JsonDifference {
  return {
    what: diff.what,
    repair: diff.repair,
    who: whoOfDifference(diff),
  };
}

/** Wraps a JSON payload with the top-level `schema: { name, version }` tag. */
export function jsonEnvelope<T extends Record<string, unknown>>(
  schemaName: string,
  payload: T,
  version = 1,
): JsonEnvelope<T> {
  return {
    schema: { name: schemaName, version },
    ...payload,
  };
}

/** Writes a pretty-printed `--json` envelope to `io.stdout`. */
export function writeJson<T extends Record<string, unknown>>(
  io: Pick<Io, 'stdout'>,
  schemaName: string,
  payload: T,
  version = 1,
): void {
  const doc = jsonEnvelope(schemaName, payload, version);
  io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
}

/** Builds a structured `--json` error document (`{"schema": {"name": "team.error", "version": 1}, "error": {"id", "message", "repair"}}`). */
export function jsonError(
  id: string,
  message: string,
  repair: string | null = null,
  version = 1,
): JsonErrorEnvelope {
  return {
    schema: { name: 'team.error', version },
    error: {
      id,
      message,
      repair,
    },
  };
}

/** Writes a structured `--json` error document to `io.stdout`. */
export function writeJsonError(
  io: Pick<Io, 'stdout'>,
  id: string,
  message: string,
  repair: string | null = null,
  version = 1,
): void {
  io.stdout(`${JSON.stringify(jsonError(id, message, repair, version), null, 2)}\n`);
}
