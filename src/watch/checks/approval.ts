import { reported, type TeamCheck } from '../check.ts';

// The owner's seat: a file with no record on this machine at all, said once while that holds.
// The watch runs the file as it stands — the live file is the record, so an edit to it is not a
// difference and nothing here compares the two.
// A record that is not an approval in force but says why — legacy, or refused by the
// verification — is the watch's own one line, said once above the pass; the check adds nothing.
export const approval: TeamCheck = {
  name: 'approval',
  run(team, ctx) {
    if (team.approvalReason != null) return [];
    if (team.approval === null) {
      return reported(ctx.once('approval', 'the file was never approved on this machine', 'owner'));
    }
    return [];
  },
};
