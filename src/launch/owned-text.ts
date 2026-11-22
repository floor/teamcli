// The launcher's owner and mode policy on the shared guarded file reader. A missing leaf is
// distinct from an unsafe or changed path; callers never treat a refused read as no setting.
import type { Stats } from 'node:fs';
import { readStateFile, stateFileStat } from '../file-write.ts';

export type OwnedText =
  | { kind: 'missing' }
  | { kind: 'read'; text: string }
  | { kind: 'refused'; reason: string };

function ownerProblem(info: Stats): string | null {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) return 'the file is not owned by this user';
  if ((info.mode & 0o022) !== 0) return 'the file is group- or world-writable';
  return null;
}

/** Uses the shared no-link, single-link, parent/identity/size guarded reader, plus the owner
 *  and write-mode policy of the launcher home. The root is established by the caller. */
export function readOwnedText(path: string, root: string): OwnedText {
  let present = false;
  try {
    const before = stateFileStat(path, root);
    if (before === null) return { kind: 'missing' };
    present = true;
    const problem = ownerProblem(before);
    if (problem !== null) return { kind: 'refused', reason: problem };
    const text = readStateFile(path, undefined, root);
    const after = stateFileStat(path, root);
    if (text === null || after === null || ownerProblem(after) !== null
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return { kind: 'refused', reason: 'the file changed while it was read' };
    }
    return { kind: 'read', text };
  } catch (error) {
    if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'refused', reason: 'the file or its parent path is unsafe or unreadable' };
  }
}
