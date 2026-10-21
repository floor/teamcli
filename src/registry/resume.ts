// The seat's own recorded conversation, for a restart that resumes it. Only team-owned records
// are read: the agent registry's `reach.agent_session` — the CLI's own id, read from the launch's
// trusted herdr reading and never derived from a pane, a name or a guessed thread — and the seat
// state this launch wrote. The record is offered as a resume id only while both name the same
// agent, seat, team, CLI and id: a record that does not is foreign or stale, and no resume is
// offered from it. No CLI home, transcript, credential or session file is read here.
import type { SeatState } from '../state.ts';
import { findAgent } from './agents.ts';
import { teamIdOf } from './teams.ts';

/** A recorded resume id is one token: `withResume` appends it to the launch line unquoted, so
 *  whitespace, a control byte or a shell metacharacter is never a session id. */
const SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
  state: SeatState | undefined;
}): RecordedSeatSessionRead {
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
  const id = agent.reach.agent_session;
  if (id === null || id === undefined || id === '') return { kind: 'none', why: 'the record names no agent session' };
  if (!SESSION_TOKEN.test(id)) return { kind: 'refused', why: 'the recorded id is not one session token' };
  const live = state?.agent_session;
  if (live === undefined || live === '') return { kind: 'none', why: 'the seat state names no agent session' };
  if (live !== id) return { kind: 'refused', why: 'the seat state and the agent record name different sessions' };
  return {
    kind: 'bound',
    recorded: {
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
    },
  };
}
