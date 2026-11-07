// The wake marker beside a message: the reservation a typed wake takes before it types, and the
// record it leaves of what the wake was seen to become.
//
// The marker is `<dropDir>/<id>.wake`, linked into place exclusively before a line is typed, so
// exactly one wake owns an attempt and a second request for the same message is coalesced rather
// than typed twice. A marker already at the name belongs to an earlier attempt whose effect is
// unknown — a crash after Enter leaves no other trace — and is never typed over. This module
// holds the three operations every wake caller shares (the watch's unread pass, the watch's
// retry, and the daemon's wake child); each caller passes the path it resolved with `wakePath`.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dropMessage } from './native.ts';

/** The marker beside a message whose one wake line was typed. */
export function wakePath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.wake`);
}

/** What a wake reservation says, when it can be read. A marker written before reservations
 *  existed carried no state and records a wake line that was sent; an unknown state reads as
 *  `sent`, never as a reservation another pass may overwrite. `evidence` names the leg the wake
 *  took (`typed`, `typed-wake`, `webhook`, or `blocked`): the report's words keep a posted
 *  adapter or a dialog block apart from a typed line. */
export type WakeMark = {
  at: string;
  state: 'reserved' | 'sent' | 'read' | 'blocked';
  evidence?: string;
  screen?: string;
  outcome?: string;
  to?: string;
  report?: string;
};

/** The marker's record, when the file exists and can be read; null otherwise. */
export function wakeMarkAt(path: string): WakeMark | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      at?: unknown;
      state?: unknown;
      evidence?: unknown;
      screen?: unknown;
      outcome?: unknown;
      to?: unknown;
      report?: unknown;
    };
    if (typeof parsed.at !== 'string') return null;
    const state = parsed.state === 'reserved'
      ? 'reserved'
      : parsed.state === 'read'
        ? 'read'
        : parsed.state === 'blocked'
          ? 'blocked'
          : 'sent';
    return {
      at: parsed.at,
      state,
      ...(typeof parsed.evidence === 'string' ? { evidence: parsed.evidence } : {}),
      ...(typeof parsed.screen === 'string' ? { screen: parsed.screen } : {}),
      ...(typeof parsed.outcome === 'string' ? { outcome: parsed.outcome } : {}),
      ...(typeof parsed.to === 'string' ? { to: parsed.to } : {}),
      ...(typeof parsed.report === 'string' ? { report: parsed.report } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Takes a marker name exclusively, before the effect it guards: the record is written whole, 0600,
 * to a temporary file and linked into place. `link` fails when the name exists, so exactly one
 * pass — or one crash's predecessor — owns the attempt. `true` means this call wrote the
 * reservation; `false` means someone else's is there (or the name could not be written at all),
 * and the caller must not perform the effect. The temporary file never shares a name with a
 * message: the scan reads UUID names only.
 */
export function reserveWake(path: string, record: Record<string, unknown>): boolean {
  const dir = dirname(path);
  const temp = join(dir, `.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    linkSync(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed; the error that ended the attempt is the answer.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Never written, or linked and unlinked above: nothing is left to remove.
    }
  }
}

/** Gives back a reservation this pass wrote, after a delivery the seam says took nothing. A
 *  reservation found on disk is never removed by a later pass. */
export function releaseWake(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone: nothing is claimed by its absence.
  }
}

/** Rewrites a reservation with what it was seen to become. This is a record update, never the
 *  reservation itself: the marker was linked into place before the effect, and a failed update
 *  leaves `reserved`, which is the truth at that point. */
export function markWake(path: string, record: Record<string, unknown>): void {
  try {
    dropMessage(dirname(path), basename(path), `${JSON.stringify(record)}\n`);
  } catch {
    // The reservation stands; only the note about its outcome is missing.
  }
}
