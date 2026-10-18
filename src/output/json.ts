import type { Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { whoOfDifference, type DifferenceWho, type OutputDifference, type PlanStep } from './text.ts';

/** Top-level schema identifier required on every 0.5.0 `--json` document. */
export interface OutputSchemaTag {
  name: string;
  version: number;
}

export type JsonEnvelope<T extends Record<string, unknown>> = Omit<T, 'schema'> & {
  schema: OutputSchemaTag;
};

export interface JsonErrorPayload {
  id: string;
  message: string;
  repair: string | null;
  /** Optional permission resolver rule id (`PermissionRule` from `src/permissions/resolve.ts`, e.g. `'no-record'`, `'owner-only'`, `'owner-or-leads'`, `'outside-envelope'`). */
  rule?: string | null;
}

export interface JsonErrorEnvelope {
  schema: OutputSchemaTag;
  error: JsonErrorPayload;
  /** Optional fallback notice (e.g. when `team.yaml` is invalid and the stored approved copy was used). */
  notice?: string | null;
}

export interface JsonDifference {
  what: string;
  repair: string;
  who: DifferenceWho;
}

/**
 * Shared base fields for action commands (`up`, `down`, `add`, `remove`, `restart`,
 * `reload`, `register`, `answer`, `init`, `grant`, `delegate`, `revoke`, `worktree`, etc.)
 * under `--json` and `--dry-run --json`.
 *
 * Uses `action_summary` (string) rather than `summary` so `summary` remains unambiguously
 * the `{ differences, owner_differences }` object on reading envelopes.
 */
export interface ActionResultBase {
  format: 1;
  dry_run: boolean;
  status: string;
  action_summary: string;
  project?: string | null;
  session?: string | null;
  plan?: readonly PlanStep[];
  notice?: string | null;
}

export type ActionEnvelope<T extends Record<string, unknown> = Record<string, never>> = JsonEnvelope<
  ActionResultBase & T
>;

/** Normalizes a difference for JSON output, including `what`, `repair`, and `who`. */
export function toJsonDifference(diff: OutputDifference): JsonDifference {
  return {
    what: diff.what,
    repair: diff.repair,
    who: whoOfDifference(diff),
  };
}

/**
 * Returns `true` when `argv` contains `--json` or `--json=<value>` at any position.
 *
 * Used before a command's argument parser runs so that:
 * - an earlier unknown option (`team <cmd> --nope --json`) still writes the `team.error`
 *   JSON envelope on `stdout` with empty `stderr`,
 * - a malformed `--json=<value>` (`team <cmd> --json=1`) also routes its invocation refusal
 *   through the `team.error` JSON envelope, and
 * - `team check` never treats `--json` / `--json=…` as a spelling-breaker that flips
 *   dispatch back to the old 0.3.3 `team check <file> --by <seat>` spelling.
 *
 * `valueOptions` names the command's options that take a value. Their value is taken as given,
 * whatever it looks like, so a `--json` that is some option's value (`--file --json`, naming a
 * file called `--json`) is a path and does not select the JSON output — the same reading
 * `team release` documents and `team commits check` and `team pr check` share.
 */
export function hasJsonFlag(argv: readonly string[], valueOptions: readonly string[] = []): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (valueOptions.some((name) => argument === `--${name}`)) {
      index += 1;
      continue;
    }
    if (argument === '--json' || argument.startsWith('--json=')) return true;
  }
  return false;
}

/**
 * Wraps a JSON payload with the top-level `schema: { name, version }` tag.
 * `schema` is placed first in key order and cannot be overwritten by a payload key named `schema`.
 */
export function jsonEnvelope<T extends Record<string, unknown>>(
  schemaName: string,
  payload: T,
  version = 1,
): JsonEnvelope<T> {
  const { schema: _ignored, ...rest } = payload as T & { schema?: unknown };
  return {
    schema: { name: schemaName, version },
    ...(rest as Omit<T, 'schema'>),
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

/** Builds a structured `--json` error document (`{"schema": {"name": "team.error", "version": 1}, "error": {"id", "message", "repair", "rule?"}, "notice?"}`). */
export function jsonError(
  id: string,
  message: string,
  repair: string | null = null,
  version = 1,
  rule?: string | null,
  notice?: string | null,
): JsonErrorEnvelope {
  return {
    schema: { name: 'team.error', version },
    error: {
      id,
      message,
      repair,
      ...(rule !== undefined ? { rule } : {}),
    },
    ...(notice !== undefined && notice !== null ? { notice } : {}),
  };
}

/** Writes a structured `--json` error document to `io.stdout`. */
export function writeJsonError(
  io: Pick<Io, 'stdout'>,
  id: string,
  message: string,
  repair: string | null = null,
  version = 1,
  rule?: string | null,
  notice?: string | null,
): void {
  io.stdout(`${JSON.stringify(jsonError(id, message, repair, version, rule, notice), null, 2)}\n`);
}

/** One command refusal, in the two shapes every action command prints it (§5.3). */
export interface RefusalSpec {
  /** The `contract/exit-codes.json` row id (e.g. `'reload.absent'`). */
  id: string;
  /** The human-readable failure text, without the leading `team <command>: ` prefix. */
  message: string;
  /** The actionable repair, or null when no automated repair command applies. */
  repair: string | null;
  /** The permission resolver's rule id (`PermissionRule`) when a caller gate refused. */
  rule?: string | null;
  /** Plain text after the prefix, when it differs from `message` (e.g. a full folder path). */
  plain?: string;
  /** Text printed after the plain refusal line (the `USAGE` on a bad invocation). */
  usage?: string;
}

/**
 * The one refusal path for a command: under `--json`, writes the structured `team.error`
 * envelope to stdout (stderr stays empty); otherwise the plain `team <command>: <text>` line
 * on stderr. It returns nothing: each site keeps its own `// exit:` marker over the literal
 * return, which is what the exit-code contract reads (a code passed through a call would hide
 * the row from `scripts/exit-codes.ts`).
 */
export function refuse(
  io: Pick<Io, 'stdout' | 'stderr'>,
  json: boolean,
  command: string,
  spec: RefusalSpec,
): void {
  if (json) {
    writeJsonError(io, spec.id, plainText(spec.message), spec.repair, 1, spec.rule);
  } else {
    io.stderr(`team ${command}: ${plainText(spec.plain ?? spec.message)}\n${spec.usage ?? ''}`);
  }
}
