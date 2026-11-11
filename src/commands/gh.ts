// `team gh`: gh against GitHub with the entity's identity; see src/commands/git.ts.
import type { Command } from '../io.ts';
import { runGitHub, USAGE as GIT_USAGE } from './git.ts';

export const USAGE = GIT_USAGE;

const ghCommand: Command = (argv, io) => runGitHub('gh', argv, io);
export default ghCommand;
