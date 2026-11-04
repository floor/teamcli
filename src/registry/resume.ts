// The seat's own recorded conversation, for a restart that resumes it. Only team-owned records
// are read: the agent registry's `reach.agent_session` — the CLI's own id, read from the launch's
// trusted herdr reading and never derived from a pane, a name or a guessed thread — and the seat
// state this launch wrote. The record is offered as a resume id only while both name the same
// agent, seat, team, CLI and id: a record that does not is foreign or stale, and no resume is
// offered from it. No CLI home, transcript, credential or session file is read here.
import { readStoreSessions } from '../sessions/registry.ts';
import type { SeatState } from '../state.ts';
import { storePath } from '../store/store.ts';
import { findAgent, type Agent } from './agents.ts';
import { teamIdOf } from './teams.ts';

/** A recorded resume id is one token: `withResume` appends it to the launch line unquoted, so
 *  whitespace, a control byte or a shell metacharacter is never a session id. */
const SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The part of a seat state a binding reads: the stable handle the record is compared by, and
 *  the conversation the launch wrote beside it. A caller holding the whole seat state passes one;
 *  a reader that has only these two facts (the delivery class) reads the same binding. */
export type SeatBindingState = Pick<SeatState, 'id' | 'agent_session'>;

/** What the two team-owned records agree on, when they agree. */
export type RecordedSeatSession = {
  /** The agent's immutable registry id (`agt_`); the record this resume is bound to. */
  agentId: string;
  /** The stable `seat_` handle, when the record carries one. */
  seatHandle: string | null;
  /** The CLI's own session id, as the launch's herdr reading reported it. */
  sessionId: string;
  /** `reach.team`, the team id the record belongs to. */
  team: string;
  /** `reach.seat`, the seat the record belongs to. */
  seat: string;
  /** The CLI the recorded launch ran. */
  cli: string;
  /** The recorded launch recipe is authoritative for a bound seat. */
  launch?: string;
  /** The model the agent was signed to run. */
  model?: string;
  version?: string;
  lab?: string;
  /** The herdr session the record was written in. */
  herdrSession: string;
  /** The pane the record last pointed at: the endpoint a caller reaches the seat through. */
  pane: string | null;
  /** The cross-session address, when the record holds one. */
  address: string | null;
};

/** `none`: nothing recorded to resume (a fresh launch is exactly today's behaviour). `refused`: a
 *  record exists but is not this seat's own current one; the caller launches fresh and says why. */
export type RecordedSeatSessionRead =
  | { kind: 'bound'; recorded: RecordedSeatSession }
  | { kind: 'none'; why: string }
  | { kind: 'refused'; why: string };

/**
 * The resume id one seat's own records agree on. `state` is the seat state the current run reads;
 * `root` is the team root its file was loaded for. The binding is compared whole:
 *
 * - the registry record's (`reach.team`, `reach.seat`) must be the target pair — the seat name
 *   alone is never a binding, since two teams may declare the same seat name — and it must have
 *   been written in the herdr session this restart runs in, since the registry is per home;
 * - a record marked orphaned, or one whose CLI is not the CLI the file now declares, is not the
 *   current seat;
 * - when both the state and the record name a stable seat handle, they must be the same handle:
 *   a seat removed and added again is a different agent, and its conversation is not this one;
 * - the id must be one token, and the seat state of this launch must name exactly that id: a
 *   state with none, or with another id, is not fresh evidence for the registry's value.
 *
 * Returns `none` when there is nothing recorded (or the launch did not record an id): a restart
 * then launches fresh, as it always did. Returns `refused` when the records disagree, so the
 * caller never resumes a conversation that is not this seat's own.
 */
export function recordedSeatSession(input: {
  home: string;
  root: string;
  herdrSession: string;
  seat: { name: string; cli: string };
  state: SeatBindingState | undefined;
}): RecordedSeatSessionRead {
  const read = readSeatBinding(input);
  if (read.kind !== 'bound') return read;
  // A resume writes the id into a new launch line: the state copy must name it too, so a
  // record the launch did not write is never resumed. Continuity reads the binding directly.
  if (!read.stateAgrees) return { kind: 'none', why: 'the seat state names no agent session' };
  return { kind: 'bound', recorded: recordedOf(read) };
}

/**
 * The registry's binding of a seat to its conversation, for continuity of a process already in
 * the seat's pane — never for a resume. The checks are {@link recordedSeatSession}'s, with one
 * difference: a seat state that names no session does not withhold the registry's id, because a
 * restored pane is proven by the live agent's session equalling the recorded one, not by the
 * launch line this run would write. A state naming another id still refuses: the two records
 * disagree, and neither is allowed to speak for the seat.
 *
 * A CLI that cannot carry one in a measured form (every profile but the ones
 * {@link withResume} knows: Claude Code `--resume <id>`, Codex `resume <id>`, Antigravity
 * `--conversation=<id>`, Grok `-r <id>`) has no resume id at all. This reader does not branch
 * on the CLI: the id it returns is `reach.agent_session`, and the profile writes that token
 * in the form above. It is also what lets a restart recognize a restored pane when the
 * profile has no resume form.
 */
export function recordedSeatContinuity(input: {
  home: string;
  root: string;
  herdrSession: string;
  seat: { name: string; cli: string };
  state: SeatBindingState | undefined;
}): RecordedSeatSessionRead {
  const read = readSeatBinding(input);
  if (read.kind !== 'bound') return read;
  return { kind: 'bound', recorded: recordedOf(read) };
}

/**
 * The id a pane may be compared with, for continuity: the registry's bound id when the record is
 * this seat's own, the state's copy when there is no record at all, and nothing when a record
 * exists but is not this seat's — a record naming another session than the state does, another
 * herdr session, another CLI, or an orphaned one is a doubt, and the state's copy is not allowed
 * to overrule it. `null` is a refusal: the caller treats the pane as not tied to the launch.
 */
export function continuityIdOf(read: RecordedSeatSessionRead, state: SeatBindingState | undefined): string | null {
  if (read.kind === 'bound') return read.recorded.sessionId;
  if (read.kind === 'refused') return null;
  const own = state?.agent_session;
  return own === undefined || own === '' ? null : own;
}

/** One continuity id per declared seat, read the way `up`, `status` and the watch read a pane:
 *  the registry's binding where it exists, the state's own copy where no record does. */
export function continuityIdOfSeat(input: {
  home: string;
  root: string;
  herdrSession: string;
  seat: { name: string; cli: string };
  state: SeatBindingState | undefined;
}): string | null {
  return continuityIdOf(recordedSeatContinuity(input), input.state);
}

/** {@link continuityIdOfSeat} for every declared seat of one session's state. */
export function continuityIdsOf(input: {
  home: string;
  root: string;
  herdrSession: string;
  seats: readonly { name: string; cli: string }[];
  states: Readonly<Record<string, SeatState | undefined>>;
}): Map<string, string | null> {
  const ids = new Map<string, string | null>();
  for (const seat of input.seats) {
    ids.set(seat.name, continuityIdOfSeat({
      home: input.home,
      root: input.root,
      herdrSession: input.herdrSession,
      seat,
      state: input.states[seat.name],
    }));
  }
  return ids;
}

/** The session one seat's pane may be compared with: the map's own verdict when the seat is in
 *  it (`null`: the records refuse), else the caller's fallback — a temporary seat's state copy,
 *  or a run that read no registry. */
export function continuitySessionOf(
  ids: ReadonlyMap<string, string | null> | undefined,
  seat: string,
  fallback: string | undefined,
): string | undefined {
  if (ids === undefined) return fallback;
  const id = ids.get(seat);
  if (id === null) return undefined;
  return id ?? fallback;
}

/** The binding both readers agree on, with the state's own copy still undecided. */
type SeatBindingRead =
  | { kind: 'bound'; agent: Agent; id: string; stateAgrees: boolean }
  | { kind: 'none'; why: string }
  | { kind: 'refused'; why: string };

/** The registry's agent record for the seat, by every check a binding makes short of the
 *  conversation id: team, seat, orphan mark, the herdr session it was written in, the CLI, and
 *  the stable handle against the seat state. */
type SeatRecordRead =
  | { kind: 'bound'; agent: Agent; state: SeatBindingState | undefined }
  | { kind: 'none'; why: string }
  | { kind: 'refused'; why: string };

type SeatLookup = {
  home: string;
  root: string;
  herdrSession: string;
  seat: { name: string; cli: string };
  state: SeatBindingState | undefined;
};

function readSeatRecord(input: SeatLookup): SeatRecordRead {
  const team = teamIdOf(input.root);
  const agent = findAgent(input.home, {
    team,
    seat: input.seat.name,
    seatHandle: input.state?.id ?? null,
  });
  if (agent === null) return { kind: 'none', why: 'no agent record for this seat' };
  // `findAgent` already filters on the pair; the comparisons stay here so a future lookup change
  // cannot quietly widen the binding.
  if (agent.reach.team !== team) return { kind: 'refused', why: `the record belongs to team ${agent.reach.team}` };
  if (agent.reach.seat !== input.seat.name) return { kind: 'refused', why: `the record belongs to seat ${agent.reach.seat}` };
  if (agent.orphaned_at != null) return { kind: 'refused', why: 'the record is orphaned; its seat is no longer declared' };
  // The registry is per home, not per herdr session: the record has to have been written in the
  // session this restart runs in, or the same team root's seat in another session answers.
  if (agent.reach.session !== input.herdrSession) {
    return { kind: 'refused', why: `the record was written in herdr session ${agent.reach.session}` };
  }
  if (agent.cli !== input.seat.cli) {
    return { kind: 'refused', why: `the record ran ${agent.cli}, the seat now declares ${input.seat.cli}` };
  }
  const state = input.state;
  if (state?.id !== undefined && agent.seat_handle != null && state.id !== agent.seat_handle) {
    return { kind: 'refused', why: 'the record is another agent for this seat' };
  }
  return { kind: 'bound', agent, state };
}

function readSeatBinding(input: SeatLookup): SeatBindingRead {
  const record = readSeatRecord(input);
  if (record.kind !== 'bound') return record;
  const { agent } = record;
  const id = agent.reach.agent_session;
  if (id === null || id === undefined || id === '') return { kind: 'none', why: 'the record names no agent session' };
  if (!SESSION_TOKEN.test(id)) return { kind: 'refused', why: 'the recorded id is not one session token' };
  const live = record.state?.agent_session;
  if (live !== undefined && live !== '' && live !== id) {
    return { kind: 'refused', why: 'the seat state and the agent record name different sessions' };
  }
  return { kind: 'bound', agent, id, stateAgrees: live !== undefined && live !== '' };
}

/** What the registry holds for a seat when only the record matters, not the conversation. */
export type RecordedSeatRecordRead =
  | { kind: 'bound'; agent: Agent }
  | { kind: 'none'; why: string }
  | { kind: 'refused'; why: string };

/**
 * The registry's agent record for the seat, by the checks every binding makes — team, seat,
 * orphan mark, the herdr session it was written in, the CLI, and the stable handle — without the
 * conversation id a resume carries. This is the binding native delivery resolves the seat by: a
 * record that names no conversation still binds the seat, while a missing or refused record
 * leaves it reachable only by pull.
 */
export function recordedSeatRecord(input: {
  home: string;
  root: string;
  herdrSession: string;
  seat: { name: string; cli: string };
  state: SeatBindingState | undefined;
}): RecordedSeatRecordRead {
  const record = readSeatRecord(input);
  return record.kind === 'bound' ? { kind: 'bound', agent: record.agent } : record;
}

/**
 * Resolves a caller-pinned `--resume <cli-session-id>` for `seat` against team-owned records:
 * the seat's agent record and the session registry (`sessions.jsonl`). Refuses when the token is
 * malformed, the seat's agent record is refused or disagrees with state, or the pinned session id
 * belongs to another team, seat, terminal-host session, or CLI, or is not recorded for this seat.
 */
export function pinnedSeatSession(input: {
  home: string;
  root: string;
  herdrSession: string;
  project: string;
  seat: { name: string; cli: string };
  state: SeatBindingState | undefined;
  sessionId: string;
}): RecordedSeatSessionRead {
  const { sessionId } = input;
  if (!SESSION_TOKEN.test(sessionId)) {
    return { kind: 'refused', why: 'the session id is not one session token' };
  }
  const record = readSeatRecord(input);
  if (record.kind === 'refused') return record;
  if (record.kind === 'bound') {
    const live = record.state?.agent_session;
    const current = record.agent.reach.agent_session;
    if (
      live !== undefined &&
      live !== '' &&
      current !== null &&
      current !== undefined &&
      current !== '' &&
      live !== current
    ) {
      return { kind: 'refused', why: 'the seat state and the agent record name different sessions' };
    }
    if (current === sessionId && live === sessionId) {
      return { kind: 'bound', recorded: recordedOf({ agent: record.agent, id: sessionId }) };
    }
  }
  const storeRead = readStoreSessions(storePath(input.project, input.root, input.home), input.home);
  if (!storeRead.ok) {
    return { kind: 'refused', why: storeRead.reason };
  }
  const candidates = storeRead.sessions.filter((one) => one.cli_session === sessionId);
  const own = candidates.filter(
    (one) =>
      one.team === input.project &&
      one.seat === input.seat.name &&
      one.herdr_session === input.herdrSession &&
      one.cli === input.seat.cli,
  );
  if (own.length > 0) {
    if (record.kind === 'bound') {
      return { kind: 'bound', recorded: recordedOf({ agent: record.agent, id: sessionId }) };
    }
    return {
      kind: 'bound',
      recorded: {
        agentId: '',
        seatHandle: input.state?.id ?? null,
        sessionId,
        team: teamIdOf(input.root),
        seat: input.seat.name,
        cli: input.seat.cli,
        herdrSession: input.herdrSession,
        pane: null,
        address: null,
      },
    };
  }
  const foreign = candidates.at(-1);
  if (foreign !== undefined) {
    if (foreign.team !== input.project) {
      return { kind: 'refused', why: `session ${sessionId} belongs to team ${foreign.team}` };
    }
    if (foreign.seat !== input.seat.name) {
      return { kind: 'refused', why: `session ${sessionId} belongs to seat ${foreign.seat}` };
    }
    if (foreign.herdr_session !== input.herdrSession) {
      return {
        kind: 'refused',
        why: `session ${sessionId} was recorded in terminal-host session ${foreign.herdr_session}`,
      };
    }
    if (foreign.cli !== input.seat.cli) {
      return {
        kind: 'refused',
        why: `session ${sessionId} ran ${foreign.cli}, the seat now declares ${input.seat.cli}`,
      };
    }
  }
  return { kind: 'refused', why: `session ${sessionId} is not a recorded session of ${input.seat.name}` };
}

function recordedOf(read: { agent: Agent; id: string }): RecordedSeatSession {
  const { agent, id } = read;
  return {
    agentId: agent.id,
    seatHandle: agent.seat_handle ?? null,
    sessionId: id,
    team: agent.reach.team,
    seat: agent.reach.seat,
    cli: agent.cli,
    launch: agent.launch,
    model: agent.signing.model,
    version: agent.signing.version,
    lab: agent.lab,
    herdrSession: agent.reach.session,
    pane: agent.reach.pane,
    address: agent.reach.address,
  };
}
