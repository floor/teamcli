// A managed Codex seat's conversation belongs to the app-server its launch started: the seat's
// runtime queue is addressed by the thread that endpoint holds, and nothing about a fresh pane
// tells TeamCLI that thread. Herdr's agent reading names no session for a managed pane, and a
// relaunch starts a new conversation, so a restarted seat's state and registry record can both
// name none while the endpoint holds the thread all along. This module reads the endpoint's own
// loaded threads and binds the one thread it proves to the seat's two records, so a send right
// after the restart is addressed to a real conversation instead of falling to a pull.
//
// The bind is deliberately narrow: only an endpoint recorded under the seat's current presence
// incarnation is read, only the seat's own agent record — the strict door's team, seat, orphan,
// session, CLI and stable-handle checks, with the handle required to be the one the state names —
// is written, and only exactly one loaded thread is taken as the seat's own. The record is
// selected before the endpoint is read, so a record that is another incarnation's is refused
// before either record changes. A read that proves nothing leaves both records as they were, and
// the caller reports the seat pull-only rather than claiming a queue that cannot be addressed.
import type { CodexLoadedThreadsRead } from '../daemon/presence/codex-source.ts';
import { inspectRecordedCodexEndpoint } from '../daemon/presence/endpoint-record.ts';
import { recordAgentSession, type Agent } from '../registry/agents.ts';
import { recordedSeatRecord } from '../registry/resume.ts';
import { readState, updateState, type SeatState } from '../state.ts';

export type CodexThreadBinding =
  | { kind: 'bound'; id: string }
  | { kind: 'unbound'; why: string };

/** The state write's own answer: only `written` means this run put the thread in the record. */
type StateWrite = 'written' | 'named' | 'moved' | 'gone';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The seat's agent record by the strict door every binding uses — team, seat, orphan mark, the
 *  session it was written in, the CLI, and the stable handle — and by the exact handle the state
 *  names. A name lookup alone is not identity: the same team and seat name can name another
 *  incarnation's record, and writing that record's conversation would bind a seat to a record the
 *  native route refuses. The record is selected before anything is read or written, so a refused
 *  record leaves the seat state untouched. */
function strictRecordOf(
  input: { home: string; root: string; session: string; seat: { name: string; cli: string } },
  state: SeatState,
): { kind: 'bound'; agent: Agent } | { kind: 'unbound'; why: string } {
  const read = recordedSeatRecord({
    home: input.home,
    root: input.root,
    herdrSession: input.session,
    seat: { name: input.seat.name, cli: input.seat.cli },
    state,
  });
  if (read.kind === 'none') {
    return { kind: 'unbound', why: 'the seat has no agent record to bind its thread to' };
  }
  if (read.kind === 'refused') {
    return { kind: 'unbound', why: `the seat's agent record is not this seat's own (${read.why})` };
  }
  if (state.id === undefined || read.agent.seat_handle !== state.id) {
    return { kind: 'unbound', why: "the seat's agent record carries no stable handle for this seat" };
  }
  return { kind: 'bound', agent: read.agent };
}

/**
 * Binds the thread a managed Codex endpoint holds to the seat state and the seat's agent record.
 * `read` is the endpoint read, handed in so the caller owns the transport budget. When the state
 * already names a thread, that thread is kept and only its record is repaired — and only if the
 * endpoint holds it. When the state names none, exactly one loaded thread is bound; none or
 * several prove nothing, and the answer says which.
 */
export async function bindCodexSeatThread(input: {
  home: string;
  root: string;
  dir: string;
  session: string;
  seat: { name: string; cli: string };
  state: SeatState | undefined;
  read(endpoint: string): Promise<CodexLoadedThreadsRead>;
}): Promise<CodexThreadBinding> {
  const state = input.state;
  if (state === undefined) return { kind: 'unbound', why: 'the seat state could not be read' };
  if (state.id === undefined) {
    return {
      kind: 'unbound',
      why: 'the seat state names no stable id, so its record cannot be told from another incarnation’s',
    };
  }
  const entry = strictRecordOf(input, state);
  if (entry.kind === 'unbound') return entry;
  const recorded = inspectRecordedCodexEndpoint(state.codex_endpoint, state.presence_binding);
  if (recorded.kind !== 'ok') {
    return {
      kind: 'unbound',
      why: recorded.kind === 'invalid'
        ? `the seat's recorded Codex endpoint cannot be used (${recorded.why})`
        : 'the seat records no managed Codex endpoint',
    };
  }
  let read: CodexLoadedThreadsRead;
  try {
    read = await input.read(recorded.record.url);
  } catch (error) {
    read = { kind: 'unavailable', why: `the endpoint read failed (${errorText(error)})` };
  }
  if (read.kind === 'unavailable') return { kind: 'unbound', why: read.why };
  const ids = [...new Set(read.ids)];
  const named = typeof state.agent_session === 'string' && state.agent_session !== ''
    ? state.agent_session
    : null;
  let id: string;
  if (named !== null) {
    if (!ids.includes(named)) {
      return {
        kind: 'unbound',
        why: `the seat state names a thread (${named}) its Codex endpoint does not hold`,
      };
    }
    id = named;
  } else {
    if (ids.length === 0) return { kind: 'unbound', why: 'its Codex endpoint holds no thread yet' };
    if (ids.length !== 1) {
      return {
        kind: 'unbound',
        why: `its Codex endpoint holds ${String(ids.length)} threads; none is proven to be this seat's`,
      };
    }
    id = ids[0]!;
    // The incarnation the endpoint was recorded under is the one this write must still see: a
    // predecessor's endpoint and a successor's state never meet, so a seat that relaunched
    // between the read and the write is left to its own binding rather than bound to this thread.
    const binding = state.presence_binding;
    let wrote: StateWrite;
    try {
      wrote = updateState<StateWrite>(input.dir, (file) => {
        const held = file.sessions[input.session]?.seats[input.seat.name];
        if (held === undefined) return 'gone';
        if (held.presence_binding !== binding) return 'moved';
        if (typeof held.agent_session === 'string' && held.agent_session !== '') return 'named';
        held.agent_session = id;
        return 'written';
      }, { writeWhen: (result) => result === 'written' });
    } catch (error) {
      return { kind: 'unbound', why: `the seat state could not be written (${errorText(error)})` };
    }
    if (wrote !== 'written') {
      return {
        kind: 'unbound',
        why: wrote === 'moved'
          ? 'the seat relaunched while its thread was being bound'
          : 'the seat state changed while its thread was being bound',
      };
    }
    const after = readState(input.dir).sessions[input.session]?.seats[input.seat.name];
    if (after?.agent_session !== id) {
      return { kind: 'unbound', why: 'the seat state did not keep the thread it was bound to' };
    }
  }
  // The two records must agree: the delivery class and the native route both read the state and
  // the registry, so a thread written to one alone binds nothing. The record is the one the entry
  // selected by its exact stable handle, never one found by its seat name alone.
  try {
    recordAgentSession(input.home, entry.agent.id, id);
  } catch (error) {
    return { kind: 'unbound', why: `the seat's agent record could not be written (${errorText(error)})` };
  }
  return { kind: 'bound', id };
}
