// The sender a wake's first line names.
//
// The name is the message's own: the seat its signed record carries, and the team that seat's
// registry identity pins. Nothing here reads the body, and no caller's typed words decide the
// name. A record whose sender this home cannot pin exactly — an id that names no live agent, a
// seat that disagrees with the agent record, a team whose root, roster or session does not agree
// with itself — has no wake name at all, and the caller keeps the durable drop and says why
// rather than typing a nameless line.
import { join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { getAgent, isAgentId } from '../registry/agents.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { messageDisplayInForce } from '../settings/message-display-policy.ts';
import { messageKeyState } from '../store/keys.ts';
import { namingFor, senderDisplayName } from './names.ts';
import type { TriggerSender } from './native.ts';
import { readRecord, verifyRecord, type RecordPayload } from './record.ts';

/** The receiving side a wake is typed into: the team file in force, its checkout and session. */
export type WakeReceiver = { root: string; session: string; team: TeamFile };

/** Whether a name can sit in a one-line wake: non-empty and holding no line break. A writer
 *  name from a signed record may hold a space (`the launch`); the line still reads as one line. */
function cleanName(name: string): boolean {
  return name !== '' && !/[\r\n]/.test(name);
}

/** Whether a team name can follow the `@`: non-empty, and no whitespace that would end it. */
function cleanTeamName(name: string): boolean {
  return name !== '' && !/\s/.test(name);
}

/**
 * The sender a wake line names, from the record alone. A record with no agent id — the owner,
 * a runtime writer such as `launch`, or a seat the receiving team declares — is named with its
 * own signed `from` and the receiving team, the team the record was written into. A record with
 * an agent id is resolved through this
 * home's registries with the same exactness the unread reporter routes by: the agent must be
 * live, its seat must be the record's `from`, and the team must be the receiving team or a team
 * whose root derives its id, whose lobbies record the session, and whose roster holds exactly
 * one entry for the agent, exactly one seat for the agent and exactly one agent at the seat.
 * Anything less returns null: no name is ever guessed or taken from the record's words.
 */
export function wakeSender(
  payload: Pick<RecordPayload, 'from' | 'from_id'>,
  home: string,
  receiving: WakeReceiver,
): TriggerSender | null {
  const receivingProject = receiving.team.project;
  if (!cleanTeamName(receivingProject)) return null;
  if (!cleanName(payload.from)) return null;

  if (payload.from_id === null) {
    // No agent id: the record's own writer name — the owner, a runtime writer such as
    // `launch`, or a seat the receiving team declares — and the team the record was written
    // into. The name is the signed record's; nothing in the body can stand in for it.
    return { seat: payload.from, team: receivingProject };
  }
  if (!isAgentId(payload.from_id)) return null;
  try {
    const agent = getAgent(home, payload.from_id);
    if (agent === null || agent.lifecycle === 'retired') return null;
    if (agent.reach.seat !== payload.from) return null;
    if (agent.reach.team === teamIdOf(receiving.root)) {
      // A seat of this very checkout: the agent record must name the receiving session, and the
      // team file in force must declare the seat.
      if (agent.reach.session !== receiving.session) return null;
      if (!receiving.team.seats.some((seat) => seat.name === payload.from)) return null;
      return { seat: payload.from, team: receivingProject };
    }
    // Another team: its own record supplies the readable team name, and only an identity that
    // agrees with itself yields one.
    const team = getTeam(home, agent.reach.team);
    if (team === null) return null;
    if (team.root === '' || teamIdOf(team.root) !== agent.reach.team) return null;
    if (!cleanTeamName(team.project)) return null;
    if (!Object.hasOwn(team.lobbies, agent.reach.session)) return null;
    const pair = team.roster.filter((entry) => entry.agent === payload.from_id && entry.seat === payload.from);
    const seats = team.roster.filter((entry) => entry.agent === payload.from_id);
    const agents = team.roster.filter((entry) => entry.seat === payload.from);
    if (pair.length !== 1 || seats.length !== 1 || agents.length !== 1) return null;
    return { seat: payload.from, team: team.project };
  } catch {
    // An unreadable registry is not a name.
    return null;
  }
}

/**
 * The message's signed payload, verified with the checkout's message key. A record that does not
 * verify has no sender this home may name, and a read would refuse it: no wake is typed for it.
 */
export function verifiedPayloadOf(dropDir: string, id: string, home: string): RecordPayload | null {
  const key = messageKeyState(home);
  if (key.kind !== 'key') return null;
  const looked = readRecord(join(dropDir, id), id);
  if (!looked.ok || looked.record === null) return null;
  if (!verifyRecord(looked.record, key.key)) return null;
  return looked.record.payload;
}

/** The message's age: the clock handed in against the record's own `at`. Unreadable or future
 *  times read 0 rather than a negative or invented age. */
function ageMsOf(at: string, now: Date | undefined): number {
  if (now === undefined) return 0;
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, now.getTime() - then);
}

/**
 * The typed wake's sender and words, from the record alone: the verified seat and team, the
 * seat's nickname (its seat name when the file writes none), and the receiving team's
 * `message-display` template in force. Everything the line shows is the record's; the summary is
 * the body's first content line, never a rewrite. A receiver whose registry or chain cannot be
 * read leaves the shipped name and template — a wake always opens with a readable header.
 */
export function wakeTrigger(
  payload: Pick<RecordPayload, 'from' | 'from_id' | 'body' | 'at'> & { subject?: string },
  home: string,
  receiving: WakeReceiver,
  now?: Date,
): TriggerSender | null {
  const sender = wakeSender(payload, home, receiving);
  if (sender === null) return null;
  let name = sender.seat;
  try {
    const naming = { ...namingFor({ home, root: receiving.root, file: receiving.team }), mode: 'nickname' as const };
    name = senderDisplayName({ seat: payload.from, id: payload.from_id ?? undefined }, naming) || sender.seat;
  } catch {
    // A registry that cannot answer leaves the seat name; a wake still names its sender.
  }
  const template = messageDisplayInForce({
    home,
    root: receiving.root,
    team: receiving.team,
    ...(now === undefined ? {} : { now }),
  });
  return {
    ...sender,
    name,
    template,
    body: payload.body,
    ageMs: ageMsOf(payload.at, now),
    ...(payload.subject === undefined ? {} : { subject: payload.subject }),
  };
}
