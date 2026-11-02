// A public-only seat's brief is read against the machine's private lists before it leaves, and
// the repository it names is read the same way, one step earlier: the session leg hands the
// hosted CLI `owner/repo`, the CLI clones that repository from the forge, and a private one
// would hand the service the code the brief is about — the same material the lists exist to keep
// off it. So the target repository is proven public before any session call.
//
// The proof is one credential-free read of the forge's own repository record: a GET with no
// header of any kind, no redirect followed, and a five-second bound (src/release/http.ts). Only
// a 200 whose record says `private: false` is public. A 404 is the forge not showing the
// repository to this read, and is not public. Everything else (a timeout, a transport failure,
// another status, a body that is not the record) is unread. The walk refuses on not-public and
// on unread alike: a guard that cannot look must not pass a message, and the message still lands
// in the seat's own drop folder. A folder whose origin names no repository is unread too — the
// CLI would choose one from its working folder, and the walk cannot prove what that choice is.
import { realFetch, type Attempt, type Fetch } from '../release/http.ts';

/** What one read proved about the repository: public, not public, or not read. */
export type RepoVisibility = 'public' | 'not-public' | 'unread';

/** The repository read the session leg makes. A test stands in its own, so no send touches the
 *  network. */
export type RepoRead = (repo: string) => Promise<RepoVisibility>;

const RECORD = 'https://api.github.com/repos/';

/** The repository path as the forge spells it: two segments, each encoded. */
function pathOf(repo: string): string {
  return repo.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** What one attempt's answer proves. The record is the forge's own: a boolean `private` field,
 *  `false` for a repository the service holds publicly. */
function verdictOf(attempt: Attempt): RepoVisibility {
  if (attempt.kind !== 'http') return 'unread';
  if (attempt.status === 404) return 'not-public';
  if (attempt.status !== 200) return 'unread';
  let record: unknown;
  try {
    record = JSON.parse(attempt.body);
  } catch {
    return 'unread';
  }
  if (typeof record !== 'object' || record === null) return 'unread';
  const flag = (record as { private?: unknown }).private;
  if (flag === false) return 'public';
  if (flag === true) return 'not-public';
  return 'unread';
}

/** The read bound to one fetcher: the real wiring for a send, a stand-in for a test. */
export function repoReadWith(fetcher: Fetch): RepoRead {
  return async (repo) => verdictOf(await fetcher(`${RECORD}${pathOf(repo)}`));
}

/** The read a send makes when its host names none: the credential-free wiring. */
export const realRepoRead: RepoRead = repoReadWith(realFetch);
