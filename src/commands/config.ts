// `team config` — two things. `keys` prints the settings registry above a seat (what may be set,
// at which levels, under which policy); it reads no team. `get`, `set`, `unset` and `edit` read and
// edit this team's own record — what `.agents/team.yaml` used to hold — wherever the team lives
// (the registry under the registry source): one schema-validated editor in place of editing a
// file by hand. Every write is validated by the team-file validator before it is stored, is the
// owner's (as editing the file was), and the run names what the approval no longer covers.

import { readArgs } from '../args.ts';
import {
  CONFIG_KEYS,
  CONFIG_LEVELS,
  CONFIG_REGISTRY,
  configKeysAt,
  type ConfigKey,
  type ConfigLevel,
} from '../config/registry.ts';
import { sayApply, sayConfigValue } from '../config/text.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { hasJsonFlag, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team config keys [<level>] [--json]
       team config get <path> [--json]
       team config set <path> <value>
       team config unset <path>
       team config edit

keys prints the settings registry: each key's levels, allowed values, release default,
governing policy and how a change applies. <level> is entity, project, team or seat;
without one, every key is listed.

get, set, unset and edit read and edit this team's record. <path> is dotted keys; under a list, a segment names the item by its name or
index: watch.unread_after, seats.lead.model, seats.0.cli. <value> is read as YAML (a
number, true, a one-line [list] or {map}), else as text. edit opens the record as YAML
in $VISUAL or $EDITOR and writes it back once it validates. Every write is validated
first and is the owner's; a change to an owner section is named as needing approval
again. set and unset rewrite the record's text, so its comments are not kept; edit keeps
them.

Exits 0 when the registry or a value is printed or a change is written (or there was
nothing to change), 1 when the path holds nothing, the caller is not the owner, or the
change does not validate, 2 when the invocation is invalid, no team is found, or the
editor fails.
`;

export const config: Command = (argv, io) => runConfig(argv, io);
export default config;

/** What a test hands in: the home whose registry holds the team, the editor, the clock. */
export type ConfigSources = {
  home?: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Runs the editor on the file; returns its exit status. The user's $VISUAL/$EDITOR when absent. */
  editor?: (path: string) => number;
};

export async function runConfig(argv: string[], rawIo: Io, sources: ConfigSources = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['json']);
  const verb = args.rest[0];
  if (verb === 'get' || verb === 'set' || verb === 'unset' || verb === 'edit') {
    const { runTeamRecordEdit } = await import('../config/edit.ts');
    return runTeamRecordEdit(argv, rawIo, sources);
  }
  const levelWord = args.rest[1];
  let level: ConfigLevel | null = null;
  let why: string | null = args.error ?? null;
  if (why === null) {
    if (verb !== 'keys') {
      why = verb === undefined ? 'a subcommand is required (keys, get, set, unset, edit)' : `unknown subcommand "${verb}"`;
    } else if (args.rest.length > 2) {
      why = `unexpected "${args.rest[2]}"`;
    } else if (levelWord !== undefined) {
      if ((CONFIG_LEVELS as readonly string[]).includes(levelWord)) level = levelWord as ConfigLevel;
      else why = `"${levelWord}" is not a level (${CONFIG_LEVELS.join(', ')})`;
    }
  }
  if (why !== null) {
    if (json) {
      writeJsonError(io, 'config.invocation', why, null);
    } else {
      io.stderr(`team config: ${why}\n${USAGE}`);
    }
    // exit: config.invocation
    return 2;
  }

  const keys: readonly ConfigKey[] = level === null ? CONFIG_KEYS : configKeysAt(level);
  if (json) {
    writeJson(io, 'team.config-keys', {
      format: 1,
      level,
      keys: keys.map((key) => {
        const spec = CONFIG_REGISTRY[key];
        return {
          key,
          levels: [...spec.levels],
          type: spec.type,
          allowed: spec.allowed,
          default: spec.fallback ?? null,
          governed_by: spec.governedBy ?? null,
          applies: spec.applies,
        };
      }),
    });
  } else if (keys.length === 0) {
    io.stdout(`no settings are registered at ${level} level\n`);
  } else {
    const style = ttyStyle(io, { json });
    const lines = renderTable({
      headers: ['KEY', 'LEVELS', 'ALLOWED', 'DEFAULT', 'GOVERNED BY', 'APPLIES'],
      rows: keys.map((key) => {
        const spec = CONFIG_REGISTRY[key];
        return [
          key,
          spec.levels.join(', '),
          spec.allowed,
          sayConfigValue(spec.fallback ?? null),
          spec.governedBy ?? '-',
          sayApply(spec.applies),
        ];
      }),
      style,
    });
    io.stdout(`${lines.join('\n')}\n`);
  }
  // exit: config.shown
  return 0;
}
