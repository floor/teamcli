// A session name is a key in the team state's `sessions` map (`team.state.json`), and every
// object inherits `__proto__`, `constructor` and `prototype`: a lookup keyed by one of those
// would find the inherited object instead of a record the team stored, and a write through it
// would land on the shared prototype. The team file refuses the three at its session field
// (`src/file/sections/session.ts`); a command line's `--session` is the other way a name reaches
// the state, so the same rule is applied where the flag is read (`src/args.ts` and
// `src/commands/check.ts`), before any command's lookup or write.
//
// The state's sessions map is built without a prototype wherever it enters the program
// (`sessionMap` in `src/state.ts`), so a name that reached a read some other way still finds the
// team's own record or nothing at all.

/** The names every object inherits, which no session may be. */
export const INHERITED_SESSION_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Why `name` cannot be a session, or null when it can be one. One sentence for every door. */
export function sessionNameRefusal(name: string): string | null {
  if (!INHERITED_SESSION_NAMES.has(name)) return null;
  return `session can't be "${name}": every object inherits that name, so a session lookup by it would not find the team's own record`;
}
