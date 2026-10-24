// Client grant bundles, the half that reads the world: what a bundle expands to under the policy in
// force, the card the owner reads at signing, the audit lines, and the one `send` a bundle admits.
// The closed vocabulary and the defaults are in `bundle-ops.ts`; the record, its signature and its
// revocation are in `records.ts`; the up/down/status verification is `verifyClientUp` in
// `up-grant.ts` (a bundle is verified by the same code as the one-op team grants).

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadAndResolvePolicyChain } from '../policy/sources.ts';
import { getAgent } from '../registry/agents.ts';
import { readTeams } from '../registry/teams.ts';
import { logLine } from '../log.ts';
import { BUNDLE_OP_ROUTES, DEVELOPER_ONLY_OPS, MANAGER_ONLY_OPS, bundleSpecsFrom, defaultBundleSpecs, parseBundlePolicy, type BundleName, type BundleOp, type BundleSpecs } from './bundle-ops.ts';
import { bundleSeatsAdmitted, withClientGrantLock, type ClientUpGrantRecord } from './records.ts';
import { projectIdOfTeamId } from './grant-duration.ts';
import { claimClientRequest } from './replay.ts';
import { verifyClientUp } from './up-grant.ts';
import { CLIENT_REQUEST_ID_PATTERN } from './verify.ts';
import { writeClientDrop, type ResolvedClientTarget } from './send.ts';

/** The bundles in force for an entity (and, when the team sits in one, its project): the release
 *  defaults with the `client-bundles` policy laid over them. A policy chain that cannot be read or
 *  verified refuses rather than falling back to defaults that may be looser than the owner's word. */
export function bundleSpecsInForce(
  home: string,
  entity: string | null,
  projectId: string | null = null,
  now: Date = new Date(),
): { ok: true; specs: BundleSpecs } | { ok: false; why: string } {
  if (entity === null && projectId === null) return { ok: true, specs: defaultBundleSpecs() };
  let chain;
  try {
    chain = loadAndResolvePolicyChain({ home, ...(entity !== null ? { entity } : {}), projectId, teamRoot: null, team: null }, { now, upToLevel: 'project' });
  } catch {
    return { ok: false, why: 'the policy chain cannot be read, so the client-bundles policy is unknown' };
  }
  if (!chain.ok) return { ok: false, why: `the policy chain cannot be verified (${chain.refusals[0]?.message ?? 'refused'}), so the client-bundles policy is unknown` };
  const value = chain.policies['client-bundles']?.value;
  if (typeof value !== 'string') return { ok: true, specs: defaultBundleSpecs() };
  const parsed = parseBundlePolicy(value);
  if (!parsed.ok) return { ok: false, why: `the client-bundles policy does not read: ${parsed.why}` };
  return { ok: true, specs: bundleSpecsFrom(parsed.specs) };
}

/** A bundle as it expands at the request: the explicit op list the owner will sign, and its days. */
export function expandBundle(
  home: string,
  bundle: BundleName,
  entity: string,
  projectId: string | null = null,
  now: Date = new Date(),
): { ok: true; ops: BundleOp[]; expiryDays: number; specs: BundleSpecs } | { ok: false; why: string } {
  const specs = bundleSpecsInForce(home, entity, projectId, now);
  if (!specs.ok) return specs;
  const spec = specs.specs[bundle];
  return { ok: true, ops: [...spec.ops], expiryDays: spec.expiryDays, specs: specs.specs };
}

/** The project id the registry records for a team, or null (a team no project names is its own). */
export function projectIdOfTeam(home: string, teamId: string): string | null {
  return projectIdOfTeamId(home, teamId);
}

/** `grok-bot` as a person reads it: `Grok Bot`. */
export function clientDisplayName(clientId: string): string {
  return clientId.split('-').filter((word) => word !== '').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

const OP_PHRASES: Readonly<Record<BundleOp, (seats: readonly string[], file: string | null) => string>> = {
  status: () => 'see status',
  list: () => 'list the team',
  check: () => 'check the team',
  feed: () => 'read the feed',
  messages: () => 'read its messages',
  send: (seats) => `send to ${seats.length === 0 ? 'no seat' : seats.join(', ')}`,
  up: (_seats, file) => `start${file !== null ? ` (file ${file})` : ''}`,
  down: () => 'stop',
  seats: () => 'list its seats',
  seat: () => 'read one seat',
  sessions: () => 'list its sessions',
  usage: () => 'read usage',
  drops: () => 'read its drops',
  projects: () => 'list its projects',
  issues: () => 'read its issues',
  plan: () => 'read the plan',
  next: () => 'read what is next',
  brief: () => 'read the brief',
  watch: () => 'watch the team',
  doctor: () => 'run the doctor',
  commits: () => 'read its commits',
  reply: () => 'reply to messages',
  ack: () => 'acknowledge messages',
  'ask-show': () => 'show asks',
  restart: () => 'restart a seat',
  reload: () => 'reload a seat',
  add: () => 'add a seat',
  remove: () => 'remove a seat',
  rename: () => 'rename a seat',
  swap: () => 'swap a seat',
  pause: () => 'pause the team (seats finish their work; no new work starts until resume)',
  resume: () => 'resume the team',
  hold: () => 'hold and release the team',
  release: () => 'check a release',
  tempo: () => 'set the team tempo',
  queue: () => 'use the task queue',
  lock: () => 'lock a path',
  unlock: () => 'unlock a path',
  worktree: () => 'manage worktrees',
  raise: () => 'raise to the owner',
  route: () => "read a seat's route",
  pr: () => 'check a pull request',
  workflow: () => 'check workflows',
  proc: () => 'record processes',
};

/** What a bundle can never do, said once on every card: the invariant the exclusion list encodes. */
export const BUNDLE_CANNOT_LINE = 'It cannot change permissions, add or remove seats, or create teams.';

/** What a manager bundle can never do, said once on its card: it adds and removes seats, so the line
 *  says what stays the owner's instead. */
export const MANAGER_CANNOT_LINE = "It cannot change permissions, grant or revoke access, touch a human's seat or the orchestrator's seat, or create teams; a seat it adds or removes is the owner's to approve.";

/** What a developer bundle can never do, said once on its card: it does the manager's and more, and the
 *  owner's own commands stay the owner's. */
export const DEVELOPER_CANNOT_LINE = "It cannot change permissions, grant, revoke or delegate access, change policy or settings, answer for the owner, run the daemon, bus or broker, register or create teams or keys, touch a human's seat or the orchestrator's seat; a seat it adds or removes is the owner's to approve.";

/** `2027-01-21 09:00 UTC`: the expiry as the card reads it, with its zone. */
function cardTime(iso: string | null): string {
  if (iso === null) return 'revoked (no end date)';
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The text the owner reads at signing, one plain sentence per grant, built from the EXPLICIT ops. */
export function bundleCard(input: { clientId: string; project: string; ops: readonly BundleOp[]; seats: readonly string[]; expires: string | null; fileFingerprint?: string | null }): string {
  const what = input.ops.map((op) => OP_PHRASES[op](input.seats, input.fileFingerprint ?? null)).join(', ');
  const developed = input.ops.some((op) => (DEVELOPER_ONLY_OPS as readonly string[]).includes(op));
  const managed = developed || input.ops.some((op) => (MANAGER_ONLY_OPS as readonly string[]).includes(op));
  // A grant may list an op whose client route is not built yet: it admits nothing until then, and the
  // card says which, so the owner never signs for a power the client does not have.
  const unrouted = managed ? input.ops.filter((op) => !BUNDLE_OP_ROUTES[op]) : [];
  const later = unrouted.length > 0 ? ` Not usable yet in this build: ${unrouted.join(', ')}.` : '';
  return `${clientDisplayName(input.clientId)} may, for team ${input.project} until ${cardTime(input.expires)}: ${what}.${later} ${developed ? DEVELOPER_CANNOT_LINE : managed ? MANAGER_CANNOT_LINE : BUNDLE_CANNOT_LINE}`;
}

/** One audit line of a client's op, in the team's own log: `client-<op>-authorized` or `-refused`. */
export function auditClientOp(root: string, op: BundleOp, clientId: string, result: 'authorized' | 'refused', text: string, at: Date): void {
  logLine(join(root, '.agents'), op, `client:${clientId}`, `client-${op}-${result}: ${text}`, at);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The seat `send` reaches for a bundle grant: the signed team and seat, found by the registry id
 *  the grant binds, the roster's agent and its registered reach, never by a name alone. */
export function resolveBundleSendTarget(home: string, grant: ClientUpGrantRecord, seat: string): { ok: true; target: ResolvedClientTarget } | { ok: false; why: string } {
  if (!(grant.seats ?? []).includes(seat)) return { ok: false, why: `the grant ${grant.grantId} may send to ${(grant.seats ?? []).join(', ') || 'no seat'}, not "${seat}"` };
  const allowed = bundleSeatsAdmitted(home, grant.up.root, grant.clientId, grant.entity);
  if (!allowed.ok) return allowed;
  if (!allowed.seats.includes(seat)) return { ok: false, why: `the team no longer lets client ${grant.clientId} address "${seat}" (it may address ${allowed.seats.join(', ') || 'none'}); the grant never widens, so the owner re-signs after changing the team` };
  let teams;
  try {
    teams = readTeams(home);
  } catch {
    return { ok: false, why: 'the team registry cannot be read' };
  }
  const team = teams[grant.up.teamId];
  if (team === undefined || real(team.root) !== grant.up.root || team.project !== grant.up.project) return { ok: false, why: `the registry no longer names the team ${grant.up.project} at ${grant.up.root} that the grant ${grant.grantId} signs` };
  if (team.lifecycle === 'archived') return { ok: false, why: `team "${team.project}" is archived` };
  const held = team.roster.filter((entry) => entry.seat === seat);
  if (held.length !== 1) return { ok: false, why: `team "${team.project}" has no single roster seat "${seat}"` };
  const entry = held[0]!;
  let agent;
  try {
    agent = getAgent(home, entry.agent);
  } catch {
    return { ok: false, why: 'the agent registry cannot be read' };
  }
  if (agent === null) return { ok: false, why: `no registered agent carries the seat's id ${entry.agent}` };
  if (agent.reach.seat !== seat) return { ok: false, why: `agent ${agent.id} does not hold seat "${seat}"` };
  if (agent.reach.team !== grant.up.teamId) return { ok: false, why: `agent ${agent.id} is not recorded on team "${grant.up.teamId}"` };
  if (agent.lifecycle === 'retired') return { ok: false, why: `agent ${agent.id} is retired` };
  return {
    ok: true,
    target: {
      entity: grant.entity,
      recipientId: agent.id,
      recipientSeat: seat,
      teamId: grant.up.teamId,
      teamRoot: grant.up.root,
      session: team.session,
      dropDir: join(grant.up.root, '.agents', 'send-drops', team.session, seat),
    },
  };
}

/** The rule line a bundle's drop carries. */
export const BUNDLE_SEND_RULE = 'a client bundle grant, to a granted seat';

/**
 * `team send --client <bundle-grant> --key <key> <seat>@<team> <text>`: verified end to end (the
 * grant carries `send`, the key is its own, the grant is canonical, unexpired and unrevoked, the
 * team is the one signed), the seat is one the grant names and the team still admits, and one
 * signed drop is written. The whole check and the write sit under the grant lock, so a revocation
 * appended at that moment is seen. The audit line is written under the same lock.
 */
export function sendWithBundle(
  host: { home: string; now: () => Date; sendId?: () => string; clientLockWaitMs?: number },
  input: { grantFile: string; keyFile: string; cwd: string; address: string; body: string; requestId?: string },
): { ok: true; to: string; id: string; requestId: string } | { ok: false; why: string } {
  try {
    return withClientGrantLock(
      host.home,
      () => {
        const now = host.now();
        const requestId = input.requestId;
        if (requestId !== undefined && !CLIENT_REQUEST_ID_PATTERN.test(requestId)) return { ok: false as const, why: `"${requestId}" is not a request id` };
        const verified = verifyClientUp({ home: host.home, grantFile: input.grantFile, keyFile: input.keyFile, cwd: input.cwd, now, op: 'send' });
        if (!verified.ok) {
          if (verified.identified !== null) auditClientOp(verified.identified.up.root, 'send', verified.identified.clientId, 'refused', `grant ${verified.identified.grantId}: ${verified.why}`, now);
          return { ok: false as const, why: verified.why };
        }
        const grant = verified.grant;
        const refuse = (why: string) => {
          auditClientOp(grant.up.root, 'send', grant.clientId, 'refused', `grant ${grant.grantId}: ${why}`, now);
          return { ok: false as const, why };
        };
        const at = input.address.indexOf('@');
        const seat = at < 0 ? input.address : input.address.slice(0, at);
        const team = at < 0 ? null : input.address.slice(at + 1);
        if (team === null || seat === '' || team === '') return refuse(`"${input.address}" is not <seat>@<team>; the grant is for team ${grant.up.project}`);
        if (team !== grant.up.project) return refuse(`the grant ${grant.grantId} is for team ${grant.up.project}, not "${team}"`);
        const resolved = resolveBundleSendTarget(host.home, grant, seat);
        if (!resolved.ok) return refuse(resolved.why);
        const id = requestId ?? verified.requestId;
        const claim = claimClientRequest(grant.up.root, grant.clientId, id, now);
        if (!claim.ok) return refuse(claim.why);
        const written = writeClientDrop({ home: host.home, grant: { clientId: grant.clientId, grantId: grant.grantId }, target: resolved.target, body: input.body, now, id: host.sendId?.(), rule: BUNDLE_SEND_RULE });
        if (!written.ok) return refuse(written.why);
        auditClientOp(grant.up.root, 'send', grant.clientId, 'authorized', `grant ${grant.grantId} client ${grant.clientId} team ${grant.up.project} seat ${seat} drop ${written.id} request ${id}`, now);
        return { ok: true as const, to: `${seat}@${grant.up.project}`, id: written.id, requestId: id };
      },
      host.clientLockWaitMs,
    );
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : 'the client grant lock could not be taken' };
  }
}
