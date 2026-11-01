import type { DialogKind } from '../watch/dialog.ts';
import { YamlError, type YamlEntry, type YamlNode } from '../yaml.ts';
import { versionMatches, versionOrder, wholeVersion } from './trust-answer.ts';

/**
 * The keys a profile may answer a dialog with: both dismiss the dialog, and the terminal host
 * spells them this way (`escape`, `ctrl+c`). Never a key that picks a menu option — a profile
 * cannot answer a question on the human's behalf, it can only stop the seat waiting on it.
 */
export const ANSWER_KEYS = ['escape', 'ctrl+c'] as const;

export type AnswerKey = (typeof ANSWER_KEYS)[number];

/** The dialog kinds an answer record may name. `satisfies` fails the typecheck on a name that is
 *  no dialog kind; a kind added to dialog.ts and not judged here matches no record, so the answer
 *  layer refuses it rather than guessing a key. */
const ANSWERABLE_KINDS = ['question', 'plan approval', 'confirmation'] as const satisfies readonly DialogKind[];

export type AnswerableKind = (typeof ANSWERABLE_KINDS)[number];

/**
 * One question-answer record: the key presses for a dialog of `kind` on the versions `from`..`to`.
 * An exact record (`from` equals `to`) matches the printed version byte for byte, as a trust
 * answer does; a range compares whole versions with no suffix on either side.
 */
export type QuestionAnswerRecord = { kind: AnswerableKind; key: AnswerKey; from: string; to: string };

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}

function text(entry: YamlEntry, key: string): string {
  const node = entry.value;
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') {
    fail(entry.line, `"${key}" must be a non-empty string`);
  }
  return node.value;
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

/** The records a profile lists, or none. A profile that omits the key answers nothing. Two
 *  records for one kind may not claim the same printed version: the lookup would have to pick
 *  one, and a profile is not the place to make that choice by order. */
export function questionAnswers(entry: YamlEntry | undefined): QuestionAnswerRecord[] {
  if (!entry) return [];
  const node = entry.value;
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"question_answer" must be a non-empty list');
  const records: QuestionAnswerRecord[] = [];
  for (const item of node.items) {
    const record = recordOf(item);
    for (const prior of records) {
      if (prior.kind === record.kind && overlaps(prior, record)) {
        fail(item.line, `"${record.kind}" is already answered on versions this record claims too`);
      }
    }
    records.push(record);
  }
  return records;
}

function recordOf(node: YamlNode): QuestionAnswerRecord {
  const entries = mapping(node, 'a question answer');
  only(entries, ['kind', 'key', 'from', 'to']);
  const kindEntry = required(entries, 'kind', node.line);
  const kind = text(kindEntry, 'kind');
  if (!(ANSWERABLE_KINDS as readonly string[]).includes(kind)) {
    fail(kindEntry.line, `"kind" must be one of ${ANSWERABLE_KINDS.join(', ')}`);
  }
  const keyEntry = required(entries, 'key', node.line);
  const key = text(keyEntry, 'key');
  if (!(ANSWER_KEYS as readonly string[]).includes(key)) fail(keyEntry.line, `"key" must be one of ${ANSWER_KEYS.join(', ')}`);
  const from = text(required(entries, 'from', node.line), 'from');
  const to = text(required(entries, 'to', node.line), 'to');
  if (from !== to) {
    const start = wholeVersion(from);
    const end = wholeVersion(to);
    if (!start || !end) fail(node.line, '"from" and "to" must both be whole versions, or the same text for one exact version');
    if (versionOrder(start, end) > 0) fail(node.line, '"from" must not be after "to"');
  }
  return { kind: kind as AnswerableKind, key: key as AnswerKey, from, to };
}

/** Whether two records for one kind could both claim the same printed version. */
function overlaps(a: QuestionAnswerRecord, b: QuestionAnswerRecord): boolean {
  if (a.from === a.to && b.from === b.to) return a.from === b.from;
  if (a.from === a.to) return versionMatches(b, a.from);
  if (b.from === b.to) return versionMatches(a, b.from);
  // Both are ranges, and the loader refused any that do not parse or run backwards.
  const start = wholeVersion(a.from) as number[];
  const end = wholeVersion(a.to) as number[];
  const otherStart = wholeVersion(b.from) as number[];
  const otherEnd = wholeVersion(b.to) as number[];
  return versionOrder(start, otherEnd) <= 0 && versionOrder(otherStart, end) <= 0;
}

/** The record that answers `kind` on the version a CLI prints, or null when none does. */
export function questionAnswerFor(
  records: readonly QuestionAnswerRecord[],
  kind: DialogKind,
  printed: string,
): QuestionAnswerRecord | null {
  for (const record of records) if (record.kind === kind && versionMatches(record, printed)) return record;
  return null;
}
