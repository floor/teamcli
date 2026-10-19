// `team config` — the settings registry above a seat. This release ships the read-only half the
// approved minimum needs: `keys` lists what may be set, at which levels, under which policy. The
// value verbs (`get`, `set`, `unset`) arrive with the wider key set: every key in this release's
// registry is a seat key, so no level above a seat holds one to get or set.
//
// The command reads no team file: the registry is the same for every project.

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

Prints the settings registry: each key's levels, allowed values, release default, governing policy and how a change applies. <level> is entity, project, team or seat; without one, every key is listed.

Exits 0 when the registry is printed, 2 when the invocation is invalid.
`;

export const config: Command = (argv, io) => runConfig(argv, io);
export default config;

export async function runConfig(argv: string[], rawIo: Io): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['json']);
  const verb = args.rest[0];
  const levelWord = args.rest[1];
  let level: ConfigLevel | null = null;
  let why: string | null = args.error ?? null;
  if (why === null) {
    if (verb !== 'keys') {
      why = verb === undefined ? 'a subcommand is required (keys)' : `unknown subcommand "${verb}"`;
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
