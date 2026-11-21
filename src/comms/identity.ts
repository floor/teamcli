// Who sent a message, as every leg prints it (rfc-event-comms, the Claude adapter §4).
//
// One function names a sender: `senderIdentity(view, principal)`. It reads the registry through a
// narrow, read-only `IdentityView` and nothing else — never the receiving seat, never a session
// title, never a label another seat carries. A seat is named by its signed nickname, then its
// roster nickname, then its OWN label persona (unless that persona is a name another seat
// carries anywhere in the registry), then its seat name. Its model is the agent record's signed
// model and version at the moment of reading, else the seat's display.
//
// A stamped record carries the identity signed at send time (`from_identity`); every other record
// is named here from its verified `from` and `from_id`, by registry id only. An id the registry
// does not hold is no answer: the signed spelling stands alone, with no team and no model.

import { readTeamConfig } from '../file/team-config.ts';
import { labelPersona } from '../file/sections/seats.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { seatNicknameReader } from '../config/apply.ts';
import { getAgent, type Agent } from '../registry/agents.ts';
import { readTeams, type TeamRecord } from '../registry/teams.ts';

/** A field's longest printed form, in characters. */
export const IDENTITY_FIELD_MAX = 64;

/** The signed identity a stamped record carries, and the one shape every renderer prints. */
export type FromIdentity = {
  /** The name a person reads: nickname, own persona, seat name; `the owner`; a client's name. */
  name: string;
  /** `<seat>@<team>` for a seat; the client principal and its grant for a client; absent for the
   *  owner and the runtime. */
  address?: string;
  /** The sender's model as signed at send time; absent for a principal that has none. */
  model?: string;
};

/** Who wrote a record, as its verified fields say. */
export type Principal =
  | { kind: 'seat'; seat: string; id: string | null }
  | { kind: 'client'; clientId: string; grantId: string | null }
  | { kind: 'owner' }
  | { kind: 'runtime' };

/** One seat as the identity rule reads it. */
export type IdentitySeat = {
  seat: string;
  teamId: string;
  teamName: string;
  /** The seat's signed nickname setting, when one verifies. */
  signedNickname: string | null;
  /** The roster's (the team file's) nickname. */
  nickname: string | null;
  /** The seat's own written label persona, before the collision guard. */
  persona: string | null;
  /** The agent record's signed model plus version, when both are set. */
  model: string | null;
  /** The team file's display for the seat. */
  display: string | null;
};

/** The narrow, read-only registry view the identity rule reads. */
export interface IdentityView {
  /** The seat a registry agent id names, or null when the registry holds no such agent. */
  seatById(agentId: string): IdentitySeat | null;
  /** Every registered seat except the agent named, across every registered team. */
  otherSeats(agentId: string): readonly IdentitySeat[];
}

/** A client id as a person reads it: `grok-bot` is `Grok Bot` (the same rule as src/client/bundles.ts). */
function clientDisplayName(clientId: string): string {
  return clientId.split('-').filter((word) => word !== '').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

/** The runtime words a record's `from` may carry with no registry id. */
const RUNTIME_SENDERS: readonly string[] = ['watch', 'daemon', 'the daemon', 'the launch', 'runtime'];

/**
 * One field as one line: control characters and line breaks become spaces, runs of spaces
 * collapse, a middle dot (the header's own separator) becomes `-`, and the field is capped.
 */
export function oneLineField(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const control = code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0x85;
    out += control ? ' ' : char === '·' ? '-' : char;
  }
  const collapsed = out.replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  return chars.length > IDENTITY_FIELD_MAX ? chars.slice(0, IDENTITY_FIELD_MAX).join('').trimEnd() : collapsed;
}

/** The identity with every field one line, and empty fields dropped. */
export function encodeIdentity(identity: FromIdentity): FromIdentity {
  const name = oneLineField(identity.name);
  const out: FromIdentity = { name: name === '' ? 'unknown' : name };
  if (identity.address !== undefined) {
    const address = oneLineField(identity.address);
    if (address !== '') out.address = address;
  }
  if (identity.model !== undefined) {
    const model = oneLineField(identity.model);
    if (model !== '') out.model = model;
  }
  return out;
}

/** The principal a record's verified sender fields name. */
export function principalOf(record: {
  from: string;
  from_id: string | null;
  from_client?: { client_id: string; grant_id: string };
}): Principal {
  if (record.from_client !== undefined) {
    return { kind: 'client', clientId: record.from_client.client_id, grantId: record.from_client.grant_id };
  }
  if (record.from.startsWith('client:') && record.from_id === null) {
    return { kind: 'client', clientId: record.from.slice('client:'.length), grantId: null };
  }
  if (record.from_id === null && record.from === 'owner') return { kind: 'owner' };
  if (record.from_id === null && RUNTIME_SENDERS.includes(record.from)) return { kind: 'runtime' };
  return { kind: 'seat', seat: record.from, id: record.from_id };
}

/** The persona names every other seat carries: its nicknames (signed and roster) and persona. */
function heldElsewhere(view: IdentityView, agentId: string): Set<string> {
  const held = new Set<string>();
  for (const other of view.otherSeats(agentId)) {
    for (const name of [other.signedNickname, other.nickname, other.persona]) {
      if (name !== null && name !== '') held.add(name.normalize('NFKC').toLowerCase());
    }
  }
  return held;
}

/** Why a seat's own label persona is not used: it names another seat. */
export type PersonaCollision = { agentId: string; seat: string; teamName: string; persona: string };

/** The seat's own persona when no other seat carries it; null otherwise (or when it has none). */
function guardedPersona(view: IdentityView, agentId: string, seat: IdentitySeat): string | null {
  if (seat.persona === null || seat.persona === '') return null;
  return heldElsewhere(view, agentId).has(seat.persona.normalize('NFKC').toLowerCase()) ? null : seat.persona;
}

/** Whether a seat's own label persona collides with another seat's name (the doctor's entry). */
export function personaCollision(view: IdentityView, agentId: string): PersonaCollision | null {
  const seat = view.seatById(agentId);
  if (seat === null || seat.persona === null || seat.persona === '') return null;
  // A nickname names the seat before its persona is read: the persona is then never printed.
  if (seat.signedNickname !== null || seat.nickname !== null) return null;
  if (guardedPersona(view, agentId, seat) !== null) return null;
  return { agentId, seat: seat.seat, teamName: seat.teamName, persona: seat.persona };
}

/**
 * The one sender identity. A seat: signed nickname, roster nickname, its own label persona (not
 * another seat's name anywhere), seat name; its model from the agent record, else the display.
 * A seat id the registry does not hold reads as its signed spelling alone, with no team and no model. A
 * client: its display name and grant binding, never a seat label. The owner and the runtime have
 * fixed names.
 */
export function senderIdentity(view: IdentityView, principal: Principal): FromIdentity {
  switch (principal.kind) {
    case 'owner':
      return { name: 'the owner' };
    case 'runtime':
      return { name: 'TeamCLI runtime' };
    case 'client':
      return encodeIdentity({
        name: clientDisplayName(principal.clientId),
        address: principal.grantId === null ? `client:${principal.clientId}` : `client:${principal.clientId} (grant ${principal.grantId})`,
      });
    case 'seat': {
      let seat: IdentitySeat | null = null;
      if (principal.id !== null) {
        try {
          seat = view.seatById(principal.id);
        } catch {
          seat = null;
        }
      }
      if (seat === null || principal.id === null) {
        // An id the registry cannot resolve shows its signed spelling only: no team, no model.
        return encodeIdentity({ name: principal.seat });
      }
      // The persona is read (and guarded against every other seat) only when no nickname names it.
      let persona: string | null = null;
      if (seat.signedNickname === null && seat.nickname === null) {
        try {
          persona = guardedPersona(view, principal.id, seat);
        } catch {
          persona = null;
        }
      }
      const name = seat.signedNickname ?? seat.nickname ?? persona ?? seat.seat;
      // The model only when it is known.
      const model = seat.model ?? seat.display;
      return encodeIdentity({
        name,
        address: `${seat.seat}@${seat.teamName}`,
        ...(model === null ? {} : { model }),
      });
    }
  }
}

/** The model an agent record signs: model and version, when the model is set. */
function signedModelOf(agent: Agent): string | null {
  const model = agent.signing.model.trim();
  if (model === '') return null;
  const version = agent.signing.version.trim();
  return version === '' ? model : `${model} ${version}`;
}

/**
 * The registry's identity view under `home`: agents by id, team records, and each team's own file
 * for the seat's label and display. Every read is lazy and kept for the life of the view, and a
 * read that fails is no answer, never an exception out of a display.
 */
export function registryIdentityView(home: string, known?: { root: string; team: TeamFile }): IdentityView {
  let teams: Readonly<Record<string, TeamRecord>> | null = null;
  // A caller that has just read a root's team file hands it in: the same read is not done again.
  const files = new Map<string, TeamFile | null>(known === undefined ? [] : [[known.root, known.team]]);
  const signed = new Map<string, string | null>();
  let nicknames: ReturnType<typeof seatNicknameReader> | null = null;
  const teamsOf = (): Readonly<Record<string, TeamRecord>> => {
    if (teams === null) {
      try {
        teams = readTeams(home);
      } catch {
        teams = {};
      }
    }
    return teams;
  };
  const fileOf = (root: string): TeamFile | null => {
    if (!files.has(root)) {
      let file: TeamFile | null = null;
      try {
        const loaded = readTeamConfig(root, { home });
        file = loaded.ok ? loaded.team : null;
      } catch {
        file = null;
      }
      files.set(root, file);
    }
    return files.get(root) ?? null;
  };
  const signedNicknameOf = (root: string, seat: string): string | null => {
    const key = `${root}\u0000${seat}`;
    if (!signed.has(key)) {
      nicknames ??= seatNicknameReader(home);
      const nickname = nicknames(root, seat);
      signed.set(key, nickname);
    }
    return signed.get(key) ?? null;
  };
  const seatOf = (teamId: string, team: TeamRecord, seatName: string, agentId: string | null, agent: Agent | null): IdentitySeat => {
    const file = fileOf(team.root);
    const declared: Seat | undefined = file?.seats.find((one) => one.name === seatName);
    const line = (agentId === null ? undefined : team.roster.find((entry) => entry.agent === agentId))
      ?? team.roster.find((entry) => entry.seat === seatName);
    return {
      seat: seatName,
      teamId,
      teamName: team.project,
      signedNickname: signedNicknameOf(team.root, seatName),
      nickname: line?.nickname ?? declared?.nickname ?? null,
      persona: declared === undefined ? null : labelPersona(declared),
      model: agent === null ? (declared === undefined ? null : `${declared.model} ${declared.version}`.trim() || null) : signedModelOf(agent),
      display: declared?.display ?? null,
    };
  };
  return {
    seatById(agentId) {
      const agent = getAgent(home, agentId);
      if (agent === null) return null;
      // The roster line that holds the id names the team (ids are unique across the registry);
      // the record's own `reach.team` answers only when no roster holds it.
      const held = Object.entries(teamsOf()).find(([, one]) => one.roster.some((line) => line.agent === agentId));
      if (held !== undefined) {
        const line = held[1].roster.find((entry) => entry.agent === agentId);
        return seatOf(held[0], held[1], line?.seat ?? agent.reach.seat, agentId, agent);
      }
      const team = teamsOf()[agent.reach.team];
      if (team === undefined) {
        return {
          seat: agent.reach.seat,
          teamId: agent.reach.team,
          teamName: agent.reach.team,
          signedNickname: null,
          nickname: null,
          persona: null,
          model: signedModelOf(agent),
          display: null,
        };
      }
      return seatOf(agent.reach.team, team, agent.reach.seat, agentId, agent);
    },
    otherSeats(agentId) {
      const out: IdentitySeat[] = [];
      for (const [teamId, team] of Object.entries(teamsOf())) {
        for (const line of team.roster) {
          if (line.agent === agentId) continue;
          out.push(seatOf(teamId, team, line.seat, line.agent, null));
        }
      }
      return out;
    },
  };
}

/** The identity a stamped record signs, from its own verified sender fields. */
export function signedIdentityOf(
  record: { from: string; from_id: string | null; from_client?: { client_id: string; grant_id: string } },
  home: string,
): FromIdentity {
  return encodeIdentity(senderIdentity(registryIdentityView(home), principalOf(record)));
}

/**
 * Whether this build writes `from_identity` (staged, review round 1). This build READS the field:
 * a stamped record that carries it renders its signed identity. It does not write it yet, because
 * the installed level-3 build (682867020) lists the stamped tree and refuses a signed field it
 * does not know, so a rollback to it, or a listener of it surviving the upgrade, would find every
 * new stamped record unsupported. The writer is enabled in a later release, once every build that
 * may still run or be rolled back to reads the field. Until then each copy names its sender from
 * the registry by id, as an unstamped record does.
 */
export const SIGN_FROM_IDENTITY = false;

/**
 * The payload with its sender identity signed in, when it is stamped and the writer is enabled
 * (`SIGN_FROM_IDENTITY`): `team send`, `team reply` and client ingress all call this after the
 * era is decided (`stampedPayload`). Any other payload is returned unchanged. A registry that
 * cannot answer still yields an identity (the signed spelling alone).
 */
export function withSignedIdentity<T extends { lvl?: 3; from: string; from_id: string | null; from_client?: { client_id: string; grant_id: string }; from_identity?: FromIdentity }>(
  payload: T,
  home: string,
): T {
  if (!SIGN_FROM_IDENTITY || payload.lvl !== 3 || payload.from_identity !== undefined) return payload;
  let identity: FromIdentity;
  try {
    identity = signedIdentityOf(payload, home);
  } catch {
    identity = encodeIdentity(senderIdentity({ seatById: () => null, otherSeats: () => [] }, principalOf(payload)));
  }
  return { ...payload, from_identity: identity };
}
