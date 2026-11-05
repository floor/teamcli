// The entities the owner declares: the name a team file's `entity:` carries, the roots that
// entity's teams live under, and the entity's own words on the liveness defaults and on seat
// nicknames. Read-only, like the rest of the configuration readers: this writes nothing, runs
// nothing and opens no pane; the `names.unique` word has its own writer in
// `src/config/entity-edit.ts`.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { editedRecordText, getAt, withValue } from './config/team-record.ts';
import { parseYaml, toValue, type YamlEntry, type YamlNode, type YamlValue } from './yaml.ts';
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
  if (root.kind !== 'map') return [];
  if (
    root.entries.length === 1 &&
    root.entries[0]?.key === 'entities' &&
    root.entries[0].value.kind === 'map'
  ) {
    return root.entries[0].value.entries;
  }
  return root.entries;
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

/** How far apart seat nicknames must stay: the whole entity, one project of it, one team, or
 *  nowhere. The order is the widening one the relax word lists. */
export const NICKNAME_SCOPES = ['entity', 'project', 'team', 'off'] as const;
export type NicknameScope = (typeof NICKNAME_SCOPES)[number];

/** The scope a team reads when its entity writes no `names.unique` word. */
export const NICKNAME_SCOPE_DEFAULT: NicknameScope = 'entity';

/**
 * Each entity's `names.unique` word, by entity name, from its entry's `names:` map —
 * `<entity>: { names: { unique: entity | project | team | off } }`. Only entities that write one
 * of the four words appear: the file is the owner's own, written by hand or through
 * `team config set <entity>.names.unique` (src/config/entity-edit.ts), so a word it does
 * not spell (a typo, a case, a stray value, a file edited by hand) declares nothing and the
 * default stands rather than widening the check by accident.
 */
export function declaredNamesUnique(home: string): Map<string, NicknameScope> {
  const out = new Map<string, NicknameScope>();
  for (const entry of entityEntries(home)) {
    if (entry.value.kind !== 'map') continue;
    const names = entry.value.entries.find((candidate) => candidate.key === 'names');
    if (names === undefined || names.value.kind !== 'map') continue;
    const unique = names.value.entries.find((candidate) => candidate.key === 'unique');
    if (unique === undefined || unique.value.kind !== 'scalar') continue;
    const word = typeof unique.value.value === 'string' ? unique.value.value.trim() : '';
    if ((NICKNAME_SCOPES as readonly string[]).includes(word)) out.set(entry.key, word as NicknameScope);
  }
  return out;
}

/**
 * The nickname scope in force for a team of `entity` at `home`: the entity's own word, or the
 * default. A team that names no entity, or a reader with no home, has no entry to read, so no
 * check runs — the entry is the only place the word lives.
 */
export function namesUniqueFor(home: string | undefined, entity: string | null): NicknameScope {
  if (home === undefined || entity === null) return 'off';
  return declaredNamesUnique(home).get(entity) ?? NICKNAME_SCOPE_DEFAULT;
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

/**
 * Each entity's declared standing rules (`<entity>.rules`), in the order the file lists them.
 * Rules are text: non-empty string scalars under `rules:`.
 */
export function declaredEntityRules(home: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entityEntries(home)) {
    if (entry.value.kind !== 'map') continue;
    const rules = entry.value.entries.find((candidate) => candidate.key === 'rules');
    if (rules === undefined || rules.value.kind !== 'seq') continue;
    const list: string[] = [];
    for (const item of rules.value.items) {
      if (item.kind !== 'scalar' || typeof item.value !== 'string') continue;
      const line = item.value.trim();
      if (line !== '') list.push(line);
    }
    if (list.length > 0) out.set(entry.key, list);
  }
  return out;
}

/** One entity's declared rules at `home`, or an empty list when none are set. */
export function entityRules(home: string | undefined, entity: string | null): string[] {
  if (home === undefined || entity === null) return [];
  return declaredEntityRules(home).get(entity) ?? [];
}

export type RulesEditPlan = {
  path: string;
  before: string;
  after: string;
  diff: string;
  changed: boolean;
  kept: boolean;
};

function renderLineDiff(path: string, before: string, after: string): string {
  if (before === after) return `nothing changed in ${path}`;
  const beforeLines = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const afterLines = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a && b !== undefined) continue;
    if (b !== undefined) out.push(`- ${b}`);
    if (a !== undefined) out.push(`+ ${a}`);
  }
  return out.join('\n');
}

function isRecordMap(value: YamlValue): value is { [key: string]: YamlValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Plan setting `<entity>.rules` in `<home>/.config/team/entities.yaml` without writing to disk.
 * Used for `--dry-run` (Zeus §5.10) and before applying an owner write.
 */
export function planEntityRulesSet(home: string, entity: string, rules: string[]): RulesEditPlan {
  const path = entitiesPath(home);
  const cleaned = rules.map((r) => r.trim()).filter((r) => r.length > 0);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (before === '') {
    const root: YamlValue = { [entity]: { rules: cleaned } };
    const edited = editedRecordText('', [entity, 'rules'], cleaned, root);
    return {
      path,
      before,
      after: edited.text,
      diff: renderLineDiff(path, before, edited.text),
      changed: true,
      kept: edited.kept,
    };
  }
  const parsed = toValue(parseYaml(before));
  if (!isRecordMap(parsed)) {
    throw new Error(`${path}: expected a map of entities`);
  }
  const hasWrapper =
    Object.keys(parsed).length === 1 &&
    Object.hasOwn(parsed, 'entities') &&
    isRecordMap(parsed.entities as YamlValue);
  const recordPath = hasWrapper ? ['entities', entity, 'rules'] : [entity, 'rules'];
  const changed = withValue(parsed, recordPath, cleaned);
  if (!changed.ok) {
    throw new Error(`entity "${entity}" rules: ${changed.why}`);
  }
  if (!changed.changed) {
    return {
      path,
      before,
      after: before,
      diff: `nothing changed in ${path}`,
      changed: false,
      kept: true,
    };
  }
  const edited = editedRecordText(before, recordPath, cleaned, changed.root);
  return {
    path,
    before,
    after: edited.text,
    diff: renderLineDiff(path, before, edited.text),
    changed: true,
    kept: edited.kept,
  };
}

/**
 * Write `<entity>.rules` in `<home>/.config/team/entities.yaml` (or return the plan without writing
 * when `opts.dryRun` is true).
 */
export function writeEntityRulesSet(
  home: string,
  entity: string,
  rules: string[],
  opts: { dryRun?: boolean } = {},
): RulesEditPlan & { written: boolean } {
  const plan = planEntityRulesSet(home, entity, rules);
  if (opts.dryRun || !plan.changed) {
    return { ...plan, written: false };
  }
  mkdirSync(dirname(plan.path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(plan.path).mode & 0o777;
  } catch {}
  const tmp = `${plan.path}.${process.pid}.tmp`;
  writeFileSync(tmp, plan.after, { mode });
  renameSync(tmp, plan.path);
  return { ...plan, written: true };
}

