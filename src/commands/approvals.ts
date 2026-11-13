// `team approvals`: the owner-seat always rules, listed and revoked; and owner requests carried as
// files between a machine whose owner seat is pinned and the machine that holds the signers.
//
// `team init --revoke-approval` removes a team-create rule only. This command lists both kinds
// and revokes either by id. Listing is a read. Revoking removes a rule the owner already gave;
// it does not grant, and it does not change owner-signers or approval-mode. The owner at a
// terminal revokes, or the owner seat signs a `team-revoke-approval` answer for that id.
//
// `export`, `sign` and `answer` carry one owner-action request and its answer
// (src/client/owner-carry.ts). None of them admits anything: the answer is the owner's signature,
// and the command it approves runs with `--approval <id>` and is checked again there.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { canonicalScope } from '../client/emission.ts';
import { ownerActionDetails, teamCreateDetails } from '../client/approval-card.ts';
import { approveOwnerAction, listOwnerActionRules, OWNER_ACTION_ID_PATTERN, readOwnerActionRecord, revokeOwnerActionRule } from '../client/owner-action.ts';
import { ownerAdmitsRecord, ownerSeatStep } from '../client/owner-action-step.ts';
import { acceptCarriedAnswer, ownerRequestFile, readCarriedFile, readOwnerRequestFile, signCarriedRequest, writeCarriedFile } from '../client/owner-carry.ts';
import { fingerprintText, localOwnerSeatFingerprint } from '../client/owner-pin.ts';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { actionApprovalsFolder, actionAuditFolder, listTeamCreateRules, readTeamCreateRecord, revokeTeamCreateRule, TEAM_CREATE_ID_PATTERN } from '../client/team-create.ts';
import { describeCaller, detachedRefusal } from '../caller.ts';
import { hasJsonFlag } from '../output/index.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = `Usage: team approvals list [--json]
       team approvals details <id> [--json]
       team approvals revoke <id...> [--json]
       team approvals revoke <id...> --request [--reason <text>] [--json]
       team approvals revoke <id...> --approval <request-id> [--json]
       team approvals export <id> --out <file> [--json]
       team approvals sign --from <file> --out <file> [--answer <oui|always|non>] [--signer <name>] [--assertion <file>] [--json]
       team approvals answer --from <file> [--json]

Lists the owner seat's always rules — team-create (tc_…) and owner-action (oa_…) — or removes
every id in the one command. Listing reads the owner's folder and changes nothing. Details prints
one request's full record — request id, repository, HEAD, bound arguments, hashes — and the audit
entries written for it; the card the owner answers never carries them. Revoking is the owner's,
from a terminal outside the terminal host, or an owner-seat answer for that revoke: --request records every
id as one request (--reason <text> is the short reason the card shows) and --approval <request-id> runs it once the owner has answered on the owner
page. One card and one Touch ID cover the whole list. A signed always rule for
team-revoke-approval covering the folder of every rule named admits the revoke with no request. A bad id revokes
nothing.

On a machine whose owner seat is pinned from another machine, owner requests travel as files.
Export writes one waiting request of this machine to a file. Sign, on the machine that holds
the owner's signers, records that request, shows its card (signed at once with --answer, or on
the owner page) and writes the signed answer to a file. Answer, back on the pinned machine, checks that
answer against the pinned owner seat and records it; the command then runs with --approval <id>.

Exits 0 when the rules are listed, the details are printed, the rules are revoked, a request
is recorded, a file is written or an answer is recorded, 1 when the details, the revoke or a
carried file are refused, 2 when the invocation can't be read.
`;

export type ApprovalsSources = { home?: string; now?: () => Date; ownerSeatStore?: OwnerSeatKeyStore };

export const approvals: Command = (argv, io) => runApprovals(argv, io);
export default approvals;

export async function runApprovals(argv: string[], io: Io, sources: ApprovalsSources = {}): Promise<number> {
  const args = readArgs(argv, ['approval', 'reason', 'from', 'out', 'answer', 'signer', 'assertion'], ['json', 'request']);
  const json = hasJsonFlag(argv);
  const verb = args.rest[0];
  const carried = verb === 'export' || verb === 'sign' || verb === 'answer';
  const verbs = verb === 'list' || verb === 'revoke' || verb === 'details' || carried;
  const misplaced = verbs ? misplacedOption(verb, args) : undefined;
  if (args.error || !verbs || misplaced !== undefined || (verb === 'list' && args.rest.length !== 1) || (verb === 'details' && args.rest.length !== 2) || (verb === 'revoke' && args.rest.length < 2)
    || (verb === 'export' && args.rest.length !== 2) || ((verb === 'sign' || verb === 'answer') && args.rest.length !== 1)) {
    const why = args.error ?? misplaced ?? (verb === undefined ? 'a verb is required: list, details, revoke, export, sign or answer'
      : verb === 'revoke' || verb === 'export' ? (args.rest.length < 2 ? 'an id is required' : `unexpected "${args.rest[args.rest.length - 1]}"`)
        : verb === 'details' && args.rest.length < 2 ? 'an id is required' : `unexpected "${args.rest[args.rest.length - 1]}"`);
    io.stderr(`team approvals: ${why}\n${USAGE}`);
    // exit: approvals.invocation
    return 2;
  }
  const home = sources.home ?? homedir();
  const now = sources.now?.() ?? new Date();
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  if (verb === 'export') return exportRequest(io, json, home, now, store, args.rest[1]!, args.values.out!);
  if (verb === 'sign') return signRequest(io, json, home, now, store, args.values);
  if (verb === 'answer') return answerRequest(io, json, home, now, store, args.values.from!);
  if (verb === 'details') {
    const id = args.rest[1]!;
    const teamCreate = TEAM_CREATE_ID_PATTERN.test(id);
    const ownerAction = OWNER_ACTION_ID_PATTERN.test(id);
    if (!teamCreate && !ownerAction) return refused(io, json, `"${id}" is not an owner-seat request id`);
    let request: unknown;
    let lines: string[];
    if (teamCreate) {
      const record = readTeamCreateRecord(home, id);
      if (typeof record === 'string') return refused(io, json, record);
      request = record;
      lines = teamCreateDetails(record);
    } else {
      const record = readOwnerActionRecord(home, id);
      if (typeof record === 'string') return refused(io, json, record);
      request = record;
      lines = ownerActionDetails(record);
    }
    const audit = auditNames(home, id);
    if (json) io.stdout(`${JSON.stringify({ format: 1, request, audit })}\n`);
    else io.stdout(`${lines.join('\n')}\n${audit.map((name) => `audit ${name}`).join('\n')}${audit.length > 0 ? '\n' : ''}`);
    // exit: approvals.details
    return 0;
  }
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
  // The charter judges each rule's own folder. An id that does not resolve names no folder, so
  // the charter does not admit the run.
  const placed = recordFolders(home, store, now, ids);
  const targets = placed.ok ? placed.folders : [];
  let seatApproved = false;
  let seatRefused = false;
  if (!args.flags.has('request') && args.values.approval === undefined) {
    const covered = ownerSeatStep('approvals', 'team-revoke-approval', argv, { request: false, approval: undefined, dry: false, json }, io, seatSources, targets);
    if (covered.kind === 'refused') seatRefused = true;
    else if (covered.kind === 'admitted') seatApproved = true;
  }
  if (!seatRefused && (args.flags.has('request') || args.values.approval !== undefined)) {
    // Check every id before the approval is claimed. A dry look admits nothing.
    if (args.values.approval !== undefined) {
      const preview = ownerSeatStep('approvals', 'team-revoke-approval', argv, { request: false, approval: args.values.approval, dry: true, json }, io, seatSources, targets);
      if (preview.kind === 'refused') seatRefused = true;
      else {
        const ready = rulesReady(home, ids);
        if (!ready.ok) return refused(io, json, `${ready.why}; nothing was revoked`);
      }
    }
    if (!seatRefused) {
      const seat = ownerSeatStep('approvals', 'team-revoke-approval', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json, reason: args.values.reason }, io, seatSources, targets);
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
  if (!seatApproved) {
    const gate = recordGate(io, home, now, store, ids, seatSources);
    if (gate.kind === 'refused') return refused(io, json, gate.why);
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

/** The options the carrying verbs take. The older verbs keep reading theirs as before, and none of
 *  these. A required option missing, or one given to a verb that does not take it, is an invocation
 *  error. */
const CARRY_OPTIONS: Record<'export' | 'sign' | 'answer', { takes: string[]; required: string[] }> = {
  export: { takes: ['out'], required: ['out'] },
  sign: { takes: ['from', 'out', 'answer', 'signer', 'assertion'], required: ['from', 'out'] },
  answer: { takes: ['from'], required: ['from'] },
};
const CARRY_ONLY = ['from', 'out', 'answer', 'signer', 'assertion'];

function misplacedOption(verb: string, args: ReturnType<typeof readArgs>): string | undefined {
  const given = Object.keys(args.values);
  if (verb === 'export' || verb === 'sign' || verb === 'answer') {
    const spec = CARRY_OPTIONS[verb];
    const stray = [...given.filter((name) => !spec.takes.includes(name)), ...(args.flags.has('request') ? ['request'] : [])][0];
    if (stray !== undefined) return `--${stray} does not belong to ${verb}`;
    const missing = spec.required.find((name) => args.values[name] === undefined);
    if (missing !== undefined) return `${verb} needs --${missing} <file>`;
    return undefined;
  }
  const stray = given.find((name) => CARRY_ONLY.includes(name));
  if (stray !== undefined) return `--${stray} belongs to export, sign or answer`;
  return undefined;
}

function assertionOf(path: string | undefined, cwd: string): { authenticator_data: string; client_data_json: string; signature: string } | undefined | 'unreadable' {
  if (path === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resolve(cwd, path), 'utf8')) as Record<string, unknown>;
    if (typeof parsed.authenticator_data === 'string' && typeof parsed.client_data_json === 'string' && typeof parsed.signature === 'string') {
      return { authenticator_data: parsed.authenticator_data, client_data_json: parsed.client_data_json, signature: parsed.signature };
    }
  } catch {}
  return 'unreadable';
}

/** On a machine whose owner seat is pinned: one waiting request of this machine, written to a file. */
function exportRequest(io: Io, json: boolean, home: string, now: Date, store: OwnerSeatKeyStore, id: string, out: string): number {
  const made = ownerRequestFile(home, id, store, now);
  if (!made.ok) return refused(io, json, made.why);
  const written = writeCarriedFile(io.cwd, out, made.file);
  if (!written.ok) return refused(io, json, written.why);
  const fingerprint = fingerprintText(made.file.owner_seat);
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'exported', request_id: id, file: written.path, machine: made.file.machine, owner_seat: fingerprint, expires_at: made.file.request.expires_at })}\n`);
  else io.stdout(`team approvals: request ${id} of machine ${made.file.machine.name} written to ${written.path}\nit expires ${made.file.request.expires_at ?? 'never'}; on the machine that holds the owner's signers run: team approvals sign --from <file> --out <answer file>\n`);
  // exit: approvals.exported
  return 0;
}

/** On the machine that holds the owner's signers: record a carried request, sign it, write the answer file. */
function signRequest(io: Io, json: boolean, home: string, now: Date, store: OwnerSeatKeyStore, values: Record<string, string>): number {
  const read = readCarriedFile(io.cwd, values.from!);
  if (!read.ok) return refused(io, json, read.why);
  const file = readOwnerRequestFile(read.value);
  if (!file.ok) return refused(io, json, file.why);
  const assertion = assertionOf(values.assertion, io.cwd);
  if (assertion === 'unreadable') return refused(io, json, `${values.assertion} is not a passkey assertion (authenticator_data, client_data_json, signature)`);
  const word = values.answer;
  const answer = word === undefined ? null : (record: { request_id: string }) => {
    const answered = approveOwnerAction(home, record.request_id, word, store, now, {
      ...(values.signer !== undefined ? { signer: values.signer } : {}),
      ...(assertion !== undefined ? { assertion } : {}),
    });
    return answered.ok ? { ok: true as const } : answered;
  };
  const signed = signCarriedRequest(home, file.file, store, now, answer, localOwnerSeatFingerprint(home, now));
  if (!signed.ok) return refused(io, json, signed.why);
  const id = file.file.request.request_id;
  const machine = file.file.machine;
  const stale = signed.stalePin
    ? `note: machine ${machine.name} pinned another owner seat (${fingerprintText(file.file.owner_seat)}); if the answer is refused there, pin a fresh export on it (team owner-seat export, then team owner-seat pin)\n`
    : '';
  if (signed.kind === 'waiting') {
    if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'waiting', request_id: id, machine, text: signed.text, stale_pin: signed.stalePin })}\n`);
    else io.stdout(`team approvals: request ${id} from machine ${machine.name} is on the owner page; run this again once the owner has answered, or pass --answer <oui|always|non> to sign it now on the owner's device\n${stale}`);
    // exit: approvals.sign-waiting
    return 0;
  }
  const written = writeCarriedFile(io.cwd, values.out!, signed.file);
  if (!written.ok) return refused(io, json, written.why);
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'answered', request_id: id, machine, choice: signed.choice, signer: signed.signer, file: written.path, stale_pin: signed.stalePin })}\n`);
  else io.stdout(`team approvals: request ${id} for machine ${machine.name} answered ${signed.choice} by ${signed.signer}; answer written to ${written.path}\non machine ${machine.name} run: team approvals answer --from <file>\n${stale}`);
  // exit: approvals.signed
  return 0;
}

/** Back on the machine whose owner seat is pinned: record a carried answer for one of its requests. */
function answerRequest(io: Io, json: boolean, home: string, now: Date, store: OwnerSeatKeyStore, from: string): number {
  const read = readCarriedFile(io.cwd, from);
  if (!read.ok) return refused(io, json, read.why);
  const accepted = acceptCarriedAnswer(home, read.value, store, now);
  if (!accepted.ok) return refused(io, json, accepted.why);
  const once = accepted.choice === 'always' ? ' (on this machine it admits this request once; no standing rule is kept here)' : '';
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'answered', request_id: accepted.id, choice: accepted.choice, signer: accepted.signer, owner_seat: fingerprintText(accepted.fingerprint) })}\n`);
  else if (accepted.choice === 'deny') io.stdout(`team approvals: the owner denied request ${accepted.id} (signed by ${accepted.signer}, pinned owner seat ${fingerprintText(accepted.fingerprint)}); nothing runs\n`);
  else io.stdout(`team approvals: request ${accepted.id} answered ${accepted.choice} by ${accepted.signer}, verified against the pinned owner seat ${fingerprintText(accepted.fingerprint)}${once}\nrun the command again with --approval ${accepted.id}\n`);
  // exit: approvals.answered
  return 0;
}

/** The audit entries written for `id`, by file name, oldest name first. Reading only. */
function auditNames(home: string, id: string): string[] {
  try {
    return readdirSync(actionAuditFolder(home)).filter((name) => name.startsWith(`${id}.`) && name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();
  } catch {
    return [];
  }
}

/** The folder of every named rule, or the first id that is not a verified rule. */
function recordFolders(
  home: string,
  store: OwnerSeatKeyStore,
  now: Date,
  ids: readonly string[],
): { ok: true; folders: string[] } | { ok: false } {
  const created = listTeamCreateRules(home, store, now).rules;
  const actions = listOwnerActionRules(home, store, now).rules;
  const folders: string[] = [];
  for (const id of ids) {
    const scope = created.find((rule) => rule.rule_id === id)?.scope ?? actions.find((rule) => rule.rule_id === id)?.scope;
    if (scope === undefined) return { ok: false };
    folders.push(canonicalScope(scope));
  }
  return { ok: true, folders };
}

/** The shared check for changing approval records (src/client/owner-action-step.ts): the owner's
 *  terminal, or a verified owner-signer `always` rule covering the folder of every rule named in
 *  `ids`. A rule whose file does not verify has no folder that can be checked, so it admits
 *  nothing — and a refusal writes nothing. */
function recordGate(
  io: Io,
  home: string,
  now: Date,
  store: OwnerSeatKeyStore,
  ids: readonly string[],
  sources: { home: string; now: () => Date; ownerSeatStore?: OwnerSeatKeyStore },
): { kind: 'admitted' } | { kind: 'refused'; why: string } {
  const created = listTeamCreateRules(home, store, now).rules;
  const actions = listOwnerActionRules(home, store, now).rules;
  const folders: string[] = [];
  let unknown: string | null = null;
  for (const id of ids) {
    const scope = created.find((rule) => rule.rule_id === id)?.scope ?? actions.find((rule) => rule.rule_id === id)?.scope;
    if (scope === undefined) {
      unknown = id;
      break;
    }
    folders.push(canonicalScope(scope));
  }
  const admitted = ownerAdmitsRecord('team-revoke-approval', io, unknown === null ? folders : null, sources);
  if (admitted.ok) return { kind: 'admitted' };
  const caller = admitted.caller;
  if (admitted.kind === 'caller') {
    const detached = detachedRefusal(caller, { who: 'the owner', where: 'a terminal outside the terminal host' });
    return { kind: 'refused', why: detached ?? `only the owner revokes an approval rule, from a terminal outside the terminal host; this call is ${describeCaller(caller)}` };
  }
  if (unknown !== null) return { kind: 'refused', why: `"${unknown}" is not a rule the owner signed, so the folder it covers cannot be checked; this call is ${describeCaller(caller)}` };
  return { kind: 'refused', why: `the owner-seat rule covers ${admitted.ruleFolder ?? 'no folder'}; ${(admitted.targets ?? folders).join(', ')} is outside it; this call is ${describeCaller(caller)}` };
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
