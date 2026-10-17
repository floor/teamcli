import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { runAuthorityEdit, type AuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { runStandingRevoke, standingGrantNamed } from '../permissions/manage.ts';

export const USAGE = `Usage: team revoke grant [--dry-run]
       team revoke delegate <session/pane> [--dry-run]
       team revoke <name> [--dry-run]
`;
export const revoke: Command = (argv, io) => runRevoke(argv, io);
export default revoke;

/**
 * Removes an authority record. `grant` and `delegate <session/pane>` edit the team file, exactly as
 * before. A bare word that names a standing grant writes that grant's revocation record instead
 * (src/permissions/manage.ts); a word no grant holds stays the invocation error. Owner only.
 */
export async function runRevoke(argv: string[], rawIo: Io, options: AuthorityEditOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, [], ['dry-run']);
  const target = args.rest[0];
  const home = options.home ?? homedir();
  let edit: AuthorityEdit | undefined;
  if (target === 'grant' && args.rest.length === 1) edit = { kind: 'revoke-grant' };
  if (target === 'delegate' && args.rest.length === 2) edit = { kind: 'revoke-delegate', pane: args.rest[1]! };
  const standing = args.error === undefined && edit === undefined && args.rest.length === 1 && target !== undefined
    ? standingGrantNamed(home, target)
    : null;
  if (args.error !== undefined || (edit === undefined && standing === null)) {
    io.stderr(`team revoke: ${args.error ?? 'name grant, or delegate and its session/pane'}\n${USAGE}`);
    return 2; // exit: revoke.invocation
  }
  const dryRun = args.flags.has('dry-run');
  const result = edit !== undefined
    ? await runAuthorityEdit('revoke', edit, io, { ...options, dryRun })
    : runStandingRevoke(io, { name: standing!.name }, { ...options, dryRun });
  if (result === 'refused') {
    return 1; // exit: revoke.refused
  }
  if (result === 'invalid') {
    return 2; // exit: revoke.invalid
  }
  return 0; // exit: revoke.done
}
