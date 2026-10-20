// Read-side entry points for presence. These are pure reads: no herdr call, no pane capture and
// no requirement that a terminal-host adapter exists. A reader works with only the project's
// files, so it answers the same on a machine where the daemon never had a screen to classify.
//
// `readPresenceTransitions` is the sequenced feed the canonical activity updater consumes. It is
// bounded by records and bytes per call and resumable by `(afterSeq, afterOffset)`, so a
// 5-second updater never scans the whole log and never samples only the current projection: a
// working→idle pair between two beats is delivered as two transitions, in order, each with its
// binding and seq.
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readPresenceLogLine, readPresenceReading, readPresenceStatus,
  type PresenceLogLine, type PresenceReading, type PresenceStatus,
} from './contract.ts';
import { presencePaths, presenceStatusPath } from './spool.ts';

export const PRESENCE_TRANSITION_MAX_RECORDS = 64;
export const PRESENCE_TRANSITION_MAX_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export type PresenceFileRead<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'absent' }
  | { kind: 'bad'; why: string };

/** The seat's current projection, or absent/bad. An old projection is never expired here: the
 *  caller decides live versus last-known from the binding and the channel's health. */
export async function readPresenceCurrent(
  stateDir: string,
  session: string,
  seat: string,
): Promise<PresenceFileRead<PresenceReading>> {
  const paths = presencePaths(stateDir, session, seat);
  if (paths === null) return { kind: 'absent' };
  let text: string;
  try {
    text = await readFile(paths.current, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'bad', why: `the projection could not be read: ${(error as Error).message}` };
  }
  const read = readPresenceReading(text);
  return read.kind === 'ok' ? { kind: 'ok', value: read.reading } : { kind: 'bad', why: read.why };
}

/** The route's own channel record. `serving` here is a hint, not health: qualify it with the
 *  daemon's current ownership/heartbeat or a live RPC answer before showing a reading as live. */
export async function readPresenceChannel(
  stateDir: string,
  session: string,
): Promise<PresenceFileRead<PresenceStatus>> {
  const path = presenceStatusPath(stateDir, session);
  if (path === null) return { kind: 'absent' };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'bad', why: `the channel record could not be read: ${(error as Error).message}` };
  }
  const read = readPresenceStatus(text);
  return read.kind === 'ok' ? { kind: 'ok', value: read.status } : { kind: 'bad', why: read.why };
}

export type PresenceTransitionInput = {
  stateDir: string;
  session: string;
  seat: string;
  /** Return lines with seq strictly greater than this. */
  afterSeq?: number;
  /** Byte offset to resume from; the caller may persist it. Defaults to 0 (the log's start). */
  afterOffset?: number;
  maxRecords?: number;
  maxBytes?: number;
};

export type PresenceTransitionRead =
  | { kind: 'ok'; transitions: PresenceLogLine[]; nextSeq: number; nextOffset: number; more: boolean }
  | { kind: 'bad'; why: string };

/** Reads the next bounded batch of applied transitions. `more` means a later call with the
 *  returned `(nextSeq, nextOffset)` has at least one complete line left. An incomplete trailing
 *  line is left for a later call and is not reported as `more`. */
export async function readPresenceTransitions(input: PresenceTransitionInput): Promise<PresenceTransitionRead> {
  const afterSeq = input.afterSeq ?? 0;
  const afterOffset = input.afterOffset ?? 0;
  const maxRecords = input.maxRecords ?? PRESENCE_TRANSITION_MAX_RECORDS;
  const maxBytes = input.maxBytes ?? PRESENCE_TRANSITION_MAX_BYTES;
  if (!Number.isInteger(afterSeq) || afterSeq < 0) return { kind: 'bad', why: 'afterSeq must be a non-negative integer' };
  if (!Number.isInteger(afterOffset) || afterOffset < 0) return { kind: 'bad', why: 'afterOffset must be a non-negative integer' };
  if (!Number.isInteger(maxRecords) || maxRecords < 1) return { kind: 'bad', why: 'maxRecords must be at least one' };
  if (!Number.isInteger(maxBytes) || maxBytes < 256) return { kind: 'bad', why: 'maxBytes must be at least 256' };
  const paths = presencePaths(input.stateDir, input.session, input.seat);
  if (paths === null) return { kind: 'ok', transitions: [], nextSeq: afterSeq, nextOffset: afterOffset, more: false };
  let handle;
  try {
    handle = await open(paths.log, 'r');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return { kind: 'ok', transitions: [], nextSeq: afterSeq, nextOffset: afterOffset, more: false };
    }
    return { kind: 'bad', why: `the presence log could not be read: ${(error as Error).message}` };
  }
  try {
    const size = (await handle.stat()).size;
    const transitions: PresenceLogLine[] = [];
    let pending = Buffer.alloc(0);
    let lineStart = afterOffset;
    let position = afterOffset;
    let nextSeq = afterSeq;
    let nextOffset = afterOffset;
    let more = false;
    let stopped = false;
    while (!stopped && position < size) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = pending.length === 0
        ? chunk.subarray(0, bytesRead)
        : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let from = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, from);
        if (newline === -1) break;
        const lineEnd = lineStart + newline + 1;
        const text = data.subarray(from, newline).toString('utf8');
        const line = readPresenceLogLine(text);
        if ('why' in line) return { kind: 'bad', why: `the presence log holds an unreadable line: ${line.why}` };
        if (line.seq <= afterSeq) {
          nextOffset = lineEnd;
          nextSeq = Math.max(nextSeq, line.seq);
          from = newline + 1;
          continue;
        }
        if (transitions.length >= maxRecords || lineEnd - afterOffset > maxBytes) {
          more = true;
          stopped = true;
          break;
        }
        transitions.push(line);
        nextSeq = line.seq;
        nextOffset = lineEnd;
        from = newline + 1;
      }
      if (stopped) break;
      pending = Buffer.from(data.subarray(from));
      lineStart += from;
      if (pending.length > MAX_LINE_BYTES) {
        return { kind: 'bad', why: 'the presence log holds a line longer than the record limit' };
      }
    }
    if (!more && pending.length > 0 && position >= size) {
      // A partial trailing line: leave it unconsumed, at its own start.
      nextOffset = lineStart;
    }
    return { kind: 'ok', transitions, nextSeq, nextOffset, more: more && size > nextOffset };
  } catch (error) {
    return { kind: 'bad', why: `the presence log could not be read: ${(error as Error).message}` };
  } finally {
    await handle.close();
  }
}
