import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { deliver as relayDeliver, stage as relayStage } from '../../packages/relay/index.js';
import { readArgs, type Args } from '../args.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { runClientSend } from '../client/send.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, detachedRefusal, judgeCallerIn, logTag, noPaneRefusal, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { resolveSeatOverrides, seatOverridesOf, seatSettingsOf, type SeatOverrides } from '../config/apply.ts';
import { loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { agentList, agentStatus, paneForegroundCwd, paneProcesses, paneRead, pressEnter, sendKey, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { rulesOf } from '../launch/rules.ts';
import { acquireSeatLock, seatLockPath } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { briefTransportOf, MEMORY_TRANSPORT_UNSUPPORTED } from '../policy/brief-transport.ts';
import { codexDaemonForSeat } from '../policy/codex-daemon.ts';
import { contextLine, hasJsonFlag, jsonError, pluralCount, renderTable, writeJson, writeJsonError, type PlanStep } from '../output/index.ts';
import { profileFor } from '../profiles/index.ts';
import { PENDING_ID, clearPending, dropTaken, markPending, nativeNonceOf, readPending, restoreTaken, takePending, writePending, type PendingNative, type PendingNativeFallbackLeg } from '../send/pending.ts';
import { readAgents, type Agent } from '../registry/agents.ts';
import * as projectRegistry from '../registry/projects.ts';
import { readTeams, teamIdOf, type TeamRecord } from '../registry/teams.ts';
import { realSources as realProjectSources, type ProjectSources } from './projects.ts';
import { liveSocketOf } from '../send/address.ts';
import { admitSend, RULE_SUMMARY, sendGrantFor, senderHeader, teamOf, type AdmitContext, type AdmitTeam, type AdmitTeams, type DeclaredSender, type SendSide } from '../send/admit.ts';
import { deliverCompose } from '../send/compose.ts';
import { readSendGrants } from '../send/grants.ts';
import { appendHistory } from '../send/history.ts';
import { ensureRecord, readRecord, signReceiptPayload, signRecord, verifyRecord, writeReceipt, type RecordPayload, type SignedRecord } from '../send/record.ts';
import { NATIVE_BODY_MARKER, NATIVE_CHANNEL } from '../send/routes.ts';
import { daemonSocketPath, isBareShellPane, requestDaemon, type DaemonSendResponse } from '../send/daemon.ts';
import { deliveryChainOf } from '../send/delivery.ts';
import { namingFor, senderDisplayName } from '../send/names.ts';
import {
  deliverCodexNativeRoute,
  deliverHeadlessResumeRoute,
  HEADLESS_RESUME_UNAVAILABLE_REASON,
  isHeadlessResumeCli,
  type HeadlessResumeSpawn,
} from '../send/push-adapters.ts';
import { bindPane, deliverTrigger, draftNote, showsHeldFrameDialog, showsTranscriptToken, TRIGGER_TAKEN_NOTE, type DeliverResult } from '../send/deliver.ts';
import { POLL_MS, readTriggerLine, TRIGGER_MAX, type NativePane } from '../send/native.ts';
import { awaitReceipt, claimBindingIn, inboxLive, INBOX_GRACE_MS, INBOX_POLL_MS, receiptHeld } from '../mcp/inbox.ts';
import { beginFallbackWalk, type FallbackWalk, type WalkAttempt } from '../send/fallback-walk.ts';
import type { AttemptOutcome, RelayReceipt } from '../send/fallback-events.ts';
import { markTaken } from '../send/taken.ts';
import { isRegistrySpec, parseSpec, resolveTarget, type Target } from '../send/resolve.ts';
import { FRAME_LIMIT, SOCKET_SEND, sendFrame, type SendOutcome } from '../send/uds.ts';
import { frameFor, frameReplyFor } from '../send/frame.ts';
import {
  declaredInboundOf, heldSocketPath, inboundIsLive, readHeldSocket, recordHeldSocket,
  socketEligible, socketHeldReason, socketSkipReason, type CrossSessionInbound, type InboundDeclaration,
} from '../send/inbound.ts';
import type { DeliveryLeg, SettingLevel } from '../settings/inherit.ts';
import { deliveryOrder } from '../settings/resolve.ts';
import { MESSAGE_LINE_MAX, messageSummaryOf, renderMessageDisplay } from '../settings/message-display.ts';
import { messageDisplayInForce } from '../settings/message-display-policy.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { deliveryTimeoutInForce } from '../policy/delivery.ts';
import { messageKeyState } from '../store/keys.ts';
import { buildIdentity, type BuildIdentity } from '../version.ts';
import { modelDiffers, runningModel } from '../status/statusline.ts';

export const USAGE = `Usage: team send <seat> <message> [--subject <text>] [--wait] [--timeout <s>] [--json] [--dry-run]
       team send <seat> --file <path> [--subject <text>] [--wait] [--timeout <s>] [--json] [--dry-run]
       team send <seat> --brief <path> [--subject <text>] [--wait] [--timeout <s>] [--json] [--dry-run]
       team send --client <grant-file> --key <key-file> <address> [--request-id <id>] <message>
       team send --client <grant-file> --key <key-file> <address> [--request-id <id>] --file <path>
       team send --confirm <id> [--json] [--dry-run]
       team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
       team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
       team send --list [--json]

Writes one message to one seat. A plain send writes the body whole to a drop file
(mode 0600, atomic rename) and types one short trigger line, for every seat; a
sender whose own file declares Claude Code, to a Claude Code seat, gets the native
handoff below instead. The body is never split across several writes. A seat whose
CLI builds its own work item from its screens — a profile with a compose module —
still gets the drop file, but the body is typed through those screens and never
becomes a trigger line; delivered there means the CLI printed the line that creates
the item. On the typed leg the run is sent (unconfirmed): the line left the seat's
input box after that trigger line and Enter, and herdr reported the seat working — or
done or blocked, changed from the status read before Enter — or the transcript shows
the drop being read; no signed receipt has come back, so the message is never called
read. The pane must not be a dialog this command already classifies (question,
permission, trust, vendor notice, provider error, rate limit). A screen that is one of
those is not reached: the kind and the drop path are named, and nothing further is
pressed. Who may call it is the registry's decision, default deny: the
owner; an orchestrator to an orchestrator of its own team or entity; an orchestrator
or operator to a seat of its own team; a seat whose role is operator to another such
seat of its own team; an assistant seat to its entity's coordinator; any seat to its
own team's orchestrator; or an owner-signed grant naming send. The record is signed
with the checkout's message key, and its payload names the sender and the rule that
admitted it. --list sends nothing: it prints
the file's seats and the seats of the other teams of the same entity, each
with the project its team sits in — another team's seat reads <seat>@<team> —
and needs no caller check. --dry-run resolves the seat and the
legs the run would walk, writes no drop file, and types nothing. It
writes no record, dials no socket and appends no line to the team log: a dry run
writes nothing, and the log records writes. Under --json its document's \`delivery\`
names every leg in order with \`eligible\` and the reason it would be skipped, including
the socket leg a Claude receiver's files keep out.

A send walks the receiving seat's delivery order — mcp-inbox, typed, drop by
default. For Codex with no declared order, the runtime queue leads when its signed
codex-daemon setting is on, followed by a typed wake before the inbox fallback; when off,
the typed wake leads. A declared order is followed as written. A level of that seat's own
chain, entity, project, team, seat, may drop legs from the order or put the legs it keeps in a
different order, and may add
native, the sender's own frame, headless-resume, a headless runtime's own turn,
or place socket anywhere: a word naming a leg the order does not have, or naming
one twice, is set aside and the order in force stands. Each leg in turn
either takes the send, which ends the walk, or definitely cannot take it, which
hands the send to the next leg and is recorded as a failure. A typed leg that
finds no live agent — no agent carries the seat's name in its session, or the
session cannot be read — types nothing and hands the send to the next leg, its
reason recorded as \`typed: <reason>\`; once it types, its own outcome is the
send's. The drop
leg writes the same 0600 drop file and types nothing at all. A seat the file marks
human: true walks the drop leg alone, whatever its delivery order or the default
says: every other leg is kept out — each one's reason is recorded — and the walk
writes the drop file, with nothing typed and no frame sent. The history line names
the channel the send went by and the legs that failed before it.

The mcp-inbox leg writes the same 0600 drop file and types nothing: it takes the
send only when the seat's own inbox server is running (\`.inbox-listener\` beside
the message names this seat, this session and this root, with a live pid), and is
otherwise skipped as \`mcp-inbox: no live inbox listener\`. A live listener gets
the message and a short wait for the receipt its \`inbox_read\` call leaves; that
receipt is \`delivered (read)\` — the seat read the message, not that it acted on
it — and its absence is \`sent (unconfirmed)\`, exit 0: the file is safe on disk
and the walk ends rather than typing into a pane the inbox was chosen over.

The outcome is one of eight, and none of them is silent:
  delivered    the socket path (exit 0): the frame was taken, or herdr reported the
               seat working; \`delivered (read)\` when the mcp-inbox leg's receipt came
               back inside its grace — the seat read the message, which is not a claim
               that it acted on it. A trigger typed into a composer is never delivered:
               it is \`sent (unconfirmed)\`
  sent         a leg's success with no signed read receipt (exit 0). The mcp-inbox and
               drop legs left the 0600 record in the seat's inbox or drop folder and
               typed nothing; the typed leg wrote the same record and the trigger left
               the composer, and its line says \`trigger taken, no read receipt yet\`
  answered     --wait: a reply record on the thread arrived within the window; the
               reply follows on stdout (exit 0)
  held         the message is safe — on disk, or in the frame a Claude Code seat's
               held-message dialog keeps, printed held (socket) — and the pane was
               left untouched because the seat remained busy, locked, or in a dialog,
               or its unsent text has no way out of the box this version measured:
               the reason names the copy's path when one was kept. A box holding
               unsent text does not hold the delivery: the text is copied beside the
               drop, the box is cleared with the profile's measured keys, the trigger
               is typed and pressed Enter, and the text is pasted back exactly, its
               row unchanged, before the run's verdict (exit 1 only where the box
               could not be cleared or the text put back); a box drawn over more than
               one row is held untouched, since a soft wrap cannot be told from a
               newline
  not-submitted the line was typed and the seat never took it (exit 1): Enter was
               pressed up to three times, and only to a box still holding exactly the
               trigger; the message names what the box holds, faint suggestions not
               counted, the drop path, and where the unsent text went — pasted back,
               or kept in its copy with the copy's path. A compose seat's brief that
               was typed and never confirmed is also not-submitted: its message names
               the screen that never came and the one line that repairs it
  timeout      --wait: the record was sent, and no reply record on the thread arrived
               within the window (exit 1); the thread stays open
  unreachable  no leg could take the send (exit 1): the typed leg found no live
               agent and no leg stood behind it, the pane is one of those dialogs,
               or the pane would not take the trigger. A compose seat refuses here,
               naming the repair, when the module stopped before typing anything
  refused      nothing was sent (exit 1): not a declared seat, a trigger that would
               exceed the measured line length, or a caller that may not send

--wait writes the signed message record through the receiving seat's delivery walk
and waits up to --timeout seconds (default 120, up to 86400) for the first verified
reply record on the thread (written by \`team reply <id> <text>\`). A seat the file
marks human: true walks the drop leg alone and types nothing. When the window
closes with no reply on the thread, the run exits 1 (timeout) and the thread stays
open; a reply after the window still arrives on the thread.

--json prints one document instead of the lines: the action surface and the
outcome in one — {format, dry_run, status, action_summary, project, session, seat,
channel, ids, thread?, reply?, plan?, delivery?} — and --list prints its own: {format, project,
session, seats, summary}. \`delivery\` is the resolved walk's legs in order: a real send's
entry is attempted (its transport was reached, with the reason when the transport did not
take the send), queued (another command holds the seat's lock, so the leg left the record
and its marker for the delivery that follows), skipped (a rule kept it out, with the
reason), refused (a rule ended the walk, with the reason) or not-reached (the walk ended
before it); a dry run lists candidate or skipped with \`eligible\` and the reason. A run
that exits 1 or 2 writes the structured error document instead — {error: {id, message,
repair}} — and stderr stays empty; a send that resolved its walk carries the same
\`delivery\` list there too. When another command holds the seat's lock, the reachable
legs queue the send instead of refusing: the signed record and its marker are written
without that lock, nothing is typed, and the run answers \`<seat>: queued (receiver
busy) (<leg>, <n> ms; id <id>)\`, exit 0, with the id the delivery keeps, never a claim
of a read. A compose seat has no queued leg — nothing on the watch's side walks its
screens — so its held lock stays a refusal, and its line says the send was not queued
and to run it again when the seat is free.
--file reads the body from a file instead of the one <message> argument; --file -
reads it from standard input, and --brief - does the same. A command-bearing or
multiline body — code, a log, a brief — is safest from a file or a pipe: the
shell can rewrite an inline message, while a single-quoted argument is passed
through unchanged. --brief reads a whole draft brief into the body, exactly as
--file does, and is the form to use when the message is a brief: a body that is
only a path to a brief file (a lone path naming a briefs/….md file) is warned
about on stderr, on either form, because a reader cannot open a file it was not
given. A multiline body that looks like terminal output — two or more lines
starting with a check mark or a bracketed number — is warned about on stderr and
sent unchanged, never cut.

--subject writes one display line beside the body: it fills the {subject} slot
of the message-display template and never stands in for {summary}, which is
always the body's own first content line. The word is sanitised like every
other field; a blank --subject is no subject at all.

A Claude Code seat's native leg is the sender's own cross-session SendMessage, which this
process cannot make for it. A sender whose own file declares Claude Code gets the handoff
instead of a skip: the recipient's live pane is found, its socket resolved, and the pair is
admitted exactly as a plain send's is; one pending record is written to the caller's own
project state (mode 0600, one file per id) and the run prints the exact target, the body and
the one line that records the delivery — then exits 0, status native. Nothing is delivered by
that run. The sender makes the call itself, and \`team send --confirm <id>\` writes the one
history line (outcome delivered, via native, the span from the handoff to the confirm) and
clears the pending record. A confirm is the handoff's own decision: the pair, the body and
the address are the ones the record carries, and the caller must be the sender that printed
it. A delivery that is never confirmed has no history line; --record below writes one by
hand.

--record writes no drop file, sends no frame and touches no pane: the sender
delivered with its own tool (a Claude Code seat's cross-session message), and this
writes down that delivery — one history line, outcome delivered, via native, with
the span the sender measured in --ms (a whole number of milliseconds). --channel
takes native, the one channel this half exists for, and is required beside --record;
--wait and --timeout are refused there, because nothing is delivered here. The
recipient's record and admission are judged exactly as a plain send's — a recorded
delivery is never a way around the rules — and the body is optional: given, it is
recorded verbatim, and without it the line says the text did not pass through this
CLI. \`team route <seat>\` answers the address such a delivery uses.

--client sends as an external client principal named by an owner-signed grant, never
as the owner or a seat: the request is signed with the client's own key and one
signed drop is written to the entity's orchestrator — \`orchestrator@floor\` is the only
address this build admits. The grant names the destination
entity and the orchestrator role, expires within 7 days and is refused once revoked.
A request id is used once. The key file is mode 0600 in the client's own
configuration folder. Key isolation is not enforced: every process running as the
same user can read that file, and each client send says so on stderr.

Not in this build: broadcast.
Exits 0 when delivered, answered, listed, recorded, or resolved by --dry-run,
1 when held, not-submitted, timed out, unreachable, stopped, or refused, 2 when
the invocation or team file can't be read.
`;

/** The walk's ending as a direct-only caller reads it: which route took the send or ended it,
 *  the one message id every attempt carried, and the signed record's path when one was staged. */
export type DirectSendResult = {
  outcome: AttemptOutcome;
  route: string;
  id: string;
  record: string | null;
  reason?: string;
};

/**
 * The watch's idle dispatch uses this hook. With it set, the send walks only routes that reach a
 * live receiver without a keystroke — the typed and native legs type, and the drop and mcp-inbox
 * legs are stored copies rather than wakes, so none of the four is attempted. The walk's ending is
 * handed back as a result instead of only an exit code. Admission, the delivery order and every
 * remaining route's rules are the same ones an ordinary send runs.
 */
export type DirectSendHook = {
  /** The pane and CLI the caller's own pass saw for this seat: the send is bound to them, and a
   *  seat the session no longer lists at that pane, or whose file names another CLI, is refused
   *  before any route is attempted. */
  expect?: { pane: string; cli: string };
  /** A caller's own narrowing recheck, run after preparation and immediately before each route
   *  a direct walk could transport on, socket or a functional headless route. On the watch's own
   *  run the principal's actual verifier is composed in front of it whatever this holds — omitted
   *  or permissive, it can only narrow, never replace. A refusal ends the walk without another
   *  transport attempt; a throw is read as a refusal, never as consent. */
  guard?: () => { ok: true } | { ok: false; why: string };
  /** Called once, when a route's ending closes the walk, before the command returns. */
  ended(result: DirectSendResult): void;
};

/**
 * The watch process's own principal for one direct-work send. It is established only by the
 * internal `sendWatchDirect`, after `verifyWatchAuthority` proves this process holds the watch:
 * no command line, no delivery-order request and no io caller can set it. `recheck` is the actual
 * verifier bound to the host's captured epoch, asked again before every direct transport; the
 * watch host's own report or a wrapper's boolean is never read as authority.
 */
export type WatchSendPrincipal = {
  /** The team root this watch host captured. Admission compares it, canonically, with the team
   *  file the run loaded: equal session names in another root are not this watch's team. */
  root: string;
  session: string;
  pane?: string;
  recheck(): { ok: true } | { ok: false; why: string };
};

export type SendHost = {
  /** The live agents of a session; null when herdr can't be reached. `cli` is the agent herdr
   *  reads on the pane (`claude`, `codex`, …), the process name a CLI profile names — null or
   *  absent when herdr reported none. */
  agents(session: string): { name: string; pane: string; cli?: string | null }[] | null;
  /** A pane's process pids, or null when the pane can't be read. */
  processInfo(session: string, pane: string): PaneProcesses | null;
  /** The folder the session sockets live in; the real one is the runtime temp folder's. */
  socketsDir: string;
  /** Where else a session's own sockets have been found: this Mac's Claude Code wrote them
   *  at /tmp/cc-socks while `tmpdir()` answered the per-user runtime folder, so discovery
   *  tries this one after socketsDir. The real host only; tests fake one folder. */
  socketsDirAlt?: string;
  deliver(socketPath: string, frame: string): Promise<SendOutcome>;
  /** Types a native seat's trigger and reads herdr's status. Tests pass a fake. */
  native: NativePane;
  now(): Date;
  /** The id a native handoff prints and records under; the real host mints a UUID, and a test or
   *  the docs runner pins one so the printed confirm line is exact. */
  newId?: () => string;
  /** The id a send record is written under when a test pins it; the real host mints a UUID. */
  sendId?: () => string;
  /** How long a client send waits for the shared grant lock before refusing busy. The real host
   *  leaves it at the client module's own bound; a test sets a short wait. */
  clientLockWaitMs?: number;
  home: string;
  /** The project registry, for the project each seat's team sits in. The real one when absent;
   *  a test stands in for it. */
  projects?: ProjectSources;
  /** Optional override for the per-project send daemon socket path. */
  daemonSocket?: string;
  /** The receiving seat's own chain for the delivery order — entity, project, team, seat. Left
   *  out (the real host does), the chain is read from the files: the receiving team file's own
   *  key and the seat's, and the registry project's (`src/send/delivery.ts`). A test hands in a
   *  chain to decide the order without a file to write. */
  delivery?: Partial<Record<SettingLevel, readonly (DeliveryLeg | PendingNativeFallbackLeg)[] | undefined>>;
  /** How long the mcp-inbox leg waits for its receipt, in milliseconds. The real host leaves it
   *  at `INBOX_GRACE_MS`; a test sets 0 (beside a listener it also writes) to see the
   *  unconfirmed ending without waiting, or a small number to watch the receipt land. */
  inboxGraceMs?: number;
  /** How long `--wait` polls for a reply record on the thread, in milliseconds. Left out on the
   *  real host so `--timeout <s>` (default 120s) sets the window; a test sets a small number or 0
   *  to exercise the thread wait without sleeping. */
  waitMs?: number;
  /** The build this process runs, compared against a live inbox listener's marker. Left out
   *  (a test's host), the mcp-inbox leg keeps the liveness-only check. */
  build?: () => BuildIdentity;
  /** The direct-only ending hook: when set, the typed leg is never walked and the ending is
   *  reported once. The watch's idle dispatch is its caller. */
  direct?: DirectSendHook;
  /** The watch's own sender principal, set only by the internal `sendWatchDirect`. Absent, the
   *  caller is placed from the ordinary sources (`io.caller`, `io.callerSources`, ancestry). */
  watch?: WatchSendPrincipal;
  /** Optional process runner override for the `headless-resume` leg (`gemini` / `cursor-agent`). */
  headlessResumeSpawn?: HeadlessResumeSpawn;
};

export const realHost: SendHost = {
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane, cli: agent.agent })) ?? null,
  processInfo: (session, pane) => paneProcesses(pane, session),
  // The probe's path shape: `<tmp>/cc-socks/<pid>.sock`, the runtime temp folder's own
  // (observed on this Mac as /tmp/cc-socks; a version-specific observation, not a public
  // API contract).
  socketsDir: join(tmpdir(), 'cc-socks'),
  socketsDirAlt: '/tmp/cc-socks',
  deliver: (socketPath, frame) => sendFrame(socketPath, frame),
  native: {
    typeText: (session, pane, text) => typeText(pane, text, session),
    pressEnter: (session, pane) => pressEnter(pane, session),
    status: (session, pane) => agentStatus(pane, session),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    paneText: (session, pane) => paneRead(pane, 40, session),
    sendKey: (session, pane, key) => sendKey(pane, key, session),
    foregroundCwd: (session, pane) => paneForegroundCwd(pane, session),
  },
  now: () => new Date(),
  home: homedir(),
  projects: realProjectSources,
  build: () => buildIdentity(),
};

const send: Command = (argv, io) => runSend(argv, io, realHost);
export default send;

/** The wait's default window, in seconds. */
export const DEFAULT_WAIT_S = 120;

/** The longest a wait may run, in seconds — a day. */
export const MAX_WAIT_S = 86_400;

/** How one leg of the resolved walk stands. `attempted` means this run reached the leg's own
 *  transport; `skipped` means a rule kept it out before anything was written; `refused` means
 *  the leg ended the walk; `not-reached` means a leg before it ended the walk first. A dry run
 *  walks nothing, so its entries are `candidate` or `skipped`, with `eligible` saying which. */
type LegState = 'attempted' | 'queued' | 'skipped' | 'refused' | 'not-reached' | 'candidate';

/** One ordered entry of a send's delivery report. The leg's own name is here, so the reason
 *  never repeats it: a reader joins the two. */
type LegReport = {
  leg: DeliveryLeg;
  state: LegState;
  /** On a dry run: whether the walk would take this leg. Absent on a real send. */
  eligible?: boolean;
  /** Why the leg was skipped or refused, or why an attempt did not take the send. */
  reason?: string;
};

/** The entry the walk left for one leg, whatever state it already holds: a leg the walk marked
 *  `attempted` before its transport answered ends as a queue or a refusal, and the report says
 *  which. A run with no resolved walk (a brief's own delivery) has no list to mark. */
function setLegState(report: Report, leg: DeliveryLeg, state: LegState, reason?: string): void {
  const entry = report.delivery?.find((one) => one.leg === leg && one.state !== 'not-reached');
  if (entry === undefined) return;
  entry.state = state;
  if (reason !== undefined) entry.reason = reason;
}

/** What the run reports besides its streams: the caller chose the document, the seat it
 *  names, the id of the frame it composed (null until one is built), and the team and session
 *  the send addresses, read from the receiving team file once it names one. */
type Report = {
  json: boolean;
  seat: string | null;
  sent: string | null;
  project: string | null;
  session: string | null;
  /** The team the sender stands in, by team id: every history line this run writes carries it,
   *  so a reader in another team resolves the sender like the record does. A run that refused
   *  before a team was read names none, and writes no history line anyway. */
  from_team?: string;
  /** The resolved walk's legs, in order: a real send fills each state as the walk runs, and a
   *  dry run lists the candidates it would walk. Absent on a run that never resolved a walk. */
  delivery?: LegReport[];
};

/** The address as the caller wrote it, kept on the history line beside the resolved seat: the
 *  spec and the registry id it resolved to (`agt_…`). Absent when the spec was the seat's own
 *  name, which `to` already carries. */
type SentAs = { spec: string; resolved: string };

/** The sender's team as every history line this run writes carries it. */
function historySender(report: Report): { from_team?: string } {
  return report.from_team === undefined ? {} : { from_team: report.from_team };
}

/** Where one send goes: the registry's answer for the spec, or the declared seat of the
 *  caller's own file. */
type Aim = {
  seat: string;
  /** The recipient's registry agent id (`agt_…`), or null on the declared-seat path. */
  agentId: string | null;
  session: string;
  cli: string;
  /** The cross-session address the registry recorded for the target; null when none. */
  address: string | null;
  /** The address as written, when it was a form rather than the seat's name; null otherwise. */
  sentAs: SentAs | null;
  /** The team file's folder this send belongs to: the receiving team's, across teams. */
  dir: string;
  project: string;
  root: string;
  /** True when the target's team is not the caller's. */
  cross: boolean;
};

type TeamLoad = ReturnType<typeof loadTeamFile>;
type LoadedTeam = Extract<TeamLoad, { ok: true }>;

/** Both halves of `team send` share these before a message exists: the team file, the caller's
 *  placement, the registry's answer and the refusals a spec gets, and — for a full address
 *  written from outside any team's folder — the receiving team's own file, read in the file's
 *  place. */
type Prologue = {
  team: TeamFile;
  root: string;
  dir: string;
  fileTeamId: string;
  loaded: LoadedTeam;
  caller: Caller;
  who: string;
  from: string;
  standing: SeatStanding;
  hit: Target | null;
};

/** A run the prologue ended before a message existed: the question is which refusal, not the
 *  sentence — the call site writes it with the same helper the rest of `send` uses, so the run
 *  reads exactly as it did when the prologue wrote it itself. */
type Ended =
  | { ended: 'configuration'; message: string }
  | { ended: 'refused'; dir: string | null; who: string; reason: string };

/** A folder that is no team at all: not inside a repository, or inside one that holds no team
 *  file. A link has its own refusal, and a file that exists but does not load still reads. */
function noTeamFolder(errors: ReadonlyArray<{ message: string }>): boolean {
  return errors.length > 0
    && errors.every((problem) => problem.message === NOT_A_REPO || problem.message.startsWith('no team file here'));
}

/** The one sentence a bare name from outside a team's folder gets: it has no team to resolve in,
 *  and the forms that need none. Never a `team init` suggestion. */
function needsTeam(spec: string): string {
  return `${spec} needs a team: run it inside a team's folder, or write ${spec}@<team> (team send --list shows the addresses)`;
}

/**
 * The steps both halves of `team send` walk before a message exists. Inside a team's folder the
 * caller's own file is the reading. Outside one, a full address — an agent id, a `@<nickname>`,
 * or a `<seat|nickname>@<team>` — is still the registry's to answer, the records name their
 * teams' roots, and the receiving team's file is loaded and read in its place; a bare name has
 * no team to resolve in and is refused with `needsTeam`'s sentence.
 */
function prologue(io: Io, host: SendHost, seatName: string): Prologue | Ended {
  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    if (noTeamFolder(loaded.errors)) {
      const parsed = parseSpec(seatName);
      if ('error' in parsed) return { ended: 'configuration', message: parsed.error };
      if (parsed.kind === 'seat') return { ended: 'configuration', message: needsTeam(seatName) };
      return homeless(io, host, seatName);
    }
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return { ended: 'configuration', message: message || 'the team file cannot be read' };
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  // The id the registry writes for this team: the live file's own identity, the team a sender
  // the store holds no record for is judged in.
  const fileTeamId = teamIdOf(root);
  // The address is resolved first: the registry answers an agent id, a `seat@team` (team spelled
  // by id, project or session), a `@nickname`, or a plain seat it holds an agent for, and the
  // live herdr read is the fallback for a record that carries no pane. A spec that names nobody
  // is refused by its own answer; a plain seat the registry cannot answer keeps the
  // declared-seat path below. The live read the resolution may fall back to is the host's, one
  // reader for the session's agents, so a fake host answers it in tests.
  // A direct-work run's caller is the watch principal its internal entry established and
  // verified: the file's own session is the only one it is judged in, and no ambient placement
  // or io caller is read. Every other run places its caller as it always has.
  const judged = host.watch === undefined
    ? judgeCallerIn(io, dir, team)
    : { caller: watchCaller(host.watch), shown: watchCaller(host.watch), session: host.watch.session };
  const { caller } = judged;
  const who = logTag(caller);
  const from = senderLabelOf(caller);
  const resolved = resolveTarget(host.home, seatName, io, (session) => host.agents(session));
  // A settings record that exists and does not verify refuses the send: the address it may
  // stand for cannot be decided from a record the store disowns.
  if ('error' in resolved && resolved.kind === 'configuration') return { ended: 'configuration', message: resolved.error };
  // An ambiguous spec is refused wherever it is written, not only when it looks like a registry
  // spec: the declared-seat path below must never pick one of the two seats the registry named.
  if ('error' in resolved && (resolved.kind === 'ambiguous' || isRegistrySpec(seatName))) {
    return { ended: 'refused', dir, who, reason: resolved.error };
  }
  const hit = 'error' in resolved ? null : resolved;
  const standing = standingOf(dir, judged.session, caller);
  return { team, root, dir, fileTeamId, loaded, caller, who, from, standing, hit };
}

/**
 * A full address from a folder that is no team: the registry names the receiving team's root, so
 * its own file is loaded and the caller — the owner, the only caller this path admits, since
 * every other caller is judged by its team's file and there is none here — stands in it for the
 * read. Every refusal this path writes has no team log to write to: it is reported, not logged.
 */
function homeless(io: Io, host: SendHost, seatName: string): Prologue | Ended {
  const caller = callerOf(io);
  if (caller.kind !== 'owner') {
    return { ended: 'refused', dir: null, who: describeCaller(caller), reason: 'a send from outside a team\'s folder is the owner\'s; run it inside a team\'s folder' };
  }
  const resolved = resolveTarget(host.home, seatName, io, (session) => host.agents(session));
  if ('error' in resolved) {
    if (resolved.kind === 'configuration') return { ended: 'configuration', message: resolved.error };
    return { ended: 'refused', dir: null, who: 'owner', reason: resolved.error };
  }
  const loaded = loadTeamFile(resolved.team.root, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    const why = `${seatName}: the team "${resolved.team.project}" has a registry record, but its team file cannot be read (${resolved.team.root})`;
    return { ended: 'configuration', message: message === '' ? why : `${why}: ${message}` };
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const fileTeamId = teamIdOf(root);
  const judged = judgeCallerIn(io, dir, team);
  return {
    team,
    root,
    dir,
    fileTeamId,
    loaded,
    caller: judged.caller,
    who: logTag(judged.caller),
    from: 'owner',
    standing: standingOf(dir, judged.session, judged.caller),
    hit: resolved,
  };
}

/**
 * The declared seat a bare name names: the seat whose own name it is, or the one whose effective
 * signed nickname it is. A settings record that exists and does not verify refuses the lookup —
 * the name cannot be mapped truthfully while the word it may stand for is unknown. Resolved
 * before admission, so no guard judges a seat the caller did not name.
 */
function declaredSeatNamed(
  home: string,
  root: string,
  team: TeamFile,
  seatName: string,
): { seat?: Seat; error?: string } {
  const named = team.seats.find((seat) => seat.name === seatName);
  if (named !== undefined) return { seat: named };
  for (const seat of team.seats) {
    const read = resolveSeatOverrides({ home, root, seat: seat.name });
    if (!read.ok) return { error: read.why };
    if ((read.overrides.nickname ?? seat.nickname) === seatName) return { seat };
  }
  return {};
}

/**
 * The path a body only points at, or null. Narrow on purpose: one line that is a single path —
 * no spaces, no sentence around it — under a `briefs` folder, ending in `.md`, that resolves to
 * a regular file. Anything else is a body, not a pointer; a prose sentence that mentions a path
 * is left alone, and the guard never refuses a send.
 */
function briefPointerIn(body: string, cwd: string, home: string): string | null {
  const text = body.trim();
  if (text === '' || text.includes('\n') || /\s/.test(text)) return null;
  if (!/^(?:~\/|\/|\.{1,2}\/|briefs\/)/.test(text)) return null;
  const full = text.startsWith('~/') ? join(home, text.slice(2)) : resolve(cwd, text);
  if (extname(full) !== '.md') return null;
  if (!full.split(sep).includes('briefs')) return null;
  try {
    if (!statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return text;
}

/** The body a `--file`/`--brief` source names: the file under the caller's folder, or standard
 *  input for a lone `-`, the spelling `team pr check` uses for its body. A test hands the bytes
 *  in through `io.stdin`; the process reads its own descriptor 0. */
function bodyFrom(source: string, io: Io): string {
  if (source !== '-') return readFileSync(resolve(io.cwd, source), 'utf8');
  return io.stdin !== undefined ? io.stdin() : readFileSync(0, 'utf8');
}

/** A line that begins like a terminal's output: a check mark, or a number in brackets. */
const OUTPUT_LINE = /^\s*(?:[✓✔]|\[\d+\])/;

/** The number of lines of a body that begin like output. Two of them in a multiline body are
 *  the shape of output pasted whole — a build log, a test run — and the send warns about that
 *  shape without touching a byte of the body. */
function outputMarkerLines(body: string): number {
  return body.split('\n').filter((line) => OUTPUT_LINE.test(line)).length;
}

export async function runSend(argv: string[], io: Io, host: SendHost): Promise<number> {
  const args = readArgs(argv, ['file', 'brief', 'timeout', 'record', 'channel', 'ms', 'confirm', 'client', 'key', 'request-id', 'subject'], ['wait', 'json', 'list', 'dry-run']);
  const seatName = args.rest[0];
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  const clientFlag = argv.some((arg) => arg === '--client' || arg.startsWith('--client='));
  const report: Report = { json, seat: seatName ?? null, sent: null, project: null, session: null };
  if (args.error) {
    // The declared limitation is printed on every client invocation, including one the parser
    // refuses: a caller must never read a client path without it.
    if (clientFlag) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    return usage(io, args.error, report, clientFlag);
  }
  // The client path comes before any caller placement: a TTY can never make this run the owner,
  // and no leg but the signed drop is walked. `runClientSend` prints the declared limitation.
  if (clientFlag) {
    if (args.values.brief !== undefined) return usage(io, '--brief is for a send to a seat, not a client request', report, true);
    return runClientSend(args, io, host, json);
  }
  if (args.values.key !== undefined || args.values['request-id'] !== undefined) {
    return usage(io, '--key and --request-id are only meaningful with --client', report);
  }
  // The no-terminal refusal judges the ordinary caller. A direct-work run's caller is the watch
  // principal, established and verified by its internal entry, which may run with no terminal;
  // it is judged at admission by its own branch, never by the process's placement.
  const detached = detachedRefusal(host.watch === undefined ? callerOf(io) : watchCaller(host.watch), { who: 'the owner or a seat the send admission admits', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) {
    if (report.json) writeJsonError(io, 'send.detached', detached, 'run team send from a terminal outside herdr');
    else io.stderr(`team send: ${detached}\n`);
    // exit: send.detached
    return 1;
  }
  if (args.flags.has('list')) return listSeats(io, host, report);
  // The confirm half of the native channel: the delivery the sender made itself is written down
  // here, from the pending record the handoff left (`confirmRun`).
  if (args.values.confirm !== undefined) return confirmRun(args, io, host, json);
  // The native half of the channel: nothing is delivered here, so the seat is named by
  // `--record` and the rest of the line is the record's own options, judged on their own.
  if (args.values.record !== undefined) return recordRun(args, io, host, json);
  // Send to outcome is measured from here, past the refusals that read nothing (a refused run
  // reads no clock): this command's own handling, the same span the daemon measures from its
  // handler. The host's clock, not the wall clock: a fixed clock in a test or the docs runner
  // then reads a fixed millisecond count.
  const startedAt = host.now().getTime();

  const words = args.rest.slice(1);
  const file = args.values.file;
  const brief = args.values.brief;
  if (!seatName) {
    return usage(io, 'a seat and a message are required', report);
  }
  if (brief !== undefined && file !== undefined) {
    return usage(io, 'a brief and --file cannot both be given', report);
  }
  if (brief !== undefined && words.length > 0) {
    return usage(io, 'a message and --brief cannot both be given', report);
  }
  if (file !== undefined && words.length > 0) {
    return usage(io, 'a message and --file cannot both be given', report);
  }
  if (file === undefined && brief === undefined && words.length === 0) {
    return usage(io, 'a message or --file is required', report);
  }
  const wait = args.flags.has('wait');
  let timeoutS = DEFAULT_WAIT_S;
  if (args.values.timeout !== undefined) {
    if (!wait) return usage(io, '--timeout is only meaningful with --wait', report);
    const raw = args.values.timeout;
    const seconds = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (seconds < 1 || seconds > MAX_WAIT_S) {
      return usage(io, `--timeout takes a whole number of seconds, 1 to ${String(MAX_WAIT_S)} (got "${raw}")`, report);
    }
    timeoutS = seconds;
  }

  const pro = prologue(io, host, seatName);
  if ('ended' in pro) {
    if (pro.ended === 'configuration') return configuration(io, pro.message, report);
    return refuse(io, pro.dir, pro.who, pro.reason, host, report);
  }
  const { team, root, dir, fileTeamId, loaded, caller, who, from, standing, hit } = pro;
  // The line's own team, for every reader outside this one: the history the receiving team keeps
  // must say where its sender stood, not leave a shared seat name to the local roster.
  report.from_team = fileTeamId;
  const declaredCaller = caller.kind === 'seat' ? team.seats.find((seat) => seat.name === caller.name) : undefined;

  // The authority rule, `admitSend` over the registry's records, default deny, judging the
  // resolved target when there is one. A sender the store holds no record for is judged as the
  // seat the live file declares for it: this team's rules alone reach it — a target in another
  // team, and the grant store, both wait for the record `team up` writes. That declared judgement
  // asks placement first, whatever the spec resolved to — the owner, or a seat on the pane the
  // state records for it, in the session judged, the same verdict `answer` asks, with the two
  // repairable refusals it can name — so the seat is judged only where the state records it
  // standing. A sender the store does hold a record for is bound to that record only where the
  // call stands as it — the record's own seat, running, on the pane it records, in its session,
  // and on the pane the state records for that seat (`admissionOf`'s identity check) — never by
  // session and seat name alone. All of it runs before the message is read and before any seat
  // is probed.
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standing);
    if (placement) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'placement', seatName, host.now());
      return refuse(io, dir, who, placement, host, report);
    }
    // A bare nickname the registry cannot answer is still a declared seat's nickname: the word
    // its signed record sets, or the file's where it sets none, maps it, and the rules judge the
    // seat it names, never the human name the caller wrote.
    const named = declaredSeatNamed(host.home, root, team, seatName);
    if (named.error !== undefined) return configuration(io, `${seatName}: ${named.error}`, report);
    const configured = named.seat;
    const seat = configured === undefined ? seatName : configured.name;
    admission = admissionOf(caller, team, null, seat, host.home, fileTeamId, () => host.now(), standing, undefined, watchContext(host, root));
    if (!admission.ok) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'admission', seat, host.now());
      return refuse(io, dir, who, admission.why, host, report);
    }
    if (!configured) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'admission', seat, host.now());
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat, agentId: null, session: team.session, cli: configured.cli, address: null, sentAs: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home, fileTeamId, () => host.now(), standing, undefined, watchContext(host, root));
    if (!admission.ok) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'admission', seatName, host.now());
      return refuse(io, dir, who, admission.why, host, report);
    }
    // A resolved spec is addressed by its record: its session and its CLI, under the receiving
    // team's own folder; across teams this run's daemon is skipped, so the send is reached
    // directly. The pane is the live read's, by the seat's name (`findAgent`), never the
    // record's alone.
    const cross = hit.team.root !== root;
    to = {
      seat: hit.agent.reach.seat,
      agentId: hit.agent.id,
      session: hit.agent.reach.session,
      cli: hit.agent.cli,
      address: hit.agent.reach.address,
      // The form the caller wrote, kept beside the seat it resolved to: a `@<nickname>`, a seat
      // or nickname at a team, `lead@<team>`, or an agent id. A plain seat names itself and adds nothing.
      sentAs: seatName === hit.agent.reach.seat ? null : { spec: seatName, resolved: hit.agent.id },
      dir: cross ? join(hit.team.root, '.agents') : dir,
      project: hit.team.project,
      root: hit.team.root,
      cross,
    };
  }
  // Whether this sender can make the native leg itself: a seat whose registry record or team file
  // declares Claude Code carries the cross-session SendMessage the leg is made with. The owner's
  // terminal, and every other CLI, do not, and their native leg stays a skip.
  const senderCli = typeof admission.sender === 'object' && 'cli' in admission.sender ? admission.sender.cli : declaredCaller?.cli;
  const callerNative = senderCli === 'claude-code';
  report.seat = to.seat;
  // The team and session the send addresses, for the context line and the document: the
  // receiving team's own, read from the file that names it.
  report.project = to.project;
  report.session = to.session;
  // What every history line this run writes keeps of the address: the form as written and the
  // registry id it resolved to, when the caller wrote a form rather than the seat's own name.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  // A seat the receiving team file marks `stopped: true` is not addressed at all: no leg is
  // walked, nothing is typed and nothing is written down. The dry run reports the real run's
  // refusal, and the check stands above every other delivery refusal, since none of them can
  // make a stopped seat take a message.
  const receiving = to.cross ? loadTeamFile(to.root, { home: host.home }) : loaded;
  const declared = receiving.ok ? receiving.team.seats.find((seat) => seat.name === to.seat) : undefined;
  if (declared?.stopped === true) return stoppedSeat(io, dir, who, to.seat, host, report);
  // The registry's signing model is the running seat's authority. A pane whose live status
  // names another model is held before the body is read and before any delivery leg is walked;
  // the team file is only the roster projection and cannot override that signed record.
  const registeredTarget = readAgents(host.home).find((agent) =>
    agent.reach.team === teamIdOf(to.root) && agent.reach.seat === to.seat &&
    agent.reach.session === to.session && agent.lifecycle !== 'retired'
  );
  if (registeredTarget !== undefined) {
    const live = findAgent(host, to.session, to.seat);
    if (live.ok) {
      const screen = host.native.paneText?.(to.session, live.pane) ?? null;
      const running = screen === null ? null : runningModel(registeredTarget.cli, screen);
      if (modelDiffers(running, registeredTarget.signing)) {
        const declaredModel = `${registeredTarget.signing.model} ${registeredTarget.signing.version}`;
        const runningLabel = `${running.model} ${running.version}`;
        return held(io, dir, who, to.seat, `model drift: ${declaredModel} vs ${runningLabel}`, host, report);
      }
    }
  }
  // A `--brief` send reads the receiving team's `brief-transport` before it reads the draft or
  // writes anything durable. `message` and `file` both deliver the whole body as an ordinary
  // send — the walk is the same one — while `memory` is refused with nothing written on either
  // side: no drop, no frame, no inbox entry, no history line, and no fallback to `file`. The
  // draft is not read when the policy refuses it, and no state or log line records the refusal,
  // so the refusal itself leaves the tree as it found it. An ordinary send names no brief and
  // never reads this policy.
  if (brief !== undefined) {
    const transport = briefTransportOf({
      home: host.home,
      root: to.root,
      ...(receiving.ok && receiving.team.entity !== null ? { entity: receiving.team.entity } : {}),
      now: host.now(),
    });
    if (transport.transport === 'memory') {
      if (report.json) writeJsonError(io, 'send.brief-memory', `refused: ${MEMORY_TRANSPORT_UNSUPPORTED}`);
      else io.stderr(`team send: refused: ${MEMORY_TRANSPORT_UNSUPPORTED}\n`);
      return 1; // exit: send.brief-memory
    }
  }
  let body: string;
  const source = brief ?? file;
  if (source !== undefined) {
    try {
      body = bodyFrom(source, io);
    } catch {
      return configuration(io, `the message file cannot be read: ${source}`, report);
    }
  } else {
    body = words.join(' ');
  }
  if (body.trim() === '') return usage(io, 'the message is empty', report);
  // The sender's own subject, a display field beside the summary: it never stands in for the
  // body's first line, and a blank one is no subject at all.
  const subject = args.values.subject?.trim();
  // A body that is only a path to a brief is the one form the owner's rule forbids: the reader
  // has the message but not the file it points at. The warning is the whole guard — the send
  // still goes, because a path in a body is not proof of anything, and a false refusal would
  // cost a real message.
  const pointer = briefPointerIn(body, io.cwd, host.home);
  if (pointer !== null) {
    io.stderr(`team send: ${to.seat}: the body only points at a brief (${pointer}); send the brief itself, with --brief <file> or its text in the body\n`);
  }
  // A multiline body drawn like terminal output is sent byte for byte: the warning changes
  // nothing in it and never refuses the send. It names the forms that keep such a body exact:
  // a file, or a pipe read as standard input.
  const outputLines = outputMarkerLines(body);
  if (body.includes('\n') && outputLines >= 2) {
    io.stderr(`team send: ${to.seat}: the body looks like pasted output (${pluralCount(outputLines, 'line')} start with a check mark or a bracketed number); use --file <path> or --file - (standard input) when a body must arrive exactly as written\n`);
  }
  // The receiver sees the sender before the message: the drop file, the frame and the daemon's
  // own write all carry the same first lines. The headline is the reading team's word on how a
  // sender reads — inside its own team a nickname, across teams `seat@team` under the default —
  // and the id it drops from the line stays on the signed record's payload.
  const naming = namingFor({
    home: host.home,
    root: to.root,
    viewerTeam: teamIdOf(to.root),
    seat: to.seat,
    ...(receiving.ok ? { file: receiving.team } : {}),
    ...(host.projects ? { projectOfTeam: (id: string) => host.projects!.ofTeam(id) } : {}),
  });
  body = `${senderHeader(admission.sender, admission.rule, naming)}\n${body}`;
  // A seat whose profile carries its rules in every brief has no standing session to keep
  // them: `rules: prepend` puts the same text a launch would deliver in front of each brief,
  // on every leg — the drop file, the socket frame and a compose seat's typed box all carry
  // this one body. `rulesOf` is the launch's own builder, so the file's rules, the seat's
  // signature lines and the workspace lines are the ones its launch would have sent.
  if (declared !== undefined && receiving.ok && profileFor(declared.cli)?.rulesMode === 'prepend') {
    body = `${rulesOf(receiving.team, declared, to.root)}\n\n${body}`;
  }

  const dry = args.flags.has('dry-run');
  // The receiving seat's own chain — entity, project, team, seat — decides the order the send
  // walks; nothing declared leaves mcp-inbox, typed, drop. Each level's word is the signed
  // `delivery-order` policy its record holds, and the receiving team file's own keys, the
  // seat's and the registry project's legacy words fill in where no signed record is held; the
  // seat's signed settings say `delivery_order` and `human` in the file's place; a host that
  // hands in a chain decides instead, which is how a test picks an order without a file to
  // write. A record that exists and does not verify refuses the send: neither the order nor the
  // human guard can be decided from a record the store disowns, and routing on the declaration
  // would let a tampered `human` preference fall back to a typed pane.
  let overrides: SeatOverrides = {};
  if (!host.delivery) {
    const read = resolveSeatOverrides({ home: host.home, root: to.root, seat: to.seat });
    if (!read.ok) {
      return configuration(io, `the receiving seat's settings record cannot be read: ${read.why}`, report);
    }
    overrides = read.overrides;
  }
  const rawChain = host.delivery ?? deliveryChainOf({
    root: to.root,
    seat: to.seat,
    home: host.home,
    // Across teams the file loaded above is the caller's own: the receiving team's is loaded
    // from its root, and one that cannot be read declares nothing.
    ...(to.cross ? {} : { file: team }),
    projectOfTeam: (id) => (host.projects ? host.projects.ofTeam(id) : projectRegistry.ofTeam(host.home, id)),
    overrides,
    now: host.now(),
  });
  const order = deliveryOrder(rawChain as Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>);
  // A receiving seat whose launch declares `crossSessionInbound: "accept"` takes the frame
  // first: the socket is the fastest channel and the owner asked for it ahead of the rest of the
  // order. A receiver keeps the order its files declare — hold, refuse and unset in the launch
  // are never dialed, since a held frame would block the seat's box — and another CLI has no
  // cross-session socket at all.
  const inbound = declaredInboundOf({
    dir: to.dir,
    root: to.root,
    session: to.session,
    seat: to.seat,
    ...(declared?.launch !== undefined ? { launch: declared.launch } : {}),
  });
  // The one implied default that names the socket: a receiving Claude session whose launch
  // declares `crossSessionInbound: accept`, with no level of its chain declaring an order, walks
  // socket first. A seat this build launched (its generated settings file is on the line) is
  // authorized by that launch alone; an explicit team-file `inbound: hold` or `refuse` keeps the
  // socket out, and a session launched some other way still needs the team file's
  // `inbound: accept`. The launch word is always what the receiving CLI needs to take the frame.
  // A word the chain declares — team, seat, project — is walked as written: it may place `socket`
  // anywhere or leave it out, and this build never force-prepends it. A seat whose box held a
  // frame keeps the socket out until its declaration is re-confirmed.
  const socketWord = declared?.inbound;
  const heldStanding = socketHeldReason(readHeldSocket(heldSocketPath(to.dir, to.session, to.seat)), inbound);
  const socketNow = SOCKET_SEND && socketEligible(socketWord, inbound) && heldStanding === null;
  const declaredOrder = Object.values(rawChain).some((word) => word !== undefined && word.length > 0);
  // The second implied default: a receiving Codex seat with no declared order walks its own
  // runtime's queue first while its effective `codex-daemon` policy is `on` (the signed default).
  // The policy is read here, ahead of the leg's own fail-closed read, because a policy that is
  // off or cannot be verified must add no attempt at all: the walk then keeps the file default
  // and `native` stays reachable only where a chain names it. A declared order is walked as
  // written, so a chain that places another runtime's leg first is never preempted.
  const nativeFirst =
    !declaredOrder &&
    to.cli === 'codex' &&
    codexDaemonForSeat({
      home: host.home,
      root: to.root,
      ...(receiving.ok ? { team: receiving.team } : {}),
      seat: to.seat,
      session: to.session,
      now: host.now(),
    }) === 'on';
  // Codex must receive a typed wake before its inbox can take a message: an inbox write alone
  // does not wake its idle TUI. Keep the native runtime route first when its signed default is
  // active, then rank typed ahead of the inbox as its fallback. If that route is off, typed leads.
  // A declared order is still walked as written. The socket default keeps its held-box and
  // dual-declaration gate; only a receiver whose box is not holding a frame is walked socket first.
  const codexWakeOrder: readonly DeliveryLeg[] =
    nativeFirst
      ? ['native', 'typed', ...order.filter((leg) => leg !== 'typed')]
      : ['typed', ...order.filter((leg) => leg !== 'typed')];
  const ordered: readonly DeliveryLeg[] =
    !declaredOrder && to.cli === 'claude-code' && socketNow
      ? ['socket', ...order]
      : !declaredOrder && to.cli === 'codex'
        ? codexWakeOrder
        : order;
  // A human's pane never takes typing, whatever its order says — and the ruling goes further: its
  // walk is the drop leg alone, whatever the order or the default holds. Every other leg the
  // order names is kept out, and each one's human reason is recorded on the history line, so a
  // reader sees what the pane was spared. The drop file waits where a keystroke cannot be taken
  // back.
  const human = overrides.human ?? (declared?.human === true);
  const chosen: readonly DeliveryLeg[] = human ? ['drop'] : ordered;
  // A direct-only walk (the watch's idle dispatch) is a wake or nothing: only a route that
  // reaches a live receiver without a keystroke stays. The typed and native legs type, the drop
  // leg is a stored copy and the mcp-inbox leg is the seat's own storage — none of them is a
  // wake, so none is attempted. A functional headless route would stay if this build carried
  // one. Every remaining leg keeps its own rules, and the order's own words decide whether the
  // receiver offers it. A watch principal makes the walk direct by itself: the watch's own send
  // never falls back to a route that types or stores, whatever hook its caller built.
  const DIRECT_WAKE_LEGS: readonly DeliveryLeg[] = ['socket', 'headless-resume'];
  const directWalk = host.direct !== undefined || host.watch !== undefined;
  const walk: readonly DeliveryLeg[] = directWalk ? chosen.filter((leg) => DIRECT_WAKE_LEGS.includes(leg)) : chosen;
  // The ordered leg report the JSON documents carry. A real send lists the walk itself; the
  // states fill in as it runs and a leg it never reaches stays `not-reached`. A human's only
  // walked leg is the drop file, so the legs the ruling kept out are listed in the order they
  // were set aside, then the drop. A Claude receiver whose chain declares no order but whose
  // files do not let the socket be dialed has the implied socket default listed as skipped with
  // its reason: the omission the report used to leave unexplained. A run that resolved no walk
  // carries no list at all.
  const planLegs: readonly DeliveryLeg[] = human
    ? (order.includes('drop') ? order : [...order, 'drop'])
    : walk;
  const impliedSocketReason = !human && to.cli === 'claude-code' && !declaredOrder && !order.includes('socket')
    ? socketIneligibleReason(to.cli, socketWord, inbound, heldStanding)
    : null;
  report.delivery = [
    ...(impliedSocketReason === null ? [] : [{ leg: 'socket' as const, state: 'skipped' as const, reason: impliedSocketReason }]),
    ...planLegs.map((leg) => ({ leg, state: 'not-reached' as const })),
  ];

  // One signed record is written into the recipient's folder — the whole body, its thread, the
  // address it resolved to and the rule that admitted it — and the leg that takes the send
  // transports that record. A compose seat (a CLI that builds its work item from its own screens)
  // types the body through those screens instead of a trigger line. When `--wait` is given, the
  // send walks the same delivery order and then waits on the thread for the first verified reply
  // record within the timeout window.
  const msgId = host.sendId?.() ?? randomUUID();
  const dropDir = join(to.dir, 'send-drops', to.session, to.seat);
  const record = recordOf(msgId, to, body, from, admission, host.now().toISOString(), subject === '' ? undefined : subject);
  const callerRoot = { root, session: team.session };
  if (dry) {
    // A dry run reports the same ordered legs a real send would, but it can only say whether each
    // would be tried: the socket default the walk did not take is listed too, with the word that
    // kept it out, so an omitted socket always has its reason. Nothing is dialed, staged or
    // written.
    report.delivery = dryDeliveryPlan({
      walk,
      order,
      cli: to.cli,
      declaredOrder,
      human,
      socketReason: socketIneligibleReason(to.cli, socketWord, inbound, heldStanding),
      handoffEligible: callerNative && !wait,
    });
    return dryRun(io, to.seat, `${to.cli} via ${walkPhrase(walk, to.cli, callerNative && !wait, socketNow)}; nothing was written`, report);
  }
  // The display words every transport opens the message with: the receiving team's
  // `message-display` template, the sender's nickname (its seat name when the file writes none),
  // and the body's first content line as the summary. The signed record is the message; this
  // header is display only. The message id never enters it — the socket frame's `msg_id` carries it.
  const wakeTemplate = messageDisplayInForce({
    home: host.home,
    root: to.root,
    team: receiving.ok ? receiving.team : null,
    now: host.now(),
  });
  const wakeName = senderDisplayName(
    { seat: record.from, ...(record.from_id === null ? {} : { id: record.from_id }) },
    { ...naming, mode: 'nickname' },
  );
  const wakeHeader = renderMessageDisplay(wakeTemplate, {
    name: wakeName,
    seat: record.from,
    team: team.project,
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    summary: messageSummaryOf(record.body),
    age: '0s',
    id: '',
  });
  // A direct-only caller hands in the pane and CLI its own pass saw for this seat: the send is
  // bound to them, never re-aimed at a pane the caller did not read. A seat the session no longer
  // lists at that pane, or whose file now names another CLI, is refused here — before any route
  // is attempted, so the refusal stages nothing.
  const bound = host.direct?.expect;
  if (bound !== undefined) {
    if (to.cli !== bound.cli) {
      return refuse(io, dir, who, `${to.seat}: its CLI is ${to.cli}, not the ${bound.cli} the pass saw; nothing was sent`, host, report);
    }
    const here = findAgent(host, to.session, to.seat);
    if (!here.ok) {
      return refuse(io, dir, who, `${to.seat}: ${here.reason}; nothing was sent`, host, report);
    }
    if (here.pane !== bound.pane) {
      return refuse(io, dir, who, `${to.seat}: its pane is now ${here.pane}, not the ${bound.pane} the pass saw; nothing was sent`, host, report);
    }
  }
  // A watch send is the watch principal's own: it is a direct send or it is nothing, and it is
  // bound to the direct context the caller's pass read. Without that context it is refused here,
  // before anything is staged — a watch principal is never walked through a route that types or
  // stores, and never trusts a target the pass did not bind. With it, the exact target evidence
  // is required unconditionally: the seat's registry record must be running and name this seat,
  // session, pane and CLI, and the state must record the same pane for it. Anything less is
  // refused before a route is attempted, so a stale, renamed or unrecorded target stages nothing.
  if (host.watch !== undefined) {
    if (host.direct === undefined || bound === undefined) {
      return refuse(io, dir, who, `${to.seat}: the watch's send carries no direct context to bind it, so nothing was sent`, host, report);
    }
    const evidence = exactWatchTarget(host, to, bound, dir);
    if (evidence !== null) return refuse(io, dir, who, evidence, host, report);
  }
  // The per-transport recheck every direct route reads: a watch principal's actual verifier
  // always runs, and a guard the caller hands in may only narrow what it allows. It is composed
  // once here, before the walk, so no route can transport without it and no caller has to
  // remember to pass one.
  const directGuard = composedGuard(host);

  // The delivery walk, in the order the receiving seat's chain resolves to. A leg that takes
  // the send ends the walk; a leg that definitely cannot take it hands the send to the next
  // one and its reason joins `failures`, which every history line this walk writes carries.
  // The typed leg looks for a live agent before it types; one it cannot find is a leg that
  // definitely cannot take the send, so the walk moves on with the reason recorded. Once the
  // typed leg types, its own outcome is the send's. The drop leg
  // writes the typed leg's own file and stops there, with nothing typed. The mcp-inbox leg
  // takes the send only while the seat's own inbox server is listening, and is otherwise
  // recorded and passed. The native leg reaches a Codex seat through its own runtime queue, with
  // nothing typed into a pane; a sender whose own file declares Claude Code gets the handoff
  // instead (unless `--wait` is set, since a handoff returns immediately to the caller before the
  // frame is sent). A human's walk is the drop leg alone; the legs this rule kept out are
  // recorded first, so the history line the drop leg writes (or the refusal) names what the pane
  // was spared.
  const failures: string[] = [];
  // Fill in one planned leg's state. A leg is marked once: the first ending that reaches it is
  // the one the report keeps. A leg that is never marked stays `not-reached`.
  const markLeg = (leg: DeliveryLeg, state: LegState, reason?: string): void => {
    const entry = report.delivery?.find((one) => one.leg === leg && one.state === 'not-reached');
    if (entry === undefined) return;
    entry.state = state;
    if (reason !== undefined) entry.reason = reason;
  };
  if (human) {
    for (const leg of order) {
      const reason = humanSkipReason(leg);
      if (reason === null) continue;
      // The history line's failure list keeps its shipped four; the report names every leg the
      // ruling set aside, including a resume route the order may carry.
      if (leg === 'typed' || leg === 'native' || leg === 'socket' || leg === 'mcp-inbox') {
        failures.push(`${leg}: ${reason}`);
      }
      markLeg(leg, 'skipped', reason);
    }
  }
  // The signed record is staged once, before the first route this process attempts: every
  // attempt carries this same record and message id, and a route that fails leaves the durable
  // copy behind. The native handoff is not such an attempt — its record is minted under the
  // handoff's own id and staged by the handoff — so a walk that begins with it stages nothing
  // here. A write that refuses is not this run's refusal — each leg reports its own ending — it
  // only leaves the walk without an episode to record.
  let stagedTried = false;
  let stagedWalk: RecordWritten | null = null;
  // A leg records through this; until a record is staged it is a no-op, so a walk that never
  // began an episode records nothing, and a leg that began one records every attempt after it.
  let note: WalkNote = (_attempt) => { /* no episode yet */ };
  // Whether the walk's last route has already recorded its exhaustion, so the ending below
  // records one only when no leg's own ending did.
  let ended = false;
  // The direct-only hook fires once, when a route's ending closes the walk.
  let directEnded = false;
  const ensureEpisode = async (): Promise<void> => {
    if (stagedTried) return;
    stagedTried = true;
    stagedWalk = await writeSendRecord(dropDir, record, host.home, host.now);
    if (!stagedWalk.ok) return;
    const begun = beginFallbackWalk({
      caller,
      team,
      root,
      home: host.home,
      now: host.now,
      recipient: { team: to.project, seat: to.seat, toId: to.agentId, session: to.session, root: to.root },
      messageId: msgId,
      record: stagedWalk.record,
      ...(to.cross && receiving.ok ? { recipientTeam: receiving.team } : {}),
    });
    note = (attempt) => {
      if (!attempt.liveRoutesRemain) ended = true;
      const noted = begun.note(attempt);
      if (!noted.ok) logLine(dir, 'send', who, `${to.seat}: the fallback attempt was not recorded (${noted.reason})`, host.now());
      // A direct-only caller hears the walk's ending here: the attempt that took the send, or
      // the last route's failure. The record was staged before the first attempt, whatever it was.
      if (host.direct !== undefined && !directEnded && (attempt.outcome === 'delivered' || !attempt.liveRoutesRemain)) {
        directEnded = true;
        host.direct.ended({
          outcome: attempt.outcome,
          route: attempt.route,
          id: msgId,
          record: stagedWalk?.ok === true ? stagedWalk.path : null,
          ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
        });
      }
    };
  };
  // The staged copy is assigned inside `ensureEpisode`'s closure, so the walk reads it through
  // this call: the declared type, not the narrowing control flow takes at the declaration.
  const stagedRecordOf = (): RecordWritten | null => stagedWalk;
  // A direct-only send stages its record before its first attempt: no route the watch can take
  // asks anything of the receiver's pane, and the ending the caller reads names that record. An
  // order with no direct route left attempts nothing, so it stages nothing and reports no ending.
  if (host.direct !== undefined && walk.length > 0) await ensureEpisode();
  let socketNote: string | null = null;
  for (const [at, leg] of walk.entries()) {
    if (leg === 'mcp-inbox') {
      // The seat's own inbox, not a pane: the leg takes the send only when a listener beside
      // the message names this seat, session and root with a live pid — and, when this process
      // knows its own build, when that listener's marker names the same build. A listener left
      // running from an older install has that build's parsers in memory and cannot read a
      // record this build signs; the walk records the stale runtime and moves on.
      const live = inboxLive(dropDir, to.root, to.session, to.seat, host.build?.());
      if (!live.live) {
        failures.push(`mcp-inbox: ${live.reason}`);
        markLeg('mcp-inbox', 'skipped', live.reason);
        note(walkAttempt('mcp-inbox', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: live.reason }));
        continue;
      }
      markLeg('mcp-inbox', 'attempted');
      await ensureEpisode();
      return deliverInbox(io, to.dir, who, from, to.project, to.root, to.session, to.seat, dropDir, record, host, report, startedAt, failures, to.sentAs, wait, timeoutS, callerRoot, note);
    }
    if (leg === 'socket') {
      // The socket leg dials only a receiving Claude session whose launch declares
      // `crossSessionInbound: "accept"`. Another CLI has no cross-session socket, and a receiver
      // whose launch declares hold, refuse or nothing, one whose team file writes no word and
      // whose launch this build did not attest, and a session started before its launcher's
      // declaration took effect, are skipped before a connection is made: a frame their box would
      // hold is worse than a slower leg. A seat whose box held a frame keeps the socket out until
      // its declaration is re-confirmed. The signed record is written first, so the
      // receiver's folder holds the durable copy whatever the frame does; a write on the socket
      // is transport, never a read.
      if (to.cli !== 'claude-code') {
        failures.push(`socket: ${to.cli} sessions have no cross-session socket`);
        markLeg('socket', 'skipped', `${to.cli} sessions have no cross-session socket`);
        note(walkAttempt('socket', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: `${to.cli} sessions have no cross-session socket` }));
        continue;
      }
      if (!SOCKET_SEND) {
        failures.push('socket: this build does not carry the cross-session socket');
        markLeg('socket', 'skipped', 'this build does not carry the cross-session socket');
        note(walkAttempt('socket', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: 'this build does not carry the cross-session socket' }));
        continue;
      }
      if (!socketEligible(socketWord, inbound)) {
        const why = socketSkipReason(socketWord, inbound);
        failures.push(`socket: ${why}`);
        markLeg('socket', 'skipped', why);
        note(walkAttempt('socket', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: why }));
        continue;
      }
      // A frame the box held once is not dialed again until the declaration is re-confirmed: the
      // hold was the receiver's answer, and a retry on the same word would hold a second frame.
      if (heldStanding !== null) {
        failures.push(`socket: ${heldStanding}`);
        markLeg('socket', 'skipped', heldStanding);
        note(walkAttempt('socket', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: heldStanding }));
        continue;
      }
      // The dial is the route attempt: the signed record is staged before the frame reaches the
      // transport, so a connection that refuses or half-takes the frame still leaves a copy.
      await ensureEpisode();
      // A direct-only caller's authority is rechecked after preparation and immediately before
      // the dial: an epoch replaced while the record was staged ends the walk here, and no other
      // route is attempted in a walk the caller no longer stands behind. The composed guard is
      // the watch principal's own verifier first and any narrowing guard its caller handed in.
      const socketGuard = guardRefusal(directGuard);
      if (socketGuard !== null) {
        failures.push(`socket: refused: ${socketGuard.why}`);
        markLeg('socket', 'refused', socketGuard.why);
        note(walkAttempt('socket', 'refused', false, host.now(), startedAt, { reason: socketGuard.why }));
        break;
      }
      const attempt = await deliverSocketFrame(dir, who, from, to, record, failures, host, report, startedAt, wait, inbound, root, wakeHeader, human);
      if (attempt.kind === 'delivered') {
        markLeg('socket', 'attempted');
        note(walkAttempt('socket', 'delivered', false, host.now(), startedAt));
        if (wait) {
          return finishThreadWait(io, to.dir, to.root, who, from, to.project, to.session, to.seat, dropDir, record, 'socket', timeoutS, host, report, startedAt, failures, to.sentAs, undefined, callerRoot);
        }
        return delivered(io, to.seat, report, 'socket');
      }
      if (attempt.kind === 'held') {
        // The mark is written once, under the receiving team's state folder: the next send reads
        // it and keeps the socket out until the declaration this hold sat under is re-confirmed.
        // The history line and the line below already carry the outcome; the mark is the retry guard.
        markLeg('socket', 'attempted', attempt.reason);
        recordHeldSocket(heldSocketPath(to.dir, to.session, to.seat), inbound, host.now());
        const remaining = liveRoutesAfter(walk, at, to.cli);
        note(walkAttempt('socket', 'held', remaining, host.now(), startedAt, { reason: attempt.reason }));
        // A held frame is not a delivery, and a live route behind it may still take the send:
        // the frame stays in the receiver's folder as its durable copy and the walk moves on.
        if (remaining) {
          failures.push(`socket: ${attempt.reason}`);
          socketNote = `typed, socket ${attempt.reason}`;
          logLine(dir, 'send', who, `${to.seat}: the socket held the frame (${attempt.reason}); falling back to the next route`, host.now());
          continue;
        }
        return held(io, dir, who, to.seat, attempt.reason, host, report, 'socket');
      }
      failures.push(`socket: ${attempt.reason}`);
      markLeg('socket', 'attempted', attempt.reason);
      note(walkAttempt('socket', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: attempt.reason }));
      socketNote = `typed, socket ${attempt.reason}`;
      // The fallback's own line, only where the typed leg is still ahead to take the send.
      if (walk.slice(at + 1).includes('typed')) {
        logLine(dir, 'send', who, `${to.seat}: the socket was not taken (${attempt.reason}); falling back to the typed trigger`, host.now());
      }
      continue;
    }
    if (leg === 'native') {
      // A Codex seat's native route is its own runtime's queue: one pointer line, built from the
      // signed record's sender, handed to the app-server thread the seat's own record binds. The
      // route is the receiving seat's: its `codex-daemon` policy, its bound session and the
      // `native` budget its signed chain sets decide whether the attempt stands. Nothing is typed
      // into a pane, and a queue acceptance is transport only — the signed read receipt the seat's
      // own `inbox_read` writes is still the one proof of a read.
      if (to.cli === 'codex') {
        // The route's clock starts here, before this process prepares anything for it: the
        // policy read, the staged copy and the bounded readiness probe all spend the signed
        // attempt budget rather than getting a fresh one.
        const routeStartedAt = host.now().getTime();
        // The signed copy is on disk before the attempt, under the same message id every other
        // route carries; a copy that cannot be written leaves the route with nothing to hand to
        // the runtime, so it is passed over.
        await ensureEpisode();
        // The control-flow view of `stagedWalk` is the value before the closure ran, so the
        // staged copy is read through its declared type here.
        const staged = stagedRecordOf();
        if (staged === null || !staged.ok) {
          const why = staged === null ? 'the record could not be written' : staged.reason;
          failures.push(`native: ${why}`);
          markLeg('native', 'skipped', why);
          note(walkAttempt('native', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: why }));
          continue;
        }
        // The receiving seat's signed chain sets the attempt budget. A chain that does not read
        // refuses the route rather than falling back to a release default no level chose.
        const policyTeam = receiving.ok ? receiving.team : null;
        const deliveryTimeout = policyTeam === null
          ? { ok: false as const, why: 'the receiving team file could not be read; the native attempt budget is undecided' }
          : deliveryTimeoutInForce({
              home: host.home,
              entity: policyTeam.entity ?? '',
              projectId: projectIdOfTeam(host.home, policyTeam, to.root) ?? '',
              root: to.root,
              team: policyTeam,
              seat: to.seat,
              now: host.now(),
            });
        const attempt = await deliverCodexNativeRoute(
          {
            route: 'native',
            runtime: 'codex',
            copy: { dir: dropDir, name: msgId },
            root: to.root,
            home: host.home,
            session: to.session,
            seat: to.seat,
            sender: { seat: from, team: teamIdOf(root) },
          },
          { id: msgId, record: staged.record },
          {
            now: host.now,
            startedAt,
            routeStartedAt,
            deliveryTimeout,
            liveRoutesRemain: liveRoutesAfter(walk, at, to.cli),
            skipStage: true,
            // Readiness is always read live: a queue that would hold the pointer is a route that
            // did not take the send, never a hopeful enqueue.
            liveProbe: true,
          },
        );
        note(attempt.walkAttempt);
        markLeg('native', 'attempted', attempt.outcome === 'enqueue' ? undefined : attempt.reason);
        if (attempt.outcome === 'enqueue') {
          report.sent = msgId;
          const failed = failures.length > 0 ? { failed: [...failures] } : {};
          const entry = { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, thread: record.thread };
          if (wait) {
            return finishThreadWait(io, to.dir, to.root, who, from, to.project, to.session, to.seat, dropDir, record, 'native', timeoutS, host, report, startedAt, failures, to.sentAs, undefined, callerRoot);
          }
          // The queue took the pointer; a read is only what the seat's own signed receipt says.
          // The receipt check is the same central one every leg uses, bounded by the same grace.
          const grace = host.inboxGraceMs ?? INBOX_GRACE_MS;
          if (await awaitReceipt(dropDir, msgId, { to: to.seat, root: to.root, session: to.session }, host.home, grace, claimBindingIn(to.root, to.session, to.seat, msgId))) {
            clearPending(dropDir, msgId);
            logLine(dir, 'send', who, `${to.seat}: delivered (read) (drop ${String(body.length)} characters, native queue receipt)`, host.now());
            appendHistory(to.project, to.root, host.home, { ...entry, ...historySender(report), outcome: 'delivered (read)', ms: host.now().getTime() - startedAt, via: 'native', ...failed });
            return delivered(io, to.seat, report, 'read', 'native');
          }
          const ms = host.now().getTime() - startedAt;
          logLine(dir, 'send', who, `${to.seat}: queued to its native runtime (drop ${String(body.length)} characters); no receipt within ${String(grace)} ms`, host.now());
          appendHistory(to.project, to.root, host.home, { ...entry, ...historySender(report), outcome: 'sent (unconfirmed)', ms, via: 'native', ...failed });
          return sentUnconfirmed(io, to.seat, report, ms, 'native');
        }
        // A held thread, an unreachable or refused queue, or an unreadable policy: the route did
        // not take the send, and the walk moves to the leg behind it.
        failures.push(`native: ${attempt.reason}`);
        continue;
      }
      // Any other CLI has no native route this build can walk: the leg is skipped without a
      // failure, since no send of this seat's could ever leave by it.
      if (to.cli !== 'claude-code') {
        markLeg('native', 'skipped', `${to.cli} sessions have no native route this build can walk`);
        continue;
      }
      // The native leg is the sender's own call, never this build's frame: a sender whose own
      // file declares Claude Code makes the handoff — the pending record, the exact target and
      // body, and the sender's own SendMessage — and the sender records it with `--confirm`. Any
      // other sender gets the skip. A handoff that cannot name a live address hands the send to
      // the leg after this one. A `--wait` run needs the message delivered in this call before
      // it waits on the thread, so it skips the handoff and continues the walk.
      if (callerNative && !wait) {
        const fallback = fallbackAfterNative(walk, at);
        const off = await handOff(team.project, root, from, to, record, admission, fallback, dropDir, host);
        if (off.kind === 'refused') {
          await ensureEpisode();
          markLeg('native', 'refused', off.why);
          note(walkAttempt('native', 'refused', false, host.now(), startedAt, { reason: off.why }));
          return refuse(io, dir, who, off.why, host, report);
        }
        // A handoff is the sender's own pending call, not a transport this walk made: nothing is
        // noted, so the episode never counts a delivery the sender has yet to make (or fail).
        if (off.kind === 'handed') {
          markLeg('native', 'attempted');
          return handed(io, to.dir, who, to.seat, off.record, host, report);
        }
        failures.push(`native: ${off.reason}`);
        markLeg('native', 'attempted', off.reason);
        await ensureEpisode();
        note(walkAttempt('native', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: off.reason }));
        continue;
      }
      failures.push(`native: ${NATIVE_LEG_UNAVAILABLE}`);
      markLeg('native', 'skipped', NATIVE_LEG_UNAVAILABLE);
      await ensureEpisode();
      note(walkAttempt('native', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: NATIVE_LEG_UNAVAILABLE }));
      continue;
    }
    if (leg === 'headless-resume') {
      // The seat's own CLI resumed headlessly for one turn: no TUI pane, so no keystroke.
      // Supported for Gemini (`gemini`) and Cursor (`cursor-agent`) seats with a bound
      // `recordedSeatSession`; any other CLI has no headless runtime in this build, so the
      // declared leg is recorded as unavailable and the walk moves on.
      //
      // A direct-only caller's authority is rechecked before this leg's own route as well, even
      // when the receiver's CLI carries no resume runtime: a refusal here ends the walk rather than
      // recording an unavailable leg, and the functional resume sits behind the same recheck, never
      // after it. A refusal never reaches the walk's next route. The composed guard is the watch
      // principal's own verifier first and any narrowing guard its caller handed in.
      const resumeGuard = guardRefusal(directGuard);
      if (resumeGuard !== null) {
        failures.push(`headless-resume: refused: ${resumeGuard.why}`);
        markLeg('headless-resume', 'refused', resumeGuard.why);
        note(walkAttempt('headless-resume', 'refused', false, host.now(), startedAt, { reason: resumeGuard.why }));
        break;
      }
      if (!isHeadlessResumeCli(to.cli)) {
        failures.push(`headless-resume: ${HEADLESS_RESUME_UNAVAILABLE_REASON}`);
        markLeg('headless-resume', 'skipped', HEADLESS_RESUME_UNAVAILABLE_REASON);
        note(walkAttempt('headless-resume', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: HEADLESS_RESUME_UNAVAILABLE_REASON }));
        continue;
      }
      const routeStartedAt = host.now().getTime();
      await ensureEpisode();
      const staged = stagedRecordOf();
      if (staged === null || !staged.ok) {
        const why = staged === null ? 'the record could not be written' : staged.reason;
        failures.push(`headless-resume: ${why}`);
        markLeg('headless-resume', 'skipped', why);
        note(walkAttempt('headless-resume', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: why }));
        continue;
      }
      const policyTeam = receiving.ok ? receiving.team : null;
      const deliveryTimeout = policyTeam === null
        ? { ok: false as const, why: 'the receiving team file could not be read; the headless-resume attempt budget is undecided' }
        : deliveryTimeoutInForce({
            home: host.home,
            entity: policyTeam.entity ?? '',
            projectId: projectIdOfTeam(host.home, policyTeam, to.root) ?? '',
            root: to.root,
            team: policyTeam,
            seat: to.seat,
            now: host.now(),
          });
      const seatCwd = declared?.cwd === undefined ? to.root : resolve(to.root, declared.cwd);
      const attempt = await deliverHeadlessResumeRoute(
        {
          route: 'headless-resume',
          cli: to.cli,
          copy: { dir: dropDir, name: msgId },
          root: to.root,
          home: host.home,
          session: to.session,
          seat: to.seat,
          sender: { seat: from, team: teamIdOf(root) },
          cwd: seatCwd,
        },
        { id: msgId, record: staged.record },
        {
          now: host.now,
          startedAt,
          routeStartedAt,
          deliveryTimeout,
          liveRoutesRemain: liveRoutesAfter(walk, at, to.cli),
          skipStage: true,
          ...(host.headlessResumeSpawn === undefined ? {} : { spawn: host.headlessResumeSpawn }),
        },
      );
      markLeg('headless-resume', 'attempted', attempt.outcome === 'enqueue' ? undefined : attempt.reason);
      note(attempt.walkAttempt);
      if (attempt.outcome === 'enqueue') {
        report.sent = msgId;
        const failed = failures.length > 0 ? { failed: [...failures] } : {};
        const entry = { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, thread: record.thread };
        if (wait) {
          return finishThreadWait(io, to.dir, to.root, who, from, to.project, to.session, to.seat, dropDir, record, 'headless-resume', timeoutS, host, report, startedAt, failures, to.sentAs, undefined, callerRoot);
        }
        const grace = host.inboxGraceMs ?? INBOX_GRACE_MS;
        if (await awaitReceipt(dropDir, msgId, { to: to.seat, root: to.root, session: to.session }, host.home, grace, claimBindingIn(to.root, to.session, to.seat, msgId))) {
          clearPending(dropDir, msgId);
          logLine(dir, 'send', who, `${to.seat}: delivered (read) (drop ${String(body.length)} characters, headless-resume receipt)`, host.now());
          appendHistory(to.project, to.root, host.home, { ...entry, ...historySender(report), outcome: 'delivered (read)', ms: host.now().getTime() - startedAt, via: 'headless-resume', ...failed });
          return delivered(io, to.seat, report, 'read', 'headless-resume');
        }
        const ms = host.now().getTime() - startedAt;
        logLine(dir, 'send', who, `${to.seat}: resumed headlessly (drop ${String(body.length)} characters); no receipt within ${String(grace)} ms`, host.now());
        appendHistory(to.project, to.root, host.home, { ...entry, ...historySender(report), outcome: 'sent (unconfirmed)', ms, via: 'headless-resume', ...failed });
        return sentUnconfirmed(io, to.seat, report, ms, 'headless-resume');
      }
      failures.push(`headless-resume: ${attempt.reason}`);
      continue;
    }
    // The drop leg: the same 0600 drop file the typed leg writes, and no keystroke at all — no
    // trigger line, no socket frame, no daemon round trip. It is the channel for a seat whose
    // receiver watches its own drop folder, and for a pane that must never be typed into: a
    // file can wait where a keystroke cannot be taken back.
    if (leg === 'drop') {
      markLeg('drop', 'attempted');
      await ensureEpisode();
      return deliverDropped(io, to.dir, to.root, who, from, to.project, to.session, to.seat, dropDir, record, host, report, startedAt, failures, to.sentAs, human, wait, timeoutS, callerRoot, note);
    }
    // The typed leg. The trigger is built here, so an order that reaches this leg is refused a
    // trigger past the measured line before anything is written. The line is the seat's own
    // receipt-writing drop read, so the command that wakes it is the one that proves it read: the
    // signed `<id>.read.json` lands before the body is printed. A compose seat's typed leg is
    // its CLI's own screens instead: there is no drop-file trigger to build, and the walk is
    // run in this process (below), not handed to the daemon. A refusal decided here — a trigger
    // past the line, a name the session does not list — happens before any route attempt, so the
    // walk stages nothing for it: a refusal leaves no record in the receiver's folder.
    const compose = profileFor(to.cli)?.compose ?? null;
    // The receiving team's `message-display` policy decides the words the wake opens with; a team
    // file that did not read leaves the shipped template, never an unnamed wake.
    const trigger = readTriggerLine(to.seat, to.session, {
      seat: record.from,
      team: team.project,
      template: wakeTemplate,
      name: wakeName,
      body: record.body,
      ageMs: 0,
      ...(record.subject === undefined ? {} : { subject: record.subject }),
    });
    if (trigger === null && compose === null) {
      const why = `${to.seat}: the trigger would exceed ${String(MESSAGE_LINE_MAX)} characters; nothing was sent`;
      markLeg('typed', 'refused', `the trigger would exceed ${String(MESSAGE_LINE_MAX)} characters; nothing was sent`);
      note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: `the trigger would exceed ${String(MESSAGE_LINE_MAX)} characters; nothing was sent` }));
      return refuse(io, dir, who, why, host, report);
    }
    // The daemon serves seats of the caller's own team; a seat in another team's record is
    // reached directly, under that team's folder. A compose seat is reached directly too: the
    // screen walk and the seat lock belong to one process. A `--wait` run is reached directly so
    // the signed record is written into the checkout's transport tree and the thread wait watches
    // that tree.
    const daemonSock = host.daemonSocket ?? daemonSocketPath(to.project, to.root, host.home);
    // A daemon dial is a route attempt: the record is staged before it, so a daemon that took the
    // request and died before answering still leaves the walk a durable copy. No socket file at
    // the path means no daemon to dial, so a send every leg will refuse stages nothing.
    if (!to.cross && compose === null && !wait && existsSync(daemonSock)) await ensureEpisode();
    const viaDaemon = to.cross || compose !== null || wait
      ? null
      : await requestDaemon(daemonSock, { v: 1, op: 'send', id: msgId, from, to: to.seat, ...sentAs, body, ...(record.from_id === null ? {} : { from_id: record.from_id }), ...(record.subject === undefined ? {} : { subject: record.subject }), name: wakeName, template: wakeTemplate, ...(failures.length > 0 ? { failed: [...failures] } : {}), ...(at + 1 < walk.length ? { fallthrough: true as const } : {}) });
    if (viaDaemon && !('pong' in viaDaemon) && !('shutdown' in viaDaemon)) {
      // A daemon that found no live agent typed nothing: when a leg still stands behind the
      // typed one, the failure joins the walk and the send goes on to it. The daemon wrote no
      // history line for this ending — the leg that takes the send writes the one line.
      if (viaDaemon.outcome === 'unreachable' && viaDaemon.fall_through === true) {
        failures.push(`typed: ${viaDaemon.detail}`);
        markLeg('typed', 'attempted', viaDaemon.detail);
        note(walkAttempt('typed', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: viaDaemon.detail }));
        continue;
      }
      noteDaemonOutcome(note, viaDaemon, host.now(), startedAt);
      markLeg('typed', 'attempted');
      return finishDaemonSend(io, dir, who, to.seat, timeoutS, host, report, viaDaemon, startedAt, socketNote ?? undefined);
    }
    // The pane is read live, by the seat's name: a record's recorded pane may have been closed or
    // reused since it was written, and a trigger typed into a pane another seat now holds would
    // reach that seat. A name the session does not list is never typed into; when no leg stands
    // behind the typed leg that is the walk's ending, and when one does the send goes on to it.
    const found: Found = findAgent(host, to.session, to.seat);
    if (!found.ok) {
      if (found.kind === 'refused') {
        markLeg('typed', 'refused', found.reason);
        note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: found.reason }));
        return refuse(io, dir, who, found.reason, host, report);
      }
      if (at + 1 < walk.length) {
        failures.push(`typed: ${found.reason}`);
        markLeg('typed', 'skipped', found.reason);
        note(walkAttempt('typed', 'unreachable', liveRoutesAfter(walk, at, to.cli), host.now(), startedAt, { reason: found.reason }));
        continue;
      }
      const entry = { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, ...historySender(report), body, id: msgId, thread: record.thread, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) };
      appendHistory(to.project, to.root, host.home, entry);
      markLeg('typed', 'skipped', found.reason);
      note(walkAttempt('typed', 'unreachable', false, host.now(), startedAt, { reason: found.reason }));
      return unreachable(io, dir, who, to.seat, found.reason, host, report);
    }
    if (isBareShellPane(to.dir, to.session, to.seat, host.processInfo(to.session, found.pane))) {
      const entry = { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, ...historySender(report), body, id: msgId, thread: record.thread, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) };
      appendHistory(to.project, to.root, host.home, entry);
      markLeg('typed', 'skipped', 'the seat is back at its shell; nothing was typed');
      note(walkAttempt('typed', 'unreachable', false, host.now(), startedAt, { reason: 'the seat is back at its shell; nothing was typed' }));
      return unreachable(io, dir, who, to.seat, 'the seat is back at its shell; nothing was typed', host, report);
    }
    report.sent = msgId;
    if (compose !== null) {
      // The seat's own folder: the record's `cwd` under the receiving team's root, else the
      // folder this send already writes to.
      const seatCwd = declared === undefined ? to.dir : resolve(to.root, declared.cwd);
      await ensureEpisode();
      markLeg('typed', 'attempted');
      return deliverComposeSeat(io, to.dir, to.root, who, from, to.project, to.session, to.seat, to.cli, found.pane, dropDir, record, seatCwd, host, report, startedAt, failures, to.sentAs, wait, timeoutS, callerRoot, note);
    }
    if (trigger === null) {
      const why = `${to.seat}: the trigger would exceed ${String(MESSAGE_LINE_MAX)} characters; nothing was sent`;
      markLeg('typed', 'refused', `the trigger would exceed ${String(MESSAGE_LINE_MAX)} characters; nothing was sent`);
      note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: `the trigger would exceed ${String(MESSAGE_LINE_MAX)} characters; nothing was sent` }));
      return refuse(io, dir, who, why, host, report);
    }
    // The typed trigger is the attempt: the signed record is on disk before the keys go out, so a
    // trigger whose outcome is ambiguous still leaves the seat a record it can read.
    await ensureEpisode();
    markLeg('typed', 'attempted');
    return deliverNative(io, to.dir, to.root, who, from, to.project, to.session, to.seat, to.cli, found.pane, dropDir, record, trigger, host, report, startedAt, socketNote ?? undefined, failures, to.sentAs, wait, timeoutS, callerRoot, note);
  }

  // No leg took the send: the walk ran out of legs — the signed record is already staged, and
  // every leg that fell is named. When no leg's own ending recorded the exhaustion (a leg that
  // was passed over without an attempt), the episode hears the order itself as the last route.
  const why = `no leg of its delivery order took the send${failures.length === 0 ? '' : ` (${failures.join('; ')})`}`;
  if (!ended && walk.length > 0) {
    note(walkAttempt(walk[walk.length - 1] as string, 'unreachable', false, host.now(), startedAt, { reason: why }));
  }
  appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, ...historySender(report), body, id: msgId, thread: record.thread, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) });
  return unreachable(io, dir, who, to.seat, why, host, report);
}

/** Why this run would not dial the socket leg, or null when it would. The checks are the walk's
 *  own, in its order, so a dry run never promises a socket the walk would refuse. */
function socketIneligibleReason(
  cli: string,
  teamWord: CrossSessionInbound | undefined,
  declaration: InboundDeclaration,
  heldStanding: string | null,
): string | null {
  if (cli !== 'claude-code') return `${cli} sessions have no cross-session socket`;
  if (!SOCKET_SEND) return 'this build does not carry the cross-session socket';
  if (!socketEligible(teamWord, declaration)) return socketSkipReason(teamWord, declaration);
  if (heldStanding !== null) return heldStanding;
  return null;
}

/** Why the native leg cannot be walked for this receiver and sender, or null when it can. A
 *  Codex receiver has its own runtime queue; every other receiver has only the sending Claude
 *  Code session's own SendMessage, which a run without that sender cannot make. */
function nativeIneligibleReason(cli: string, handoffEligible: boolean): string | null {
  if (cli === 'codex') return null;
  if (cli === 'claude-code') return handoffEligible ? null : NATIVE_LEG_UNAVAILABLE;
  return `${cli} sessions have no native route this build can walk`;
}

/** The human ruling's reason for one leg, or null for the drop file. These are the same words
 *  the history line records, without the leg prefix the report entry already carries. */
function humanSkipReason(leg: DeliveryLeg): string | null {
  if (leg === 'typed') return "the pane is a human's, and nothing is typed into it";
  if (leg === 'native' || leg === 'socket') return "the pane is a human's, and no frame is sent";
  if (leg === 'mcp-inbox') return "the pane is a human's, and the drop leg is the only one walked";
  if (leg === 'headless-resume') return "the pane is a human's, and the drop leg is the only one walked";
  return null;
}

/** The dry run's ordered leg list: the same walk a real send would make, with each leg's
 *  eligibility and the word that keeps it out. A Claude receiver with no declared order also
 *  lists the implied socket candidate the walk did not take, so a socket omission always has
 *  its reason. Nothing here reads a pane, dials a socket or writes a file. */
function dryDeliveryPlan(input: {
  walk: readonly DeliveryLeg[];
  order: readonly DeliveryLeg[];
  cli: string;
  declaredOrder: boolean;
  human: boolean;
  socketReason: string | null;
  handoffEligible: boolean;
}): LegReport[] {
  const candidate = (leg: DeliveryLeg): LegReport => {
    const reason = input.human
      ? humanSkipReason(leg)
      : leg === 'socket'
        ? input.socketReason
        : leg === 'native'
          ? nativeIneligibleReason(input.cli, input.handoffEligible)
          : leg === 'headless-resume'
            ? 'this build carries no headless resume runtime'
            : null;
    return reason === null
      ? { leg, state: 'candidate', eligible: true }
      : { leg, state: 'skipped', eligible: false, reason };
  };
  const entries: LegReport[] = [];
  // The implied socket default: a Claude receiver whose chain declares no order walks socket
  // first when it may be dialed. When it may not, the walk leaves it out entirely, and this is
  // the entry that says why — the omission the report used to leave unexplained.
  if (
    !input.human
    && input.cli === 'claude-code'
    && !input.declaredOrder
    && !input.order.includes('socket')
    && input.socketReason !== null
  ) {
    entries.push(candidate('socket'));
  }
  const legs: readonly DeliveryLeg[] = input.human
    ? (input.order.includes('drop') ? input.order : [...input.order, 'drop'])
    : input.walk;
  for (const leg of legs) entries.push(candidate(leg));
  return entries;
}

/** The channel a dry run names: the legs of the order this build can actually walk, in words.
 *  A leg this build does not carry — native for a sender that cannot make its own SendMessage
 *  (src/send/uds.ts's SOCKET_SEND is off) or a seat whose CLI has no cross-session socket — is
 *  not a channel a run would take, and neither is named. The handoff counts as the native leg
 *  only for a sender whose own file declares Claude Code, since only that sender makes the call
 *  the leg is. The mcp-inbox leg is a channel: it writes the seat's inbox drop and waits for its
 *  receipt, and the legs behind it are named as the fallbacks. The where-nothing-is-carried
 *  phrase is unreachable by the default order of any seat — its legs are mcp-inbox, typed,
 *  drop, and each is either named or passed over for a reason — and only an order that holds
 *  none of them prints it. */
function walkPhrase(order: readonly DeliveryLeg[], cli: string, handoffEligible: boolean, socketDialable: boolean): string {
  // The socket leg is walkable only where this run would dial it: a Claude receiver that itself
  // declares accept. The native leg is a Codex receiver's own runtime queue, and for any other
  // receiver only the sender's own handoff — a sender whose own file declares Claude Code.
  const socketWalkable = SOCKET_SEND && socketDialable;
  const nativeWalkable = cli === 'codex' || (cli === 'claude-code' && handoffEligible);
  const resumeWalkable = isHeadlessResumeCli(cli);
  const typed = profileFor(cli)?.compose != null
    ? 'a typed brief through its own screens'
    : 'a 0600 drop file and one trigger line';
  const words = (leg: DeliveryLeg): string => {
    if (leg === 'socket') return 'its cross-session socket';
    if (leg === 'native') {
      return cli === 'codex' ? 'its native runtime queue' : 'the native handoff (your own SendMessage, then --confirm)';
    }
    if (leg === 'headless-resume') return 'its headless session resume';
    if (leg === 'mcp-inbox') return "the seat's own MCP inbox";
    if (leg === 'drop') return 'a 0600 drop file, with nothing typed into the pane';
    return typed;
  };
  const walkable = order.filter(
    (leg) =>
      leg === 'drop'
      || leg === 'mcp-inbox'
      || leg === 'typed'
      || (leg === 'socket' && socketWalkable)
      || (leg === 'native' && nativeWalkable)
      || (leg === 'headless-resume' && resumeWalkable),
  );
  const [first] = walkable;
  if (first === undefined) return 'no leg of its delivery order this build can walk';
  // The drop leg is a file and no keystroke: it always takes the send, so nothing stands behind it.
  if (first === 'drop') return 'a 0600 drop file with nothing typed into the pane';
  // Every leg of the order is named: the typed leg hands the send to a leg behind it when it
  // finds no live agent, so nothing after it is dropped from the walk's description.
  if (walkable.length === 1) return words(first);
  return `${words(first)}, falling back to ${walkable.slice(1).map(words).join(', then ')}`;
}

/** What a direct-only run reports: the command's own exit code and the walk's ending. A run
 *  that refused before any direct route was attempted carries no result. */
export type DirectSendRun = { code: number; result: DirectSendResult | null };

/**
 * Sends `body` to `seat` over wake routes only, through the same command an ordinary send runs:
 * the same admission, the same delivery order, the same route rules. Only a route that reaches a
 * live receiver without a keystroke is walked, so nothing is typed and no stored copy counts as a
 * delivery, and the send is bound to the pane and CLI the caller's pass saw. The watch's idle
 * dispatch calls this.
 */
export async function sendDirect(
  io: Io,
  host: SendHost,
  input: {
    seat: string;
    pane: string;
    cli: string;
    body: string;
    guard?: () => { ok: true } | { ok: false; why: string };
    watch?: WatchSendPrincipal;
  },
): Promise<DirectSendRun> {
  const captured: { result: DirectSendResult | null } = { result: null };
  const code = await runSend([input.seat, input.body], io, {
    ...host,
    direct: {
      expect: { pane: input.pane, cli: input.cli },
      ...(input.guard === undefined ? {} : { guard: input.guard }),
      ended: (ending) => { captured.result = ending; },
    },
    ...(input.watch === undefined ? {} : { watch: input.watch }),
  });
  return { code, result: captured.result };
}

/** Records one route attempt for the send's fallback episode; null when no episode could be
 *  staged. The recorder's own refusal is logged by the caller and never changes the walk. */
type WalkNote = (attempt: WalkAttempt) => void;

/** The attempt shape the walk records, measured from the run's own clock. */
function walkAttempt(
  route: string,
  outcome: AttemptOutcome,
  liveRoutesRemain: boolean,
  at: Date,
  startedAt: number,
  extra: { reason?: string; receipt?: RelayReceipt } = {},
): WalkAttempt {
  return {
    route,
    outcome,
    liveRoutesRemain,
    at,
    ms: at.getTime() - startedAt,
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    ...(extra.receipt === undefined ? {} : { receipt: extra.receipt }),
  };
}

/** Whether a leg after this one can still take the send: a walk's remaining routes, less the one
 *  this build carries no runtime for. A route is live when it stands; the drop leg's file always
 *  stands in front of a copy. */
function liveRoutesAfter(walk: readonly DeliveryLeg[], at: number, cli?: string): boolean {
  return walk
    .slice(at + 1)
    .some((leg) => leg !== 'headless-resume' || (cli !== undefined && isHeadlessResumeCli(cli)));
}

/** What a native handoff leaves behind, or why the send goes to the leg behind native. */
type HandOff =
  | { kind: 'handed'; record: PendingNative }
  | { kind: 'fallback'; reason: string }
  | { kind: 'refused'; why: string };

/**
 * The native leg for a sender whose own file declares Claude Code: the recipient's live pane and
 * socket are resolved exactly as a socket send's are, and one pending record is written to the
 * caller's own project state — the receiving team's project, root and rule ride the record, so
 * the confirm writes the history line where the send would have. Nothing is delivered here. A
 * record that cannot be written refuses: an unrecorded native send is never the easy path. An
 * address that cannot be resolved is the ordinary fallback to the leg behind native.
 */
/** Stamps the handoff's short nonce onto the attribution header line (`from … — admitted by: … [<nonce>]`). */
function stampHandoffNonce(body: string, nonce: string): string {
  const newline = body.indexOf('\n');
  if (newline < 0) return `${body} [${nonce}]`;
  return `${body.slice(0, newline)} [${nonce}]${body.slice(newline)}`;
}

/** The legs of the recipient's `delivery_order` that stand after `native`: when a handoff is
 *  not confirmed within the 10m window, `team watch` walks these legs in order. The socket leg is
 *  not one of them: a frame is written by the send that walks it, and a handoff's pending record
 *  names only the legs the watcher itself can take. */
function fallbackAfterNative(
  walk: readonly DeliveryLeg[],
  at: number,
): readonly PendingNativeFallbackLeg[] {
  return walk
    .slice(at + 1)
    .filter((leg): leg is PendingNativeFallbackLeg => leg === 'mcp-inbox' || leg === 'typed' || leg === 'drop');
}

/** The registry id the sender's record carries, when it has one: the owner and the watch are
 *  named by their reserved words alone, and a declared sender the store holds no record for
 *  carries none. */
export function senderIdOf(admission: Admission): string | null {
  if (!admission.ok || admission.sender === 'owner' || admission.sender === 'watch') return null;
  return 'id' in admission.sender ? admission.sender.id : null;
}

/** The record a send transports, built once the message's body is final: the id is the record's
 *  name, the thread is the first message's id (its own, on a first message), and the rule that
 *  admitted the pair is written on it. */
function recordOf(msgId: string, to: Aim, body: string, from: string, admission: Admission, at: string, subject?: string): RecordPayload {
  return {
    kind: 'message',
    id: msgId,
    to: to.seat,
    to_id: to.agentId,
    root: to.root,
    session: to.session,
    at,
    body,
    from,
    from_id: senderIdOf(admission),
    rule: admission.ok ? admission.rule : 'unrecorded',
    thread: msgId,
    ...(subject === undefined ? {} : { subject }),
  };
}

/** The record a leg wrote, with its signed text: the socket leg carries those bytes in its frame
 *  attempt's message. */
type RecordWritten = { ok: true; path: string; existing?: true; record: string } | { ok: false; reason: string };

/**
 * Writes the signed record under the leg's own lock, before the leg's transport action. Every
 * ending that says "nothing was sent" happens above this call, and every leg that takes the send
 * has the record on disk first. The write is the relay package's (`stage`), with the record's
 * bytes as this build signs them. A name already held by a regular file is left untouched by the
 * relay and judged here by `ensureRecord`, so a duplicate id is this message's record exactly as
 * before: a walk that falls from the socket to the typed leg writes one record, not two.
 */
async function writeSendRecord(dropDir: string, payload: RecordPayload, home: string, now: () => Date): Promise<RecordWritten> {
  let signed: SignedRecord;
  try {
    signed = signRecord(payload, home);
  } catch {
    return { ok: false, reason: 'the record could not be signed' };
  }
  const record = `${JSON.stringify(signed, null, 2)}\n`;
  const staged = await relayStage({ dir: dropDir, name: payload.id }, { id: payload.id, record }, { now });
  if (staged.outcome === 'refused') return { ok: false, reason: staged.reason };
  if (staged.receipt.existing) {
    // Admission still decides whether the file at the name is this message's record: `ensureRecord`
    // reads it and, while the name is held, writes nothing.
    const held = ensureRecord(dropDir, signed);
    if (!held.ok) return { ok: false, reason: held.reason };
    return { ok: true, path: held.path, existing: true, record };
  }
  return { ok: true, path: staged.receipt.copy ?? join(dropDir, payload.id), record };
}

async function handOff(
  storeProject: string,
  storeRoot: string,
  from: string,
  to: Aim,
  payload: RecordPayload,
  admission: Admission,
  fallback: readonly PendingNativeFallbackLeg[],
  dropDir: string,
  host: SendHost,
): Promise<HandOff> {
  if (!admission.ok) return { kind: 'refused', why: 'the send was not admitted' };
  const body = payload.body;
  const found = findAgent(host, to.session, to.seat);
  if (!found.ok) return { kind: 'fallback', reason: found.reason };
  const at = socketPathFor(host, to, found.pane);
  if (at === null) {
    return { kind: 'fallback', reason: `no socket was found for its pane's processes (looked in ${socketDirs(host)})` };
  }
  const id = host.newId?.() ?? randomUUID();
  if (!PENDING_ID.test(id)) {
    return { kind: 'refused', why: 'the handoff id is not a UUID; no pending record was written and nothing was sent' };
  }
  const nonce = nativeNonceOf(id);
  // The native leg's own body carries the handoff's nonce on its header line; the record is
  // that same message, so the receiver reads in `team messages` what the transport carried.
  const stamped = stampHandoffNonce(body, nonce);
  // The handoff mints its own id. A first message is its own thread, so the thread follows the
  // id the record is written under; a reply's thread is the first message's, unrelated to this id.
  const thread = payload.thread === payload.id ? id : payload.thread;
  const pending: PendingNative = {
    v: 1,
    id,
    nonce,
    ts: host.now().toISOString(),
    from,
    from_id: senderIdOf(admission),
    to: to.seat,
    to_id: to.agentId,
    team: teamIdOf(to.root),
    session: to.session,
    cli: to.cli,
    pane: found.pane,
    address: `uds:${at.path}`,
    rule: admission.rule,
    project: to.project,
    root: to.root,
    thread,
    ...(to.sentAs !== null ? { spec: to.sentAs.spec, resolved: to.sentAs.resolved } : {}),
    ...(payload.subject === undefined ? {} : { subject: payload.subject }),
    fallback: [...fallback],
    body: stamped,
  };
  // The signed record the native leg transports, under the handoff's own id: the receiver can
  // read the message before the sender's own SendMessage carries the line, and a handoff that
  // expires leaves the message where `team messages` reads it.
  const signed = await writeSendRecord(
    dropDir,
    { ...payload, id, body: stamped, thread, at: host.now().toISOString() },
    host.home,
    host.now,
  );
  if (!signed.ok) {
    return { kind: 'refused', why: `the record could not be written (${signed.reason}); nothing was sent` };
  }
  const written = writePending(storeProject, storeRoot, host.home, pending);
  if (!written.ok) {
    return { kind: 'refused', why: `the native handoff could not be written down (${written.reason}); nothing was sent` };
  }
  return { kind: 'handed', record: pending };
}

/** The handoff's own exit: the next call is the sender's, and the confirm line is the receipt.
 *  Nothing was delivered by this run; exit 0, always. */
function handed(io: Io, dir: string, who: string, seat: string, record: PendingNative, host: SendHost, report: Report): number {
  report.sent = record.id;
  const line = `team send --confirm ${record.id}`;
  const summary = `${seat}: native: nothing was sent; make the call with your own SendMessage, then record it`;
  logLine(dir, 'send', who, `${seat}: native handoff ${record.id} (${record.address})`, host.now());
  if (report.json) {
    writeAction(io, report, {
      status: 'native',
      summary,
      channel: 'native',
      to: record.address,
      confirm: line,
      message: record.body,
    });
  } else {
    const body = record.body.endsWith('\n') ? record.body : `${record.body}\n`;
    openText(io, report);
    io.stdout(
      `${summary}\n` +
        `to: ${record.address}\n` +
        `message:\n${body}` +
        `${line}\n`,
    );
  }
  return 0; // exit: send.native
}

/**
 * `team send --record <seat> --channel native --ms <N>`: the sender delivered with its own tool
 * — a Claude Code seat's cross-session message — and this writes the one history line every
 * other outcome gets, with the span the sender measured. Nothing is delivered here: no drop
 * file, no frame, no pane, and no socket is ever opened. The seat is named by the option, so
 * the positionals are the body, not the seat.
 *
 * Everything the record claims is judged first, and judged exactly as a plain send's target is:
 * the caller and its placement, the recipient's registry record, admission over the same
 * records with the grant store last (the prologue below is `runSend`'s own, step for step). A
 * native delivery must not become a way around the rules — only around the transport.
 */
function recordRun(args: Args, io: Io, host: SendHost, json: boolean): number {
  const seatName = args.values.record as string;
  const report: Report = { json, seat: seatName, sent: null, project: null, session: null };
  const channel = args.values.channel;
  const msRaw = args.values.ms;
  const file = args.values.file;
  if (args.flags.has('wait') || args.values.timeout !== undefined) {
    return usage(io, '--wait and --timeout are not meaningful with --record: nothing is delivered here', report);
  }
  if (channel === undefined) return usage(io, `--record needs --channel ${NATIVE_CHANNEL}`, report);
  if (channel !== NATIVE_CHANNEL) {
    return usage(io, `--channel takes ${NATIVE_CHANNEL} (got "${channel}"): the other channels send themselves`, report);
  }
  if (msRaw === undefined) {
    return usage(io, '--record needs --ms <N>: the span the sender measured, in whole milliseconds', report);
  }
  const ms = /^\d+$/.test(msRaw) ? Number(msRaw) : -1;
  if (ms < 0 || !Number.isSafeInteger(ms)) {
    return usage(io, `--ms takes a whole number of milliseconds (got "${msRaw}")`, report);
  }
  if (file !== undefined && args.rest.length > 0) {
    return usage(io, 'a message and --file cannot both be given', report);
  }
  let body: string;
  if (file !== undefined) {
    try {
      body = readFileSync(resolve(io.cwd, file), 'utf8');
    } catch {
      return configuration(io, `the message file cannot be read: ${file}`, report);
    }
  } else if (args.rest.length > 0) {
    body = args.rest.join(' ');
  } else {
    // The sender's text travelled in its own tool's call; the record says so rather than
    // inventing one.
    body = NATIVE_BODY_MARKER;
  }
  if (body.trim() === '') return usage(io, 'the message is empty', report);

  const pro = prologue(io, host, seatName);
  if ('ended' in pro) {
    if (pro.ended === 'configuration') return configuration(io, pro.message, report);
    return refuse(io, pro.dir, pro.who, pro.reason, host, report);
  }
  const { team, root, dir, fileTeamId, loaded, caller, who, from, standing, hit } = pro;
  // The same identity a delivered send writes: a recorded delivery is history in the receiving
  // team's store too, and a reader there must not take a shared seat name for its own.
  report.from_team = fileTeamId;
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standing);
    if (placement) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'placement', seatName, host.now());
      return refuse(io, dir, who, placement, host, report);
    }
    // A bare nickname the registry cannot answer is still a declared seat's nickname: the word
    // its signed record sets, or the file's where it sets none, maps it, and the rules judge the
    // seat it names, never the human name the caller wrote.
    const named = declaredSeatNamed(host.home, root, team, seatName);
    if (named.error !== undefined) return configuration(io, `${seatName}: ${named.error}`, report);
    const configured = named.seat;
    const seat = configured === undefined ? seatName : configured.name;
    admission = admissionOf(caller, team, null, seat, host.home, fileTeamId, () => host.now(), standing, undefined, watchContext(host, root));
    if (!admission.ok) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'admission', seat, host.now());
      return refuse(io, dir, who, admission.why, host, report);
    }
    if (!configured) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'admission', seat, host.now());
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat, agentId: null, session: team.session, cli: configured.cli, address: null, sentAs: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home, fileTeamId, () => host.now(), standing, undefined, watchContext(host, root));
    if (!admission.ok) {
      raiseSecurityRefusal(team, root, host.home, dir, caller, 'admission', seatName, host.now());
      return refuse(io, dir, who, admission.why, host, report);
    }
    // A resolved spec is addressed by its record: its session and its CLI, under the receiving
    // team's own folder. Nothing is delivered here, so no pane is read.
    const cross = hit.team.root !== root;
    to = {
      seat: hit.agent.reach.seat,
      agentId: hit.agent.id,
      session: hit.agent.reach.session,
      cli: hit.agent.cli,
      address: hit.agent.reach.address,
      // The form the caller wrote, kept beside the seat it resolved to: a `@<nickname>`, a seat
      // or nickname at a team, `lead@<team>`, or an agent id. A plain seat names itself and adds nothing.
      sentAs: seatName === hit.agent.reach.seat ? null : { spec: seatName, resolved: hit.agent.id },
      dir: cross ? join(hit.team.root, '.agents') : dir,
      project: hit.team.project,
      root: hit.team.root,
      cross,
    };
  }
  report.seat = to.seat;
  report.project = to.project;
  report.session = to.session;
  // What every history line this run writes keeps of the address: the form as written and the
  // registry id it resolved to, when the caller wrote a form rather than the seat's own name.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  // A stopped seat takes no record either: the same file read and the same refusal as a real
  // send, before a dry run or a history line exists. `--record` reaches here before the
  // delivery path's own check.
  const receiving = to.cross ? loadTeamFile(to.root, { home: host.home }) : loaded;
  const declared = receiving.ok ? receiving.team.seats.find((seat) => seat.name === to.seat) : undefined;
  if (declared?.stopped === true) return stoppedSeat(io, dir, who, to.seat, host, report);
  const msgId = randomUUID();
  if (args.flags.has('dry-run')) return recordDryRun(io, to.seat, ms, report);
  const written = appendHistory(to.project, to.root, host.home, {
    ts: host.now().toISOString(),
    from,
    to: to.seat,
    ...sentAs,
    ...historySender(report),
    body,
    id: msgId,
    outcome: 'delivered',
    ms,
    via: NATIVE_CHANNEL,
  });
  if (!written.ok) return refuse(io, dir, who, `the delivery could not be recorded: ${written.reason}`, host, report);
  logLine(to.dir, 'send', who, `${to.seat}: recorded (native, ${String(ms)} ms)`, host.now());
  return recorded(io, to.seat, ms, msgId, report);
}

/** The native delivery is in the history: one line, `via: native`, the sender's own span. Exit
 *  0, always. */
function recorded(io: Io, seat: string, ms: number, id: string, report: Report): number {
  report.sent = id;
  const summary = `${seat}: recorded (native, ${String(ms)} ms)`;
  if (report.json) {
    writeAction(io, report, { status: 'recorded', summary, channel: 'native' });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.recorded
}

/** What --record would write, with nothing written and nothing read: the run's own wording.
 *  Exit 0, always. */
function recordDryRun(io: Io, seat: string, ms: number, report: Report): number {
  const summary = `${seat}: would record (native, ${String(ms)} ms); nothing was written`;
  const plan: PlanStep[] = [{ step: 'record', seat, detail: `native delivery, ${String(ms)} ms; nothing was written`, prefix: '+' }];
  if (report.json) {
    writeAction(io, report, { status: 'dry-run', summary, dryRun: true, channel: null, plan });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.record-dry-run
}

/**
 * `team send --confirm <id>`: the half the handoff printed. The pending record is read from the
 * caller's own project state, and the caller must be the sender it names, standing where the
 * handoff judged it. The pair, the body and the address are the record's own: a confirm cannot
 * substitute a recipient or a message a later rule would not have admitted. The record is taken
 * atomically before the one history line is written — outcome delivered, via native, the span
 * from the handoff to this call — so two confirms of one id never both record it; a history
 * write that fails puts the record back.
 */
function confirmRun(args: Args, io: Io, host: SendHost, json: boolean): number {
  const id = args.values.confirm as string;
  const report: Report = { json, seat: null, sent: null, project: null, session: null };
  if (args.flags.has('wait') || args.values.timeout !== undefined) {
    return usage(io, '--wait and --timeout are not meaningful with --confirm: nothing is delivered here', report);
  }
  if (args.values.record !== undefined || args.values.channel !== undefined || args.values.ms !== undefined || args.values.file !== undefined) {
    return usage(io, '--confirm takes no other option: the pending record carries the seat, the body and the span', report);
  }
  if (args.rest.length > 0) return usage(io, '--confirm takes the id the handoff printed and no message', report);
  if (!PENDING_ID.test(id)) return usage(io, `--confirm takes the id a native handoff printed (got "${id}")`, report);

  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logTag(caller);
  const from = senderLabelOf(caller);
  const read = readPending(team.project, root, host.home, id, host.now());
  if (!read.ok) return refuse(io, dir, who, `${id}: the pending record cannot be read (${read.reason}); nothing was recorded`, host, report);
  if (read.record === null) return refuse(io, dir, who, `${id}: no pending native record holds that id; nothing was recorded`, host, report);
  const record = read.record;
  report.seat = record.to;
  report.project = record.project;
  report.session = record.session;
  const senderHere = caller.kind === 'owner' ? record.from === 'owner' : caller.kind === 'seat' && caller.name === record.from;
  if (!senderHere) {
    return refuse(io, dir, who, `${id}: it was printed for ${record.from}, and this call is ${from}; nothing was recorded`, host, report);
  }
  // The sender stands where the handoff judged it — the owner always does; a seat is the seat it
  // names, in the session judged, on the pane the state records for it, and when the handoff
  // bound a registry agent record (`from_id`), the caller must still stand as that same agent.
  const standing = standingOf(dir, judged.session, caller);
  if (caller.kind === 'seat') {
    const callerRecord = recordFor(host.home, team.session, caller.name);
    if (record.from_id !== null) {
      if (callerRecord === null || callerRecord.id !== record.from_id) {
        const current = callerRecord === null ? 'no running agent record' : `agent ${callerRecord.id}`;
        return refuse(
          io,
          dir,
          who,
          `${id}: it was printed for agent ${record.from_id} (seat ${record.from}), and this call has ${current}; nothing was recorded`,
          host,
          report,
        );
      }
    }
    if (callerRecord !== null) {
      const identity = recordIdentityProblem(caller, callerRecord, standing);
      if (identity !== null) return refuse(io, dir, who, identity, host, report);
    }
  }
  const placement = placementProblemOf(caller, standing);
  if (placement !== null) return refuse(io, dir, who, placement, host, report);
  // The span the handoff measured, from the record's own clock to this run's: the host's clock,
  // so a test or the docs runner reads a fixed count.
  const ms = Math.max(0, host.now().getTime() - Date.parse(record.ts));
  if (args.flags.has('dry-run')) return recordDryRun(io, record.to, ms, report);
  // `delivered` is earned only when the recipient's transcript shows this handoff's nonce,
  // verified through the same stripped-row check the typed leg uses for a drop id. Without it,
  // the confirm records `sent (unconfirmed)`, never `delivered`.
  const found = findAgent(host, record.session, record.to);
  const pane = found.ok ? found.pane : record.pane;
  const screen = host.native.paneText?.(record.session, pane) ?? null;
  const verified =
    screen !== null &&
    showsTranscriptToken(screen, record.nonce, `team send --confirm ${record.id}`);
  const outcome: 'delivered' | 'sent (unconfirmed)' = verified ? 'delivered' : 'sent (unconfirmed)';
  // Take before writing: only the confirm that renamed the record writes the line.
  const taken = takePending(team.project, root, host.home, id);
  if (!taken.ok) return refuse(io, dir, who, `${id}: ${taken.reason}`, host, report);
  const sentAs = record.spec !== undefined && record.resolved !== undefined
    ? { spec: record.spec, resolved: record.resolved }
    : {};
  const written = appendHistory(record.project, record.root, host.home, {
    ts: host.now().toISOString(),
    from: record.from,
    to: record.to,
    ...sentAs,
    // The confirm runs in the sender's checkout, so `root` is the team the sender stands in —
    // the receiving team's own root is the record's. The line needs the sender's.
    from_team: teamIdOf(root),
    body: record.body,
    id: record.id,
    // A handoff written before the thread spine carries none; its own id opens the thread.
    thread: record.thread ?? record.id,
    outcome,
    ms,
    via: NATIVE_CHANNEL,
  });
  if (!written.ok) {
    restoreTaken(taken.taken, team.project, root, host.home, id);
    return refuse(io, dir, who, `the delivery could not be recorded: ${written.reason}`, host, report);
  }
  dropTaken(taken.taken);
  logLine(join(record.root, '.agents'), 'send', who, `${record.to}: ${outcome} (native, ${String(ms)} ms)`, host.now());
  return confirmed(io, record.to, ms, record.id, outcome, report);
}

/** The confirm wrote the one history line the handoff promised: `delivered` when the recipient's
 *  transcript showed the handoff's nonce, `sent (unconfirmed)` otherwise. Exit 0, always. */
function confirmed(
  io: Io,
  seat: string,
  ms: number,
  id: string,
  outcome: 'delivered' | 'sent (unconfirmed)',
  report: Report,
): number {
  report.sent = id;
  const summary = `${seat}: ${outcome} (native, ${String(ms)} ms)`;
  if (report.json) {
    writeAction(io, report, { status: outcome, summary, channel: 'native' });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.confirmed
}

/** The typed leg's daemon answer, as the fallback episode records the typed route. A trigger
 *  the daemon saw the seat take is a delivery of the transport — the read receipt is a later,
 *  separate signal. */
function noteDaemonOutcome(note: WalkNote | null, res: DaemonSendResponse, at: Date, startedAt: number): void {
  if (note === null) return;
  if (res.outcome === 'delivered' || res.outcome === 'answered') {
    note(walkAttempt('typed', 'delivered', false, at, startedAt));
    return;
  }
  // The daemon took the send into the seat's FIFO queue and will deliver it when the seat is
  // free: the typed route has carried it, and no leg behind it is tried. The delivery's own
  // receipt is the daemon's history line when it lands.
  if (res.outcome === 'queued') {
    note(walkAttempt('typed', 'delivered', false, at, startedAt));
    return;
  }
  const outcome: AttemptOutcome =
    res.outcome === 'held' || res.outcome === 'timeout' || res.outcome === 'unreachable' || res.outcome === 'refused'
      ? res.outcome
      : 'refused';
  note(walkAttempt('typed', outcome, false, at, startedAt, { reason: res.detail }));
}

function finishDaemonSend(
  io: Io,
  dir: string,
  who: string,
  seatName: string,
  timeoutS: number,
  host: SendHost,
  report: Report,
  res: DaemonSendResponse,
  startedAt: number,
  /** How the send reached the seat, for the outcome line (the fallback's own reason). */
  note?: string,
): number {
  report.sent = res.id;
  if (res.outcome === 'delivered') {
    // The daemon's own word for a trigger the seat took. It is a trigger sent, not a message
    // read: no signed receipt has come back, so the sender's line says `sent (unconfirmed)`.
    // The daemon's typed leg moved any unsent text too: its receipt belongs on the same line.
    const notes = [TRIGGER_TAKEN_NOTE, note, res.draft].filter((one): one is string => one !== undefined);
    const ms = host.now().getTime() - startedAt;
    return sentUnconfirmed(io, seatName, report, ms, 'typed', notes.length === 0 ? undefined : notes.join('; '));
  }
  if (res.outcome === 'answered') return answered(io, seatName, { reply: res.reply, msg_id: res.reply_id }, report);
  if (res.outcome === 'queued') {
    // The receiver was busy when the send reached the daemon: the signed copy is stored and the
    // message holds one place in that seat's FIFO, so the sender is answered now instead of
    // waiting for the turn. The delivery receipt is the daemon's history line when the seat
    // frees; the send id is the same one on both.
    setLegState(report, 'typed', 'queued');
    return queuedBusy(io, dir, who, seatName, 'typed', res.id, null, host, report, startedAt);
  }
  if (res.outcome === 'timeout') return timedOut(io, seatName, timeoutS, report);
  if (res.outcome === 'held') return held(io, dir, who, seatName, res.detail, host, report);
  if (res.outcome === 'unreachable') return unreachable(io, dir, who, seatName, res.detail, host, report);
  if (res.outcome === 'not-submitted') {
    const result: DeliverResult = { outcome: 'not-submitted', tries: res.tries, ...(res.box === null ? {} : { box: res.box }) };
    // The daemon keeps no pending record in the folder a watch scans, so this line promises no
    // retry: it names the drop and stops there.
    const where = `the drop file is at ${res.drop_path}${res.draft === undefined ? '' : `; ${res.draft}`}`;
    return notSubmitted(io, dir, who, seatName, result, where, host, report);
  }
  return refuse(io, dir, who, res.detail, host, report);
}

/**
 * The daemon queue's own word, answered by a direct leg: the seat's lock is another command's,
 * so this run types nothing and the signed record it stored is delivered when the seat is free —
 * by the watch's typed retry, the seat's own inbox client, or its drop watcher, which is the leg
 * the record's marker names. An acceptance, never a delivery: no receipt is claimed, and the id
 * on the line is the one the delivery keeps. Exit 0, always — the same word and exit the
 * daemon's queue answers with.
 */
function queuedBusy(
  io: Io,
  dir: string,
  who: string,
  seatName: string,
  leg: 'typed' | 'mcp-inbox' | 'drop',
  msgId: string,
  /** The pid holding the seat's lock, when this process met it; null for the daemon's own
   *  queue, which keeps the message itself and writes its own log line. */
  held: number | null,
  host: SendHost,
  report: Report,
  startedAt: number,
): number {
  report.sent = msgId;
  if (held !== null) {
    const why = `another command holds the seat (pid ${String(held)})`;
    logLine(dir, 'send', who, `${seatName}: queued (receiver busy) (${leg}; ${why}; id ${msgId})`, host.now());
  }
  const ms = host.now().getTime() - startedAt;
  const summary = `${seatName}: queued (receiver busy) (${leg}, ${String(ms)} ms; id ${msgId})`;
  if (report.json) {
    writeAction(io, report, { status: 'queued (receiver busy)', summary, channel: leg });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.queued
}

type ThreadReply = { reply: string; msg_id: string };

const THREAD_RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function isThreadSidecarName(name: string): boolean {
  return name.endsWith('.pending') || name.endsWith('.taken') || name.endsWith('.read') || name.endsWith('.json') || name.startsWith('work-');
}

function sameCheckout(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

function peelSenderHeader(body: string): string {
  const split = body.indexOf('\n\n');
  if (split > 0 && body.startsWith('from ') && body.slice(0, split).includes(' — admitted by: ')) {
    return body.slice(split + 2);
  }
  return body;
}

/**
 * Looks across the session's transport tree (`<root>/.agents/send-drops/<session>/<seat>/<id>`)
 * for the first verified message record on `sentPayload.thread` other than `sentPayload.id`.
 */
function findThreadReply(
  roots: readonly { root: string; session: string }[],
  sentPayload: RecordPayload,
  home: string,
): ThreadReply | null {
  const keyState = messageKeyState(home);
  if (keyState.kind !== 'key') return null;
  const hits: { at: number; id: string; body: string }[] = [];
  for (const { root, session } of roots) {
    const sessionDir = join(root, '.agents', 'send-drops', session);
    let seats: string[];
    try {
      seats = readdirSync(sessionDir).sort();
    } catch {
      continue;
    }
    for (const seat of seats) {
      if (!THREAD_RECORD_NAME.test(seat)) continue;
      const seatDir = join(sessionDir, seat);
      let names: string[];
      try {
        names = readdirSync(seatDir).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        if (!THREAD_RECORD_NAME.test(name) || isThreadSidecarName(name)) continue;
        const looked = readRecord(join(seatDir, name));
        if (!looked.ok || looked.record === null) continue;
        const payload = looked.record.payload;
        if (payload.thread !== sentPayload.thread || payload.id === sentPayload.id) continue;
        if (payload.session !== session || !sameCheckout(payload.root, root)) continue;
        if (!verifyRecord(looked.record, keyState.key)) continue;
        const at = Date.parse(payload.at);
        hits.push({ at: Number.isFinite(at) ? at : 0, id: payload.id, body: peelSenderHeader(payload.body) });
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));
  const first = hits[0] as { at: number; id: string; body: string };
  return { reply: first.body, msg_id: first.id };
}

/**
 * Waits up to `timeoutMs` for a verified reply record on `sentPayload.thread`, looking once,
 * then every `pollMs`. A timeout of zero is the one look and no wait at all.
 */
async function awaitThreadReply(
  roots: readonly { root: string; session: string }[],
  sentPayload: RecordPayload,
  home: string,
  timeoutMs: number,
  pollMs = INBOX_POLL_MS,
): Promise<ThreadReply | null> {
  const immediate = findThreadReply(roots, sentPayload, home);
  if (immediate !== null) return immediate;
  const deadline = Date.now() + timeoutMs;
  for (let left = deadline - Date.now(); left > 0; left = deadline - Date.now()) {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(pollMs, left));
    });
    const found = findThreadReply(roots, sentPayload, home);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Completes a `--wait` send after the receiving seat's delivery leg has written the signed record:
 * waits on the thread for the first verified reply record within `timeoutS` (or `host.waitMs`),
 * records `answered` when a reply arrives, or `timeout` when the window closes with no reply
 * while leaving the thread open for a late reply.
 */
async function finishThreadWait(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  project: string,
  session: string,
  seatName: string,
  dropDir: string,
  payload: RecordPayload,
  via: 'socket' | 'typed' | 'drop' | 'mcp-inbox' | 'native' | 'headless-resume',
  timeoutS: number,
  host: SendHost,
  report: Report,
  startedAt: number,
  failures: readonly string[] = [],
  sentAs: SentAs | null = null,
  note?: string,
  extraRoot?: { root: string; session: string },
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const roots = extraRoot !== undefined && (!sameCheckout(extraRoot.root, root) || extraRoot.session !== session)
    ? [{ root, session }, extraRoot]
    : [{ root, session }];
  const waitMs = host.waitMs ?? timeoutS * 1000;
  const found = await awaitThreadReply(roots, payload, host.home, waitMs);
  if ((via === 'mcp-inbox' || via === 'drop') && (found !== null || receiptHeld(dropDir, payload.id, { to: seatName, root, session }, host.home, claimBindingIn(root, session, seatName, payload.id)))) {
    clearPending(dropDir, payload.id);
  }
  const entry = {
    ts: host.now().toISOString(),
    from,
    to: seatName,
    ...(sentAs === null ? {} : sentAs),
    ...historySender(report),
    body: payload.body,
    id: payload.id,
    thread: payload.thread,
  };
  if (found !== null) {
    try {
      const receipt = signReceiptPayload(
        { kind: 'receipt', status: 'replied', id: payload.id, to: seatName, root, session, at: host.now().toISOString() },
        host.home,
      );
      writeReceipt(dropDir, receipt, host.home);
    } catch {
      // A reply record on the thread is the answer even if the receipt sidecar cannot be written.
    }
    logLine(dir, 'send', who, `${seatName}: answered (reply ${String(found.reply.length)} characters)`, host.now());
    appendHistory(project, root, host.home, {
      ...entry,
      outcome: 'answered',
      ...(note !== undefined ? { note } : {}),
      ms: host.now().getTime() - startedAt,
      via,
      ...failed,
    });
    return answered(io, seatName, found, report, via, payload.thread);
  }
  logLine(dir, 'send', who, `${seatName}: timeout (sent, no reply on the thread within ${String(timeoutS)}s; the thread stays open)`, host.now());
  appendHistory(project, root, host.home, {
    ...entry,
    outcome: 'timeout',
    ...(note !== undefined ? { note } : {}),
    ms: host.now().getTime() - startedAt,
    via,
    ...failed,
  });
  return timedOut(io, seatName, timeoutS, report);
}

type Found = { ok: true; pane: string } | { ok: false; kind: 'unreachable' | 'refused'; reason: string };

/** The one live agent of this name, or why the send cannot use a pane. */
function findAgent(host: SendHost, session: string, seatName: string): Found {
  const agents = host.agents(session);
  if (agents === null) return { ok: false, kind: 'unreachable', reason: `the session "${session}" could not be read` };
  const named = agents.filter((agent) => agent.name === seatName);
  if (named.length === 0) return { ok: false, kind: 'unreachable', reason: 'no live agent carries that name in the session' };
  if (named.length > 1) return { ok: false, kind: 'refused', reason: `${seatName}: herdr lists more than one agent of this name; nothing was sent` };
  return { ok: true, pane: (named[0] as { pane: string }).pane };
}

/**
 * The drop leg: the body is written to the seat's 0600 drop file under the seat lock, and the
 * pane is not touched — no trigger line, no socket frame, no daemon round trip, so no agent has
 * to be live and no screen is read. The receiver finds the file by watching its own drop folder
 * and leaves a receipt beside it when it reads it, so the one thing this leg can say at once is
 * that the file is in place: `sent (unconfirmed)`, exit 0, with `via: drop` on the history line.
 * The marker is what the watch watches for the receipt; a human's drop is read by a person, who
 * writes none, so no marker is left there.
 */
async function deliverDropped(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  project: string,
  session: string,
  seatName: string,
  dropDir: string,
  payload: RecordPayload,
  host: SendHost,
  report: Report,
  startedAt: number,
  /** The reasons the legs before this one did not take the send: every history line carries them. */
  failures: readonly string[] = [],
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: SentAs | null = null,
  /** The receiving pane is a human's: a person reads the drop and writes no receipt, so no
   *  marker is left for a receipt that is never owed. */
  human = false,
  wait = false,
  timeoutS = 60,
  extraRoot?: { root: string; session: string },
  note: WalkNote = (_attempt) => { /* no episode */ },
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const msgId = payload.id;
  const body = payload.body;
  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) {
    // Another command holds the seat, and a held seat is a queue, not a refusal. The drop is a
    // file, not a keystroke: the record and the marker are written without that lock — the id
    // names the file, the seal is idempotent and the relay publishes each name once — and the
    // seat's watcher reads it when the seat is free. An acceptance, never a delivery.
    setLegState(report, 'drop', 'queued');
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      setLegState(report, 'drop', 'refused', 'the record could not be written');
      note(walkAttempt('drop', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was sent`, host, report);
    }
    const queuedWrite = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!queuedWrite.ok) {
      setLegState(report, 'drop', 'refused', `the record could not be written (${queuedWrite.reason})`);
      note(walkAttempt('drop', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${queuedWrite.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${queuedWrite.reason}); nothing was sent`, host, report);
    }
    const queuedAttempt = await relayDeliver(
      { route: 'durable-copy', copy: { dir: dropDir, name: msgId } },
      { id: msgId, record: queuedWrite.record },
      { now: host.now },
    );
    if (queuedAttempt.outcome === 'refused') {
      setLegState(report, 'drop', 'refused', queuedAttempt.reason);
      note(walkAttempt('drop', 'refused', false, host.now(), startedAt, { reason: queuedAttempt.reason }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${queuedAttempt.reason}); nothing was sent`, host, report);
    }
    note(walkAttempt('drop', 'held', false, host.now(), startedAt, { reason: 'the record is stored; no seat was woken' }));
    if (!human) {
      // The marker is the watcher's receipt record, as on every drop send: it is never typed,
      // and its receipt promotes the send once the seat reads the file.
      markPending(dropDir, {
        ts: host.now().toISOString(),
        from,
        to: seatName,
        ...(sentAs === null ? {} : sentAs),
        body,
        id: msgId,
        leg: 'drop',
      });
    }
    appendHistory(project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      ...(sentAs === null ? {} : sentAs),
      ...historySender(report),
      body,
      id: msgId,
      thread: payload.thread,
      outcome: 'queued (receiver busy)',
      ms: host.now().getTime() - startedAt,
      ...failed,
    });
    return queuedBusy(io, dir, who, seatName, 'drop', msgId, lock.held, host, report, startedAt);
  }
  try {
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      note(walkAttempt('drop', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was sent`, host, report);
    }
    const written = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!written.ok) {
      note(walkAttempt('drop', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${written.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${written.reason}); nothing was sent`, host, report);
    }
    // The drop leg's one route attempt. The durable copy is the route: stored by the write above
    // and confirmed by `deliver`, which returns `held` — a copy is never a delivery.
    const attempt = await relayDeliver(
      { route: 'durable-copy', copy: { dir: dropDir, name: msgId } },
      { id: msgId, record: written.record },
      { now: host.now },
    );
    if (attempt.outcome === 'refused') {
      note(walkAttempt('drop', 'refused', false, host.now(), startedAt, { reason: attempt.reason }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${attempt.reason}); nothing was sent`, host, report);
    }
    // A durable copy with no seat woken is the walk's last route's `held`: the episode counts it
    // so the delayed escalation can name a message nothing live ever took.
    note(walkAttempt('drop', 'held', false, host.now(), startedAt, { reason: 'the record is stored; no seat was woken' }));
    if (!human) {
      // Written before the send returns: a watcher that reads the drop a moment later still finds
      // the marker the receipt promotes, and a process that dies here leaves the watch its record.
      markPending(dropDir, {
        ts: host.now().toISOString(),
        from,
        to: seatName,
        ...(sentAs === null ? {} : sentAs),
        body,
        id: msgId,
        leg: 'drop',
      });
    }
    logLine(dir, 'send', who, `${seatName}: sent to its drop folder (drop ${String(body.length)} characters); no read receipt yet`, host.now());
    report.sent = msgId;
  } finally {
    lock.release();
  }
  if (wait) {
    return finishThreadWait(io, dir, root, who, from, project, session, seatName, dropDir, payload, 'drop', timeoutS, host, report, startedAt, failures, sentAs, undefined, extraRoot);
  }
  const ms = host.now().getTime() - startedAt;
  appendHistory(project, root, host.home, {
    ts: host.now().toISOString(),
    from,
    to: seatName,
    ...(sentAs === null ? {} : sentAs),
    ...historySender(report),
    body,
    id: msgId,
    thread: payload.thread,
    outcome: 'sent (unconfirmed)',
    ms,
    via: 'drop',
    ...failed,
  });
  return sentUnconfirmed(io, seatName, report, ms, 'drop');
}

/**
 * Writes the drop file under the seat lock, types the one trigger, and reports what it knows. The
 * trigger is the seat's own receipt-writing read, so when the signed `<id>.read.json` verifies
 * inside the wait the message is `delivered (read)` — the seat ran it, and the receipt is the
 * read. Short of that, a trigger that left the box is `sent (unconfirmed)`, never `delivered`: no
 * receipt has come back, and only a receipt earns that word. A line that was typed but not taken
 * is `not-submitted`, never a success. A line that left the box with no status, transcript or
 * receipt evidence inside the window is `sent (unconfirmed)` with the trigger note `trigger taken,
 * no read receipt yet`: the seat took it, the watch looks for the later sign, and the line is
 * never typed again. The lock is held across the typing so a second send cannot append into the
 * same composer.
 */
async function deliverNative(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  project: string,
  session: string,
  seatName: string,
  cli: string,
  pane: string,
  dropDir: string,
  payload: RecordPayload,
  trigger: string,
  host: SendHost,
  report: Report,
  startedAt: number,
  /** How the send reached the seat, for the outcome line (the fallback's own reason). */
  note?: string,
  /** The reasons the legs before this one did not take the send: every history line carries them. */
  failures: readonly string[] = [],
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: SentAs | null = null,
  wait = false,
  timeoutS = 60,
  extraRoot?: { root: string; session: string },
  walkNote: WalkNote = (_attempt) => { /* no episode */ },
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const msgId = payload.id;
  const body = payload.body;
  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) {
    // The seat's lock is another command's, so no keystroke is typed here. The signed record is
    // the message, and a marker beside it with no leg is the watch's typed-retry record: written
    // without that lock — the id names the file, and the relay publishes each name once — they
    // make the send durable now, and the watch types the same trigger once the seat is free.
    setLegState(report, 'typed', 'queued');
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      setLegState(report, 'typed', 'refused', 'the record could not be written');
      walkNote?.(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was typed`, host, report);
    }
    const queuedWrite = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!queuedWrite.ok) {
      setLegState(report, 'typed', 'refused', `the record could not be written (${queuedWrite.reason})`);
      walkNote?.(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${queuedWrite.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${queuedWrite.reason}); nothing was typed`, host, report);
    }
    const queuedEntry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId, thread: payload.thread };
    markPending(dropDir, queuedEntry);
    walkNote?.(walkAttempt('typed', 'delivered', false, host.now(), startedAt, { reason: `another command holds the seat (pid ${String(lock.held)}); queued for the watch` }));
    appendHistory(project, root, host.home, {
      ...queuedEntry,
      ...historySender(report),
      outcome: 'queued (receiver busy)',
      ms: host.now().getTime() - startedAt,
      ...failed,
    });
    return queuedBusy(io, dir, who, seatName, 'typed', msgId, lock.held, host, report, startedAt);
  }
  let taken = false;
  // An unsent draft the delivery moved out of the box and put back: its one-line word rides
  // on the outcome heard here. The copy's path, when the put-back failed, is in that line.
  let draft: string | undefined;
  try {
    let path: string;
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      walkNote?.(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was typed`, host, report);
    }
    const written = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!written.ok) {
      walkNote?.(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${written.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${written.reason}); nothing was typed`, host, report);
    }
    path = written.path;
    const receipt = (): boolean => receiptHeld(dropDir, msgId, { to: seatName, root, session }, host.home, claimBindingIn(root, session, seatName, msgId));
    const result = await deliverTrigger(bindPane(host.native, session), pane, trigger, cli, { receipt, dropPath: path });
    const where = `the record is at ${path}`;
    draft = result.draft === undefined ? undefined : draftNote(result.draft);
    // A held drop gets a record beside it, for the watch to deliver once the seat is free. The
    // line names that retry, so a sender does not have to guess whether the drop still travels.
    const retry = 'a running watch retries it when the seat is idle';
    const entry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId, thread: payload.thread };
    if (result.outcome === 'held') {
      appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'held', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      markPending(dropDir, entry);
      walkNote?.(walkAttempt('typed', 'held', false, host.now(), startedAt, { reason: result.reason ?? 'the composer holds text' }));
      return held(io, dir, who, seatName, `${result.reason ?? 'the composer holds text'}; ${where}; ${retry}`, host, report);
    }
    if (result.outcome === 'unreachable') {
      appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      // A dialog is not a missing channel: the drop is on disk and the seat will be free once the
      // prompt is answered, so the watch gets the same record a held send leaves.
      if (result.dialog !== undefined) {
        markPending(dropDir, entry);
        walkNote?.(walkAttempt('typed', 'unreachable', false, host.now(), startedAt, { reason: result.reason ?? 'the seat was not reached' }));
        return unreachable(io, dir, who, seatName, `${retry}; ${where}`, host, report, result.dialog);
      }
      walkNote?.(walkAttempt('typed', 'unreachable', false, host.now(), startedAt, { reason: result.reason ?? 'the seat was not reached' }));
      return unreachable(io, dir, who, seatName, `${result.reason ?? 'the seat was not reached'}; ${where}`, host, report);
    }
    if (result.outcome === 'not-submitted') {
      appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'not-submitted', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      markPending(dropDir, entry);
      walkNote?.(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: 'the line was not submitted' }));
      return notSubmitted(io, dir, who, seatName, result, `${where}; ${retry}${draft === undefined ? '' : `; ${draft}`}`, host, report);
    }
    // A signed read receipt that landed inside the window — or between its last poll and this
    // line — is the read itself: the seat ran the trigger's own drop read and the receipt is on
    // disk. That is `delivered (read)`, the one word a typed line earns only this way; the seat
    // read the message, which is not a claim that it acted on it.
    if (result.evidence === 'receipt' || (result.evidence === 'taken' && receiptHeld(dropDir, msgId, { to: seatName, root, session }, host.home, claimBindingIn(root, session, seatName, msgId)))) {
      walkNote?.(walkAttempt('typed', 'delivered', false, host.now(), startedAt));
      logLine(dir, 'send', who, `${seatName}: delivered (read) (drop ${String(body.length)} characters, typed, receipt${draft === undefined ? '' : `; ${draft}`})`, host.now());
      appendHistory(project, root, host.home, {
        ...entry,
        ...historySender(report),
        outcome: 'delivered (read)',
        ...(draft === undefined ? {} : { note: draft }),
        ms: host.now().getTime() - startedAt,
        via: 'typed',
        ...failed,
      });
      return delivered(io, seatName, report, 'read', 'typed');
    }
    taken = result.evidence === 'taken';
    // The line left the box: the transport delivered it, and the read receipt (if one comes) is
    // a later, separate signal.
    walkNote?.(walkAttempt('typed', 'delivered', false, host.now(), startedAt, { reason: 'trigger taken, no read receipt yet' }));
    logLine(dir, 'send', who, `${seatName}: sent (unconfirmed) (drop ${String(body.length)} characters, typed, ${evidenceOf(result)}${draft === undefined ? '' : `; ${draft}`})`, host.now());
    if (taken) {
      markTaken(dropDir, {
        id: msgId,
        from,
        to: seatName,
        body,
        ts: entry.ts,
        before: result.prior ?? 'unknown',
      });
    }
  } finally {
    lock.release();
  }
  // Every successful typed delivery is a trigger sent, never a message read: the drop is on disk
  // and the line left the box, and no signed receipt has come back. The note says exactly that.
  // A record beside a taken drop lets a running watch look for the later sign; it is never a retry
  // record — a taken line is never typed again.
  const notes = [TRIGGER_TAKEN_NOTE, note, draft].filter((one): one is string => one !== undefined);
  const noteLine = notes.join('; ');
  if (wait) {
    return finishThreadWait(io, dir, root, who, from, project, session, seatName, dropDir, payload, 'typed', timeoutS, host, report, startedAt, failures, sentAs, noteLine, extraRoot);
  }
  const ms = host.now().getTime() - startedAt;
  appendHistory(project, root, host.home, {
    ts: host.now().toISOString(),
    from,
    to: seatName,
    ...(sentAs === null ? {} : sentAs),
    ...historySender(report),
    body,
    id: msgId,
    thread: payload.thread,
    outcome: 'sent (unconfirmed)',
    note: noteLine,
    ms,
    via: 'typed',
    ...failed,
  });
  return sentUnconfirmed(io, seatName, report, ms, 'typed', noteLine);
}

/**
 * The mcp-inbox leg: the message is written whole into the seat's own inbox — the same 0600
 * drop file the typed leg would leave — and nothing is typed. The leg takes the send whenever
 * the seat's own server is listening (`inboxLive` has just said so); the wait that follows is
 * only for the receipt, and either ending exits 0. A receipt means the seat's client read the
 * message — `delivered (read)`, never a claim that it acted on it — and clears the pending
 * record. No receipt is `sent (unconfirmed)`, with the record left beside the drop carrying its
 * leg, so a watch pass can tell the message is the seat's own to read and never types it. The
 * lock is held across the write, as the typed leg holds it across its trigger.
 */
async function deliverInbox(
  io: Io,
  dir: string,
  who: string,
  from: string,
  project: string,
  root: string,
  session: string,
  seatName: string,
  dropDir: string,
  payload: RecordPayload,
  host: SendHost,
  report: Report,
  startedAt: number,
  /** The reasons the legs before this one did not take the send: every history line carries them. */
  failures: readonly string[] = [],
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: SentAs | null = null,
  wait = false,
  timeoutS = 60,
  extraRoot?: { root: string; session: string },
  note: WalkNote = (_attempt) => { /* no episode */ },
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const msgId = payload.id;
  const body = payload.body;
  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) {
    // The seat's lock is another command's, so nothing reaches its inbox server here. The record
    // and its inbox marker are written without that lock — the id names the file, the seal is
    // idempotent and the relay publishes each name once — and the seat's own server reads the
    // record when the seat is free; a marker past the inbox window is the watch's typed retry.
    // An acceptance, never a delivery.
    setLegState(report, 'mcp-inbox', 'queued');
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      setLegState(report, 'mcp-inbox', 'refused', 'the record could not be written');
      note(walkAttempt('mcp-inbox', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was sent`, host, report);
    }
    const queuedWrite = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!queuedWrite.ok) {
      setLegState(report, 'mcp-inbox', 'refused', `the record could not be written (${queuedWrite.reason})`);
      note(walkAttempt('mcp-inbox', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${queuedWrite.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${queuedWrite.reason}); nothing was sent`, host, report);
    }
    const queuedEntry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId, thread: payload.thread };
    markPending(dropDir, { ...queuedEntry, leg: 'mcp-inbox' });
    note(walkAttempt('mcp-inbox', 'delivered', false, host.now(), startedAt, { reason: `another command holds the seat (pid ${String(lock.held)}); queued for the seat's inbox and the watch` }));
    appendHistory(project, root, host.home, {
      ...queuedEntry,
      ...historySender(report),
      outcome: 'queued (receiver busy)',
      ms: host.now().getTime() - startedAt,
      ...failed,
    });
    return queuedBusy(io, dir, who, seatName, 'mcp-inbox', msgId, lock.held, host, report, startedAt);
  }
  const entry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId, thread: payload.thread };
  try {
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      note(walkAttempt('mcp-inbox', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was sent`, host, report);
    }
    const written = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!written.ok) {
      note(walkAttempt('mcp-inbox', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${written.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${written.reason}); nothing was sent`, host, report);
    }
    report.sent = msgId;
    // The seat's own inbox server took the record: the transport delivered it, whether or not a
    // read receipt follows inside the window.
    note(walkAttempt('mcp-inbox', 'delivered', false, host.now(), startedAt, { reason: "written to the seat's own MCP inbox" }));
    // Written before the wait: a process that dies mid-wait still leaves the message marked
    // for the watch's later pass. A receipt clears it; `sent (unconfirmed)` leaves it on disk.
    markPending(dropDir, { ...entry, leg: 'mcp-inbox' });
    if (!wait) {
      const grace = host.inboxGraceMs ?? INBOX_GRACE_MS;
      if (await awaitReceipt(dropDir, msgId, { to: seatName, root, session }, host.home, grace, claimBindingIn(root, session, seatName, msgId))) {
        clearPending(dropDir, msgId);
        logLine(dir, 'send', who, `${seatName}: delivered (read) (drop ${String(body.length)} characters, receipt)`, host.now());
        appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'delivered (read)', ms: host.now().getTime() - startedAt, via: 'mcp-inbox', ...failed });
        return delivered(io, seatName, report, 'read');
      }
      const ms = host.now().getTime() - startedAt;
      logLine(dir, 'send', who, `${seatName}: sent to its own MCP inbox (drop ${String(body.length)} characters); no receipt within ${String(grace)} ms`, host.now());
      appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'sent (unconfirmed)', ms, via: 'mcp-inbox', ...failed });
      return sentUnconfirmed(io, seatName, report, ms, 'mcp-inbox');
    }
  } finally {
    lock.release();
  }
  return finishThreadWait(io, dir, root, who, from, project, session, seatName, dropDir, payload, 'mcp-inbox', timeoutS, host, report, startedAt, failures, sentAs, undefined, extraRoot);
}

/**
 * A compose seat's typed leg: the drop file is written, then the profile's module walks the
 * CLI's own screens and types the brief there. Delivered means the CLI printed its proof line
 * (a created session); a module refusal after it typed is `not-submitted` — the box may hold
 * the text — and one before it typed is `unreachable`. The drop file stays the message's copy
 * when the walk fails, and every ending names it.
 */
async function deliverComposeSeat(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  project: string,
  session: string,
  seatName: string,
  cli: string,
  pane: string,
  dropDir: string,
  payload: RecordPayload,
  seatCwd: string,
  host: SendHost,
  report: Report,
  startedAt: number,
  failures: readonly string[] = [],
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: SentAs | null = null,
  wait = false,
  timeoutS = 60,
  extraRoot?: { root: string; session: string },
  note: WalkNote = (_attempt) => { /* no episode */ },
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const msgId = payload.id;
  const body = payload.body;
  const profile = profileFor(cli);
  const compose = profile?.compose ?? null;
  if (profile === null || compose === null) {
    note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: 'its profile carries no compose module' }));
    return refuse(io, dir, who, `${seatName}: its profile carries no compose module; nothing was sent`, host, report);
  }
  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) {
    // A compose seat is typed on its CLI's own screens, and nothing on the watch's side walks
    // those screens: there is no queued leg to leave the record for, so the send is refused and
    // says so — and says that the way forward is another send once the seat is free.
    const why = `another command holds it (pid ${String(lock.held)}); nothing was sent and a compose send is not queued; run it again when the seat is free`;
    note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: why }));
    return refuse(io, dir, who, `${seatName}: ${why}`, host, report);
  }
  const entry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId, thread: payload.thread };
  try {
    let path: string;
    try {
      sealDropTree(dir, session, seatName);
    } catch {
      note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: 'the record could not be written' }));
      return refuse(io, dir, who, `${seatName}: the record could not be written; nothing was typed`, host, report);
    }
    const written = await writeSendRecord(dropDir, payload, host.home, host.now);
    if (!written.ok) {
      note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: `the record could not be written (${written.reason})` }));
      return refuse(io, dir, who, `${seatName}: the record could not be written (${written.reason}); nothing was typed`, host, report);
    }
    path = written.path;
    const result = await deliverCompose(host.native, {
      profile: compose,
      binary: profile.binary,
      session,
      pane,
      seatCwd,
      idleTimeout: profile.idleTimeout,
      message: body,
    });
    const where = `the record is at ${path}`;
    if (result.outcome === 'unreachable') {
      appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      note(walkAttempt('typed', 'unreachable', false, host.now(), startedAt, { reason: result.reason }));
      return unreachable(io, dir, who, seatName, `${result.reason}; ${where}`, host, report);
    }
    if (result.outcome === 'not-submitted') {
      appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'not-submitted', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      note(walkAttempt('typed', 'refused', false, host.now(), startedAt, { reason: result.reason }));
      return typedBriefNotSubmitted(io, dir, who, seatName, `${result.reason}; ${where}`, host, report);
    }
    note(walkAttempt('typed', 'delivered', false, host.now(), startedAt, { reason: `typed brief, ${result.evidence}` }));
    logLine(dir, 'send', who, `${seatName}: delivered (typed brief, ${result.evidence})`, host.now());
  } finally {
    lock.release();
  }
  if (wait) {
    return finishThreadWait(io, dir, root, who, from, project, session, seatName, dropDir, payload, 'typed', timeoutS, host, report, startedAt, failures, sentAs, undefined, extraRoot);
  }
  appendHistory(project, root, host.home, { ...entry, ...historySender(report), outcome: 'delivered', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
  return delivered(io, seatName, report, 'typed brief');
}

/** What a brief's walk reports to its caller, in words the launch can print or log. */
export type BriefWalkResult = {
  /** The leg that took the send; null when none did, or when no leg was walked. */
  via: DeliveryLeg | null;
  /** Whether the walk ran at all. A settings record the store disowns stops it before any leg. */
  walked: boolean;
  /** The reasons legs did not take the send, and why a walk did not run. */
  failures: readonly string[];
  /** 0 when a leg took the send (or no walk ran), 1 when the walk ran out of legs. */
  exit: number;
};

/**
 * The delivery half of `brief-transport: message`. The launch has already claimed the
 * brief and written its signed record; this walks the receiving seat's own delivery order with
 * the same legs, the same order resolution and the same history a send uses, so the brief earns
 * the receipts a send earns. The record's identity — its id, thread, body and claim binding — is
 * the launch's own and is never re-minted here; every leg writes or finds that same record.
 *
 * The walk does not print the send command's lines: the caller hands an `io` that captures them
 * and reports the outcome in its own words. A seat whose signed settings record cannot be read is
 * walked by no leg at all — routing on a declaration the store disowns could type into a human's
 * pane — and the record the launch already wrote stands as the delivery. This build's native leg
 * is a socket write it does not make and a SendMessage a launch cannot send, so it is recorded
 * and passed; the mcp-inbox, typed and drop legs are the same functions `team send` walks.
 */
export async function walkBriefDelivery(input: {
  io: Io;
  host: SendHost;
  /** The receiving team's `.agents` folder. */
  dir: string;
  root: string;
  /** The receiving team's project; left out, the loaded team file's own. */
  project?: string;
  session: string;
  seat: string;
  cli: string;
  payload: RecordPayload;
}): Promise<BriefWalkResult> {
  const seatName = input.seat;
  const from = input.payload.from;
  const startedAt = input.host.now().getTime();
  const dropDir = join(input.dir, 'send-drops', input.session, seatName);
  const read = resolveSeatOverrides({ home: input.host.home, root: input.root, seat: seatName });
  if (!read.ok) {
    return {
      via: null,
      walked: false,
      exit: 0,
      failures: [`the receiving seat's settings record cannot be read: ${read.why}`],
    };
  }
  let file: TeamFile | undefined;
  try {
    const loaded = loadTeamFile(input.root, { home: input.host.home });
    if (loaded.ok) file = loaded.team;
  } catch {
    // A file that cannot even be read declares nothing, as one that does not validate does.
  }
  const order = deliveryOrder(deliveryChainOf({
    root: input.root,
    seat: seatName,
    home: input.host.home,
    ...(file === undefined ? {} : { file }),
    projectOfTeam: (id: string) => (input.host.projects ? input.host.projects.ofTeam(id) : projectRegistry.ofTeam(input.host.home, id)),
    overrides: read.overrides,
  }));
  const declared = file?.seats.find((seat) => seat.name === seatName);
  const project = input.project ?? file?.project ?? '';
  // A human's pane never takes typing, whatever its order says: its walk is the drop leg alone,
  // and the legs this ruling kept out are named first, exactly as a send's walk records them.
  const human = read.overrides.human ?? (declared?.human === true);
  const walk: readonly DeliveryLeg[] = human ? ['drop'] : order;
  const report: Report = {
    json: false,
    seat: seatName,
    sent: null,
    project,
    session: input.session,
    from_team: teamIdOf(input.root),
  };
  const failures: string[] = [];
  if (human) {
    for (const leg of order) {
      if (leg === 'typed') failures.push("typed: the pane is a human's, and nothing is typed into it");
      else if (leg === 'native') failures.push("native: the pane is a human's, and no frame is sent");
      else if (leg === 'mcp-inbox') failures.push("mcp-inbox: the pane is a human's, and the drop leg is the only one walked");
    }
  }
  for (const leg of walk) {
    if (leg === 'mcp-inbox') {
      const live = inboxLive(dropDir, input.root, input.session, seatName, input.host.build?.());
      if (!live.live) {
        failures.push(`mcp-inbox: ${live.reason}`);
        continue;
      }
      const exit = await deliverInbox(input.io, input.dir, from, from, project, input.root, input.session, seatName, dropDir, input.payload, input.host, report, startedAt, failures);
      return { via: 'mcp-inbox', walked: true, exit, failures };
    }
    if (leg === 'native') {
      // This build's send reads `native` as the frame on a cross-session socket — a socket write
      // SOCKET_SEND does not make here — or as a handoff to a Claude Code sender's own
      // SendMessage, which a launch cannot make. The leg is recorded and passed.
      failures.push('native: the launch cannot make a cross-session SendMessage');
      continue;
    }
    if (leg === 'typed') {
      const compose = profileFor(input.cli)?.compose ?? null;
      const trigger = readTriggerLine(seatName, input.session);
      if (trigger === null && compose === null) {
        failures.push(`typed: the trigger would exceed ${String(TRIGGER_MAX)} characters`);
        continue;
      }
      const found = findAgent(input.host, input.session, seatName);
      if (!found.ok) {
        failures.push(`typed: ${found.reason}`);
        continue;
      }
      if (isBareShellPane(input.dir, input.session, seatName, input.host.processInfo(input.session, found.pane))) {
        failures.push('typed: the seat is back at its shell; nothing was typed');
        continue;
      }
      if (compose === null) {
        if (trigger === null) {
          failures.push(`typed: the trigger would exceed ${String(TRIGGER_MAX)} characters`);
          continue;
        }
        const exit = await deliverNative(input.io, input.dir, input.root, from, from, project, input.session, seatName, input.cli, found.pane, dropDir, input.payload, trigger, input.host, report, startedAt, undefined, failures);
        return { via: 'typed', walked: true, exit, failures };
      }
      // The seat's own folder: the record's `cwd` under the receiving team's root, else the
      // folder this delivery already writes to.
      const seatCwd = declared === undefined ? input.dir : resolve(input.root, declared.cwd);
      const exit = await deliverComposeSeat(input.io, input.dir, input.root, from, from, project, input.session, seatName, input.cli, found.pane, dropDir, input.payload, seatCwd, input.host, report, startedAt, failures);
      return { via: 'typed', walked: true, exit, failures };
    }
    const exit = await deliverDropped(input.io, input.dir, input.root, from, from, project, input.session, seatName, dropDir, input.payload, input.host, report, startedAt, failures, null, human);
    return { via: 'drop', walked: true, exit, failures };
  }
  const why = `no leg of its delivery order took the send${failures.length === 0 ? '' : ` (${failures.join('; ')})`}`;
  appendHistory(project, input.root, input.host.home, {
    ts: input.host.now().toISOString(),
    from,
    to: seatName,
    ...historySender(report),
    body: input.payload.body,
    id: input.payload.id,
    thread: input.payload.thread,
    outcome: 'unreachable',
    ms: input.host.now().getTime() - startedAt,
    ...(failures.length > 0 ? { failed: [...failures] } : {}),
  });
  return { via: null, walked: true, exit: 1, failures };
}

/** The brief was typed into a compose seat's own box and the CLI never confirmed it. The
 *  message is on disk, and the one team.log line is the orchestrator's notice. Exit 1. */
function typedBriefNotSubmitted(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report): number {
  return notSubmittedAt(io, dir, who, seat, reason, host, report);
}
/** A send that typed its line and was never taken: the trigger line of a drop-file send, or a
 *  compose seat's brief. One site, one exit id: both are the same outcome to a caller. */
function notSubmittedAt(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report): number {
  const message = `${seat}: not-submitted: ${reason}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeSendError(io, 'send.not-submitted', message, report);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.not-submitted
}

/** `send-drops`, the session directory, and the seat directory are each mode 0700.
 *  The leaf alone would leave the parents at the umask, so other users could list
 *  session ids and seat names. `.agents` itself is not changed. */
export function sealDropTree(dir: string, session: string, seat: string): void {
  const root = join(dir, 'send-drops');
  const sessionDir = join(root, session);
  const leaf = join(sessionDir, seat);
  mkdirSync(leaf, { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(sessionDir, 0o700);
  chmodSync(leaf, 0o700);
}

/** The seat and channel. No drop file, nothing typed and no team.log line: a dry run writes
 *  nothing, and the log records writes. Exit 0, always. */
function dryRun(io: Io, seat: string, what: string, report: Report): number {
  report.sent = null;
  const summary = `${seat}: dry-run: ${what}`;
  const plan: PlanStep[] = [{ step: 'send', seat, detail: what, prefix: '+' }];
  if (report.json) {
    writeAction(io, report, { status: 'dry-run', summary, dryRun: true, channel: null, plan });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.dry-run
}

/** One `--list` row: the name to type, the seat's human name as an address (`@<nickname>` in its
 *  own team, `<nickname>@<team>` in another), its CLI, its role, the project its team sits in,
 *  and whether its seat is stopped. A seat of another team reads `<seat>@<team>` in the name; a
 *  nickname reads `@<nickname>` in its own team and `<nickname>@<team>` in another, so every human
 *  name the listing prints is an address too. */
type SeatRow = { name: string; nickname: string | null; cli: string; role: string; stopped: boolean; project: string; reach: 'socket' | 'typed' };

/** `--list`: the file's seats and its entity's other teams' seats, nothing sent and no caller
 *  check. Exit 0, always. */
function listSeats(io: Io, host: SendHost, report: Report): number {
  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  report.project = loaded.team.project;
  report.session = loaded.team.session;
  // Phase 0b: every row carries the project its team sits in — the registry project whose teams
  // name this team, else the team's own project name (a team the registry places in none is its
  // own project). An injected registry answers for itself; with none, the registry the host's home
  // holds is the reading, bound to that home rather than to wherever the process runs.
  const teamId = teamIdOf(loaded.root);
  const found = host.projects ? host.projects.ofTeam(teamId) : projectRegistry.ofTeam(host.home, teamId);
  const project = found?.name ?? loaded.team.project;
  // The reach a send would take, judged from the declared CLI alone: a Claude Code seat carries
  // the cross-session channel, every other CLI the typed trigger. `--list` reads no pane and
  // dials nothing, so it claims no live address; a stopped seat renders `stopped` in its place.
  const seats: SeatRow[] = loaded.team.seats.map((seat) => {
    // The signed seat setting stands where the file word did, so the row prints the address the
    // resolver takes: every row the listing prints is a spec the resolver answers.
    const nickname = addressedNickname(host.home, loaded.root, seat);
    return {
      name: seat.name,
      // The `@<nickname>` form: every row the listing prints is a spec the resolver takes as it
      // stands, and a bare nickname would not be one outside the caller's team.
      nickname: nickname === undefined ? null : `@${nickname}`,
      cli: seat.cli,
      role: seat.role,
      project,
      reach: seat.cli === 'claude-code' ? 'socket' : 'typed',
      stopped: seat.stopped === true,
    };
  });
  // The caller's entity reaches past its own file: the machine's team registry holds every other
  // team of the same entity, and each of their seats is addressable as `<seat>@<team>` — the
  // team's own project name is the scope. A registry the home cannot read is reported as the
  // team file's own read is; a team whose record names another entity, or none, adds no row.
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(host.home);
  } catch (error) {
    return configuration(io, (error as Error).message, report);
  }
  const entity = teams[teamId]?.entity ?? loaded.team.entity ?? null;
  if (entity !== null) seats.push(...crossTeamRows(host, teams, teamId, entity));
  const summary = pluralCount(seats.length, 'seat');
  if (report.json) {
    writeJson(io, 'team.send.list', {
      format: 1 as const,
      project: loaded.team.project,
      session: loaded.team.session,
      seats,
      summary,
    });
  } else {
    io.stdout(`${contextLine(loaded.team.project, loaded.team.session)}\n`);
    const rows = seats.map((seat) => [seat.name, seat.nickname ?? '-', seat.role, seat.project, seat.stopped ? 'stopped' : seat.reach]);
    for (const line of renderTable({ headers: ['SEAT', 'NICKNAME', 'ROLE', 'PROJECT', 'REACH'], rows })) io.stdout(`${line}\n`);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.listed
}

/**
 * The seats of the other teams of one entity, as `--list` rows: each roster line's seat and role,
 * the CLI and lifecycle the agent record carries, and the project its team sits in. A roster line
 * whose agent record is gone or retired is skipped — no address reaches it. A team record that is
 * stopped or archived marks every seat it carries as stopped, as a stopped seat's own file does.
 * Teams are ordered by their own name, so the rows a person reads do not follow the registry's
 * key order.
 */
function crossTeamRows(host: SendHost, teams: Record<string, TeamRecord>, ownId: string, entity: string): SeatRow[] {
  const agents = new Map(readAgents(host.home).map((agent) => [agent.id, agent]));
  const rows: SeatRow[] = [];
  const others = Object.entries(teams)
    .filter(([id, record]) => id !== ownId && record.entity === entity)
    .sort(([, left], [, right]) => left.project.localeCompare(right.project));
  for (const [id, record] of others) {
    const found = host.projects ? host.projects.ofTeam(id) : projectRegistry.ofTeam(host.home, id);
    const project = found?.name ?? record.project;
    for (const entry of record.roster) {
      const agent = agents.get(entry.agent);
      if (!agent || agent.lifecycle === 'retired') continue;
      const nickname = seatSettingsOf({
        home: host.home,
        root: record.root,
        agentId: entry.agent,
        seat: entry.seat,
        teamId: id,
        entity: record.entity,
      }).nickname ?? entry.nickname;
      rows.push({
        name: `${entry.seat}@${record.project}`,
        nickname: nickname === undefined ? null : `${nickname}@${record.project}`,
        cli: agent.cli,
        role: entry.role,
        stopped: agent.lifecycle === 'stopped' || record.lifecycle === 'stopped' || record.lifecycle === 'archived',
        project,
        reach: agent.cli === 'claude-code' ? 'socket' : 'typed',
      });
    }
  }
  return rows;
}

/**
 * The first of the pane's processes with a socket in the sockets folders: the foreground
 * processes first (the running CLI is one of them), then the shell; each pid's folders in
 * order — `socketsDir`, then the alt folder when the real host has one. The probe's socket
 * is derived from one process — the session — so more than one match is not resolved here:
 * the first is used, in that order.
 */
function socketOf(host: SendHost, processes: PaneProcesses): string | null {
  const dirs = host.socketsDirAlt === undefined ? [host.socketsDir] : [host.socketsDir, host.socketsDirAlt];
  const pids = [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
  for (const pid of pids) {
    for (const dir of dirs) {
      const path = join(dir, `${String(pid)}.sock`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The folders discovery looked in, as one phrase for a refusal's text. */
function socketDirs(host: SendHost): string {
  return host.socketsDirAlt === undefined ? host.socketsDir : `${host.socketsDir}, ${host.socketsDirAlt}`;
}

type SocketAttempt = { kind: 'delivered' } | { kind: 'held'; reason: string } | { kind: 'fallback'; reason: string };

/** The one sentence a held socket frame reports: the pane, the frame's state, and why nothing
 *  further is typed. */
const HELD_FRAME_REASON =
  'the session holds the socket frame at its held-message dialog ("Held message from another session"): the box is blocked while it is up, and nothing further is typed';

/** What the walk records for the native leg when the sender cannot make the leg itself: the
 *  frame is the sending session's own cross-session SendMessage, which this process cannot make,
 *  so the leg cannot take this send, and the walk skips and records it. A sender whose own file
 *  declares Claude Code gets the handoff instead. */
const NATIVE_LEG_UNAVAILABLE = "unavailable; the native leg is the sending session's own SendMessage";

/** How long a socket write's pane is read for the held-message dialog, in all. */
const HELD_READ_MS = 1000;

/** Reads the target pane until the held-message dialog shows, or ~1s passes: the dialog renders
 *  right after the write lands, and a write the session holds is not a delivery. A host with no
 *  pane reader keeps the write's own answer — there is nothing to look at. */
async function heldAtDialog(session: string, pane: string, host: SendHost): Promise<boolean> {
  const reader = host.native.paneText;
  if (reader === undefined) return false;
  if (showsHeldFrameDialog(reader(session, pane))) return true;
  for (let waited = 0; waited < HELD_READ_MS; waited += POLL_MS) {
    await host.native.wait(POLL_MS);
    if (showsHeldFrameDialog(reader(session, pane))) return true;
  }
  return false;
}

/**
 * The default path's first leg: one frame on the target's cross-session socket, nothing typed.
 * The address is resolved first — the registry's recorded one while it is still live, else the pane's
 * own processes — and a write the socket takes is the send: this channel has no
 * acknowledgement, so a taken frame is all this run can know. Every other ending comes back as
 * a reason for the caller to fall back to the typed trigger: no pane, no socket, a socket gone
 * or refusing, a frame past the measured limit. A recorded address whose write refuses gets one
 * live re-resolution first: a pid the registry has not caught up with must not cost the fast
 * path, while the record itself remains the registry's to refresh.
 */
async function deliverSocketFrame(
  dir: string,
  who: string,
  from: string,
  to: Aim,
  payload: RecordPayload,
  /** The reasons the legs before this one did not take the send: the history line carries them. */
  failures: readonly string[],
  host: SendHost,
  report: Report,
  startedAt: number,
  wait = false,
  inbound: InboundDeclaration = { policy: null, declaredAt: null, source: null },
  /** The sending run's team root: the entity an owner-origin reply line is read from. */
  callerRoot: string,
  /** The rendered `message-display` header every frame opens with; empty, the body alone. */
  header = '',
  /** True for a person-pane seat: no reply line and no read hint, a person answers in its client. */
  personPane = false,
): Promise<SocketAttempt> {
  const msgId = payload.id;
  const body = payload.body;
  report.sent = msgId;
  // The address as written, when it was a form: every history line carries it beside the seat.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  // The reply line names the seat the signed record carries and the team this run stood in; a
  // team the run does not know is no address at all, and the frame is not dialed rather than
  // answering somewhere guessed. A person-pane seat has no reply line at all.
  const sendingTeam = report.from_team;
  if (sendingTeam === undefined && !personPane) {
    return { kind: 'fallback', reason: 'the sending team is not known, so the frame carries no reply address' };
  }
  const reply = personPane || sendingTeam === undefined
    ? null
    : frameReplyFor(host.home, callerRoot, payload.from, sendingTeam);
  if (reply !== null && 'missing' in reply) return { kind: 'fallback', reason: reply.missing };
  // The header is the message's display line, then the record's full body: the signed copy is
  // still the message, and the header never replaces it.
  const content = header === '' ? body : `${header}\n\n${body}`;
  const frame = frameFor(content, msgId, reply === null ? null : reply.line);
  if (frame.length > FRAME_LIMIT) {
    return { kind: 'fallback', reason: `the frame is ${String(frame.length)} characters, past the socket's measured limit of ${String(FRAME_LIMIT)}` };
  }
  // The pane is read live, by the seat's name: a recorded pane may have been reused by another
  // seat since the record was written, and its socket is not this seat's.
  const found: Found = findAgent(host, to.session, to.seat);
  if (!found.ok) return { kind: 'fallback', reason: found.reason };
  // The seat lock stays the gate: a command that holds it — a send typing a trigger, an `up`,
  // an outstanding --wait — keeps this fast path out, and the typed path below answers the
  // refusal exactly as it always has. The lock file is read here, never taken: the fallback's
  // own delivery takes it for real.
  if (existsSync(seatLockPath(to.dir, to.session, to.seat))) {
    return { kind: 'fallback', reason: 'another command holds the seat' };
  }
  const first = socketPathFor(host, to, found.pane);
  if (first === null) {
    return { kind: 'fallback', reason: `no socket was found for its pane's processes (looked in ${socketDirs(host)})` };
  }
  // A session started before the file that declares `accept` changed was launched without the
  // setting in force: the frame would be held at its box, so the walk passes this leg over until
  // the seat's CLI host is restarted. The socket's own age is the evidence (`inboundIsLive`).
  if (!inboundIsLive(inbound, first.path)) {
    return { kind: 'fallback', reason: 'the receiving session was started before its crossSessionInbound declaration; restart its CLI host so it accepts' };
  }
  // The record is on disk before the frame leaves: a frame the seat never reads still leaves a
  // signed record in its folder, which is the copy `team messages` and the watch read.
  const copy = { dir: join(to.dir, 'send-drops', to.session, to.seat), name: msgId };
  const written = await writeSendRecord(copy.dir, payload, host.home, host.now);
  if (!written.ok) return { kind: 'fallback', reason: `the record could not be written (${written.reason})` };
  // One frame on the socket, through the relay's socket route. The caller's own dial is handed in,
  // so an injected host's transport is the transport this attempt uses. A recorded address whose
  // write refuses gets the same one live re-resolution it always did, as a second attempt.
  const message = { id: msgId, record: written.record, frame };
  let taken = await relayDeliver(
    { route: 'socket', socket: first.path, runtime: to.cli, copy },
    message,
    { now: host.now, dial: host.deliver },
  );
  if (taken.outcome !== 'delivered' && first.recorded) {
    const processes = host.processInfo(to.session, found.pane);
    const live = processes === null ? null : socketOf(host, processes);
    if (live !== null && live !== first.path) {
      taken = await relayDeliver({ route: 'socket', socket: live, runtime: to.cli, copy }, message, { now: host.now, dial: host.deliver });
    }
  }
  if (taken.outcome !== 'delivered') return { kind: 'fallback', reason: taken.reason };
  logLine(to.dir, 'send', who, `${to.seat}: sent on the socket (${String(frame.length)} characters)`, host.now());
  if (await heldAtDialog(to.session, found.pane, host)) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, ...historySender(report), body, id: msgId, thread: payload.thread, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'socket', ...failed });
    return { kind: 'held', reason: HELD_FRAME_REASON };
  }
  if (!wait) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, ...historySender(report), body, id: msgId, thread: payload.thread, outcome: 'delivered', ms: host.now().getTime() - startedAt, via: 'socket', ...failed });
  }
  return { kind: 'delivered' };
}

/** The address a send tries: the registry's recorded one while it is still live — its pid among
 *  the pane's, its socket present — else the pane's own processes (`socketOf`). `recorded` marks
 *  the difference — only the recorded address gets the live re-resolution after its write
 *  refuses. A pane that cannot be read leaves a recorded address as the only thing this run has;
 *  a write that refuses still falls back to the typed trigger. */
function socketPathFor(host: SendHost, to: Aim, pane: string): { path: string; recorded: boolean } | null {
  const processes = host.processInfo(to.session, pane);
  if (to.address !== null) {
    const live = liveSocketOf(to.address, processes, host.socketsDir);
    if (live !== null) return { path: live, recorded: live === to.address };
    if (processes === null) return { path: to.address, recorded: true };
  }
  if (processes === null) return null;
  const path = socketOf(host, processes);
  return path === null ? null : { path, recorded: false };
}

/** Raises the owner's `security.refused` for a denied identity or admission: the rule, the
 *  caller's seat, the seat it addressed and the folder the call stood in — never the message. */
function raiseSecurityRefusal(
  team: TeamFile,
  root: string,
  home: string,
  dir: string,
  caller: Caller,
  rule: 'placement' | 'admission',
  target: string | null,
  now: Date,
): void {
  raiseRefusalEvent({
    project: team.project,
    root,
    home,
    session: team.session,
    kind: 'security.refused',
    rule,
    object: {
      ...(target === null ? {} : { id: target }),
      ...(caller.kind === 'seat' ? { seat: caller.name } : caller.kind === 'owner' ? { seat: 'owner' } : {}),
      path: dir,
    },
    now,
  });
}

/** The caller a direct-work run names: the watch itself, built from the principal
 *  `sendWatchDirect` established after the actual verifier passed. It is never derived from io
 *  and never from the request. */
function watchCaller(principal: WatchSendPrincipal): Caller {
  return { kind: 'watch', session: principal.session, ...(principal.pane === undefined ? {} : { pane: principal.pane }) };
}

/** The watch context admission reads, or undefined for an ordinary run: the verified principal
 *  and the root this run actually loaded. The two are compared canonically at admission, so the
 *  context selects the loaded file, never an ambient working directory. */
function watchContext(host: SendHost, root: string): { principal: WatchSendPrincipal; root: string } | undefined {
  return host.watch === undefined ? undefined : { principal: host.watch, root };
}

/** The sender label a record and a history line carry: a seat's name, the reserved word `watch`
 *  for the watch's own direct-work principal, or `owner` for every other non-seat. */
function senderLabelOf(caller: Caller): string {
  return caller.kind === 'seat' ? caller.name : caller.kind === 'watch' ? 'watch' : 'owner';
}

/** One direct route's recheck, read as a refusal on any refusal or throw: a guard that cannot
 *  answer never lets a transport stand. The reason travels to the walk's attempt ledger unchanged. */
function guardRefusal(guard: (() => { ok: true } | { ok: false; why: string }) | undefined): { ok: false; why: string } | null {
  if (guard === undefined) return null;
  try {
    const verdict = guard();
    return verdict.ok ? null : { ok: false, why: verdict.why };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The recheck a direct route actually reads. When the run is the watch's own send, the watch
 * principal's actual verifier always runs first: it is composed here, from the principal the run
 * carries, so a caller that omits its own guard — or hands in one that always allows — cannot
 * replace it. A caller's guard, when present, may only narrow the principal's verdict, and a
 * refusal from either stands. Every other direct walk keeps exactly the guard it was given.
 */
function composedGuard(host: SendHost): (() => { ok: true } | { ok: false; why: string }) | undefined {
  const principal = host.watch;
  if (principal === undefined) return host.direct?.guard;
  const narrowing = host.direct?.guard;
  return () => {
    const mine = guardRefusal(() => principal.recheck());
    if (mine !== null) return mine;
    return guardRefusal(narrowing) ?? { ok: true };
  };
}

/**
 * Why the caller is not placed to send, or null — placement alone, never authority. The owner
 * always is; an unplaced caller is refused with its own reason; a seat must be the seat it names
 * in the session judged, on the pane the state records for it, exactly as `answer` judges, and
 * the two refusals it can name carry the repair.
 */
function placementProblemOf(caller: Caller, at: SeatStanding): string | null {
  if (caller.kind === 'unplaced') return caller.reason;
  if (caller.kind !== 'seat') return null;
  const verdict = callerVerdict(caller, caller.name, at);
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  return null;
}

/**
 * Why a caller judged as the file's declared seat does not pass the placement check: the two pane
 * reasons above, and the session — a call placed in another session than the one the seat is
 * judged in, or carrying none, is not that seat. The placement check is a precondition of the
 * declared judgement, so it is asked wherever that judgement is reached, and this is the one
 * place the refusal for a session the caller is not placed in is written.
 */
function declaredPlacementProblem(caller: Caller, name: string, at: SeatStanding): string | null {
  const verdict = callerVerdict(caller, name, at);
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (verdict.kind === 'refused') {
    return `seat ${name} stands in session ${at.session}, and this call is not placed in it: a caller of another session is not that seat`;
  }
  return null;
}

/** Why the send is admitted, and the rule that admitted it — or why it is not. */
export type Admission = { ok: true; rule: string; sender: Agent | DeclaredSender | 'owner' | 'watch' } | { ok: false; why: string };

/**
 * The authority rule for this send: `admitSend`, over the registry's own records, default deny.
 * The sender's record is its identity — the agent id the drop file's header names — and the
 * target is the agent the spec resolved to, or, on the declared-seat path, the seat this run
 * judged against the caller's own team. The team's record comes from the live file this run
 * judged, which is the seed the registry projects; a registered team's own record joins it when
 * addressing crosses teams.
 *
 * A caller the store holds no record for is judged as the seat the live file declares, when the
 * file declares it and the caller stands where the state records that seat — its pane, in the
 * session judged: the bootstrap case, where a team that has never been registered talks to itself
 * before any record exists. A caller the file declares but the state does not record standing is
 * refused by the placement check, with the two repairs the state can name. That judgement reaches
 * only its own team — the declared seat has no id to carry across teams — and it is never
 * granted: a grant names a record's identity. A caller the file does not declare, and any send
 * that would leave the file's team, stays refused with the commands that write the record.
 *
 * A record names a sender only where the call stands as it — the record's own seat, running, on
 * the pane the record holds, in its session, and on the pane the state records for that seat
 * (`recordIdentityProblem`; the same verdict `who.ts` asks of a seat). A call whose name matches a
 * record but does not stand as it is refused, never bound: a pane renamed to a registered seat's
 * name, and a caller of that name in another session, are not that seat, and must not send with
 * its id. A registry-resolved target does not skip this: the sender's identity is judged the same
 * way on every path, before any rule is asked.
 *
 * The last rule is read only once the registry's own rules have refused: the owner's send-grants
 * folder, and, only when it holds a record, the clock that decides expiry — the same order `up`
 * and `init` ask the grants in. A record the folder returns still has to name this caller's own
 * record and this receiver (`sendGrantFor`); a grant for another pair is not a grant here, so
 * nothing looser than the pair reaches `admitSend`.
 *
 * `reply` is handed in by `team reply` alone, and only after it verified the record it answers
 * and found the thread open: the context then carries `open-thread`, and the reply rule — the
 * last one `admitSend` asks — can admit a pair no rule above admits.
 */
export function admissionOf(
  caller: Caller,
  team: TeamFile,
  target: Target | null,
  seatName: string,
  home: string,
  fileTeamId: string,
  now: () => Date,
  at: SeatStanding,
  reply?: 'open-thread',
  watch?: { principal: WatchSendPrincipal; root: string },
): Admission {
  if (caller.kind === 'owner') return { ok: true, rule: 'the owner', sender: 'owner' };
  if (caller.kind === 'watch') return watchAdmissionOf(caller, team, target, seatName, watch);
  const record = recordFor(home, team.session, caller.kind === 'seat' ? caller.name : '');
  // A record is bound to a call only where the call stands as it: the record's own seat, running,
  // on the pane the record holds, in its session, and on the pane the state records for that seat
  // (`callerVerdict`). Session and seat name bind no one — a pane renamed to a registered seat's
  // name is not that seat, and a caller of the same name in another session is not either — so a
  // record the call does not stand as refuses instead of acting for it. Nobody is judged by it.
  if (record !== null) {
    const identity = recordIdentityProblem(caller, record, at);
    if (identity !== null) return { ok: false, why: identity };
  }
  const declared = record === null ? declaredSenderOf(caller, team, fileTeamId) : null;
  const sender = record ?? declared;
  if (sender === null) return { ok: false, why: noAgentRecord(caller, declared) };
  // The declared seat is a reading of the caller, not a record: it is judged as that seat only
  // where the state records the seat standing. The declared-target path asks this up front; asked
  // here too, a resolved spec asks it whatever the target's record state.
  if (declared !== null) {
    const placement = declaredPlacementProblem(caller, declared.seat, at);
    if (placement !== null) return { ok: false, why: placement };
  }
  // The team the sender's own rules are read in: the record's own team, or, for a declared
  // sender, the live file's.
  const ownTeam = record === null ? fileTeamId : record.reach.team;
  // The target the rules judge: the resolved agent's own record when the registry answered the
  // spec — it names the team a cross-team send lands in — else the seat the caller's team was
  // asked for, as the declared-seat path always had it.
  const judged: SendSide = target === null ? { seat: seatName, team: ownTeam } : target.agent;
  // A declared sender's judgement stops at its own team: with no record there is no identity for
  // a rule that crosses teams to read, so a send that would leave stays refused.
  if (record === null && teamOf(judged) !== fileTeamId) return { ok: false, why: noAgentRecord(caller, declared) };
  const records = admitRecordsOf(home, team, ownTeam, target);
  // The project level `admitSend` reads: the registered projects, which decide the pairs a
  // project's own rules admit, and the asker's `seats_cross_teams` chain, entity → project →
  // team → seat, which `admitSend` resolves itself (`seatsCrossTeams`). No level's record
  // carries a declaration of that setting yet, so the chain is empty here and the setting
  // stands at its own default, off.
  const context: AdmitContext = { projects: projectRegistry.readProjects(home), crossTeams: {}, ...(reply !== undefined ? { reply } : {}) };
  const verdict = admitSend(sender, judged, records, undefined, context);
  if (verdict.ok) return { ok: true, rule: verdict.rule, sender };
  // The grant folder is asked for a recorded sender alone: a grant names an identity, and the
  // declared one has none yet. So the header it would write never claims a grant.
  if (record !== null) {
    const grants = readSendGrants(home);
    if (grants.length > 0) {
      const grant = sendGrantFor(record, judged, grants, records, now());
      if (grant !== undefined) {
        const granted = admitSend(record, judged, records, grant, context);
        if (granted.ok) return { ok: true, rule: granted.rule, sender: record };
      }
    }
  }
  return { ok: false, why: verdict.why };
}

/**
 * The watch's own admission. A watch is not a seat: no seat or registry-record identity rule can
 * bind it, and its authority is the direct-work record `sendWatchDirect` verified with the actual
 * verifier before this run began. It admits exactly what the watch is for — one declared seat of
 * the team file it was verified against, in that file's session, under that file's canonical
 * root — and nothing else. A resolved address is read only where it resolves to this same root,
 * session and declared seat; every other address, grant, file or reply refuses. The target may
 * never be a person's pane or the owner.
 */
function watchAdmissionOf(
  caller: Extract<Caller, { kind: 'watch' }>,
  team: TeamFile,
  target: Target | null,
  seatName: string,
  watch: { principal: WatchSendPrincipal; root: string } | undefined,
): Admission {
  if (watch === undefined) {
    return { ok: false, why: 'the watch sends only through its own verified direct-work entry; no principal stands behind this run' };
  }
  // The captured root, canonically, is the only root this watch may act in. A team file with the
  // same session name in another root is another team, and the refusal comes before any staging.
  if (!samePath(watch.principal.root, watch.root)) {
    return { ok: false, why: `the watch was verified for its captured root, and this run loaded another root: same session names do not make another root's team` };
  }
  if (caller.session !== team.session || watch.principal.session !== team.session) {
    return { ok: false, why: `the watch stands in session ${caller.session}, not this team file's ${team.session}; nothing was sent` };
  }
  // A resolved address is allowed only when it is the plain declared seat this same file names;
  // an agent id, nickname or another team's seat is a spec the watch never carries.
  if (target !== null) {
    if (!samePath(target.team.root, watch.root)) {
      return { ok: false, why: `${target.agent.reach.seat}: it resolves to another team's record, and the watch wakes a seat of its own team file only` };
    }
    if (seatName !== target.agent.reach.seat || target.agent.reach.session !== team.session) {
      return { ok: false, why: `${seatName}: the watch addresses a declared seat by its own name and session, never a resolved spec` };
    }
  }
  const seat = target === null ? seatName : target.agent.reach.seat;
  const declared = team.seats.find((entry) => entry.name === seat);
  if (declared === undefined) {
    return { ok: false, why: `${seat}: it is not a declared seat; the watch wakes a seat of its own team file only` };
  }
  if (declared.human === true) {
    return { ok: false, why: `${seat}: the pane is a person's, and the watch wakes seats only` };
  }
  return { ok: true, rule: "the watch's direct-work authority", sender: 'watch' };
}

/** Whether two paths name the same place canonically; an unreadable side is not the same place. */
function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Why the watch's target is not the exact seat its own pass read, or null when it is. The watch
 * wakes a seat the registry holds a running record for, and the record, the state and the pass
 * must all name the same seat, session, pane and CLI: a record that stopped, a pane reused, or a
 * file that now names another CLI refuses before any route is attempted. The live pane read
 * (`direct.expect`) already answered the session's own view; this is the durable evidence behind it.
 */
function exactWatchTarget(host: SendHost, to: Aim, bound: { pane: string; cli: string }, dir: string): string | null {
  const record = recordFor(host.home, to.session, to.seat);
  if (record === null) {
    return `${to.seat}: the registry holds no record for it in session ${to.session}, and the watch wakes a recorded seat only; nothing was sent`;
  }
  if (record.lifecycle !== 'running') {
    return `the registry's record for seat ${to.seat} is ${record.lifecycle}, not running; nothing was sent`;
  }
  if (record.reach.seat !== to.seat || record.reach.session !== to.session) {
    return `the registry's record names ${record.reach.seat} in session ${record.reach.session}, not ${to.seat} in ${to.session}; nothing was sent`;
  }
  if (record.reach.pane !== bound.pane) {
    const on = record.reach.pane === null ? 'no pane' : `pane ${record.reach.pane}`;
    return `the registry records ${on} for seat ${to.seat}, and the pass read pane ${bound.pane}; nothing was sent`;
  }
  if (record.cli !== bound.cli) {
    return `the registry records ${record.cli} for seat ${to.seat}, and the pass read ${bound.cli}; nothing was sent`;
  }
  const recorded = standingOf(dir, to.session, { kind: 'seat', name: to.seat, pane: bound.pane, session: to.session }).recordedPane;
  if (recorded !== bound.pane) {
    const on = recorded === undefined ? 'no pane' : `pane ${recorded}`;
    return `the state records ${on} for seat ${to.seat}, and the pass read pane ${bound.pane}; nothing was sent`;
  }
  return null;
}

/** Why a caller with no registry record is refused, with the commands that write the record: a
 *  seat the live file declares is recorded where it already runs by `register`, and `up` registers
 *  every seat its run leaves standing, so the seat is judged by its own row afterwards either way.
 *  A caller the file does not declare is named `up` alone: `register` reads the same file, and it
 *  would refuse a name that file does not hold. */
function noAgentRecord(caller: Caller, declared: DeclaredSender | null): string {
  const register = declared === null ? '' : `\`team register ${declared.seat}\` records the seat where it already runs, or `;
  return `sender ${describeCaller(caller)} has no agent record on this machine, so no rule admits the send (${RULE_SUMMARY}); ${register}\`team up\` registers a seat it leaves standing`;
}

/** Why a call may not act as the agent record its name found: null when it may — the call is a
 *  seat standing as the record holds it, on the pane the record names, in the record's session,
 *  with the record running, and the state recording that seat on that same pane (`callerVerdict`,
 *  the pane proof every admitted seat meets). Session and seat name alone bind nobody: a pane
 *  renamed to a registered seat's name is not that seat, and a caller of that name in another
 *  session is not it either. */
function recordIdentityProblem(caller: Caller, record: Agent, at: SeatStanding): string | null {
  const name = record.reach.seat;
  if (caller.kind !== 'seat') {
    return `the registry holds agent ${record.id} for seat ${name}, and this call is ${describeCaller(caller)}: a record is its own seat's, never a placement beside it`;
  }
  if (record.lifecycle !== 'running') {
    return `the registry's record for seat ${name} is ${record.lifecycle}, not running: only a running seat acts as its own record`;
  }
  if (record.reach.session !== caller.session) {
    return `seat ${name} stands in session ${record.reach.session}, and this call is not placed in it: a caller of another session is not that seat`;
  }
  if (record.reach.pane !== caller.pane) {
    const on = record.reach.pane === null ? 'no pane' : `pane ${record.reach.pane}`;
    return `the registry records ${on} for seat ${name} in session ${record.reach.session}, and this call is on pane ${caller.pane}: a pane renamed to a seat's name is not that seat`;
  }
  const verdict = callerVerdict(caller, name, at);
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (verdict.kind === 'refused') {
    return `seat ${name} stands in session ${at.session}, and this call is not placed in it: a caller of another session is not that seat`;
  }
  return null;
}

/** The seat the live file declares for a caller the store holds no record for: its own name, the
 *  file's team id, and the role the file gives it. Null for a caller that is not a seat, or a
 *  name the file does not declare; whether the caller stands where the state records that seat is
 *  asked beside this judgement, never read from the name alone. */
function declaredSenderOf(caller: Caller, team: TeamFile, fileTeamId: string): DeclaredSender | null {
  if (caller.kind !== 'seat') return null;
  const seat = team.seats.find((one) => one.name === caller.name);
  if (!seat) return null;
  return { seat: seat.name, team: fileTeamId, role: seat.role, declared: true };
}

/** The registry's record whose name this session holds for a seat: the most recently updated one,
 *  retired records left out. Null when the store holds none. A candidate only — the call is bound
 *  to it by `recordIdentityProblem`, which asks that the call stands as the record holds it. */
function recordFor(home: string, session: string, seat: string): Agent | null {
  if (seat === '') return null;
  let found: Agent | null = null;
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired') continue;
    if (agent.reach.session !== session || agent.reach.seat !== seat) continue;
    if (!found || agent.provenance.updated_at >= found.provenance.updated_at) found = agent;
  }
  return found;
}

/** The admission records a send is judged against: every registered team — so a target in another
 *  team is judged by that team's own record — and, over it, the live file of each team of the pair,
 *  which is the seed the registry projects. The file's project, entity, lead and operator, with the
 *  roster the store holds for that team and the file's own seats behind it; a file seat the file
 *  names as its lead carries the `leads` capability there, so the rules read the file's own lead off
 *  the line the file declares it on, whichever spelling — the `leads` mark, or the legacy
 *  `coordinator:` key a 0.3.5/0.4 file still uses — named it. The receiving team's file is read for
 *  the same reason: its registry roster may have been written before the `leads` capability existed,
 *  so the record alone cannot say who leads it, and a send keyed on the record would refuse a lead
 *  whose file names one. A roster line's role word is read only by the operator pair, on both
 *  sides and from the file's line where it writes one; every other rule reads a place, a
 *  capability or a grant.
 */
function admitRecordsOf(home: string, team: TeamFile, teamId: string, target: Target | null): AdmitTeams {
  const records = readTeams(home);
  overlayTeam(home, records, team, teamId);
  if (target !== null) {
    // The key is the spelling the target's own record uses, exactly as `teamOf` reads it — that is
    // the record `admitSend` asks for. The caller's team is overlaid above already.
    const receivingId = target.agent.reach.team;
    if (receivingId !== teamId) {
      const receiving = loadTeamFile(target.team.root, { home });
      if (receiving.ok) overlayTeam(home, records, receiving.team, receivingId);
    }
  }
  return records;
}

/** One team's live file, laid over the registry's record: the file's project, entity, lead and
 *  operator, and the roster — the store's agent lines for the team, with the file's own seats
 *  behind them. A file seat carries `leads` where the file resolved it as the lead (from the
 *  `leads` mark or the legacy `coordinator:` key alike), so the project rules and the lead rule
 *  read the file's own place in the chain, never a role's word; the one rule that does read a role
 *  word, the operator pair, gets the word the file writes today on a store line. An `entity:` the
 *  file names wins;
 *  a file that names none keeps the entity the registry recorded, the precedence the listing and
 *  the nickname scope read — a key left out of the seed never erases a recorded entity. */
function overlayTeam(home: string, records: AdmitTeams, team: TeamFile, teamId: string): void {
  // The file's own assistant, by the place the file gives it: the capability rides the seat's
  // line, whether the line comes from the registry or from the file's seats below it.
  const assistantSeat = team.seats.find((seat) => seat.assistant === true)?.name;
  const roster: AdmitTeam['roster'] = [];
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired' || agent.reach.team !== teamId) continue;
    // The file's line is the seat's present word: a role it writes now decides as it writes it,
    // and the signing role the record was registered under stands only where the file no longer
    // declares the seat.
    const line = team.seats.find((seat) => seat.name === agent.reach.seat);
    roster.push({
      agent: agent.id, seat: agent.reach.seat, role: line?.role ?? agent.signing.role,
      ...(agent.reach.seat === assistantSeat ? { assistant: true } : {}),
    });
  }
  for (const seat of team.seats) {
    if (!roster.some((entry) => entry.seat === seat.name)) {
      roster.push({
        agent: '', seat: seat.name, role: seat.role, leads: seat.name === team.orchestrator,
        ...(seat.assistant === true ? { assistant: true } : {}),
      });
    }
  }
  records[teamId] = {
    project: team.project,
    entity: team.entity ?? records[teamId]?.entity ?? null,
    orchestrator: team.orchestrator,
    operator: team.operator,
    roster,
  };
}

/** The nickname a declared seat answers to: the one its signed record sets, standing where the
 *  file's word did, and the file's own when no record signs one. A record that does not verify
 *  signs nothing, so a broken record never takes the file's word away. */
function addressedNickname(home: string | null, root: string, seat: Seat): string | undefined {
  return seatOverridesOf({ home, root, seat: seat.name }).nickname ?? seat.nickname;
}

function seatList(team: TeamFile): string {
  const names = team.seats.map((seat) => seat.name);
  return names.length === 0 ? '(none)' : names.join(', ');
}

/** The socket frame was taken, the seat's inbox server returned the message, or the typed
 *  trigger's own drop read wrote a signed receipt. Exit 0, always. The note names the path —
 *  `socket` — and `read` for a signed receipt (the mcp-inbox leg's, or a typed trigger's own),
 *  whose own words are `delivered (read)`: the seat read the message, which is not a claim that
 *  it acted on it. `via` names the channel for a read that came through the typed leg. */
function delivered(io: Io, seat: string, report: Report, note?: string, via?: 'typed' | 'native' | 'headless-resume'): number {
  const summary = `${seat}: delivered${note === undefined ? '' : ` (${note})`}`;
  const read = note === 'read';
  if (report.json) {
    writeAction(io, report, {
      status: read ? 'delivered (read)' : 'delivered',
      summary,
      channel: read ? (via ?? 'mcp-inbox') : note === 'socket' ? 'socket' : 'typed',
    });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.delivered
}

/** A leg's success with no read receipt: on the mcp-inbox and drop legs the message is the 0600
 *  drop file in the seat's folder and nothing was typed; on the typed leg the trigger left the
 *  composer and the drop is still the message. The `note` says which — a typed send's names the
 *  trigger and the receipt that has not come back. Exit 0, always. */
function sentUnconfirmed(io: Io, seat: string, report: Report, ms: number, leg: 'mcp-inbox' | 'drop' | 'typed' | 'native' | 'headless-resume', note?: string): number {
  const summary = `${seat}: sent (unconfirmed) (${leg}, ${String(ms)} ms${note === undefined ? '' : `; ${note}`})`;
  if (report.json) {
    writeAction(io, report, { status: 'sent (unconfirmed)', summary, channel: leg });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.sent-unconfirmed
}

/** A reply record on the thread arrived within the window: printed, and the send is over. Exit 0, always. */
function answered(
  io: Io,
  seat: string,
  read: { reply: string; msg_id: string | null },
  report: Report,
  channel: 'socket' | 'typed' | 'drop' | 'mcp-inbox' | 'native' | 'headless-resume' = 'socket',
  thread: string | null = report.sent,
): number {
  const summary = `${seat}: answered`;
  if (report.json) {
    writeAction(io, report, { status: 'answered', summary, channel, reply: read.reply, replyId: read.msg_id, thread });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n${read.reply}\n`);
  }
  return 0; // exit: send.answered
}

/** The record was sent, and the wait window closed with no reply on the thread (the thread stays open). Exit 1, always. */
function timedOut(io: Io, seat: string, seconds: number, report: Report): number {
  const why = `sent, no reply on the thread within ${String(seconds)}s; the thread stays open`;
  const message = `${seat}: timeout: ${why}`;
  if (report.json) writeSendError(io, 'send.timeout', message, report);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.timeout
}

/** The message is on disk — or, on the socket's path, in the frame the session's own
 *  held-message dialog keeps — and the pane was left untouched. Exit 1, always. The note names
 *  the path, in the delivery lines' own shape (`socket`). */
function held(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report, note?: string): number {
  const label = note === undefined ? 'held' : `held (${note})`;
  const message = `${seat}: ${label}: ${reason}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeSendError(io, 'send.held', message, report);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.held
}

/** What showed the seat took the line, as the log words it. A box that cleared with no status or
 *  transcript evidence reads `trigger taken, no read receipt yet`: the line left the composer,
 *  and the only proof of a read is a receipt that has not come. */
function evidenceOf(result: DeliverResult): string {
  if (result.evidence === 'taken') return TRIGGER_TAKEN_NOTE;
  return result.evidence === 'transcript' ? 'the transcript shows the drop read' : `herdr status ${result.status ?? 'working'}`;
}

/** The trigger was typed and never taken: the seat did not begin processing it. The message is on
 *  disk, and the one team.log line is the orchestrator's notice. Exit 1, always. */
function notSubmitted(io: Io, dir: string, who: string, seat: string, result: DeliverResult, where: string, host: SendHost, report: Report): number {
  const box = result.box === undefined ? 'the box could not be read' : result.box === '' ? 'the box is empty' : `the box holds ${JSON.stringify(result.box)}`;
  const reason = `the seat did not take the trigger after ${String(result.tries)} Enter${result.tries === 1 ? '' : 's'}; ${box}; ${where}`;
  return notSubmittedAt(io, dir, who, seat, reason, host, report);
}

/** A refusal: the message was not written, and the reason says why. Exit 1, always. Outside a
 *  team's folder there is no team log to append to (`dir` is null), so the refusal is reported
 *  and not written down. */
function refuse(io: Io, dir: string | null, who: string, reason: string, host: SendHost, report: Report): number {
  if (dir !== null) logLine(dir, 'send', who, `refused: ${reason}`, host.now());
  if (report.json) writeSendError(io, 'send.refused', `refused: ${reason}`, report);
  else io.stderr(`team send: refused: ${reason}\n`);
  return 1; // exit: send.refused
}

/** The seat's channel was not open, and nothing was sent. A dialog is the one unreachable the
 *  watch can still deliver: the drop's record says so, and the line says when. Exit 1, always. */
function unreachable(
  io: Io,
  dir: string,
  who: string,
  seat: string,
  reason: string,
  host: SendHost,
  report: Report,
  /** The dialog in the way, when the send was stopped by one rather than by a missing channel. */
  dialog?: string,
): number {
  const words = dialog === undefined ? `unreachable: ${reason}` : `unreachable now (the screen reads ${dialog}); ${reason}`;
  const message = `${seat}: ${words}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeSendError(io, 'send.unreachable', message, report);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.unreachable
}

/** The receiving team file marks the seat `stopped: true`: the seat is not addressed, so the
 *  send is refused before a drop file, a leg or a history line exists. The line wears the
 *  unreachable outcome's words, and its own exit id tells a stopped seat apart from a channel
 *  that merely failed. Exit 1, always. */
function stoppedSeat(io: Io, dir: string, who: string, seat: string, host: SendHost, report: Report): number {
  const reason = `${seat} is stopped`;
  const message = `${seat}: unreachable: ${reason}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeJsonError(io, 'send.stopped', message);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.stopped
}

function usage(io: Io, message: string, report: Report, keyIsolation = false): number {
  if (report.json) {
    // A client invocation's usage refusal carries the same declared limitation as its other
    // outcomes, so no JSON reader sees a client document without it (the error schema admits it).
    if (keyIsolation) io.stdout(`${JSON.stringify({ ...jsonError('send.usage', message), key_isolation: KEY_ISOLATION_LINE }, null, 2)}\n`);
    else writeJsonError(io, 'send.usage', message);
  } else io.stderr(`team send: ${message}\n${USAGE}`);
  return 2; // exit: send.usage
}

function configuration(io: Io, message: string, report: Report): number {
  if (report.json) writeJsonError(io, 'send.configuration', message);
  else io.stderr(`team send: ${message}\n`);
  return 2; // exit: send.configuration
}

/** The one action document's own fields: the frame is `writeAction`'s. `summary` is the closing
 *  line the plain run prints last, so the two faces say the same thing once. */
type ActionFields = {
  status:
    | 'delivered'
    | 'delivered (read)'
    | 'sent (unconfirmed)'
    | 'queued (receiver busy)'
    | 'answered'
    | 'recorded'
    | 'native'
    | 'dry-run';
  summary: string;
  dryRun?: boolean;
  /** The leg that carried the send: `socket`, `typed`, `drop`, `mcp-inbox`, `headless-resume`, or `native` for a
   *  record or handoff. */
  channel?: 'socket' | 'typed' | 'drop' | 'mcp-inbox' | 'native' | 'headless-resume' | null;
  /** The reply's text, on an answered wait. */
  reply?: string;
  /** The reply record's own id, on an answered wait. */
  replyId?: string | null;
  /** The thread id, on an answered wait. */
  thread?: string | null;
  /** The native handoff: the exact SendMessage target, the body it carries, and the line that
   *  records the delivery — present on the handoff alone. */
  to?: string;
  confirm?: string;
  message?: string;
  plan?: readonly PlanStep[];
};

/** Writes a send's `team.error` document. A run that resolved a walk carries its ordered legs
 *  too, so a caller reading a failure sees the same report a delivered send has: which leg was
 *  tried, which a rule kept out, and which the walk never reached. A run refused before a walk
 *  resolved writes the plain error. */
function writeSendError(io: Io, id: string, message: string, report: Report): void {
  if (report.delivery === undefined) {
    writeJsonError(io, id, message);
    return;
  }
  io.stdout(`${JSON.stringify({ ...jsonError(id, message), delivery: report.delivery }, null, 2)}\n`);
}

/** Writes the `team.send` action document (the envelope's tag first, then the action surface,
 *  then the command's own fields) — the frame every exit-0 outcome shares. */
function writeAction(io: Io, report: Report, fields: ActionFields): void {
  writeJson(io, 'team.send', {
    format: 1 as const,
    dry_run: fields.dryRun === true,
    status: fields.status,
    action_summary: fields.summary,
    project: report.project,
    session: report.session,
    seat: report.seat,
    ...(fields.channel !== undefined ? { channel: fields.channel } : {}),
    ...(fields.to !== undefined ? { to: fields.to } : {}),
    ...(fields.confirm !== undefined ? { confirm: fields.confirm } : {}),
    ...(fields.message !== undefined ? { message: fields.message } : {}),
    ...(fields.thread !== undefined ? { thread: fields.thread } : {}),
    ids: { sent: report.sent, reply: fields.replyId ?? null },
    ...(fields.reply !== undefined ? { reply: fields.reply } : {}),
    ...(fields.plan !== undefined ? { plan: [...fields.plan] } : {}),
    ...(report.delivery !== undefined ? { delivery: report.delivery } : {}),
  });
}

/** The context line every exit-0 run opens on, when the receiving team file names the team:
 *  `team <project>, session "<session>"`. A run refused before the file was read has none. */
function openText(io: Io, report: Report): void {
  if (report.project !== null && report.session !== null) {
    io.stdout(`${contextLine(report.project, report.session)}\n`);
  }
}
