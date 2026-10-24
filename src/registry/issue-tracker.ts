// The team's issue tracker (`issue_tracker` in a team record of `~/.config/team/teams.yaml`): a
// reference to the project, in some tracker, where the team's work is tracked. It is team level —
// one per team, never per agent or seat — and it is a reference only: the tracker's name and
// where to look, never a credential. `type` is an open word, not an enum, so a tracker nobody
// listed yet needs no code change; `linear` and `github` are the values the docs name.
//
// The shape is checked in one place, here, for both directions: the registry reader refuses a
// record it cannot read as this (so a writer never replaces a file it could not read), and the
// writer refuses a value before anything is written.

/** The team's issue tracker. Only `type` and `project` are required. */
export type IssueTracker = {
  /** The tracker kind, an open lowercase token: `linear`, `github`, or any other word. */
  type: string;
  /** The tracker's project reference, as free text: a Linear project name, a GitHub `owner/repo`. */
  project: string;
  /** The tracker's own team or namespace key when the tracker has one: a Linear team key such as `FLO`. */
  team?: string;
  /** A link to the project (http or https, no credentials, no query, no fragment). */
  url?: string;
};

/** The shape of `type`: a lowercase token of at most 32 characters. */
export const ISSUE_TRACKER_TYPE = /^[a-z][a-z0-9-]{0,31}$/;

/** The longest `project`, `team` and `url`, in characters. */
export const ISSUE_TRACKER_LIMITS = { project: 200, team: 64, url: 512 } as const;

/** The keys the record takes. Any other key is refused rather than dropped, so a rewrite never
 *  loses a word it did not understand. */
export const ISSUE_TRACKER_KEYS: readonly string[] = ['type', 'project', 'team', 'url'];

// A credential does not belong in a reference. This is a safety net for the common token
// prefixes, not a scanner: the rule is that the field never holds a secret.
const CREDENTIAL_LIKE = /(lin_api_|lin_oauth_|gh[pousr]_|github_pat_|xox[abeprs]-|sk-)[A-Za-z0-9_-]{8,}/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type IssueTrackerCheck = { ok: true; value: IssueTracker } | { ok: false; why: string };

/** Reads a value as an issue tracker: the record's own keys, each checked, and nothing else.
 *  Returns the normalised record (known keys, in a fixed order) or the reason it is refused. */
export function checkIssueTracker(raw: unknown): IssueTrackerCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, why: '"issue_tracker" must be a map with a "type" and a "project"' };
  }
  const map = raw as Record<string, unknown>;
  const unknown = Object.keys(map).filter((key) => !ISSUE_TRACKER_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, why: `"issue_tracker" has no key ${unknown.map((key) => `"${key}"`).join(', ')}; it takes ${ISSUE_TRACKER_KEYS.join(', ')}` };
  }
  const type = map.type;
  if (typeof type !== 'string' || !ISSUE_TRACKER_TYPE.test(type)) {
    return { ok: false, why: '"issue_tracker.type" must be a lowercase word of at most 32 characters: a letter, then letters, digits or "-"' };
  }
  const project = checkText(map.project, 'project', ISSUE_TRACKER_LIMITS.project, true);
  if (typeof project !== 'string') return project;
  const out: IssueTracker = { type, project };
  if (map.team !== undefined) {
    const team = checkText(map.team, 'team', ISSUE_TRACKER_LIMITS.team, false);
    if (typeof team !== 'string') return team;
    out.team = team;
  }
  if (map.url !== undefined) {
    const url = checkText(map.url, 'url', ISSUE_TRACKER_LIMITS.url, false);
    if (typeof url !== 'string') return url;
    const why = urlProblem(url);
    if (why) return { ok: false, why: `"issue_tracker.url" ${why}` };
    out.url = url;
  }
  return { ok: true, value: out };
}

function checkText(value: unknown, key: string, max: number, required: boolean): string | IssueTrackerCheck {
  const name = `"issue_tracker.${key}"`;
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, why: `${name} must be ${required ? 'text, and is required' : 'non-empty text'}` };
  }
  if (value.length > max) return { ok: false, why: `${name} is longer than ${max} characters` };
  if (CONTROL.test(value)) return { ok: false, why: `${name} must not hold control characters or line breaks` };
  if (value !== value.trim()) return { ok: false, why: `${name} must not start or end with whitespace` };
  if (CREDENTIAL_LIKE.test(value)) return { ok: false, why: `${name} looks like a credential; the field is a reference and never holds one` };
  return value;
}

function urlProblem(text: string): string | null {
  if (/\s/.test(text)) return 'must not hold whitespace';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be an absolute http or https URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must be an http or https URL';
  if (url.username !== '' || url.password !== '') return 'must not carry credentials';
  if (url.search !== '' || url.hash !== '') return 'must not carry a query or a fragment';
  return null;
}
