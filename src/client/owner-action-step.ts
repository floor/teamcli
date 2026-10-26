// The owner-seat door of the lifecycle commands (src/client/owner-action.ts):
// `--request` records what the caller will run and asks the owner seat; `--approval <id>` runs it
// once the owner seat signed for exactly that. The owner never types a command and never answers
// a pane: the answer is a signature from the owner page (passkey or Touch ID). Each command keeps
// its own exits; this file only decides.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { callerLabel, callerOf } from '../caller.ts';
import { admitOwnerAction, admitOwnerActionByRule, boundWords, createOwnerActionRequest, type OwnerAction, type OwnerActionAdmission } from './owner-action.ts';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from './owner-seat.ts';
import { findRoot } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Io } from '../io.ts';
import { refuse } from '../output/index.ts';

export type OwnerSeatSources = { home?: string; now?: () => Date; ownerSeatStore?: OwnerSeatKeyStore };

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
  command: 'up' | 'add' | 'import' | 'send' | 'down' | 'bus' | 'approvals' | 'forget',
  action: OwnerAction,
  argv: readonly string[],
  ask: { request: boolean; approval: string | undefined; dry: boolean; json: boolean },
  io: Io,
  sources: OwnerSeatSources,
): OwnerSeatStep {
  if (!ask.request && ask.approval === undefined) return { kind: 'none' };
  const home = sources.home ?? homedir();
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
    const run = `team ${command} ${[...words, '--approval', made.record.request_id].join(' ')}`.replace(/\s+/g, ' ');
    const where = made.page === 'live' ? 'the owner page is already open and will show this card' : 'the owner answers it on the owner page';
    if (ask.json) io.stdout(`${JSON.stringify({ format: 1, status: 'requested', request_id: made.record.request_id, expires_at: made.record.expires_at, text: made.text, page: made.page, run })}\n`);
    else io.stdout(`team ${command}: owner-seat request ${made.record.request_id} recorded; ${where}\nthen run: ${run}\n`);
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
