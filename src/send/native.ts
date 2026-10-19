// Native-CLI delivery: the body goes to a drop file, and the pane receives one short trigger.
//
// Measured on herdr 0.7.1 (2026-10-12, scratch session b2-send-native, then b2-send-key):
// `pane send-text` and `pane send-keys` both exit 0 with empty stdout when the bytes were
// written, including when a canonical reader never saw a 1024-byte line and when a short line
// stayed in the codex composer. `enter` and `Enter` both submit: a line sink recorded
// `key-enter` and `key-Enter`. Submission showed up as herdr `agent_status` `working` about
// 0.4s after Enter — cursor by the pane hint `ctrl+c to stop`, codex by a spinner in the OSC
// title, agy by the `esc to cancel` footer. Codex then reported `done`, and `done` was still
// the status when the next submit began. An immediate Enter once left the line unsubmitted;
// a second Enter submitted it. Agy 1.3.3 on a 13-column pane submitted 200 characters and, at
// 400, collapsed the composer so Enter inserted lines. Two send-texts before Enter concatenate.
//
// `delivered` rests on that status change, not on the exit code and not on pane text read here.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The longest trigger typed into a pane. Agy on a 13-column pane submitted 200 and collapsed at 400. */
export const TRIGGER_MAX = 200;

/**
 * Above this size a message is never typed into a pane. This build file-drops every native body,
 * including shorter ones, because the ceiling moves with the pane width and a typed line is not
 * truncated — it is either submitted whole or not submitted.
 */
export const INLINE_CEILING = TRIGGER_MAX;

/** The gap before Enter. An immediate Enter once left the line in the composer (exit 0). */
export const SETTLE_MS = 1000;

/** How often the seat's herdr status is read while waiting for it to change. */
export const POLL_MS = 200;

/** Polls after one Enter before a second Enter is tried. Five is one second. */
export const POLL_LIMIT = 5;

/** What types the trigger and reports herdr's status. Tests pass a fake. */
export type NativePane = {
  typeText(session: string, pane: string, text: string): boolean;
  pressEnter(session: string, pane: string): boolean;
  status(session: string, pane: string): string | null;
  wait(ms: number): Promise<void>;
  /** The pane's visible text, or null when it cannot be read. Absent means the caller does not look. */
  paneText?(session: string, pane: string): string | null;
  /** One key, spelled as herdr spells it (`escape`, `enter`, `down`, `up`, `ctrl+c`). Absent
   *  means a screen walk that needs a key is refused, never silently skipped. */
  sendKey?(session: string, pane: string, key: string): boolean;
  /** The pane's foreground working directory, or null. Absent means the caller falls back to
   *  the seat's recorded folder. */
  foregroundCwd?(session: string, pane: string): string | null;
};

/**
 * One line naming the drop file, or null when that line would be longer than `TRIGGER_MAX`
 * or would not be one line. The body is never part of the line.
 */
export function triggerLine(path: string): string | null {
  const line = `Read ${path} and do that.`;
  if (line.includes('\n') || line.length > TRIGGER_MAX) return null;
  return line;
}

/**
 * The trigger a message's typed leg types: the seat runs its own drop read, the same command its
 * turn-start hook runs, so the line that wakes it is also the one that writes the signed read
 * receipt beside the drop — `team drops --read` prints the body after the receipt is on disk. The
 * seat and session are the receiver's, exactly as its launch names them. Null when that line
 * would be longer than `TRIGGER_MAX` or would not be one line; the caller then refuses the send
 * before anything is written.
 */
export function readTriggerLine(seat: string, session: string): string | null {
  const line = `Run team drops --read --seat ${seat} --session ${session} and do that.`;
  if (line.includes('\n') || line.length > TRIGGER_MAX) return null;
  return line;
}

/**
 * Whether the samples show the seat took the trigger.
 *
 * `working` is enough on its own when the seat was not working before Enter. `done` and `blocked`
 * count only when they differ from the status read before Enter: a codex seat sits at `done` after
 * the previous turn, so that same status is not a new submission. A seat that was already working
 * before Enter proves nothing by its status at all.
 */
export function sawSubmission(before: string | null, samples: readonly string[]): boolean {
  // A seat that was already working before Enter says nothing about this line: `working` after
  // Enter is the turn it was in, and a `done` after it is that turn ending. Only the transcript
  // can show such a seat took the trigger.
  if (before === 'working') return false;
  for (const sample of samples) {
    if (sample === 'working') return true;
    if ((sample === 'done' || sample === 'blocked') && sample !== before) return true;
  }
  return false;
}

/**
 * Writes `body` whole, mode 0600, by renaming a temp file in `directory` onto `id`.
 * The directory is mode 0700. The bytes are not truncated.
 */
export function dropMessage(directory: string, id: string, body: string): string {
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  const finalPath = join(directory, id);
  const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, finalPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename's error is the one the caller sees.
    }
    throw error;
  }
  return finalPath;
}

export type SubmitResult = { ok: true; status: string } | { ok: false; reason: string };

/**
 * Types `line` once, presses Enter, and reads herdr's status. A first Enter that leaves the
 * status unchanged is followed by one more Enter — the miss measured when Enter was sent
 * before the composer had the line. Never reads the pane. `hold`, when given, is asked once
 * after the first Enter leaves the status unchanged and before a second Enter: true means
 * press nothing further.
 */
export async function submitTrigger(
  pane: NativePane,
  session: string,
  paneId: string,
  line: string,
  hold?: () => boolean,
  beforeEnter?: () => boolean,
): Promise<SubmitResult> {
  const before = pane.status(session, paneId);
  if (before === null) return { ok: false, reason: "the seat's status could not be read" };
  if (!pane.typeText(session, paneId, line)) return { ok: false, reason: 'the pane did not take the trigger' };
  await pane.wait(SETTLE_MS);
  if (beforeEnter?.()) return { ok: false, reason: 'held' };
  if (!pane.pressEnter(session, paneId)) return { ok: false, reason: 'the Enter was not taken' };
  const first = await watch(pane, session, paneId, before);
  if (first !== null) return { ok: true, status: first };
  if (hold?.()) return { ok: false, reason: 'herdr did not report the seat working' };
  if (!pane.pressEnter(session, paneId)) return { ok: false, reason: 'the Enter was not taken' };
  const second = await watch(pane, session, paneId, before);
  if (second !== null) return { ok: true, status: second };
  return { ok: false, reason: 'herdr did not report the seat working' };
}

async function watch(pane: NativePane, session: string, paneId: string, before: string | null): Promise<string | null> {
  const samples: string[] = [];
  for (let i = 0; i < POLL_LIMIT; i++) {
    await pane.wait(POLL_MS);
    const sample = pane.status(session, paneId);
    if (sample === null) return null;
    samples.push(sample);
    if (sawSubmission(before, samples)) return sample;
  }
  return null;
}
