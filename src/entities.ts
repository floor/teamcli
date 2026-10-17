// The entities the owner declares: the name a team file's `entity:` carries, the roots that
// entity's teams live under, and the entity's own word on the liveness defaults. Read-only, like
// the rest of the configuration readers: this writes nothing, runs nothing and opens no pane.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, type YamlEntry, type YamlNode } from './yaml.ts';
import { livenessMap } from './settings/declared.ts';
import type { StateThresholds } from './settings/inherit.ts';

/** The owner's entities file: `<home>/.config/team/entities.yaml`, one entry per entity. */
export function entitiesPath(home: string): string {
  return join(home, '.config', 'team', 'entities.yaml');
}

/**
 * The file's entries, in the order it lists them. The file is the owner's own, so an absent or
 * unreadable file, and a document that is not a map, each declare nothing.
 */
function entityEntries(home: string): YamlEntry[] {
  let text: string;
  try {
    text = readFileSync(entitiesPath(home), 'utf8');
  } catch {
    return [];
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return [];
  }
  return root.kind === 'map' ? root.entries : [];
}

/**
 * Each entity's declared roots, by entity name, in the order the file lists them. These are the
 * only roots a record may cover by naming an entity: no path is written into this program. An
 * entry whose `roots:` is not a sequence of non-empty strings declares none — a record that
 * relies on them then grants nothing rather than falling back to a guess.
 */
export function declaredRoots(home: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entityEntries(home)) {
    if (entry.value.kind !== 'map') continue;
    const roots = entry.value.entries.find((candidate) => candidate.key === 'roots');
    if (roots === undefined || roots.value.kind !== 'seq') continue;
    const list: string[] = [];
    for (const item of roots.value.items) {
      if (item.kind !== 'scalar' || typeof item.value !== 'string' || item.value.trim() === '') continue;
      const path = item.value.trim();
      if (!list.includes(path)) list.push(path);
    }
    if (list.length > 0) out.set(entry.key, list);
  }
  return out;
}

/**
 * Each entity's declared word on the liveness defaults, by entity name, read from its
 * `liveness:` map. An entry whose map does not read declares none: the settings reader takes no
 * partial word from a map it could not parse.
 */
export function declaredEntityLiveness(home: string): Map<string, Partial<StateThresholds>> {
  const out = new Map<string, Partial<StateThresholds>>();
  for (const entry of entityEntries(home)) {
    if (entry.value.kind !== 'map') continue;
    const liveness = livenessMap(entry.value.entries.find((candidate) => candidate.key === 'liveness')?.value);
    if (liveness !== undefined) out.set(entry.key, liveness);
  }
  return out;
}

/** One entry's liveness word, or none when the home, the name or the map says nothing. */
export function entityLiveness(home: string | undefined, entity: string | null): Partial<StateThresholds> | undefined {
  if (home === undefined || entity === null) return undefined;
  return declaredEntityLiveness(home).get(entity);
}
