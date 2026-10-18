import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { runAuthorityEdit, type AuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { grantsDir } from '../grant.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { runStandingRevoke, standingGrantNamed } from '../permissions/manage.ts';

export const USAGE = `Usage: team revoke grant [--dry-run] [--json]
       team revoke delegate <session/pane> [--dry-run] [--json]
       team revoke <name> [--dry-run] [--json]

Exits 0 when the grant or delegate is revoked or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.
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
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['dry-run', 'json']);
  const target = args.rest[0];
  const home = options.home ?? homedir();
  let edit: AuthorityEdit | undefined;
  if (target === 'grant' && args.rest.length === 1) edit = { kind: 'revoke-grant' };
  if (target === 'delegate' && args.rest.length === 2) edit = { kind: 'revoke-delegate', pane: args.rest[1]! };
  const standing = args.error === undefined && edit === undefined && args.rest.length === 1 && target !== undefined
    ? standingGrantNamed(home, target)
    : null;
  if (args.error !== undefined || (edit === undefined && standing === null)) {
    // A bare word no record holds says which word was typed, and where the standing grants are
    // read from: the record files' own names are the names `team revoke <name>` takes.
    const named = target !== undefined && args.rest.length === 1 && target !== 'grant' && target !== 'delegate'
      ? `no grant or delegate is named "${plainLine(target)}"; \`ls ${grantsDir(home)}\` shows the standing grants`
      : undefined;
    const why = args.error ?? named ?? 'name grant, or delegate and its session/pane';
    if (json) {
      writeJsonError(rawIo, 'revoke.invocation', plainText(why), null);
    } else {
      io.stderr(`team revoke: ${why}\n${USAGE}`);
    }
    return 2; // exit: revoke.invocation
  }
  const dryRun = args.flags.has('dry-run');
  const result = edit !== undefined
    ? await runAuthorityEdit('revoke', edit, rawIo, { ...options, dryRun, json })
    : runStandingRevoke(rawIo, { name: standing!.name }, { ...options, dryRun, json });
  if (result === 'refused') {
    return 1; // exit: revoke.refused
  }
  if (result === 'invalid') {
    return 2; // exit: revoke.invalid
  }
  return 0; // exit: revoke.done
}
