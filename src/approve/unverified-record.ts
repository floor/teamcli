/**
 * The one sentence for a stored approval that does not verify. `team restart` says it in dev
 * mode and continues; `team order` and `team worktree` say the same and continue. The lines are
 * the stored copy's own: a signature that does not verify covers none of them, so the sentence
 * gives their count and the first few. Standing cannot be renewed in this build. The owner is
 * to be told. Nothing here signs or writes an approval, and the sentence names no command.
 */
export function unverifiedRecordSentence(record: string, file: string): string {
  const lines = file.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  const preview = lines.length === 0 ? '' : ` (${lines.slice(0, 3).map((line) => JSON.stringify(line)).join('; ')})`;
  const noun = lines.length === 1 ? 'line' : 'lines';
  return `${record} does not verify: ${lines.length} unverified ${noun}${preview}; standing cannot be renewed in this build, and the owner is to be told`;
}
