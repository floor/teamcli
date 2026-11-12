// `team gh`: gh against GitHub with the entity's identity; see src/commands/git.ts.
import type { Command } from '../io.ts';
import { runGitHub, USAGE as GIT_USAGE } from './git.ts';

export const USAGE = `Usage: team gh <arguments>

Runs the gh CLI with the entity's GitHub identity, the token read from the keychain for this one
command and given to that process only. Refused before anything runs: gh commands that merge,
release, delete or rename a repository, write through the API, or touch authentication,
credentials, secrets, keys, variables or settings. team git does the same for git.

Exits with the command's own code, 1 when it is refused or the identity cannot be read, 2 when
the invocation can't be read.
`;

/** Every word after the command goes to gh: the command takes no option of its own. */
export const VALUE_OPTIONS: readonly string[] = [];

const ghCommand: Command = (argv, io) => runGitHub('gh', argv, io);
export default ghCommand;
