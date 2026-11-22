// `team config get|set <entity>.<key> …` for the keys of an entity's own record: the
// `names.unique` word on seat nicknames (src/entities.ts reads it back), the `reminders` list
// the reminder chore fires (src/reminder/config.ts reads it back), and the `root` and
// `worktrees` folders the entity's projects and worktrees sit in on this machine, which a team
// file names as `{root}` and `{worktrees}` (src/file/root-word.ts reads them back; `unset`
// removes either). The entity's entry lives in the
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
// it. The third way is the owner's signed answer to this exact write: `--request` records it and
// `--approval <id>` applies it once (`ownerRequestDoor`). It is the only way on a machine whose
// owner seat is pinned from another machine, where no terminal is the owner and no general grant
// stands; the request is carried to the owner's signers as a file (`team approvals export`).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { renameSync, writeFileSync } from '../host/guarded-fs.ts';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { admitGeneral } from '../client/general-grant.ts';
import { ownerRequestDoor } from '../client/owner-action-step.ts';
import { checkedRootPath, ENTITY_ROOT_KEY, ENTITY_WORKTREES_KEY, entitiesPath, lockedEntities, NICKNAME_SCOPE_DEFAULT, NICKNAME_SCOPES, type NicknameScope } from '../entities.ts';
import { loadTeamFile } from '../file/load.ts';
import { isEntityName } from '../file/sections/entity.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import { NAME_POOL_DEFAULT, NAME_POOLS } from '../registry/name-pools.ts';
import { cleanedIo, type Io } from '../io.ts';
import { composedRulesOf, formatComposedRules } from '../launch/rules.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { projectIdOf, ProjectsError, projectsFile, setProjectRules } from '../registry/projects.ts';
import { editedRecordText, getAt, parseValue, shownValue, withValue } from './team-record.ts';
import { machineZone, readReminders } from '../reminder/config.ts';
import { parseYaml, toValue, YamlError, type YamlNode, type YamlValue } from '../yaml.ts';
import type { ConfigSources } from '../commands/config.ts';

const NAMES_KEY = 'names.unique';
/** The entity's two words on handing out seat nicknames (src/registry/names.ts:autoNamePlan). */
const NAMES_AUTO_KEY = 'names.auto';
const NAMES_POOL_KEY = 'names.pool';
/** The three keys of the entity's `names:` map, each written as `<entity>: names: <key>:`. */
function isNamesKey(key: EntityKey | null): key is typeof NAMES_KEY | typeof NAMES_AUTO_KEY | typeof NAMES_POOL_KEY {
  return key === NAMES_KEY || key === NAMES_AUTO_KEY || key === NAMES_POOL_KEY;
}
const REMINDERS_KEY = 'reminders';
const RULES_KEY = 'rules';
const ROOT_KEY = ENTITY_ROOT_KEY;
const WORKTREES_KEY = ENTITY_WORKTREES_KEY;
/** The entity's two folders on this machine: the projects root and the worktrees folder. */
function isFolderKey(key: EntityKey | null): key is typeof ROOT_KEY | typeof WORKTREES_KEY {
  return key === ROOT_KEY || key === WORKTREES_KEY;
}
/** How a refusal or a report names a folder key. */
function folderLabel(key: EntityKey | null): string {
  return key === WORKTREES_KEY ? 'worktrees folder' : 'projects root';
}
/** The reserved path the composed view answers to. A leading `@` is a shape no entity name can
 *  take (`isEntityName` starts with a letter or a digit), so the view cannot shadow an entity
 *  called `composed`, and `composed.rules` stays that entity's own stored rules. */
const COMPOSED_PATH = '@composed.rules';
type EntityKey = typeof NAMES_KEY | typeof NAMES_AUTO_KEY | typeof NAMES_POOL_KEY | typeof REMINDERS_KEY | typeof RULES_KEY | typeof ROOT_KEY | typeof WORKTREES_KEY;
const FORM: Record<EntityKey, string> = {
  [ROOT_KEY]: `team config set <entity>.${ROOT_KEY} <folder> [--dry-run]`,
  [WORKTREES_KEY]: `team config set <entity>.${WORKTREES_KEY} <folder> [--dry-run]`,
  [NAMES_KEY]: `team config set <entity>.${NAMES_KEY} <word>`,
  [NAMES_AUTO_KEY]: `team config set <entity>.${NAMES_AUTO_KEY} on|off`,
  [NAMES_POOL_KEY]: `team config set <entity>.${NAMES_POOL_KEY} <pool>|[<name>, …]`,
  [REMINDERS_KEY]: `team config set <entity>.${REMINDERS_KEY} <yaml list>`,
  [RULES_KEY]: `team config set <entity>.${RULES_KEY} <yaml list> [--dry-run]`,
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

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** The entities file written the atomic way the other stores are: a temporary file renamed over
 *  it, at the mode it already had (0600 for a file that appeared between the read and the
 *  write). The owner's own file keeps the permissions they set.
 *
 *  It is written here, not as a signed settings record beside `writeConfigSet` and
 *  `writePolicySet`: `entities.yaml` is the owner's own file of words — the `names.unique` write
 *  has always gone through this function — and the reminder path reads the file itself
 *  (`src/reminder/config.ts`, through `entitiesPath`), never the signed chain under the registry.
 *  A signed record here would be a value nothing reads. The door is the same as the word's:
 *  the owner at a terminal, or the owner's general grant. */
function writeOwnerFile(path: string, text: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {}
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

function hasEntitiesWrapper(record: Record<string, YamlValue>): boolean {
  return (
    Object.keys(record).length === 1 &&
    Object.hasOwn(record, 'entities') &&
    isMap(record.entities as YamlValue)
  );
}

export async function runEntityRecordEdit(argv: string[], rawIo: Io, sources: ConfigSources = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const dryRun = argv.includes('--dry-run');
  const args = readArgs(
    argv.filter((arg) => arg !== '--dry-run'),
    ['approval', 'general', 'key', 'reason'],
    ['json', 'request'],
  );
  const usage = (await import('../commands/config.ts')).USAGE;
  const [verb, path, rawValue] = args.rest;
  const given = args.rest.length;
  const key = entityKeyOf(path);
  const entityName = (path ?? '').slice(0, key === null ? 0 : -(key.length + 1));
  const isProjectRules =
    key === RULES_KEY && (entityName.startsWith('project.') || entityName.startsWith('projects.'));
  const targetName = isProjectRules ? entityName.replace(/^projects?\./, '') : entityName;
  let why: string | null = args.error ?? null;
  if (why === null && key === null) why = `a path names an entity's ${NAMES_KEY}, ${NAMES_AUTO_KEY}, ${NAMES_POOL_KEY}, ${REMINDERS_KEY}, ${RULES_KEY}, ${ROOT_KEY}, or ${WORKTREES_KEY}`;
  if (why === null && isFolderKey(key) && isProjectRules) why = `a ${folderLabel(key)} is an entity's, not a project's: ${FORM[key]}`;
  if (why === null && verb !== 'get' && path === COMPOSED_PATH) {
    why = `${COMPOSED_PATH} is a view of the rules in force, not a stored value: it takes no set or unset; \`team config get ${COMPOSED_PATH}\` reads it`;
  }
  if (why === null && verb === 'unset' && !isFolderKey(key)) {
    why =
      isNamesKey(key)
        ? `an entity's word has no unset: ${FORM[key]} with the word you want (${key === NAMES_KEY ? NICKNAME_SCOPE_DEFAULT : key === NAMES_AUTO_KEY ? 'on' : NAME_POOL_DEFAULT} is the default)`
        : key === RULES_KEY
          ? `rules have no unset: ${FORM[RULES_KEY]} with an empty list ([] clears them)`
          : `an entity's reminders have no unset: ${FORM[REMINDERS_KEY]} with an empty list ([] clears them)`;
  }
  if (why === null && verb !== 'get' && verb !== 'set' && !(verb === 'unset' && isFolderKey(key))) why = 'the entity form takes get or set';
  if (why === null && verb === 'unset' && given > 2) why = `unexpected "${args.rest[2] ?? ''}"`;
  if (why === null && verb === 'get' && given > 2) why = `unexpected "${args.rest[2] ?? ''}"`;
  if (why === null && verb === 'set' && given === 2) why = `a value is required: ${FORM[key as EntityKey]}`;
  if (why === null && verb === 'set' && given > 3) why = `unexpected "${args.rest[3] ?? ''}"`;
  const asked = args.flags.has('request') || args.values.approval !== undefined;
  if (why === null && asked && verb === 'get') why = '--request and --approval take set or unset: a get is any caller\'s';
  if (why === null && args.flags.has('request') && args.values.approval !== undefined) why = '--request asks the owner seat and --approval runs an answered request: pass one';
  if (why === null && asked && args.values.general !== undefined) why = '--general admits the write by a grant, and --request or --approval by the owner\'s answer: pass one';
  if (why === null && args.values.reason !== undefined && !args.flags.has('request')) why = '--reason goes with --request';
  if (why === null && (args.values.general !== undefined) !== (args.values.key !== undefined)) why = '--general and --key go together';
  if (why === null && args.values.general !== undefined && verb === 'get') why = `--general takes set${isFolderKey(key) ? ' or unset' : ''}`;
  if (why === null && path !== COMPOSED_PATH && !isEntityName(targetName)) {
    why = `"${targetName}" is not an entity name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most`;
  }
  if (why !== null) return usageRefused(io, json, why, usage);

  // The value is judged before any door or file read: its words are public, the refusal is the
  // same for every caller, and nothing is written whatever the caller's standing. A reminder list
  // is judged for shape here and for content by the daemon's own parser after the file is read.
  let word: NicknameScope | null = null;
  // The `names.auto` word or the `names.pool` value, as it is written.
  let namesValue: YamlValue | null = null;
  let list: YamlValue[] | null = null;
  // The folder as the owner writes it (`~/…` stays `~/…` in the file), and the path it reads as here.
  let folder: { written: string; path: string } | null = null;
  const home = sources.home ?? homedir();
  if (isFolderKey(key)) {
    if (verb === 'set') {
      const checked = checkedRootPath(rawValue as string, home);
      if (!checked.ok) {
        refuse(io, json, 'config', {
          id: 'config.entity.root-value',
          message: `${checked.why}; nothing was written`,
          repair: null,
        });
        // exit: config.entity.root-value
        return 1;
      }
      folder = { written: (rawValue as string).trim().replace(/(.)\/+$/, '$1'), path: checked.root };
    }
  } else if (key === NAMES_KEY) {
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
  } else if (key === NAMES_AUTO_KEY || key === NAMES_POOL_KEY) {
    if (verb === 'set') {
      const value = key === NAMES_AUTO_KEY ? (rawValue as string).trim() : parseValue(rawValue as string);
      const problem = key === NAMES_AUTO_KEY
        ? (value === 'on' || value === 'off' ? null : `"${rawValue as string}" is not a names.auto word: use on or off`)
        : typeof value === 'string'
          ? (Object.hasOwn(NAME_POOLS, value) ? null : `"${value}" is no built-in pool: use ${Object.keys(NAME_POOLS).join(', ')}, or a YAML list of names`)
          : Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && SEAT_NAME.test(item) && item !== 'lead' && item !== 'daemon')
            ? null
            : 'a names.pool list is one or more names, each letters, digits, ".", "_" and "-", never lead or daemon';
      if (problem !== null) {
        refuse(io, json, 'config', { id: 'config.entity.names-value', message: `${problem}; nothing was written`, repair: null });
        // exit: config.entity.names-value
        return 1;
      }
      namesValue = value;
    }
  } else if (key === RULES_KEY && verb === 'set') {
    const value = parseValue(rawValue as string);
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === 'string' && item.trim().length > 0)
    ) {
      return remindersValue(
        io,
        json,
        'the value is not a YAML list of rule strings: write [ ] or [ "rule", … ]; nothing was written',
      );
    }
    list = (value as string[]).map((item) => item.trim());
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

  const file = isProjectRules ? projectsFile(home) : entitiesPath(home);

  if (verb === 'get' && path === COMPOSED_PATH) {
    const loaded = loadTeamFile(io.cwd, { home });
    if (!loaded.ok) return noValue(io, json, loaded.errors.map((e) => e.message).join('; '));
    const seat = loaded.team.seats[0];
    if (!seat) return noValue(io, json, 'team has no seats');
    if (json) {
      writeJson(io, 'team.config-value', {
        format: 1,
        path: COMPOSED_PATH,
        value: composedRulesOf(loaded.team, seat, loaded.root, undefined, 'file', home),
        source: 'composed',
      });
    } else {
      io.stdout(formatComposedRules(loaded.team, seat, loaded.root, undefined, home));
    }
    // exit: config.entity.composed-value
    return 0;
  }

  if (verb === 'get') {
    if (!existsSync(file)) {
      return noValue(
        io,
        json,
        `${file} does not exist: ${isProjectRules ? 'project' : 'entity'} "${targetName}" writes no ${key as string}`,
      );
    }
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
    if (!isMap(record)) return unreadable(io, json, `${file}: expected a map of ${isProjectRules ? 'projects' : 'entities'}`);
    if (key === REMINDERS_KEY || key === RULES_KEY) {
      let resolvedTarget = targetName;
      if (isProjectRules && isMap(record.projects) && !Object.hasOwn(record.projects, resolvedTarget)) {
        const byDisplay = Object.entries(record.projects).find(
          ([, raw]) => isMap(raw) && raw.name === targetName,
        );
        if (byDisplay) {
          resolvedTarget = byDisplay[0];
        } else {
          try {
            const derived = projectIdOf(targetName);
            if (Object.hasOwn(record.projects, derived)) resolvedTarget = derived;
          } catch {}
        }
      }
      const lookupPath = isProjectRules
        ? ['projects', resolvedTarget, key]
        : hasEntitiesWrapper(record)
          ? ['entities', targetName, key]
          : [targetName, key];
      const got = getAt(record, lookupPath);
      if (!got.found || !Array.isArray(got.value)) {
        return noValue(io, json, `${isProjectRules ? 'project' : 'entity'} "${targetName}" writes no ${key} in ${file}`);
      }
      if (json) writeJson(io, 'team.config-value', { format: 1, path: `${entityName}.${key}`, value: got.value, source: isProjectRules ? 'project' : 'entity' });
      else io.stdout(shownValue(got.value));
    } else if (isFolderKey(key)) {
      const got = getAt(record, hasEntitiesWrapper(record) ? ['entities', entityName, key] : [entityName, key]);
      if (!got.found || typeof got.value !== 'string') {
        const reads = key === WORKTREES_KEY ? `; its worktrees sit in <root>/worktrees` : '';
        return noValue(io, json, `entity "${entityName}" names no ${folderLabel(key)} in ${file}${reads}`);
      }
      const checked = checkedRootPath(got.value, home);
      if (json) {
        writeJson(io, 'team.config-value', {
          format: 1,
          path: `${entityName}.${key}`,
          value: got.value,
          source: 'entity',
          ...(checked.ok ? { resolved: checked.root } : { problem: checked.why }),
        });
      } else {
        io.stdout(`${got.value}\n`);
        // A word the reader refuses is what the file says, not what is in force: say so.
        if (!checked.ok) io.stderr(`team config: ${checked.why}: a team that writes {root} is refused until it is set again\n`);
      }
    } else if (key === NAMES_AUTO_KEY || key === NAMES_POOL_KEY) {
      const sub = key.slice('names.'.length);
      const got = getAt(record, hasEntitiesWrapper(record) ? ['entities', entityName, 'names', sub] : [entityName, 'names', sub]);
      if (!got.found) return noValue(io, json, `entity "${entityName}" writes no ${key} in ${file}`);
      if (json) writeJson(io, 'team.config-value', { format: 1, path: `${entityName}.${key}`, value: got.value, source: 'entity' });
      else io.stdout(shownValue(got.value));
    } else {
      const lookupPath = hasEntitiesWrapper(record)
        ? ['entities', entityName, 'names', 'unique']
        : [entityName, 'names', 'unique'];
      const got = getAt(record, lookupPath);
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

  // The door: the owner at a terminal, a seat the owner's general grant covers for this entity,
  // or the owner's signed answer to exactly this write. Nothing is read from the file before one
  // of the three admits the write. An answer binds the file's folder, the entity and the words.
  // It is checked first with nothing claimed, then the write is tried with nothing written, and
  // only a write that would go through spends the answer.
  const door = (dry: boolean) => ownerRequestDoor(
    'config',
    'team-entity-config',
    argv,
    { request: args.flags.has('request'), approval: args.values.approval, dry, json, ...(args.values.reason === undefined ? {} : { reason: args.values.reason }) },
    io,
    { home, ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) },
    // Bound as the parser read the line — the verb, the path and the value — and the file it
    // writes, so the card can show the exact change and the run writes nothing else.
    { root: dirname(file), team: targetName, head: null, words: [...args.rest, `file=${file}`] },
  );
  let spendAnswer = false;
  // A project's rules through an answer name the project by its id, exactly: a display name can
  // later be moved to another project, so it is never what an answer binds. The write under the
  // lock then requires that same id.
  if (asked && isProjectRules) {
    const exact = exactProjectId(file, targetName);
    if (exact !== null) return pathRefused(io, json, exact);
  }
  if (asked) {
    const step = door(true);
    if (step.kind === 'requested') {
      // exit: config.entity.approval-requested
      return 0;
    }
    if (step.kind !== 'admitted') {
      // exit: config.entity.approval-refused
      return 1;
    }
    spendAnswer = !dryRun;
  } else if (args.values.general !== undefined) {
    const admitted = admitGeneral(home, resolve(io.cwd, args.values.general), resolve(io.cwd, args.values.key as string), 'config', targetName, sources.now?.() ?? new Date());
    if (!admitted.ok) return generalRefused(io, json, admitted.why);
    if (!json) io.stderr(`team config: admitted by general grant ${admitted.grant.grant_id} (${admitted.grant.client_id})\n`);
  } else {
    const caller = callerOf(rawIo);
    const detached = detachedRefusal(caller);
    if (detached !== undefined) return detachedRefused(io, json, detached);
    if (!isOwner(caller)) {
      const actionLabel =
        isNamesKey(key)
          ? "sets an entity's word"
          : isFolderKey(key)
            ? `sets an entity's ${folderLabel(key)}`
          : key === RULES_KEY
            ? isProjectRules
              ? "writes a project's rules"
              : "writes an entity's rules"
            : "writes an entity's reminders";
      return notOwnerRefused(io, json, caller, targetName, actionLabel);
    }
  }

  // An answer is spent only by a write that goes through, inside the file's lock: the write is
  // planned under the lock, a plan that is refused keeps the answer for a corrected run, and the
  // answer is claimed just before the planned text is written (or, for a value already in place,
  // before the unchanged plan returns).
  const spend = (): boolean => door(false).kind === 'admitted';

  if (isProjectRules) {
    let outcome: ReturnType<typeof setProjectRules>;
    try {
      outcome = setProjectRules(home, targetName, list as string[], {
        dryRun,
        allowDisplayName: !asked,
        ...(spendAnswer ? { claim: spend } : {}),
      });
    } catch (error) {
      const msg = error instanceof ProjectsError || error instanceof Error ? error.message : String(error);
      if (msg.endsWith('; nothing was written')) {
        return pathRefused(io, json, msg);
      }
      return unreadable(io, json, msg);
    }
    // exit: config.entity.approval-refused
    if (outcome.claimRefused === true) return 1;
    if (!outcome.changed) {
      if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${key as string}`, changed: false, ...(dryRun ? { dry_run: true } : {}), source: 'project', comments_kept: true });
      else io.stdout(`nothing changed in ${file}\n`);
      // exit: config.project.rules-unchanged
      return 0;
    }
    if (json) {
      writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${key as string}`, changed: true, ...(dryRun ? { dry_run: true } : {}), source: 'project', comments_kept: outcome.kept });
    } else {
      const count = list?.length ?? 0;
      const shown = `${String(count)} rule${count === 1 ? '' : 's'}`;
      if (dryRun) {
        io.stdout(`dry-run: would set ${entityName}.${key as string}: ${shown} in ${file}\n${outcome.after}`);
      } else {
        io.stdout(`set ${entityName}.${key as string}: ${shown} in ${file}\n`);
        if (!outcome.kept) io.stderr(`team config: the projects file was rewritten whole to change ${entityName}.${key as string}; its comments were not kept\n`);
      }
    }
    // exit: config.project.rules-written
    return 0;
  }

  const entitiesFile = entitiesPath(home);
  const runEntityWrite = (write: boolean = !dryRun, claim?: () => boolean):
    | { kind: 'claim-refused' }
    | { kind: 'path'; why: string }
    | { kind: 'unreadable'; why: string }
    | { kind: 'reminders-problem'; why: string }
    | { kind: 'unchanged' }
    | { kind: 'written'; text: string; kept: boolean } => {
    // A projects root is the first word a fresh machine needs, before any other entry exists: a
    // set makes the file and the entry when they are missing, and an unset of a root that is not
    // there changes nothing. Every other key keeps to an entry the file already declares.
    const makesEntry = isFolderKey(key) && verb === 'set';
    // Every outcome that stands as done spends an answer the run carries, a value already absent
    // included, so a replay of the same answer is refused as any replay is.
    const done = (): { kind: 'unchanged' } | { kind: 'claim-refused' } => (claim !== undefined && !claim() ? { kind: 'claim-refused' } : { kind: 'unchanged' });
    if (isFolderKey(key) && verb === 'unset' && !existsSync(entitiesFile)) return done();
    if (!existsSync(entitiesFile) && !makesEntry) {
      return {
        kind: 'path',
        why: `${entitiesFile} does not exist: no entry for entity "${targetName}"; nothing was written`,
      };
    }
    let text = '';
    try {
      if (existsSync(entitiesFile)) text = readFileSync(entitiesFile, 'utf8');
    } catch (error) {
      return {
        kind: 'unreadable',
        why: `${entitiesFile}: ${(error as Error).message}`,
      };
    }
    let root: YamlNode;
    try {
      root = text.trim() === '' ? { kind: 'map', line: 1, entries: [] } : parseYaml(text);
    } catch (error) {
      return {
        kind: 'unreadable',
        why: `${entitiesFile}: ${unreadableReason(error)}`,
      };
    }
    const record = toValue(root);
    if (!isMap(record)) {
      return {
        kind: 'unreadable',
        why: `${entitiesFile}: expected a map of entities`,
      };
    }
    const wrapped = hasEntitiesWrapper(record);
    const entryLookup = wrapped ? ['entities', targetName] : [targetName];
    const entry = getAt(record, entryLookup);
    if (!entry.found && isFolderKey(key) && verb === 'unset') return done();
    if (!entry.found && !makesEntry) {
      return {
        kind: 'path',
        why: `${entitiesFile}: no entry for entity "${targetName}"; nothing was written`,
      };
    }
    if (entry.found && !isMap(entry.value)) {
      return {
        kind: 'path',
        why: `${entitiesFile}: entity "${targetName}" is not a map; nothing was written`,
      };
    }
    // The record nests the word (`<entity>: names: unique:`), while a reminder or rules list sits
    // directly under the entity.
    const recordPath =
      isNamesKey(key)
        ? [...entryLookup, 'names', key.slice('names.'.length)]
        : [...entryLookup, key as string];
    const value: YamlValue | undefined =
      key === NAMES_KEY ? (word as string) : isNamesKey(key) ? (namesValue as YamlValue) : isFolderKey(key) ? folder?.written : (list as YamlValue[]);
    const changed = withValue(record, recordPath, value);
    if (!changed.ok) {
      return {
        kind: 'path',
        why: `entity "${targetName}" ${key as string}: ${changed.why}; nothing was written`,
      };
    }
    if (!changed.changed) return done();
    const edited = editedRecordText(text, recordPath, value, changed.root);
    // A reminder list is held to the daemon's own parser on the text that would be written. A
    // problem on this entity refuses the write with the parser's reason, whatever the file carried
    // before the edit — the text stored must be one the daemon reads whole, and a list that already
    // held a bad entry would otherwise keep it as if the edit had cured it. A problem on another
    // entity refuses only when this edit introduced it: renaming a reminder can make a later
    // entity's entry the duplicate, and the parser names that entity. A problem another entity
    // already carried is not this call's subject and never blocks the write.
    if (key === REMINDERS_KEY) {
      let candidate: YamlNode;
      try {
        candidate = parseYaml(edited.text);
      } catch (error) {
        return {
          kind: 'unreadable',
          why: `${entitiesFile}: the edited text cannot be read: ${unreadableReason(error)}`,
        };
      }
      const before = new Set(readReminders(root, { defaultZone: machineZone() }).problems.map(problemKey));
      const refused = readReminders(candidate, { defaultZone: machineZone() }).problems.find(
        (problem) => problem.entity === null || problem.entity === entityName || !before.has(problemKey(problem)),
      );
      if (refused !== undefined) return { kind: 'reminders-problem', why: refused.why };
    }
    if (claim !== undefined && !claim()) return { kind: 'claim-refused' };
    if (write) {
      writeOwnerFile(entitiesFile, edited.text);
    }
    return { kind: 'written', text: edited.text, kept: edited.kept };
  };

  let entityOutcome: ReturnType<typeof runEntityWrite>;
  try {
    if (spendAnswer) {
      // Planned, claimed and written under the one lock. A plan that is refused spends nothing,
      // and its refusal is said below; one that changes nothing is the write the owner answered,
      // already in place, and spends the answer as a write would, so a replay is refused.
      entityOutcome = lockedEntities(home, () => runEntityWrite(true, spend));
    } else {
      entityOutcome = dryRun ? runEntityWrite() : lockedEntities(home, () => runEntityWrite());
    }
  } catch (error) {
    return unreadable(io, json, error instanceof Error ? error.message : String(error));
  }
  // exit: config.entity.approval-refused
  if (entityOutcome.kind === 'claim-refused') return 1;
  if (entityOutcome.kind === 'path') return pathRefused(io, json, entityOutcome.why);
  if (entityOutcome.kind === 'unreadable') return unreadable(io, json, entityOutcome.why);
  if (entityOutcome.kind === 'reminders-problem') return remindersProblem(io, json, entityOutcome.why);
  if (entityOutcome.kind === 'unchanged') {
    if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${key as string}`, changed: false, ...(dryRun ? { dry_run: true } : {}), source: 'entity', comments_kept: true });
    else io.stdout(`nothing changed in ${entitiesFile}\n`);
    // exit: config.entity.unchanged
    return 0;
  }
  if (json) {
    writeJson(io, 'team.config-edit', { format: 1, verb, path: `${entityName}.${key as string}`, changed: true, ...(dryRun ? { dry_run: true } : {}), source: 'entity', comments_kept: entityOutcome.kept });
  } else {
    const count = list?.length ?? 0;
    const itemLabel = key === RULES_KEY ? 'rule' : 'reminder';
    const shown =
      key === NAMES_KEY
        ? (word as string)
        : isNamesKey(key)
          ? (Array.isArray(namesValue) ? `${String(namesValue.length)} name${namesValue.length === 1 ? '' : 's'}` : String(namesValue))
        : isFolderKey(key)
          ? folder === null ? 'removed' : folder.written === folder.path ? folder.path : `${folder.written} (${folder.path})`
          : `${String(count)} ${itemLabel}${count === 1 ? '' : 's'}`;
    const done = isFolderKey(key) && verb === 'unset' ? 'unset' : 'set';
    if (dryRun) {
      io.stdout(`dry-run: would ${done} ${entityName}.${key as string}: ${shown} in ${entitiesFile}\n${entityOutcome.text}`);
    } else {
      io.stdout(`${done} ${entityName}.${key as string}: ${shown} in ${entitiesFile}\n`);
      // What the change means for the entity's teams: `{root}` in their files reads the new folder.
      if (isFolderKey(key)) {
        const word = key === WORKTREES_KEY ? '{worktrees}' : '{root}';
        io.stderr(folder === null
          ? key === WORKTREES_KEY
            ? `team config: teams of entity "${entityName}" read {worktrees} as <root>/worktrees again\n`
            : `team config: a team of entity "${entityName}" that writes {root} is now refused until a root is set again\n`
          : `team config: teams of entity "${entityName}" read ${word} as ${folder.path}\n`);
      }
      if (!entityOutcome.kept) io.stderr(`team config: the entities file was rewritten whole to change ${entityName}.${key as string}; its comments were not kept\n`);
    }
  }
  // exit: config.entity.written
  return 0;
}

/** Why `name` is not the exact id of a project in `file`, naming the id when `name` is a display
 *  name; null when it is one. */
function exactProjectId(file: string, name: string): string | null {
  let projects: YamlValue | undefined;
  try {
    const record = toValue(parseYaml(readFileSync(file, 'utf8')));
    projects = isMap(record) ? record.projects : undefined;
  } catch {
    return `${file} cannot be read, so project "${name}" cannot be named exactly; nothing was recorded or written`;
  }
  if (isMap(projects) && Object.hasOwn(projects, name)) return null;
  const byName = isMap(projects) ? Object.entries(projects).find(([, raw]) => isMap(raw) && raw.name === name) : undefined;
  if (byName !== undefined) return `"${name}" is a project's display name; an owner-seat answer binds the project's id: use project.${byName[0]}.rules; nothing was recorded or written`;
  return `no project has the id "${name}" in ${file}; an owner-seat answer binds a project's id; nothing was recorded or written`;
}

/** One problem as a value, so the same complaint before and after an edit compares equal. */
function problemKey(problem: { entity: string | null; name: string | null; why: string }): string {
  return `${problem.entity ?? ''}\u0000${problem.name ?? ''}\u0000${problem.why}`;
}

/** The key a `team config get|set <entity>.<key>` path names, stripped from the path's last
 *  segment; null when the last segment is none of the entity/project keys. */
function entityKeyOf(path: string | undefined): EntityKey | null {
  if (path === undefined) return null;
  if (path.endsWith(`.${NAMES_KEY}`)) return NAMES_KEY;
  if (path.endsWith(`.${NAMES_AUTO_KEY}`)) return NAMES_AUTO_KEY;
  if (path.endsWith(`.${NAMES_POOL_KEY}`)) return NAMES_POOL_KEY;
  if (path.endsWith(`.${ROOT_KEY}`) && path.length > ROOT_KEY.length + 1) return ROOT_KEY;
  if (path.endsWith(`.${WORKTREES_KEY}`) && path.length > WORKTREES_KEY.length + 1) return WORKTREES_KEY;
  if (path.endsWith(`.${REMINDERS_KEY}`)) return REMINDERS_KEY;
  if (path.endsWith(`.${RULES_KEY}`) && path.length > RULES_KEY.length + 1) return RULES_KEY;
  return null;
}

