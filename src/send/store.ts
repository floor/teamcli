// The production reading of `messaging.store`: the receiving seat's chain — entity, project,
// team, seat — as the signed records and team-file words declare it. A level's word is the
// signed `messaging.store` policy its record holds; the team file's own word at the top level,
// or on the seat, fills in only where that level holds no signed record. A signed record shadows
// the file's word at its level: expired, or a value the catalogue cannot read, it leaves the
// level silent rather than reviving the word it replaced.
//
// Durability is the safe side (`src/settings/inherit.ts` ranks first > parallel > none), which
// decides what an unreadable source may do. The entity's word can only loosen the shipped
// `first` or close it again, so an entity source this reader cannot read leaves `first`
// standing — at least as much as any word it could have carried. The project, team and seat sit
// below the entity and may tighten what it loosened: a record that exists and cannot be read
// could hide a `first` under an entity's `none`, and falling through would keep less than the
// chain demands. Those three levels refuse the chain (`StoreChainUnreadable`) instead.
import type { ProjectRecord } from '../registry/projects.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { PolicySourceRead } from '../policy/resolve.ts';
import { readEntityPolicySource, readProjectPolicySource, readSeatPolicySource, readTeamPolicySource } from '../policy/sources.ts';
import { getPolicySpec, normalizePolicyName, type Policy } from '../policy/types.ts';
import { teamIdOf } from '../registry/teams.ts';
import type { MessagingStore, SettingLevel, WordDeclaration } from '../settings/inherit.ts';
import { MESSAGING_STORE } from '../settings/inherit.ts';
import { resolveWordSetting } from '../settings/resolve.ts';

/**
 * A project, team or seat record this reader cannot read. Each sits below the entity and may
 * tighten toward `first`; reading an unreadable record as no word would let an entity's `none`
 * stand where the lower level closed the door, so the chain refuses and the caller says so in
 * words of its own. The message is the plain reason.
 */
export class StoreChainUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreChainUnreadable';
  }
}

/** The store a send walks, the level whose word put it there, and the words the resolver set
 *  aside (a team or seat word that loosened, a value the catalogue cannot read). */
export type StoreChain = {
  value: MessagingStore;
  source: SettingLevel | null;
  refused: readonly WordDeclaration<MessagingStore>[];
};

/**
 * Reads the store the receiving seat's chain declares. `file` is the receiving team's validated
 * file when the caller already holds it, which every send does; a file this reader cannot load
 * declares nothing and the shipped `first` stands, as it does for an entity source that cannot
 * be read. The project's word is asked of the registry record for the project the team sits in;
 * a registry that cannot name the project, and a project policy record that exists and cannot
 * be read, throw `StoreChainUnreadable`, as do an unreadable team policy section and an
 * unreadable seat record — see the module comment for why those three levels refuse and the
 * entity does not.
 */
export function messagingStoreChainOf(input: {
  /** The receiving team's root. */
  root: string;
  /** The receiving seat's name, as the team file spells it. */
  seat: string;
  /** The receiving seat's agent id, when the roster knows it: the record the seat's signed
   *  policies live under. Absent, the seat's file word is the only word it can declare. */
  agentId: string | null;
  /** The home the records and the registry read from. */
  home: string;
  /** The receiving team's validated file, when the caller already holds it. */
  file?: TeamFile;
  /** The registry's answer for the project a team sits in, or null. */
  projectOfTeam: (teamId: string) => ProjectRecord | null;
  /** The instant an expiry is judged at; the wall clock when none is given. */
  now?: Date;
}): StoreChain {
  const now = input.now ?? new Date();
  let file = input.file;
  if (!file) {
    try {
      const loaded = readTeamConfig(input.root, { home: input.home });
      if (loaded.ok) file = loaded.team;
    } catch {
      // A file that cannot even be read declares nothing, as one that does not validate does.
    }
  }
  const found: Seat | undefined = file?.seats.find((one) => one.name === input.seat);
  const declared: WordDeclaration<MessagingStore>[] = [];

  // The entity's word only loosens or closes the shipped `first`: a source that cannot be read
  // leaves that default standing, which keeps at least as much as any word it could carry.
  const entitySource = readEntityPolicySource(input.home, file?.entity ?? null);
  const entity = entitySource.ok ? signedStoreOf(entitySource, now) : undefined;
  if (entity !== undefined && entity !== null) declared.push({ level: 'entity', value: entity });

  // The project's word can tighten the entity's loosening; a registry that cannot name the
  // project, or a project policy record that exists and cannot be read, refuses the chain.
  let projectId: string | null = null;
  try {
    projectId = input.projectOfTeam(teamIdOf(input.root))?.id ?? null;
  } catch (error) {
    throw new StoreChainUnreadable(
      `the project registry cannot name this team's project: ${(error as Error).message}`,
    );
  }
  const projectSource = readProjectPolicySource(input.home, projectId);
  if (!projectSource.ok && projectId !== null) {
    throw new StoreChainUnreadable(`the project's messaging.store record cannot be read: ${projectSource.why}`);
  }
  const project = projectSource.ok ? signedStoreOf(projectSource, now) : undefined;
  if (project !== undefined && project !== null) declared.push({ level: 'project', value: project });

  // The team's signed word shadows the file's own word at that level; a policy section the
  // source cannot read could hold the team's closing to `first`, so it refuses the chain.
  let team: MessagingStore | null | undefined;
  if (file !== undefined) {
    const teamSource = readTeamPolicySource(input.home, input.root, file);
    if (!teamSource.ok) {
      throw new StoreChainUnreadable(`the team's messaging.store record cannot be read: ${teamSource.why}`);
    }
    team = signedStoreOf(teamSource, now);
    if (team === undefined) team = file.messaging?.store;
  }
  if (team !== undefined && team !== null) declared.push({ level: 'team', value: team });

  // The seat's record is the last word and may always close the door; a record that exists and
  // cannot be read refuses rather than letting an entity's `none` stand through it.
  let seat: MessagingStore | undefined;
  if (input.agentId !== null) {
    const seatSource = readSeatPolicySource(input.home, input.agentId, found ?? null);
    if (!seatSource.ok) {
      throw new StoreChainUnreadable(`the seat's messaging.store record cannot be read: ${seatSource.why}`);
    }
    const signed = signedStoreOf(seatSource, now);
    seat = signed === null ? undefined : signed;
  }
  if (seat === undefined) seat = found?.messaging?.store;
  if (seat !== undefined) declared.push({ level: 'seat', value: seat });

  const resolved = resolveWordSetting(MESSAGING_STORE, declared, { now });
  return { value: resolved.value, source: resolved.source, refused: resolved.refused };
}

/**
 * One level's signed `messaging.store` word. `undefined` means the level holds no signed record
 * — a file word, when there is one, still applies. `null` means it holds one but no word
 * stands: every declaration it holds is expired or a value the catalogue cannot read, so the
 * level is silent and the file word it shadows does not come back. Only a signed record is read
 * here; a source reader may inject a legacy unsigned word beside the signed ones.
 */
function signedStoreOf(source: Extract<PolicySourceRead, { ok: true }>, now: Date): MessagingStore | null | undefined {
  const spec = getPolicySpec('messaging.store');
  let held = false;
  let word: MessagingStore | undefined;
  for (const policy of source.policies) {
    if (normalizePolicyName(policy.name) !== 'messaging.store') continue;
    if (!isSignedPolicy(policy)) continue;
    held = true;
    if (expiredPolicy(policy, now)) continue;
    const parsed = spec?.parseValue(policy.value) as MessagingStore | null | undefined;
    if (parsed) word = parsed;
  }
  if (!held) return undefined;
  return word ?? null;
}

/** A policy record that was signed, as opposed to a legacy word injected by a source reader. */
function isSignedPolicy(policy: Policy): boolean {
  return policy.setter !== null || policy.signature !== undefined;
}

/** An expired declaration counts as unset at its level, as it does in the policy chain. */
function expiredPolicy(policy: Policy, now: Date): boolean {
  if (!policy.expiry) return false;
  const at = Date.parse(policy.expiry);
  return Number.isFinite(at) && at <= now.getTime();
}
