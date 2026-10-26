// `team forget`: removes one team registry record.
//
// The record is the machine's note that the team exists. Forgetting it does not stop panes,
// close workspaces, or delete the team file. The owner at a terminal runs it, or the owner seat
// signs a `team-forget` answer for that id. A key that names more than one team is refused, so
// a project name shared by two teams never deletes both.

import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { ownerSeatRuleAdmits, ownerSeatStep } from '../client/owner-action-step.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { hasJsonFlag } from '../output/index.ts';
import type { Command, Io } from '../io.ts';
import { findTeams, forgetTeam } from '../registry/teams.ts';

export const USAGE = `Usage: team forget <id> [--json]
       team forget <id> --request [--json]
       team forget <id> --approval <request-id> [--json]

Removes one team from this machine's registry. <id> is a team id, a project name, or a session
name; a word that names more than one team is refused. The team's place in any project record is
dropped with it. Panes are not stopped and the team file is not deleted.

The owner runs it from a terminal outside herdr. --request records the forget for the owner seat
and removes nothing; --approval <request-id> runs it once the owner has answered on the owner
page. A signed always rule for team-forget covering this folder admits the run with no request.

Exits 0 when the record is removed or a request is recorded, 1 when it is refused or the record
is not there, 2 when the invocation can't be read.
`;

export type ForgetSources = { home?: string; now?: () => Date; ownerSeatStore?: OwnerSeatKeyStore };

export const forget: Command = (argv, io) => runForget(argv, io);
export default forget;

export async function runForget(argv: string[], io: Io, sources: ForgetSources = {}): Promise<number> {
  const args = readArgs(argv, ['approval'], ['json', 'request']);
  const json = hasJsonFlag(argv);
  if (args.error || args.rest.length !== 1) {
    io.stderr(`team forget: ${args.error ?? (args.rest.length === 0 ? 'a team id is required' : `unexpected "${args.rest[1]}"`)}\n${USAGE}`);
    // exit: forget.invocation
    return 2;
  }
  const key = args.rest[0]!;
  const home = sources.home ?? homedir();
  const now = sources.now?.() ?? new Date();
  const seatSources = { home, now: () => now, ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) };
  let seatApproved = false;
  if (args.flags.has('request') || args.values.approval !== undefined) {
    const seat = ownerSeatStep('forget', 'team-forget', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json }, io, seatSources);
    if (seat.kind === 'requested') {
      // exit: forget.approval-requested
      return 0;
    }
    if (seat.kind === 'refused') {
      // exit: forget.approval-refused
      return 1;
    }
    seatApproved = seat.kind === 'admitted';
  }
  const caller = callerOf(io);
  if (!seatApproved && !isOwner(caller)) seatApproved = ownerSeatRuleAdmits('team-forget', io.cwd, false, seatSources);
  if (!seatApproved) {
    const detached = detachedRefusal(caller, { who: 'the owner', where: 'a terminal outside herdr' });
    if (detached !== undefined) return refused(io, json, detached);
    if (!isOwner(caller)) return refused(io, json, `only the owner forgets a team record, from a terminal outside herdr; this call is ${describeCaller(caller)}`);
  }
  let found;
  try {
    found = findTeams(home, key);
  } catch (error) {
    return refused(io, json, `the team registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (found.length === 0) return missing(io, json, key);
  if (found.length > 1) return refused(io, json, `"${key}" names ${String(found.length)} teams (${found.map((team) => team.id).join(', ')}); name one team id`);
  const id = found[0]!.id;
  if (id === undefined) return refused(io, json, 'the team record has no id');
  let removed;
  try {
    removed = forgetTeam(home, id);
  } catch (error) {
    return refused(io, json, `the team registry was not updated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (removed === null) return missing(io, json, id);
  const line = `forgot ${id} (${removed.project}); panes were not stopped and the team file was not deleted`;
  if (json) io.stdout(`${JSON.stringify({ format: 1, forgot: id, project: removed.project })}\n`);
  else io.stdout(`team forget: ${line}\n`);
  // exit: forget.forgotten
  return 0;
}

function missing(io: Io, json: boolean, key: string): number {
  const message = `no team record for "${key}"`;
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'missing', message })}\n`);
  else io.stderr(`team forget: ${message}\n`);
  // exit: forget.missing
  return 1;
}

function refused(io: Io, json: boolean, message: string): number {
  if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'refused', message })}\n`);
  else io.stderr(`team forget: ${message}\n`);
  // exit: forget.refused
  return 1;
}
