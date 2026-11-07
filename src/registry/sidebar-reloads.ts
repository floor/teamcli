// The sidebar reload records (the sidebar-metadata design of 2026-11-04): which running session
// of the terminal host was last reloaded onto which sidebar layout, beside the entity-level
// sources in the TeamCLI config directory — never a team file, and never inside the host's own
// config folder. The host exposes no way to read a session's live layout or its reload state
// back, so the record is the only witness a later comparison (check) can read: without it, a
// session that started before an edit holds the older layout in memory with nothing naming it.
//
// The store is machine-scoped presentation state, not truth: a missing file is no records, a
// file that cannot be read throws (`SidebarReloadsError`, the registry doctrine — an unreadable
// file never reads as an empty one), and the writers that consume it degrade to a note, never a
// refusal, because the sidebar is presentation and never blocks a launch.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../state.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';

/** One applied `server reload-config`: the layout the config held when the session reloaded onto
 *  it, `rows` as the canonical policy word and `indicators` as the host's word, and when. */
export type SidebarReloadRecord = {
  rows: string;
  indicators: string;
  at: string;
};

/** The reload-record file could not be read as one. Names the file and what is wrong. */
export class SidebarReloadsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidebarReloadsError';
  }
}

export function sidebarReloadsFile(home: string): string {
  return join(home, '.config', 'team', 'sidebar-reloads.yaml');
}

/** Every record, by session name. A missing file is no records; a file that cannot be read —
 *  corrupt YAML, or one under a folder this user cannot search — throws, so no reader takes an
 *  unreadable record file as proof a session never reloaded. */
export function readSidebarReloads(home: string): Record<string, SidebarReloadRecord> {
  const path = sidebarReloadsFile(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SidebarReloadsError(`${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) return {};
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch (error) {
    if (error instanceof YamlError) throw new SidebarReloadsError(`${path}: line ${error.line}: ${error.message}`);
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SidebarReloadsError(`${path}: not a reload record file`);
  }
  const root = value as { reloads?: unknown };
  if (root.reloads === undefined) return {};
  const reloads = root.reloads;
  if (reloads === null || typeof reloads !== 'object' || Array.isArray(reloads)) {
    throw new SidebarReloadsError(`${path}: reloads: not a map of records`);
  }
  const records: Record<string, SidebarReloadRecord> = {};
  for (const [session, entry] of Object.entries(reloads as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SidebarReloadsError(`${path}: reloads.${session}: not a record`);
    }
    const record = entry as { rows?: unknown; indicators?: unknown; at?: unknown };
    if (typeof record.rows !== 'string' || typeof record.indicators !== 'string' || typeof record.at !== 'string') {
      throw new SidebarReloadsError(`${path}: reloads.${session}: rows, indicators and at are each a word`);
    }
    records[session] = { rows: record.rows, indicators: record.indicators, at: record.at };
  }
  return records;
}

// --- the lock and the write ---------------------------------------------------------------------

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

function locked<T>(home: string, work: () => T): T {
  const path = `${sidebarReloadsFile(home)}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A holder that died leaves its file behind: one older than any write takes is not held.
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch {
        // gone already, or taken by another waiter: look again
      }
      if (Date.now() > deadline) throw new SidebarReloadsError(`${path} is held by another run`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // already removed as stale
    }
  }
}

/** A word is written bare only where the reader would read it back as the same text; every
 *  other string is double-quoted, so a timestamp's colons survive a round trip. */
function scalar(text: string): string {
  const bare = /^[A-Za-z_/~][A-Za-z0-9_./@~-]*$/.test(text) && !/^(~|null|true|false)$/i.test(text);
  return bare ? text : JSON.stringify(text);
}

function emit(records: Record<string, SidebarReloadRecord>): string {
  const sessions = Object.keys(records).sort();
  if (!sessions.length) return 'reloads: {}\n';
  const lines = ['reloads:'];
  for (const session of sessions) {
    const record = records[session] as SidebarReloadRecord;
    lines.push(`  ${scalar(session)}:`);
    lines.push(`    rows: ${scalar(record.rows)}`);
    lines.push(`    indicators: ${scalar(record.indicators)}`);
    lines.push(`    at: ${scalar(record.at)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Records applied reloads, merging under the store's own lock: a read-modify-write ending in
 *  an atomic replace, so two sessions reloaded by two runs never lose each other's record. An
 *  unreadable file throws here — the caller degrades to a note, never a refusal. */
export function recordSidebarReloads(home: string, applied: readonly { session: string; record: SidebarReloadRecord }[]): void {
  if (applied.length === 0) return;
  locked(home, () => {
    const records = readSidebarReloads(home);
    for (const one of applied) records[one.session] = one.record;
    const path = sidebarReloadsFile(home);
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, emit(records));
  });
}
