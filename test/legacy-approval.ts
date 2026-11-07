import { approvalOf } from '../src/approve/approval.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { Approval } from '../src/store/store.ts';

/**
 * The approval an older release left on disk: today's fields, format 1, and no lead.
 * lead is signed with format 2. A format-1 record that carries it is refused.
 */
export function legacyApprovalRecord(team: TeamFile, root: string, file: string, now?: Date): Approval & { file: string } {
  const record = { ...approvalOf(team, root, now), format: 1 as const, file };
  delete record.lead;
  return record;
}
