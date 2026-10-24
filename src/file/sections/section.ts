import type { YamlEntry, YamlNode } from '../../yaml.ts';
import type { FsReader } from '../../lobby/gate.ts';
import type { Check, Fields } from '../check.ts';

/** What a section reads and writes while the file is validated. */
export interface Ctx {
  /** Every problem and warning, and the field helpers that report them. */
  check: Check;
  /** The whole file, for errors that belong to the file itself rather than one section. */
  root: YamlNode;
  /** The file's own fields, by top-level key. */
  top: Fields;
  /** The names of seats left out for their own problems, shared with the sections that name seats. */
  broken: Set<string>;
  /** The seats the file marks with `leads: true`, in file order: the seats section sets this. */
  leads: LeadMark[];
  /** Each section's value, set once the section has run. */
  values: Map<string, unknown>;
  /** Injected home for path validation. */
  home?: string;
  /** Injected filesystem for path validation. The gate uses the same reader. */
  fs?: FsReader;
  /** The project root, when the caller knows it: trust containment is checked against it. */
  rootDir?: string;
  /** The workspace mode a file that writes none works in: the resolved `workspace-mode` policy. */
  workspaceMode?: 'worktree' | 'shared';
}

/** A seat the file marks as its lead — `leads: true` — and the line the mark stands on. */
export interface LeadMark {
  /** The seat's name as the file writes it, before `count` is expanded. */
  name: string;
  line: number;
}

/** A section's value, once every section it names in `after` has run. */
export function valueOf<T>(ctx: Ctx, name: string): T {
  const value = ctx.values.get(name);
  if (value === undefined) throw new Error(`section "${name}" has not run before its reader; name it in "after"`);
  return value as T;
}

/** A JSON Schema fragment for one section, assembled into the file's schema by the generator. */
export type JsonSchema = Record<string, unknown>;

/** One top-level section of the team file, read and checked on its own. */
export interface Section {
  /**
   * The section's name: the owner-section list and the approval digest, a difference line, the
   * `after` references and the wave. `watch.checks` names a line inside `watch`, not a key of
   * its own.
   */
  name: string;
  /**
   * The top-level key the file may spell this section with, when it is not the canonical `name`:
   * the old key a rename left accepted. It supplies the section's entry and the schema publishes
   * it; everything order- and digest-shaped stays keyed by `name`.
   */
  key?: string;
  /** True when only the owner changes it: `team approve` fingerprints exactly these, in list order. */
  owner: boolean;
  /** The sections whose value this one reads; the validator runs it once those have run. */
  after: readonly string[];
  /** The code from `validate.ts`, moved as it was: reads its entry, reports, returns its value. */
  validate(entry: YamlEntry | undefined, ctx: Ctx): unknown;
  /** The JSON Schema fragment for this section. */
  schema: JsonSchema;
}
