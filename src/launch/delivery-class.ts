// How a message reaches a seat that is not in a turn: read from the profile the CLI measured,
// then refined by what the seat's launch actually installed.
//
// A profile's `delivery` is one measurement of the CLI's own channels: an event adapter that
// wakes the seat (the development channel, the cross-session socket), the runtime's own queue
// that holds a message between turns (a Codex seat on a managed endpoint), an MCP inbox the
// model reads when it takes a turn, or nothing. The measured class is the ceiling, not the
// answer: a Claude seat launched without the channel and without an accepted socket is a
// pull-on-turn seat, and a Codex seat launched without a managed endpoint is pull-on-turn or,
// with no watcher at all, none.
//
// This module is the one reader of that refinement. It reads the facts the launch left behind —
// the recorded watcher (or the one its launch line implies), the development channel on the
// line, the cross-session socket the send itself would dial (its declaration, the team file's
// own word, and the address the registry recorded), the managed app-server endpoint bound to its
// current presence incarnation, together with the conversation that endpoint's queue is
// addressed by, and the seat's webhook adapter when its row configures one (its two files read
// at the same moment) — and answers one class plus the evidence it read, so a caller that skips
// a seat can say why. The words a console prints come from the same class (`deliveryWords`), so
// the report and the gating can never disagree.
import { existsSync } from 'node:fs';
import { inspectRecordedCodexEndpoint } from '../daemon/presence/endpoint-record.ts';
import type { Seat } from '../file/types.ts';
import { channelLaunchEnabled } from '../mcp/channel.ts';
import { DELIVERY_CLASSES, profileFor, type DeliveryClass } from '../profiles/profile.ts';
import { findAgent } from '../registry/agents.ts';
import { recordedSeatSession } from '../registry/resume.ts';
import { teamIdOf } from '../registry/teams.ts';
import { declaredInboundOf, inboundIsLive, socketEligible } from '../send/inbound.ts';
import { webhookRouteOf } from '../send/webhook.ts';
import type { SeatState } from '../state.ts';
import { cliWatcher, type CliWatcher } from './cli-hook.ts';

export { DELIVERY_CLASSES };
export type { DeliveryClass };

/** What the launch left behind, as each part is measured: the words a class is read from. */
export type DeliveryFacts = {
  /** The class the CLI's shipped profile measured, or `none` when it has no profile. */
  declared: DeliveryClass;
  /** The seat is a person's pane: nothing wakes it, and a message waits in its bus inbox. */
  human?: boolean;
  /** The watcher the launch installed: the recorded value when the state has one, else the one
   *  the launch line implies (`cliWatcher`). `none` means the CLI has no route to the drop. */
  watcher: CliWatcher;
  /** Whether the launch enables the CLI's development channel, the push adapter that wakes an
   *  idle seat. Measured from the line, the way the send's channel leg measures it. */
  channel: boolean;
  /** Whether the receiving session's cross-session socket is a route the send admits: its
   *  effective settings declare `crossSessionInbound: accept`, the team file's own `inbound`
   *  word does not opt out, and the address the seat's registry record names still stands. A
   *  caller that read the pane may pass `false` for a socket the session no longer holds. */
  socket: boolean;
  /** Whether the seat's managed app-server endpoint is recorded and bound to its current
   *  presence incarnation, and the seat's own records name the conversation that queue is
   *  addressed by: only then does its runtime's own queue hold a message between turns. */
  endpoint: boolean;
  /** Whether the seat configures a webhook adapter and both its files can be read right now:
   *  the routine takes every accepted message, so it wakes an idle seat like the channel. */
  webhook?: boolean;
};

/**
 * The class that decides whether a message can reach the seat while it is idle: `push` when an
 * event adapter wakes it, `between-turns` when its runtime queue takes the message, otherwise
 * `pull-on-turn` while some watcher serves its turns, or `none` with nothing at all.
 *
 * The profile's declared class is not consulted here: the facts are what the launch installed,
 * which is what the stranger at the other end of a send can rely on. A declared `push` seat
 * whose launch turned neither adapter on falls to its watcher, and a declared `between-turns`
 * seat with no endpoint falls the same way.
 */
export function effectiveDeliveryClass(facts: DeliveryFacts): DeliveryClass {
  if (facts.human === true) return 'none';
  if (facts.channel || facts.socket || facts.webhook === true) return 'push';
  if (facts.endpoint) return 'between-turns';
  if (facts.watcher !== 'none') return 'pull-on-turn';
  return 'none';
}

/** Whether a message can reach a seat of this class while it sits idle. `push` and
 *  `between-turns` can; `pull-on-turn` and `none` cannot, which is why dispatch spends no
 *  attempt on them. */
export function wakeableWhileIdle(cls: DeliveryClass): boolean {
  return cls === 'push' || cls === 'between-turns';
}

/** The class a CLI's shipped profile measured, or `none` for a CLI this build has no profile
 *  for. The launch refines this (`effectiveDeliveryClass`); the declaration alone is what `up`
 *  reports, because a seat is being launched and nothing has been installed yet. */
export function declaredDeliveryClass(cli: string): DeliveryClass {
  return profileFor(cli)?.delivery ?? 'none';
}

/** The class in plain words, for a console line after the leg's own word. Never a bare
 *  "unconfirmed": each sentence says what happens to the message next. */
export function deliveryWords(cls: DeliveryClass, seat: string): string {
  switch (cls) {
    case 'push':
      return 'woken through its event adapter';
    case 'between-turns':
      return 'woken through its runtime queue';
    case 'pull-on-turn':
      return `queued; ${seat} reads it at its next turn (pull-only)`;
    case 'none':
      return `queued; ${seat} has no way to be woken while idle`;
  }
}

/** The evidence a seat-level read found, kept apart from the class so a caller can say what it
 *  read rather than only what it concluded. */
export type DeliveryEvidence = {
  /** The CLI the seat runs, as the file or the launch record names it. */
  cli: string;
  /** The class its profile declares, or `none` when the CLI has no shipped profile. */
  declared: DeliveryClass;
  watcher: CliWatcher;
  /** `recorded` when the state carries the watcher the launch installed; `derived` when it was
   *  read off the launch line because the record has none. */
  watcherFrom: 'recorded' | 'derived';
  channel: boolean;
  socket: boolean;
  /** Whether the seat's records bind the conversation its runtime queue is addressed by
   *  (`recordedSeatSession`), so a pointer can actually be handed over. Read only while an
   *  endpoint is recorded and bound; `false` there is what keeps the class off `between-turns`. */
  conversation: boolean;
  /** The endpoint record bound to the current presence incarnation, and a bound conversation. */
  endpoint: boolean;
  human: boolean;
  /** Whether the seat's webhook adapter can post right now: its two files read, and the secret
   *  file is the owner's own 0600 file. False when the seat configures none or cannot deliver. */
  webhook: boolean;
  /** Why a configured webhook adapter cannot deliver, when it cannot; null otherwise. */
  webhookReason: string | null;
};

export type SeatDelivery = {
  seat: string;
  /** The effective class: what a send or a dispatch may do with an idle seat. */
  class: DeliveryClass;
  /** The class in plain words (`deliveryWords`), ready for a console line. */
  words: string;
  evidence: DeliveryEvidence;
};

/** The seat-level read's input: the team's folders and the two records a launch leaves. */
export type SeatDeliveryInput = {
  /** The team's state folder: the folder holding the team file, where the launch's generated
   *  settings file and its endpoint record live. */
  dir: string;
  /** The team's root, for a relative script on the launch line. */
  root: string;
  session: string;
  seat: string;
  /** The seat's row in the team file, when the caller has one: its `cli`, its launch line, its
   *  `human` word, its `inbound` word — the team's own opt-out the send admits by — and its
   *  `webhook` row when it configures an adapter. A temporary seat has none. */
  declared?: Pick<Seat, 'cli' | 'launch' | 'human' | 'inbound' | 'webhook'>;
  /** The seat's runtime record, when the seat is launched. Its `launch_line` is what the
   *  launch actually ran, its `watcher` is what the launch actually installed, and its `id` and
   *  `agent_session` are the two facts a conversation binding is compared by. */
  state?: Pick<SeatState, 'id' | 'cli' | 'launch_line' | 'watcher' | 'agent_session' | 'codex_endpoint' | 'presence_binding'>;
  /** The registry home: where the seat's agent record keeps the cross-session address its
   *  launch recorded. A caller that cannot name it proves no recorded address, and the socket
   *  is then no evidence — the conservative reading, never a guess. */
  home?: string;
};

/** The cross-session address the seat's registry record names, when one is recorded: the same
 *  record a send resolves its dial from. A home the caller cannot name, or a registry that
 *  cannot be read, proves no address. */
function recordedSocketAddress(input: SeatDeliveryInput): string | null {
  if (input.home === undefined) return null;
  try {
    return findAgent(input.home, { team: teamIdOf(input.root), seat: input.seat })?.reach.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the seat's runtime queue can be handed a pointer at all: the conversation binding the
 * push adapter resolves before it calls `codex queue --thread <id>` (`recordedSeatSession`). An
 * endpoint alone is no evidence — a managed launch records its endpoint before its pane has
 * reported the thread it started, and a restart can rebind a record's handle while the
 * conversation stays behind — so a seat whose own records do not bind a conversation is never
 * read as woken. Without a registry home the record cannot be compared, and the state's own copy
 * is the one necessary reading left: a state naming no agent session proves no conversation.
 */
function conversationBound(input: SeatDeliveryInput): boolean {
  const state = input.state;
  if (state === undefined) return false;
  if (input.home === undefined) return (state.agent_session ?? '') !== '';
  return recordedSeatSession({
    home: input.home,
    root: input.root,
    herdrSession: input.session,
    seat: { name: input.seat, cli: state.cli ?? input.declared?.cli ?? '' },
    state,
  }).kind === 'bound';
}

/**
 * One seat's effective delivery class, read from the records the launch left.
 *
 * The class is measured, not assumed: the CLI and launch line come from the runtime record
 * first (what ran) and the file's row second (what a launch will run); the watcher is the
 * recorded one, or the one `cliWatcher` derives from the line; the channel is the launch
 * line's own flag; the socket is the route the send itself admits — the effective settings'
 * `crossSessionInbound`, the team file's own word, and the address the launch recorded; and
 * the endpoint is the recorded app-server URL only while it is bound to the seat's current
 * presence incarnation and the seat's records bind the conversation its queue is addressed by
 * (`recordedSeatSession`, the read the push adapter makes). A record that cannot be read falls
 * to the conservative class, never to a guess.
 */
export function seatDeliveryClass(input: SeatDeliveryInput): SeatDelivery {
  const cli = input.state?.cli ?? input.declared?.cli ?? '';
  const launch = input.state?.launch_line ?? input.declared?.launch ?? '';
  const declaredClass = declaredDeliveryClass(cli);
  const recorded = input.state?.watcher;
  const watcher = recorded ?? cliWatcher(cli, launch);
  const channel = cli === 'claude-code' && channelLaunchEnabled(launch);
  const inbound = declaredInboundOf({
    dir: input.dir,
    root: input.root,
    session: input.session,
    seat: input.seat,
    ...(input.declared?.launch !== undefined ? { launch: input.declared.launch } : {}),
  });
  const endpointRecorded = inspectRecordedCodexEndpoint(
    input.state?.codex_endpoint,
    input.state?.presence_binding,
  ).kind === 'ok';
  // The endpoint is a running app-server; `between-turns` also needs the thread its queue takes
  // a pointer for. The two are written by different moments of a launch, so the second is read
  // here rather than assumed from the first.
  const conversation = endpointRecorded && conversationBound(input);
  const endpoint = endpointRecorded && conversation;
  const human = input.declared?.human === true;
  // The socket is the route the send itself admits: the effective settings' accept, the team
  // file's own `inbound` word, and the address the launch recorded still standing. A
  // declaration alone is no evidence that a socket exists; without a recorded address that is
  // there, nothing can be dialed, and a dispatch must not spend time-bound work on it.
  const address = recordedSocketAddress(input);
  const socket =
    socketEligible(input.declared?.inbound, inbound) &&
    address !== null &&
    existsSync(address) &&
    inboundIsLive(inbound, address);
  // The webhook adapter is read from the two files its row names, right now: a route that cannot
  // be read is no evidence the seat wakes, and the words say why in the same breath.
  const webhookRoute = input.declared?.webhook === undefined ? null : webhookRouteOf(input.declared.webhook);
  const webhook = webhookRoute?.ok === true;
  const webhookReason = webhookRoute !== null && !webhookRoute.ok ? webhookRoute.reason : null;
  const facts: DeliveryFacts = {
    declared: declaredClass,
    watcher,
    channel,
    socket,
    endpoint,
    ...(human ? { human: true } : {}),
    ...(webhook ? { webhook: true } : {}),
  };
  const cls = effectiveDeliveryClass(facts);
  return {
    seat: input.seat,
    class: cls,
    words: deliveryWords(cls, input.seat),
    evidence: {
      cli,
      declared: declaredClass,
      watcher,
      watcherFrom: recorded === undefined ? 'derived' : 'recorded',
      channel,
      socket: facts.socket,
      conversation,
      endpoint,
      human,
      webhook,
      webhookReason,
    },
  };
}
