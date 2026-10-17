// A lease is a file in this clone: `.agents/leases/<id>.json`. Two live leases in this clone do
// not cover one id. Another clone, and another machine, are outside that promise. The file is
// not signed. The lock is `withLock` on the leases directory, which is not `.agents/team.lock`.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from '../state.ts';
import type { TaskRecord } from './adapter.ts';

/** Thirty minutes. A team-file key does not set it. */
export const LEASE_MS = 30 * 60 * 1000;

export type Lease = {
  format: 1;
  id: string;
  seat: string;
  pane: string;
  acquiredAt: string;
  renewedAt: string;
  until: string;
};

export function leasesDir(root: string): string {
  return join(root, '.agents', 'leases');
}

type Held = { kind: 'held'; record: TaskRecord };
type ClaimResult = Held | { kind: 'none' } | { kind: 'kept' };

/** The caller's live lease is renewed when its record is still in the file. A missing record is
 *  `kept`: the file stays, and no second id is taken. Release is what removes it. */
export function claimLocal(
  root: string,
  input: { now: number; seat: string; pane: string; known: ReadonlyMap<string, TaskRecord>; candidates: readonly TaskRecord[] },
): ClaimResult {
  return withLock(leasesDir(root), () => {
    const dir = leasesDir(root);
    const own = callerFiles(dir, input.seat, input.pane).find((item) => isLive(item.lease, input.now));
    if (own) {
      const record = input.known.get(own.lease.id);
      if (!record) return { kind: 'kept' };
      writeAtomic(own.path, body(renew(own.lease, input.now)));
      return { kind: 'held', record };
    }
    for (const record of input.candidates) {
      if (heldByOther(dir, record.id, input.seat, input.pane, input.now)) continue;
      const lease: Lease = {
        format: 1,
        id: record.id,
        seat: input.seat,
        pane: input.pane,
        acquiredAt: stamp(input.now),
        renewedAt: stamp(input.now),
        until: stamp(input.now + LEASE_MS),
      };
      writeAtomic(join(dir, `${record.id}.json`), body(lease));
      return { kind: 'held', record };
    }
    return { kind: 'none' };
  });
}

/** Unlinks the caller's file, live or expired. Another seat's file is left. */
export function releaseLocal(root: string, seat: string, pane: string, now: number): { kind: 'released'; id: string } | { kind: 'none' } {
  return withLock(leasesDir(root), () => {
    const matches = callerFiles(leasesDir(root), seat, pane);
    if (!matches.length) return { kind: 'none' };
    const live = matches.find((item) => isLive(item.lease, now));
    const chosen = live ?? matches[0];
    if (!chosen) return { kind: 'none' };
    for (const item of matches) unlinkSync(item.path);
    return { kind: 'released', id: chosen.lease.id };
  });
}

/** Re-keys any lease held by `fromSeat` to `toSeat` so a renamed seat can still renew and release it. */
export function renameSeatLeases(root: string, fromSeat: string, toSeat: string): string[] {
  const dir = leasesDir(root);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  if (files.length === 0) return [];
  return withLock(dir, () => {
    const moved: string[] = [];
    for (const path of leaseFiles(dir)) {
      const lease = readLease(path);
      if (!lease || lease.seat !== fromSeat) continue;
      writeAtomic(path, body({ ...lease, seat: toSeat }));
      moved.push(lease.id);
    }
    return moved;
  });
}

function body(lease: Lease): string {
  return `${JSON.stringify(lease, null, 2)}\n`;
}

function stamp(now: number): string {
  return new Date(now).toISOString();
}

function renew(lease: Lease, now: number): Lease {
  return { ...lease, renewedAt: stamp(now), until: stamp(now + LEASE_MS) };
}

function isLive(lease: Lease, now: number): boolean {
  const until = Date.parse(lease.until);
  return Number.isFinite(until) && until > now;
}

/** Not this JSON, or `until` missing or not after now: expired, so one caller may replace it. */
function readLease(path: string): Lease | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const lease = parsed as Partial<Lease>;
  if (lease.format !== 1) return null;
  if (typeof lease.id !== 'string' || typeof lease.seat !== 'string' || typeof lease.pane !== 'string') return null;
  if (typeof lease.acquiredAt !== 'string' || typeof lease.renewedAt !== 'string' || typeof lease.until !== 'string') return null;
  return lease as Lease;
}

function leaseFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

function callerFiles(dir: string, seat: string, pane: string): { path: string; lease: Lease }[] {
  const found: { path: string; lease: Lease }[] = [];
  for (const path of leaseFiles(dir)) {
    const lease = readLease(path);
    if (lease && lease.seat === seat && lease.pane === pane) found.push({ path, lease });
  }
  return found;
}

function heldByOther(dir: string, id: string, seat: string, pane: string, now: number): boolean {
  const lease = readLease(join(dir, `${id}.json`));
  if (!lease || !isLive(lease, now)) return false;
  return lease.seat !== seat || lease.pane !== pane;
}
