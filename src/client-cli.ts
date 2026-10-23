// The owner-facing client half of the CLI: the grant and revocation forms of `team grant` and
// `team revoke`, plus the owner admission they share and the key-file reading keygen and grant
// share. The client record, its signature, the store and the lock live in
// `src/client/records.ts`; this file only prints what those functions answer and keeps every
// numeric exit in the command file that declares it.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Args } from './args.ts';
import { describeCaller, isOwner, walkCaller } from './caller.ts';
import { devModeOwnerLiftAtCwd } from './dev_mode.ts';
import {
  CLIENT_GRANT_ID_PATTERN,
  CLIENT_PUBLIC_KEY_PATTERN,
  KEY_ISOLATION_LINE,
  appendClientRevocation,
  keyIdOf,
  publicRawOf,
  teamGrantLabel,
  teamOpFlags,
  withClientGrantLock,
  writeClientGrant,
  writeClientGrantAudit,
  writeClientUpGrant,
  writeClientBundleGrant,
  bundleSeatsAdmitted,
  type ClientGrantScope,
  type ClientTeamOp,
} from './client/records.ts';
import { resolveClientUpTarget } from './client/up-grant.ts';
import { readTeams } from './registry/teams.ts';
import { bundleSignsFile, isBundleName, type BundleName, type BundleOp } from './client/bundle-ops.ts';
import { bundleCard, expandBundle, projectIdOfTeam } from './client/bundles.ts';
import { verifyClientGrantIssue } from './client/verify.ts';
import { acceptOwnerSigner, addOwnerSigner, deliverToOwnerSeat, readOwnerSeat, ownerSeatMessages, registerOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from './client/owner-seat.ts';
import { approveAsOwnerSeat, GRANT_CHOICES, type PendingUpBinding, answerPendingGrant, confirmationLine, autoApprovePendingGrant, createPendingGrant, denyPendingGrant, executePendingGrant, grantEmissionOf, listApprovalRules, matchingApprovalRule, oneTimeCodeAdapter, pendingSummary, revokeApprovalRule, type OwnerNotifier, type PendingGrantParams } from './client/emission.ts';
import type { Io } from './io.ts';
import { plainText } from './launch/plain.ts';
import { writeJson, writeJsonError } from './output/index.ts';

/** The client key the owner points `--public-key` at: the public half written by keygen, or
 *  the private key file itself, from which the public half is read and never printed. */
export type ClientPublicInput = {
  publicKey: string;
  keyId: string;
  keyDir: string;
};

function objectOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Reads one client key directory's public half (or its private key, for the public half). */
export function clientPublicInput(arg: string, cwd: string): { ok: true; key: ClientPublicInput } | { ok: false; why: string } {
  const path = resolve(cwd, arg);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, why: `the client key file ${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})` };
  }
  const record = objectOf(text);
  if (record === null) return { ok: false, why: `the client key file ${path} is not a client key` };
  if (typeof record.private === 'string') {
    let derived: { publicKey: string; keyId: string };
    try {
      derived = publicRawOf(record.private);
    } catch {
      return { ok: false, why: `the client key file ${path} does not parse as an Ed25519 key` };
    }
    return { ok: true, key: { ...derived, keyDir: dirname(path) } };
  }
  if (typeof record.public_key !== 'string' || !CLIENT_PUBLIC_KEY_PATTERN.test(record.public_key)) {
    return { ok: false, why: `the client key file ${path} carries no 64-hex Ed25519 public key` };
  }
  const keyDir = typeof record.key_dir === 'string' ? record.key_dir : dirname(path);
  const keyId = typeof record.key_id === 'string' ? record.key_id : keyIdOf(record.public_key);
  return { ok: true, key: { publicKey: record.public_key, keyId, keyDir } };
}

/** The owner admission every client-form call shares: the one sentence a seat reads, and the
 *  `*.refused` error the JSON form writes. Returns true when the call may go on. */
export function clientOwnerAllows(command: 'grant' | 'revoke', rawIo: Io, io: Io, json: boolean, home: string = homedir()): boolean {
  const caller = walkCaller(io);
  if (isOwner(caller)) return true;
  const message = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
  // The owner's dev-mode admission for exactly this gate. The home is the
  // one the central resolver reads a governing policy or the machine record from; the command
  // always names it, so a herdr caller is not refused before the record can be read.
  const lift = devModeOwnerLiftAtCwd(rawIo, { command, refusal: message, home });
  if (lift !== null && lift.lifted) {
    io.stderr(`${lift.warning}\n`);
    return true;
  }
  if (json) {
    writeJsonError(rawIo, `${command}.refused`, plainText(message), `the owner runs \`team ${command}\` from a terminal outside herdr`, 1, 'owner-only');
  } else {
    io.stderr(`team ${command}: ${message}\n`);
  }
  return false;
}

/** The ops `--up` and `--down` ask for, in canonical order, or null when neither flag is given. */
export function teamOpsOfArgs(args: Args): ClientTeamOp[] | null {
  const asked = (['up', 'down'] as const).filter((op) => args.flags.has(op));
  return asked.length === 0 ? null : asked;
}

/** The problems the `--client` form of `team grant` owns, or null when the arguments are whole. */
export function clientGrantProblem(args: Args): string | null {
  if (args.error !== undefined) return args.error;
  if (args.flags.has('dry-run')) return '--dry-run belongs to the team-file forms; a client grant is issued or refused whole';
  if (args.rest.length > 0) return 'the --client form takes no positional arguments';
  if (args.values.client === undefined) return '--client is required';
  if (args.values.entity === undefined) return '--entity is required';
  if (args.values['public-key'] === undefined) return '--public-key is required';
  if (args.values.scope !== undefined) return '--scope belongs to the team-file form';
  if (args.values.capabilities !== undefined) return '--capabilities belongs to the standing-grant form';
  if (args.values.name !== undefined) return '--name belongs to the standing-grant form';
  for (const flag of ['execute', 'code', 'approve', 'deny', 'revoke-approval'] as const) {
    if (args.values[flag] !== undefined) return `--${flag} does not take --client: team grant --execute <request-id> --code <code>`;
  }
  if (args.flags.has('approvals')) return '--approvals takes no other arguments';
  if (args.flags.has('request') && args.flags.has('client-request')) return '--request and --client-request are two different forms';
  const teamOps = teamOpsOfArgs(args);
  if (args.values.bundle !== undefined) {
    // A bundle is the owner's form alone, like `--up`: it never rides a master grant, so a sub-grant
    // can never carry one, and it carries only what its name expands to for the one team it names.
    const asked = args.values.bundle;
    if (!isBundleName(asked)) return `--bundle takes observer, operator, manager or developer, not "${asked}"`;
    if (teamOps !== null) return `--bundle ${asked} and ${teamOpFlags(teamOps)} are two forms: a bundle's ops come from its name; ask for one or the other`;
    if (args.flags.has('client-request')) return `--bundle belongs to the owner form: a sub-grant never carries a bundle`;
    if (args.values.team === undefined) return `--bundle ${asked} needs --team <team>: a bundle binds one team and its folder`;
    if (args.flags.has('inbox')) return `--bundle ${asked} takes no --inbox: a bundle carries the ops its name expands to and nothing else`;
    if (args.flags.has('allow-grant') || MASTER_SCOPE_FLAGS.some((flag) => args.values[flag] !== undefined)) return `--bundle ${asked} takes no --allow-grant: a bundle never carries grant`;
    if (args.values.via !== undefined || args.values.key !== undefined) return '--via and --key belong to the --client-request form';
  }
  if (teamOps !== null) {
    // An up or down grant is the owner's form alone: it never rides a master grant, so a sub-grant
    // can never carry `up` or `down`, and it carries nothing but those for the one team it names.
    // `--up`, `--down` or both choose what the one record admits.
    const asked = teamOpFlags(teamOps);
    const label = teamGrantLabel(teamOps);
    if (args.flags.has('client-request')) return `${asked} belongs to the owner form: a sub-grant never carries ${teamOps.join(' or ')}`;
    if (args.values.team === undefined) return `${asked} needs --team <team>: a ${label} binds one team and its folder`;
    if (args.values.seat !== undefined) return `${asked} takes no --seat: a ${label} runs ${teamOps.map((op) => `team ${op}`).join(' and ')} for one team and addresses no seat`;
    if (args.flags.has('inbox')) return `${asked} takes no --inbox: a ${label} carries ${teamOps.join(' and ')} and nothing else`;
    if (args.flags.has('allow-grant') || MASTER_SCOPE_FLAGS.some((flag) => args.values[flag] !== undefined)) return `${asked} takes no --allow-grant: a ${label} never carries grant`;
    if (args.values.via !== undefined || args.values.key !== undefined) return '--via and --key belong to the --client-request form';
  }
  if (args.flags.has('client-request')) {
    if (args.values.via === undefined) return '--via <master-grant-file> is required with --client-request';
    if (args.values.key === undefined) return '--key <client-key> is required with --client-request';
    if (args.flags.has('allow-grant') || MASTER_SCOPE_FLAGS.some((flag) => args.values[flag] !== undefined)) {
      return '--allow-grant and the --grant-* scope flags belong to the owner form: a sub-grant never carries grant';
    }
    return null;
  }
  if (args.values.via !== undefined) return '--via belongs to the --client-request form';
  if (args.values.key !== undefined) return '--key belongs to the --client-request form';
  if (!args.flags.has('allow-grant') && MASTER_SCOPE_FLAGS.some((flag) => args.values[flag] !== undefined)) {
    return 'the --grant-entity, --grant-project and --grant-team scope flags need --allow-grant';
  }
  return null;
}

const MASTER_SCOPE_FLAGS = ['grant-entity', 'grant-project', 'grant-team'] as const;

/** The seat names the registry's roster holds for a team, or none when it is not registered. */
function readRosterSeats(home: string, teamId: string): string[] {
  try {
    return (readTeams(home)[teamId]?.roster ?? []).map((entry) => entry.seat);
  } catch {
    return [];
  }
}

function listOf(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(',').map((word) => word.trim()).filter((word) => word !== '');
}

/** The scope a master grant carries, from `--grant-entity`, `--grant-project` and `--grant-team`. */
export function masterScopeOf(args: Args): ClientGrantScope {
  return { entities: listOf(args.values['grant-entity']), projects: listOf(args.values['grant-project']), teams: listOf(args.values['grant-team']) };
}

/** The client form of `team grant`: owner-only, one fresh id per issuance, at most seven days. */
export function runClientGrantMode(rawIo: Io, io: Io, args: Args, json: boolean, home: string = homedir(), approval: GrantApprovalOptions = {}): 'ok' | 'refused' | 'invalid' {
  const problem = clientGrantProblem(args);
  if (problem !== null) {
    if (json) writeJsonError(rawIo, 'grant.invalid', plainText(problem), null);
    else io.stderr(`team grant: ${problem}\n`);
    return 'invalid';
  }
  // The client-request path is the one form that does not ask for the owner: its authority is the
  // owner-signed master grant it presents, checked whole before anything is written.
  if (args.flags.has('client-request')) return runClientGrantRequestMode(rawIo, io, args, json, home);
  // Under an entity's signed `grant-emission: conversational`, a pending request; refused otherwise.
  if (args.flags.has('request')) return runPendingGrantMode(rawIo, io, args, json, home, approval);
  if (!clientOwnerAllows('grant', rawIo, io, json, home)) return 'refused';
  const key = clientPublicInput(args.values['public-key']!, io.cwd);
  if (!key.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(key.why), null);
    else io.stderr(`team grant: ${key.why}\n`);
    return 'refused';
  }
  if (args.values.bundle !== undefined) return runDirectBundleGrantMode(rawIo, io, args, key.key, json, home, approval.now);
  if (teamOpsOfArgs(args) !== null) return runDirectUpGrantMode(rawIo, io, args, key.key, json, home);
  const result = writeClientGrant(home, {
    clientId: args.values.client!,
    entity: args.values.entity!,
    publicKey: key.key.publicKey,
    keyId: key.key.keyId,
    keyDir: key.key.keyDir,
    ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
    ...(args.flags.has('inbox') ? { inbox: true } : {}),
    ...(args.values.seat !== undefined ? { seat: args.values.seat } : {}),
    ...(args.values.team !== undefined ? { team: args.values.team } : {}),
    ...(args.flags.has('allow-grant') ? { grantScope: masterScopeOf(args) } : {}),
  });
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  if (json) {
    writeJson(io, 'team.grant', {
      format: 1 as const,
      dry_run: false,
      status: 'updated' as const,
      action_summary: 'grant: updated',
      project: null,
      session: null,
      target: result.grant.grantId,
    });
  } else {
    io.stdout(`grant: updated\nclient grant: ${result.grant.grantId}\nclient: ${result.grant.clientId}\nexpires: ${result.grant.expires}\ngrant file: ${result.path}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 'ok';
}

/** What a `--bundle` request resolves to: the live team's binding (its file's fingerprints only when
 *  `up` is an op, so a file edit before the answer never moves a bundle that does not start the
 *  team), the bundle's explicit ops under the policy in force, and the seats `send` reaches. */
export function bundleParamsOf(home: string, args: Args, now: Date, cwd: string): { ok: true; up: PendingUpBinding; bundle: BundleName; bundle_ops: BundleOp[]; bundle_seats: string[] } | { ok: false; why: string } {
  const bundle = args.values.bundle as BundleName;
  const entity = args.values.entity!;
  const target = resolveClientUpTarget(home, entity, args.values.team!, cwd);
  if (!target.ok) return target;
  const expanded = expandBundle(home, bundle, entity, projectIdOfTeam(home, target.binding.teamId), now);
  if (!expanded.ok) return expanded;
  const withUp = bundleSignsFile(bundle, expanded.ops);
  const up: PendingUpBinding = {
    project: target.binding.project,
    team_id: target.binding.teamId,
    root: target.binding.root,
    fingerprints: withUp ? target.binding.fingerprints : { sections: {}, seats: {} },
  };
  let seats: string[] = [];
  if (expanded.ops.includes('send')) {
    const named = listOf(args.values.seat);
    if (named.length > 0) {
      seats = named;
    } else {
      // No --seat: every seat the team admits this client that the registry's roster holds.
      const admitted = bundleSeatsAdmitted(home, target.binding.root, args.values.client!, entity);
      if (!admitted.ok) return admitted;
      const held = new Set(readRosterSeats(home, target.binding.teamId));
      seats = admitted.seats.filter((seat) => held.has(seat));
      if (seats.length === 0) return { ok: false, why: `the ${bundle} bundle carries send but no seat of team ${target.binding.project} is open to client ${args.values.client!}; name the seats with --seat <seat>[,<seat>]` };
    }
  } else if (args.values.seat !== undefined) {
    return { ok: false, why: `--seat names where send goes, and the ${bundle} bundle in force does not carry send` };
  }
  return { ok: true, up, bundle, bundle_ops: expanded.ops, bundle_seats: seats };
}

/** `team grant --client … --team <team> --bundle observer|operator|manager|developer`, at the owner's terminal. */
function runDirectBundleGrantMode(rawIo: Io, io: Io, args: Args, key: ClientPublicInput, json: boolean, home: string, at?: Date): 'ok' | 'refused' {
  const refuse = (why: string): 'refused' => {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(why), null);
    else io.stderr(`team grant: ${why}\n`);
    return 'refused';
  };
  const now = at ?? new Date();
  const params = bundleParamsOf(home, args, now, io.cwd);
  if (!params.ok) return refuse(params.why);
  const specs = expandBundle(home, params.bundle, args.values.entity!, projectIdOfTeam(home, params.up.team_id), now);
  if (!specs.ok) return refuse(specs.why);
  const result = writeClientBundleGrant(home, {
    clientId: args.values.client!,
    entity: args.values.entity!,
    publicKey: key.publicKey,
    keyId: key.keyId,
    keyDir: key.keyDir,
    bundle: params.bundle,
    ops: params.bundle_ops,
    seats: params.bundle_seats,
    ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
    up: { project: params.up.project, teamId: params.up.team_id, root: params.up.root, fingerprints: params.up.fingerprints },
    specs: specs.specs,
  }, { now });
  if (!result.ok) return refuse(result.why);
  const card = bundleCard({ clientId: result.grant.clientId, project: result.grant.up.project, ops: result.grant.ops, seats: result.grant.seats ?? [], expires: result.grant.expires });
  if (json) {
    writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: 'grant: updated', project: null, session: null, target: result.grant.grantId });
  } else {
    io.stdout(`grant: updated\nclient grant: ${result.grant.grantId}\nclient: ${result.grant.clientId}\nbundle: ${result.grant.bundle}\nops: ${result.grant.ops.join(', ')}\nteam: ${result.grant.up.project} at ${result.grant.up.root}\nexpires: ${result.grant.expires}\ncard: ${card}\ngrant file: ${result.path}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 'ok';
}

/** `team grant --client … --team <team> --up --down`, at the owner's terminal: binds one live team and writes the team grant. */
function runDirectUpGrantMode(rawIo: Io, io: Io, args: Args, key: ClientPublicInput, json: boolean, home: string): 'ok' | 'refused' {
  const refuse = (why: string): 'refused' => {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(why), null);
    else io.stderr(`team grant: ${why}\n`);
    return 'refused';
  };
  const target = resolveClientUpTarget(home, args.values.entity!, args.values.team!, io.cwd);
  if (!target.ok) return refuse(target.why);
  const result = writeClientUpGrant(home, {
    clientId: args.values.client!,
    entity: args.values.entity!,
    publicKey: key.publicKey,
    keyId: key.keyId,
    keyDir: key.keyDir,
    ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
    ops: teamOpsOfArgs(args) ?? ['up'],
    up: target.binding,
  });
  if (!result.ok) return refuse(result.why);
  if (json) {
    writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: 'grant: updated', project: null, session: null, target: result.grant.grantId });
  } else {
    io.stdout(`grant: updated\nclient grant: ${result.grant.grantId}\nclient: ${result.grant.clientId}\n${result.grant.ops.join(' and ')}: team ${result.grant.up.project} at ${result.grant.up.root}\nexpires: ${result.grant.expires}\ngrant file: ${result.path}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 'ok';
}

/**
 * `team grant --client-request`: a client holding an owner-issued master grant asks TeamCLI for a
 * sub-grant. No owner terminal is asked for; the request is signed with the master's app key and
 * admitted only inside the master's scope, ops and expiry ({@link verifyClientGrantIssue}). Under
 * the grant lock the master is re-read as in force, then the sub-grant is written by the same
 * issuer the owner path uses, naming its master, and an audit record is appended.
 */
export function runClientGrantRequestMode(rawIo: Io, io: Io, args: Args, json: boolean, home: string = homedir()): 'ok' | 'refused' | 'invalid' {
  const refuse = (why: string): 'refused' => {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(why), null);
    else io.stderr(`team grant: ${why}\n`);
    return 'refused';
  };
  const key = clientPublicInput(args.values['public-key']!, io.cwd);
  if (!key.ok) return refuse(key.why);
  const now = new Date();
  const admitted = verifyClientGrantIssue({
    home,
    masterFile: resolve(io.cwd, args.values.via!),
    keyFile: resolve(io.cwd, args.values.key!),
    clientId: args.values.client!,
    entity: args.values.entity!,
    team: args.values.team ?? null,
    seat: args.values.seat ?? null,
    publicKey: key.key.publicKey,
    keyId: key.key.keyId,
    keyDir: key.key.keyDir,
    expires: args.values.expires ?? null,
    inbox: args.flags.has('inbox'),
    now,
  });
  if (!admitted.ok) return refuse(admitted.why);
  let outcome: { ok: true; grantId: string; clientId: string; expires: string; path: string; audit: string } | { ok: false; why: string };
  try {
    outcome = withClientGrantLock(home, () => {
      const again = verifyClientGrantIssue({
        home,
        masterFile: resolve(io.cwd, args.values.via!),
        keyFile: resolve(io.cwd, args.values.key!),
        clientId: admitted.request.client_id,
        entity: admitted.request.entity,
        team: admitted.request.team,
        seat: admitted.request.seat,
        publicKey: admitted.request.public_key,
        keyId: admitted.request.key_id,
        keyDir: admitted.request.key_dir,
        expires: admitted.request.expires,
        inbox: admitted.request.inbox,
        now,
        requestId: admitted.request.request_id,
      });
      if (!again.ok) return { ok: false as const, why: again.why };
      const written = writeClientGrant(home, {
        clientId: again.request.client_id,
        entity: again.request.entity,
        publicKey: again.request.public_key,
        keyId: again.request.key_id,
        keyDir: again.request.key_dir,
        expires: again.expires,
        issuedBy: again.master.grantId,
        ...(again.request.inbox ? { inbox: true } : {}),
        ...(again.request.seat !== null ? { seat: again.request.seat } : {}),
        ...(again.request.team !== null ? { team: again.request.team } : {}),
      }, { now });
      if (!written.ok) return { ok: false as const, why: written.why };
      const audit = writeClientGrantAudit(home, {
        subGrantId: written.grant.grantId,
        masterGrantId: again.master.grantId,
        clientId: again.master.clientId,
        requestId: again.request.request_id,
        requestSignature: again.signature,
        at: now.toISOString(),
      });
      if (!audit.ok) return { ok: false as const, why: `${audit.why}; the sub-grant ${written.grant.grantId} was written at ${written.path} and the owner revokes it with team revoke` };
      return { ok: true as const, grantId: written.grant.grantId, clientId: written.grant.clientId, expires: written.grant.expires, path: written.path, audit: audit.path };
    });
  } catch {
    return refuse('the client grant lock could not be taken');
  }
  if (!outcome.ok) return refuse(outcome.why);
  if (json) {
    writeJson(io, 'team.grant', {
      format: 1 as const,
      dry_run: false,
      status: 'updated' as const,
      action_summary: 'grant: updated',
      project: null,
      session: null,
      target: outcome.grantId,
    });
  } else {
    io.stdout(`grant: updated\nclient grant: ${outcome.grantId}\nclient: ${outcome.clientId}\nissued by master grant: ${admitted.master.grantId}\nexpires: ${outcome.expires}\ngrant file: ${outcome.path}\naudit record: ${outcome.audit}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 'ok';
}

/** Test seams for the conversational path: the on-screen notifier and the clock. */
export type GrantApprovalOptions = { notify?: OwnerNotifier; now?: Date; ownerSeatStore?: OwnerSeatKeyStore };

/** `team grant --client … --request`: records a pending request; never writes a grant. */
export function runPendingGrantMode(rawIo: Io, io: Io, args: Args, json: boolean, home: string, approval: GrantApprovalOptions = {}): 'ok' | 'refused' | 'invalid' {
  const refuse = (why: string): 'refused' => {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(why), null);
    else io.stderr(`team grant: ${why}\n`);
    return 'refused';
  };
  const key = clientPublicInput(args.values['public-key']!, io.cwd);
  if (!key.ok) return refuse(key.why);
  const allow = args.flags.has('allow-grant');
  let up: PendingUpBinding | null = null;
  const teamOps = teamOpsOfArgs(args);
  if (teamOps !== null) {
    const target = resolveClientUpTarget(home, args.values.entity!, args.values.team!, io.cwd);
    if (!target.ok) return refuse(target.why);
    up = { project: target.binding.project, team_id: target.binding.teamId, root: target.binding.root, fingerprints: target.binding.fingerprints };
  }
  let bundled: ReturnType<typeof bundleParamsOf> | null = null;
  if (args.values.bundle !== undefined) {
    bundled = bundleParamsOf(home, args, approval.now ?? new Date(), io.cwd);
    if (!bundled.ok) return refuse(bundled.why);
    up = bundled.up;
  }
  const params: PendingGrantParams = {
    client_id: args.values.client!,
    entity: args.values.entity!,
    public_key: key.key.publicKey,
    key_id: key.key.keyId,
    key_dir: key.key.keyDir,
    team: args.values.team ?? null,
    seat: bundled !== null ? null : args.values.seat ?? null,
    expires: args.values.expires ?? null,
    inbox: args.flags.has('inbox'),
    allow_grant: allow,
    grant_scope: allow ? masterScopeOf(args) : null,
    ...(up !== null ? { up } : {}),
    ...(bundled !== null && bundled.ok ? { bundle: bundled.bundle, bundle_ops: bundled.bundle_ops, bundle_seats: bundled.bundle_seats } : {}),
    // Written only when it adds `down`: a request for an up grant is the request it always was.
    ...(up !== null && teamOps !== null && teamOps.join(',') !== 'up' ? { team_ops: teamOps } : {}),
  };
  const now = approval.now ?? new Date();
  const summary = pendingSummary(params, now);
  // A standing rule the owner approved ('always') covers a request fully inside it: no new ask.
  if (grantEmissionOf(home, params.entity, now).mode === 'conversational') {
    const rule = matchingApprovalRule(home, params, now);
    if (rule !== null) {
      const auto = autoApprovePendingGrant(home, params, rule, now);
      if (!auto.ok) return refuse(auto.why);
      if (json) {
        writeJson(io, 'team.grant', {
          format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: 'grant: updated',
          project: null, session: null, target: auto.grant.grantId, approved_by: 'standing-rule', rule_id: rule.rule_id, summary,
        });
      } else {
        io.stdout(`grant: updated\nclient grant: ${auto.grant.grantId}\napproved by: standing rule ${rule.rule_id}\nsummary: ${summary.text}\ngrant file: ${auto.path}\naudit record: ${auto.audit}\n${KEY_ISOLATION_LINE}\n`);
      }
      return 'ok';
    }
  }
  const created = createPendingGrant(home, params, {
    ...(approval.now !== undefined ? { now: approval.now } : {}),
    adapter: oneTimeCodeAdapter(...(approval.notify !== undefined ? [approval.notify] : [])),
  });
  if (!created.ok) return refuse(created.why);
  const id = created.record.request_id;
  const delivered = deliverToOwnerSeat(home, { request_id: id, params_sha256: created.record.params_sha256, text: confirmationLine(id, params, now).replace(/\(team grant --answer[^)]*\)/, `(team grant --approve-as-owner-seat ${id} <oui|always|non>)`), summary, at: now.toISOString() });
  const choices = GRANT_CHOICES.filter((choice) => !(choice === 'always' && (params.allow_grant || up !== null))).map((choice) => ({
    id: choice,
    label: choice === 'once' ? 'Yes, once' : choice === 'always' ? 'Always for this' : 'No',
    needs_code: choice !== 'deny',
    command: choice === 'deny' ? `team grant --deny ${id}` : `team grant --execute ${id} --approve ${choice} --code <code>`,
  }));
  if (json) {
    writeJson(io, 'team.grant', {
      format: 1 as const,
      dry_run: false,
      status: 'requested' as const,
      action_summary: 'grant: request recorded',
      project: null,
      session: null,
      target: id,
      request: { id, params_sha256: created.record.params_sha256, expires_at: created.record.expires_at, adapter: created.record.adapter },
      summary,
      choices,
      prompt: confirmationLine(id, params, now),
      answer_command: `team grant --answer ${id} <oui|always|non>`,
      owner_seat: delivered !== null ? { delivered: true, inbox: delivered, answer_command: `team grant --approve-as-owner-seat ${id} <oui|always|non>` } : { delivered: false },
    });
  } else {
    io.stdout(`grant: request recorded\nrequest: ${id}\nconfirmation: ${confirmationLine(id, params, now)}\nsummary: ${summary.text}\nparams sha256: ${created.record.params_sha256}\napproval: ${created.record.adapter} (shown to the owner on screen only)\nexpires: ${created.record.expires_at}\nchoices: ${choices.map((c) => c.id).join(' | ')}\n${choices.map((c) => `  ${c.id}: ${c.command}`).join('\n')}\n`);
  }
  return 'ok';
}

/** `team grant --execute <request-id> --code <code>`: writes the pending grant with an owner approval. */
export function runExecuteGrantMode(rawIo: Io, io: Io, args: Args, json: boolean, home: string, approval: GrantApprovalOptions = {}): 'ok' | 'refused' | 'invalid' {
  const refuse = (why: string): 'refused' => {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(why), null);
    else io.stderr(`team grant: ${why}\n`);
    return 'refused';
  };
  let params: PendingGrantParams | undefined;
  if (args.values['public-key'] !== undefined) {
    const key = clientPublicInput(args.values['public-key'], io.cwd);
    if (!key.ok) return refuse(key.why);
    const allow = args.flags.has('allow-grant');
    params = {
      client_id: args.values.client ?? '',
      entity: args.values.entity ?? '',
      public_key: key.key.publicKey,
      key_id: key.key.keyId,
      key_dir: key.key.keyDir,
      team: args.values.team ?? null,
      seat: args.values.seat ?? null,
      expires: args.values.expires ?? null,
      inbox: args.flags.has('inbox'),
      allow_grant: allow,
      grant_scope: allow ? masterScopeOf(args) : null,
    };
    const teamOps = teamOpsOfArgs(args);
    if (args.values.bundle !== undefined && isBundleName(args.values.bundle)) {
      const bundled = bundleParamsOf(home, args, approval.now ?? new Date(), io.cwd);
      if (!bundled.ok) return refuse(bundled.why);
      params = { ...params, seat: null, up: bundled.up, bundle: bundled.bundle, bundle_ops: bundled.bundle_ops, bundle_seats: bundled.bundle_seats };
    } else if (teamOps !== null) {
      const target = resolveClientUpTarget(home, params.entity, params.team ?? '', io.cwd);
      if (!target.ok) return refuse(target.why);
      params = {
        ...params,
        up: { project: target.binding.project, team_id: target.binding.teamId, root: target.binding.root, fingerprints: target.binding.fingerprints },
        ...(teamOps.join(',') !== 'up' ? { team_ops: teamOps } : {}),
      };
    }
  }
  const choice = args.values.approve ?? 'once';
  if (choice !== 'once' && choice !== 'always') return refuse(`--approve takes once or always, not "${choice}"; to refuse, team grant --deny <request-id>`);
  const result = executePendingGrant(home, {
    requestId: args.values.execute!,
    approve: choice,
    ...(args.values.code !== undefined ? { code: args.values.code } : {}),
    ...(params !== undefined ? { params } : {}),
  }, {
    ...(approval.now !== undefined ? { now: approval.now } : {}),
    ...(approval.ownerSeatStore !== undefined ? { ownerSeatStore: approval.ownerSeatStore } : {}),
  });
  if (!result.ok) return refuse(result.why);
  if (json) {
    writeJson(io, 'team.grant', {
      format: 1 as const,
      dry_run: false,
      status: 'updated' as const,
      action_summary: 'grant: updated',
      project: null,
      session: null,
      target: result.grant.grantId,
      approved_by: result.adapter,
      ...(result.ruleId !== undefined ? { rule_id: result.ruleId } : {}),
    });
  } else {
    io.stdout(`grant: updated\nclient grant: ${result.grant.grantId}\nclient: ${result.grant.clientId}\napproved by: ${result.adapter}${result.ruleId !== undefined ? `\nstanding rule: ${result.ruleId}` : ''}\nexpires: ${result.grant.expires}\ngrant file: ${result.path}\naudit record: ${result.audit}\n${KEY_ISOLATION_LINE}\n`);
  }
  return 'ok';
}

/** `team grant --answer <request-id> <oui|always|non>`: the owner's answer, owner-only. */
export function runAnswerGrantMode(rawIo: Io, io: Io, requestId: string, word: string, json: boolean, home: string, now: Date = new Date()): 'ok' | 'refused' | 'invalid' {
  if (!clientOwnerAllows('grant', rawIo, io, json, home)) return 'refused';
  const result = answerPendingGrant(home, requestId, word, now);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: `grant: answered ${result.choice}`, project: null, session: null, target: requestId });
  else io.stdout(`grant: answered ${result.choice}\nrequest: ${requestId}\nsummary: ${result.summary}\n`);
  return 'ok';
}

/** `team grant --add-owner-seat --team <team>`: owner-only; creates the key in the credential store. */
export function runAddOwnerSeatMode(rawIo: Io, io: Io, team: string, json: boolean, home: string, approval: GrantApprovalOptions = {}, args?: Args): 'ok' | 'refused' {
  if (!clientOwnerAllows('grant', rawIo, io, json, home)) return 'refused';
  if (args?.values.signer === undefined) {
    if (json) writeJsonError(rawIo, 'grant.refused', '--signer <name> is required: no signer is a default', null);
    else io.stderr('team grant: --signer <name> is required: no signer is a default\n');
    return 'refused';
  }
  const result = registerOwnerSeat(home, { team, signer: args.values.signer, ...(args.values.entity !== undefined ? { entity: args.values.entity } : {}) }, approval.ownerSeatStore ?? systemOwnerSeatKeyStore(), approval.now);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  const accepted = acceptOwnerSigner(home, result.record.entity, result.record.signers[0]!.name, approval.now);
  const acceptedLine = accepted.ok
    ? `owner-signers (entity ${result.record.entity}): ${accepted.names.join(', ')}`
    : `owner-signers not set (${accepted.why}); run: team policy set entity owner-signers ${result.record.signers[0]!.name} --entity ${result.record.entity}`;
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: 'grant: owner seat registered', project: null, session: null, target: `owner@${team}` });
  else io.stdout(`owner seat: registered owner@${team}\nsigner: ${result.record.signers[0]!.name} (mac-keystore; private key never leaves the credential store)\npublic key: ${result.record.signers[0]!.public_key}\nrecord: ${result.path}\n${acceptedLine}\n`);
  return 'ok';
}

/** `team grant --add-owner-signer --signer <name> --type <mac-keystore|webauthn> …`: owner-only. */
export function runAddOwnerSignerMode(rawIo: Io, io: Io, args: Args, json: boolean, home: string, approval: GrantApprovalOptions = {}): 'ok' | 'refused' {
  if (!clientOwnerAllows('grant', rawIo, io, json, home)) return 'refused';
  const type = args.values.type;
  const result = type !== 'mac-keystore' && type !== 'webauthn'
    ? { ok: false as const, why: '--type is mac-keystore or webauthn' }
    : addOwnerSigner(home, {
        signer: args.values.signer ?? '',
        type,
        ...(args.values['signer-public-key'] !== undefined ? { publicKey: args.values['signer-public-key'] } : {}),
        ...(args.values['credential-id'] !== undefined ? { credentialId: args.values['credential-id'] } : {}),
        ...(args.values['rp-id'] !== undefined ? { rpId: args.values['rp-id'] } : {}),
      }, approval.ownerSeatStore ?? systemOwnerSeatKeyStore(), approval.now);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  const seat = readOwnerSeat(home);
  const accepted = seat === null ? null : acceptOwnerSigner(home, seat.entity, result.signer.name, approval.now);
  const acceptedLine = accepted === null || seat === null ? '' : accepted.ok
    ? `owner-signers (entity ${seat.entity}): ${accepted.names.join(', ')}\n`
    : `owner-signers not updated (${accepted.why}); run: team policy set entity owner-signers <names> --entity ${seat.entity}\n`;
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: 'grant: owner signer added', project: null, session: null, target: result.signer.name });
  else io.stdout(`owner signer added: ${result.signer.name} (${result.signer.type})\n${acceptedLine}`);
  return 'ok';
}

/** Reads a passkey assertion file: { authenticator_data, client_data_json, signature } (base64url, base64url, hex DER). */
export function assertionFile(path: string | undefined, cwd: string): { authenticator_data: string; client_data_json: string; signature: string } | undefined {
  if (path === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resolve(cwd, path), 'utf8')) as Record<string, unknown>;
    if (typeof parsed.authenticator_data === 'string' && typeof parsed.client_data_json === 'string' && typeof parsed.signature === 'string') {
      return { authenticator_data: parsed.authenticator_data, client_data_json: parsed.client_data_json, signature: parsed.signature };
    }
  } catch {}
  return undefined;
}

/** `team grant --approve-as-owner-seat <id> <word>`: signed by the owner seat's key (user presence). */
export function runOwnerSeatApproveMode(rawIo: Io, io: Io, requestId: string, word: string, json: boolean, home: string, approval: GrantApprovalOptions = {}, args?: Args): 'ok' | 'refused' {
  const assertion = assertionFile(args?.values.assertion, io.cwd);
  const result = approveAsOwnerSeat(home, requestId, word, approval.ownerSeatStore ?? systemOwnerSeatKeyStore(), approval.now, {
    ...(args?.values.signer !== undefined ? { signer: args.values.signer } : {}),
    ...(assertion !== undefined ? { assertion } : {}),
    ...(args?.values.at !== undefined ? { at: args.values.at } : {}),
  });
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: `grant: owner seat answered ${result.choice}`, project: null, session: null, target: requestId });
  else io.stdout(`grant: owner seat answered ${result.choice}\nrequest: ${requestId}\nsummary: ${result.summary}\n`);
  return 'ok';
}

/** `team grant --owner-seat-inbox`: the confirmations waiting in the owner seat's inbox. */
export function runOwnerSeatInboxMode(io: Io, json: boolean, home: string): 'ok' {
  const messages = ownerSeatMessages(home);
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'unchanged' as const, action_summary: 'grant: owner seat inbox', project: null, session: null, target: 'owner-seat', rules: messages });
  else io.stdout(messages.length === 0 ? 'owner seat inbox: empty\n' : `${messages.map((m) => `${m.at}  ${m.text}`).join('\n')}\n`);
  return 'ok';
}

/** `team grant --deny <request-id>`: spends a pending request; anyone may, it only narrows. */
export function runDenyGrantMode(rawIo: Io, io: Io, requestId: string, json: boolean, home: string): 'ok' | 'refused' {
  const result = denyPendingGrant(home, requestId);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'denied' as const, action_summary: 'grant: denied', project: null, session: null, target: requestId });
  else io.stdout(`grant: denied\nrequest: ${requestId}\n`);
  return 'ok';
}

/** `team grant --approvals`: the standing rules that verify, and the ids of any that do not. */
export function runListApprovalsMode(io: Io, json: boolean, home: string): 'ok' {
  const listed = listApprovalRules(home);
  if (json) {
    writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'unchanged' as const, action_summary: 'grant: approvals listed', project: null, session: null, target: 'approvals', rules: listed.rules, ignored: listed.ignored });
  } else if (listed.rules.length === 0) {
    io.stdout(`approvals: none${listed.ignored.length > 0 ? `\nignored (do not verify): ${listed.ignored.join(', ')}` : ''}\n`);
  } else {
    io.stdout(`${listed.rules.map((r) => `${r.rule_id}  ${r.client_id} -> ${r.seats.join(',')}@${r.teams.join(',')} (entity ${r.entity})  ops ${r.ops.join(',')}  max ${String(r.max_duration_seconds)}s  by ${r.approved_by}  ${r.created}`).join('\n')}${listed.ignored.length > 0 ? `\nignored (do not verify): ${listed.ignored.join(', ')}` : ''}\n`);
  }
  return 'ok';
}

/** `team grant --revoke-approval <rule-id>`: removes one standing rule; anyone may. */
export function runRevokeApprovalMode(rawIo: Io, io: Io, ruleId: string, json: boolean, home: string): 'ok' | 'refused' {
  const result = revokeApprovalRule(home, ruleId);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'grant.refused', plainText(result.why), null);
    else io.stderr(`team grant: ${result.why}\n`);
    return 'refused';
  }
  if (json) writeJson(io, 'team.grant', { format: 1 as const, dry_run: false, status: 'updated' as const, action_summary: 'grant: approval revoked', project: null, session: null, target: ruleId });
  else io.stdout(`approval revoked: ${ruleId}\n`);
  return 'ok';
}

/** The client form of `team revoke`: owner-only, appended by grant id and never overwritten. */
export function runClientRevokeMode(rawIo: Io, io: Io, grantId: string, json: boolean, home: string = homedir()): 'ok' | 'refused' | 'invalid' {
  if (!CLIENT_GRANT_ID_PATTERN.test(grantId)) {
    if (json) writeJsonError(rawIo, 'revoke.invalid', plainText(`${JSON.stringify(grantId)} is not a client grant id`), null);
    else io.stderr(`team revoke: ${JSON.stringify(grantId)} is not a client grant id\n`);
    return 'invalid';
  }
  if (!clientOwnerAllows('revoke', rawIo, io, json, home)) return 'refused';
  const result = appendClientRevocation(home, grantId);
  if (!result.ok) {
    if (json) writeJsonError(rawIo, 'revoke.refused', plainText(result.why), null);
    else io.stderr(`team revoke: ${result.why}\n`);
    return 'refused';
  }
  if (json) {
    writeJson(io, 'team.revoke', {
      format: 1 as const,
      dry_run: false,
      status: 'updated' as const,
      action_summary: 'revoke: updated',
      project: null,
      session: null,
      target: result.record.grantId,
    });
  } else {
    io.stdout(`revoke: updated\nclient grant revoked: ${result.record.grantId}\nrevocation file: ${result.path}\n`);
  }
  return 'ok';
}
