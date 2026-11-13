// A key on a seat's own launch line is named, never written: the word `NAME={secret:<entry>}`
// stands where the line sets one of its leading variables, and the launch fills it with the
// machine's secret store's own lookup of that entry (src/secrets/store.ts), as one double-quoted
// `$(…)` word, the form a shipped provider launcher's key word already takes. The pane's shell
// runs the lookup when the seat starts, so the key never passes through TeamCLI, its records or
// its logs, and a team file carries no store command of any one machine: the same line launches
// wherever the store holds the entry.
//
// Only a leading assignment's whole value is filled, read through the launch readers
// (`leadingAssignments` in src/profiles/profile.ts). There a shell does not split the
// substitution and hands its output to no program as an argument; anywhere else the key would
// become an argument, so such a word refuses the launch rather than being guessed at. A line
// with no secret word is returned unchanged, byte for byte: a line an earlier swap wrote with its
// own lookup launches exactly as it did.
import { leadingAssignments } from '../profiles/profile.ts';
import { NO_SECRET_STORE, type SecretStore } from '../secrets/store.ts';

/** The one form a secret word takes: a leading variable whose whole value names an entry. The
 *  entry is a plain word (`SECRET_NAME` in src/secrets/run.ts), so nothing in it needs quoting. */
const SECRET_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=\{secret:([A-Za-z0-9][A-Za-z0-9._-]*)\}$/;

/** What marks a secret word anywhere on a line. */
const MARK = '{secret:';

/** A launch line with its secret words filled, or why it cannot be. `entries` names what was
 *  filled, in order; empty for a line that carries none. */
export type SecretFill = { ok: true; line: string; entries: string[] } | { ok: false; why: string };

/** Whether a launch line names a secret at all. */
export function hasSecretWord(line: string): boolean {
  return line.includes(MARK);
}

/** The secret word a profile writes for `entry`, as the value of `name`. */
export function secretWord(name: string, entry: string): string {
  return `${name}={secret:${entry}}`;
}

/**
 * Fills every secret word of `line` with `store`'s lookup command. A store that is absent or has
 * no lookup for an entry on this machine refuses, with the store's own reason, which never names
 * a value. Nothing is read here: the lookup names the entry only.
 */
export function fillSecretWords(line: string, store: SecretStore | null): SecretFill {
  if (!hasSecretWord(line)) return { ok: true, line, entries: [] };
  const leading = leadingAssignments(line);
  if (leading === null) return { ok: false, why: 'its launch line names a secret, and its words cannot be read' };
  let out = '';
  let cursor = 0;
  const entries: string[] = [];
  for (const word of leading) {
    const match = SECRET_WORD.exec(word.source);
    if (match === null) {
      if (word.source.includes(MARK)) {
        return { ok: false, why: `its launch line names a secret outside a variable's whole value (\`${word.source}\`)` };
      }
      continue;
    }
    if (store === null) return { ok: false, why: NO_SECRET_STORE };
    const lookup = store.lookupCommand(match[2]!);
    if (!lookup.ok) return { ok: false, why: lookup.reason };
    out += `${line.slice(cursor, word.start)}${match[1]}="$(${lookup.command})"`;
    cursor = word.end;
    entries.push(match[2]!);
  }
  // Past the leading assignments a secret word would reach a program as an argument.
  const rest = line.slice(leading.at(-1)?.end ?? 0);
  if (rest.includes(MARK)) {
    return { ok: false, why: 'its launch line names a secret after its leading variables: only a leading variable may hold one' };
  }
  return { ok: true, line: out + line.slice(cursor), entries };
}
