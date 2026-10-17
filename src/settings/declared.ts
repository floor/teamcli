// The file surfaces of the settings chain: the machine's own settings file, an entity's
// `liveness:` map in entities.yaml, a project record's `liveness:` and the team file's watch
// section. Each reader is silent about a file it cannot read or a map it cannot parse — a word
// that does not read is no word at all, and the value in force stands. The file that is wrong is
// another command's to refuse; no reader here invents a value or falls back to a guess.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { defaultWatch } from '../file/sections/watch.ts';
import { parseYaml, type YamlNode } from '../yaml.ts';
import { LIVENESS_KEYS, type StateThresholds } from './inherit.ts';

/** One `liveness:` map from a file, or undefined when the node is not one: only the three
 *  thresholds, each a number of seconds. A map with any other key or a value that is not a
 *  number declares nothing — no partial word is taken from a map that did not read. A number
 *  that is not a liveness word (a fraction, or zero) is carried as the declaration it is: the
 *  resolver sets it aside and reports it as invalid, so no reader here judges it silently. */
export function livenessMap(node: YamlNode | undefined): Partial<StateThresholds> | undefined {
  if (node === undefined || node.kind !== 'map') return undefined;
  const out: Partial<StateThresholds> = {};
  for (const entry of node.entries) {
    if (!(LIVENESS_KEYS as readonly string[]).includes(entry.key)) return undefined;
    if (entry.value.kind !== 'scalar') return undefined;
    const value = entry.value.value;
    if (typeof value !== 'number') return undefined;
    out[entry.key as keyof StateThresholds] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The machine's settings file: `~/.config/team/settings.yaml`. */
export function machineSettingsPath(home: string): string {
  return join(home, '.config', 'team', 'settings.yaml');
}

/** The machine's word on the thresholds, under `liveness:`; none when the file is absent,
 *  unreadable, or the map does not read. */
export function machineLiveness(home: string | undefined): Partial<StateThresholds> | undefined {
  if (home === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(machineSettingsPath(home), 'utf8');
  } catch {
    return undefined;
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return undefined;
  }
  if (root.kind !== 'map') return undefined;
  return livenessMap(root.entries.find((entry) => entry.key === 'liveness')?.value);
}

/**
 * The team's own words from the `watch` section in force. A value equal to the one the section
 * ships is no word at all — the file did not write it, and passing it as a declaration would
 * make a tighter word above look like a loosening attempt. Only a value the section moves is
 * handed to the resolver as the team's; an absent section declares none.
 */
export function watchWords(watch: TeamFile['watch'] | undefined): Partial<StateThresholds> {
  const shipped = defaultWatch();
  const out: Partial<StateThresholds> = {};
  if (watch === undefined) return out;
  if (watch.idleFirst !== shipped.idleFirst) out.idle_lead_seconds = watch.idleFirst;
  if (watch.idleOwner !== shipped.idleOwner) out.idle_owner_seconds = watch.idleOwner;
  if (watch.blindAfter !== shipped.blindAfter) out.blind_after_seconds = watch.blindAfter;
  return out;
}
