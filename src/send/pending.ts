// The record a held send leaves beside its drop, and the bound on retrying it; and the native
// channel's pending half, the record a handoff leaves behind.
//
// `team send` writes the drop before it types the trigger. When the composer already holds a
// person's unsent text — or the seat never takes the trigger — the send exits `held` or
// `not-submitted` with the drop still on disk and its words never read, and until this record
// existed nothing ever tried again: four such drops sat unread in one orchestrator's pane while
// the owner's own draft held the composer. A marker `<id>.pending` beside the drop is the retry's
// record: the watch delivers it once the seat is free, gives up after a fixed number of typed
// tries or a fixed age, and says the drop's path so the message can be sent again.
//
// The marker is a convenience, never the message: the drop file is the message, and a marker that
// cannot be written or read costs a retry, not a byte of the body.
//
// A Claude Code seat's native leg is the sender's own cross-session SendMessage, which an
// external process cannot call. So `team send` resolves the recipient, judges the pair and
// writes a pending native record — the address and the whole body, under the caller's own project
// state — then prints them; the sender makes the call, and `team send --confirm <id>` reads the
// record back and writes the one history line. The record is what makes the two steps one
// decision: the confirm records the pair the handoff admitted, never a body or a recipient a later
// call could substitute. It lives beside `messages.jsonl` in the project's state folder, at mode
// 0600, one file per id, written whole by rename; a file that cannot be written refuses the
// handoff, so an unrecorded native send is never the easy path.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { storePath } from '../store/store.ts';
import { ensureStoreLadder, readNoFollow } from './history.ts';
import { dropMessage } from './native.ts';

/** How many typed retries one held send is given, after the send's own attempt. */
export const PENDING_MAX_TRIES = 3;

/** How long after the held send a retry is still made, however free the seat was. */
export const PENDING_MAX_AGE_MS = 30 * 60_000;

/** The record kept beside a drop whose send was held or not submitted. */
export type PendingDrop = {
  id: string;
  /** The sender, as the send recorded it. */
  from: string;
  to: string;
  /** The drop's whole body, which is what a retry's own history line carries. */
  body: string;
  /** When the send was held, ISO; a retry's age is measured from it. */
  ts: string;
  /** Typed retries made since the send. */
  tries: number;
};

/** The marker's path: the drop's own name with `.pending` after it. */
export function pendingDropPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.pending`);
}

/** Writes the record whole, mode 0600 by rename of a temporary file in the drop's directory —
 *  the write shape and modes the drop itself gets (`dropMessage`). */
function writePendingDrop(dropDir: string, drop: PendingDrop): void {
  try {
    dropMessage(dropDir, `${drop.id}.pending`, JSON.stringify(drop));
  } catch {
    // The drop is the message; this record only saves a retry.
  }
}

/** Records a held drop for a later retry. Best-effort and silent. */
export function markPending(dropDir: string, drop: Omit<PendingDrop, 'tries'>): void {
  writePendingDrop(dropDir, { ...drop, tries: 0 });
}

/** Writes a failed retry back, so the next pass knows how many tries are left. */
export function recordPendingTry(dropDir: string, drop: PendingDrop): void {
  writePendingDrop(dropDir, { ...drop, tries: drop.tries + 1 });
}

/** Forgets a drop: delivered, or given up on. */
export function clearPending(dropDir: string, id: string): void {
  try {
    unlinkSync(pendingDropPath(dropDir, id));
  } catch {
    // Already gone, or never written: nothing stands in the way of the next send.
  }
}

function readPendingDrops(dropDir: string): PendingDrop[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const drops: PendingDrop[] = [];
  for (const name of names) {
    if (!name.endsWith('.pending')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dropDir, name), 'utf8')) as Partial<PendingDrop>;
      if (typeof parsed.id !== 'string' || typeof parsed.from !== 'string' || typeof parsed.to !== 'string'
        || typeof parsed.body !== 'string' || typeof parsed.ts !== 'string') continue;
      if (name !== `${parsed.id}.pending`) continue;
      drops.push({
        id: parsed.id,
        from: parsed.from,
        to: parsed.to,
        body: parsed.body,
        ts: parsed.ts,
        tries: typeof parsed.tries === 'number' && Number.isInteger(parsed.tries) && parsed.tries >= 0 ? parsed.tries : 0,
      });
    } catch {
      continue;
    }
  }
  return drops.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** The folder inside `<project state folder>/` that holds the pending native sends. */
export const PENDING_DIR = 'pending';

/** The id shape a handoff prints: a UUID, the name of its one file. */
export const PENDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One handoff, exactly as the sender's own call will make it: the target's address and the
 *  body, and the pair's own record — the receiving project, team and rule the confirm writes
 *  the history line for. */
export type PendingNative = {
  v: 1;
  /** The id the handoff printed; the confirm names it, and the history line keeps it. */
  id: string;
  /** When the handoff printed it: the confirm's span is measured from here. */
  ts: string;
  /** The sender: the seat's name, or `owner`. */
  from: string;
  /** The sender's agent id, when the registry holds one. */
  from_id: string | null;
  /** The recipient: its seat, agent id, team, session, CLI and live pane. */
  to: string;
  to_id: string | null;
  team: string;
  session: string;
  cli: string;
  pane: string;
  /** The exact target printed: `uds:<socket path>`. */
  address: string;
  /** The rule that admitted the pair, as the handoff judged it. */
  rule: string;
  /** The receiving project and root: the store the history line goes to, across teams too. */
  project: string;
  root: string;
  /** The whole body the sender was told to send, sender header included. */
  body: string;
};

export type PendingRead = { ok: true; record: PendingNative | null } | { ok: false; reason: string };

export type PendingWrite = { ok: true; path: string } | { ok: false; reason: string };

/** `<project state folder>/pending`: under the project the handoff was run from, never the
 *  lobby and never the repository checkout. */
export function pendingDir(project: string, root: string, home: string): string {
  return join(storePath(project, root, home), PENDING_DIR);
}

/** The one file a pending id names. */
export function pendingPath(project: string, root: string, home: string, id: string): string {
  return join(pendingDir(project, root, home), `${id}.json`);
}

/** The folder's own guard: a real directory of this user's, at mode 0700. Missing is created;
 *  a link, a FIFO, another user's folder or a file in the way is a refusal. */
function folderProblem(at: string): string | null {
  const held = heldAt(at);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind !== 'folder') return 'the pending folder is not a directory';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's folder";
  return null;
}

/** Writes one pending record whole: the project ladder, then the pending folder at 0700, then a
 *  temporary file at 0600 renamed to the id's own name. An existing file at that path is never
 *  replaced — ids are never reused, so a file there is not this handoff's. */
export function writePending(project: string, root: string, home: string, record: PendingNative): PendingWrite {
  const store = storePath(project, root, home);
  const ladder = ensureStoreLadder(store, home);
  if (ladder !== null) return { ok: false, reason: ladder };
  const dir = pendingDir(project, root, home);
  const problem = folderProblem(dir);
  if (problem !== null) return { ok: false, reason: problem };
  try {
    if (heldAt(dir).kind === 'missing') {
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  } catch {
    return { ok: false, reason: 'the pending folder could not be created' };
  }
  const path = pendingPath(project, root, home, record.id);
  if (heldAt(path).kind !== 'missing') return { ok: false, reason: 'a pending record already holds that id' };
  const temporary = join(dir, `.${record.id}.${String(process.pid)}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    return { ok: true, path };
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // the write's own failure is the reason; a leftover temporary is not
    }
    return { ok: false, reason: 'the pending record could not be written' };
  }
}

/** The held drops in one seat's directory, oldest first; or one pending native record by id. */
export function readPending(dropDir: string): PendingDrop[];
export function readPending(project: string, root: string, home: string, id: string): PendingRead;
export function readPending(first: string, root?: string, home?: string, id?: string): PendingDrop[] | PendingRead {
  if (root === undefined || home === undefined || id === undefined) {
    return readPendingDrops(first);
  }
  return readPendingNative(first, root, home, id);
}

/** One record, or why it cannot be read. A missing file is `record: null` — the confirm's own
 *  refusal, not a fault; anything that is not the record this version writes is a fault named. */
function readPendingNative(project: string, root: string, home: string, id: string): PendingRead {
  if (!PENDING_ID.test(id)) return { ok: true, record: null };
  const dir = pendingDir(project, root, home);
  const problem = folderProblem(dir);
  if (problem !== null) return { ok: false, reason: problem };
  const path = pendingPath(project, root, home, id);
  const held = heldAt(path);
  if (held.kind === 'missing') return { ok: true, record: null };
  if (held.kind === 'link') return { ok: false, reason: 'a symbolic link was found and not followed' };
  if (held.kind === 'fifo') return { ok: false, reason: 'a FIFO was found and not followed' };
  if (held.kind !== 'file') return { ok: false, reason: 'the pending record is not a regular file' };
  if (process.getuid !== undefined && held.uid !== process.getuid()) return { ok: false, reason: "another user's file" };
  const text = readNoFollow(path);
  if (text === null) return { ok: false, reason: 'the pending record could not be read' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the pending record is not JSON' };
  }
  const record = shapeOf(parsed, id);
  if (record === null) return { ok: false, reason: 'the pending record is not one this version wrote' };
  return { ok: true, record };
}

/**
 * Takes one pending record for its confirm: an atomic rename to a private name, so of two
 * confirms racing on one id only one writes the history line. A file that is missing is named —
 * nothing can be recorded — and the guards match the read's.
 */
export function takePending(
  project: string,
  root: string,
  home: string,
  id: string,
): { ok: true; taken: string } | { ok: false; reason: string } {
  const path = pendingPath(project, root, home, id);
  const held = heldAt(path);
  if (held.kind === 'missing') return { ok: false, reason: 'no pending record holds that id; nothing was recorded' };
  if (held.kind === 'link') return { ok: false, reason: 'a symbolic link was found and not followed' };
  if (held.kind !== 'file') return { ok: false, reason: 'the pending record is not a regular file' };
  if (process.getuid !== undefined && held.uid !== process.getuid()) return { ok: false, reason: "another user's file" };
  const taken = join(pendingDir(project, root, home), `.${id}.${String(process.pid)}.taken`);
  try {
    renameSync(path, taken);
    return { ok: true, taken };
  } catch {
    return { ok: false, reason: 'the pending record could not be taken; nothing was recorded' };
  }
}

/** Drops a taken record once its history line is written. A leftover name is this user's own
 *  hidden file and is not a second delivery; it is left for the owner's own cleanup. */
export function dropTaken(taken: string): void {
  try {
    unlinkSync(taken);
  } catch {
    // the history line is written; the leftover names no pending send any more
  }
}

/** Puts a taken record back when its history line could not be written, so the sender can retry
 *  the confirm. A restore that fails leaves the taken file behind and the id unconfirmed. */
export function restoreTaken(taken: string, project: string, root: string, home: string, id: string): void {
  try {
    renameSync(taken, pendingPath(project, root, home, id));
  } catch {
    // the refusal names the history write; this only best-effort restores the record
  }
}

/** The record's shape, checked whole: an unknown version, a missing field or a wrongly-typed one
 *  is not a record this version wrote. The id inside must be the file's own name. */
function shapeOf(value: unknown, id: string): PendingNative | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const flat = value as Record<string, unknown>;
  if (flat.v !== 1) return null;
  if (flat.id !== id) return null;
  const fields = ['ts', 'from', 'to', 'team', 'session', 'cli', 'pane', 'address', 'rule', 'project', 'root', 'body'] as const;
  for (const field of fields) {
    if (typeof flat[field] !== 'string') return null;
  }
  if (flat.from_id !== null && typeof flat.from_id !== 'string') return null;
  if (flat.to_id !== null && typeof flat.to_id !== 'string') return null;
  if (fields.some((field) => (flat[field] as string) === '')) return null;
  if (!Number.isFinite(Date.parse(flat.ts as string))) return null;
  return {
    v: 1,
    id,
    ts: flat.ts as string,
    from: flat.from as string,
    from_id: flat.from_id as string | null,
    to: flat.to as string,
    to_id: flat.to_id as string | null,
    team: flat.team as string,
    session: flat.session as string,
    cli: flat.cli as string,
    pane: flat.pane as string,
    address: flat.address as string,
    rule: flat.rule as string,
    project: flat.project as string,
    root: flat.root as string,
    body: flat.body as string,
  };
}
