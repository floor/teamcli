// A managed Codex seat's conversation belongs to the app-server its launch started: the seat's
// runtime queue is addressed by the thread that endpoint holds, and nothing about a fresh pane
// tells TeamCLI that thread. Herdr's agent reading names no session for a managed pane, and a
// relaunch starts a new conversation, so a restarted seat's state and registry record can both
// name none while the endpoint holds the thread all along. This module reads the endpoint's own
// loaded threads and binds the one thread it proves to the seat's two records, so a send right
// after the restart is addressed to a real conversation instead of falling to a pull.
//
// The bind is deliberately narrow: only an endpoint this seat's own launch started — the one
// recorded under the seat's current presence incarnation, at the socket path this session and seat
// own under that binding, and not one another seat records too — is read; only the seat's own agent
// record — the strict door's team, seat, orphan, session, CLI and stable-handle checks, with the
// handle required to be the one the state names — is written; and only exactly one loaded thread
// is taken as the seat's own. The record is selected before the endpoint is read, so a record that
// is another incarnation's is refused before either record changes. Every write is then fenced on
// the snapshot the bind acted on — the incarnation, its endpoint, the thread the state names, and
// the record's own conversation — re-read before the state write and again under the registry
// lock, so a successor's thread is never replaced and the two records never end up naming
// different incarnations' conversations. A read that proves nothing leaves both records as they
// were, and the caller reports the seat pull-only rather than claiming a queue that cannot be
// addressed.
import type { CodexLoadedThreadsRead } from '../daemon/presence/codex-source.ts';
import {
  inspectRecordedCodexEndpoint,
  readCodexEndpointRecord,
} from '../daemon/presence/endpoint-record.ts';
import { recordAgentSessionWhen, type Agent, type AgentSessionWrite } from '../registry/agents.ts';
import { recordedSeatRecord } from '../registry/resume.ts';
import { readState, updateState, type SeatState, type State } from '../state.ts';
import { codexEndpointSocket } from './codex-endpoint.ts';

export type CodexThreadBinding =
  | { kind: 'bound'; id: string }
  | { kind: 'unbound'; why: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first other seat whose record names `url`, as `<session>/<seat>`, or null. The record is
 *  read by shape, not by its binding, so a predecessor's record that still names the same socket
 *  makes the endpoint just as ambiguous. */
function sharingSeat(file: State, session: string, seat: string, url: string): string | null {
  for (const [otherSession, one] of Object.entries(file.sessions)) {
    for (const [otherSeat, other] of Object.entries(one.seats)) {
      if (otherSession === session && otherSeat === seat) continue;
      const record = readCodexEndpointRecord(other.codex_endpoint);
      if (record !== null && record.url === url) return `${otherSession}/${otherSeat}`;
    }
  }
  return null;
}

/** The endpoint record this seat's incarnation can prove as its own. The strict read proves the
 *  record was written under the seat's current presence binding; the owned-path rule — the one a
 *  stop acts on — proves the URL is exactly the socket this launch gives this session and seat
 *  under that binding; and no other seat's record may name the same URL. A record pointing into
 *  another seat's run folder, a record whose URL is not the binding's own socket, or one two
 *  seats both name is ambiguous ownership: reading it would bind this seat to a conversation its
 *  runtime queue does not address. */
function ownedEndpoint(
  input: { dir: string; session: string; seat: { name: string } },
  state: SeatState,
  file: State,
): { kind: 'ok'; url: string; binding: string } | { kind: 'unbound'; why: string } {
  const recorded = inspectRecordedCodexEndpoint(state.codex_endpoint, state.presence_binding);
  if (recorded.kind === 'absent') {
    return { kind: 'unbound', why: 'the seat records no managed Codex endpoint' };
  }
  if (recorded.kind === 'invalid') {
    return {
      kind: 'unbound',
      why: `the seat's recorded Codex endpoint cannot be used (${recorded.why})`,
    };
  }
  const binding = recorded.record.binding;
  const own = codexEndpointSocket(input.dir, input.session, input.seat.name, binding);
  if (own === null || own.url !== recorded.record.url) {
    return { kind: 'unbound', why: 'the seat’s recorded Codex endpoint is not the one its launch owns' };
  }
  const shared = sharingSeat(file, input.session, input.seat.name, recorded.record.url);
  if (shared !== null) {
    return { kind: 'unbound', why: `another seat records the same Codex endpoint (${shared})` };
  }
  return { kind: 'ok', url: recorded.record.url, binding };
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

/** The snapshot every write is fenced on: the incarnation the endpoint was recorded under, that
 *  endpoint's own URL, the thread the state names, the record selected for it, the conversation
 *  that record held then, and the thread this run is binding. A launch replaces all of it at once,
 *  so a snapshot the records no longer show is another incarnation's. */
type Snapshot = {
  id: string;
  binding: string;
  url: string;
  /** The thread the seat state names, or null when it names none. */
  named: string | null;
  /** The record's conversation when the record was selected. */
  recorded: string | null;
  /** The record's id, selected by the strict door and the exact handle. */
  agent: string;
  /** The thread this run is binding. */
  bind: string;
};

function conversationOf(agent: Agent): string | null {
  const held = agent.reach.agent_session;
  return typeof held === 'string' && held !== '' ? held : null;
}

/** Why `file` no longer shows the snapshot, or null. Pure over a state file, so the state lock's
 *  own read and a later fresh read judge the same way. The endpoint is compared by URL under the
 *  same binding: a successor that recorded another socket — even one carrying the same binding —
 *  started a different server, and this run's read proves nothing about it. */
function stateMismatch(file: State, session: string, seat: string, snap: Snapshot): string | null {
  const held = file.sessions[session]?.seats[seat];
  if (held === undefined) return 'the seat left the state while its thread was being bound';
  if (held.id !== snap.id) {
    return 'the seat state names another incarnation while its thread was being bound';
  }
  if (held.presence_binding !== snap.binding) {
    return 'the seat relaunched while its thread was being bound';
  }
  const recorded = inspectRecordedCodexEndpoint(held.codex_endpoint, held.presence_binding);
  if (recorded.kind !== 'ok' || recorded.record.url !== snap.url) {
    return 'the seat’s recorded Codex endpoint changed while its thread was being bound';
  }
  const named = typeof held.agent_session === 'string' && held.agent_session !== ''
    ? held.agent_session
    : null;
  if (named !== snap.named) {
    return snap.named === null
      ? 'the seat state gained a thread while another was being bound'
      : 'the seat state changed its thread while it was being bound';
  }
  const shared = sharingSeat(file, session, seat, snap.url);
  if (shared !== null) return `another seat records the same Codex endpoint (${shared})`;
  return null;
}

/** Why either record no longer shows the snapshot, or null: the state by {@link stateMismatch},
 *  and the record still the same one by the strict door and the exact handle. The record's own
 *  conversation must also be exactly the one it held at selection, or the one being bound: a
 *  conversation another writer recorded after this run selected the record is a later binding,
 *  and a record cleared after it is a later answer too. Either replacing it would overwrite that
 *  writer's word in the registry alone; a null is compared like any other value, so only a record
 *  that held none at selection is still a record with none. */
function fence(
  input: { home: string; root: string; dir: string; session: string; seat: { name: string; cli: string } },
  snap: Snapshot,
): string | null {
  let file: State;
  try {
    file = readState(input.dir);
  } catch (error) {
    return `the team state could not be read (${errorText(error)})`;
  }
  const mismatch = stateMismatch(file, input.session, input.seat.name, snap);
  if (mismatch !== null) return mismatch;
  const held = file.sessions[input.session]?.seats[input.seat.name];
  if (held === undefined) return 'the seat left the state while its thread was being bound';
  const record = strictRecordOf(input, held);
  if (record.kind === 'unbound') return record.why;
  if (record.agent.id !== snap.agent) {
    return "the seat's agent record changed while its thread was being bound";
  }
  const conversation = conversationOf(record.agent);
  if (conversation !== snap.recorded && conversation !== snap.bind) {
    return conversation === null
      ? "the seat's agent record lost its conversation while its thread was being bound"
      : `the seat's agent record names another thread (${conversation})`;
  }
  return null;
}

/**
 * Binds the thread a managed Codex endpoint holds to the seat state and the seat's agent record.
 * `read` is the endpoint read, handed in so the caller owns the transport budget. When the state
 * already names a thread, that thread is kept and only its record is repaired — and only if the
 * endpoint holds it. When the state names none, exactly one loaded thread is bound; none or
 * several prove nothing, and the answer says which. Every write is fenced on the snapshot the
 * bind acted on, so a seat that relaunched during the endpoint read, or a record another writer
 * changed, is refused rather than bound to a thread that is not the one its records name.
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
  // The whole state is read once for the sharing proof: an endpoint two seats both name is not
  // this seat's own, whatever the record's own fields say.
  let file: State;
  try {
    file = readState(input.dir);
  } catch (error) {
    return { kind: 'unbound', why: `the team state could not be read (${errorText(error)})` };
  }
  const own = ownedEndpoint(input, state, file);
  if (own.kind === 'unbound') return own;
  const entry = strictRecordOf(input, state);
  if (entry.kind === 'unbound') return entry;
  let read: CodexLoadedThreadsRead;
  try {
    read = await input.read(own.url);
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
  }
  const snap: Snapshot = {
    id: state.id,
    binding: own.binding,
    url: own.url,
    named,
    recorded: conversationOf(entry.agent),
    agent: entry.agent.id,
    bind: id,
  };
  // The snapshot the bind acted on is fenced before either record is written. The endpoint read
  // is the one suspension point of this call, and a launch that ran during it installs a new
  // incarnation, a new endpoint, a new thread and a new record together: the thread just read is
  // the predecessor's, and writing it to either record would bind a successor to a conversation it
  // does not own. A snapshot that moved is refused here, with both records left exactly as they
  // stand — on the named path too, where nothing else would revalidate the incarnation.
  const moved = fence(input, snap);
  if (moved !== null) return { kind: 'unbound', why: moved };
  if (named === null) {
    // The state write carries the same fence under the state lock: between the check above and
    // the write, the seat may have been replaced once more.
    let wrote: string;
    try {
      wrote = updateState<string>(input.dir, (file) => {
        const mismatch = stateMismatch(file, input.session, input.seat.name, snap);
        if (mismatch !== null) return mismatch;
        const held = file.sessions[input.session]?.seats[input.seat.name];
        if (held === undefined) return 'the seat left the state while its thread was being bound';
        held.agent_session = id;
        return 'written';
      }, { writeWhen: (result) => result === 'written' });
    } catch (error) {
      return { kind: 'unbound', why: `the seat state could not be written (${errorText(error)})` };
    }
    if (wrote !== 'written') return { kind: 'unbound', why: wrote };
    const after = readState(input.dir).sessions[input.session]?.seats[input.seat.name];
    if (after?.agent_session !== id) {
      return { kind: 'unbound', why: 'the seat state did not keep the thread it was bound to' };
    }
  }
  // The two records must agree: the delivery class and the native route both read the state and
  // the registry, so a thread written to one alone binds nothing. The record is the one the entry
  // selected by its exact stable handle, and the write is fenced again under the folder lock on
  // the state that now names the thread: a conversation another writer recorded first is refused
  // rather than replaced, so a later binding is never overwritten with this one.
  const settled: Snapshot = { ...snap, named: id };
  let write: AgentSessionWrite;
  try {
    write = recordAgentSessionWhen(input.home, entry.agent.id, id, () => {
      const why = fence(input, settled);
      return why === null ? true : why;
    });
  } catch (error) {
    return { kind: 'unbound', why: `the seat's agent record could not be written (${errorText(error)})` };
  }
  if (write.kind === 'refused') return { kind: 'unbound', why: write.why };
  return { kind: 'bound', id };
}
