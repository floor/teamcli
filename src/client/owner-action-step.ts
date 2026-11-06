// The owner-seat door of the lifecycle commands (src/client/owner-action.ts):
// `--request` records what the caller will run and asks the owner seat; `--approval <id>` runs it
// once the owner seat signed for exactly that. The owner never types a command and never answers
// a pane: the answer is a signature from the owner page (passkey or Touch ID). Each command keeps
// its own exits; this file only decides.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { callerLabel, callerOf, isOwner, type Caller } from '../caller.ts';
import { syncChildTimeout } from '../child.ts';
import { charterGate } from '../charter/check.ts';
import { isSameOrInside } from '../grant.ts';
import { admitOwnerAction, admitOwnerActionByRule, approveOwnerAction, auditRuleAdmission, boundWords, canonicalRoot, createOwnerActionRequest, listOwnerActionRules, type OwnerAction, type OwnerActionAdmission } from './owner-action.ts';
import { readOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from './owner-seat.ts';
import { findRoot } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { ownerSubjectProof } from '../dev_mode.ts';
import { readTeams } from '../registry/teams.ts';
import type { Io } from '../io.ts';
import { refuse } from '../output/index.ts';

export type OwnerSeatSources = {
  home?: string;
  now?: () => Date;
  ownerSeatStore?: OwnerSeatKeyStore;
  /** Whether a request is presented to the owner seat's Touch ID signer at once. Absent: only
   *  with the system key store (a real run); an injected store opts in with `true`. */
  present?: boolean;
  /** The team root the caller has already resolved, for a caller whose team lives in a folder
   *  that is not a git repository (the registry record is keyed by that folder). Absent: the git
   *  root of `io.cwd`, as before. */
  root?: string;
};

export type OwnerSeatStep =
  | { kind: 'none' }
  | { kind: 'requested' }
  | { kind: 'refused' }
  | { kind: 'admitted'; admission: Extract<OwnerActionAdmission, { ok: true }> };

export function headOf(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: syncChildTimeout(5_000),
    }).trim() || null;
  } catch {
    return null;
  }
}

/** The team an approval names: the project of this folder's team, or the folder's name before there is one. */
export function teamNameAt(root: string, home: string): string {
  try {
    const loaded = readTeamConfig(root, { home });
    if (loaded.ok) return loaded.team.project;
  } catch {}
  return basename(root);
}

/** `--request` and `--approval <id>` for one command. `none` when neither was passed. */
export function ownerSeatStep(
  command: 'up' | 'add' | 'import' | 'send' | 'down' | 'bus' | 'approvals' | 'forget' | 'config' | 'client' | 'development-mode',
  action: OwnerAction,
  argv: readonly string[],
  ask: { request: boolean; approval: string | undefined; dry: boolean; json: boolean; reason?: string },
  io: Io,
  sources: OwnerSeatSources,
): OwnerSeatStep {
  const home = sources.home ?? homedir();
  // The charter admits routine operations in the folder it covers. The machine's development
  // mode is not one of them: it is the machine's, so only the owner's own answer admits it, even
  // when the caller's folder lies inside a signed charter.
  if (command !== 'development-mode') {
    const gate = charterGate(home, { operation: command === 'client' ? 'grant' : command, cwd: io.cwd }, sources.ownerSeatStore);
    if (gate.kind === 'block') {
      refuse(io, ask.json, command, { id: `${command}.approval-refused`, message: gate.message, repair: null });
      return { kind: 'refused' };
    }
    if (gate.kind === 'admit') return { kind: 'admitted', admission: { ok: true, via: 'charter', signer: gate.signer } };
  }
  if (!ask.request && ask.approval === undefined) return { kind: 'none' };
  const now = sources.now?.() ?? new Date();
  const refused = (message: string): OwnerSeatStep => {
    refuse(io, ask.json, command, { id: `${command}.approval-refused`, message, repair: null });
    return { kind: 'refused' };
  };
  if (ask.request && ask.approval !== undefined) return refused('--request asks the owner seat and --approval runs an answered request: pass one');
  const root = sources.root ?? findRoot(io.cwd);
  if (root === null) return refused('not inside a git repository');
  const team = teamNameAt(root, home);
  const head = headOf(root);
  const words = boundWords(argv);
  if (ask.request) {
    const made = createOwnerActionRequest(home, {
      actions: [action],
      root,
      team,
      head,
      args: { [action]: words },
      requestedBy: callerLabel(callerOf(io)),
      ...(ask.reason === undefined ? {} : { reason: ask.reason }),
    }, now);
    if (!made.ok) return refused(made.why);
    // The same honest delivery `grant --request` uses: the owner seat's Touch ID signer is asked to
    // sign this request's answer, with the card as the prompt. A verified signature is the approval,
    // and the request is then admitted and run in this same invocation, exactly as signed. A
    // cancelled or unavailable prompt leaves the request waiting on the owner page.
    const touch = presentAction(home, made.record.request_id, sources, now);
    if (touch.ok) {
      const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
      const admitted = admitOwnerAction(home, made.record.request_id, { action, root, team, head, words, claim: !ask.dry }, store, now);
      if (!admitted.ok) return refused(admitted.why);
      if (!ask.json) io.stderr(`team ${command}: owner notified via touch-id: approved with a verified owner-seat signature (signed by ${admitted.signer}); applying request ${made.record.request_id}\n`);
      return { kind: 'admitted', admission: admitted };
    }
    const run = `team ${command} ${[...words, '--approval', made.record.request_id].join(' ')}`.replace(/\s+/g, ' ');
    const where = made.page === 'live' ? 'the owner page is already open and will show this card' : 'the owner answers it on the owner page';
    if (ask.json) io.stdout(`${JSON.stringify({ format: 1, status: 'requested', request_id: made.record.request_id, expires_at: made.record.expires_at, text: made.text, page: made.page, run })}\n`);
    else io.stdout(`team ${command}: owner-seat request ${made.record.request_id} recorded; ${touch.why === null ? '' : `owner NOT notified via touch-id (${touch.why}); `}${where}\nthen run: ${run}\n`);
    return { kind: 'requested' };
  }
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  const admitted = admitOwnerAction(home, ask.approval!, { action, root, team, head, words, claim: !ask.dry }, store, now);
  if (!admitted.ok) return refused(admitted.why);
  if (!ask.dry && !ask.json) io.stderr(`team ${command}: owner-seat approval ${ask.approval} (signed by ${admitted.signer}${admitted.via === 'rule' ? `, always rule ${admitted.ruleId}` : ''})\n`);
  return { kind: 'admitted', admission: admitted };
}

/** One team a rule folder names, with the folder its own state lives in. */
type RuleTeam = { team: TeamFile; root: string; dir: string };

/** Every team an owner-seat rule folder can name: the folder's own team, and each registry team
 *  whose repository sits directly in it — the two shapes a rule scope takes (a team's own folder,
 *  or the folder holding the project teams). A folder no team answers for names none, and a rule
 *  signed for it then admits no one but the owner. */
function ruleTeams(home: string, folder: string): RuleTeam[] {
  const out = new Map<string, RuleTeam>();
  const add = (loaded: Extract<ReturnType<typeof readTeamConfig>, { ok: true }>): void => {
    out.set(canonicalRoot(loaded.root), { team: loaded.team, root: loaded.root, dir: dirname(loaded.path) });
  };
  try {
    const loaded = readTeamConfig(folder, { home });
    if (loaded.ok && canonicalRoot(loaded.root) === canonicalRoot(folder)) add(loaded);
  } catch {
    // A folder with no readable team is no subject: the other shape may still answer.
  }
  try {
    const records = readTeams(home);
    for (const record of Object.values(records)) {
      const root = canonicalRoot(record.root);
      if (root !== canonicalRoot(folder) && dirname(root) !== canonicalRoot(folder)) continue;
      try {
        const loaded = readTeamConfig(record.root, { home });
        if (loaded.ok) add(loaded);
      } catch {
        // One unreadable record names no subject; the folder's other teams still may.
      }
    }
  } catch {
    // A registry that cannot be read names no further team.
  }
  return [...out.values()];
}

/**
 * Whether the caller is the subject an owner-seat rule admits: the lead of the team the rule was
 * signed for, placed in that team's session, or the same entity's main orchestrator placed above
 * it. The rule names the team at its creation (`rule.team`), so a sibling team's lead standing in
 * the same folder is no admission, and neither is a plain seat anywhere in it.
 */
function ruleSubjectAdmits(
  rule: { team: string; scope: string },
  home: string,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
): boolean {
  for (const held of ruleTeams(home, rule.scope)) {
    if (held.team.project !== rule.team) continue;
    const proof = ownerSubjectProof(io, { home, team: held.team, root: held.root, dir: held.dir });
    if (proof !== null && proof.role === 'orchestrator') return true;
  }
  return false;
}

/** With no request: whether a verified owner-seat `always` rule covers this action here, for
 *  the subject that rule admits — the lead of the team the rule was signed for, or the same
 *  entity's main orchestrator. Asked only where the ordinary gate refused. The rule actually
 *  spent is the one that names the caller's team, so two teams sharing a folder cannot spend
 *  each other's rules. */
export function ownerSeatRuleAdmits(
  action: OwnerAction,
  cwd: string,
  dry: boolean,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  sources: OwnerSeatSources,
): boolean {
  const home = sources.home ?? homedir();
  const root = findRoot(cwd);
  if (root === null) return false;
  try {
    const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
    const now = sources.now?.() ?? new Date();
    // The owner's own no-terminal run is the rule's first subject: `--request` was signed by
    // the owner seat, and an `always` answer is her standing consent for the same shape.
    // Everyone else must prove the lead of the team the covering rule names, or that team's
    // entity's main orchestrator. A plain seat, a lead of another team sharing the folder and
    // another entity's orchestrator never reach the claim, write no audit line, and leave every
    // rule exactly as it was.
    const folder = dirname(canonicalRoot(root));
    const covering = listOwnerActionRules(home, store, now).rules
      .filter((rule) => rule.actions.includes(action) && rule.scope === folder);
    if (covering.length === 0) return false;
    const caller = callerOf(io);
    const admits = caller.kind === 'owner-no-tty'
      ? covering[0]
      : covering.find((rule) => ruleSubjectAdmits(rule, home, io));
    if (admits === undefined) return false;
    return admitOwnerActionByRule(home, { action, root, team: teamNameAt(root, home), claim: !dry, ruleId: admits.rule_id }, store, now).ok;
  } catch {
    return false;
  }
}

/**
 * The folder an owner-seat `always` rule covers when it admits a caller at `cwd`: the parent of
 * the canonical repository root, exactly the scope `ruleFor` matches. Null outside a repository.
 * An action that changes another folder as well as the caller (`init --approval-mode --scope`)
 * checks its target against this folder: the rule admits its own folder's business and no
 * folder outside it.
 */
export function ownerSeatRuleFolder(cwd: string): string | null {
  const root = findRoot(cwd);
  return root === null ? null : dirname(canonicalRoot(root));
}

export type OwnerRecordAdmission =
  | { ok: true; via: 'owner' }
  | { ok: true; via: 'rule'; ruleId: string; signer: string; ruleFolder: string }
  | { ok: false; kind: 'caller'; caller: Caller }
  | { ok: false; kind: 'target'; caller: Caller; ruleFolder: string | null; targets: readonly string[] | null };

/**
 * The one check for changing an approval record: removing a standing rule or spending a pending
 * grant (`team approvals revoke`, `team init --revoke-approval` and `--approval-mode`,
 * `team grant --deny` and `--revoke-approval`). Its default is the owner at a terminal. The
 * configured way in is a verified owner-signer `always` rule for `team-revoke-approval`, and the
 * rule must cover the folder of the record the call changes (every folder in `targets`) — the
 * target, never merely the caller's own folder: a rule is the owner's standing consent for that
 * folder's records, wherever the call is made from. With no known target (a record that does not
 * verify or cannot be placed) no rule admits anything. A refusal writes no record; an admission
 * by rule is recorded in the owner-action audit folder, as a rule admission always was.
 */
export function ownerAdmitsRecord(action: OwnerAction, io: Io, targets: readonly string[] | null, sources: OwnerSeatSources): OwnerRecordAdmission {
  const caller = callerOf(io);
  if (isOwner(caller)) return { ok: true, via: 'owner' };
  const home = sources.home ?? homedir();
  try {
    const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
    const now = sources.now?.() ?? new Date();
    const rules = listOwnerActionRules(home, store, now).rules.filter((rule) => rule.actions.includes(action));
    if (rules.length === 0) return { ok: false, kind: 'caller', caller };
    if (targets === null || targets.length === 0) return { ok: false, kind: 'target', caller, ruleFolder: rules[0]!.scope, targets };
    const covering = rules.filter((one) => targets.every((target) => isSameOrInside(one.scope, target)));
    if (covering.length === 0) return { ok: false, kind: 'target', caller, ruleFolder: rules[0]!.scope, targets };
    // The rule is the owner's standing consent for a folder's records. The owner's own
    // no-terminal run may spend it; everyone else must be the lead of the team the rule was
    // signed for, or that team's entity's main orchestrator — never a plain seat, a lead of
    // another team, or another entity's orchestrator. Among rules covering the same record, the
    // one spent is the one whose team the caller leads. Asked before the audit line is written.
    const rule = caller.kind === 'owner-no-tty'
      ? covering[0]!
      : covering.find((one) => ruleSubjectAdmits(one, home, io));
    if (rule === undefined) return { ok: false, kind: 'caller', caller };
    auditRuleAdmission(home, rule, action, targets, now);
    return { ok: true, via: 'rule', ruleId: rule.rule_id, signer: rule.signer, ruleFolder: rule.scope };
  } catch {
    return { ok: false, kind: 'caller', caller };
  }
}

/** Presents one owner-action request to the owner seat's Touch ID signer. `why` is null when no
 *  presentation was attempted (a test store that did not opt in). */
function presentAction(home: string, id: string, sources: OwnerSeatSources, now: Date): { ok: true } | { ok: false; why: string | null } {
  const enabled = sources.present ?? sources.ownerSeatStore === undefined;
  if (!enabled) return { ok: false, why: null };
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered' };
  const signer = seat.signers.find((one) => one.type === 'mac-keystore');
  if (signer === undefined) return { ok: false, why: 'the owner seat has no Touch ID (mac-keystore) signer' };
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available here` };
  const answered = approveOwnerAction(home, id, 'oui', store, now, { signer: signer.name });
  return answered.ok ? { ok: true } : { ok: false, why: answered.why };
}
