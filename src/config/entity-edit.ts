// `team config get|set <entity>.names.unique …`: the one writer of an entity's own word on seat
// nicknames (src/entities.ts reads it back). The entity's entry lives in the owner's entities
// file; this command changes that one line of an entry the file already declares, and nothing
// else — not the file, not the entry, not a sibling key. It reads no team, so it runs outside a
// checkout. The word is the path's last segment, so the entity may carry dots and is taken by
// stripping the suffix.
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
import { editedRecordText, getAt, withValue } from './team-record.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';
import type { ConfigSources } from '../commands/config.ts';

const KEY = 'names.unique';
const FORM = `team config set <entity>.${KEY} <word>`;

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
  const entityName = (path ?? '').slice(0, -`.${KEY}`.length);
  let why: string | null = args.error ?? null;
  if (why === null && verb === 'unset') {
    why = `an entity's word has no unset: ${FORM} with the word you want (${NICKNAME_SCOPE_DEFAULT} is the default)`;
  }
  if (why === null && verb !== 'get' && verb !== 'set') why = 'the entity form takes get or set';
  if (why === null && verb === 'get' && given > 2) why = `unexpected "${args.rest[2] ?? ''}"`;
  if (why === null && verb === 'set' && given === 2) why = `a value is required: ${FORM}`;
  if (why === null && verb === 'set' && given > 3) why = `unexpected "${args.rest[3] ?? ''}"`;
  if (why === null && (args.flags.has('request') || args.values.approval !== undefined)) {
    why = 'an entity\'s word takes no --request or --approval: the owner runs it, or a seat under the owner\'s general grant';
  }
  if (why === null && (args.values.general !== undefined) !== (args.values.key !== undefined)) why = '--general and --key go together';
  if (why === null && args.values.general !== undefined && verb === 'get') why = '--general takes set';
  if (why === null && !isEntityName(entityName)) {
    why = `"${entityName}" is not an entity name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most`;
  }
  if (why !== null) return usageRefused(io, json, why, usage);

  // The word is judged before any door or file read: the four words are public, the refusal is
  // the same for every caller, and nothing is written whatever the caller's standing.
  if (verb === 'set' && !(NICKNAME_SCOPES as readonly string[]).includes(rawValue as string)) {
    refuse(io, json, 'config', {
      id: 'config.entity.names-value',
      message: `${rawValue === undefined ? 'no word' : `"${rawValue}"`} is not a names.unique word: use ${NICKNAME_SCOPES.join(', ')}; nothing was written`,
      repair: null,
    });
    // exit: config.entity.names-value
    return 1;
  }
  const word = rawValue as NicknameScope;

  const home = sources.home ?? homedir();
  const file = entitiesPath(home);

  if (verb === 'get') {
    if (!existsSync(file)) return noValue(io, json, `${file} does not exist: entity "${entityName}" writes no ${KEY}`);
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
    const got = getAt(record, [entityName, 'names', 'unique']);
    if (!got.found || typeof got.value !== 'string') {
      return noValue(io, json, `entity "${entityName}" writes no ${KEY} in ${file}`);
    }
    if (json) writeJson(io, 'team.config-value', { format: 1, path: `${entityName}.${KEY}`, value: got.value, source: 'entity' });
    else io.stdout(`${got.value}\n`);
    // A word the check does not spell is what the file says, but not what is in force: say so,
    // rather than printing it as if it were read.
    if (!(NICKNAME_SCOPES as readonly string[]).includes(got.value.trim()) && !json) {
      io.stderr(`team config: "${got.value}" is not one of ${NICKNAME_SCOPES.join(', ')}: the default entity is in force\n`);
    }
    // exit: config.entity.value
    return 0;
  }

  // The door: the owner at a terminal, or a seat the owner's general grant covers for this
  // entity. Nothing is read from the file before one of the two admits the write.
  if (args.values.general !== undefined) {
    const admitted = admitGeneral(home, resolve(io.cwd, args.values.general), resolve(io.cwd, args.values.key as string), 'config', entityName, sources.now?.() ?? new Date());
    if (!admitted.ok) {
      refuse(io, json, 'config', { id: 'config.entity.general-refused', message: admitted.why, repair: null });
      // exit: config.entity.general-refused
      return 1;
    }
    if (!json) io.stderr(`team config: admitted by general grant ${admitted.grant.grant_id} (${admitted.grant.client_id})\n`);
  } else {
    const caller = callerOf(rawIo);
    const detached = detachedRefusal(caller);
    if (detached !== undefined) {
      refuse(io, json, 'config', { id: 'config.entity.detached', message: detached, repair: null });
      // exit: config.entity.detached
      return 1;
    }
    if (!isOwner(caller)) {
      refuse(io, json, 'config', {
        id: 'config.entity.not-owner',
        message: `only the owner, or a seat holding the owner's general grant for entity "${entityName}", sets an entity's word; this call is ${describeCaller(caller)}`,
        repair: null,
        rule: 'owner-only',
      });
      // exit: config.entity.not-owner
      return 1;
    }
  }

  if (!existsSync(file)) return pathRefused(io, json, `${file} does not exist: no entry for entity "${entityName}"; nothing was written`);
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
  const entry = getAt(record, [entityName]);
  if (!entry.found) return pathRefused(io, json, `${file}: no entry for entity "${entityName}"; nothing was written`);
  if (!isMap(entry.value)) return pathRefused(io, json, `${file}: entity "${entityName}" is not a map; nothing was written`);
  const changed = withValue(record, [entityName, 'names', 'unique'], word);
  if (!changed.ok) return pathRefused(io, json, `entity "${entityName}" ${KEY}: ${changed.why}; nothing was written`);
  if (!changed.changed) {
    if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${KEY}`, changed: false, source: 'entity', comments_kept: true });
    else io.stdout(`nothing changed in ${file}\n`);
    // exit: config.entity.unchanged
    return 0;
  }
  const edited = editedRecordText(text, [entityName, 'names', 'unique'], word, changed.root);
  writeOwnerFile(file, edited.text);
  if (json) {
    writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${KEY}`, changed: true, source: 'entity', comments_kept: edited.kept });
  } else {
    io.stdout(`set ${entityName}.${KEY}: ${word} in ${file}\n`);
    if (!edited.kept) io.stderr(`team config: the entities file was rewritten whole to change ${entityName}.${KEY}; its comments were not kept\n`);
  }
  // exit: config.entity.written
  return 0;
}
