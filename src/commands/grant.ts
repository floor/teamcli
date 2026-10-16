import { readArgs, type Args } from '../args.ts';
import { runAuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { runStandingGrant } from '../permissions/manage.ts';

export const USAGE = `Usage: team grant <seat> --scope <act,...> [--dry-run]
       team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run]
`;
export const grant: Command = (argv, io) => runGrant(argv, io);
export default grant;

/**
 * Writes an authority record, in one of two forms. With `--scope` and no `--capabilities` it edits
 * the team file's grant, exactly as before. With `--capabilities` it writes a standing grant
 * record: a seat names a registered agent and `@team` this project's team; the record is what the
 * gates read (src/permissions/manage.ts). Owner only either way.
 */
export async function runGrant(argv: string[], rawIo: Io, options: AuthorityEditOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['scope', 'capabilities', 'expires', 'name'], ['dry-run']);
  const problem = invocationProblem(args);
  if (problem !== null) {
    io.stderr(`team grant: ${problem}\n${USAGE}`);
    return 2; // exit: grant.invocation
  }
  const dryRun = args.flags.has('dry-run');
  const capabilities = args.values.capabilities;
  const result = capabilities === undefined
    ? await runAuthorityEdit('grant', { kind: 'grant', seat: args.rest[0]!, scope: args.values.scope!.split(',') }, io, { ...options, dryRun })
    : runStandingGrant(io, {
        seat: args.rest[0]!,
        capabilities: capabilities.split(','),
        ...(args.values.scope !== undefined ? { scope: args.values.scope.split(',') } : {}),
        ...(args.values.expires !== undefined ? { expires: args.values.expires } : {}),
        ...(args.values.name !== undefined ? { name: args.values.name } : {}),
      }, { ...options, dryRun });
  if (result === 'refused') {
    return 1; // exit: grant.refused
  }
  if (result === 'invalid') {
    return 2; // exit: grant.invalid
  }
  return 0; // exit: grant.done
}

/**
 * The invocation problems both forms share, and the flags that belong to one form alone. Returned
 * as data: the one marked `return 2` above carries the exit id, and a call here in a return
 * expression would be walked as one.
 */
function invocationProblem(args: Args): string | null {
  if (args.error !== undefined) return args.error;
  if (args.rest.length !== 1) {
    return args.values.capabilities === undefined ? 'a seat and --scope are required' : 'one seat or @team is required';
  }
  if (args.values.capabilities !== undefined) return null;
  if (args.values.scope !== undefined) return null;
  if (args.values.expires !== undefined) return '--expires belongs to the --capabilities form: team grant <seat|@team> --capabilities <cap,...>';
  if (args.values.name !== undefined) return '--name belongs to the --capabilities form: team grant <seat|@team> --capabilities <cap,...>';
  return 'a seat and --scope are required';
}
