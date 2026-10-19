import { homedir } from 'node:os';
import { readArgs, type Args } from '../args.ts';
import { runAuthorityEdit, type AuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { runClientRevokeMode } from '../client-cli.ts';
import { CLIENT_GRANT_ID_PATTERN } from '../client/records.ts';
import { grantsDir } from '../grant.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { runStandingRevoke, standingGrantNamed } from '../permissions/manage.ts';

export const USAGE = `Usage: team revoke grant [--dry-run] [--json]
       team revoke delegate <session/pane> [--dry-run] [--json]
       team revoke <name> [--dry-run] [--json]
       team revoke <client-grant-id> [--json]
       team revoke --client <client-grant-id> [--json]

Exits 0 when the grant or delegate is revoked or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.
`;
export const revoke: Command = (argv, io) => runRevoke(argv, io);
export default revoke;

/**
 * Removes an authority record. `grant` and `delegate <session/pane>` edit the team file, exactly as
 * before. A bare word that names a standing grant writes that grant's revocation record instead
 * (src/permissions/manage.ts); a word no grant holds stays the invocation error. A client grant
 * id appends builder-4's owner-signed revocation record instead. Owner only in every form.
 */
export async function runRevoke(argv: string[], rawIo: Io, options: AuthorityEditOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['client'], ['dry-run', 'json']);
  const target = args.rest[0];
  const home = options.home ?? homedir();
  let edit: AuthorityEdit | undefined;
  if (target === 'grant' && args.rest.length === 1) edit = { kind: 'revoke-grant' };
  if (target === 'delegate' && args.rest.length === 2) edit = { kind: 'revoke-delegate', pane: args.rest[1]! };
  const looksClient = args.values.client !== undefined || (target !== undefined && CLIENT_GRANT_ID_PATTERN.test(target));
  const clientProblem = looksClient ? clientRevokeProblem(args) : null;
  const standing = !looksClient && args.error === undefined && edit === undefined && args.rest.length === 1 && target !== undefined
    ? standingGrantNamed(home, target)
    : null;
  if (args.error !== undefined || clientProblem !== null || (edit === undefined && clientProblem === null && !looksClient && standing === null)) {
    // A bare word no record holds says which word was typed, and where the standing grants are
    // read from: the record files' own names are the names `team revoke <name>` takes.
    const named = target !== undefined && args.rest.length === 1 && target !== 'grant' && target !== 'delegate' && !looksClient
      ? `no grant or delegate is named "${plainLine(target)}"; \`ls ${grantsDir(home)}\` shows the standing grants`
      : undefined;
    const why = args.error ?? clientProblem ?? named ?? 'name grant, or delegate and its session/pane';
    if (json) {
      writeJsonError(rawIo, 'revoke.invocation', plainText(why), null);
    } else {
      io.stderr(`team revoke: ${why}\n${USAGE}`);
    }
    return 2; // exit: revoke.invocation
  }
  const dryRun = args.flags.has('dry-run');
  const result = looksClient
    ? runClientRevokeMode(rawIo, io, args.values.client ?? target!, json)
    : edit !== undefined
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

/** The invocation problems the client forms own: one id, no dry run, no team-file target. */
function clientRevokeProblem(args: Args): string | null {
  if (args.values.client !== undefined && args.rest.length > 0) {
    return '--client takes the grant id itself and no positional argument';
  }
  if (args.rest.length > 1) return 'revoke takes exactly one client grant id';
  if (args.flags.has('dry-run')) return '--dry-run belongs to the team-file forms; a client revocation is appended whole';
  return null;
}
