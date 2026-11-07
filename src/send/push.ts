// The runtime-push leg: one pointer handed to the receiving CLI's own runtime — its queue, its
// app-server, its ACP session — instead of a keystroke into a pane.
//
// The durable signed drop is still the message (`src/commands/send.ts` writes it first). This leg
// carries only two facts: the id, and the read that proves the message. The line is built from
// the signed record's sender and the sender team the send resolved for itself, never from the
// message body: a body that begins with a forged `From …` cannot change what the receiver reads
// first. A runtime may print the line as a diagnostic; neither the line nor an accepted queue
// entry is a read. Only the signed `<id>.read.json` the seat's own `inbox_read` writes is one.
//
// An adapter serves the CLI profiles it names and returns one of three words: `enqueue` (the
// runtime took the pointer), `unsupported` (this runtime has no channel for it in this build),
// or `unreachable` (the channel exists but could not be reached). None of them is `delivered`;
// the send stays `sent (unconfirmed)` until a receipt verifies. An adapter never types into a
// pane, never reads a screen, and is never given the message body.
import { TRIGGER_MAX } from './native.ts';
import { RUNTIME_PUSH_ADAPTERS } from './push-adapters.ts';

/** The authentic identity a pointer shows first: the signed record's sender and its team. */
export type PushSender = {
  /** The sender as the signed record carries it (`owner`, or a seat's name). */
  seat: string;
  /** The team the sender stood in when the send was judged. */
  team: string;
};

/** The request one adapter is given. It holds no message body: the body stays in the drop. */
export type RuntimePushRequest = {
  /** The receiving team's root. */
  root: string;
  /** The session the receiving seat belongs to. */
  session: string;
  /** The receiving seat's name, as the team file spells it. */
  seat: string;
  /** The message's drop id; the pointer names it and `inbox_read` takes it. */
  id: string;
  /** The sender the pointer names first, from the signed record — never from the body. */
  sender: PushSender;
  /** The receiving seat's runtime session, resolved by the send from the seat's own state or its
   *  registry record (`reach.agent_session`), never discovered by an adapter. Null when the seat
   *  has none recorded: an adapter that needs one answers `unsupported`, and the walk moves on. */
  agentSession: string | null;
  /** The pointer line, exactly as `pushPointer` builds it; the runtime may print it. */
  pointer: string;
  /** The home the send runs under, for a runtime channel that already keeps its own state there.
   *  It is not licence to read the owner's CLI configuration or credential folders
   *  (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.config/muse`): the seat is addressed
   *  through `agentSession`, never by discovery in those folders, and a test hands in a synthetic
   *  home. */
  home: string;
  /** Optional per-attempt timeout in milliseconds, resolved by the caller from the recipient's
   *  `delivery-timeout` (`native`) policy in `src/policy/delivery.ts`. */
  timeoutMs?: number;
};

/** What an adapter says after one attempt. Only `enqueue` means the runtime took the pointer;
 *  none of these words is a read, and none of them is `delivered`. */
export type RuntimePushOutcome =
  | { kind: 'enqueue' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unreachable'; reason: string; timedOut?: boolean };

/** What a native route needs from the seat's own records before it can take a pointer: the
 *  conversation the CLI holds (`agent_session`, read the way `recordedSeatSession` reads it), or
 *  only the record that places the seat. */
export type RuntimePushBinding = 'conversation' | 'seat';

/** One runtime's channel, for the CLI profiles it names. */
export type RuntimePushAdapter = {
  /** The CLI profiles the adapter serves, as `src/launch/cli-hook.ts` and the team file spell
   *  them (`claude-code`, `codex`, `gemini`, …). */
  readonly clis: readonly string[];
  /** What the route needs of the seat's records before it can take a pointer: `conversation`
   *  when it hands the pointer to a threaded runtime the CLI already holds, so the seat's
   *  recorded `agent_session` is the binding that lets the route resolve it; `seat` when the
   *  record that places the seat is the route's whole requirement. */
  readonly binding: RuntimePushBinding;
  /** Hands one pointer to the runtime; resolves with what the runtime said. It must not carry
   *  the message body and must not type into a pane. */
  push(request: RuntimePushRequest): Promise<RuntimePushOutcome>;
};

/**
 * The first line a runtime shows for a pushed message: the authentic sender's `seat@team`, the
 * message id, and the one `inbox_read` call that proves it — one line, and never the body. When
 * `sentAt` is the record's own send time, the line names it too, so a pointer that arrives late
 * shows its age. The time is left off when adding it would pass `TRIGGER_MAX`. The signed record
 * supplies the sender; a name typed into the body cannot reach this line. Null when the identity
 * or id would make the line more than `TRIGGER_MAX` characters or more than one line; the leg
 * then hands the send to the next one, as a typed trigger that cannot be built is refused rather
 * than shortened.
 */
export function pushPointer(id: string, sender: PushSender, sentAt?: string): string | null {
  if (id === '' || sender.seat === '' || sender.team === '' || /\s/.test(sender.seat) || /\s/.test(sender.team)) return null;
  const base = `From ${sender.seat}@${sender.team}: New team message ${id}: call inbox_read({"id":"${id}"})`;
  const timed = sentAt !== undefined && sentAt !== '' && !/\s/.test(sentAt)
    ? `${base} sent ${sentAt}`
    : base;
  const line = timed.length <= TRIGGER_MAX ? timed : base;
  if (line.includes('\n') || line.length > TRIGGER_MAX) return null;
  return line;
}

/**
 * The adapter for a receiving seat's CLI, or null when this build carries none. A seat whose CLI
 * has no adapter has no runtime-push leg to walk: the leg is skipped without a failure, since no
 * send of that seat's could ever leave by it. `adapters` is the shipped registry unless a caller
 * (a test, or a host that extends the build) hands its own.
 */
export function pushAdapterFor(cli: string, adapters: readonly RuntimePushAdapter[] = RUNTIME_PUSH_ADAPTERS): RuntimePushAdapter | null {
  return adapters.find((adapter) => adapter.clis.includes(cli)) ?? null;
}

/**
 * The binding the native route of a seat's CLI needs: the runtime-push adapter this build ships
 * for that CLI declares it, so the check a launch reads back is the one the adapter itself
 * resolves — one declaration per route, not a name list kept beside the call. A CLI with no
 * adapter has no native route in this build, so the record that places the seat is all it can
 * require. `adapters` is the shipped registry unless a caller hands its own, as
 * {@link pushAdapterFor}.
 */
export function nativePushBindingFor(cli: string, adapters: readonly RuntimePushAdapter[] = RUNTIME_PUSH_ADAPTERS): RuntimePushBinding {
  return pushAdapterFor(cli, adapters)?.binding ?? 'seat';
}
