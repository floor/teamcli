import { sessionNameRefusal } from './session-names.ts';

// A command's options: `--name value` for the names in `valued`, `--name` alone for the names in
// `flags`. Anything else that starts with "--" is an error; the rest are positional.
export type Args = { values: Record<string, string>; flags: Set<string>; rest: string[]; error?: string };

export function readArgs(argv: string[], valued: string[], flags: string[]): Args {
  const args: Args = { values: {}, flags: new Set(), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      args.rest.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (flags.includes(name) && inline === undefined) args.flags.add(name);
    else if (valued.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') return { ...args, error: `--${name} needs a value` };
      // `--session` names a key in the team state's sessions map. The three names every object
      // inherits are refused here, where the flag is read: every command that takes a session
      // reads its line through this parser, so the refusal stands before any of them looks the
      // name up or writes through it (src/session-names.ts), and the team file's own door is the
      // same sentence.
      if (name === 'session') {
        const refusal = sessionNameRefusal(value);
        if (refusal !== null) return { ...args, error: refusal };
      }
      args.values[name] = value;
    } else return { ...args, error: `unknown option --${name}` };
  }
  return args;
}
