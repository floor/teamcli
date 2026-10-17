// The entities the owner declares: the name a team file's `entity:` carries and the roots that
// entity's teams live under. Read-only, like the rest of the configuration readers: this writes
// nothing, runs nothing and opens no pane.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, type YamlNode } from './yaml.ts';

/** The owner's entities file: `<home>/.config/team/entities.yaml`, one entry per entity. */
export function entitiesPath(home: string): string {
  return join(home, '.config', 'team', 'entities.yaml');
}

/**
 * Each entity's declared roots, by entity name, in the order the file lists them. These are the
 * only roots a record may cover by naming an entity: no path is written into this program. The
 * file is the owner's own, so an absent or unreadable file, a document that is not a map, and an
 * entry whose `roots:` is not a sequence of non-empty strings each declare nothing — a record
 * that relies on them then grants nothing rather than falling back to a guess.
 */
export function declaredRoots(home: string): Map<string, string[]> {
  let text: string;
  try {
    text = readFileSync(entitiesPath(home), 'utf8');
  } catch {
    return new Map();
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return new Map();
  }
  if (root.kind !== 'map') return new Map();
  const out = new Map<string, string[]>();
  for (const entry of root.entries) {
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
