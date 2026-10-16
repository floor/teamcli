import { readArgs } from '../args.ts';
import { runAuthorityEdit, type AuthorityEdit, type AuthorityEditOptions } from '../authority-edit.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';

export const USAGE = `Usage: team revoke grant [--dry-run]
       team revoke delegate <session/pane> [--dry-run]
`;
export const revoke: Command = (argv, io) => runRevoke(argv, io);
export default revoke;

export async function runRevoke(argv: string[], rawIo: Io, options: AuthorityEditOptions = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, [], ['dry-run']);
  const target = args.rest[0];
  let edit: AuthorityEdit | undefined;
  if (target === 'grant' && args.rest.length === 1) edit = { kind: 'revoke-grant' };
  if (target === 'delegate' && args.rest.length === 2) edit = { kind: 'revoke-delegate', pane: args.rest[1]! };
  if (args.error || !edit) {
    io.stderr(`team revoke: ${args.error ?? 'name grant, or delegate and its session/pane'}\n${USAGE}`);
    return 2; // exit: revoke.invocation
  }
  const result = await runAuthorityEdit('revoke', edit, io, { ...options, dryRun: args.flags.has('dry-run') });
  if (result === 'refused') {
    return 1; // exit: revoke.refused
  }
  if (result === 'invalid') {
    return 2; // exit: revoke.invalid
  }
  return 0; // exit: revoke.done
}
