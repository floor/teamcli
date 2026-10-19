import { readArgs, type Args } from '../args.ts';
import { runAuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { runClientGrantMode } from '../client-cli.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { runStandingGrant } from '../permissions/manage.ts';

export const USAGE = `Usage: team grant <seat> --scope <act,...> [--dry-run] [--json]
       team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run] [--json]
       team grant --client <client-id> --entity <entity> --public-key <file> [--expires <ISO>] [--inbox] [--json]

Exits 0 when the grant is written or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.
`;
export const grant: Command = (argv, io) => runGrant(argv, io);
export default grant;

/**
 * Writes an authority record, in one of two forms. With `--scope` and no `--capabilities` it edits
 * the team file's grant, exactly as before. With `--capabilities` it writes a standing grant
 * record: a seat names a registered agent and `@team` this project's team; the record is what the
 * gates read (src/permissions/manage.ts). With `--client` it writes the owner-signed client grant
 * builder-4's records module owns. Owner only in every form.
 */
export async function runGrant(argv: string[], rawIo: Io, options: AuthorityEditOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['scope', 'capabilities', 'expires', 'name', 'client', 'entity', 'public-key'], ['dry-run', 'inbox', 'json']);
  const dryRun = args.flags.has('dry-run');
  let result: 'ok' | 'refused' | 'invalid';
  if (args.values.client !== undefined) {
    result = runClientGrantMode(rawIo, io, args, json);
  } else {
    const problem = invocationProblem(args);
    if (problem !== null) {
      if (json) {
        writeJsonError(rawIo, 'grant.invocation', plainText(problem), null);
      } else {
        io.stderr(`team grant: ${problem}\n${USAGE}`);
      }
      return 2; // exit: grant.invocation
    }
    const capabilities = args.values.capabilities;
    result = capabilities === undefined
      ? await runAuthorityEdit('grant', { kind: 'grant', seat: args.rest[0]!, scope: args.values.scope!.split(',') }, rawIo, { ...options, dryRun, json })
      : runStandingGrant(rawIo, {
          seat: args.rest[0]!,
          capabilities: capabilities.split(','),
          ...(args.values.scope !== undefined ? { scope: args.values.scope.split(',') } : {}),
          ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
          ...(args.values.name !== undefined ? { name: args.values.name } : {}),
        }, { ...options, dryRun, json });
  }
  if (result === 'refused') {
    return 1; // exit: grant.refused
  }
  if (result === 'invalid') {
    return 2; // exit: grant.invalid
  }
  return 0; // exit: grant.done
}

/**
 * The invocation problems the two team-file forms share, and the flags that belong to one form
 * alone. Returned as data: the one marked `return 2` above carries the exit id, and a call here in
 * a return expression would be walked as one.
 */
function invocationProblem(args: Args): string | null {
  if (args.error !== undefined) return args.error;
  if (args.flags.has('inbox')) return '--inbox belongs to the --client form: a grant that reads the client inbox';
  if (args.rest.length !== 1) {
    return args.values.capabilities === undefined ? 'a seat and --scope are required' : 'one seat or @team is required';
  }
  if (args.values.capabilities !== undefined) return null;
  if (args.values.scope !== undefined) return null;
  if (args.values.expires !== undefined) return '--expires belongs to the --capabilities form: team grant <seat|@team> --capabilities <cap,...>';
  if (args.values.name !== undefined) return '--name belongs to the --capabilities form: team grant <seat|@team> --capabilities <cap,...>';
  if (args.values.entity !== undefined) return '--entity belongs to the --client form';
  if (args.values['public-key'] !== undefined) return '--public-key belongs to the --client form';
  return 'a seat and --scope are required';
}
