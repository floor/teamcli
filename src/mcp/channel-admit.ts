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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { getAgent, isAgentId, type Agent } from '../registry/agents.ts';
import { readProjects } from '../registry/projects.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { admitSend, sendGrantFor, type AdmitContext, type AdmitTeam, type AdmitTeams, type ReplyContext, type SendSide } from '../send/admit.ts';
import { eventThresholdsInForce } from '../policy/thresholds.ts';
import { readSendGrantReads } from '../send/grants.ts';
import { closeFile, readClose, readSealedRecord, recordAuthOfSealed, recordNameOk, sameFolder, verifyClose, type RecordPayload } from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';
import { parseYaml, toValue } from '../yaml.ts';

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
  const receiving = admitTeamOf(input.team, agentIdsOf(input.home, receivingId, input.session));
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
    const holder = currentHolderOf(input.home, receivingId, input.payload.from);
    if (holder.kind === 'unreadable') {
      return { ok: false, why: 'the sender registry cannot be read' };
    }
    if (holder.kind !== 'holder' || holder.agent.id !== agent.id) {
      return { ok: false, why: `agent ${input.payload.from_id} is not the live holder of ${JSON.stringify(input.payload.from)}` };
    }
    if (agentIdsOf(input.home, receivingId, input.session).get(input.payload.from) !== agent.id) {
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

/** Ordinary records bind a named recipient to both the current agent and a unique roster entry.
 *  Only the reserved owner/launch principals retain the declared-seat/null-id exceptions. */
function receivingSide(
  input: { home: string; root: string; session: string; seat: string; team: TeamFile; payload: { from: string; from_id: string | null; rule: string; to_id?: string | null } },
  receivingId: string,
): SendSide | ChannelAdmission {
  const holder = currentHolderOf(input.home, receivingId, input.seat);
  const named = input.payload.to_id;
  const reserved = (input.payload.from === OWNER_MAILBOX && input.payload.from_id === null)
    || (input.payload.from === GENERAL_BRIEF_FROM && input.payload.from_id === null && input.payload.rule === GENERAL_BRIEF_RULE);
  if (!reserved && (typeof named !== 'string' || !isAgentId(named))) {
    return { ok: false, why: 'an ordinary channel record must name its recipient agent id' };
  }
  if (typeof named === 'string' && named !== '') {
    if (holder.kind === 'unreadable') {
      return { ok: false, why: 'the recipient registry cannot be read' };
    }
    const live = holder.kind === 'holder' ? holder.agent : null;
    if (!isAgentId(named) || live === null || live.id !== named || live.reach.seat !== input.seat || live.reach.session !== input.session) {
      return { ok: false, why: `the signed record names recipient ${JSON.stringify(named)}, which is not the live agent for ${input.seat}` };
    }
    if (!reserved) {
      let record;
      try {
        record = getTeam(input.home, receivingId);
      } catch {
        return { ok: false, why: 'the recipient team registry cannot be read' };
      }
      if (record === null || record.root === '' || !sameFolder(record.root, input.root)
        || teamIdOf(record.root) !== receivingId
        || record.roster.filter((entry) => entry.agent === named && entry.seat === input.seat).length !== 1
        || record.roster.filter((entry) => entry.agent === named).length !== 1
        || record.roster.filter((entry) => entry.seat === input.seat).length !== 1) {
        return { ok: false, why: `recipient ${named} is not the unique current roster binding for ${input.seat}` };
      }
    }
    return live;
  }
  if (holder.kind === 'holder' && holder.agent.reach.seat === input.seat && holder.agent.reach.session === input.session) {
    return holder.agent;
  }
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

type HolderLookup =
  | { kind: 'holder'; agent: Agent }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'unreadable' };

/** Resolves the current non-retired holder of `(team, seat)`. Non-record directory artifacts and
 *  schema-invalid records whose decoded `reach.team` and `reach.seat` establish a disjoint endpoint
 *  are ignored. Any invalid or unreadable record that matches `(team, seat)` or whose endpoint
 *  identity cannot be decoded returns `unreadable`; tied maximum `updated_at` timestamps return
 *  `ambiguous` without consulting filesystem modification times. */
function currentHolderOf(home: string, team: string, seat: string): HolderLookup {
  const dir = join(home, '.config', 'team', 'agents');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable' };
  }
  const claimants: { agent: Agent; updatedAt: number }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.yaml')) continue;
    const id = name.slice(0, -'.yaml'.length);
    if (!isAgentId(id)) continue;
    let agent: Agent | null;
    try {
      agent = getAgent(home, id);
    } catch {
      return { kind: 'unreadable' };
    }
    if (agent === null) {
      if (!isDisjointInvalidRecord(join(dir, name), team, seat)) {
        return { kind: 'unreadable' };
      }
      continue;
    }
    if (agent.lifecycle === 'retired') continue;
    if (agent.reach.team !== team || agent.reach.seat !== seat) continue;
    const updatedAt = Date.parse(agent.provenance.updated_at);
    if (!Number.isFinite(updatedAt)) return { kind: 'ambiguous' };
    claimants.push({ agent, updatedAt });
  }
  if (claimants.length === 0) return { kind: 'none' };
  let best = claimants[0]!;
  let tied = false;
  for (let i = 1; i < claimants.length; i += 1) {
    const candidate = claimants[i]!;
    if (candidate.updatedAt > best.updatedAt) {
      best = candidate;
      tied = false;
    } else if (candidate.updatedAt === best.updatedAt) {
      tied = true;
    }
  }
  if (tied) return { kind: 'ambiguous' };
  return { kind: 'holder', agent: best.agent };
}

function isDisjointInvalidRecord(path: string, team: string, seat: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = toValue(parseYaml(text));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const reach = (parsed as Record<string, unknown>).reach;
  if (typeof reach !== 'object' || reach === null || Array.isArray(reach)) return false;
  const recordTeam = (reach as Record<string, unknown>).team;
  const recordSeat = (reach as Record<string, unknown>).seat;
  if (typeof recordTeam !== 'string' || recordTeam === '') return false;
  if (typeof recordSeat !== 'string' || recordSeat === '') return false;
  return recordTeam !== team || recordSeat !== seat;
}

function agentIdsOf(home: string, teamId: string, session: string): Map<string, string> {
  try {
    const record = getTeam(home, teamId);
    if (record === null || record.root === '' || teamIdOf(record.root) !== teamId) return new Map();
    return idsFrom(home, teamId, session, record.roster);
  } catch {
    // A registry that cannot be read leaves the roster without ids. The seat rules still run;
    // a project or grant that needs an id does not match an empty one.
    return new Map();
  }
}

function idsFrom(
  home: string,
  teamId: string,
  session: string,
  roster: readonly { agent: string; seat: string }[],
): Map<string, string> {
  const seats = new Map<string, number>();
  const agents = new Map<string, number>();
  for (const entry of roster) {
    seats.set(entry.seat, (seats.get(entry.seat) ?? 0) + 1);
    if (entry.agent !== '') agents.set(entry.agent, (agents.get(entry.agent) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const entry of roster) {
    if (entry.agent === '' || !isAgentId(entry.agent)) continue;
    if (seats.get(entry.seat) !== 1 || agents.get(entry.agent) !== 1) continue;
    const holder = currentHolderOf(home, teamId, entry.seat);
    if (holder.kind !== 'holder' || holder.agent.id !== entry.agent || holder.agent.reach.session !== session) continue;
    out.set(entry.seat, entry.agent);
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
  const holder = currentHolderOf(home, teamId, seat);
  if (holder.kind === 'unreadable') {
    return { ok: false, why: 'the foreign sender registry cannot be read' };
  }
  if (holder.kind !== 'holder' || holder.agent.id !== agentId || holder.agent.reach.session !== session) {
    return { ok: false, why: `agent ${agentId} is not the current holder of foreign seat ${JSON.stringify(seat)}` };
  }
  const loaded = readTeamConfig(record.root, { home });
  if (!loaded.ok) {
    return { ok: false, why: `the sender's team file cannot be read, so the channel cannot admit ${JSON.stringify(seat)}` };
  }
  if (!loaded.team.seats.some((entry) => entry.name === seat)) {
    return { ok: false, why: `${seat}: it is not a declared seat of its own team file now in force` };
  }
  return { ok: true, team: admitTeamOf(loaded.team, idsFrom(home, teamId, session, record.roster)) };
}
