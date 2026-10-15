import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readMerge } from '../end/condition.ts';
import { resultPathProblem } from '../end/until.ts';

export type EndView =
  | { kind: 'result'; exists: boolean }
  | { kind: 'merged'; verdict: 'merged' | 'open' | 'unproven'; detail: string; ownNow: number };

/**
 * What the watch reads for one end. A missing base cannot prove a merge.
 * `seat`, when the caller has one, is named on a path the watch refuses.
 */
export function readEnd(root: string, until: string, base: string | null, ownBefore: boolean, seat?: string): EndView {
  if (until.startsWith('result:') && until.length > 'result:'.length) {
    const path = until.slice('result:'.length);
    const problem = resultPathProblem(root, path);
    if (problem) {
      // Unproven is the reading the watch already says, and nothing is removed.
      // The path check does not follow a symlink. The existence test below does.
      const who = seat ? `${seat}: ` : '';
      return { kind: 'merged', verdict: 'unproven', ownNow: 0, detail: `${who}${problem}; nothing is removed` };
    }
    return { kind: 'result', exists: existsSync(resolve(root, path)) };
  }
  if (!until.startsWith('merged:') || until.length <= 'merged:'.length) {
    return { kind: 'merged', verdict: 'unproven', ownNow: 0, detail: 'the end is not one this version reads; nothing is removed' };
  }
  if (!base) {
    return { kind: 'merged', verdict: 'unproven', ownNow: 0, detail: 'workspace.base is required to read a merged end; nothing is removed' };
  }
  const read = readMerge(root, until.slice('merged:'.length), base, ownBefore);
  return { kind: 'merged', verdict: read.verdict, detail: read.detail, ownNow: read.ownNow };
}
