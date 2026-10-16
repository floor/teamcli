// The scoped bypass: one flag that names what it may waive. `TEAMCLI_DEV_MODE=1` is its unnamed,
// unscoped form — every refusal it turns into a warning, for any project and any seat. A
// `TEAMCLI_BYPASS` value is a comma-separated list of scopes: `project:<name>` covers an act on
// that team file's project, `seat:<name>` an act about that seat, and `all` the dev-mode reach.
// Only the callers that already ask about dev mode ask here, and an entry that is malformed or
// names nothing the act holds leaves every refusal where it is.

/** One scope a `TEAMCLI_BYPASS` value declares. */
export type BypassScope =
  | { kind: 'all' }
  | { kind: 'project'; project: string }
  | { kind: 'seat'; seat: string };

/** The decision for one act: what waived it, and the parenthetical a warning names it with. */
export interface Bypass {
  kind: 'all' | 'project' | 'seat';
  /** What the warning line says waived the refusal, e.g. `TEAMCLI_BYPASS project "acme"`. */
  label: string;
}

/**
 * Every scope a `TEAMCLI_BYPASS` value declares, in the order written. Spelled exactly, like
 * `TEAMCLI_DEV_MODE`'s "set to exactly `1`": the whitespace around an entry is trimmed and empty
 * entries drop out, and the name is taken exactly as written after the colon — `project: acme`
 * names the project ` acme` and matches nothing. An entry that is none of the three forms, or
 * names an empty scope, bypasses nothing: a typo can only add refusals, never remove them.
 */
export function bypassScopes(env: Record<string, string | undefined>): BypassScope[] {
  const raw = env.TEAMCLI_BYPASS;
  if (raw === undefined) return [];
  const scopes: BypassScope[] = [];
  for (const entry of raw.split(',')) {
    const text = entry.trim();
    if (text === 'all') scopes.push({ kind: 'all' });
    else if (text.startsWith('project:') && text.length > 'project:'.length) {
      scopes.push({ kind: 'project', project: text.slice('project:'.length) });
    } else if (text.startsWith('seat:') && text.length > 'seat:'.length) {
      scopes.push({ kind: 'seat', seat: text.slice('seat:'.length) });
    }
  }
  return scopes;
}

/**
 * The bypass in force for one act, or null. `project` is the acting team file's project and
 * `seat` the seat the act is about; an act that names neither — a run whose file is not read
 * yet — is covered by `all` alone, the reach dev mode has. A `project:` or `seat:` entry matches
 * only what it names; `all` covers everything.
 */
export function matchBypass(
  scopes: BypassScope[],
  act: { project?: string | undefined; seat?: string | undefined },
): Bypass | null {
  for (const scope of scopes) {
    if (scope.kind === 'all') return { kind: 'all', label: 'TEAMCLI_BYPASS' };
    if (scope.kind === 'project' && act.project !== undefined && scope.project === act.project) {
      return { kind: 'project', label: `TEAMCLI_BYPASS project "${scope.project}"` };
    }
    if (scope.kind === 'seat' && act.seat !== undefined && scope.seat === act.seat) {
      return { kind: 'seat', label: `TEAMCLI_BYPASS seat "${scope.seat}"` };
    }
  }
  return null;
}

/** The tail a waived refusal's warning line carries, naming what waived it. */
export function bypassTail(bypass: Bypass): string {
  return `; the scoped bypass continues (${bypass.label})`;
}
