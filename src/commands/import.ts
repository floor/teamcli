import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';
import { runTeamImport } from './migrate.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';

export const USAGE = `Usage: team import [<file>] [--dry-run] [--json]
       team import [<file>] --request [--json]
       team import [<file>] --approval <request-id> [--dry-run] [--json]

Makes a team file this team's registry record: .agents/team.yaml when no file is
named. The repair team check and team status name when a leftover team file says
something the registry does not; also the first import when team migrate was not run.

  <file>     the team file to import, for this checkout's team
  --dry-run  say what would be imported, and write nothing
  --json     the result as one JSON document on stdout
  --request  record this import and send it to the owner seat; the owner answers
             on the owner page (passkey or Touch ID), never at a terminal
  --approval <request-id>
             run the import the owner seat signed for, once

Exits 0 when the registry holds the file (or would, with --dry-run), 1 when the
caller is not the owner or the owner-seat approval is refused, 2 when the invocation, team file, or registry record can't
be read.
`;

export const teamImport: Command = (argv, io) => runImport(argv, io);

/** The command with its home and clock named, for tests that keep the registry in a temp home. */
export async function runImport(argv: string[], io: Io, sources: { home?: string; now?: () => Date; ownerSeatStore?: OwnerSeatKeyStore } = {}): Promise<number> {
  const ended = await runTeamImport('import', argv, readArgs(argv, ['approval'], ['json', 'dry-run', 'request']), io, sources);
  switch (ended) {
    case 'approval-requested':
      // exit: import.approval-requested
      return 0;
    case 'approval-refused':
      // exit: import.approval-refused
      return 1;
    case 'done':
    case 'already-migrated':
      // exit: import.done
      return 0;
    case 'detached':
      // exit: import.detached
      return 1;
    case 'not-owner':
      // exit: import.not-owner
      return 1;
    case 'invocation':
      // exit: import.invocation
      return 2;
    case 'invalid':
    case 'registry':
      // exit: import.invalid
      return 2;
    default:
      // exit: import.round-trip
      return 2;
  }
}
export default teamImport;
