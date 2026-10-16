import { readArgs } from '../args.ts';
import { runAuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';

export const USAGE = 'Usage: team grant <seat> --scope <act,...> [--dry-run]\n';
export const grant: Command = (argv, io) => runGrant(argv, io);
export default grant;

export async function runGrant(argv: string[], rawIo: Io, options: AuthorityEditOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['scope'], ['dry-run']);
  if (args.error || args.rest.length !== 1 || !args.values.scope) {
    io.stderr(`team grant: ${args.error ?? 'a seat and --scope are required'}\n${USAGE}`);
    return 2; // exit: grant.invocation
  }
  const result = await runAuthorityEdit('grant', {
    kind: 'grant', seat: args.rest[0]!, scope: args.values.scope.split(','),
  }, io, { ...options, dryRun: args.flags.has('dry-run') });
  if (result === 'refused') {
    return 1; // exit: grant.refused
  }
  if (result === 'invalid') {
    return 2; // exit: grant.invalid
  }
  return 0; // exit: grant.done
}
