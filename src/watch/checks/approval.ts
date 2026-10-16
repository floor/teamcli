import { reported, type TeamCheck } from '../check.ts';

// The owner's seat: a file that was never approved on this machine, or one that changed since
// the last approval. Reported once while the difference holds. The watch runs the file as it
// stands — the report tells the owner what changed since the seal.
// A record that is not an approval in force but says why — legacy, or refused by the
// verification — is the watch's own one line, said once above the pass; the check adds nothing.
export const approval: TeamCheck = {
  name: 'approval',
  run(team, ctx) {
    if (team.approvalReason != null) return [];
    if (team.approval === null) {
      return reported(ctx.once('approval', 'the file was never approved on this machine', 'owner'));
    }
    if (team.approval?.length) {
      return reported(ctx.once('approval', `the file has changed since the last approval: ${team.approval.join('; ')}`, 'owner'));
    }
    return [];
  },
};
