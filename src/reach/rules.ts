// The reach seam's shared constants: what a seat's `reach` grant may say and what the projection
// file is called. These have a second home — the readers of `reach-roster.json` validate the same
// shapes (`src/connector/shuttle-roster.ts` in teamcli-mcp-server, and the bridge's own reader) —
// so a change here is a change to the projection contract, never a local edit.

/** The fronts a seat's replies may be served to: the closed list a `reach.to` draws from, the
 *  way `cli` draws from CLIS. A front reaches this list with its own release. */
export const FRONTS = ['grokbot'];

/** The projection's alias rule; the readers canonicalize an alias to lowercase and refuse
 *  duplicates case-insensitively. The route and key_id rule is the same set of characters. */
export const REACH_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const REACH_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One projection holds at most this many seats — the readers' own cap. */
export const REACH_MAX_SEATS = 32;

/** The projection file in the lobby, and the temporary its atomic write passes through. Both are
 *  declared lobby files (`TOOL_LOBBY_FILES`, src/profiles/profile.ts): the closed-tree gate must
 *  allow them, and a crashed write must not leave a file the next launch refuses. */
export const REACH_ROSTER_FILE = 'reach-roster.json';
export const REACH_ROSTER_TEMP = 'reach-roster.json.tmp';
