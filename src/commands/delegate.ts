import { readArgs } from '../args.ts';
import { runAuthorityEdit } from '../authority-edit.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team delegate <session/pane> --commands <act,...> [--dry-run] [--json]

Exits 0 when the delegate is written or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.
`;

export const delegate: Command = (argv, io) => runDelegate(argv, io);
export default delegate;

/** Add or replace one external delegate. Authority and record validation share the same
 * owner-only editor as grant and revoke; an existing delegate cannot widen its own entry. */
export async function runDelegate(argv: string[], io: Io, sources: { home?: string } = {}): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['commands'], ['dry-run', 'json']);
  const pane = args.rest[0];
  const commands = args.values.commands;
  if (args.error || args.rest.length !== 1 || !pane || commands === undefined) {
    const extra = args.rest[1];
    const message = args.error ?? (extra !== undefined
      ? `unexpected "${plainLine(extra)}"`
      : !pane ? 'a <session/pane> is required' : '--commands is required');
    if (json) {
      writeJsonError(io, 'delegate.invocation', plainLine(message), null);
    } else {
      out.stderr(`team delegate: ${plainLine(message)}\n${USAGE}`);
    }
    // exit: delegate.invocation
    return 2;
  }
  const result = await runAuthorityEdit('delegate', { kind: 'delegate', pane, commands: commands.split(',') }, io, {
    home: sources.home,
    dryRun: args.flags.has('dry-run'),
    json,
  });
  if (result === 'refused') {
    // exit: delegate.refused
    return 1;
  }
  if (result === 'invalid') {
    // exit: delegate.invalid
    return 2;
  }
  // exit: delegate.done
  return 0;
}
