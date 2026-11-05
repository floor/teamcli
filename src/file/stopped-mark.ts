// A seat's `stopped` mark, set or cleared through the record editor (src/config/team-record.ts)
// rather than by line. The line writer cannot see a seat written as a flow mapping (`- { name: … }`)
// or a list whose dash sits at the `seats:` header's own column, so a revival of such a seat left
// the mark in place; the parsed record holds the seat wherever the text spells it, and the record
// editor rewrites the one key. A counted entry is split first, so the other instances stay as they
// were. The caller decides whether the seat is declared (the parsed team's own seats are the
// answer) and validates the text again before it is stored.
import { editedRecordText, withValue, type RecordPath } from '../config/team-record.ts';
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';
import { splitSeatCount } from './lines.ts';

export type StoppedEdit = { ok: true; text: string } | { ok: false; why: string };

/** `text` with `name`'s entry carrying `stopped: true` (`stopped`), or without the key when it is
 *  cleared. A seat the record cannot address is a refusal, never a silent no-op. */
export function setSeatStopped(text: string, name: string, stopped: boolean): StoppedEdit {
  const split = splitSeatCount(text, name);
  let record: YamlValue;
  try {
    record = toValue(parseYaml(split));
  } catch (error) {
    return { ok: false, why: `the record cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const path: RecordPath = ['seats', name, 'stopped'];
  const value: YamlValue | undefined = stopped ? true : undefined;
  const changed = withValue(record, path, value);
  if (!changed.ok) return { ok: false, why: changed.why };
  if (!changed.changed) return { ok: true, text: split };
  return { ok: true, text: editedRecordText(split, path, value, changed.root).text };
}
