// The reminder chore's configuration, read from the owner's entity record: one `reminders:` list
// under an entity in `<home>/.config/team/entities.yaml`, beside the roots, liveness, nickname
// and client words `src/entities.ts` already reads there. The daemon reads it fresh; this module
// decides nothing and sends nothing.
//
// One bad reminder is refused alone and named — a later duplicate name too — and the rest read.
// A reminder is a name, at least one wall-clock time, an optional zone (the machine's when it
// names none), an optional catch-up word, and the seats it addresses. An address is written the
// way a send writes one, `<seat>@<team>`, so the parser needs no roster and no registry: it
// checks the text, and resolving an address to a declared seat of a checkout is the resolver's
// business (`resolveReminderEntries`).

import { readFileSync } from 'node:fs';
import { entitiesPath } from '../entities.ts';
import { parseSpec } from '../send/resolve.ts';
import { parseYaml, YamlError, type YamlEntry, type YamlNode } from '../yaml.ts';

/** A reminder's name: lower-case words and dashes, the shape the state record keys on. */
export const REMINDER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** One wall-clock time, `HH:MM`, on a 24-hour clock. */
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The longest text one seat receives, in characters. */
export const REMINDER_TEXT_LIMIT = 4096;

/** One seat a reminder addresses, and the text that seat receives when the reminder names its own
 *  (null: the reminder's shared text). */
export type ReminderConfigTarget = { address: string; text: string | null };

/** One reminder as the file writes it: no address resolved, no placeholder filled. */
export type ReminderConfigEntry = {
  /** The entity entry the reminder was written under. */
  entity: string;
  name: string;
  /** The wall-clock times, deduplicated, in the order the file writes them. */
  at: string[];
  /** The zone the times are read in: the reminder's own, else the caller's default. */
  zone: string;
  catchUp: boolean | undefined;
  /** The text every target receives unless it writes its own; null when every target writes one. */
  text: string | null;
  targets: ReminderConfigTarget[];
};

/** One refused reminder, or a refusal of the entities file itself (`entity: null`). */
export type ReminderConfigProblem = { entity: string | null; name: string | null; why: string };

export type ReminderConfigRead = { entries: ReminderConfigEntry[]; problems: ReminderConfigProblem[] };

/** What the read takes: the zone a reminder without one of its own is read in. The caller names
 *  it — the schedule never reads the machine's zone implicitly — and the daemon names its own. */
export type ReminderConfigOptions = { defaultZone: string };

/** The zone this machine keeps, named for the schedule. `Intl` answers it; a runtime that names
 *  none is read as UTC rather than guessing an offset. */
export function machineZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
}

/** Whether a zone name is one `Intl` knows: the constructor refuses an unknown zone with a
 *  RangeError, which is the only check the schedule's own readers make as well. */
export function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The entity entries of the owner's file, in its order; an absent or unreadable file, and a
 *  document that is not a map, declare none. The read is the same one `src/entities.ts` makes. */
function entityEntries(home: string): { ok: true; entries: YamlEntry[] } | { ok: false; why: string } {
  let text: string;
  try {
    text = readFileSync(entitiesPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, entries: [] };
    return { ok: false, why: `${entitiesPath(home)}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (text.trim() === '') return { ok: true, entries: [] };
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    const where = error instanceof YamlError ? `line ${String(error.line)}: ${error.message}` : String(error);
    return { ok: false, why: `${entitiesPath(home)}: ${where}` };
  }
  if (root.kind !== 'map') return { ok: false, why: `${entitiesPath(home)}: expected a map of entities` };
  return { ok: true, entries: root.entries };
}

/**
 * Reads every entity's `reminders:` list. An entry the file refuses is named and skipped; a name
 * a second entity repeats is refused there too, because the state record keys one reminder by
 * name for the whole machine.
 */
export function readReminderConfig(home: string, options: ReminderConfigOptions): ReminderConfigRead {
  const read = entityEntries(home);
  if (!read.ok) return { entries: [], problems: [{ entity: null, name: null, why: read.why }] };
  const entries: ReminderConfigEntry[] = [];
  const problems: ReminderConfigProblem[] = [];
  const named = new Map<string, string>();
  for (const entity of read.entries) {
    const node = entity.value.kind === 'map' ? entity.value.entries.find((candidate) => candidate.key === 'reminders')?.value : undefined;
    if (node === undefined) continue;
    if (node.kind !== 'seq') {
      problems.push({ entity: entity.key, name: null, why: `${entity.key}.reminders must be a list of reminders` });
      continue;
    }
    for (const item of node.items) {
      const parsed = readReminder(entity.key, item, options);
      if ('why' in parsed) {
        problems.push({ entity: entity.key, name: parsed.name, why: `${entity.key}.reminders: ${parsed.why}` });
        continue;
      }
      const first = named.get(parsed.name);
      if (first !== undefined) {
        problems.push({ entity: entity.key, name: parsed.name, why: `${entity.key}.reminders: "${parsed.name}" is already a reminder of ${first}` });
        continue;
      }
      named.set(parsed.name, entity.key);
      entries.push(parsed);
    }
  }
  return { entries, problems };
}

type ParsedEntry = ReminderConfigEntry | { name: string | null; why: string };

/** One list item: a map of the reminder's own keys, and nothing else. */
function readReminder(entity: string, node: YamlNode, options: ReminderConfigOptions): ParsedEntry {
  if (node.kind !== 'map') return { name: null, why: 'each reminder must be a map' };
  const fields = new Map<string, YamlNode>();
  for (const field of node.entries) {
    if (!['name', 'at', 'zone', 'catchUp', 'text', 'to'].includes(field.key)) {
      return { name: null, why: `"${field.key}" is not a reminder key (name, at, zone, catchUp, text, to)` };
    }
    if (fields.has(field.key)) return { name: null, why: `"${field.key}" is written twice` };
    fields.set(field.key, field.value);
  }

  const nameNode = fields.get('name');
  if (nameNode === undefined) return { name: null, why: 'a reminder needs a name' };
  if (nameNode.kind !== 'scalar' || typeof nameNode.value !== 'string' || !REMINDER_NAME.test(nameNode.value)) {
    return { name: null, why: 'a name is lower-case words and dashes, up to 64 characters' };
  }
  const name = nameNode.value;

  const atNode = fields.get('at');
  if (atNode === undefined) return { name, why: 'a reminder needs at least one time' };
  const at = readTimes(atNode);
  if ('why' in at) return { name, why: at.why };

  let zone = options.defaultZone;
  const zoneNode = fields.get('zone');
  if (zoneNode !== undefined) {
    if (zoneNode.kind !== 'scalar' || typeof zoneNode.value !== 'string' || !isKnownZone(zoneNode.value)) {
      return { name, why: 'zone must be a named zone this runtime knows' };
    }
    zone = zoneNode.value;
  }

  let catchUp: boolean | undefined;
  const catchUpNode = fields.get('catchUp');
  if (catchUpNode !== undefined) {
    if (catchUpNode.kind !== 'scalar' || typeof catchUpNode.value !== 'boolean') return { name, why: 'catchUp must be true or false' };
    catchUp = catchUpNode.value;
  }

  let text: string | null = null;
  const textNode = fields.get('text');
  if (textNode !== undefined) {
    const read = readText(textNode);
    if ('why' in read) return { name, why: read.why };
    text = read.text;
  }

  const toNode = fields.get('to');
  if (toNode === undefined) return { name, why: 'a reminder needs at least one address' };
  const targets = readTargets(toNode);
  if ('why' in targets) return { name, why: targets.why };
  for (const target of targets.targets) {
    if (target.text === null && text === null) return { name, why: `"${target.address}" writes no text and the reminder writes none` };
  }

  return { entity, name, at: at.at, zone, catchUp, text, targets: targets.targets };
}

function readTimes(node: YamlNode): { at: string[] } | { why: string } {
  if (node.kind !== 'seq' || node.items.length === 0) return { why: 'at must be a list of at least one HH:MM time' };
  const at: string[] = [];
  for (const item of node.items) {
    if (item.kind !== 'scalar' || typeof item.value !== 'string' || !WALL_TIME.test(item.value)) {
      return { why: 'at holds a value that is not an HH:MM time' };
    }
    if (!at.includes(item.value)) at.push(item.value);
  }
  return { at };
}

function readText(node: YamlNode): { text: string } | { why: string } {
  if (node.kind !== 'scalar' || typeof node.value !== 'string') return { why: 'text must be a string' };
  const text = node.value.trim();
  if (text === '') return { why: 'text must not be empty' };
  if (text.length > REMINDER_TEXT_LIMIT) return { why: `text is longer than ${String(REMINDER_TEXT_LIMIT)} characters` };
  return { text };
}

/** The `to:` list: a bare address, or `{ to, text }`, and nothing else. */
function readTargets(node: YamlNode): { targets: ReminderConfigTarget[] } | { why: string } {
  if (node.kind !== 'seq' || node.items.length === 0) return { why: 'to must name at least one address' };
  const targets: ReminderConfigTarget[] = [];
  for (const item of node.items) {
    if (item.kind === 'scalar') {
      if (typeof item.value !== 'string') return { why: 'an address must be a string' };
      const why = addressProblem(item.value);
      if (why !== null) return { why };
      targets.push({ address: item.value, text: null });
      continue;
    }
    if (item.kind !== 'map') return { why: 'an address is `<seat>@<team>` or { to, text }' };
    const keys = item.entries.map((field) => field.key);
    const unknown = keys.find((key) => key !== 'to' && key !== 'text');
    if (unknown !== undefined) return { why: `an address takes to and text, not "${unknown}"` };
    if (keys.filter((key) => key === 'to').length !== 1) return { why: 'an address needs exactly one to' };
    const to = item.entries.find((field) => field.key === 'to')?.value;
    if (to === undefined || to.kind !== 'scalar' || typeof to.value !== 'string') return { why: 'to must be a string' };
    const why = addressProblem(to.value);
    if (why !== null) return { why };
    let text: string | null = null;
    const textNode = item.entries.find((field) => field.key === 'text')?.value;
    if (textNode !== undefined) {
      const read = readText(textNode);
      if ('why' in read) return { why: read.why };
      text = read.text;
    }
    targets.push({ address: to.value, text });
  }
  return { targets };
}

/** An address is a full `<seat>@<team>`: a bare seat or nickname has no team to resolve in, and
 *  an agent id names a record rather than a seat of a team the reminder can be judged against. */
function addressProblem(address: string): string | null {
  const parsed = parseSpec(address);
  if ('error' in parsed) return parsed.error;
  if (parsed.kind !== 'at') return `"${address}" is not <seat>@<team>`;
  if (parsed.target === '') return `"${address}" is not <seat>@<team>`;
  return null;
}

/** The words the reminder fills into its text per target. Braced keys only; anything else in
 *  braces is left as written, so a text can carry a code sample without escaping. */
export function fillReminderText(template: string, words: { team: string; seat: string; name: string }): string {
  return template.replace(/\{(team|seat|name)\}/g, (_whole, key: string) => words[key as 'team' | 'seat' | 'name']);
}
