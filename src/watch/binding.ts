// The identity a session's watchdog binding is compared by. The daemon's hosted wrapper and the
// watch actor verifier both judge whether a recorded binding names the team the loader resolved,
// so the rule lives here once: two copies could drift, and a drift on this comparison is the
// difference between a watch that runs and a watch that refuses its own record.
//
// The binding records the team file the loader resolved for the route. For a team read from its
// file that file exists, and the identity is its real path. For the default team — its definition
// imported to the registry, `.agents/team.yaml` retired — the loader still resolves the
// conventional path beside the root while nothing stands there: the file's absence is the normal
// state, not a different team. The identity is then the canonical folder the path resolves to
// (the root, which is the key the registry addresses the team's record by) joined with the file
// name. So the same root spelled through a link, a trailing slash or `..` is one identity, while
// another root, or another name in the same folder, is not: the root/session isolation the
// binding exists for is unchanged.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The canonical identity of the team a binding names: the real path when the file exists, and
 *  the canonical parent joined with the file name when the definition lives elsewhere (the
 *  registry) and no file stands there. Never throws: an unresolvable parent is resolved
 *  lexically, so a comparison always has an answer and a mismatch always refuses. */
export function teamBindingIdentity(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    let parent = resolve(dirname(file));
    try {
      parent = realpathSync(parent);
    } catch {
      // The folder is gone too: the lexical path is still this binding's identity.
    }
    return join(parent, basename(file));
  }
}

/** Whether two recorded team files name the same team. */
export function sameTeamBinding(left: string, right: string): boolean {
  return teamBindingIdentity(left) === teamBindingIdentity(right);
}
