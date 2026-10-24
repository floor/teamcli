// Owner-signed client grants: the record that admits one external client principal (its own app
// key, never a seat, never the owner) to one operation, sending to its entity's orchestrator.
//
// The record carries its own domain tag, so a client-grant signature is never an approval, a
// message or a standing grant. Its identity is a random id minted per issuance (`cg_` and 24 hex):
// a grant is never re-issued under a name an earlier grant used, so a revocation file can name the
// id and can never be overwritten by a later issuance.
//
// Revocation is appended, never an edit: each event writes a new file (a random event id in its
// name) created with O_EXCL. A revoked id is refused at every use. The check that decides "still
// active" and the write of a side effect are serialized against the appender by one lock file.
//
// The key file the client holds is mode 0600, in a directory this module refuses outside the
// client's own configuration folder. That is a file-hygiene boundary only: every seat runs as the
// owner's user, so a process running as that user can read the key. The runtime says so plainly
// (`KEY_ISOLATION_LINE`); it is never called isolation or enforcement.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { declaredEntityClients, declaredRoots } from '../entities.ts';
import { loadTeamFile } from '../file/load.ts';
import { isLeadSeat } from '../file/sections/lead.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import { approvalDifferences } from '../approve/approval.ts';
import type { Fingerprints } from '../approve/fingerprint.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { getAgent } from '../registry/agents.ts';
import { readTeams, type TeamRecord } from '../registry/teams.ts';
import { STATE_FILE } from '../state.ts';
import { keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { DAY_MS, GRANT_DURATION_DEFAULT_DAYS, endsAtMs } from './duration-policy.ts';
import { chooseGrantExpiry, projectIdOfTeamId } from './grant-duration.ts';
import { BUNDLE_DEFAULT_DAYS, DEVELOPER_ONLY_OPS, MANAGER_ONLY_OPS, bundleOpsOf, bundleSignsFile, canonicalBundleOps, isBundleName, isForbiddenBundleCommand, type BundleName, type BundleOp, type BundleSpecs } from './bundle-ops.ts';

/** The domain tag client-grant and client-revocation signatures carry. */
export const CLIENT_GRANT_DOMAIN = 'team-client-grant-v1\n';

/** The send-only vocabulary this build writes by default and honors. */
export const CLIENT_GRANT_VOCABULARY_VERSION = 1;

/** The vocabulary that also admits the client's own inbox: `send` and `messages`, exactly. It is
 *  written only when the owner asks for it (`--inbox`); a v1 grant is never widened in place. */
export const CLIENT_INBOX_VOCABULARY_VERSION = 2;

/** The ops a vocabulary-2 grant carries, exactly, in this order. */
export const CLIENT_INBOX_ALLOWED_OPS = ['send', 'messages'] as const;

/** The master vocabulary: a grant that also carries `grant`, the right to have TeamCLI issue
 *  sub-grants inside its signed `grant_scope`. Written only by the owner (`--allow-grant`). Its op
 *  list is exactly `send, grant` or `send, messages, grant`; an older build refuses it whole. */
export const CLIENT_MASTER_VOCABULARY_VERSION = 3;

/** One operation a client grant can admit. */
export type ClientOp = 'send' | 'messages' | 'grant';

/** Where a master grant may issue sub-grants. An entity admits every team of that entity; a team
 *  (by name) or a project (by project ID) admits only within the master grant's own entity. All
 *  three empty grants nothing. */
export type ClientGrantScope = { entities: string[]; projects: string[]; teams: string[] };

/** The ops a sub-grant may ever carry: never `grant`, so a sub-grant is never a master. */
export const CLIENT_SUB_GRANT_OPS: readonly ClientOp[] = ['send', 'messages'];

/** The owner-directed runtime line. It states the limit; it is not a claim of isolation. */
export const KEY_ISOLATION_LINE = 'key isolation: not enforced (pane guard pending)';

// This slice admits exactly one principal and one destination. The names are checked at issuance,
// in the stored record's decoder and again in the send resolver, so no path widens by a string.
export const CLIENT_SLICE_CLIENT_ID = 'grok-bot';
export const CLIENT_SLICE_ENTITY = 'floor';
export const CLIENT_SLICE_SEAT = 'orchestrator';
export const CLIENT_SLICE_ADDRESS = `${CLIENT_SLICE_SEAT}@${CLIENT_SLICE_ENTITY}`;

/** The seats a client reaches when the coordinator team's file names none for it under
 *  `clients:` — the orchestrator alone, so a file without the section behaves as before. */
export const CLIENT_DEFAULT_SEATS: readonly string[] = [CLIENT_SLICE_SEAT];

/**
 * Whether `clientId` may hold a grant on `entity`, and the seats the entity lets it address, from
 * the owner's entities file (`<entity>: clients: <client-id>: seats: [...]`). An entity that writes
 * no `clients:` admits only the default pair — `grok-bot` on `floor`, to the orchestrator — so a
 * machine with no such word behaves as before. An entity that writes one admits exactly the
 * clients it lists; a map that does not read refuses. Checked at issuance, decode and send.
 */
export function clientAdmission(
  home: string,
  clientId: string,
  entity: string,
): { ok: true; seats: readonly string[] } | { ok: false; why: string } {
  if (!CLIENT_WORD_PATTERN.test(clientId)) return refusal(`"${clientId}" is not a client id: one lowercase word, digits and hyphens`);
  if (!CLIENT_WORD_PATTERN.test(entity)) return refusal(`"${entity}" is not an entity name: one lowercase word, digits and hyphens`);
  let declared;
  try {
    declared = declaredEntityClients(home).get(entity);
  } catch {
    return refusal('the entities file cannot be read');
  }
  if (declared === undefined) {
    if (clientId !== CLIENT_SLICE_CLIENT_ID || entity !== CLIENT_SLICE_ENTITY) {
      return refusal(`entity "${entity}" declares no client "${clientId}"; with no \`clients:\` word only ${CLIENT_SLICE_CLIENT_ID} on ${CLIENT_SLICE_ENTITY} is admitted`);
    }
    return { ok: true, seats: CLIENT_DEFAULT_SEATS };
  }
  if (!declared.ok) return refusal(declared.why);
  const seats = declared.clients[clientId];
  if (seats === undefined) return refusal(`entity "${entity}" declares no client "${clientId}"`);
  return { ok: true, seats };
}

/** The one address a grant admits: its signed seat at its entity. */
export function clientAddressOf(grant: { recipientSeat: string; entity: string; team?: string }): string {
  return `${grant.recipientSeat}@${grant.team ?? grant.entity}`.toLowerCase();
}

/** The entity coordinator's immutable binding, signed into every grant. */
export const CLIENT_TEAM_ID_PATTERN = /^[0-9a-f]{12}$/;
export const CLIENT_AGENT_ID_PATTERN = /^agt_[0-9a-f]{12}$/;

/** A grant's identity: minted once per issuance, never reused. */
export const CLIENT_GRANT_ID_PATTERN = /^cg_[0-9a-f]{24}$/;

/** Twelve hex of the app key's SHA-256. */
export const CLIENT_KEY_ID_PATTERN = /^[0-9a-f]{12}$/;

/** An Ed25519 public key, raw: 32 bytes as 64 lowercase hex. */
export const CLIENT_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** A client id and an entity name: one lowercase word, hyphens allowed. */
export const CLIENT_WORD_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The release default for a send grant: seven days, both how long a grant lasts when `--expires`
 *  is absent and the cap when no `client-grant-max-duration` policy says otherwise. It is a
 *  default, not a ceiling: the owner's policy raises (or lowers) the cap, and `none` allows a grant
 *  with no end date (see `grant-duration.ts`). */
export const CLIENT_EXPIRY_MAX_MS = GRANT_DURATION_DEFAULT_DAYS.send * DAY_MS;

/** The one operation and the one destination role this slice admits. */
export const CLIENT_ALLOWED_OPS = ['send'] as const;
export const CLIENT_ALLOWED_ROLES = ['orchestrator'] as const;

/** The app key's file names, inside its canonical directory. */
export const CLIENT_KEY_FILE = 'client.key';
export const CLIENT_PUB_FILE = 'client.pub';

/** The grants folder, the same one the owner's standing records live in. */
export function clientGrantsFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'grants');
}

/** `<home>/.config/team-client`, the only parent a client key directory may sit under. */
export function clientKeyFolder(home: string = homedir()): string {
  return join(home, '.config', 'team-client');
}

/** One client's canonical key directory. */
export function clientKeyDir(home: string, clientId: string): string {
  return join(clientKeyFolder(home), clientId);
}

/** A fresh grant id: random, minted per issuance, never a reused name. */
export function clientGrantId(): string {
  return `cg_${randomBytes(12).toString('hex')}`;
}

export function clientGrantPath(home: string, grantId: string): string {
  return join(clientGrantsFolder(home), `${grantId}.json`);
}

/** One verified client grant, exactly as written and signed. */
export type ClientGrantRecord = {
  grantId: string;
  clientId: string;
  entity: string;
  publicKey: string;
  keyId: string;
  keyDir: string;
  /** The entity coordinator and its lead agent, resolved at issuance and signed: the send may
   *  use no other team or recipient, whatever the registry says later. */
  teamId: string;
  recipientId: string;
  recipientSeat: string;
  /** The target team's name, when the owner named one with `--team`; absent means the entity's
   *  coordinator team (the team named like the entity), so a grant written before it reads as
   *  before. The address the grant admits is `<recipientSeat>@<team>`. */
  team?: string;
  /** `['send']` on vocabulary 1, `['send','messages']` on vocabulary 2, and on vocabulary 3 one
   *  of those followed by `grant`. */
  allowedOps: ClientOp[];
  allowedRoles: ['orchestrator'];
  issued: string;
  /** The end of the grant as signed, or `null`: no end date. A null expiry is written only when the
   *  owner's `client-grant-max-duration` policy said `none`; the grant then lasts until revoked.
   *  It is the JSON `null` on disk, never an absent field, so an older build (which reads a string
   *  here) refuses the whole record. */
  expires: string | null;
  vocabulary: 1 | 2 | 3;
  /** Vocabulary 3 only: where this master grant may issue sub-grants. */
  grantScope?: ClientGrantScope;
  /** Set on a sub-grant: the master grant id it was issued under. Signed, so a sub-grant always
   *  names its master, and revoking the master stops the sub-grant at its next use. */
  issuedBy?: string;
};

/** One verified appended revocation. */
export type ClientRevocationRecord = { revocationId: string; grantId: string; by: 'owner'; at: string };

export type ClientGrantRead =
  | { ok: true; grant: ClientGrantRecord; signature: string }
  | { ok: false; why: string };

export type ClientGrantRequest = {
  clientId: string;
  entity: string;
  publicKey: string;
  keyId: string;
  keyDir: string;
  /** Absent means the default length (7 days, or the cap when that is shorter); anything past the
   *  `client-grant-max-duration` cap in force is refused. */
  expires?: string;
  /** No end date (`--expires never`): written only when the policy in force says `none`, and never
   *  with `expires`, `grantScope` or `issuedBy`. */
  neverExpires?: boolean;
  /** The seat the grant addresses; absent means the orchestrator. It must be one the coordinator
   *  team's approved `clients:` section lists for this client (or the default, orchestrator). */
  seat?: string;
  /** The target team by name; absent (or the entity's own name) means the entity's coordinator
   *  team, and the grant then carries no `team` field, byte-shape unchanged. */
  team?: string;
  /** When true, the grant is vocabulary 2 and carries `send` and `messages`; omitted or false
   *  writes the shipped vocabulary 1, send only, byte-shape unchanged. */
  inbox?: boolean;
  /** When present, the grant is a master grant (vocabulary 3) carrying `grant` and this scope.
   *  Owner path only. */
  grantScope?: ClientGrantScope;
  /** When present, the grant is a sub-grant issued under this master id. Never with grantScope. */
  issuedBy?: string;
};

export type ClientGrantOptions = { now?: Date; key?: KeyObject };

/** The one sentence every refusal of a client grant starts with. */
function refusal(why: string): { ok: false; why: string } {
  return { ok: false, why };
}

// ---- keys ----------------------------------------------------------------------------------

// The fixed SPKI prefix for a raw Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyObject(rawHex: string): KeyObject | null {
  if (!CLIENT_PUBLIC_KEY_PATTERN.test(rawHex)) return null;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The raw public half of one private key, and the id derived from it. */
export function publicRawOf(privatePem: string): { publicKey: string; keyId: string } {
  const publicKey = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = publicKey.subarray(publicKey.length - 32).toString('hex');
  return { publicKey: raw, keyId: keyIdOf(raw) };
}

export function keyIdOf(rawHex: string): string {
  return createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest('hex').slice(0, 12);
}

export type ClientKeyPair = { privatePem: string; publicKey: string; keyId: string };

/** A fresh Ed25519 pair for one client. The private half never leaves the client's directory. */
export function newClientKeyPair(): ClientKeyPair {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const { publicKey, keyId } = publicRawOf(privatePem);
  return { privatePem, publicKey, keyId };
}

/**
 * The sessions a placement check reads from `<dir>/team.state.json`, strictly, or null when the
 * team has no state record. This reader is deliberately local: the shared state reader fills an
 * absent `seats` or `worktrees` map with `{}`, so through it a present `null` map and a map an
 * older record does not carry are the same value. A placement check must tell a broken record
 * from an old one, so it reads the raw record and refuses a present map of an unknown shape.
 */
function readPlacementSessions(dir: string): Record<string, unknown> | null {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a team state of format 1`);
  }
  const state = parsed as { format?: unknown; sessions?: unknown };
  if (state.format !== 1 || state.sessions === null || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
    throw new Error(`${path} is not a team state of format 1`);
  }
  return state.sessions as Record<string, unknown>;
}

/** The team's declarations, as the placement check reads them: a file that is absent, one that
 *  cannot be read or does not validate, or the team file it read. The text and schema alone are
 *  judged here, never the placement rules a launch applies: a declaration can legitimately omit a
 *  trust section, or trust a folder without listing the derived lobby, and still name the folder
 *  its seats run in. */
type DeclaredTeam =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'invalid' }
  | { kind: 'read'; team: TeamFile };

function readDeclarations(root: string, home: string): DeclaredTeam {
  if (!existsSync(join(root, '.agents', 'team.yaml'))) return { kind: 'absent' };
  let loaded: ReturnType<typeof loadTeamFile>;
  try {
    loaded = loadTeamFile(root, { file: join(root, '.agents', 'team.yaml'), home, checkOnly: true });
  } catch {
    return { kind: 'unreadable' };
  }
  if (!loaded.ok) return { kind: 'invalid' };
  return { kind: 'read', team: loaded.team };
}

/** The folder a declaration launches its seat in, resolved from recorded and declared placement
 *  metadata only: the seat's declared cwd against the recorded team root, the recorded root for a
 *  lead, and the session's RECORDED lobby for a seat that waits in one. A session that recorded no
 *  lobby falls back to the folder the declaration itself names in `lobby:`, never to a lobby
 *  recomputed from HOME; a seat with neither is ambiguous and the caller refuses in these words
 *  rather than guessing one. This is folder discovery, not a launch decision: no trust rule or
 *  protected-checkout rule takes part, so a folder the record names cannot block a key for a
 *  reason that belongs to `up`. */
function declaredLaunchFolder(
  team: TeamFile,
  seat: Seat,
  root: string,
  home: string,
  recordedLobby: string | undefined,
  project: string,
  session: string,
): { ok: true; folder: string } | { ok: false; why: string } {
  if (seat.cwd !== '.') return { ok: true, folder: resolve(root, seat.cwd) };
  if (isLeadSeat(team, seat.name)) return { ok: true, folder: root };
  const declared = team.lobby === null || team.lobby === ''
    ? undefined
    : (() => {
        const expanded = team.lobby.replace(/^~(?=$|\/)/, home);
        return isAbsolute(expanded) ? expanded : resolve(root, expanded);
      })();
  const lobby = recordedLobby !== undefined && recordedLobby !== '' ? recordedLobby : declared;
  if (lobby === undefined) {
    return {
      ok: false,
      why: `the session "${session}" of team "${project}" records no lobby and the declaration names none, so the folder seat "${seat.name}" starts in cannot be resolved`,
    };
  }
  return { ok: true, folder: lobby };
}

/**
 * Why a key directory may not hold a client key, or null. The directory must be absolute, under
 * `<home>/.config/team-client/`, outside every registered team root and lobby, outside every
 * `.agents` tree and outside the OS temp directory, with no symbolic link on its path. This is a
 * placement refusal, not proof that another same-user process cannot read the key.
 */
export function clientKeyPlacementProblem(home: string, dir: string): string | null {
  if (!isAbsolute(dir)) return `the key directory "${dir}" is not absolute`;
  if (hasDotTraversal(dir)) return `the key directory "${dir}" walks through "." or ".."; name the real path`;
  const base = canonical(join(home, '.config', 'team-client'));
  const target = canonical(dir);
  if (!inside(base, target)) {
    return `the key directory "${dir}" is outside ${join(home, '.config', 'team-client')}: a client key sits only there`;
  }
  const linked = symlinkComponent(dir);
  if (linked !== null) return `the key directory "${dir}" has a symbolic link at "${linked}"; a client key path takes no links`;
  const temp = canonical(tmpdir());
  if (overlaps(temp, target)) return `the key directory "${dir}" overlaps the OS temp directory; a client key sits only in its configuration folder`;
  let teams: ReturnType<typeof readTeams>;
  try {
    teams = readTeams(home);
  } catch {
    return 'the team registry cannot be read: client key placement cannot be checked';
  }
  for (const team of Object.values(teams)) {
    const root = canonical(team.root);
    // The declarations are read once per team: the declared seats' own folders below, and the
    // launch folder a record an older version wrote falls back to when it carries no `start_cwd`.
    // A file that is present but does not read leaves the placement unknown, and so does a
    // missing declaration for a recorded seat: both refuse rather than skip the seat.
    let declarations: DeclaredTeam | undefined;
    const declaredTeam = (): DeclaredTeam => {
      declarations ??= readDeclarations(team.root, home);
      return declarations;
    };
    if (overlaps(root, target)) return `the key directory "${dir}" is inside the team root "${team.root}"; a client key sits outside every checkout`;
    for (const lobby of Object.values(team.lobbies ?? {})) {
      if (lobby && overlaps(canonical(lobby), target)) {
        return `the key directory "${dir}" is inside a team lobby; a client key sits outside every lobby`;
      }
    }
    // A seat runs as this user in a folder the state records, and the session records every
    // worktree it made; a key there is inside the seat's own checkout. The placement check reads
    // the raw record, so a present `null` map is refused instead of normalized away. A field that
    // is present but is not a readable absolute path is not placement evidence, and an entry of
    // an unknown shape cannot be checked: both refuse rather than place the key beside it. A
    // field an older record simply does not carry is absent, not unknown, and stays absent for a
    // seat recorded as not yet ready.
    let sessions: Record<string, unknown> | null;
    try {
      sessions = readPlacementSessions(join(team.root, '.agents'));
    } catch {
      return `the recorded seat folders of team "${team.project}" cannot be read: client key placement cannot be checked`;
    }
    for (const [sessionName, rawSession] of Object.entries(sessions ?? {})) {
      if (rawSession === null || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
        return `the recorded session "${sessionName}" of team "${team.project}" is not a state record: client key placement cannot be checked`;
      }
      const session = rawSession as { seats?: unknown; worktrees?: unknown };
      // The lobby this session recorded when it registered; never one recomputed from HOME.
      const recordedLobby = team.lobbies?.[sessionName];
      if (session.seats !== undefined && (session.seats === null || typeof session.seats !== 'object' || Array.isArray(session.seats))) {
        return `the recorded seats of session "${sessionName}" cannot be read: client key placement cannot be checked`;
      }
      for (const [seatName, rawSeat] of Object.entries((session.seats ?? {}) as Record<string, unknown>)) {
        if (rawSeat === null || typeof rawSeat !== 'object' || Array.isArray(rawSeat)) {
          return `the recorded seat "${seatName}" is not a seat record: client key placement cannot be checked`;
        }
        const seat = rawSeat as {
          stage?: unknown;
          start_cwd?: unknown;
          pane?: unknown;
          launched?: unknown;
          workspace?: unknown;
          agent_session?: unknown;
        };
        if (seat.start_cwd === undefined) {
          // A seat at ready or launched is running, and a named seat that carries a pane, a
          // workspace, a launched identity or an agent session has been seen by the runtime: its
          // record carries no folder, so the folder it really started in is the one its
          // declaration names — the declared cwd against the recorded team root, the recorded
          // root for a lead, the session's recorded lobby for a lobby seat — never the caller's
          // working folder, a folder derived from HOME, or a process inferred from a pid. Only a
          // named legacy record with none of that evidence may legitimately carry no start
          // folder; an unknown stage cannot be cleared as inactive either.
          const inactiveNamed =
            seat.stage === 'named' &&
            seat.pane === undefined &&
            seat.launched === undefined &&
            seat.workspace === undefined &&
            seat.agent_session === undefined;
          if (!inactiveNamed) {
            const absent = `the recorded seat "${seatName}" carries no start folder`;
            const file = declaredTeam();
            if (file.kind === 'absent') {
              return `${absent} and team "${team.project}" declares no seats (there is no .agents/team.yaml): client key placement cannot be checked`;
            }
            if (file.kind === 'unreadable') {
              return `${absent} and the team file of "${team.project}" cannot be read: client key placement cannot be checked`;
            }
            if (file.kind === 'invalid') {
              return `${absent} and the team file of "${team.project}" does not validate: client key placement cannot be checked`;
            }
            const declaration = file.team.seats.find((candidate) => candidate.name === seatName);
            if (declaration === undefined) {
              return `${absent} and the team file of "${team.project}" declares no seat by that name: client key placement cannot be checked`;
            }
            const launch = declaredLaunchFolder(file.team, declaration, team.root, home, recordedLobby, team.project, sessionName);
            if (!launch.ok) {
              return `${absent} and its declaration's launch folder cannot be resolved (${launch.why}): client key placement cannot be checked`;
            }
            if (overlaps(canonical(launch.folder), target)) {
              return `the key directory "${dir}" is inside the folder seat "${seatName}" ran in; a client key sits outside every seat folder`;
            }
          }
          continue;
        }
        const cwd = seat.start_cwd;
        if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
          return `the recorded start folder of seat "${seatName}" is not an absolute path: client key placement cannot be checked`;
        }
        if (overlaps(canonical(cwd), target)) {
          return `the key directory "${dir}" is inside the folder seat "${seatName}" ran in; a client key sits outside every seat folder`;
        }
      }
      if (session.worktrees !== undefined && (session.worktrees === null || typeof session.worktrees !== 'object' || Array.isArray(session.worktrees))) {
        return `the recorded worktrees of session "${sessionName}" cannot be read: client key placement cannot be checked`;
      }
      for (const [branch, rawWorktree] of Object.entries((session.worktrees ?? {}) as Record<string, unknown>)) {
        if (rawWorktree === null || typeof rawWorktree !== 'object' || Array.isArray(rawWorktree)) {
          return `the recorded worktree "${branch}" is not a worktree record: client key placement cannot be checked`;
        }
        const recordedPath = (rawWorktree as { path?: unknown }).path;
        if (typeof recordedPath !== 'string' || recordedPath === '') {
          return `the recorded path of worktree "${branch}" is not a path: client key placement cannot be checked`;
        }
        // A legacy record may hold the worktree path relative to the team root. It is resolved
        // against that root only, never against the caller's working folder or a seat folder, so
        // an old record names its real worktree for the overlap check instead of blocking every
        // key directory. An absolute path is used as it is; both go through the same symlink-
        // aware canonical form, which stays lexical for a path that no longer exists.
        const worktreePath = isAbsolute(recordedPath) ? recordedPath : resolve(team.root, recordedPath);
        if (overlaps(canonical(worktreePath), target)) {
          return `the key directory "${dir}" is inside the recorded worktree "${branch}"; a client key sits outside every worktree`;
        }
      }
    }
    // The team file names where each seat starts, and a trust path can put that folder outside
    // the root. A file that is present but does not read leaves the placement unknown: refuse.
    // This is the same declaration the seat fallback above reads, read once for the team.
    const file = declaredTeam();
    if (file.kind === 'unreadable') {
      return `the team file of "${team.project}" cannot be read: client key placement cannot be checked`;
    }
    if (file.kind === 'invalid') {
      return `the team file of "${team.project}" does not validate: client key placement cannot be checked`;
    }
    if (file.kind === 'read') {
      for (const seat of file.team.seats) {
        const cwd = canonical(resolve(team.root, seat.cwd));
        if (overlaps(cwd, target)) {
          return `the key directory "${dir}" is inside the folder seat "${seat.name}" starts in; a client key sits outside every seat folder`;
        }
      }
    }
  }
  return null;
}

/**
 * Reads one client private key under the file-hygiene rules: a regular file of the current user,
 * no symbolic link, mode 0600 (no group or other bits), inside a canonical client key directory.
 */
export function readClientPrivateKey(home: string, path: string): { ok: true; privatePem: string; publicKey: string; keyId: string } | { ok: false; why: string } {
  if (!isAbsolute(path)) return refusal(`the key file "${path}" is not absolute`);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return refusal(`the key file "${path}" cannot be read`);
  }
  if (stat.isSymbolicLink()) return refusal(`the key file "${path}" is a symbolic link; a client key is a plain file`);
  if (!stat.isFile()) return refusal(`the key file "${path}" is not a regular file`);
  if (process.getuid !== undefined && stat.uid !== process.getuid()) return refusal(`the key file "${path}" belongs to another user`);
  if ((stat.mode & 0o077) !== 0) {
    return refusal(`the key file "${path}" is readable by a group or another user (mode ${(stat.mode & 0o777).toString(8)}); it must be 0600`);
  }
  if ((stat.mode & 0o400) === 0) return refusal(`the key file "${path}" is not readable by its owner`);
  const placement = clientKeyPlacementProblem(home, dirname(path));
  if (placement !== null) return refusal(placement);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return refusal(`the key file "${path}" cannot be read`);
  }
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return refusal(`the key file "${path}" is not whole JSON`);
  }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return refusal(`the key file "${path}" is not a client key`);
  const fields = stored as Record<string, unknown>;
  if (fields.format !== 1 || fields.algorithm !== 'ed25519' || typeof fields.private !== 'string') {
    return refusal(`the key file "${path}" is not a client key`);
  }
  let derived: { publicKey: string; keyId: string };
  try {
    derived = publicRawOf(fields.private);
  } catch {
    return refusal(`the key file "${path}" does not parse as an Ed25519 key`);
  }
  return { ok: true, privatePem: fields.private, ...derived };
}

/** The key file a client writes, whole, mode 0600. Created with O_EXCL: never replaced. */
export function writeClientKeyFiles(dir: string, pair: ClientKeyPair): { ok: true; keyPath: string; pubPath: string } | { ok: false; why: string } {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    return refusal(`the key directory "${dir}" cannot be created`);
  }
  const keyPath = join(dir, CLIENT_KEY_FILE);
  const pubPath = join(dir, CLIENT_PUB_FILE);
  try {
    writeFileSync(keyPath, `${JSON.stringify({ format: 1, algorithm: 'ed25519', private: pair.privatePem }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(pubPath, `${JSON.stringify({ public_key: pair.publicKey, key_id: pair.keyId, key_dir: dir }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return refusal(`a client key already exists in "${dir}"; a key is never replaced`);
    return refusal(`the client key could not be written in "${dir}"`);
  }
  return { ok: true, keyPath, pubPath };
}

// ---- grant records -------------------------------------------------------------------------

/** What the signature covers: the record's name and the whole mapping. */
function grantPayload(name: string, grant: Json): Json {
  return { name, client_grant: grant };
}

function onDiskGrant(grant: ClientGrantRecord): Record<string, Json> {
  return {
    grant_id: grant.grantId,
    client_id: grant.clientId,
    entity: grant.entity,
    public_key: grant.publicKey,
    key_id: grant.keyId,
    key_dir: grant.keyDir,
    team_id: grant.teamId,
    recipient_id: grant.recipientId,
    recipient_seat: grant.recipientSeat,
    ...(grant.team !== undefined ? { team: grant.team } : {}),
    allowed_ops: [...grant.allowedOps],
    allowed_roles: [...grant.allowedRoles],
    issued: grant.issued,
    expires: grant.expires,
    vocabulary: grant.vocabulary,
    ...(grant.grantScope !== undefined
      ? { grant_scope: { entities: [...grant.grantScope.entities], projects: [...grant.grantScope.projects], teams: [...grant.grantScope.teams] } }
      : {}),
    ...(grant.issuedBy !== undefined ? { issued_by: grant.issuedBy } : {}),
  };
}

/** The problem with a scope's words, or null: lowercase words, none repeated in one list. */
export function clientGrantScopeProblem(scope: ClientGrantScope): string | null {
  for (const field of ['entities', 'projects', 'teams'] as const) {
    const list = scope[field];
    if (!Array.isArray(list)) return `grant scope ${field} is not a list`;
    for (const word of list) {
      if (typeof word !== 'string' || !CLIENT_WORD_PATTERN.test(word)) return `"${String(word)}" is not a ${field} scope word: one lowercase word, digits and hyphens`;
    }
    if (new Set(list).size !== list.length) return `grant scope ${field} names a word twice`;
  }
  return null;
}

/** Whether a master scope admits a target: entity anywhere; team or project inside its own entity. */
export function clientGrantScopeAdmits(
  master: { entity: string; grantScope?: ClientGrantScope },
  target: { entity: string; team: string; project: string },
): boolean {
  const scope = master.grantScope;
  if (scope === undefined) return false;
  if (scope.entities.includes(target.entity)) return true;
  if (target.entity !== master.entity) return false;
  return scope.teams.includes(target.team) || scope.projects.includes(target.project);
}

export type EntityCoordinator = {
  entity: string;
  teamId: string;
  teamRoot: string;
  session: string;
  recipientId: string;
  recipientSeat: string;
};

/**
 * The entity's one coordinator team and its one lead agent, read from the registry: the team
 * whose `entity` and `project` are both the entity, its unique `leads: true` seat, that seat's
 * role and registered agent id. Nothing here reads the current folder, a running pane or a bare
 * seat name. A declared entity root, when the entities file names one, must hold the team root.
 */
export function resolveEntityCoordinator(
  home: string,
  entity: string,
  target: { seat?: string; clientId?: string; team?: string } = {},
): { ok: true; coordinator: EntityCoordinator } | { ok: false; why: string } {
  const wanted = target.seat ?? CLIENT_SLICE_SEAT;
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(home);
  } catch {
    return refusal('the team registry cannot be read');
  }
  const teamName = target.team ?? entity;
  if (!CLIENT_WORD_PATTERN.test(teamName)) return refusal(`"${teamName}" is not a team name: one lowercase word, digits and hyphens`);
  const coordinators = Object.values(teams).filter((team) => team.entity === entity && team.project === teamName);
  if (coordinators.length !== 1) {
    const what = teamName === entity ? 'coordinator team' : `team "${teamName}"`;
    return refusal(
      coordinators.length === 0
        ? `no ${what} of entity "${entity}" is registered`
        : `entity "${entity}" has ${String(coordinators.length)} records for ${what}; a client grant needs exactly one`,
    );
  }
  const team = coordinators[0] as TeamRecord;
  if (team.lifecycle === 'archived') return refusal(`team "${team.project}" is archived`);
  const teamId = team.id ?? '';
  if (!CLIENT_TEAM_ID_PATTERN.test(teamId)) return refusal(`team "${team.project}" has no registry id`);
  if (!isAbsolute(team.root)) return refusal(`team "${team.project}" has no absolute root`);
  const admitted = clientAdmission(home, target.clientId ?? CLIENT_SLICE_CLIENT_ID, entity);
  if (!admitted.ok) return refusal(admitted.why);
  const allowed = clientSeatsAt(team.root, home, target.clientId ?? CLIENT_SLICE_CLIENT_ID, admitted.seats);
  if (!allowed.ok) return refusal(allowed.why);
  if (allowed.seats.length === 0) return refusal(`team "${team.project}" lists no seat a client may address`);
  if (!allowed.seats.includes(wanted)) {
    return refusal(`team "${team.project}" does not list "${wanted}" among the seats a client may address (${allowed.seats.join(', ')})`);
  }
  let lead: TeamRecord['roster'][number];
  if (wanted === CLIENT_SLICE_SEAT) {
    const leads = team.roster.filter((entry) => entry.leads === true);
    if (leads.length !== 1) {
      return refusal(
        leads.length === 0
          ? `team "${team.project}" marks no lead seat; a client grant needs one`
          : `team "${team.project}" marks ${String(leads.length)} lead seats; a client grant needs exactly one`,
      );
    }
    lead = leads[0] as TeamRecord['roster'][number];
    if (lead.seat.toLowerCase() !== CLIENT_SLICE_SEAT || lead.role.toLowerCase() !== CLIENT_SLICE_SEAT) {
      return refusal(`team "${team.project}" leads with "${lead.seat}" (${lead.role}), not ${CLIENT_SLICE_SEAT}`);
    }
  } else {
    const held = team.roster.filter((entry) => entry.seat === wanted);
    if (held.length !== 1) return refusal(`team "${team.project}" has no single roster seat "${wanted}"`);
    lead = held[0] as TeamRecord['roster'][number];
    if (allowed.refused.includes(wanted)) return refusal(`"${wanted}" is the operator or a human seat; a client never addresses it`);
  }
  const roots = declaredRoots(home).get(entity);
  if (roots !== undefined && !roots.some((allowed) => sameFolder(allowed, team.root))) {
    return refusal(`team "${team.project}" sits outside the roots entity "${entity}" declares`);
  }
  let agent;
  try {
    agent = getAgent(home, lead.agent);
  } catch {
    return refusal('the agent registry cannot be read');
  }
  if (agent === null) return refusal(`no registered agent carries the lead seat's id ${lead.agent}`);
  if (agent.reach.seat !== lead.seat) return refusal(`agent ${agent.id} does not hold seat "${lead.seat}"`);
  if (agent.reach.team !== teamId) {
    return refusal(`agent ${agent.id} is not recorded on team "${teamId}"`);
  }
  if (agent.lifecycle === 'retired') return refusal(`agent ${agent.id} is retired`);
  return {
    ok: true,
    coordinator: {
      entity,
      teamId,
      teamRoot: team.root,
      session: team.session,
      recipientId: agent.id,
      recipientSeat: lead.seat,
    },
  };
}

export type ClientGrantPlan = { ok: true; grant: ClientGrantRecord } | { ok: false; why: string };

/** Validates one grant and builds the record a write signs — an id is minted only by the write. */
export function planClientGrant(home: string, request: ClientGrantRequest, options: ClientGrantOptions = {}): ClientGrantPlan {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const inbox = request.inbox === true;
  if (!Number.isFinite(nowMs)) return refusal('the issued time is not a readable timestamp');
  const master = request.grantScope !== undefined;
  if (master && request.issuedBy !== undefined) return refusal('a sub-grant never carries grant: master grants do not chain');
  if (master) {
    const problem = clientGrantScopeProblem(request.grantScope!);
    if (problem !== null) return refusal(problem);
  }
  if (request.issuedBy !== undefined && !CLIENT_GRANT_ID_PATTERN.test(request.issuedBy)) return refusal(`"${request.issuedBy}" is not a client grant id`);
  const admitted = clientAdmission(home, request.clientId, request.entity);
  if (!admitted.ok) return refusal(admitted.why);
  const team = request.team === undefined || request.team === request.entity ? undefined : request.team;
  const coordinator = resolveEntityCoordinator(home, request.entity, {
    clientId: request.clientId,
    ...(team !== undefined ? { team } : {}),
    ...(request.seat !== undefined ? { seat: request.seat } : {}),
  });
  if (!coordinator.ok) return refusal(coordinator.why);
  if (!CLIENT_WORD_PATTERN.test(request.clientId)) {
    return refusal(`"${request.clientId}" is not a client id: one lowercase word, digits and hyphens`);
  }
  if (!CLIENT_WORD_PATTERN.test(request.entity)) {
    return refusal(`"${request.entity}" is not an entity name: one lowercase word, digits and hyphens`);
  }
  if (!CLIENT_PUBLIC_KEY_PATTERN.test(request.publicKey)) {
    return refusal(`"${request.publicKey}" is not an Ed25519 public key: 64 lowercase hex`);
  }
  if (request.keyId !== keyIdOf(request.publicKey)) {
    return refusal(`the key id "${request.keyId}" is not the public key's own (${keyIdOf(request.publicKey)})`);
  }
  const placement = clientKeyPlacementProblem(home, request.keyDir);
  if (placement !== null) return refusal(placement);
  // How long it lasts is the `client-grant-max-duration` policy's word (7 days by default); an
  // unreadable chain refuses. A master grant and a sub-grant always carry an end date.
  const chosen = chooseGrantExpiry({
    home,
    kind: 'send',
    entity: request.entity,
    projectId: projectIdOfTeamId(home, coordinator.coordinator.teamId),
    now,
    expires: request.expires,
    never: request.neverExpires,
    allowNever: !master && request.issuedBy === undefined,
    noun: master ? 'master grant' : request.issuedBy !== undefined ? 'sub-grant' : 'client grant',
  });
  if (!chosen.ok) return refusal(chosen.why);
  const expires = chosen.expires;
  return {
    ok: true,
    grant: {
      grantId: '',
      clientId: request.clientId,
      entity: request.entity,
      publicKey: request.publicKey,
      keyId: request.keyId,
      keyDir: canonical(request.keyDir),
      teamId: coordinator.coordinator.teamId,
      recipientId: coordinator.coordinator.recipientId,
      recipientSeat: coordinator.coordinator.recipientSeat,
      ...(team !== undefined ? { team } : {}),
      allowedOps: [...(inbox ? CLIENT_INBOX_ALLOWED_OPS : CLIENT_ALLOWED_OPS), ...(master ? (['grant'] as const) : [])],
      allowedRoles: [...CLIENT_ALLOWED_ROLES],
      issued: now.toISOString(),
      expires,
      vocabulary: master ? CLIENT_MASTER_VOCABULARY_VERSION : inbox ? CLIENT_INBOX_VOCABULARY_VERSION : CLIENT_GRANT_VOCABULARY_VERSION,
      ...(master ? { grantScope: { entities: [...request.grantScope!.entities], projects: [...request.grantScope!.projects], teams: [...request.grantScope!.teams] } } : {}),
      ...(request.issuedBy !== undefined ? { issuedBy: request.issuedBy } : {}),
    },
  };
}

/**
 * Writes one owner-signed client grant under a fresh random id, created with O_EXCL: an id that
 * already names a file is never written over (a new id is minted instead).
 */
export function writeClientGrant(
  home: string,
  request: ClientGrantRequest,
  options: ClientGrantOptions = {},
): { ok: true; grant: ClientGrantRecord; path: string } | { ok: false; why: string } {
  const plan = planClientGrant(home, request, options);
  if (!plan.ok) return plan;
  const folder = clientGrantsFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return refusal(`the grants folder "${folder}" cannot be created`);
  }
  const key = options.key ?? keyOf(home);
  for (let attempt = 0; attempt < 3; attempt++) {
    const grant: ClientGrantRecord = { ...plan.grant, grantId: clientGrantId() };
    const disk = onDiskGrant(grant);
    const signature = signDomain(CLIENT_GRANT_DOMAIN, grantPayload(grant.grantId, disk), key);
    const path = clientGrantPath(home, grant.grantId);
    const published = publishExclusive(folder, `${grant.grantId}.json`, `${JSON.stringify({ client_grant: disk, signature }, null, 2)}\n`);
    if (published === 'written') return { ok: true, grant, path };
    if (published === 'exists') continue;
    return refusal(`the client grant could not be published in "${folder}"`);
  }
  return refusal('a fresh grant id could not be found; nothing was written');
}

/** One verified owner-signed client grant from a file, or the reason it is not one. */
export function readClientGrantFile(home: string, path: string): ClientGrantRead {
  const state = keyState(home);
  if (state.kind !== 'key') return refusal('the owner signing key is absent or unreadable: no client grant can verify');
  let text: string;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return refusal(`the grant file "${path}" is a symbolic link; a client grant is a plain file`);
    if (!stat.isFile()) return refusal(`the grant file "${path}" is not a regular file`);
    if (process.getuid !== undefined && stat.uid !== process.getuid()) return refusal(`the grant file "${path}" belongs to another user`);
    text = readFileSync(path, 'utf8');
  } catch {
    return refusal(`the grant file "${path}" cannot be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refusal(`the grant file "${path}" is not whole JSON`);
  }
  // An up grant is a different record: it admits `team up --client` for one team and never a send,
  // a read or a sub-grant. Said plainly here, so a send that is handed one knows what it holds.
  if (claimsBundleVocabulary(parsed)) {
    return refusal(`the grant file "${path}" is a bundle grant (${claimedBundleOps(parsed).join(', ')}): it admits those commands for one team through their own --client forms, and this route does not read it`);
  }
  if (claimsUpVocabulary(parsed)) {
    const claimed = claimedTeamOps(parsed);
    const admits = claimed.map((op) => `\`team ${op} --client ${path} --key <client.key>\``).join(' and ');
    return refusal(`the grant file "${path}" is ${teamGrantLabelWithArticle(claimed)}: it admits ${admits} for one team and nothing else, never send, messages or grant`);
  }
  const record = clientGrantFrom(parsed, state.key);
  if (record === null) return refusal(`the grant file "${path}" is not a verified owner-signed client grant`);
  const admitted = clientAdmission(home, record.grant.clientId, record.grant.entity);
  if (!admitted.ok) return refusal(admitted.why);
  return { ok: true, grant: record.grant, signature: record.signature };
}

/** The verified grant for `grantId` from the canonical store, or the reason it is not there. */
export function readClientGrant(home: string, grantId: string): ClientGrantRead {
  if (!CLIENT_GRANT_ID_PATTERN.test(grantId)) return refusal(`"${grantId}" is not a client grant id`);
  return readClientGrantFile(home, clientGrantPath(home, grantId));
}

/**
 * Whether the presented grant is the canonical store's own record for its id: the canonical file
 * exists, verifies under the owner key, and every field and the signature match the presented
 * copy. A detached copy is never a bearer token by itself.
 */
export function canonicalClientGrant(home: string, presented: { grant: ClientGrantRecord; signature: string }): ClientGrantRead {
  const canonical = readClientGrant(home, presented.grant.grantId);
  if (!canonical.ok) return canonical;
  const fields: (keyof ClientGrantRecord)[] = ['grantId', 'clientId', 'entity', 'publicKey', 'keyId', 'keyDir', 'teamId', 'recipientId', 'recipientSeat', 'team', 'issued', 'expires', 'vocabulary', 'issuedBy'];
  for (const field of fields) {
    if (canonical.grant[field] !== presented.grant[field]) {
      return refusal(`the presented grant is not the canonical record for ${presented.grant.grantId} (${field} differs)`);
    }
  }
  // The op list and the role list are signed fields too: a presented copy that adds or drops an
  // op, or names another role, is not the canonical record even when every scalar matches.
  for (const field of ['allowedOps', 'allowedRoles'] as const) {
    if (canonical.grant[field].join(',') !== presented.grant[field].join(',')) {
      return refusal(`the presented grant is not the canonical record for ${presented.grant.grantId} (${field} differs)`);
    }
  }
  if (JSON.stringify(canonical.grant.grantScope ?? null) !== JSON.stringify(presented.grant.grantScope ?? null)) {
    return refusal(`the presented grant is not the canonical record for ${presented.grant.grantId} (grantScope differs)`);
  }
  if (canonical.signature !== presented.signature) {
    return refusal(`the presented grant is not the canonical record for ${presented.grant.grantId} (signature differs)`);
  }
  return canonical;
}

/**
 * The grant in force at `now`: canonical, unexpired, and with no appended revocation. Read fresh
 * by every use; call inside {@link withClientGrantLock} when it guards a side effect.
 */
export function activeClientGrant(
  home: string,
  presented: { grant: ClientGrantRecord; signature: string },
  now: Date = new Date(),
): { ok: true; grant: ClientGrantRecord } | { ok: false; why: string } {
  const canonical = canonicalClientGrant(home, presented);
  if (!canonical.ok) return canonical;
  const grant = canonical.grant;
  // A record with no end date (`expires: null`) is not expired, ever; `team revoke` still ends it.
  if (grant.expires !== null) {
    if (!Number.isFinite(Date.parse(grant.expires))) return refusal(`the grant ${grant.grantId} has no readable expiry`);
    if (clientGrantExpired(grant.expires, now)) return refusal(`the grant ${grant.grantId} expired at ${grant.expires}`);
  }
  const revocation = clientRevocations(home, grant.grantId);
  if (!revocation.ok) return revocation;
  if (revocation.records[0] !== undefined) {
    return refusal(`the grant ${grant.grantId} was revoked at ${revocation.records[0].at}`);
  }
  const master = clientMasterRevocation(home, grant);
  if (master !== null) return refusal(master);
  return { ok: true, grant };
}

/** For a sub-grant, the reason its master no longer stands behind it (revoked, or its revocations
 *  unreadable), or null. A grant with no `issued_by` always answers null. */
export function clientMasterRevocation(home: string, grant: ClientGrantRecord): string | null {
  if (grant.issuedBy === undefined) return null;
  const revocation = clientRevocations(home, grant.issuedBy);
  if (!revocation.ok) return revocation.why;
  if (revocation.records[0] !== undefined) {
    return `the master grant ${grant.issuedBy} that issued ${grant.grantId} was revoked at ${revocation.records[0].at}`;
  }
  return null;
}

/** The audit folder for sub-grants issued under a master grant: kept apart from the grants folder,
 *  whose standing-grant reader owns every file name there. */
export function clientGrantAuditFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'client-grant-audit');
}

/**
 * Appends one owner-signed audit record for a sub-grant: which master issued it, under which signed
 * client request. Created with O_EXCL under the sub-grant's own fresh id, never overwritten.
 */
export function writeClientGrantAudit(
  home: string,
  record: { subGrantId: string; masterGrantId: string; clientId: string; requestId: string; requestSignature: string; at: string },
  key: KeyObject = keyOf(home),
): { ok: true; path: string } | { ok: false; why: string } {
  const folder = clientGrantAuditFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return refusal(`the audit folder "${folder}" cannot be created`);
  }
  const body: Json = {
    sub_grant_id: record.subGrantId,
    master_grant_id: record.masterGrantId,
    client_id: record.clientId,
    request_id: record.requestId,
    request_signature: record.requestSignature,
    at: record.at,
  };
  const signature = signDomain(CLIENT_GRANT_DOMAIN, { name: record.subGrantId, client_grant_audit: body }, key);
  const name = `${record.subGrantId}.json`;
  const published = publishExclusive(folder, name, `${JSON.stringify({ client_grant_audit: body, signature }, null, 2)}\n`);
  if (published !== 'written') return refusal(`the audit record for ${record.subGrantId} could not be published in "${folder}"`);
  return { ok: true, path: join(folder, name) };
}

// ---- appended revocations ------------------------------------------------------------------

function revocationPayload(name: string, record: Json): Json {
  return { name, client_revocation: record };
}

export type ClientRevocationRead = { ok: true; records: ClientRevocationRecord[] } | { ok: false; why: string };

/** The reserved namespace: a revocation of a client grant, and nothing else, by file name. */
function reservedRevocation(name: string): boolean {
  return name.startsWith('revoke-cg_');
}

/**
 * Every verified appended revocation naming this grant, oldest file first. Damage anywhere in the
 * reserved namespace is a fail-closed read, never an empty list: a linked, unreadable, malformed
 * or wrongly signed `revoke-cg_…` file refuses the send rather than reading as "not revoked".
 * Standing grants' own revocation files are a different namespace and are not read here.
 */
export function clientRevocations(home: string, grantId: string): ClientRevocationRead {
  const folder = clientGrantsFolder(home);
  let names: string[];
  try {
    const stat = lstatSync(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return refusal(`the grants folder "${folder}" is not a plain folder`);
    names = readdirSync(folder).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, records: [] };
    return refusal(`the grants folder "${folder}" cannot be read`);
  }
  const reserved = names.filter(reservedRevocation);
  if (reserved.length === 0) return { ok: true, records: [] };
  const state = keyState(home);
  if (state.kind !== 'key') return refusal('a client revocation record exists and the owner signing key cannot verify it');
  const records: ClientRevocationRecord[] = [];
  for (const name of reserved) {
    const path = join(folder, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return refusal(`the client revocation record "${path}" cannot be read`);
    }
    if (stat.isSymbolicLink()) return refusal(`the client revocation record "${path}" is a symbolic link`);
    if (!stat.isFile()) return refusal(`the client revocation record "${path}" is not a regular file`);
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      return refusal(`the client revocation record "${path}" belongs to another user`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return refusal(`the client revocation record "${path}" is not whole JSON`);
    }
    const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
    const found = revocationFrom(stem, parsed, state.key);
    if (found === null) return refusal(`the client revocation record "${path}" is not a verified owner-signed revocation`);
    if (found.grantId === grantId) records.push(found);
  }
  return { ok: true, records };
}

/**
 * Appends one owner-signed revocation of `grantId`. The file's name carries a random event id and
 * is created with O_EXCL: an earlier revocation is never overwritten and a later one never erases
 * it. Held under the same lock as a send's check, so one of the two is always first.
 */
export function appendClientRevocation(
  home: string,
  grantId: string,
  options: ClientGrantOptions = {},
): { ok: true; record: ClientRevocationRecord; path: string } | { ok: false; why: string } {
  const now = options.now ?? new Date();
  if (!CLIENT_GRANT_ID_PATTERN.test(grantId)) return refusal(`"${grantId}" is not a client grant id`);
  const canonical = readClientGrant(home, grantId);
  if (!canonical.ok && !readClientUpGrant(home, grantId).ok) return refusal(`there is no canonical client grant ${grantId}: ${canonical.why}`);
  return withClientGrantLock(home, () => {
    const key = options.key ?? keyOf(home);
    const folder = clientGrantsFolder(home);
    for (let attempt = 0; attempt < 3; attempt++) {
      const revocationId = `revoke-${grantId}-${randomBytes(8).toString('hex')}`;
      const disk: Record<string, Json> = { grant_id: grantId, by: 'owner', at: now.toISOString() };
      const signature = signDomain(CLIENT_GRANT_DOMAIN, revocationPayload(revocationId, disk), key);
      const path = join(folder, `${revocationId}.json`);
      const published = publishExclusive(folder, `${revocationId}.json`, `${JSON.stringify({ client_revocation: disk, signature }, null, 2)}\n`);
      if (published === 'written') {
        return { ok: true, record: { revocationId, grantId, by: 'owner', at: now.toISOString() }, path };
      }
      if (published === 'exists') continue;
      return refusal(`the revocation could not be published in "${folder}"`);
    }
    return refusal('a fresh revocation id could not be found; nothing was written');
  });
}

function revocationFrom(stem: string, record: unknown, key: KeyObject): ClientRevocationRecord | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const envelope = record as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'client_revocation' || keys[1] !== 'signature') return null;
  const stemMatch = /^revoke-(cg_[0-9a-f]{24})-[0-9a-f]{16}$/.exec(stem);
  if (stemMatch === null) return null;
  const raw = envelope.client_revocation;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const known = ['grant_id', 'by', 'at'];
  if (Object.keys(fields).some((key) => !known.includes(key))) return null;
  if (typeof fields.grant_id !== 'string' || !CLIENT_GRANT_ID_PATTERN.test(fields.grant_id)) return null;
  if (fields.grant_id !== stemMatch[1]) return null;
  if (fields.by !== 'owner') return null;
  if (typeof fields.at !== 'string' || !Number.isFinite(Date.parse(fields.at))) return null;
  if (typeof envelope.signature !== 'string') return null;
  if (!verifyDomain(CLIENT_GRANT_DOMAIN, revocationPayload(stem, raw as Json), envelope.signature, key)) return null;
  return { revocationId: stem, grantId: fields.grant_id, by: 'owner', at: fields.at };
}

// ---- the shared lock -----------------------------------------------------------------------

const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` holding the grants-folder client lock. A send's re-read-claim-write and a revocation's
 * append never interleave: whichever takes the lock first completes before the other reads.
 *
 * There is no automatic reclaim. A lock file is never stolen by age, an empty or malformed body,
 * or a pid guess: the holder may be alive between create and write, and an unreadable holder is
 * not a dead one. A waiter polls to its deadline and then refuses busy, naming the file and the
 * one repair — the owner removes it after checking nothing is running. Release removes the file
 * only when it still carries this run's token and the inode this run created.
 */
export function withClientGrantLock<T>(home: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): T {
  const folder = clientGrantsFolder(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, '.client.lock');
  const token = randomBytes(8).toString('hex');
  const content = `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`;
  const deadline = Date.now() + waitMs;
  let fd = -1;
  for (;;) {
    try {
      fd = openSync(path, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`the client grant lock "${path}" cannot be taken`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `another command holds the client grant lock "${path}"; nothing was sent. If no command is running, the owner must remove that file`,
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  const created = fstatSync(fd);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    return fn();
  } finally {
    try {
      const now = lstatSync(path);
      if (now.dev === created.dev && now.ino === created.ino && readFileSync(path, 'utf8').includes(`"token":"${token}"`)) {
        unlinkSync(path);
      }
    } catch {}
  }
}

/**
 * Publishes one record whole: a temporary file in the same folder, written and flushed, then
 * linked onto the final name, which fails rather than replacing. Success means the whole signed
 * bytes are at the final name; a crash before the link leaves only a dot-named temporary that
 * every reader skips.
 */
function publishExclusive(folder: string, name: string, content: string): 'written' | 'exists' | 'failed' {
  const final = join(folder, name);
  const temporary = join(folder, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(temporary, 'wx', 0o600);
  } catch {
    return 'failed';
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(temporary);
    } catch {}
    return 'failed';
  }
  closeSync(fd);
  try {
    linkSync(temporary, final);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
  try {
    const dir = openSync(folder, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {}
  return 'written';
}

/**
 * The seats one client may address on the team at `root`, from its file's `clients:` section.
 * A file with no section for the client yields the default (the orchestrator), so a team that
 * writes nothing behaves as before. A section that names the client is honoured only while the
 * owner's approval of it is in force: an unapproved or changed `clients:` is refused, never read
 * as the default. `refused` names the operator and human seats, which no list admits.
 */
export function clientSeatsAt(
  root: string,
  home: string,
  clientId: string,
  base: readonly string[] = CLIENT_DEFAULT_SEATS,
): { ok: true; seats: readonly string[]; refused: string[] } | { ok: false; why: string } {
  const declared = readDeclarations(root, home);
  if (declared.kind !== 'read') return { ok: true, seats: base, refused: [] };
  const team = declared.team;
  // The operator is refused unless it is the lead itself (a file whose operator is its
  // orchestrator keeps the default reach it always had); a `human: true` seat always is.
  const operator = team.operator === team.orchestrator ? [] : [team.operator];
  const refused = [...operator, ...team.seats.filter((seat) => seat.human === true).map((seat) => seat.name)];
  if (team.clients === null || team.clients === undefined) return { ok: true, seats: base.filter((seat) => !refused.includes(seat)), refused };
  let differences: string[] | null;
  try {
    differences = approvalDifferences(team, root, home);
  } catch {
    differences = null;
  }
  if (differences === null || differences.includes('`clients` changed')) {
    return { ok: false, why: 'the team file\'s `clients:` section is not the one the owner approved' };
  }
  const listed = team.clients[clientId];
  if (listed === undefined) return { ok: true, seats: base.filter((seat) => !refused.includes(seat)), refused };
  return { ok: true, seats: listed.seats.filter((seat) => !refused.includes(seat)), refused };
}

// ---- up and down grants --------------------------------------------------------------------
//
// A client team grant admits one client's `team up --client <grant> --key <key>` and/or
// `team down --client <grant> --key <key>` for ONE team at ONE folder, and nothing else: its op
// list is `up`, `down`, or both, so it is never read as a send, messages or grant record (the
// send-side decoder refuses vocabulary 4 whole, and an older build refuses it as an unknown
// vocabulary). The `up` form is byte-for-byte the record the first build wrote (binding under the
// key `up`); a record that carries `down` keeps the same binding under the key `team`, so a build
// that knows only `up` refuses it whole instead of reading half of it. The team is bound by what the registry and the file say, signed:
// its project name, its registry id (twelve hex, derived from the real root), its absolute root,
// and the fingerprints of the team file as the owner approved it (owner sections and every seat,
// the same digests `team approve` records). A later edit of one of those needs a new signature.
// The entity names whose policies and owner signers govern the grant; it is not a requirement
// that the team's own file names it (a team with no entity is bound by project, id and root).

/** The vocabulary of an up grant: `up` alone. */
export const CLIENT_UP_VOCABULARY_VERSION = 4;

/** The one op an up-only grant carries. */
export const CLIENT_UP_ALLOWED_OPS = ['up'] as const;

/** Every op a team grant can carry, in the one canonical order a record lists them. */
export const CLIENT_TEAM_OPS = ['up', 'down'] as const;
export type ClientTeamOp = (typeof CLIENT_TEAM_OPS)[number];

/** The ops as a record writes them: known, each once, in canonical order; an empty request is `up`
 *  (what `--up` alone has always meant). */
export function canonicalTeamOps(ops: readonly string[] | undefined): ClientTeamOp[] | null {
  const asked = ops === undefined || ops.length === 0 ? ['up'] : ops;
  if (asked.some((op) => !(CLIENT_TEAM_OPS as readonly string[]).includes(op))) return null;
  return CLIENT_TEAM_OPS.filter((op) => asked.includes(op));
}

/** What a grant is called in a sentence: `up grant`, `down grant`, or `up and down grant`. */
export function teamGrantLabel(ops: readonly string[]): string {
  return `${ops.join(' and ')} grant`;
}

/** What one verified team grant is called in a sentence: `up grant`, `down grant`, `up and down
 *  grant` for the one-op forms, `operator bundle grant` for a bundle. */
export function grantLabelOf(grant: { ops: readonly string[]; bundle?: string }): string {
  return grant.bundle !== undefined ? `${grant.bundle} bundle grant` : teamGrantLabel(grant.ops);
}

/** The label with its article: `an up grant`, `a down grant`, `an up and down grant`. */
export function teamGrantLabelWithArticle(ops: readonly string[]): string {
  return `${ops[0] === 'up' ? 'an' : 'a'} ${teamGrantLabel(ops)}`;
}

/** The flags that ask for those ops: `--up`, `--down`, or `--up --down`. */
export function teamOpFlags(ops: readonly string[]): string {
  return ops.map((op) => `--${op}`).join(' ');
}

/** A team grant (up, down or both) is durable: ninety days is the release default, both its length
 *  when `--expires` is absent and its cap when no `client-grant-max-duration` policy says otherwise.
 *  `--expires` shortens it; the owner revokes it at any time with `team revoke`. It is a default,
 *  not a ceiling: the policy raises or lowers the cap, and `none` allows no end date. */
export const CLIENT_UP_EXPIRY_MAX_MS = GRANT_DURATION_DEFAULT_DAYS.up * DAY_MS;

/** Where one up grant binds: one team by name and registry id, its real root, and its file. */
export type ClientUpBinding = {
  project: string;
  teamId: string;
  root: string;
  fingerprints: Fingerprints;
};

/** One verified up grant, exactly as written and signed. */
export type ClientUpGrantRecord = {
  grantId: string;
  clientId: string;
  entity: string;
  publicKey: string;
  keyId: string;
  keyDir: string;
  issued: string;
  /** The end as signed, or `null`: no end date (the policy said `none`); see {@link ClientGrantRecord.expires}. */
  expires: string | null;
  /** 4: the one-op grants (`up`, `down`, both). 5: an `observer` or `operator` bundle grant (see
   *  `CLIENT_BUNDLE_VOCABULARY_VERSION`). 6: a `manager` bundle grant (`CLIENT_MANAGER_VOCABULARY_VERSION`).
   *  7: a `developer` bundle grant (`CLIENT_DEVELOPER_VOCABULARY_VERSION`). */
  vocabulary: 4 | 5 | 6 | 7;
  /** What the grant admits, explicitly: `up`, `down`, or both on vocabulary 4; on vocabularies 5 and 6
   *  the bundle's expansion as the owner signed it. These decide; `bundle` never does. */
  ops: BundleOp[];
  /** Vocabularies 5 and 6 only: the bundle's name, for display. Never read as authority. */
  bundle?: BundleName;
  /** Vocabularies 5 and 6 only: the seats `send` may reach, as signed (empty when `send` is not an op). */
  seats?: string[];
  /** The one team and folder every op binds. The name is the first build's: it binds `down` too. */
  up: ClientUpBinding;
};

export type ClientUpGrantRequest = {
  clientId: string;
  entity: string;
  publicKey: string;
  keyId: string;
  keyDir: string;
  /** Absent means the default length (90 days, or the cap when shorter); anything past the
   *  `client-grant-max-duration` cap in force is refused. */
  expires?: string;
  /** No end date (`--expires never`): only when the policy in force says `none` for up/down grants. */
  neverExpires?: boolean;
  /** Absent means `up`, as before; `['down']` and `['up', 'down']` add the stop. */
  ops?: readonly string[];
  up: ClientUpBinding;
};

export type ClientUpGrantRead =
  | { ok: true; grant: ClientUpGrantRecord; signature: string }
  | { ok: false; why: string };

/** The command that asks for an up grant, spelled for one client key and team: what every
 *  refusal of an up grant ends with, so the owner's next step is always one line. */
export function upRequestCommand(input: { clientId: string; entity: string; keyDir: string; project: string; ops?: readonly string[]; bundle?: string } | null): string {
  if (input === null) return 'team grant --client <client-id> --entity <entity> --public-key <client.pub> --team <team> --up --request';
  if (input.bundle !== undefined) return `team grant --client ${input.clientId} --entity ${input.entity} --public-key ${join(input.keyDir, CLIENT_PUB_FILE)} --team ${input.project} --bundle ${input.bundle} --request`;
  return `team grant --client ${input.clientId} --entity ${input.entity} --public-key ${join(input.keyDir, CLIENT_PUB_FILE)} --team ${input.project} ${teamOpFlags(input.ops ?? ['up'])} --request`;
}

/** Where a record keeps its binding: `up` for the up-only form the first build wrote, `team` for any
 *  record that carries `down`. */
function bindingKeyOf(ops: readonly string[]): 'up' | 'team' {
  return ops.length === 1 && ops[0] === 'up' ? 'up' : 'team';
}

function onDiskUpGrant(grant: ClientUpGrantRecord): Record<string, Json> {
  if (isBundleVocabulary(grant.vocabulary)) return onDiskBundleGrant(grant);
  return {
    grant_id: grant.grantId,
    client_id: grant.clientId,
    entity: grant.entity,
    public_key: grant.publicKey,
    key_id: grant.keyId,
    key_dir: grant.keyDir,
    allowed_ops: [...grant.ops],
    issued: grant.issued,
    expires: grant.expires,
    vocabulary: CLIENT_UP_VOCABULARY_VERSION,
    [bindingKeyOf(grant.ops)]: {
      project: grant.up.project,
      team_id: grant.up.teamId,
      root: grant.up.root,
      fingerprints: { sections: { ...grant.up.fingerprints.sections }, seats: { ...grant.up.fingerprints.seats } },
    },
  };
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** The problem with a binding's shape, or null. Shape only: whether it still names a live team is
 *  the up-grant module's check, at the request and at every use. */
export function clientUpBindingProblem(binding: ClientUpBinding): string | null {
  if (typeof binding.project !== 'string' || !CLIENT_WORD_PATTERN.test(binding.project)) return `"${String(binding.project)}" is not a team name: one lowercase word, digits and hyphens`;
  if (typeof binding.teamId !== 'string' || !CLIENT_TEAM_ID_PATTERN.test(binding.teamId)) return `"${String(binding.teamId)}" is not a team registry id`;
  if (typeof binding.root !== 'string' || !isAbsolute(binding.root) || hasDotTraversal(binding.root)) return `the team root "${String(binding.root)}" is not a plain absolute path`;
  const prints = binding.fingerprints as unknown;
  if (prints === null || typeof prints !== 'object' || Array.isArray(prints)) return 'the team file fingerprints are not a record';
  const { sections, seats } = prints as { sections?: unknown; seats?: unknown };
  for (const [name, map] of [['sections', sections], ['seats', seats]] as const) {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return `the team file fingerprints carry no ${name}`;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (key === '' || typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) return `the ${name} fingerprint of "${key}" is not a SHA-256`;
    }
  }
  if (Object.keys(seats as Record<string, unknown>).length === 0) return 'the team file declares no seat to launch';
  return null;
}

/** Validates one up grant request and builds the record a write signs — the id is minted by the write. */
export function planClientUpGrant(home: string, request: ClientUpGrantRequest, options: ClientGrantOptions = {}): { ok: true; grant: ClientUpGrantRecord } | { ok: false; why: string } {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return refusal('the issued time is not a readable timestamp');
  const admitted = clientAdmission(home, request.clientId, request.entity);
  if (!admitted.ok) return refusal(admitted.why);
  if (!CLIENT_PUBLIC_KEY_PATTERN.test(request.publicKey)) return refusal(`"${request.publicKey}" is not an Ed25519 public key: 64 lowercase hex`);
  if (request.keyId !== keyIdOf(request.publicKey)) return refusal(`the key id "${request.keyId}" is not the public key's own (${keyIdOf(request.publicKey)})`);
  const placement = clientKeyPlacementProblem(home, request.keyDir);
  if (placement !== null) return refusal(placement);
  const bound = clientUpBindingProblem(request.up);
  if (bound !== null) return refusal(bound);
  const ops = canonicalTeamOps(request.ops);
  if (ops === null) return refusal(`a team grant carries up, down or both, not "${(request.ops ?? []).join(', ')}"`);
  const chosen = chooseGrantExpiry({
    home,
    kind: 'up',
    entity: request.entity,
    projectId: projectIdOfTeamId(home, request.up.teamId),
    now,
    expires: request.expires,
    never: request.neverExpires,
    noun: teamGrantLabel(ops),
  });
  if (!chosen.ok) return refusal(chosen.why);
  const expires = chosen.expires;
  return {
    ok: true,
    grant: {
      grantId: '',
      clientId: request.clientId,
      entity: request.entity,
      publicKey: request.publicKey,
      keyId: request.keyId,
      keyDir: canonical(request.keyDir),
      issued: now.toISOString(),
      expires,
      vocabulary: CLIENT_UP_VOCABULARY_VERSION,
      ops,
      up: {
        project: request.up.project,
        teamId: request.up.teamId,
        root: request.up.root,
        fingerprints: { sections: { ...request.up.fingerprints.sections }, seats: { ...request.up.fingerprints.seats } },
      },
    },
  };
}

/** Writes one owner-signed up grant under a fresh random id, created with O_EXCL. */
export function writeClientUpGrant(
  home: string,
  request: ClientUpGrantRequest,
  options: ClientGrantOptions = {},
): { ok: true; grant: ClientUpGrantRecord; path: string } | { ok: false; why: string } {
  const plan = planClientUpGrant(home, request, options);
  if (!plan.ok) return plan;
  return publishTeamGrant(home, plan.grant, options);
}

/** Signs and publishes one planned team grant (vocabulary 4, 5 or 6) under a fresh random id. */
function publishTeamGrant(home: string, plan: ClientUpGrantRecord, options: ClientGrantOptions): { ok: true; grant: ClientUpGrantRecord; path: string } | { ok: false; why: string } {
  const folder = clientGrantsFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return refusal(`the grants folder "${folder}" cannot be created`);
  }
  const key = options.key ?? keyOf(home);
  for (let attempt = 0; attempt < 3; attempt++) {
    const grant: ClientUpGrantRecord = { ...plan, grantId: clientGrantId() };
    const disk = onDiskUpGrant(grant);
    const signature = signDomain(CLIENT_GRANT_DOMAIN, grantPayload(grant.grantId, disk), key);
    const path = clientGrantPath(home, grant.grantId);
    const published = publishExclusive(folder, `${grant.grantId}.json`, `${JSON.stringify({ client_grant: disk, signature }, null, 2)}\n`);
    if (published === 'written') return { ok: true, grant, path };
    if (published === 'exists') continue;
    return refusal(`the ${plan.vocabulary === 4 ? 'up' : 'bundle'} grant could not be published in "${folder}"`);
  }
  return refusal('a fresh grant id could not be found; nothing was written');
}

function clientUpGrantFrom(record: unknown, key: KeyObject): { grant: ClientUpGrantRecord; signature: string } | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const envelope = record as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'client_grant' || keys[1] !== 'signature') return null;
  const raw = envelope.client_grant;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  if (isBundleVocabulary(fields.vocabulary)) return bundleGrantFrom(envelope, fields, key);
  if (fields.vocabulary !== CLIENT_UP_VOCABULARY_VERSION) return null;
  // The ops are exactly what a request writes: known, once each, in canonical order. Anything else
  // is not a record this build wrote, and the binding's key follows from them.
  if (!Array.isArray(fields.allowed_ops) || fields.allowed_ops.some((op) => typeof op !== 'string')) return null;
  const listed = fields.allowed_ops as string[];
  const ops = canonicalTeamOps(listed);
  if (ops === null || listed.length === 0 || ops.join(',') !== listed.join(',')) return null;
  const bindingKey = bindingKeyOf(ops);
  const known = ['grant_id', 'client_id', 'entity', 'public_key', 'key_id', 'key_dir', 'allowed_ops', 'issued', 'expires', 'vocabulary', bindingKey];
  if (Object.keys(fields).length !== known.length || Object.keys(fields).some((name) => !known.includes(name))) return null;
  if (typeof fields.grant_id !== 'string' || !CLIENT_GRANT_ID_PATTERN.test(fields.grant_id)) return null;
  if (typeof fields.client_id !== 'string' || !CLIENT_WORD_PATTERN.test(fields.client_id)) return null;
  if (typeof fields.entity !== 'string' || !CLIENT_WORD_PATTERN.test(fields.entity)) return null;
  if (typeof fields.public_key !== 'string' || !CLIENT_PUBLIC_KEY_PATTERN.test(fields.public_key)) return null;
  if (typeof fields.key_id !== 'string' || fields.key_id !== keyIdOf(fields.public_key)) return null;
  if (typeof fields.key_dir !== 'string' || !isAbsolute(fields.key_dir)) return null;
  if (typeof fields.issued !== 'string' || !Number.isFinite(Date.parse(fields.issued))) return null;
  const expiry = decodedExpiry(fields);
  if (expiry === null) return null;
  const up = fields[bindingKey];
  if (up === null || typeof up !== 'object' || Array.isArray(up)) return null;
  const upFields = up as Record<string, unknown>;
  if (Object.keys(upFields).sort().join(',') !== 'fingerprints,project,root,team_id') return null;
  const prints = upFields.fingerprints;
  if (prints === null || typeof prints !== 'object' || Array.isArray(prints)) return null;
  if (Object.keys(prints).sort().join(',') !== 'seats,sections') return null;
  const binding: ClientUpBinding = {
    project: upFields.project as string,
    teamId: upFields.team_id as string,
    root: upFields.root as string,
    fingerprints: prints as Fingerprints,
  };
  if (clientUpBindingProblem(binding) !== null) return null;
  if (typeof envelope.signature !== 'string') return null;
  if (!verifyDomain(CLIENT_GRANT_DOMAIN, grantPayload(fields.grant_id, raw as Json), envelope.signature, key)) return null;
  return {
    grant: {
      grantId: fields.grant_id,
      clientId: fields.client_id,
      entity: fields.entity,
      publicKey: fields.public_key,
      keyId: fields.key_id,
      keyDir: fields.key_dir,
      issued: fields.issued,
      expires: expiry.expires,
      vocabulary: CLIENT_UP_VOCABULARY_VERSION,
      ops,
      up: {
        project: binding.project,
        teamId: binding.teamId,
        root: binding.root,
        fingerprints: { sections: { ...binding.fingerprints.sections }, seats: { ...binding.fingerprints.seats } },
      },
    },
    signature: envelope.signature,
  };
}

/** Whether a parsed record is of the up vocabulary, before its signature is judged (for the
 *  wording of a refusal only: nothing is admitted on this). */
function claimsUpVocabulary(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const grant = (parsed as { client_grant?: unknown }).client_grant;
  if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) return false;
  return (grant as { vocabulary?: unknown }).vocabulary === CLIENT_UP_VOCABULARY_VERSION;
}

/** Whether a parsed record is of the bundle vocabulary (for the wording of a refusal only). */
function claimsBundleVocabulary(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const grant = (parsed as { client_grant?: unknown }).client_grant;
  if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) return false;
  const vocabulary = (grant as { vocabulary?: unknown }).vocabulary;
  return isBundleVocabulary(vocabulary);
}

/** Whether the file at `path` claims to be a bundle grant. It judges nothing: the route it is sent
 *  down verifies the record whole, and says why when it does not. */
export function claimsBundleGrantFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1_000_000) return false;
    return claimsBundleVocabulary(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return false;
  }
}

/** The ops a vocabulary-5, -6 or -7 file names, for the wording of a refusal only. */
function claimedBundleOps(parsed: unknown): string[] {
  const grant = (parsed as { client_grant?: { allowed_ops?: unknown } }).client_grant;
  return Array.isArray(grant?.allowed_ops) ? (grant.allowed_ops as unknown[]).filter((op): op is string => typeof op === 'string') : [];
}

/** The ops a vocabulary-4 file names, for the wording of a refusal only. */
function claimedTeamOps(parsed: unknown): ClientTeamOp[] {
  const grant = (parsed as { client_grant?: { allowed_ops?: unknown } }).client_grant;
  const named = Array.isArray(grant?.allowed_ops) ? (grant.allowed_ops as unknown[]).filter((op): op is string => typeof op === 'string') : [];
  return canonicalTeamOps(named) ?? ['up'];
}

/** The bundle that would carry an op: `manager` for the ones only it carries, `operator` for the ones
 *  that act, `observer` for the ones that read. */
export function bundleForOp(op: string): BundleName {
  if ((DEVELOPER_ONLY_OPS as readonly string[]).includes(op)) return 'developer';
  if ((MANAGER_ONLY_OPS as readonly string[]).includes(op)) return 'manager';
  return op === 'send' || op === 'up' || op === 'down' ? 'operator' : 'observer';
}

function opGrantNoun(op: BundleOp, article: boolean): string {
  if (op === 'up' || op === 'down') return article ? teamGrantLabelWithArticle([op]) : teamGrantLabel([op]);
  return `${article ? 'a ' : ''}grant that carries ${op}`;
}

/** The request that asks for a grant carrying `op`: the one-op form for up and down, a bundle for the rest. */
function opRequestCommand(op: BundleOp, input: { clientId: string; entity: string; keyDir: string; project: string } | null): string {
  if (op === 'up' || op === 'down') return input === null ? upRequestCommand(null).replace('--up', teamOpFlags([op])) : upRequestCommand({ ...input, ops: [op] });
  const bundle = bundleForOp(op);
  return input === null ? `team grant --client <client-id> --entity <entity> --public-key <client.pub> --team <team> --bundle ${bundle} --request` : upRequestCommand({ ...input, bundle });
}

/** One verified owner-signed up grant from a file, or the reason it is not one. A send, messages
 *  or master grant is named for what it is, with the command that asks for an up grant. */
export function readClientUpGrantFile(home: string, path: string, op: BundleOp = 'up'): ClientUpGrantRead {
  const state = keyState(home);
  if (state.kind !== 'key') return refusal('the owner signing key is absent or unreadable: no client grant can verify');
  let text: string;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return refusal(`the grant file "${path}" is a symbolic link; a client grant is a plain file`);
    if (!stat.isFile()) return refusal(`the grant file "${path}" is not a regular file`);
    if (process.getuid !== undefined && stat.uid !== process.getuid()) return refusal(`the grant file "${path}" belongs to another user`);
    text = readFileSync(path, 'utf8');
  } catch {
    return refusal(`the grant file "${path}" cannot be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refusal(`the grant file "${path}" is not whole JSON`);
  }
  const up = clientUpGrantFrom(parsed, state.key);
  if (up === null) {
    const other = clientGrantFrom(parsed, state.key);
    if (other !== null) {
      return refusal(`the grant file "${path}" is not ${opGrantNoun(op, true)} (it admits ${other.grant.allowedOps.join(', ')}); the owner requests one with ${opRequestCommand(op, { clientId: other.grant.clientId, entity: other.grant.entity, keyDir: other.grant.keyDir, project: '<team>' })}`);
    }
    return refusal(`the grant file "${path}" is not a verified owner-signed ${opGrantNoun(op, false)}; the owner requests one with ${opRequestCommand(op, null)}`);
  }
  const admitted = clientAdmission(home, up.grant.clientId, up.grant.entity);
  if (!admitted.ok) return refusal(admitted.why);
  return { ok: true, grant: up.grant, signature: up.signature };
}

/** The verified up grant for `grantId` from the canonical store, or the reason it is not there. */
export function readClientUpGrant(home: string, grantId: string): ClientUpGrantRead {
  if (!CLIENT_GRANT_ID_PATTERN.test(grantId)) return refusal(`"${grantId}" is not a client grant id`);
  return readClientUpGrantFile(home, clientGrantPath(home, grantId));
}

/** The up grant in force at `now`: the canonical store's own record for the presented id (a
 *  detached copy is never a bearer token), unexpired and with no appended revocation. Read fresh
 *  by every use; call inside {@link withClientGrantLock} when it guards a side effect. */
export function activeClientUpGrant(
  home: string,
  presented: { grant: ClientUpGrantRecord; signature: string },
  now: Date = new Date(),
): { ok: true; grant: ClientUpGrantRecord } | { ok: false; why: string; kind: 'expired' | 'revoked' | 'other' } {
  const other = (why: string) => ({ ok: false as const, why, kind: 'other' as const });
  const canonicalRead = readClientUpGrant(home, presented.grant.grantId);
  if (!canonicalRead.ok) return other(canonicalRead.why);
  if (canonicalRead.signature !== presented.signature || canonicalRead.grant.grantId !== presented.grant.grantId) {
    return other(`the presented grant is not the canonical record for ${presented.grant.grantId} (signature differs)`);
  }
  const grant = canonicalRead.grant;
  if (grant.expires !== null) {
    if (!Number.isFinite(Date.parse(grant.expires))) return other(`the grant ${grant.grantId} has no readable expiry`);
    if (clientGrantExpired(grant.expires, now)) return { ok: false, why: `the ${grantLabelOf(grant)} ${grant.grantId} expired at ${grant.expires}`, kind: 'expired' };
  }
  const revocation = clientRevocations(home, grant.grantId);
  if (!revocation.ok) return other(revocation.why);
  if (revocation.records[0] !== undefined) return { ok: false, why: `the ${grantLabelOf(grant)} ${grant.grantId} was revoked at ${revocation.records[0].at}`, kind: 'revoked' };
  return { ok: true, grant };
}

// ---- bundle grants -------------------------------------------------------------------------
//
// A bundle grant (vocabulary 5 or 6) is a named, fixed list of commands grouped in one owner-signed
// grant for ONE team at ONE folder: `observer` (read-only) or `operator` (observer, plus `send` to
// the granted seats, `up` and `down`) on vocabulary 5, and `manager` (the team's day-to-day
// management, seat lifecycle included) on vocabulary 6. One Touch ID covers the whole list. It complements the
// per-command grants above, which stay valid, readable and unchanged; a grant is never widened in
// place, and an older build refuses vocabulary 5 whole (it reads only 1 to 4).
//
// The record carries the EXPLICIT op list the owner signed (`allowed_ops`) and the bundle's name as
// a display label (`bundle`). Only the list decides, so a command added to a bundle in a later
// build never widens a grant signed before. The commands that change who may do what (grant,
// revoke, init, policy, add, remove, …) are structurally ineligible (`bundle-ops.ts`): the decoder
// refuses a record that lists one, even one carrying a valid owner signature.
//
// The binding is one team (name, registry id from its real root, the real root), the entity whose
// policy governs the grant, the client's key, and the expiry. The fingerprints of the team file
// are signed only when `up` is an op, and only `up` checks them: a file edit does not end a grant's
// status, send, down or any other op. A manager's own `add` is such an edit, and the one it ends is
// its `up`, until the owner re-signs: the roster change is the owner's to approve.

/** The vocabulary of an `observer` or `operator` bundle grant. */
export const CLIENT_BUNDLE_VOCABULARY_VERSION = 5;

/** The vocabulary of a `manager` bundle grant. Its ops include the seat lifecycle (`add`, `remove`)
 *  that vocabulary 5 can never carry, so a build that reads only 1 to 5 refuses the record whole as an
 *  unknown vocabulary rather than reading half of it, and this build holds each vocabulary to its own
 *  bundles and op lists: a vocabulary-5 record that lists `add` is nothing, signed or not. */
export const CLIENT_MANAGER_VOCABULARY_VERSION = 6;

/** The vocabulary of a `developer` bundle grant. Its ops include the pacing and work commands the manager
 *  can never carry, so a build that reads only 1 to 6 refuses the record whole as an unknown vocabulary,
 *  and this build holds the manager's vocabulary-6 record to the manager's list: a vocabulary-6 record that
 *  lists `pause` is nothing, signed or not. */
export const CLIENT_DEVELOPER_VOCABULARY_VERSION = 7;

/** The vocabulary a bundle's record is written in. */
export function bundleVocabularyOf(bundle: BundleName): 5 | 6 | 7 {
  return bundle === 'developer' ? CLIENT_DEVELOPER_VOCABULARY_VERSION : bundle === 'manager' ? CLIENT_MANAGER_VOCABULARY_VERSION : CLIENT_BUNDLE_VOCABULARY_VERSION;
}

/** Whether a vocabulary number is one a bundle record is written in. */
function isBundleVocabulary(vocabulary: unknown): boolean {
  return vocabulary === CLIENT_BUNDLE_VOCABULARY_VERSION || vocabulary === CLIENT_MANAGER_VOCABULARY_VERSION || vocabulary === CLIENT_DEVELOPER_VOCABULARY_VERSION;
}

export type ClientBundleGrantRequest = {
  clientId: string;
  entity: string;
  publicKey: string;
  keyId: string;
  keyDir: string;
  bundle: BundleName;
  /** The bundle as expanded at the request: the explicit ops the owner signs. */
  ops: readonly string[];
  /** The seats `send` may reach; required with `send`, refused without it. */
  seats?: readonly string[];
  /** Absent means the bundle's default days (or the cap when shorter); past its cap is refused. */
  expires?: string;
  /** No end date (`--expires never`): only when the policy in force says `none` for bundles and
   *  the `client-bundles` policy wrote no `@<days>d` for this bundle. */
  neverExpires?: boolean;
  /** The binding. `fingerprints` is read only when `up` is an op. */
  up: ClientUpBinding;
  /** The policy-resolved specs in force; the release defaults when absent. The ops must sit inside
   *  the bundle's, and the expiry inside its days. */
  specs?: BundleSpecs;
};

const EMPTY_FINGERPRINTS: Fingerprints = { sections: {}, seats: {} };

/** The problem with a bundle binding's shape, or null. The fingerprints are checked only for `up`. */
export function clientBundleBindingProblem(binding: ClientUpBinding, ops: readonly string[], bundle: BundleName = 'operator'): string | null {
  if (bundleSignsFile(bundle, ops)) return clientUpBindingProblem(binding);
  return clientUpBindingProblem({ ...binding, fingerprints: { sections: {}, seats: { '-': '0'.repeat(64) } } });
}

function onDiskBundleGrant(grant: ClientUpGrantRecord): Record<string, Json> {
  const team: Record<string, Json> = { project: grant.up.project, team_id: grant.up.teamId, root: grant.up.root };
  if (bundleSignsFile(grant.bundle ?? 'operator', grant.ops)) team.fingerprints = { sections: { ...grant.up.fingerprints.sections }, seats: { ...grant.up.fingerprints.seats } };
  return {
    grant_id: grant.grantId,
    client_id: grant.clientId,
    entity: grant.entity,
    public_key: grant.publicKey,
    key_id: grant.keyId,
    key_dir: grant.keyDir,
    bundle: grant.bundle ?? 'operator',
    allowed_ops: [...grant.ops],
    seats: [...(grant.seats ?? [])],
    issued: grant.issued,
    expires: grant.expires,
    vocabulary: bundleVocabularyOf(grant.bundle ?? 'operator'),
    team,
  };
}

/** The seats a bundle's `send` may be signed for: the seats the entity admits this client, the team
 *  file's own `clients:` list (when the owner approved it) and never the operator or a human seat. */
export function bundleSeatsAdmitted(home: string, root: string, clientId: string, entity: string): { ok: true; seats: readonly string[] } | { ok: false; why: string } {
  const admitted = clientAdmission(home, clientId, entity);
  if (!admitted.ok) return refusal(admitted.why);
  const allowed = clientSeatsAt(root, home, clientId, admitted.seats);
  if (!allowed.ok) return refusal(allowed.why);
  return { ok: true, seats: allowed.seats };
}

/** Validates one bundle request and builds the record a write signs: the id is minted by the write. */
export function planClientBundleGrant(home: string, request: ClientBundleGrantRequest, options: ClientGrantOptions = {}): { ok: true; grant: ClientUpGrantRecord } | { ok: false; why: string } {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return refusal('the issued time is not a readable timestamp');
  if (!isBundleName(request.bundle)) return refusal(`"${String(request.bundle)}" is not a bundle: observer, operator, manager or developer`);
  for (const op of request.ops) {
    if (isForbiddenBundleCommand(op, request.bundle)) return refusal(`"${op}" can never be in a bundle (the ${request.bundle} bundle among them): it changes who may do what, and only the owner does that`);
  }
  const ops = canonicalBundleOps(request.ops, request.bundle);
  if (ops === null) return refusal(`a ${request.bundle} bundle carries only ${bundleOpsOf(request.bundle).join(', ')}, not "${request.ops.join(', ')}"`);
  if (new Set(request.ops).size !== request.ops.length) return refusal('a bundle names an op twice');
  const spec = request.specs?.[request.bundle];
  if (spec !== undefined) {
    const outside = ops.filter((op) => !spec.ops.includes(op));
    if (outside.length > 0) return refusal(`the policy in force no longer lets the ${request.bundle} bundle carry ${outside.join(', ')}; ask again for the bundle as it is now`);
  }
  const admitted = clientAdmission(home, request.clientId, request.entity);
  if (!admitted.ok) return refusal(admitted.why);
  if (!CLIENT_PUBLIC_KEY_PATTERN.test(request.publicKey)) return refusal(`"${request.publicKey}" is not an Ed25519 public key: 64 lowercase hex`);
  if (request.keyId !== keyIdOf(request.publicKey)) return refusal(`the key id "${request.keyId}" is not the public key's own (${keyIdOf(request.publicKey)})`);
  const placement = clientKeyPlacementProblem(home, request.keyDir);
  if (placement !== null) return refusal(placement);
  // A manager or developer grant is always for one team: a binding that names none (no team id, no root) is no grant.
  if ((request.bundle === 'manager' || request.bundle === 'developer') && (request.up.teamId === '' || request.up.root === '' || request.up.project === '')) return refusal(`a ${request.bundle} bundle is for one team: it needs --team <team>`);
  const bound = clientBundleBindingProblem(request.up, ops, request.bundle);
  if (bound !== null) return refusal(bound);
  // The seats `send` reaches: signed explicitly, each one still admitted now.
  const seats = [...(request.seats ?? [])];
  if (ops.includes('send')) {
    if (seats.length === 0) return refusal('a bundle with send names the seats it may send to: --seat <seat>[,<seat>]');
    if (new Set(seats).size !== seats.length) return refusal('a bundle names a seat twice');
    const allowed = bundleSeatsAdmitted(home, request.up.root, request.clientId, request.entity);
    if (!allowed.ok) return refusal(allowed.why);
    let roster: string[];
    try {
      const record = readTeams(home)[request.up.teamId];
      if (record === undefined) return refusal(`team "${request.up.project}" is not in the registry: a bundle with send reaches seats the registry names`);
      roster = record.roster.map((entry) => entry.seat);
    } catch {
      return refusal('the team registry cannot be read');
    }
    for (const name of seats) {
      if (!SEAT_NAME.test(name)) return refusal(`"${name}" is not a seat name`);
      if (!allowed.seats.includes(name)) return refusal(`the team does not let client ${request.clientId} address "${name}" (it may address ${allowed.seats.join(', ') || 'none'})`);
      if (!roster.includes(name)) return refusal(`team "${request.up.project}" has no seat "${name}" on its roster`);
    }
  } else if (seats.length > 0) {
    return refusal(`seats name where send goes, and this ${request.bundle} bundle does not carry send`);
  }
  // The `client-bundles` days are the default length, and a bound too when the policy wrote them;
  // `client-grant-max-duration` (bundle kind) is the cap, 90 days by default.
  const chosen = chooseGrantExpiry({
    home,
    kind: 'bundle',
    entity: request.entity,
    projectId: projectIdOfTeamId(home, request.up.teamId),
    now,
    expires: request.expires,
    never: request.neverExpires,
    defaultDays: spec?.expiryDays ?? BUNDLE_DEFAULT_DAYS,
    narrowDays: spec?.expiryExplicit === true ? spec.expiryDays : null,
    noun: `${request.bundle} bundle`,
  });
  if (!chosen.ok) return refusal(chosen.why);
  const expires = chosen.expires;
  return {
    ok: true,
    grant: {
      grantId: '',
      clientId: request.clientId,
      entity: request.entity,
      publicKey: request.publicKey,
      keyId: request.keyId,
      keyDir: canonical(request.keyDir),
      issued: now.toISOString(),
      expires,
      vocabulary: bundleVocabularyOf(request.bundle),
      bundle: request.bundle,
      ops,
      seats,
      up: {
        project: request.up.project,
        teamId: request.up.teamId,
        root: request.up.root,
        fingerprints: bundleSignsFile(request.bundle, ops) ? { sections: { ...request.up.fingerprints.sections }, seats: { ...request.up.fingerprints.seats } } : { sections: {}, seats: {} },
      },
    },
  };
}

/** Writes one owner-signed bundle grant under a fresh random id, created with O_EXCL. */
export function writeClientBundleGrant(
  home: string,
  request: ClientBundleGrantRequest,
  options: ClientGrantOptions = {},
): { ok: true; grant: ClientUpGrantRecord; path: string } | { ok: false; why: string } {
  const plan = planClientBundleGrant(home, request, options);
  if (!plan.ok) return plan;
  return publishTeamGrant(home, plan.grant, options);
}

/**
 * The expiry of a decoded record: an ISO time after the issue time, or the JSON `null` that means
 * no end date. Anything else (a number, an absent field, a time not after the issue) is not a
 * record this build wrote. There is deliberately no ceiling here: how long a grant may last is the
 * policy's word at issuance, and a grant already signed keeps the end it was signed with. An older
 * build reads only a string here and refuses a record with `null` (or a longer date than its own
 * constant) whole.
 */
function decodedExpiry(fields: Record<string, unknown>): { expires: string | null } | null {
  const issued = typeof fields.issued === 'string' ? Date.parse(fields.issued) : Number.NaN;
  if (!Number.isFinite(issued)) return null;
  if (fields.expires === null) return { expires: null };
  if (typeof fields.expires !== 'string' || !Number.isFinite(Date.parse(fields.expires))) return null;
  if (Date.parse(fields.expires) <= issued) return null;
  return { expires: fields.expires };
}

/** Whether a record's end is at or before `now`; a record with no end date is never expired. */
export function clientGrantExpired(expires: string | null, now: Date): boolean {
  if (expires === null) return false;
  const ends = endsAtMs(expires);
  return !Number.isFinite(ends) || ends <= now.getTime();
}

/** Decodes a vocabulary-5 record. A record that is not exactly what a build writes is not a grant,
 *  and an op that can never be in a bundle makes the whole record nothing, signed or not. */
function bundleGrantFrom(envelope: Record<string, unknown>, fields: Record<string, unknown>, key: KeyObject): { grant: ClientUpGrantRecord; signature: string } | null {
  const raw = envelope.client_grant as Json;
  const known = ['grant_id', 'client_id', 'entity', 'public_key', 'key_id', 'key_dir', 'bundle', 'allowed_ops', 'seats', 'issued', 'expires', 'vocabulary', 'team'];
  if (Object.keys(fields).length !== known.length || Object.keys(fields).some((name) => !known.includes(name))) return null;
  if (typeof fields.grant_id !== 'string' || !CLIENT_GRANT_ID_PATTERN.test(fields.grant_id)) return null;
  if (typeof fields.client_id !== 'string' || !CLIENT_WORD_PATTERN.test(fields.client_id)) return null;
  if (typeof fields.entity !== 'string' || !CLIENT_WORD_PATTERN.test(fields.entity)) return null;
  if (typeof fields.public_key !== 'string' || !CLIENT_PUBLIC_KEY_PATTERN.test(fields.public_key)) return null;
  if (typeof fields.key_id !== 'string' || fields.key_id !== keyIdOf(fields.public_key)) return null;
  if (typeof fields.key_dir !== 'string' || !isAbsolute(fields.key_dir)) return null;
  if (!isBundleName(fields.bundle)) return null;
  // Each vocabulary holds only its own bundles: 5 the observer and operator (no seat lifecycle), 6 the manager, 7 the developer.
  if (fields.vocabulary !== bundleVocabularyOf(fields.bundle)) return null;
  // The explicit ops decide: known for this bundle, none forbidden for it, each once, in canonical order.
  if (!Array.isArray(fields.allowed_ops) || fields.allowed_ops.some((op) => typeof op !== 'string')) return null;
  const listed = fields.allowed_ops as string[];
  if (listed.some((op) => isForbiddenBundleCommand(op, fields.bundle as BundleName))) return null;
  const ops = canonicalBundleOps(listed, fields.bundle);
  if (ops === null || ops.join(',') !== listed.join(',')) return null;
  if (!Array.isArray(fields.seats) || fields.seats.some((name) => typeof name !== 'string' || !SEAT_NAME.test(name))) return null;
  const seats = fields.seats as string[];
  if (new Set(seats).size !== seats.length) return null;
  if (ops.includes('send') ? seats.length === 0 : seats.length > 0) return null;
  if (typeof fields.issued !== 'string' || !Number.isFinite(Date.parse(fields.issued))) return null;
  const expiry = decodedExpiry(fields);
  if (expiry === null) return null;
  const team = fields.team;
  if (team === null || typeof team !== 'object' || Array.isArray(team)) return null;
  const teamFields = team as Record<string, unknown>;
  const withPrints = bundleSignsFile(fields.bundle, ops);
  if (Object.keys(teamFields).sort().join(',') !== (withPrints ? 'fingerprints,project,root,team_id' : 'project,root,team_id')) return null;
  let fingerprints: Fingerprints = { sections: {}, seats: {} };
  if (withPrints) {
    const prints = teamFields.fingerprints;
    if (prints === null || typeof prints !== 'object' || Array.isArray(prints)) return null;
    if (Object.keys(prints).sort().join(',') !== 'seats,sections') return null;
    fingerprints = prints as Fingerprints;
  }
  const binding: ClientUpBinding = { project: teamFields.project as string, teamId: teamFields.team_id as string, root: teamFields.root as string, fingerprints };
  if (clientBundleBindingProblem(binding, ops, fields.bundle) !== null) return null;
  if (typeof envelope.signature !== 'string') return null;
  if (!verifyDomain(CLIENT_GRANT_DOMAIN, grantPayload(fields.grant_id, raw), envelope.signature, key)) return null;
  return {
    grant: {
      grantId: fields.grant_id,
      clientId: fields.client_id,
      entity: fields.entity,
      publicKey: fields.public_key,
      keyId: fields.key_id,
      keyDir: fields.key_dir,
      issued: fields.issued,
      expires: expiry.expires,
      vocabulary: bundleVocabularyOf(fields.bundle),
      bundle: fields.bundle,
      ops,
      seats,
      up: {
        project: binding.project,
        teamId: binding.teamId,
        root: binding.root,
        fingerprints: withPrints ? { sections: { ...fingerprints.sections }, seats: { ...fingerprints.seats } } : { sections: {}, seats: {} },
      },
    },
    signature: envelope.signature,
  };
}

// ---- shared helpers ------------------------------------------------------------------------

function clientGrantFrom(record: unknown, key: KeyObject): { grant: ClientGrantRecord; signature: string } | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const envelope = record as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'client_grant' || keys[1] !== 'signature') return null;
  const raw = envelope.client_grant;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const known = ['grant_id', 'client_id', 'entity', 'public_key', 'key_id', 'key_dir', 'team_id', 'recipient_id', 'recipient_seat', 'team', 'allowed_ops', 'allowed_roles', 'issued', 'expires', 'vocabulary', 'grant_scope', 'issued_by'];
  if (Object.keys(fields).some((key) => !known.includes(key))) return null;
  if (typeof fields.grant_id !== 'string' || !CLIENT_GRANT_ID_PATTERN.test(fields.grant_id)) return null;
  // Which clients and entities are admitted is the entities file's word, checked by the reader
  // (`clientAdmission`) once the signature holds; here only the shape is held.
  if (typeof fields.client_id !== 'string' || !CLIENT_WORD_PATTERN.test(fields.client_id)) return null;
  if (typeof fields.entity !== 'string' || !CLIENT_WORD_PATTERN.test(fields.entity)) return null;
  if (typeof fields.public_key !== 'string' || !CLIENT_PUBLIC_KEY_PATTERN.test(fields.public_key)) return null;
  if (typeof fields.key_id !== 'string' || fields.key_id !== keyIdOf(fields.public_key)) return null;
  if (typeof fields.key_dir !== 'string' || !isAbsolute(fields.key_dir)) return null;
  if (typeof fields.team_id !== 'string' || !CLIENT_TEAM_ID_PATTERN.test(fields.team_id)) return null;
  if (typeof fields.recipient_id !== 'string' || !CLIENT_AGENT_ID_PATTERN.test(fields.recipient_id)) return null;
  // The seat is signed; which seats a client may address is the team file's `clients:` word,
  // checked again by the resolver at every use. Here only its shape is held.
  if (typeof fields.recipient_seat !== 'string' || !SEAT_NAME.test(fields.recipient_seat) || fields.recipient_seat.length > 64) return null;
  // `team` is optional and, when written, names another team of the entity; written equal to the
  // entity it would be a second spelling of the absent field, so it is refused.
  if (fields.team !== undefined && (typeof fields.team !== 'string' || !CLIENT_WORD_PATTERN.test(fields.team) || fields.team === fields.entity)) return null;
  if (!Array.isArray(fields.allowed_ops)) return null;
  const ops = fields.allowed_ops as unknown[];
  if (!Array.isArray(fields.allowed_roles) || fields.allowed_roles.length !== 1 || fields.allowed_roles[0] !== 'orchestrator') return null;
  if (typeof fields.issued !== 'string' || !Number.isFinite(Date.parse(fields.issued))) return null;
  const expiry = decodedExpiry(fields);
  if (expiry === null) return null;
  // The vocabulary is exact: 1 is send only, 2 is send and messages. Any other value, and any
  // op list that is not exactly its own shape, is not a grant this build honors — so a crafted
  // v2 record missing `messages` is refused, and an old build refuses a v2 record whole.
  let allowedOps: ClientOp[];
  if (fields.vocabulary === CLIENT_GRANT_VOCABULARY_VERSION) {
    if (ops.length !== 1 || ops[0] !== 'send') return null;
    allowedOps = ['send'];
  } else if (fields.vocabulary === CLIENT_INBOX_VOCABULARY_VERSION) {
    if (ops.length !== 2 || ops[0] !== 'send' || ops[1] !== 'messages') return null;
    allowedOps = ['send', 'messages'];
  } else if (fields.vocabulary === CLIENT_MASTER_VOCABULARY_VERSION) {
    // A master grant: exactly `send, grant` or `send, messages, grant`, with a whole scope.
    const two = ops.length === 2 && ops[0] === 'send' && ops[1] === 'grant';
    const three = ops.length === 3 && ops[0] === 'send' && ops[1] === 'messages' && ops[2] === 'grant';
    if (!two && !three) return null;
    allowedOps = two ? ['send', 'grant'] : ['send', 'messages', 'grant'];
  } else return null;
  // The scope is present on a master grant and nowhere else; `issued_by` never on a master, so a
  // sub-grant can never itself carry `grant`.
  let grantScope: ClientGrantScope | undefined;
  if (fields.vocabulary === CLIENT_MASTER_VOCABULARY_VERSION) {
    const scope = fields.grant_scope;
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null;
    const scopeKeys = Object.keys(scope).sort();
    if (scopeKeys.join(',') !== 'entities,projects,teams') return null;
    const candidate = scope as ClientGrantScope;
    if (clientGrantScopeProblem(candidate) !== null) return null;
    grantScope = { entities: [...candidate.entities], projects: [...candidate.projects], teams: [...candidate.teams] };
    if (fields.issued_by !== undefined) return null;
  } else if (fields.grant_scope !== undefined) return null;
  if (fields.issued_by !== undefined && (typeof fields.issued_by !== 'string' || !CLIENT_GRANT_ID_PATTERN.test(fields.issued_by) || fields.issued_by === fields.grant_id)) return null;
  // A master grant and a sub-grant always carry an end date: `null` is the plain send and inbox
  // grants' word alone.
  if (expiry.expires === null && (fields.vocabulary === CLIENT_MASTER_VOCABULARY_VERSION || fields.issued_by !== undefined)) return null;
  if (typeof envelope.signature !== 'string') return null;
  if (!verifyDomain(CLIENT_GRANT_DOMAIN, grantPayload(fields.grant_id, raw as Json), envelope.signature, key)) return null;
  return {
    grant: {
      grantId: fields.grant_id,
      clientId: fields.client_id,
      entity: fields.entity,
      publicKey: fields.public_key,
      keyId: fields.key_id,
      keyDir: fields.key_dir,
      teamId: fields.team_id,
      recipientId: fields.recipient_id,
      recipientSeat: fields.recipient_seat,
      ...(typeof fields.team === 'string' ? { team: fields.team } : {}),
      allowedOps,
      allowedRoles: ['orchestrator'],
      issued: fields.issued,
      expires: expiry.expires,
      vocabulary: fields.vocabulary as 1 | 2 | 3,
      ...(grantScope !== undefined ? { grantScope } : {}),
      ...(typeof fields.issued_by === 'string' ? { issuedBy: fields.issued_by } : {}),
    },
    signature: envelope.signature,
  };
}

function hasDotTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sameFolder(left: string, right: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(left) === real(right);
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function symlinkComponent(path: string): string | null {
  const parts = resolve(path).split(sep).filter((part) => part !== '');
  let at: string = sep;
  for (const part of parts) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null;
    }
  }
  return null;
}
