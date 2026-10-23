// The client team grant's two halves that read the world: binding a request to one live team (its
// name, registry id, real root and the fingerprints of its file), and verifying a client's own
// `team up --client <grant> --key <key>` or `team down --client <grant> --key <key>` against that
// binding. The two ops share one binding and one verification; they differ in the op the grant must
// carry and in one rule: `down` does not need the team file to be the one the owner signed (below). The record, its signature and its
// revocation live in `records.ts`; this module decides only whether THIS invocation, here, now,
// is the one the owner signed. Every refusal ends with the owner's exact next step.

import { createPrivateKey } from 'node:crypto';
import type { BundleOp } from './bundle-ops.ts';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { compare, describe, fingerprints } from '../approve/fingerprint.ts';
import { declaredRoots } from '../entities.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
import { signDomain, verifyDomain, type Json } from '../store/keys.ts';
import {
  CLIENT_WORD_PATTERN,
  activeClientUpGrant,
  canonicalTeamOps,
  bundleForOp,
  grantLabelOf,
  publicKeyObject,
  readClientPrivateKey,
  readClientUpGrantFile,
  upRequestCommand,
  type ClientUpBinding,
  type ClientUpGrantRecord,
} from './records.ts';

/** The domain tag an up request signature carries: the sender's proof that it holds the app key
 *  for this grant, this team and this folder. It is never a send, a read, an approval or a grant. */
export const CLIENT_UP_REQUEST_DOMAIN = 'team-client-request-v3\n';

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function insideOrSame(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Why a team may not be bound under `entity`, or null. A team that names no entity is bound by
 *  its project, id and root alone; one that names another entity is never bound under this one;
 *  and when the entity declares roots, the team's root sits inside one of them. */
function entityProblem(home: string, entity: string, team: TeamFile, teamId: string, root: string): string | null {
  const records = (() => {
    try {
      return readTeams(home);
    } catch {
      return null;
    }
  })();
  if (records === null) return 'the team registry cannot be read';
  const record = records[teamId];
  if (record !== undefined && record.lifecycle === 'archived') return `team "${team.project}" is archived`;
  for (const named of [team.entity, record?.entity ?? null]) {
    if (named !== null && named !== entity) {
      return `team "${team.project}" belongs to entity "${named}"; a client grant under entity "${entity}" binds a team with no entity or entity "${entity}"`;
    }
  }
  const roots = declaredRoots(home).get(entity);
  if (roots !== undefined && !roots.some((allowed) => insideOrSame(real(allowed.replace(/^~(?=$|\/)/, home)), root))) {
    return `team "${team.project}" sits outside the roots entity "${entity}" declares`;
  }
  return null;
}

/**
 * Binds a request to one live team: the team named `project`, found in `cwd` when that folder is
 * its team folder and otherwise by the registry (exactly one, not archived). The binding carries
 * the real root and the fingerprints of the file as it reads now, so what the owner answers is
 * the file in front of them and nothing looser.
 */
export function resolveClientUpTarget(
  home: string,
  entity: string,
  project: string,
  cwd: string,
): { ok: true; binding: ClientUpBinding; team: TeamFile } | { ok: false; why: string } {
  if (!CLIENT_WORD_PATTERN.test(project)) return { ok: false, why: `"${project}" is not a team name: one lowercase word, digits and hyphens` };
  let root: string | null = null;
  const here = loadTeamFile(cwd, { home });
  if (here.ok && here.team.project === project) root = real(here.root);
  if (root === null) {
    let records;
    try {
      records = readTeams(home);
    } catch {
      return { ok: false, why: 'the team registry cannot be read' };
    }
    const named = Object.values(records).filter((record) => record.project === project && record.lifecycle !== 'archived');
    if (named.length === 0) {
      return { ok: false, why: `no team "${project}" is registered and this folder is not its team folder; run the request from the folder that holds ${project}'s .agents/team.yaml` };
    }
    if (named.length > 1) {
      return { ok: false, why: `${String(named.length)} registered teams are named "${project}" (${named.map((record) => record.root).join(', ')}); run the request from the folder of the one the grant is for` };
    }
    root = real(named[0]!.root);
  }
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) return { ok: false, why: `the team file of "${project}" at ${root} does not load: ${loaded.errors[0]?.message ?? 'unreadable'}` };
  if (loaded.team.project !== project) return { ok: false, why: `the team file at ${root} names team "${loaded.team.project}", not "${project}"` };
  const teamId = teamIdOf(root);
  const problem = entityProblem(home, entity, loaded.team, teamId, root);
  if (problem !== null) return { ok: false, why: problem };
  return { ok: true, binding: { project, teamId, root, fingerprints: fingerprints(loaded.team) }, team: loaded.team };
}

/** What differs between the file the owner signed for and the file now: one line per change, the
 *  same words `team status` uses, or an empty list. */
export function upDrift(binding: ClientUpBinding, team: TeamFile): string[] {
  return compare(binding.fingerprints, fingerprints(team)).map(describe);
}

/**
 * Whether a binding still names the live team: the folder loads, carries the same team name and
 * registry id, still sits under the entity, and its file is the one the binding fingerprints.
 * Used at the request, at execute (the owner's answer is for this file) and at every client run.
 */
export function upBindingProblem(
  home: string,
  entity: string,
  binding: ClientUpBinding,
  /** `down`: a team file that changed, or that no longer loads, does not stop the owner's stop.
   *  Identity (name, registry id, folder, entity) is still checked whenever the file loads. */
  op: BundleOp = 'up',
): { kind: 'drift' | 'team'; why: string; changes: string[] } | null {
  const team = (why: string) => ({ kind: 'team' as const, why, changes: [] as string[] });
  const loaded = loadTeamFile(binding.root, { home });
  if (!loaded.ok) {
    if (op === 'down' && teamIdOf(binding.root) === binding.teamId) return null;
    return team(`the team file at ${binding.root} does not load: ${loaded.errors[0]?.message ?? 'unreadable'}`);
  }
  if (real(loaded.root) !== binding.root) return team(`the folder ${binding.root} is not a team root any more`);
  if (loaded.team.project !== binding.project) return team(`the team file at ${binding.root} names team "${loaded.team.project}", not "${binding.project}"`);
  if (teamIdOf(binding.root) !== binding.teamId) return team(`the folder ${binding.root} is not the team the grant signs (registry id differs)`);
  const problem = entityProblem(home, entity, loaded.team, binding.teamId, binding.root);
  if (problem !== null) return team(problem);
  // Only `up` is the owner's signature on THIS file: every other op names the team, not its file.
  if (op !== 'up') return null;
  const changes = upDrift(binding, loaded.team);
  if (changes.length > 0) return { kind: 'drift', why: 'the team file changed', changes };
  return null;
}

export type ClientUpVerification =
  | { ok: true; grant: ClientUpGrantRecord; root: string; requestId: string; /** The owner's signature on the grant, for the re-read under the lock. */ signature: string }
  | { ok: false; why: string; /** Set once the key proved the client's identity: the refusal is then written to the team's log. */ identified: ClientUpGrantRecord | null };

/** The command that renews one grant, spelled for its own client key, team and ops. */
function renew(grant: ClientUpGrantRecord, ops: readonly string[] = grant.ops): string {
  const base = { clientId: grant.clientId, entity: grant.entity, keyDir: grant.keyDir, project: grant.up.project };
  // A bundle grant is renewed as a bundle: the one that carries every op it carried, and the new one if it is wider.
  if (grant.bundle !== undefined) {
    const developer = grant.bundle === 'developer' || ops.some((op) => bundleForOp(op) === 'developer');
    if (developer) return upRequestCommand({ ...base, bundle: 'developer' });
    const manager = grant.bundle === 'manager' || ops.some((op) => bundleForOp(op) === 'manager');
    return upRequestCommand({ ...base, bundle: manager ? 'manager' : ops.some((op) => bundleForOp(op) === 'operator') || grant.bundle === 'operator' ? 'operator' : 'observer' });
  }
  return upRequestCommand({ ...base, ops: canonicalTeamOps(ops) ?? ops });
}

/**
 * Verifies one `team up --client` (or, with `op: 'down'`, `team down --client`) invocation end to end, in the order that reads least first: the
 * grant file verifies under the owner key and is an up grant; the key file passes its hygiene
 * rules and is the grant's own app key, and a request built from this invocation signs and
 * verifies with it; the grant is canonical, unexpired and unrevoked; this folder, or the team
 * named, is the folder the owner signed; and the team file is the one the owner approved.
 * Nothing here prompts, writes or launches.
 */
export function verifyClientUp(input: {
  home: string;
  grantFile: string;
  keyFile: string;
  cwd: string;
  team?: string;
  now: Date;
  /** The op this invocation runs; the grant must carry it. Default `up`. */
  op?: BundleOp;
}): ClientUpVerification {
  const op: BundleOp = input.op ?? 'up';
  const fail = (why: string, identified: ClientUpGrantRecord | null = null): ClientUpVerification => ({ ok: false, why, identified });
  const presented = readClientUpGrantFile(input.home, input.grantFile, op);
  if (!presented.ok) return fail(presented.why);
  const grant = presented.grant;
  const key = readClientPrivateKey(input.home, input.keyFile);
  if (!key.ok) return fail(`${key.why}; the client key is ${join(grant.keyDir, 'client.key')}`);
  if (key.publicKey !== grant.publicKey || key.keyId !== grant.keyId) {
    return fail(`the key file is not the app key the grant ${grant.grantId} names; use ${join(grant.keyDir, 'client.key')}`);
  }
  const requestId = `${op}_${randomBytes(12).toString('hex')}`;
  const body: Json = {
    v: 3,
    op,
    grant_id: grant.grantId,
    client_id: grant.clientId,
    key_id: grant.keyId,
    entity: grant.entity,
    project: grant.up.project,
    team_id: grant.up.teamId,
    root: grant.up.root,
    request_id: requestId,
    issued_at: input.now.toISOString(),
  };
  let signature: string;
  try {
    signature = signDomain(CLIENT_UP_REQUEST_DOMAIN, body, createPrivateKey(key.privatePem));
  } catch {
    return fail('the request could not be signed with the app key');
  }
  const publicKey = publicKeyObject(grant.publicKey);
  if (publicKey === null || !verifyDomain(CLIENT_UP_REQUEST_DOMAIN, body, signature, publicKey)) {
    return fail("the request signature does not verify under the grant's app key");
  }
  // The identity is proven from here on: every later refusal is written to the team's log.
  const refuse = (why: string): ClientUpVerification => fail(why, grant);

  const active = activeClientUpGrant(input.home, presented, input.now);
  if (!active.ok) {
    return refuse(active.kind === 'other' ? active.why : `${active.why}; the owner issues a new one with ${renew(grant)}`);
  }
  const signed = `team "${grant.up.project}" at ${grant.up.root}`;
  const label = grantLabelOf(grant);
  // A grant carries exactly the ops the owner signed: one for `up` is no leave to stop, and the
  // other way round. The refusal names the request that would add the op, and never adds it.
  if (!grant.ops.includes(op)) {
    return refuse(`the ${label} ${grant.grantId} admits ${grant.ops.join(' and ')} only, not ${op}; the owner requests one that carries ${op} with ${renew(grant, [...grant.ops, op])}`);
  }
  if (input.team !== undefined && input.team !== grant.up.project) {
    return refuse(`the ${label} ${grant.grantId} is for ${signed}, not team "${input.team}"`);
  }
  // Where the caller stands. The grant names its one folder, so the run is that folder whatever the
  // caller's; the check is only against a mix-up. Inside the signed folder: fine. Inside another
  // team's folder: refused unless the team is named — and a team of the same name in another
  // folder is refused even then, since it is not clear which of the two was meant.
  const nameIt = `Run it in ${grant.up.root}, or name the team: team ${op} --client <grant> --key <key> --team ${grant.up.project}`;
  // `send` names its target in the address, so where the caller stands is no part of it.
  const here = op === 'send' ? null : loadTeamFile(input.cwd, { home: input.home, checkOnly: true });
  if (here === null) {
    // (nothing to compare: see above)
  } else if (here.ok) {
    if (real(here.root) !== grant.up.root) {
      if (input.team === undefined) {
        return refuse(`the ${label} ${grant.grantId} is for ${signed}; this folder is team "${here.team.project}" at ${real(here.root)}, which the owner did not sign. ${nameIt}`);
      }
      if (here.team.project === grant.up.project) {
        return refuse(`the ${label} ${grant.grantId} is for ${signed}; this folder is also a team "${here.team.project}", at ${real(here.root)}, which the owner did not sign. Run it in ${grant.up.root}`);
      }
    }
  } else if (input.team === undefined && !(op === 'down' && real(input.cwd) === grant.up.root)) {
    // (A `down` run in the signed folder itself is that folder even when its team file no longer
    // loads: stopping the team must stay possible, and the run's own file read says what is wrong.)
    return refuse(`the ${label} ${grant.grantId} is for ${signed}; this folder is not its team folder. ${nameIt}`);
  }
  const problem = upBindingProblem(input.home, grant.entity, grant.up, op);
  if (problem !== null) {
    if (problem.kind === 'team') return refuse(`${problem.why}; the owner issues a new ${label} with ${renew(grant)}`);
    return refuse(`the team file of ${grant.up.project} changed since the owner signed the ${label} ${grant.grantId}: ${problem.changes.join('; ')}. The owner re-signs with ${renew(grant)}, answers on the owner seat, then runs team grant --execute <request-id>`);
  }
  // The grant is re-read under the grant lock immediately before the run's first effect.
  return { ok: true, grant, root: grant.up.root, requestId, signature: presented.signature };
}

