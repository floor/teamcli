// The `--client <grant> --key <key>` form of a bundle op, one place for every command that has one.
//
// A command with a client form does three things with this module and nothing else of its own:
//
// 1. `clientFormProblem`: the invocation rules every client form shares (the grant and the key come
//    together, `--team` only names the one team the grant is for, and nothing that aims elsewhere
//    rides with it: each command adds its own).
// 2. `verifyClientForm`: the grant is verified whole, before anything is read, by `verifyClientUp`: the
//    grant is the owner's (signature, canonical record, vocabulary), the key is the grant's own, the
//    grant carries THIS op, is unexpired and unrevoked, and the team named (or this folder) is the one
//    team, at the one root, under the one registry id the owner signed. A refusal for a client the key
//    identified goes on the team's own log; a grant that did not verify identifies no one.
// 3. `authorizeClientRun`: the grant is read once more under the grant lock immediately before the
//    run's first effect, and the run's audit line is written while the lock is held, so a revocation
//    is either seen by this run or ordered after it.
//
// The run is then the grant's folder alone and never the owner's: the command passes no owner gate
// by this, it opens its own second door for the verified run, exactly as `team down --client` does.

import { resolve } from 'node:path';
import type { BundleOp } from './bundle-ops.ts';
import { auditClientOp } from './bundles.ts';
import { activeClientUpGrant, withClientGrantLock, type ClientUpGrantRecord } from './records.ts';
import { verifyClientUp } from './up-grant.ts';

/** One verified client run: the grant as the owner signed it, its signature (for the re-read under
 *  the lock), the request id this run minted, and the one folder it runs in. */
export type ClientRun = { grant: ClientUpGrantRecord; signature: string; requestId: string; root: string };

/** The options every client form adds to a command's own. */
export const CLIENT_FORM_OPTIONS = ['client', 'key', 'team'] as const;

/** The invocation problems every client form shares, or null. `usage` is the form's own spelling
 *  (`team seats --client <grant-file> --key <client-key-file>`), so each sentence says what to type. */
export function clientFormProblem(values: Readonly<Record<string, string | undefined>>, usage: string): string | null {
  const client = values.client !== undefined;
  if (client && values.key === undefined) return '--client needs --key <client-key-file>';
  if (!client && values.key !== undefined) return `--key belongs to the --client form: ${usage}`;
  if (!client && values.team !== undefined) return `--team belongs to the --client form: ${usage} --team <team>`;
  return null;
}

/** Verifies one client invocation of `op` end to end. `cwd` is where the caller stands (the grant
 *  names its folder, so it is only checked against a mix-up). */
export function verifyClientForm(
  host: { home: string; now: Date },
  input: { op: BundleOp; values: Readonly<Record<string, string | undefined>>; cwd: string },
): { ok: true; run: ClientRun } | { ok: false; why: string; named: ClientUpGrantRecord | null } {
  const verified = verifyClientUp({
    home: host.home,
    grantFile: resolve(input.cwd, input.values.client!),
    keyFile: resolve(input.cwd, input.values.key!),
    cwd: input.cwd,
    ...(input.values.team !== undefined ? { team: input.values.team } : {}),
    now: host.now,
    op: input.op,
  });
  if (!verified.ok) return { ok: false, why: verified.why, named: verified.identified };
  return { ok: true, run: { grant: verified.grant, signature: verified.signature, requestId: verified.requestId, root: verified.root } };
}

/** The client form's whole entrance for a command that has no gate of its own to keep: the grant is
 *  verified for `op` (see `verifyClientForm`), and a refusal of a client the key identified goes on the
 *  team's own log. `ok: false` carries the sentence to print. */
export function enterClientForm(
  host: { home: string; now: Date },
  input: { op: BundleOp; values: Readonly<Record<string, string | undefined>>; cwd: string },
): { ok: true; run: ClientRun } | { ok: false; why: string } {
  const verified = verifyClientForm(host, input);
  if (verified.ok) return verified;
  auditClientRefusal(input.op, verified.named, verified.why, host.now);
  return { ok: false, why: verified.why };
}

/** The line a client run prints on stderr once its grant verified: which grant, which client, which team. */
export function clientBanner(run: ClientRun): string {
  return `client grant ${run.grant.grantId}: ${run.grant.clientId} for team ${run.grant.up.project} at ${run.root}, until ${run.grant.expires}`;
}

/** `client:<id>`: how a client run is named in a team's own log and state. */
export function clientActor(run: ClientRun): string {
  return `client:${run.grant.clientId}`;
}

/**
 * The sentence a roster-changing client run (`add`, `remove`) ends with: the change is the owner's to
 * approve with the owner seat, and the approval record was not touched. An added seat is a new seat to the
 * signed fingerprints, so `up --client` for this team stops until the owner signs a fresh manager or developer grant;
 * a removed seat is no difference to them, so nothing else stops.
 */
export function rosterApprovalText(op: 'add' | 'remove', seat: string, run: ClientRun): string {
  const verb = op === 'add' ? `added ${seat} to` : `removed ${seat} from`;
  const bundle = run.grant.bundle === 'developer' ? 'developer' : 'manager';
  const base = `client grant ${run.grant.grantId} ${verb} the team file: the roster change is for the owner to approve with the owner seat; the approval record was not changed`;
  return op === 'add'
    ? `${base}. \`up --client\` for this team stops until the owner signs a fresh ${bundle} grant for it (team grant --client ${run.grant.clientId} --entity <entity> --public-key <file> --team ${run.grant.up.project} --bundle ${bundle} --request, answered on the owner seat)`
    : base;
}

/** The refusal of a client the key identified, on the team's own log: `client-<op>-refused`. */
export function auditClientRefusal(op: BundleOp, named: ClientUpGrantRecord | null, why: string, at: Date): void {
  if (named !== null) auditClientOp(named.up.root, op, named.clientId, 'refused', `grant ${named.grantId}: ${why}`, at);
}

/** The audit text of an authorized run, one line, with the grant, the client, the team and the request. */
export function authorizedText(run: ClientRun, extra = ''): string {
  return `grant ${run.grant.grantId} client ${run.grant.clientId} team ${run.grant.up.project} root ${run.root} request ${run.requestId}${extra === '' ? '' : ` ${extra}`}`;
}

/**
 * The grant read once more under its lock, immediately before the run's first effect: a revocation
 * appended since the check at the top stops this run here, and a run that passes writes its audit
 * line while it still holds the lock. Returns the reason the grant no longer stands, or null.
 */
export function authorizeClientRun(home: string, run: ClientRun, op: BundleOp, at: Date, extra = ''): string | null {
  try {
    return withClientGrantLock(home, () => {
      const still = activeClientUpGrant(home, { grant: run.grant, signature: run.signature }, at);
      if (!still.ok) return still.why;
      auditClientOp(run.root, op, run.grant.clientId, 'authorized', authorizedText(run, extra), at);
      return null;
    });
  } catch {
    return 'the client grant lock could not be taken';
  }
}
