// `team config get|set <entity>.<key> …` for the two keys of an entity's own record: the
// `names.unique` word on seat nicknames (src/entities.ts reads it back) and the `reminders` list
// the reminder chore fires (src/reminder/config.ts reads it back). The entity's entry lives in the
// owner's entities file; this command changes that one key of an entry the file already declares,
// and nothing else — not the file, not the entry, not a sibling key. A reminder list is held to
// the daemon's own parser before it is written, so a list the daemon would refuse is never
// stored. It reads no team, so it runs outside a checkout. The key is the path's last segment, so
// the entity may carry dots and is taken by stripping the suffix.
//
// The write is the owner's, at a terminal, or a seat's under the owner's general grant. 0.5.10
// admits a wildcard grant only: a grant that lists entities is refused with the one sentence in
// src/client/general-grant.ts before the op is checked, and the entity is not read. A charter is
// the owner's word for one folder, and this word is not a folder's, so the charter does not admit
// it. There is no owner-seat request: the owner asked that relaxing the check need no answer, and
// the grant is the standing answer.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { admitGeneral } from '../client/general-grant.ts';
import { entitiesPath, NICKNAME_SCOPE_DEFAULT, NICKNAME_SCOPES, type NicknameScope } from '../entities.ts';
import { isEntityName } from '../file/sections/entity.ts';
import { cleanedIo, type Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { editedRecordText, getAt, parseValue, shownValue, withValue } from './team-record.ts';
import { machineZone, readReminders } from '../reminder/config.ts';
import { parseYaml, toValue, YamlError, type YamlNode, type YamlValue } from '../yaml.ts';
import type { ConfigSources } from '../commands/config.ts';

const NAMES_KEY = 'names.unique';
const REMINDERS_KEY = 'reminders';
type EntityKey = typeof NAMES_KEY | typeof REMINDERS_KEY;
const FORM: Record<EntityKey, string> = {
  [NAMES_KEY]: `team config set <entity>.${NAMES_KEY} <word>`,
  [REMINDERS_KEY]: `team config set <entity>.${REMINDERS_KEY} <yaml list>`,
};

/** The invocation is not one the entity form carries out: one refusal with the command's usage,
 *  before the file is read. Exit 2, always. */
function usageRefused(io: Io, json: boolean, message: string, usage: string): number {
  refuse(io, json, 'config', { id: 'config.entity.usage', message, repair: null, usage });
  return 2; // exit: config.entity.usage
}

/** Neither a get nor a set may answer the word: the file the entry lives in cannot be read, and
 *  a writer that guessed at its text would replace it with a guess. Exit 2. */
function unreadable(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.unreadable', message, repair: null });
  return 2; // exit: config.entity.unreadable
}

/** The entry writes no word this command can read: a missing file or entry, or a `names` map
 *  without `unique`. Exit 1, and a get writes nothing ever. */
function noValue(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.no-value', message, repair: null });
  return 1; // exit: config.entity.no-value
}

/** The word's line cannot be reached: the file or the entity's entry is missing, the entry is
 *  not a map, or a value sits on the way to `names.unique`. Nothing is written. Exit 1. */
function pathRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.path', message, repair: null });
  return 1; // exit: config.entity.path
}

/** A reminders value that is not a YAML list: judged before any door or file read, so the refusal
 *  is the same for every caller and nothing is written. Exit 1. */
function remindersValue(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.reminders-value', message, repair: null });
  return 1; // exit: config.entity.reminders-value
}

/** A reminder list the daemon's own parser would refuse (a bad field, a duplicate name, a pair
 *  the state record could not key): the parser's reason, named. Nothing is written. Exit 1. */
function remindersProblem(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.reminders-problem', message, repair: null });
  return 1; // exit: config.entity.reminders-problem
}

/** The write's door refused a general grant: it does not cover this entity or admit this op.
 *  Exit 1. */
function generalRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.general-refused', message, repair: null });
  return 1; // exit: config.entity.general-refused
}

/** The write's door refused a caller with no terminal. Exit 1. */
function detachedRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.entity.detached', message, repair: null });
  return 1; // exit: config.entity.detached
}

/** The write's door refused a caller that is neither the owner nor admitted by the owner's
 *  general grant. Exit 1. */
function notOwnerRefused(io: Io, json: boolean, caller: ReturnType<typeof callerOf>, entityName: string, what: string): number {
  refuse(io, json, 'config', {
    id: 'config.entity.not-owner',
    message: `only the owner, or a seat holding the owner's general grant for entity "${entityName}", ${what}; this call is ${describeCaller(caller)}`,
    repair: null,
    rule: 'owner-only',
  });
  return 1; // exit: config.entity.not-owner
}

/** One line saying why a file's reader refused the text: the parser's own reason, with the line
 *  it names. */
function unreadableReason(error: unknown): string {
  if (error instanceof YamlError) return `line ${error.line}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function isMap(value: YamlValue): value is { [key: string]: YamlValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The entities file written the atomic way the other stores are: a temporary file renamed over
 *  it, at the mode it already had (0600 for a file that appeared between the read and the
 *  write). The owner's own file keeps the permissions they set. */
function writeOwnerFile(path: string, text: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {}
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

export async function runEntityRecordEdit(argv: string[], rawIo: Io, sources: ConfigSources = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['approval', 'general', 'key'], ['json', 'request']);
  const usage = (await import('../commands/config.ts')).USAGE;
  const [verb, path, rawValue] = args.rest;
  const given = args.rest.length;
  const key = entityKeyOf(path);
  const entityName = (path ?? '').slice(0, key === null ? 0 : -(key.length + 1));
  let why: string | null = args.error ?? null;
  if (why === null && key === null) why = `a path names an entity's ${NAMES_KEY} or ${REMINDERS_KEY}`;
  if (why === null && verb === 'unset') {
    why =
      key === NAMES_KEY
        ? `an entity's word has no unset: ${FORM[NAMES_KEY]} with the word you want (${NICKNAME_SCOPE_DEFAULT} is the default)`
        : `an entity's reminders have no unset: ${FORM[REMINDERS_KEY]} with an empty list ([] clears them)`;
  }
  if (why === null && verb !== 'get' && verb !== 'set') why = 'the entity form takes get or set';
  if (why === null && verb === 'get' && given > 2) why = `unexpected "${args.rest[2] ?? ''}"`;
  if (why === null && verb === 'set' && given === 2) why = `a value is required: ${FORM[key as EntityKey]}`;
  if (why === null && verb === 'set' && given > 3) why = `unexpected "${args.rest[3] ?? ''}"`;
  if (why === null && (args.flags.has('request') || args.values.approval !== undefined)) {
    const what = key === NAMES_KEY ? "an entity's word" : "an entity's reminders";
    why = `${what} take${key === NAMES_KEY ? 's' : ''} no --request or --approval: the owner runs it, or a seat under the owner's general grant`;
  }
  if (why === null && (args.values.general !== undefined) !== (args.values.key !== undefined)) why = '--general and --key go together';
  if (why === null && args.values.general !== undefined && verb === 'get') why = '--general takes set';
  if (why === null && !isEntityName(entityName)) {
    why = `"${entityName}" is not an entity name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most`;
  }
  if (why !== null) return usageRefused(io, json, why, usage);

  // The value is judged before any door or file read: its words are public, the refusal is the
  // same for every caller, and nothing is written whatever the caller's standing. A reminder list
  // is judged for shape here and for content by the daemon's own parser after the file is read.
  let word: NicknameScope | null = null;
  let list: YamlValue[] | null = null;
  if (key === NAMES_KEY) {
    if (verb === 'set' && !(NICKNAME_SCOPES as readonly string[]).includes(rawValue as string)) {
      refuse(io, json, 'config', {
        id: 'config.entity.names-value',
        message: `${rawValue === undefined ? 'no word' : `"${rawValue}"`} is not a names.unique word: use ${NICKNAME_SCOPES.join(', ')}; nothing was written`,
        repair: null,
      });
      // exit: config.entity.names-value
      return 1;
    }
    word = rawValue as NicknameScope;
  } else if (verb === 'set') {
    const value = parseValue(rawValue as string);
    if (!Array.isArray(value)) {
      return remindersValue(
        io,
        json,
        `the value is not a YAML list of reminders: write [ ] or [ { name, at, text, to }, … ]; nothing was written`,
      );
    }
    list = value;
  }

  const home = sources.home ?? homedir();
  const file = entitiesPath(home);

  if (verb === 'get') {
    if (!existsSync(file)) return noValue(io, json, `${file} does not exist: entity "${entityName}" writes no ${key as string}`);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      return unreadable(io, json, `${file}: ${(error as Error).message}`);
    }
    let record: YamlValue;
    try {
      record = toValue(parseYaml(text));
    } catch (error) {
      return unreadable(io, json, `${file}: ${unreadableReason(error)}`);
    }
    if (!isMap(record)) return unreadable(io, json, `${file}: expected a map of entities`);
    if (key === REMINDERS_KEY) {
      const got = getAt(record, [entityName, REMINDERS_KEY]);
      if (!got.found || !Array.isArray(got.value)) {
        return noValue(io, json, `entity "${entityName}" writes no reminders in ${file}`);
      }
      if (json) writeJson(io, 'team.config-value', { format: 1, path: `${entityName}.${REMINDERS_KEY}`, value: got.value, source: 'entity' });
      else io.stdout(shownValue(got.value));
    } else {
      const got = getAt(record, [entityName, 'names', 'unique']);
      if (!got.found || typeof got.value !== 'string') {
        return noValue(io, json, `entity "${entityName}" writes no ${NAMES_KEY} in ${file}`);
      }
      if (json) writeJson(io, 'team.config-value', { format: 1, path: `${entityName}.${NAMES_KEY}`, value: got.value, source: 'entity' });
      else io.stdout(`${got.value}\n`);
      // A word the check does not spell is what the file says, but not what is in force: say so,
      // rather than printing it as if it were read.
      if (!(NICKNAME_SCOPES as readonly string[]).includes(got.value.trim()) && !json) {
        io.stderr(`team config: "${got.value}" is not one of ${NICKNAME_SCOPES.join(', ')}: the default entity is in force\n`);
      }
    }
    // exit: config.entity.value
    return 0;
  }

  // The door: the owner at a terminal, or a seat the owner's general grant covers for this
  // entity. Nothing is read from the file before one of the two admits the write.
  if (args.values.general !== undefined) {
    const admitted = admitGeneral(home, resolve(io.cwd, args.values.general), resolve(io.cwd, args.values.key as string), 'config', entityName, sources.now?.() ?? new Date());
    if (!admitted.ok) return generalRefused(io, json, admitted.why);
    if (!json) io.stderr(`team config: admitted by general grant ${admitted.grant.grant_id} (${admitted.grant.client_id})\n`);
  } else {
    const caller = callerOf(rawIo);
    const detached = detachedRefusal(caller);
    if (detached !== undefined) return detachedRefused(io, json, detached);
    if (!isOwner(caller)) {
      return notOwnerRefused(io, json, caller, entityName, key === NAMES_KEY ? "sets an entity's word" : "writes an entity's reminders");
    }
  }

  if (!existsSync(file)) return pathRefused(io, json, `${file} does not exist: no entry for entity "${entityName}"; nothing was written`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return unreadable(io, json, `${file}: ${(error as Error).message}`);
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    return unreadable(io, json, `${file}: ${unreadableReason(error)}`);
  }
  const record = toValue(root);
  if (!isMap(record)) return unreadable(io, json, `${file}: expected a map of entities`);
  const entry = getAt(record, [entityName]);
  if (!entry.found) return pathRefused(io, json, `${file}: no entry for entity "${entityName}"; nothing was written`);
  if (!isMap(entry.value)) return pathRefused(io, json, `${file}: entity "${entityName}" is not a map; nothing was written`);
  // The record nests the word (`<entity>: names: unique:`), while a reminder list sits directly
  // under the entity, beside its roots — the shapes src/entities.ts and src/reminder/config.ts read.
  const recordPath = key === NAMES_KEY ? [entityName, 'names', 'unique'] : [entityName, REMINDERS_KEY];
  const value: YamlValue | undefined = key === NAMES_KEY ? (word as string) : (list as YamlValue[]);
  const changed = withValue(record, recordPath, value);
  if (!changed.ok) return pathRefused(io, json, `entity "${entityName}" ${key as string}: ${changed.why}; nothing was written`);
  if (!changed.changed) {
    if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${key as string}`, changed: false, source: 'entity', comments_kept: true });
    else io.stdout(`nothing changed in ${file}\n`);
    // exit: config.entity.unchanged
    return 0;
  }
  const edited = editedRecordText(text, recordPath, value, changed.root);
  // A reminder list is held to the daemon's own parser on the text that would be written: a
  // problem the file did not already carry (a bad field, a name written twice, a name another
  // entity already holds) refuses the write with the parser's reason, and nothing is written.
  if (key === REMINDERS_KEY) {
    let candidate: YamlNode;
    try {
      candidate = parseYaml(edited.text);
    } catch (error) {
      return unreadable(io, json, `${file}: the edited text cannot be read: ${unreadableReason(error)}`);
    }
    const before = new Set(readReminders(root, { defaultZone: machineZone() }).problems.map(problemKey));
    const introduced = readReminders(candidate, { defaultZone: machineZone() }).problems.find((problem) => !before.has(problemKey(problem)));
    if (introduced !== undefined) return remindersProblem(io, json, introduced.why);
  }
  writeOwnerFile(file, edited.text);
  if (json) {
    writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${key as string}`, changed: true, source: 'entity', comments_kept: edited.kept });
  } else {
    const count = list?.length ?? 0;
    const shown = key === NAMES_KEY ? (word as string) : `${String(count)} reminder${count === 1 ? '' : 's'}`;
    io.stdout(`set ${entityName}.${key as string}: ${shown} in ${file}\n`);
    if (!edited.kept) io.stderr(`team config: the entities file was rewritten whole to change ${entityName}.${key as string}; its comments were not kept\n`);
  }
  // exit: config.entity.written
  return 0;
}

/** The key a `team config get|set <entity>.<key>` path names, stripped from the path's last
 *  segment; null when the last segment is neither key. */
function entityKeyOf(path: string | undefined): EntityKey | null {
  if (path === undefined) return null;
  if (path.endsWith(`.${NAMES_KEY}`)) return NAMES_KEY;
  if (path.endsWith(`.${REMINDERS_KEY}`)) return REMINDERS_KEY;
  return null;
}

/** One problem as a value, so the same complaint before and after an edit compares equal. */
function problemKey(problem: { entity: string | null; name: string | null; why: string }): string {
  return `${problem.entity ?? ''}\u0000${problem.name ?? ''}\u0000${problem.why}`;
}
