// The owner-seat door of the lifecycle commands (src/client/owner-action.ts):
// `--request` records what the caller will run and asks the owner seat; `--approval <id>` runs it
// once the owner seat signed for exactly that. The owner never types a command and never answers
// a pane: the answer is a signature from the owner page (passkey or Touch ID). Each command keeps
// its own exits; this file only decides.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { callerLabel, callerOf } from '../caller.ts';
import { charterGate } from '../charter/check.ts';
import { admitOwnerAction, admitOwnerActionByRule, approveOwnerAction, boundWords, createOwnerActionRequest, type OwnerAction, type OwnerActionAdmission } from './owner-action.ts';
import { readOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from './owner-seat.ts';
import { findRoot } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Io } from '../io.ts';
import { refuse } from '../output/index.ts';

export type OwnerSeatSources = {
  home?: string;
  now?: () => Date;
  ownerSeatStore?: OwnerSeatKeyStore;
  /** Whether a request is presented to the owner seat's Touch ID signer at once. Absent: only
   *  with the system key store (a real run); an injected store opts in with `true`. */
  present?: boolean;
};

export type OwnerSeatStep =
  | { kind: 'none' }
  | { kind: 'requested' }
  | { kind: 'refused' }
  | { kind: 'admitted'; admission: Extract<OwnerActionAdmission, { ok: true }> };

export function headOf(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
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
  command: 'up' | 'add' | 'import' | 'send' | 'down' | 'bus' | 'approvals' | 'forget' | 'config' | 'client',
  action: OwnerAction,
  argv: readonly string[],
  ask: { request: boolean; approval: string | undefined; dry: boolean; json: boolean },
  io: Io,
  sources: OwnerSeatSources,
): OwnerSeatStep {
  const home = sources.home ?? homedir();
  const gate = charterGate(home, { operation: command === 'client' ? 'grant' : command, cwd: io.cwd }, sources.ownerSeatStore);
  if (gate.kind === 'block') {
    refuse(io, ask.json, command, { id: `${command}.approval-refused`, message: gate.message, repair: null });
    return { kind: 'refused' };
  }
  if (gate.kind === 'admit') return { kind: 'admitted', admission: { ok: true, via: 'charter', signer: gate.signer } };
  if (!ask.request && ask.approval === undefined) return { kind: 'none' };
  const now = sources.now?.() ?? new Date();
  const refused = (message: string): OwnerSeatStep => {
    refuse(io, ask.json, command, { id: `${command}.approval-refused`, message, repair: null });
    return { kind: 'refused' };
  };
  if (ask.request && ask.approval !== undefined) return refused('--request asks the owner seat and --approval runs an answered request: pass one');
  const root = findRoot(io.cwd);
  if (root === null) return refused('not inside a git repository');
  const team = teamNameAt(root, home);
  const head = headOf(root);
  const words = boundWords(argv);
  if (ask.request) {
    const made = createOwnerActionRequest(home, { actions: [action], root, team, head, args: { [action]: words }, requestedBy: callerLabel(callerOf(io)) }, now);
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

/** With no request: whether a verified owner-seat `always` rule covers this action here. Asked only where the ordinary gate refused. */
export function ownerSeatRuleAdmits(action: OwnerAction, cwd: string, dry: boolean, sources: OwnerSeatSources): boolean {
  const home = sources.home ?? homedir();
  const root = findRoot(cwd);
  if (root === null) return false;
  try {
    const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
    return admitOwnerActionByRule(home, { action, root, team: teamNameAt(root, home), claim: !dry }, store, sources.now?.() ?? new Date()).ok;
  } catch {
    return false;
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
