// The watch's own direct-work send: the one entry a hosted watch uses to wake an idle seat. It is
// internal — no command line reaches it and no `io.caller` stands in for it. The run's caller is
// the watch principal this module establishes after the actual `verifyWatchAuthority` proves this
// process holds the watch, and the verifier is asked again after preparation and immediately before
// every direct transport the walk could take, including the typed fallback a refused socket leg
// hands the send to. A refusal at either point ends the send with no transport attempted, and an
// exception from the verifier is read as a refusal, never as consent.
//
// The context, not the process's working directory, selects the team file: the root is the one
// the watch host captured, the verifier loads the team file from it canonically, and admission
// compares the captured root with the root the run actually loaded. The epoch is the one the
// host captured when it acquired the watch — never a queue field, a request field or a wrapper
// argument — and it is the host's own memory that is the source of truth for it.
import type { Io } from '../io.ts';
import { sendDirect, realHost, type SendHost, type WatchSendPrincipal } from '../commands/send.ts';
import { verifyWatchAuthority, WATCH_DIRECT_WORK, type WatchActorVerdict } from './authority.ts';
import { workPushResultOf, type WorkPushRequest, type WorkPushResult } from './dispatch.ts';

/** What a watch host hands its direct-work send: the team root and session it was bound to, and
 *  the epoch it captured when it acquired the watch. */
export type WatchDirectContext = { root: string; session: string; capturedEpoch: string };

/**
 * Sends one work push through the ordinary send command's admission, delivery order and route
 * rules, walking only the direct wake legs — plus the typed fallback when a socket leg this run
 * dialed is refused. `host` is the transport/test seam and carries no identity of its own; the
 * caller is built here, from the verifier's verdict alone.
 */
export async function sendWatchDirect(
  context: WatchDirectContext,
  request: WorkPushRequest,
  host: SendHost = realHost,
): Promise<WorkPushResult> {
  const first = verify(context);
  if (!first.ok) return { ok: false, refused: first.why };
  const principal: WatchSendPrincipal = {
    root: context.root,
    session: context.session,
    ...(first.actor.pane === undefined ? {} : { pane: first.actor.pane }),
    recheck: () => {
      const again = verify(context);
      return again.ok ? { ok: true } : { ok: false, why: again.why };
    },
  };
  const said: string[] = [];
  // No guard is handed in: the send composes the principal's own recheck itself, from the watch
  // it carries, before every direct transport. This entry never relies on a caller remembering
  // to wire the check — it hands over the principal and lets the seam do it.
  const run = await sendDirect(watchDirectIo(context.root, (text) => said.push(text)), host, {
    seat: request.seat,
    pane: request.pane,
    cli: request.cli,
    body: request.body,
    watch: principal,
  });
  return workPushResultOf(run.result, said.join(''));
}

/** The actual verifier, read as a verdict on every path: an exception is a refusal with its own
 *  reason, so no caller can continue optimistically past a verifier that could not answer. */
function verify(context: WatchDirectContext): WatchActorVerdict {
  try {
    return verifyWatchAuthority({
      root: context.root,
      session: context.session,
      epoch: context.capturedEpoch,
      purpose: WATCH_DIRECT_WORK,
    });
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/** The run's io: the captured root as its working directory, so the team file the run loads is
 *  the one the watch was verified against, and no caller of the process's own: the watch
 *  principal is established by `sendWatchDirect` alone. */
function watchDirectIo(root: string, onStderr: (text: string) => void): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => {
      onStderr(text);
      void process.stderr.write(text);
    },
    cwd: root,
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}
