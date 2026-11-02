// The forge shim's switch: a machine-level setting, on by default, that decides whether a session
// server puts team's own forge CLI first on its PATH. The shim refuses to run the real CLI when
// no seat token is in the environment, so a credential helper cannot fall back to the account
// login stored on the machine. It is a mechanism, not a wall: the owner or a workflow turns it
// off with the word `off`, and nothing else does — a value that is not a word of this grammar
// leaves it on, because a typo must not open the fallback.
//
// It reads the same file `team-config.source` reads, `<home>/.config/team/settings.yaml`, under
// its own key. The environment override exists for one run (a workflow, or a test suite).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';
import { machineSettingsPath } from './declared.ts';

/** The setting's name, as written in `<home>/.config/team/settings.yaml`. */
export const FORGE_SHIM_SETTING = 'forge-shim';
/** The environment variable that overrides the setting for one run. */
export const FORGE_SHIM_ENV = 'TEAM_FORGE_SHIM';
/** The release default: on. A seat with no token of its own must not reach the stored login. */
export const DEFAULT_FORGE_SHIM = 'on';

export type ForgeShimResolution = {
  /** Whether the shim is written and put first on the session server's PATH. */
  on: boolean;
  /** Where the word came from. */
  from: 'environment' | 'machine' | 'default';
  /** The value that was not a word of this grammar, when one was found. The shim stays on. */
  problem?: string;
};

function word(value: unknown): 'on' | 'off' | null {
  if (value === true || value === 'true') return 'on';
  if (value === false || value === 'false') return 'off';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === 'on' || text === 'off' ? text : null;
}

/** The machine's word: `forge-shim: <word>` in the machine settings file. Absent when the file
 *  or the key is absent; a file that does not parse has no word here (its other readers name it). */
function machineWord(path: string): { value: unknown } | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!(FORGE_SHIM_SETTING in value)) return undefined;
  return { value: value[FORGE_SHIM_SETTING] };
}

/** Which way the shim's switch points: the environment, then the machine file, then the default.
 *  Only an explicit off turns it off; every other value, including one this grammar does not
 *  know, leaves it on and is reported in `problem`. */
export function resolveForgeShim(options: { home?: string; env?: Record<string, string | undefined> } = {}): ForgeShimResolution {
  const env = options.env ?? process.env;
  const fromEnv = env[FORGE_SHIM_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    const value = word(fromEnv);
    if (value === 'off') return { on: false, from: 'environment' };
    if (value === 'on') return { on: true, from: 'environment' };
    return { on: true, from: 'environment', problem: `${FORGE_SHIM_ENV} is "${fromEnv}"; it must be on or off` };
  }
  const home = options.home ?? homedir();
  const path = machineSettingsPath(home);
  const machine = machineWord(path);
  if (machine !== undefined) {
    const value = word(machine.value);
    if (value === 'off') return { on: false, from: 'machine' };
    if (value === 'on') return { on: true, from: 'machine' };
    return { on: true, from: 'machine', problem: `${FORGE_SHIM_SETTING} is "${String(machine.value)}" in ${path}; it must be on or off` };
  }
  return { on: true, from: 'default' };
}
