// The live journal's file layer: one canonical-JSON record per line, append-only, plus the
// case-safe file naming and the quarantine rename. No locking lives here; the store serializes
// callers and owns the commit order.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../canonical.ts';
import type { RunId } from '../types.ts';
import type { LiveRecord } from './records.ts';
import { validateRecord } from './records.ts';

export function runsDir(root: string): string {
  return join(root, 'runs');
}

export function definitionsDir(root: string): string {
  return join(root, 'definitions');
}

export function indexPath(root: string): string {
  return join(root, 'index.json');
}

const FILE_SAFE = /[a-z0-9._-]/;

/**
 * Encode a run id into a filename stem. Every byte outside `[a-z0-9._-]` becomes `%XX`, uppercase
 * letters included, so two run ids differing only by case cannot alias on a case-insensitive
 * filesystem. The run id inside the records is unchanged.
 */
export function encodeFileStem(runId: RunId): string {
  const bytes = new TextEncoder().encode(runId);
  let encoded = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (FILE_SAFE.test(char)) encoded += char;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** The exact inverse of `encodeFileStem`. */
export function decodeFileStem(stem: string): RunId {
  const bytes: number[] = [];
  for (let index = 0; index < stem.length; index += 1) {
    const char = stem[index]!;
    if (char !== '%') {
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const hex = stem.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error('malformed percent escape');
    bytes.push(Number.parseInt(hex, 16));
    index += 2;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}

export function journalPath(root: string, runId: RunId): string {
  return join(runsDir(root), `${encodeFileStem(runId)}.jsonl`);
}

/** The run id a journal filename names, or undefined when the name is not a journal. */
export function journalRunIdOf(fileName: string): RunId | undefined {
  if (!fileName.endsWith('.jsonl')) return undefined;
  try {
    return decodeFileStem(fileName.slice(0, -'.jsonl'.length));
  } catch {
    return undefined;
  }
}

export type JournalParse = { ok: true; records: LiveRecord[] } | { ok: false; why: string };

/** Parse one journal's text strictly: every line must be a complete, valid record. */
export function parseJournalText(text: string): JournalParse {
  if (text === '') return { ok: true, records: [] };
  if (!text.endsWith('\n')) return { ok: false, why: 'the journal ends mid-record' };
  const lines = text.split('\n');
  lines.pop();
  const records: LiveRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { ok: false, why: `line ${index + 1} is not JSON` };
    }
    const decided = validateRecord(raw);
    if (!decided.ok) return { ok: false, why: `line ${index + 1}: ${decided.why}` };
    records.push(decided.record);
  }
  return { ok: true, records };
}

export function readJournalTextFile(path: string): JournalParse {
  return parseJournalText(readFileSync(path, 'utf8'));
}

export function journalExists(root: string, runId: RunId): boolean {
  return existsSync(journalPath(root, runId));
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Append one complete record line; creates the runs directory on first use. */
export function appendJournal(path: string, record: LiveRecord): void {
  ensureDirectory(dirname(path));
  appendFileSync(path, `${canonicalJson(record)}\n`, { mode: 0o600 });
}

/** Create a journal with its first record; refuses to touch an existing file. */
export function createJournal(path: string, record: LiveRecord): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, `${canonicalJson(record)}\n`, { flag: 'wx', mode: 0o600 });
}

/**
 * Move a damaged journal aside: `<name>.corrupt`, then `.corrupt.1`, `.corrupt.2`, and up.
 * Returns the path it landed on.
 */
export function quarantineJournal(path: string): string {
  let target = `${path}.corrupt`;
  let counter = 0;
  while (existsSync(target)) {
    counter += 1;
    target = `${path}.corrupt.${counter}`;
  }
  renameSync(path, target);
  return target;
}

/** Atomic file replacement for the index: temp file, then rename. */
export function writeAtomicMode(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}
