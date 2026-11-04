// The daemon's own reminder send: the one entry the machine daemon uses to deliver a reminder
// under its own identity. It is internal — no command line reaches it and no `io.caller` stands
// in for it. The run's caller is the daemon principal this module establishes after the state
// record and the single-instance lock prove this process is the daemon, and the verifier is
// asked again before every transport the walk could take. A refusal at either point ends the
// send with no transport attempted, and an exception from the verifier is read as a refusal,
// never as consent.
//
// The recipients are the reminder's own list for this due instant: the principal carries them
// into admission, which refuses any address outside it, any owner or pane, any human seat, and
// any checkout the daemon did not host when the principal was established.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Io } from '../io.ts';
import { recordDir } from '../commands/messages.ts';
import { realHost, runSend, type DaemonRecipient, type DaemonSendPrincipal, type SendHost } from '../commands/send.ts';
import { recordFile } from '../send/record.ts';
import { verifyDaemonAuthority, type DaemonIdentity } from './authority.ts';

/** What the reminder layer hands its send: the reminder's name and due key, and the seats that
 *  due instant addresses. The daemon's home — where its state record and lock live — is the
 *  host's, so no caller can point the proof at another machine folder. */
export type DaemonDirectContext = {
  reminder: string;
  due: string;
  recipients: readonly DaemonRecipient[];
};

/** One reminder delivery: the recipient's checkout, the declared seat, and the body the reminder
 *  text produced. The run loads the team file from `root` and walks that seat's delivery order
 *  exactly as an ordinary send does. `id` is the retry's one identity: a reminder retried on a
 *  later beat carries the message id it already staged, so the same message cannot arrive twice
 *  under two names. */
export type DaemonDirectRequest = { root: string; seat: string; body: string; id?: string };

/**
 * The outcome the reminder state records for one recipient: whether it went, the one message id
 * every attempt carried, whether a signed record was staged under it — the sign that the walk
 * reached a transport rather than an admission refusal — and the words the run wrote, never a
 * claim of a read the receiving seat did not sign.
 */
export type DaemonDirectResult = {
  ok: boolean;
  code: number;
  /** The message id the attempt carried; null when the daemon's identity was refused before a
   *  send was ever built, so no message was named. */
  id: string | null;
  staged: boolean;
  text: string;
};

/** Where the run's own words go. The daemon's process writes them to its standard streams, which
 *  its log collects; the machine chores child writes them into its protocol instead, because its
 *  standard output carries frames and nothing else. */
export type DaemonDirectSink = { stdout: (text: string) => void; stderr: (text: string) => void };

/**
 * Sends one reminder to one recipient through the ordinary send command's admission, delivery
 * order and route rules. `host` is the transport/test seam and carries no identity of its own;
 * the caller is built here, from the verifier's verdict alone.
 */
export async function sendDaemonDirect(
  context: DaemonDirectContext,
  request: DaemonDirectRequest,
  host: SendHost = realHost,
  sink?: DaemonDirectSink,
): Promise<DaemonDirectResult> {
  const first = verify(host);
  if (!first.ok) return { ok: false, code: 1, id: null, staged: false, text: first.why };
  const identity: DaemonIdentity = first.identity;
  // The id is minted (or the retry's kept) before the walk, so every attempt of one reminder
  // carries it and the result can name the message even when no transport took it.
  const id = request.id ?? host.sendId?.() ?? randomUUID();
  const principal: DaemonSendPrincipal = {
    reminder: context.reminder,
    due: context.due,
    recipients: context.recipients,
    roots: first.roots,
    recheck: () => {
      const again = verify(host, identity);
      return again.ok ? { ok: true } : { ok: false, why: again.why };
    },
  };
  const said: string[] = [];
  // No guard is handed in: the send composes the principal's own recheck itself, from the
  // principal it carries, before every transport. This entry never relies on a caller
  // remembering to wire the check — it hands over the principal and lets the seam do it.
  const code = await runSend([request.seat, request.body], daemonDirectIo(request.root, said, sink), {
    ...host,
    sendId: () => id,
    daemon: principal,
  });
  // A record staged under the id is the walk's own evidence that it reached a transport; an
  // admission refusal writes nothing, so the retry rule can tell the two apart.
  const recipient = context.recipients.find((one) => one.root === request.root && one.seat === request.seat);
  const staged = recipient !== undefined && existsSync(recordFile(recordDir(request.root, recipient.session, request.seat), id));
  return { ok: code === 0, code, id, staged, text: said.join('') };
}

/** The actual verifier, read as a verdict on every path: an exception is a refusal with its own
 *  reason, so no caller can continue optimistically past a verifier that could not answer. */
function verify(host: SendHost, captured?: DaemonIdentity): ReturnType<typeof verifyDaemonAuthority> {
  try {
    return verifyDaemonAuthority({ home: host.home, now: host.now(), ...(captured === undefined ? {} : { captured }) });
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/** The run's io: the recipient's checkout as its working directory, so the team file the run
 *  loads is the one the daemon hosted, and no caller of the process's own: the daemon principal
 *  is established by `sendDaemonDirect` alone. The words always land in `said`; without a sink
 *  they also reach this process's standard streams, which is where the daemon's log reads them. */
function daemonDirectIo(root: string, said: string[], sink?: DaemonDirectSink): Io {
  return {
    stdout: (text) => {
      said.push(text);
      if (sink !== undefined) sink.stdout(text);
      else void process.stdout.write(text);
    },
    stderr: (text) => {
      said.push(text);
      if (sink !== undefined) sink.stderr(text);
      else void process.stderr.write(text);
    },
    cwd: root,
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}
