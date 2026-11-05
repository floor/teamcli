/**
 * The one sentence for a stored approval that does not verify. `team restart` says it in dev
 * mode and continues; `team check` prints the same facts. The lines are the stored copy's own:
 * a signature that does not verify covers none of them, so the sentence gives their count and
 * the first few. The repair is `team approve`, from the checkout, by the owner. Nothing here
 * signs or writes an approval.
 */
export function unverifiedRecordSentence(record: string, file: string): string {
  const lines = file.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  const preview = lines.length === 0 ? '' : ` (${lines.slice(0, 3).map((line) => JSON.stringify(line)).join('; ')})`;
  const noun = lines.length === 1 ? 'line' : 'lines';
  return `${record} does not verify: ${lines.length} unverified ${noun}${preview}; re-sign with team approve, from this checkout, owner only`;
}
