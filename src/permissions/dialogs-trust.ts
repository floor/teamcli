// The `dialogs.trust` setting in force: an owner-signed team grant in the grants folder, naming
// this team's registry id. There is no file key and no approval behind it — the record is the
// whole setting, so the owner turns it on with `team grant @team --capabilities dialogs.trust`
// and off with `team revoke`, and no local mode waives either gate.
//
// Every gate reads it fresh, the same read `activeGrants` gives the other grants, so a grant takes
// effect at the next dialog and a revocation ends it at the next gate check. The default is no
// record, so off: `answer` refuses the key, `up`'s polled wait never re-reads the prompt, and
// `status` and `check` offer the owner's repair rather than `team answer`.
import { activeGrants, covers, DIALOGS_TRUST } from './grants.ts';
import { teamIdOf } from '../registry/teams.ts';

/** Whether the team at `root` holds `dialogs.trust` at `now`: an active team grant carrying the
 *  word, whose grantee is the team's registry id. A seat grant never carries it. */
export function dialogsTrustInForce(home: string, root: string, now: Date = new Date()): boolean {
  const teamId = teamIdOf(root);
  return activeGrants(home, now).some((grant) => covers(grant, { teamId }) && grant.capabilities.includes(DIALOGS_TRUST));
}
