/**
 * The one sentence for a stored approval that does not verify. `team restart` says it in dev
 * mode and continues; `team check` prints the same facts. The lines are the stored copy's own:
 * a signature that does not verify covers none of them, so the sentence gives their count and
 * the first few. The re-sign command is the first `key: value` line of that copy. Nothing here
 * signs or writes an approval.
 */
export function unverifiedRecordSentence(record: string, file: string): string {
  const lines = file.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  const preview = lines.length === 0 ? '' : ` (${lines.slice(0, 3).map((line) => JSON.stringify(line)).join('; ')})`;
  const noun = lines.length === 1 ? 'line' : 'lines';
  const scalar = lines.map((line) => /^([A-Za-z0-9_.-]+):\s+(\S.*)$/.exec(line.trim())).find((match) => match !== null);
  const path = scalar?.[1] ?? '<path>';
  const raw = scalar?.[2] ?? '<value>';
  const value = /^[A-Za-z0-9._@/:%+-]+$/.test(raw) ? raw : `'${raw.replace(/'/g, `'\\''`)}'`;
  const set = `team config set ${path} ${value}`;
  return `${record} does not verify: ${lines.length} unverified ${noun}${preview}; re-sign with ${set} --request, then ${set} --approval <id>`;
}
