// The seat's state record is where a managed Codex launch writes its endpoint. This reads that
// record under the team state folder and hands the stored value to the shared, pure reader; it
// adds no validation of its own. An absent seat, an unreadable state file, a record for another
// incarnation and a malformed record all answer null, which the source factory turns into an
// unproven seat. No path is derived from a home folder, and no shared endpoint is guessed in the
// record's place.
import { readState } from '../../state.ts';
import { readRecordedCodexEndpoint } from './endpoint-record.ts';

/** The URL the seat's current record carries for its current presence binding, or null. */
export function currentCodexEndpoint(stateDir: string, session: string, seat: string): string | null {
  let record;
  try {
    record = readState(stateDir).sessions[session]?.seats?.[seat];
  } catch {
    // A state file this build cannot read names no endpoint for any seat.
    return null;
  }
  if (record === undefined) return null;
  return readRecordedCodexEndpoint(record.codex_endpoint, record.presence_binding)?.url ?? null;
}
