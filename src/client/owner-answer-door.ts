// The owner-answer door: one place, in the dispatcher, where every owner-only command accepts the
// owner's signed answer on a machine whose owner seat is pinned from another machine. There, no
// terminal is the owner, no general grant stands and dev mode lifts nothing, so a command that has
// no `--request` of its own could not run at all. The door gives each of them the same two
// options the lifecycle commands already have:
//
//   `team <command> … --request [--reason <text>]`   records the exact command line (its name and
//       every word but these options and `--json`) for the owner seat, bound to this machine, the
//       repository the caller stands in (or the account's home outside one), its team and HEAD;
//   `team <command> … --approval <id>`                runs that exact line once the owner has
//       answered it, as the owner, with the option taken off the line. The answer is verified
//       against the pin and claimed single-use before the command reads its line.
//
// The request is carried like any other (`team approvals export`, `sign`, `answer`). Every word of
// the line is bound, `--dry-run` included, so a dry run is its own request and a line that differs
// by a word admits nothing. No charter, rule or lead admits a line through this door.
//
// Left to the command itself: a command whose own parser reads `--approval`, `--request` or
// `--reason` (the lifecycle commands, `config`, `daemon`, `development-mode`, `client`, `init`,
// `grant`), and two the owner's answer never stands in for: `owner-seat`, whose first pin is
// trust on first use and whose later pins are signed exports, and `setup`, since a pinned machine
// keeps no charter. On a machine with its own owner seat the door is closed: every line passes.

import { homedir } from 'node:os';
import type { Io } from '../io.ts';
import { dispatchedCommand, VALUED } from './general-door.ts';
import { ownerMachinePinned } from './owner-pin-path.ts';

/** Commands whose own line reads the owner-seat options, or that the owner's answer never admits. */
const ANSWER_OWN = new Set(['init', 'grant', 'owner-seat', 'setup', 'batch']);

export type AnswerDoor =
  | { kind: 'pass' }
  | { kind: 'usage'; why: string; json: boolean }
  | { kind: 'refused'; why: string; json: boolean }
  | { kind: 'requested'; json: boolean }
  | { kind: 'admitted'; argv: string[]; io: Io; json: boolean };

/** Whether the command line is one this door reads: not a command that reads the options itself. */
function doorCommand(name: string, rest: readonly string[]): boolean {
  const { command } = dispatchedCommand(name, rest);
  for (const one of [name, command]) {
    if (ANSWER_OWN.has(one)) return false;
    const valued = VALUED[one] ?? [];
    if (valued.includes('approval') || valued.includes('request') || valued.includes('reason')) return false;
  }
  return true;
}

type Taken = { request: boolean; approval: string | undefined; reason: string | undefined; repeated: boolean; line: string[]; bound: string[] };

/** The line without the door's options, read the way the command's own parser reads it: a valued
 *  option of the command consumes the next word, so a value that spells an option is not taken. */
function takeOptions(name: string, rest: readonly string[]): Taken {
  const { command } = dispatchedCommand(name, rest);
  const valued = new Set(VALUED[command] ?? []);
  const line: string[] = [];
  let request = false;
  let approval: string | undefined;
  let reason: string | undefined;
  let seen = 0;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string;
    if (word === '--request') { request = true; seen += 1; continue; }
    if (word === '--approval' || word === '--reason') {
      const value = rest[i + 1];
      if (word === '--approval') approval = value ?? ''; else reason = value ?? '';
      seen += 1;
      i += 1;
      continue;
    }
    if (word.startsWith('--approval=')) { approval = word.slice('--approval='.length); seen += 1; continue; }
    if (word.startsWith('--reason=')) { reason = word.slice('--reason='.length); seen += 1; continue; }
    line.push(word);
    if (word.startsWith('--') && !word.includes('=') && valued.has(word.slice(2)) && i + 1 < rest.length) {
      line.push(rest[i + 1] as string);
      i += 1;
    }
  }
  const named = (request ? 1 : 0) + (approval !== undefined ? 1 : 0) + (reason !== undefined ? 1 : 0);
  return { request, approval, reason, repeated: seen > named, line, bound: [name, ...line.filter((word) => word !== '--json')] };
}

/** Whether a line carries one of the door's options at all (a cheap test before the door loads). */
export function carriesOwnerAnswer(rest: readonly string[]): boolean {
  return rest.some((word) => word === '--request' || word === '--approval' || word.startsWith('--approval=') || word === '--reason' || word.startsWith('--reason='));
}

/** The door's verdict for `team <name> <rest>`. Off a pinned machine, or for a command that reads
 *  the options itself, it passes the line untouched. */
export async function ownerAnswerDoor(name: string, rest: readonly string[], io: Io, now: Date = new Date()): Promise<AnswerDoor> {
  const home = io.env.HOME ?? homedir();
  if (!carriesOwnerAnswer(rest) || !doorCommand(name, rest) || !ownerMachinePinned(home)) return { kind: 'pass' };
  const json = rest.includes('--json');
  const taken = takeOptions(name, rest);
  if (taken.repeated) return { kind: 'usage', why: '--request, --approval and --reason are each given once', json };
  if (!taken.request && taken.approval === undefined) return { kind: 'usage', why: '--reason goes with --request', json };
  if (taken.request && taken.approval !== undefined) return { kind: 'usage', why: '--request asks the owner seat and --approval runs an answered request: pass one', json };
  if (taken.reason !== undefined && !taken.request) return { kind: 'usage', why: '--reason goes with --request', json };
  if (taken.approval !== undefined && taken.approval === '') return { kind: 'usage', why: '--approval takes <request-id>', json };
  const { findRoot } = await import('../file/load.ts');
  const { headOf, teamNameAt } = await import('./owner-action-step.ts');
  const { admitOwnerAction, createOwnerActionRequest } = await import('./owner-action.ts');
  const { callerLabel, callerOf } = await import('../caller.ts');
  const root = findRoot(io.cwd) ?? home;
  const team = teamNameAt(root, home);
  const head = headOf(root);
  if (taken.request) {
    const made = createOwnerActionRequest(home, {
      actions: ['team-owner-command'],
      root,
      team,
      head,
      args: { 'team-owner-command': taken.bound },
      requestedBy: callerLabel(callerOf(io)),
      ...(taken.reason === undefined ? {} : { reason: taken.reason }),
    }, now);
    if (!made.ok) return { kind: 'refused', why: made.why, json };
    const run = `team ${[...taken.bound, '--approval', made.record.request_id].join(' ')}`;
    if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'requested', request_id: made.record.request_id, expires_at: made.record.expires_at, text: made.text, page: made.page, run })}\n`);
    else io.stdout(`team ${name}: owner-seat request ${made.record.request_id} recorded; carry it to the owner's signers with team approvals export\nthen run: ${run}\n`);
    return { kind: 'requested', json };
  }
  const { systemOwnerSeatKeyStore } = await import('./owner-seat.ts');
  const admitted = admitOwnerAction(home, taken.approval!, { action: 'team-owner-command', root, team, head, words: taken.bound, claim: true }, systemOwnerSeatKeyStore(), now);
  if (!admitted.ok) return { kind: 'refused', why: admitted.why, json };
  if (!json) io.stderr(`team ${name}: owner-seat approval ${taken.approval} (signed by ${admitted.signer})\n`);
  return { kind: 'admitted', argv: taken.line, io: { ...io, caller: { kind: 'owner' } }, json };
}
