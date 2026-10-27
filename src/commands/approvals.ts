// `team approvals`: the owner-seat always rules, listed and revoked.
//
// `team init --revoke-approval` removes a team-create rule only. This command lists both kinds
// and revokes either by id. Listing is a read. Revoking removes a rule the owner already gave;
// it does not grant, and it does not change owner-signers or approval-mode. The owner at a
// terminal revokes, or the owner seat signs a `team-revoke-approval` answer for that id.

import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { listOwnerActionRules, OWNER_ACTION_ID_PATTERN, revokeOwnerActionRule } from '../client/owner-action.ts';
import { ownerSeatRuleAdmits, ownerSeatStep } from '../client/owner-action-step.ts';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { actionApprovalsFolder, listTeamCreateRules, revokeTeamCreateRule, TEAM_CREATE_ID_PATTERN } from '../client/team-create.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { hasJsonFlag } from '../output/index.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = `Usage: team approvals list [--json]
       team approvals revoke <id...> [--json]
       team approvals revoke <id...> --request [--json]
       team approvals revoke <id...> --approval <request-id> [--json]

Lists the owner seat's always rules — team-create (tc_…) and owner-action (oa_…) — or removes
every id in the one command. Listing reads the owner's folder and changes nothing. Revoking is
the owner's, from a terminal outside herdr, or an owner-seat answer for that revoke: --request
records every id as one request and --approval <request-id> runs it once the owner has answered
on the owner page. One card and one Touch ID cover the whole list. A signed always rule for
team-revoke-approval covering this folder admits the revoke with no request. A bad id revokes
nothing.

Exits 0 when the rules are listed, the rules are revoked, or a request is recorded, 1 when the
revoke is refused, 2 when the invocation can't be read.
`;

export type ApprovalsSources = { home?: string; now?: () => Date; ownerSeatStore?: OwnerSeatKeyStore };

export const approvals: Command = (argv, io) => runApprovals(argv, io);
export default approvals;

export async function runApprovals(argv: string[], io: Io, sources: ApprovalsSources = {}): Promise<number> {
  const args = readArgs(argv, ['approval'], ['json', 'request']);
  const json = hasJsonFlag(argv);
  const verb = args.rest[0];
  if (args.error || (verb !== 'list' && verb !== 'revoke') || (verb === 'list' && args.rest.length !== 1) || (verb === 'revoke' && args.rest.length < 2)) {
    const why = args.error ?? (verb === undefined ? 'a verb is required: list or revoke' : verb === 'revoke' ? 'an id is required' : `unexpected "${args.rest[args.rest.length - 1]}"`);
    io.stderr(`team approvals: ${why}\n${USAGE}`);
    // exit: approvals.invocation
    return 2;
  }
  const home = sources.home ?? homedir();
  const now = sources.now?.() ?? new Date();
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  if (verb === 'list') {
    const created = listTeamCreateRules(home, store, now);
    const actions = listOwnerActionRules(home, store, now);
    const rules = [
      ...created.rules.map((rule) => ({ id: rule.rule_id, kind: 'team-create' as const, scope: rule.scope, signer: rule.signer, created: rule.created })),
      ...actions.rules.map((rule) => ({ id: rule.rule_id, kind: 'owner-action' as const, actions: rule.actions, scope: rule.scope, team: rule.team, signer: rule.signer, created: rule.created })),
    ];
    if (json) io.stdout(`${JSON.stringify({ format: 1, rules })}\n`);
    else if (rules.length === 0) io.stdout('team approvals: no always rules\n');
    else for (const rule of rules) io.stdout(`${rule.id}  ${rule.kind}  ${rule.scope}\n`);
    // exit: approvals.listed
    return 0;
  }
  const ids = args.rest.slice(1);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) return refused(io, json, `"${repeated}" is repeated; nothing was revoked`);
  const seatSources = { home, now: () => now, ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) };
  let seatApproved = false;
  let seatRefused = false;
  if (!args.flags.has('request') && args.values.approval === undefined) {
    const covered = ownerSeatStep('approvals', 'team-revoke-approval', argv, { request: false, approval: undefined, dry: false, json }, io, seatSources);
    if (covered.kind === 'refused') seatRefused = true;
    else if (covered.kind === 'admitted') seatApproved = true;
  }
  if (!seatRefused && (args.flags.has('request') || args.values.approval !== undefined)) {
    // Check every id before the approval is claimed. A dry look admits nothing.
    if (args.values.approval !== undefined) {
      const preview = ownerSeatStep('approvals', 'team-revoke-approval', argv, { request: false, approval: args.values.approval, dry: true, json }, io, seatSources);
      if (preview.kind === 'refused') seatRefused = true;
      else {
        const ready = rulesReady(home, ids);
        if (!ready.ok) return refused(io, json, `${ready.why}; nothing was revoked`);
      }
    }
    if (!seatRefused) {
      const seat = ownerSeatStep('approvals', 'team-revoke-approval', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json }, io, seatSources);
      if (seat.kind === 'requested') {
        // exit: approvals.approval-requested
        return 0;
      }
      if (seat.kind === 'refused') seatRefused = true;
      else seatApproved = seat.kind === 'admitted';
    }
  }
  if (seatRefused) {
    // exit: approvals.approval-refused
    return 1;
  }
  const caller = callerOf(io);
  if (!seatApproved && !isOwner(caller)) seatApproved = ownerSeatRuleAdmits('team-revoke-approval', io.cwd, false, seatSources);
  if (!seatApproved) {
    const detached = detachedRefusal(caller, { who: 'the owner', where: 'a terminal outside herdr' });
    if (detached !== undefined) return refused(io, json, detached);
    if (!isOwner(caller)) return refused(io, json, `only the owner revokes an approval rule, from a terminal outside herdr; this call is ${describeCaller(caller)}`);
  }
  if (args.values.approval === undefined) {
    const ready = rulesReady(home, ids);
    if (!ready.ok) return refused(io, json, `${ready.why}; nothing was revoked`);
  }
  for (const id of ids) {
    const revoked = id.startsWith('tc_') ? revokeTeamCreateRule(home, id) : revokeOwnerActionRule(home, id);
    if (!revoked.ok) return refused(io, json, revoked.why);
  }
  if (json) io.stdout(`${JSON.stringify({ format: 1, revoked: ids })}\n`);
  else io.stdout(`team approvals: revoked ${ids.join(', ')}\n`);
  // exit: approvals.revoked
  return 0;
}

/** Every id is one rule file. Nothing is unlinked here. */
function rulesReady(home: string, ids: string[]): { ok: true } | { ok: false; why: string } {
  for (const id of ids) {
    const teamCreate = TEAM_CREATE_ID_PATTERN.test(id);
    const ownerAction = OWNER_ACTION_ID_PATTERN.test(id);
    if (!teamCreate && !ownerAction) return { ok: false, why: `"${id}" is not an approval rule id` };
    try {
      if (!lstatSync(join(actionApprovalsFolder(home), `${id}.json`)).isFile()) throw new Error('kind');
    } catch {
      return { ok: false, why: teamCreate ? `no team-create rule ${id}` : `no owner-action rule ${id}` };
    }
  }
  return { ok: true };
}

function refused(io: Io, json: boolean, message: string): number {
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'refused', message })}\n`);
  else io.stderr(`team approvals: ${message}\n`);
  // exit: approvals.refused
  return 1;
}
