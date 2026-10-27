// The owner's standing grants: records in the same grants folder the send-grants and entity
// create-grants live in (`~/.config/team/grants/`, read with its own plain-file and no-symlink
// guards), carrying a `grant` mapping — a seat-level grant, naming an agent id, or a team-level
// grant, naming a team id — and the owner's signature over it.
//
//   {
//     "grant": {
//       "grantor": "owner",
//       "grantee": "agt_0123456789ab",     // a team id for a team grant
//       "kind": "seat",                    // written, never inferred from the id's shape
//       "capabilities": ["gate", "merge"], // from the closed, version-pinned vocabulary below
//                                          // (`dialogs.trust` is a team-only owner setting)
//       "scope": ["/Users/x/Code/acme"],   // always concrete: the declared roots when none is given
//       "issued": "2026-10-17T02:00:00.000Z",
//       "expires": null,                   // optional; checked at every use
//       "generation": 1,
//       "vocabulary": 1
//     },
//     "signature": "9f2c…"
//   }
//
// The signature reuses the store's own machinery and invents no crypto: the owner's Ed25519
// approval key (`keyOf`), the canonical payload encoder and a domain tag of this record's own,
// so a grant signature is never an approval or a message signature. The payload covers the file's
// stem and the whole `grant` mapping, so a record renamed or edited after signing does not verify
// and is not a grant. Nothing outside the signed bytes carries meaning: a record with a field this
// version does not know is skipped, as the store's own reader does with its records.
//
// Revocation is its own appended record, never an edit of the grant: a `revocation` mapping naming
// the grant's stem and its generation — the pair is that record's identity, so a later grant under
// the same name is a new record and this revocation never touches it (revival is a new grant,
// never a restore). A revoked or expired grant is not in `activeGrants`, the read every gate makes
// fresh: revocation takes effect at the next gate check and depends on no ledger.
//
// This module is the records only: writing them (owner-only in 0.5.0) and reading them. Writing is
// `writeGrant`/`writeRevocation`; `planGrant`/`planRevocation` are the same validation without the
// generation, the signature or the file, so a dry run refuses exactly what a write refuses. What a
// caller may do with a capability — the bundle ∩ envelope intersection, the command-to-capability
// map — is the resolver's (src/permissions/resolve.ts, src/permissions/map.ts). The capability
// list here is the grantable side of the map's last row; the map owns the command side.

import type { KeyObject } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { charterGrantBound } from '../charter/check.ts';
import { grantsDir, readGrantRecords } from '../grant.ts';
import { isAgentId } from '../registry/agents.ts';
import { bumpGeneration, keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';

/** The domain tag grant signatures carry: a grant signature verifies as nothing but a grant. */
export const GRANT_DOMAIN = 'team-grant-v1\n';

/** The vocabulary version this build writes into a grant and honors on reading one. */
export const GRANT_VOCABULARY_VERSION = 1;

/** The operational capabilities a grant may carry — the only names a grant may use (the
 *  command-to-vocabulary map's last row). */
export const GRANT_CAPABILITIES = ['write', 'read', 'review', 'gate', 'merge', 'deploy', 'act-as', 'use-broker'] as const;

/** The owner's setting a team grant may carry: `dialogs.trust` lets the team's lead answer a
 *  folder-trust dialog. It is not a command — the map holds no row for it — and never a seat
 *  word: the record names the team's id, and the gate reads it fresh at every dialog. */
export const DIALOGS_TRUST = 'dialogs.trust';

/** Every setting word a grant record may carry, beside the capabilities. A setting is a word of
 *  the signed record and never a command. */
export const GRANT_SETTINGS = [DIALOGS_TRUST] as const;

/** The whole closed vocabulary of a record: the operational capabilities and the owner's
 *  settings. The command map reads only {@link GRANT_CAPABILITIES}. */
export const GRANT_WORDS = [...GRANT_CAPABILITIES, ...GRANT_SETTINGS] as const;

/** Never on a team grant: administrative or capability-bearing names, refused at write with the
 *  reason named. A seat grant may not carry them either — they are outside the grantable
 *  vocabulary — but a team grant refuses them as what they are. */
export const TEAM_GRANT_FORBIDDEN = ['grant', 'create', 'agree', 'leads'] as const;

/** A team id: twelve lowercase hex, the shape `teamIdOf` mints. */
const TEAM_ID_PATTERN = /^[0-9a-f]{12}$/;

/** A record's file stem: one path segment, no leading dot, no separators. A revocation's stem is
 *  `revoke-` plus the revoked grant's; the command layer holds its names to the same rule before a
 *  write is attempted. */
export const RECORD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One verified grant record, exactly as written and signed. */
export type GrantRecord = {
  /** The file's stem in the grants folder; a revocation names it with the generation. */
  name: string;
  grantor: 'owner';
  /** The agent id of a seat grant, the team id of a team grant. */
  grantee: string;
  kind: 'seat' | 'team';
  capabilities: string[];
  /** Absolute paths, each inside one of the declared roots; the roots themselves when none was given. */
  scope: string[];
  issued: string;
  /** ISO timestamp, or null: a grant without an expiry. */
  expires: string | null;
  /** The number this signing holds — one sequence per home's grants folder. */
  generation: number;
  vocabulary: number;
};

/** The signed team-envelope boundary a revocation of a team grant ends, preserved inside the
 *  revocation record itself so overwriting or removing the old grant file cannot erase what the
 *  revocation terminated. */
export type RevokedEnvelope = {
  grantee: string;
  capabilities: string[];
  scope: string[];
};

/** One verified revocation record: ending the grant `grant` at `grantGeneration`, and nothing else. */
export type RevocationRecord = {
  /** The revocation file's own stem. */
  name: string;
  /** The revoked record's stem. */
  grant: string;
  /** The revoked record's generation: the pair with the stem is that record's identity. */
  grantGeneration: number;
  by: 'owner';
  at: string;
  generation: number;
  /** Present when the revoked grant is a team envelope: the team id, capabilities and scope
   *  signed into the revocation so later overwrites or removal of the envelope file cannot change
   *  which seat-grant capabilities the revocation ended. */
  envelope?: RevokedEnvelope;
};

/** A grant to write. The owner writes grants alone in 0.5.0; the record says so. */
export type GrantRequest = {
  /** The record's file stem; a revocation names it with the generation. */
  name: string;
  kind: 'seat' | 'team';
  /** An agent id for a seat grant, a team id for a team grant. */
  grantee: string;
  /** From {@link GRANT_CAPABILITIES}; stored sorted and without duplicates. */
  capabilities: readonly string[];
  /** Paths inside `roots`; omitted means the declared roots themselves. */
  scope?: readonly string[];
  /** ISO timestamp; omitted or null means no expiry. */
  expires?: string | null;
  /** The declared roots of the grantee (its team's root, the entity's paths): every scope path
   *  must sit inside one, or the write is refused with the path and the roots named. */
  roots: readonly string[];
};

/** A revocation to write: the grant's stem and generation, the pair that identifies the record. */
export type RevocationRequest = {
  /** The revocation file's own stem. */
  name: string;
  grant: string;
  generation: number;
};

export type GrantWrite = { ok: true; record: GrantRecord } | { ok: false; why: string };
export type RevocationWrite = { ok: true; record: RevocationRecord } | { ok: false; why: string };

/** A validated grant that is not yet signed or written; `record.generation` is 0 until the write
 *  moves it. The dry run's plan and the write's first half are the same call, so a preview refuses
 *  exactly what a write refuses. */
export type GrantPlan = { ok: true; record: GrantRecord } | { ok: false; why: string };

/** A validated revocation, not yet signed or written: generation 0 for a new revocation, or the
 *  existing signed record when the exact `(name, grant, generation)` revocation is already on disk. */
export type RevocationPlan = { ok: true; record: RevocationRecord } | { ok: false; why: string };

export type GrantOptions = {
  now?: Date;
  /** The signing key; the real `keyOf(home)` default. Tests and callers never forge one. */
  key?: KeyObject;
};

/**
 * Writes one owner-signed grant record. Refused, with the reason named and nothing written, for
 * everything {@link planGrant} refuses. The generation moves first, then the signed record is
 * written whole or not at all.
 */
export function writeGrant(home: string, request: GrantRequest, options: GrantOptions = {}): GrantWrite {
  const now = options.now ?? new Date();
  const plan = planGrant(home, request, { ...options, now });
  if (!plan.ok) return plan;

  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const key = options.key ?? keyOf(home);
  return withFolderLock(folder, () => {
    const committedPlan = planGrant(home, request, { now, key });
    if (!committedPlan.ok) return committedPlan;
    committedPlan.record.generation = bumpGeneration(folder, home, now);
    const disk = onDiskGrant(committedPlan.record);
    const signature = signDomain(GRANT_DOMAIN, grantPayload(committedPlan.record.name, disk), key);
    writeRecord(recordPath(home, committedPlan.record.name), { grant: disk, signature });
    return { ok: true, record: committedPlan.record };
  });
}

/**
 * Validates one grant and builds the record a write would sign — generation 0, nothing written.
 * Refused, with the reason named: a grantee of the wrong shape for its kind, a capability outside
 * the closed vocabulary, one of the four names a team grant never carries, a scope path outside
 * the declared roots, an unreadable issued or expires, an empty capability list, a stem that is
 * not one safe file name.
 */
export function planGrant(home: string, request: GrantRequest, options: GrantOptions = {}): GrantPlan {
  const now = options.now ?? new Date();
  const problem = grantProblem(home, request, now);
  if (problem !== null) return { ok: false, why: problem };
  return {
    ok: true,
    record: {
      name: request.name,
      grantor: 'owner',
      grantee: request.grantee,
      kind: request.kind,
      capabilities: normalizeCapabilities(request.capabilities),
      scope: normalizeScope(home, request.scope ?? request.roots, request.roots),
      issued: now.toISOString(),
      expires: request.expires ?? null,
      generation: 0,
      vocabulary: GRANT_VOCABULARY_VERSION,
    },
  };
}

/**
 * Writes one owner-signed revocation record, for the grant {@link planRevocation} accepts: the
 * grant's stem and generation together, so a typo is refused rather than left as a record that
 * revokes nothing, and a record name that is a grant's file is refused by the plan, never written
 * over it. Repeating the exact same `(name, grant, generation)` revocation is idempotent: it
 * returns the signed record already on disk without writing or advancing the sequence.
 */
export function writeRevocation(home: string, request: RevocationRequest, options: GrantOptions = {}): RevocationWrite {
  const now = options.now ?? new Date();
  const plan = planRevocation(home, request, { ...options, now });
  if (!plan.ok) return plan;
  if (plan.record.generation > 0) {
    return { ok: true, record: plan.record };
  }

  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const key = options.key ?? keyOf(home);
  return withFolderLock(folder, () => {
    const committedPlan = planRevocation(home, request, { now, key });
    if (!committedPlan.ok) return committedPlan;
    if (committedPlan.record.generation > 0) {
      return { ok: true, record: committedPlan.record };
    }
    committedPlan.record.generation = bumpGeneration(folder, home, now);
    const disk = onDiskRevocation(committedPlan.record);
    const signature = signDomain(GRANT_DOMAIN, revocationPayload(committedPlan.record.name, disk), key);
    writeRecordExclusive(recordPath(home, committedPlan.record.name), { revocation: disk, signature });
    return { ok: true, record: committedPlan.record };
  });
}

/**
 * Validates one revocation against the folder and builds the record a write would sign —
 * generation 0, nothing written: both stems one safe file name, a positive integer generation,
 * a record name that is neither its grant's own nor another grant's file, and a grant of that
 * exact stem and generation in the folder. Repeating an exact `(name, grant, generation)` pair
 * already on disk returns the existing record unchanged; reusing an occupied revocation stem for
 * a different `(grant, generation)` pair is refused.
 */
export function planRevocation(home: string, request: RevocationRequest, options: GrantOptions = {}): RevocationPlan {
  const now = options.now ?? new Date();
  if (!RECORD_NAME_PATTERN.test(request.name)) return { ok: false, why: `"${request.name}" is not one safe file name` };
  if (!RECORD_NAME_PATTERN.test(request.grant)) return { ok: false, why: `"${request.grant}" is not one safe file name` };
  if (!Number.isInteger(request.generation) || request.generation < 1) {
    return { ok: false, why: `"${request.generation}" is not a generation: a positive integer is expected` };
  }
  // A revocation is a separate record, never a grant's file: the write names its own stem, so a
  // stem that is the grant's own or another grant's would overwrite that grant instead of ending it.
  if (request.name === request.grant) {
    return {
      ok: false,
      why: `"${request.name}" is its grant's own name: a revocation is a separate record and never writes over the grant's file`,
    };
  }
  const { grants, revocations } = readGrants(home);
  if (grants.some((grant) => grant.name === request.name)) {
    return {
      ok: false,
      why: `"${request.name}" is another grant's name in ${grantsDir(home)}: a revocation is a separate record and never writes over a grant's file`,
    };
  }
  const existingRevocation = revocations.find((revocation) => revocation.name === request.name);
  if (existingRevocation !== undefined) {
    if (existingRevocation.grant === request.grant && existingRevocation.grantGeneration === request.generation) {
      return { ok: true, record: existingRevocation };
    }
    return {
      ok: false,
      why: `"${request.name}" is another revocation's name in ${grantsDir(home)} (revoking ${existingRevocation.grant}@${existingRevocation.grantGeneration}): a revocation is a separate record and never writes over a revocation's file`,
    };
  }
  if (existsSync(recordPath(home, request.name))) {
    return {
      ok: false,
      why: `"${request.name}" is already occupied in ${grantsDir(home)}: a revocation never writes over an existing file`,
    };
  }
  const alreadyRevoked = revocations.find(
    (revocation) => revocation.grant === request.grant && revocation.grantGeneration === request.generation,
  );
  if (alreadyRevoked !== undefined) {
    return {
      ok: false,
      why: `grant ${request.grant} at generation ${request.generation} is already revoked by ${alreadyRevoked.name} in ${grantsDir(home)}`,
    };
  }
  const target = grants.find(
    (grant) => grant.name === request.grant && grant.generation === request.generation,
  );
  if (target === undefined) {
    return { ok: false, why: `there is no grant ${request.grant} at generation ${request.generation} in ${grantsDir(home)}` };
  }
  const record: RevocationRecord = {
    name: request.name,
    grant: request.grant,
    grantGeneration: request.generation,
    by: 'owner',
    at: now.toISOString(),
    generation: 0,
    ...(target.kind === 'team'
      ? {
          envelope: {
            grantee: target.grantee,
            capabilities: [...target.capabilities],
            scope: [...target.scope],
          },
        }
      : {}),
  };
  if (target.kind === 'seat') {
    Object.defineProperty(record, SEAT_REVOCATION_SYMBOL, { value: true, enumerable: false });
  }
  return { ok: true, record };
}

/**
 * Picks the file stem a CLI standing revocation should write for `grantName` at `grantGeneration`:
 * `revoke-<grantName>` when that stem is free in the folder (or already holds the exact same
 * `(grantName, grantGeneration)` revocation), or `revoke-<grantName>-<grantGeneration>` (with an
 * index suffix if needed) when an earlier revocation already holds `revoke-<grantName>`.
 */
export function standingRevocationName(
  grantName: string,
  grantGeneration: number,
  grants: readonly GrantRecord[],
  revocations: readonly RevocationRecord[],
): string {
  const baseName = `revoke-${grantName}`;
  const existingSamePair = revocations.find(
    (revocation) =>
      revocation.name === baseName &&
      revocation.grant === grantName &&
      revocation.grantGeneration === grantGeneration,
  );
  if (existingSamePair !== undefined) return baseName;
  const priorRevocation = revocations.find((revocation) => revocation.name === baseName);
  if (priorRevocation === undefined) return baseName;
  return distinctRevocationName(baseName, grantGeneration, grants, revocations);
}

/**
 * Every verified record in the folder, grants and revocations alike — history, not effect: a
 * revoked or expired grant is here too. A record whose signature does not verify, whose shape
 * this version does not know, or whose key cannot be read is not a record and is skipped, as the
 * folder's own reader skips what does not parse.
 */
export function readGrants(home: string = homedir()): { grants: GrantRecord[]; revocations: RevocationRecord[] } {
  const grants: GrantRecord[] = [];
  const revocations: RevocationRecord[] = [];
  const state = keyState(home);
  if (state.kind !== 'key') return { grants, revocations };
  for (const { stem, record } of readGrantRecords(home)) {
    const grant = grantFrom(stem, record, state.key);
    if (grant !== null) {
      grants.push(grant);
      continue;
    }
    const revocation = revocationFrom(stem, record, state.key);
    if (revocation !== null) revocations.push(revocation);
  }
  return { grants, revocations };
}

type TeamEnvelopeRevocation = {
  grantee: string;
  capabilities: readonly string[];
  scope: readonly string[];
  grantGeneration: number;
  revocationGeneration: number;
};

const SEAT_REVOCATION_SYMBOL = Symbol.for('team.permissions.seatRevocation');
const TEAM_REVOCATIONS_SYMBOL = Symbol.for('team.permissions.seatGrantTeamRevocations');
const seatGrantTeamRevocations = new WeakMap<GrantRecord, readonly TeamEnvelopeRevocation[]>();

function getSeatGrantTeamRevocations(grant: GrantRecord): readonly TeamEnvelopeRevocation[] | undefined {
  const fromSymbol = (grant as Record<symbol, unknown>)[TEAM_REVOCATIONS_SYMBOL] as
    | readonly TeamEnvelopeRevocation[]
    | undefined;
  return fromSymbol ?? seatGrantTeamRevocations.get(grant);
}

/**
 * Whether a seat grant's authority for `(teamId, capability, targetPath)` was durably ended by a
 * later team-envelope revocation of `teamId` covering `capability` and `targetPath`.
 */
export function isSeatGrantTerminated(
  grant: GrantRecord,
  teamId: string,
  capability: string,
  targetPath: string,
): boolean {
  const revocations = getSeatGrantTeamRevocations(grant);
  if (revocations === undefined || revocations.length === 0) return false;
  return revocations.some(
    (entry) =>
      grant.generation < entry.revocationGeneration &&
      (entry.grantee === '*' || entry.grantee === teamId) &&
      entry.capabilities.includes(capability) &&
      entry.scope.some((envPath) => inside(envPath, targetPath)),
  );
}

/**
 * Whether a seat grant retains at least one non-terminated scope path for `(teamId, capability)`.
 */
export function seatGrantHasActiveScopeForTeam(
  grant: GrantRecord,
  teamId: string,
  capability: string,
): boolean {
  return grant.scope.some((seatPath) => !isSeatGrantTerminated(grant, teamId, capability, seatPath));
}

/**
 * Whether a seat grant covers `targetPath` for `(teamId, capability)` through a non-terminated
 * scope path without `targetPath` itself having been terminated for `(teamId, capability)`.
 */
export function seatGrantCoversPathForTeam(
  grant: GrantRecord,
  teamId: string,
  capability: string,
  targetPath: string,
): boolean {
  if (isSeatGrantTerminated(grant, teamId, capability, targetPath)) return false;
  return grant.scope.some(
    (seatPath) => !isSeatGrantTerminated(grant, teamId, capability, seatPath) && inside(seatPath, targetPath),
  );
}

/**
 * The non-terminated scope paths of `grant` for `(teamId, capability)`.
 */
export function activeSeatScopeForTeam(
  grant: GrantRecord,
  teamId: string,
  capability: string,
): string[] {
  return grant.scope.filter((seatPath) => !isSeatGrantTerminated(grant, teamId, capability, seatPath));
}

export type ActiveGrantOptions = {
  /** Optional team id when resolving for a specific team, so envelope revocations of other teams do not end this team's seat grants. */
  teamId?: string;
  /** Internal: retain seat grants ended solely by a team-envelope revocation when reporting outside-envelope with no active envelope. */
  includeEnvelopeEndedSeatGrants?: boolean;
};

/**
 * The grants in force at `now`: read fresh on every call — the read every gate makes — with the
 * revoked and the expired left out. Revocation takes effect here, at the next gate check, and
 * never depends on a ledger.
 */
export function activeGrants(home: string = homedir(), now: Date = new Date(), options: ActiveGrantOptions = {}): GrantRecord[] {
  const { grants, revocations } = readGrants(home);
  const revoked = new Set(revocations.map((entry) => `${entry.grant}@${entry.grantGeneration}`));
  const maxRevokedGeneration = new Map<string, number>();
  for (const entry of revocations) {
    const previous = maxRevokedGeneration.get(entry.grant) ?? 0;
    if (entry.grantGeneration > previous) {
      maxRevokedGeneration.set(entry.grant, entry.grantGeneration);
    }
  }
  const nowMs = now.getTime();
  const directlyActive = grants.filter((grant) => {
    if (revoked.has(`${grant.name}@${grant.generation}`)) return false;
    if (grant.generation <= (maxRevokedGeneration.get(grant.name) ?? 0)) return false;
    return grant.expires === null || Date.parse(grant.expires) > nowMs;
  });
  if (options.includeEnvelopeEndedSeatGrants) {
    return directlyActive;
  }

  const teamRevocations: TeamEnvelopeRevocation[] = [];
  for (const revocation of revocations) {
    if (revocation.envelope !== undefined) {
      if (options.teamId !== undefined && revocation.envelope.grantee !== options.teamId) continue;
      teamRevocations.push({
        grantee: revocation.envelope.grantee,
        capabilities: revocation.envelope.capabilities,
        scope: revocation.envelope.scope,
        grantGeneration: revocation.grantGeneration,
        revocationGeneration: revocation.generation,
      });
      continue;
    }
    if ((revocation as Record<symbol, unknown>)[SEAT_REVOCATION_SYMBOL] === true) {
      continue;
    }
    const exactGrant = grants.find(
      (grant) =>
        grant.name === revocation.grant &&
        grant.generation === revocation.grantGeneration,
    );
    if (exactGrant !== undefined) {
      if (exactGrant.kind !== 'team') continue;
      if (options.teamId !== undefined && exactGrant.grantee !== options.teamId) continue;
      teamRevocations.push({
        grantee: exactGrant.grantee,
        capabilities: exactGrant.capabilities,
        scope: exactGrant.scope,
        grantGeneration: revocation.grantGeneration,
        revocationGeneration: revocation.generation,
      });
      continue;
    }
    // Legacy revocation without an embedded `envelope` field whose exact target record at
    // `(revocation.grant, revocation.grantGeneration)` is missing from disk: never infer historical
    // target identity, kind, or scope from a newer same-stem record. Fail closed for all
    // pre-existing seat grants older than `revocation.generation`.
    teamRevocations.push({
      grantee: '*',
      capabilities: [...GRANT_WORDS],
      scope: ['/'],
      grantGeneration: revocation.grantGeneration,
      revocationGeneration: revocation.generation,
    });
  }
  if (teamRevocations.length === 0) {
    return directlyActive;
  }

  const activeTeamEnvelopes = directlyActive.filter((grant) => grant.kind === 'team');
  const isPairActiveInHome = (grant: GrantRecord, capability: string, seatPath: string): boolean => {
    const revokingTeams = new Set<string>();
    for (const tr of teamRevocations) {
      if (
        grant.generation < tr.revocationGeneration &&
        tr.capabilities.includes(capability) &&
        tr.scope.some((envPath) => inside(envPath, seatPath))
      ) {
        if (tr.grantee === '*') return false;
        revokingTeams.add(tr.grantee);
      }
    }
    if (revokingTeams.size === 0) return true;
    if (options.teamId !== undefined) return false;
    return activeTeamEnvelopes.some(
      (env) =>
        !revokingTeams.has(env.grantee) &&
        env.capabilities.includes(capability) &&
        env.scope.some((envPath) => inside(envPath, seatPath)),
    );
  };

  const result: GrantRecord[] = [];
  for (const grant of directlyActive) {
    if (grant.kind !== 'seat') {
      result.push(grant);
      continue;
    }
    const remainingCapabilities = grant.capabilities.filter((capability) =>
      grant.scope.some((seatPath) => isPairActiveInHome(grant, capability, seatPath)),
    );
    if (remainingCapabilities.length === 0) continue;
    const remainingScope = grant.scope.filter((seatPath) =>
      remainingCapabilities.some((capability) => isPairActiveInHome(grant, capability, seatPath)),
    );
    if (remainingScope.length === 0) continue;
    const narrowed =
      remainingCapabilities.length === grant.capabilities.length && remainingScope.length === grant.scope.length
        ? grant
        : { ...grant, capabilities: remainingCapabilities, scope: remainingScope };
    const applicableRevocations = teamRevocations.filter((tr) => grant.generation < tr.revocationGeneration);
    if (applicableRevocations.length > 0) {
      const annotated = narrowed === grant ? { ...grant } : narrowed;
      (annotated as Record<symbol, unknown>)[TEAM_REVOCATIONS_SYMBOL] = applicableRevocations;
      seatGrantTeamRevocations.set(annotated, applicableRevocations);
      result.push(annotated);
    } else {
      result.push(narrowed);
    }
  }
  return result;
}

/**
 * Whether a grant's grantee is this identity: a seat grant covers the agent id it names, a team
 * grant the team id — by the id alone, so a seat added to the team after the grant is covered,
 * and a CLI, launch or pane change of the same agent is nothing to the grant.
 */
export function covers(grant: GrantRecord, grantee: { agentId?: string | null; teamId?: string | null }): boolean {
  return grant.kind === 'seat' ? grant.grantee === (grantee.agentId ?? null) : grant.grantee === (grantee.teamId ?? null);
}

// ---- writing helpers ----------------------------------------------------------------------

function recordPath(home: string, name: string): string {
  return join(grantsDir(home), `${name}.json`);
}

/** Writes one record whole: a temporary file of mode 600, then a rename. */
function writeRecord(path: string, value: Json): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

/** Writes one append-only record exclusively: links the staged temporary file to `path` so an
 *  existing destination file can never be overwritten, then unlinks the temporary name. */
function writeRecordExclusive(path: string, value: Json): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

let lockSequence = 0;

/** Serializes grant and revocation commits within a single grants folder across concurrent writers. */
function withFolderLock<T>(folder: string, fn: () => T): T {
  const lockPath = join(folder, '.write.lock');
  const deadline = Date.now() + 5000;
  const stagedLock = `${lockPath}.${process.pid}.${++lockSequence}.tmp`;
  writeFileSync(stagedLock, `${process.pid}\n`, { mode: 0o600 });
  let myIno = -1;
  let acquired = false;
  try {
    myIno = statSync(stagedLock).ino;
    while (!acquired) {
      try {
        linkSync(stagedLock, lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lockStat = statSync(lockPath);
          const rawPid = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
          if (Number.isInteger(rawPid) && rawPid > 0) {
            try {
              process.kill(rawPid, 0);
            } catch (killError) {
              if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
                const reclaimGuard = `${lockPath}.reclaim-${lockStat.ino}`;
                try {
                  linkSync(lockPath, reclaimGuard);
                  try {
                    if (statSync(lockPath).ino === lockStat.ino) {
                      unlinkSync(lockPath);
                    }
                  } finally {
                    try {
                      unlinkSync(reclaimGuard);
                    } catch {}
                  }
                  continue;
                } catch {}
              }
            }
          }
        } catch {}
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for grant store lock ${lockPath}`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
  } finally {
    try {
      unlinkSync(stagedLock);
    } catch {}
  }
  try {
    return fn();
  } finally {
    try {
      if (statSync(lockPath).ino === myIno) {
        unlinkSync(lockPath);
      }
    } catch {}
  }
}

/** The bytes a grant signature covers: the file's stem and the whole grant mapping. */
function grantPayload(name: string, grant: Json): Json {
  return { name, grant };
}

/** The bytes a revocation signature covers: the file's stem and the whole revocation mapping. */
function revocationPayload(name: string, record: Json): Json {
  return { name, revocation: record };
}

/** The grant mapping as written: the stem is the name and is signed beside the mapping, not in it. */
function onDiskGrant(record: GrantRecord): Record<string, Json> {
  return {
    grantor: record.grantor,
    grantee: record.grantee,
    kind: record.kind,
    capabilities: [...record.capabilities],
    scope: [...record.scope],
    issued: record.issued,
    expires: record.expires,
    generation: record.generation,
    vocabulary: record.vocabulary,
  };
}

/** The revocation mapping as written: `generation` is the revoked record's; the file's own number
 *  is signed with the mapping. */
function onDiskRevocation(record: RevocationRecord): Record<string, Json> {
  return {
    grant: record.grant,
    grant_generation: record.grantGeneration,
    by: record.by,
    at: record.at,
    generation: record.generation,
    ...(record.envelope !== undefined
      ? {
          envelope: {
            grantee: record.envelope.grantee,
            capabilities: [...record.envelope.capabilities],
            scope: [...record.envelope.scope],
          },
        }
      : (record as Record<symbol, unknown>)[SEAT_REVOCATION_SYMBOL] === true
        ? { envelope: null }
        : {}),
  };
}

// ---- validation ---------------------------------------------------------------------------

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities)].sort();
}

function normalizeScope(home: string, scope: readonly string[], _roots: readonly string[]): string[] {
  return [...new Set(scope.map((path) => expand(home, path)))].sort();
}

function expand(home: string, path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, home));
}

function hasDotTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function distinctRevocationName(
  baseName: string,
  grantGeneration: number,
  grants: readonly GrantRecord[],
  revocations: readonly RevocationRecord[],
): string {
  const taken = new Set<string>([
    ...grants.map((grant) => grant.name),
    ...revocations.map((revocation) => revocation.name),
  ]);
  const suffix = `-${grantGeneration}`;
  const primary = `${baseName.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  if (RECORD_NAME_PATTERN.test(primary) && !taken.has(primary)) return primary;
  for (let index = 2; ; index += 1) {
    const indexedSuffix = `-${grantGeneration}-${index}`;
    const candidate = `${baseName.slice(0, Math.max(1, 64 - indexedSuffix.length))}${indexedSuffix}`;
    if (RECORD_NAME_PATTERN.test(candidate) && !taken.has(candidate)) return candidate;
  }
}

function grantProblem(home: string, request: GrantRequest, now: Date): string | null {
  if (!RECORD_NAME_PATTERN.test(request.name)) return `"${request.name}" is not one safe file name`;
  if (request.kind !== 'seat' && request.kind !== 'team') return `"${request.kind}" is not a grant kind: seat or team is expected`;
  if (request.kind === 'seat' && !isAgentId(request.grantee)) {
    return `a seat grant names an agent id: "${request.grantee}" is not agt_ plus 12 hex`;
  }
  if (request.kind === 'team' && !TEAM_ID_PATTERN.test(request.grantee)) {
    return `a team grant names a team id: "${request.grantee}" is not 12 hex`;
  }
  if (request.capabilities.length === 0) return 'a grant carries at least one capability';
  for (const capability of request.capabilities) {
    if (request.kind === 'team' && (TEAM_GRANT_FORBIDDEN as readonly string[]).includes(capability)) {
      return `a team grant never carries \`${capability}\`: the four administrative names (${TEAM_GRANT_FORBIDDEN.join(', ')}) are refused on a team grant`;
    }
    if (request.kind !== 'team' && (GRANT_SETTINGS as readonly string[]).includes(capability)) {
      return `a seat grant never carries \`${capability}\`: it is a team setting, and the record names the team's id`;
    }
    if (!(GRANT_WORDS as readonly string[]).includes(capability)) {
      return `"${capability}" is not a grantable capability: the vocabulary is closed (${GRANT_WORDS.join(', ')})`;
    }
  }
  if (request.expires !== undefined && request.expires !== null) {
    if (typeof request.expires !== 'string' || !Number.isFinite(Date.parse(request.expires))) {
      return `"${request.expires}" is not a readable expiry timestamp`;
    }
  }
  if (!Number.isFinite(now.getTime())) return 'the issued time is not a readable timestamp';
  const roots = request.roots.map((root) => expand(home, root));
  if (roots.length === 0) return 'a grant names at least one declared root: its scope sits within them';
  for (const path of request.scope ?? []) {
    if (typeof path !== 'string' || path.trim() === '') return 'a scope path is empty';
    if (!path.startsWith('/') && !path.startsWith('~/')) {
      return `the scope path ${path} is not absolute: a scope is an absolute path or starts with \`~/\``;
    }
    if (hasDotTraversal(path)) {
      return `the scope path ${path} walks through \`.\` or \`..\`; declare the real path`;
    }
    const expanded = expand(home, path);
    if (!roots.some((root) => inside(root, expanded))) {
      return `the scope path ${expanded} is outside the declared roots (${roots.join(', ')}): a grant's scope sits within them`;
    }
  }
  if (readGrants(home).revocations.some((revocation) => revocation.name === request.name)) {
    return `"${request.name}" is a revocation's name in ${grantsDir(home)}: a grant is a separate record and never writes over a revocation's file`;
  }
  const bound = charterGrantBound(home, request);
  if (bound !== null) return bound;
  return null;
}

/** A verified grant from a folder record, or null: `grant` plus `signature` and nothing else,
 * every field of the known shape, and the signature over exactly the stem and the mapping. */
function grantFrom(stem: string, record: Record<string, unknown>, key: KeyObject): GrantRecord | null {
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'grant' || keys[1] !== 'signature') return null;
  const raw = record.grant;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const known = ['grantor', 'grantee', 'kind', 'capabilities', 'scope', 'issued', 'expires', 'generation', 'vocabulary'];
  if (Object.keys(fields).some((key) => !known.includes(key))) return null;
  if (fields.grantor !== 'owner') return null;
  const grantee = typeof fields.grantee === 'string' ? fields.grantee : null;
  const kind = fields.kind === 'seat' || fields.kind === 'team' ? fields.kind : null;
  if (grantee === null || kind === null) return null;
  if (kind === 'seat' ? !isAgentId(grantee) : !TEAM_ID_PATTERN.test(grantee)) return null;
  if (!Array.isArray(fields.capabilities) || fields.capabilities.length === 0) return null;
  const capabilities = fields.capabilities;
  if (!capabilities.every((value) => typeof value === 'string' && (GRANT_WORDS as readonly string[]).includes(value))) return null;
  if (kind === 'team' && capabilities.some((value) => (TEAM_GRANT_FORBIDDEN as readonly string[]).includes(value as string))) return null;
  if (kind !== 'team' && capabilities.some((value) => (GRANT_SETTINGS as readonly string[]).includes(value as string))) return null;
  if (!Array.isArray(fields.scope) || !fields.scope.every((value) => typeof value === 'string' && value !== '')) return null;
  if (typeof fields.issued !== 'string' || !Number.isFinite(Date.parse(fields.issued))) return null;
  if (fields.expires !== null && (typeof fields.expires !== 'string' || !Number.isFinite(Date.parse(fields.expires)))) return null;
  if (!Number.isInteger(fields.generation) || (fields.generation as number) < 1) return null;
  if (fields.vocabulary !== GRANT_VOCABULARY_VERSION) return null;
  if (typeof record.signature !== 'string') return null;
  if (!verifyDomain(GRANT_DOMAIN, grantPayload(stem, raw as Json), record.signature, key)) return null;
  return {
    name: stem,
    grantor: 'owner',
    grantee,
    kind,
    capabilities: [...capabilities] as string[],
    scope: [...(fields.scope as string[])],
    issued: fields.issued,
    expires: fields.expires as string | null,
    generation: fields.generation as number,
    vocabulary: GRANT_VOCABULARY_VERSION,
  };
}

/** A verified revocation from a folder record, or null. */
function revocationFrom(stem: string, record: Record<string, unknown>, key: KeyObject): RevocationRecord | null {
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'revocation' || keys[1] !== 'signature') return null;
  const raw = record.revocation;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const known = ['grant', 'grant_generation', 'by', 'at', 'generation', 'envelope'];
  if (Object.keys(fields).some((key) => !known.includes(key))) return null;
  if (typeof fields.grant !== 'string' || !RECORD_NAME_PATTERN.test(fields.grant)) return null;
  if (!Number.isInteger(fields.grant_generation) || (fields.grant_generation as number) < 1) return null;
  if (fields.by !== 'owner') return null;
  if (typeof fields.at !== 'string' || !Number.isFinite(Date.parse(fields.at))) return null;
  if (!Number.isInteger(fields.generation) || (fields.generation as number) < 1) return null;
  let envelope: RevokedEnvelope | undefined;
  const isSeatRevocation = fields.envelope === null;
  if (fields.envelope !== undefined && fields.envelope !== null) {
    const parsed = revokedEnvelopeFrom(fields.envelope);
    if (parsed === null) return null;
    envelope = parsed;
  }
  if (typeof record.signature !== 'string') return null;
  if (!verifyDomain(GRANT_DOMAIN, revocationPayload(stem, raw as Json), record.signature, key)) return null;
  const verified: RevocationRecord = {
    name: stem,
    grant: fields.grant,
    grantGeneration: fields.grant_generation as number,
    by: 'owner',
    at: fields.at,
    generation: fields.generation as number,
    ...(envelope !== undefined ? { envelope } : {}),
  };
  if (isSeatRevocation) {
    Object.defineProperty(verified, SEAT_REVOCATION_SYMBOL, { value: true, enumerable: false });
  }
  return verified;
}

function revokedEnvelopeFrom(raw: unknown): RevokedEnvelope | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const known = ['grantee', 'capabilities', 'scope'];
  if (Object.keys(fields).some((key) => !known.includes(key))) return null;
  if (typeof fields.grantee !== 'string' || !TEAM_ID_PATTERN.test(fields.grantee)) return null;
  if (!Array.isArray(fields.capabilities) || fields.capabilities.length === 0) return null;
  if (!fields.capabilities.every((value) => typeof value === 'string' && (GRANT_WORDS as readonly string[]).includes(value))) return null;
  if (fields.capabilities.some((value) => (TEAM_GRANT_FORBIDDEN as readonly string[]).includes(value as string))) return null;
  if (!Array.isArray(fields.scope) || !fields.scope.every((value) => typeof value === 'string' && value !== '')) return null;
  return {
    grantee: fields.grantee,
    capabilities: [...(fields.capabilities as string[])],
    scope: [...(fields.scope as string[])],
  };
}
