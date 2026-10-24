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

/** One entity's `clients:` word: seats by client id, or why the map does not read. */
export type DeclaredClients = { ok: true; clients: Record<string, string[]> } | { ok: false; why: string };

const CLIENT_WORD = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEAT_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Each entity's declared external clients, by entity name, read from its `clients:` map:
 * `<entity>: { clients: { <client-id>: { seats: [<seat>, ...] } } }`. Only entities that write the
 * key appear. A map that does not read whole — a bad client id, a missing, empty, repeated or
 * malformed seat list, an unknown key — is reported as unreadable, never read in part, so the
 * caller refuses rather than guessing.
 */
export function declaredEntityClients(home: string): Map<string, DeclaredClients> {
  const out = new Map<string, DeclaredClients>();
  for (const entry of entityEntries(home)) {
    if (entry.value.kind !== 'map') continue;
    const node = entry.value.entries.find((candidate) => candidate.key === 'clients')?.value;
    if (node === undefined) continue;
    out.set(entry.key, readClients(node));
  }
  return out;
}

function readClients(node: YamlNode): DeclaredClients {
  const bad = (why: string): DeclaredClients => ({ ok: false, why: `entities.yaml clients: ${why}` });
  if (node.kind !== 'map' || node.entries.length === 0) return bad('must map at least one client id to { seats: [...] }');
  const clients: Record<string, string[]> = {};
  for (const client of node.entries) {
    if (!CLIENT_WORD.test(client.key)) return bad(`"${client.key}" is not a client id`);
    if (Object.hasOwn(clients, client.key)) return bad(`"${client.key}" is named twice`);
    if (client.value.kind !== 'map') return bad(`${client.key} must be { seats: [...] }`);
    const keys = client.value.entries.map((field) => field.key);
    if (keys.length !== 1 || keys[0] !== 'seats') return bad(`${client.key} takes exactly one key, seats`);
    const list = client.value.entries[0]!.value;
    if (list.kind !== 'seq' || list.items.length === 0) return bad(`${client.key}.seats must name at least one seat`);
    const seats: string[] = [];
    for (const item of list.items) {
      if (item.kind !== 'scalar' || typeof item.value !== 'string' || !SEAT_WORD.test(item.value)) return bad(`${client.key}.seats holds a value that is not a seat name`);
      if (seats.includes(item.value)) return bad(`${client.key}.seats names "${item.value}" twice`);
      seats.push(item.value);
    }
    clients[client.key] = seats;
  }
  return { ok: true, clients };
}
