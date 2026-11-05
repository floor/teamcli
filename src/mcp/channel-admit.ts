// Recipient-side admission for a channel push.
//
// The signature proves the record was not changed after it was signed. It does not prove the
// sender may reach this seat. A wake label resolves a display name, including a null agent id
// and a cross-team roster match, and that name is not an admission. The push asks the live team
// file and `admitSend` again: a forwarded "admitted by" line grants nothing.
import { OWNER_MAILBOX } from '../bus/owner.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../launch/general-brief.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { findAgent, getAgent, isAgentId } from '../registry/agents.ts';
import { readProjects } from '../registry/projects.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { admitSend, sendGrantFor, type AdmitContext, type AdmitTeam, type AdmitTeams, type ReplyContext, type SendSide } from '../send/admit.ts';
import { eventThresholdsInForce } from '../policy/thresholds.ts';
import { readSendGrantReads } from '../send/grants.ts';
import { closeFile, readClose, readSealedRecord, recordAuthOfSealed, recordNameOk, sameFolder, verifyClose, type RecordPayload } from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

export type ChannelAdmission = { ok: true; rule: string } | { ok: false; why: string };

/** Whether this verified record may be pushed to `seat` under the team file now in force. */
export function admitChannelDelivery(input: {
  payload: Pick<RecordPayload, 'from' | 'from_id' | 'rule'> & Partial<Pick<RecordPayload, 'id' | 'to' | 'to_id' | 'in_reply_to' | 'thread' | 'root' | 'session'>>;
  home: string;
  root: string;
  session: string;
  seat: string;
  team: TeamFile;
  /** One observation time for reply bounds; tests pin it without changing the machine clock. */
  now?: Date;
}): ChannelAdmission {
  if (!input.team.seats.some((seat) => seat.name === input.seat)) {
    return { ok: false, why: `${input.seat}: it is not a declared seat of the team file now in force` };
  }
  const receivingId = teamIdOf(input.root);
  const receiving = admitTeamOf(input.team, agentIdsOf(input.home, receivingId));
  const records: AdmitTeams = { [receivingId]: receiving };
  const target = receivingSide(input, receivingId);
  if ('ok' in target) return target;
  let projects;
  try {
    projects = readProjects(input.home);
  } catch {
    return { ok: false, why: 'the project registry cannot be read' };
  }
  const reply = replyContext(input);
  const context: AdmitContext = { projects, crossTeams: {}, ...(reply === undefined ? {} : { reply }) };

  if (input.payload.from === OWNER_MAILBOX && input.payload.from_id === null) {
    return judge('owner', target, records, context, input.home);
  }
  if (
    input.payload.from === GENERAL_BRIEF_FROM
    && input.payload.from_id === null
    && input.payload.rule === GENERAL_BRIEF_RULE
  ) {
    return { ok: true, rule: GENERAL_BRIEF_RULE };
  }
  if (input.payload.from_id === null) {
    return { ok: false, why: `the signed record names no agent id for ${JSON.stringify(input.payload.from)}` };
  }
  if (!isAgentId(input.payload.from_id)) {
    return { ok: false, why: `the signed record's from_id ${JSON.stringify(input.payload.from_id)} is not an agent id` };
  }
  let agent;
  try {
    agent = getAgent(input.home, input.payload.from_id);
  } catch {
    return { ok: false, why: 'the sender registry cannot be read' };
  }
  if (agent === null || agent.lifecycle === 'retired') {
    return { ok: false, why: `agent ${input.payload.from_id} is not a live record in this home's registry` };
  }
  if (agent.reach.seat !== input.payload.from) {
    return {
      ok: false,
      why: `agent ${input.payload.from_id} names seat ${JSON.stringify(agent.reach.seat)}, not ${JSON.stringify(input.payload.from)}`,
    };
  }
  if (agent.reach.team === receivingId) {
    if (agent.reach.session !== input.session) {
      return {
        ok: false,
        why: `agent ${input.payload.from_id} is registered in session ${JSON.stringify(agent.reach.session)}, not ${JSON.stringify(input.session)}`,
      };
    }
    if (!input.team.seats.some((seat) => seat.name === input.payload.from)) {
      return { ok: false, why: `agent ${input.payload.from_id} is not a seat of this checkout's team file now in force` };
    }
    const holder = findAgent(input.home, { team: receivingId, seat: input.payload.from });
    if (holder === null || holder.id !== agent.id) {
      return { ok: false, why: `agent ${input.payload.from_id} is not the live holder of ${JSON.stringify(input.payload.from)}` };
    }
    if (agentIdsOf(input.home, receivingId).get(input.payload.from) !== agent.id) {
      return { ok: false, why: `agent ${input.payload.from_id} is not the one current roster binding for ${JSON.stringify(input.payload.from)}` };
    }
    return judge(agent, target, records, context, input.home);
  }
  const foreign = foreignTeam(input.home, agent.reach.team, agent.reach.session, input.payload.from, input.payload.from_id);
  if (!foreign.ok) return foreign;
  records[agent.reach.team] = foreign.team;
  return judge(agent, target, records, context, input.home);
}

function judge(
  caller: SendSide | 'owner',
  target: SendSide,
  records: AdmitTeams,
  context: AdmitContext,
  home: string,
): ChannelAdmission {
  const verdict = admitSend(caller, target, records, undefined, context);
  if (verdict.ok || caller === 'owner' || !('reach' in caller)) return verdict;
  let reads;
  try {
    reads = readSendGrantReads(home);
  } catch {
    return { ok: false, why: 'the send grants cannot be read' };
  }
  const grant = sendGrantFor(
    caller,
    target,
    reads.filter((read) => read.state === 'verified'),
    records,
    new Date(),
  );
  if (grant === undefined) return verdict;
  return admitSend(caller, target, records, grant, context);
}

/** The live agent holding the receiving seat, when the registry has one. A record that names a
 *  recipient id must name that agent. A seat with no agent yet is judged as the declared seat. */
function receivingSide(
  input: { home: string; root: string; session: string; seat: string; team: TeamFile; payload: { to_id?: string | null } },
  receivingId: string,
): SendSide | ChannelAdmission {
  let live;
  try {
    live = findAgent(input.home, { team: receivingId, seat: input.seat });
  } catch {
    return { ok: false, why: 'the recipient registry cannot be read' };
  }
  const named = input.payload.to_id;
  if (typeof named === 'string' && named !== '') {
    if (!isAgentId(named) || live === null || live.id !== named || live.reach.seat !== input.seat || live.reach.session !== input.session) {
      return { ok: false, why: `the signed record names recipient ${JSON.stringify(named)}, which is not the live agent for ${input.seat}` };
    }
    return live;
  }
  if (live !== null && live.reach.seat === input.seat && live.reach.session === input.session) return live;
  return { seat: input.seat, team: receivingId, role: roleOf(input.team, input.seat) };
}

/** A reply context only when the answered record is in the sender's own tree, the principal ids
 *  match, and that thread is still open there. A send, or a record with no principal id, carries
 *  none. Seat names are not the check. */
function replyContext(input: {
  home: string;
  root: string;
  session: string;
  seat: string;
  team: TeamFile;
  now?: Date;
  payload: {
    id?: string;
    from: string;
    from_id: string | null;
    to?: string;
    to_id?: string | null;
    in_reply_to?: string;
    thread?: string;
  };
}): ReplyContext | undefined {
  const payload = input.payload;
  if (
    payload.in_reply_to === undefined
    || payload.in_reply_to === ''
    || !recordNameOk(payload.in_reply_to)
    || payload.thread === undefined
    || !recordNameOk(payload.thread)
    || payload.to === undefined
    || payload.from_id === null
    || payload.to_id === null
    || payload.to_id === undefined
    || payload.to_id === ''
  ) {
    return undefined;
  }
  const key = messageKeyState(input.home);
  if (key.kind !== 'key') return undefined;
  let sender;
  let target;
  try {
    sender = getAgent(input.home, payload.from_id);
    target = getAgent(input.home, payload.to_id);
  } catch {
    return undefined;
  }
  if (sender === null || sender.lifecycle === 'retired' || sender.reach.seat !== payload.from) return undefined;
  if (target === null || target.lifecycle === 'retired' || payload.to !== input.seat
    || target.reach.seat !== input.seat || target.reach.team !== teamIdOf(input.root)
    || target.reach.session !== input.session) return undefined;
  let record;
  try {
    record = getTeam(input.home, sender.reach.team);
  } catch {
    return undefined;
  }
  if (record === null || record.root === '' || teamIdOf(record.root) !== sender.reach.team) return undefined;
  const root = record.root;
  const session = sender.reach.session;
  const loaded = readTeamConfig(root, { home: input.home });
  if (!loaded.ok || loaded.team.session !== session) return undefined;
  const senderSeat = loaded.team.seats.find((seat) => seat.name === payload.from);
  if (senderSeat === undefined) return undefined;
  const looked = readSealedRecord(join(root, '.agents', 'send-drops', session, payload.from, payload.in_reply_to));
  if (!looked.ok || looked.sealed === null) return undefined;
  const auth = recordAuthOfSealed(looked.sealed, key.key);
  if (auth.kind !== 'ok') return undefined;
  const answered = auth.value.payload;
  if (answered.id !== payload.in_reply_to || payload.thread !== answered.thread) return undefined;
  if (answered.from_id !== payload.to_id || answered.to_id !== payload.from_id) return undefined;
  if (answered.from !== payload.to || answered.to !== payload.from || answered.session !== session || !sameFolder(answered.root, root)) return undefined;
  const now = input.now ?? new Date();
  const thresholds = eventThresholdsInForce({
    home: input.home,
    root,
    entity: loaded.team.entity,
    team: loaded.team,
    projectId: projectIdOfTeam(input.home, loaded.team, root),
    agentId: sender.id,
    seat: senderSeat,
    now,
    upToLevel: 'seat',
  });
  if (!thresholds.ok) return undefined;
  if (!threadStillOpen(root, session, answered.thread, key.key, now, thresholds.thresholds.thread_ttl_seconds, thresholds.thresholds.thread_cap, payload.id)) {
    return undefined;
  }
  // A seat cannot manufacture generic reply authority to the entity's main orchestrator.
  // As in `team reply`, that reach is bound to the opening record sent by that principal to
  // this replying principal; a later follow-up by the orchestrator cannot change the opener.
  const entity = loaded.team.entity;
  if (entity !== undefined && entity !== null && input.team.entity === entity
    && input.team.project === entity && input.team.orchestrator === input.seat) {
    let opening = answered;
    if (answered.id !== answered.thread) {
      const looked = readSealedRecord(join(root, '.agents', 'send-drops', session, payload.from, answered.thread));
      if (!looked.ok || looked.sealed === null) return undefined;
      const auth = recordAuthOfSealed(looked.sealed, key.key);
      if (auth.kind !== 'ok') return undefined;
      opening = auth.value.payload;
    }
    if (opening.id !== answered.thread || opening.thread !== opening.id
      || opening.from_id !== target.id || opening.to_id !== sender.id
      || opening.from !== payload.to || opening.to !== payload.from
      || opening.session !== session || !sameFolder(opening.root, root)) return undefined;
    return 'main-orchestrator-thread';
  }
  return 'open-thread';
}

function threadStillOpen(root: string, session: string, thread: string, key: KeyObject, now: Date, ttlSeconds: number, cap: number, incomingId?: string): boolean {
  const dir = join(root, '.agents', 'send-drops', session);
  let seats: string[];
  try {
    seats = readdirSync(dir);
  } catch {
    return false;
  }
  let count = 0;
  let latest = 0;
  let closed = false;
  for (const seat of seats) {
    if (seat.startsWith('.') || seat.includes('.')) continue;
    let names: string[];
    try {
      names = readdirSync(join(dir, seat));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!recordNameOk(name) || name === incomingId) continue;
      const looked = readSealedRecord(join(dir, seat, name));
      if (!looked.ok || looked.sealed === null) continue;
      const auth = recordAuthOfSealed(looked.sealed, key);
      if (auth.kind !== 'ok') continue;
      const payload = auth.value.payload;
      if (payload.id !== name) continue;
      if (payload.thread !== thread || payload.session !== session || !sameFolder(payload.root, root)) continue;
      count += 1;
      const at = Date.parse(payload.at);
      if (Number.isFinite(at) && at > latest) latest = at;
      const close = readClose(closeFile(join(dir, seat), payload.id), payload.id);
      if (!close.ok || close.close === null) continue;
      if (close.close.payload.thread !== thread || close.close.payload.session !== session || !sameFolder(close.close.payload.root, root)) continue;
      if (verifyClose(close.close, key)) closed = true;
    }
  }
  if (closed || count === 0) return false;
  if (latest > 0 && now.getTime() - latest >= ttlSeconds * 1_000) return false;
  if (count >= cap) return false;
  return true;
}

function roleOf(team: TeamFile, seat: string): string | undefined {
  return team.seats.find((entry) => entry.name === seat)?.role;
}

function agentIdsOf(home: string, teamId: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const record = getTeam(home, teamId);
    if (record === null) return out;
    const counts = new Map<string, number>();
    for (const entry of record.roster) counts.set(entry.seat, (counts.get(entry.seat) ?? 0) + 1);
    for (const entry of record.roster) {
      if (entry.agent !== '' && counts.get(entry.seat) === 1) out.set(entry.seat, entry.agent);
    }
  } catch {
    // A registry that cannot be read leaves the roster without ids. The seat rules still run;
    // a project or grant that needs an id does not match an empty one.
  }
  return out;
}

function idsFrom(roster: readonly { agent: string; seat: string }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const entry of roster) counts.set(entry.seat, (counts.get(entry.seat) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const entry of roster) {
    if (entry.agent !== '' && counts.get(entry.seat) === 1) out.set(entry.seat, entry.agent);
  }
  return out;
}

function admitTeamOf(team: TeamFile, agents: ReadonlyMap<string, string> = new Map()): AdmitTeam {
  return {
    project: team.project,
    entity: team.entity ?? null,
    orchestrator: team.orchestrator,
    operator: team.operator,
    session: team.session,
    roster: team.seats.map((seat) => ({
      agent: agents.get(seat.name) ?? '',
      seat: seat.name,
      role: seat.role,
      ...(seat.name === team.orchestrator ? { leads: true } : {}),
      ...(seat.assistant === true ? { assistant: true } : {}),
    })),
  };
}

/** The sender's own team, re-read from its checkout, after the registry identity agrees with
 *  itself. A roster match here is not admission: the caller still asks `admitSend`. */
function foreignTeam(
  home: string,
  teamId: string,
  session: string,
  seat: string,
  agentId: string,
): { ok: true; team: AdmitTeam } | { ok: false; why: string } {
  let record;
  try {
    record = getTeam(home, teamId);
  } catch {
    return { ok: false, why: 'the sender team registry cannot be read' };
  }
  if (record === null) {
    return { ok: false, why: `agent ${agentId} names team ${JSON.stringify(teamId)}, which this home's registry does not hold` };
  }
  if (record.root === '' || teamIdOf(record.root) !== teamId) {
    return { ok: false, why: `team ${JSON.stringify(teamId)} does not agree with its own root` };
  }
  if (!Object.hasOwn(record.lobbies, session)) {
    return { ok: false, why: `agent ${agentId} names session ${JSON.stringify(session)}, which team ${JSON.stringify(teamId)} does not record` };
  }
  const pair = record.roster.filter((entry) => entry.agent === agentId && entry.seat === seat);
  const seats = record.roster.filter((entry) => entry.agent === agentId);
  const agents = record.roster.filter((entry) => entry.seat === seat);
  if (pair.length !== 1 || seats.length !== 1 || agents.length !== 1) {
    return { ok: false, why: `agent ${agentId} is not one seat of team ${JSON.stringify(teamId)}` };
  }
  const loaded = readTeamConfig(record.root, { home });
  if (!loaded.ok) {
    return { ok: false, why: `the sender's team file cannot be read, so the channel cannot admit ${JSON.stringify(seat)}` };
  }
  if (!loaded.team.seats.some((entry) => entry.name === seat)) {
    return { ok: false, why: `${seat}: it is not a declared seat of its own team file now in force` };
  }
  return { ok: true, team: admitTeamOf(loaded.team, idsFrom(record.roster)) };
}
