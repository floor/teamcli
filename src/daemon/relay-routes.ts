// Machine-daemon route-selection and runtime-adapter integration.
//
// Bridges a host-resolved `HostedRoute` (`src/daemon/routes.ts`) and its validated `TeamFile` with
// the runtime-adapter contract (`runtimeRelayCapabilities`, `probeRuntimeRelayRoute`,
// `deliverRuntimeRelayRoute`, `walkRuntimeRelayRoutes` in `src/send/push-adapters/relay-runtime.ts`).
//
// Boundary invariants:
//   - Does not touch `src/daemon/host.ts` or `src/daemon/protocol.ts` (owned by the host module), or
//     `src/daemon/next.ts` / `src/daemon/next-client.ts` (owned by the next handler).
//   - Like `handleNext` in `src/daemon/next.ts`, takes a host-resolved `HostedRoute` and loaded
//     `TeamFile`, re-verifies route/team agreement, declared-seat membership, stopped-seat state,
//     signed seat settings (`resolveSeatOverrides`), and (when a `SignedRecord` is supplied)
//     message-key signature and route-binding fields before any route is probed or staged.
//   - Broker hosting stays strictly off (`broker: 'absent'`): nothing in this module opens a
//     broker socket or reads a credential store.
//   - Preserves the receipt and fallback semantics:
//       * One signed durable copy is staged once under `message.id` before any route attempt.
//       * Candidate routes are probed before dialing or spawning; any route that would hold or
//         block (`crossSessionInbound: 'hold'`, a session socket predating `accept`, or an active /
//         non-accepting Codex thread on `thread/read`) is classified `would-hold` and skipped.
//       * `durable-copy` returns `outcome: 'held'` (`readReceiptVerified: false`, receipt `stored`).
//       * Live transport (`socket`, `native`, `headless-resume`) returns `outcome: 'delivered'`
//         (`readReceiptVerified: false`, receipt `maybe-consumed`) and promotes to `'read'` only
//         when TeamCLI's signed `<id>.read.json` verifier (`receiptHeld` / `awaitReceipt`) confirms
//         a verified read receipt. Every runtime reports `liveReceiptProven: false`.
import { dirname, join } from 'node:path';
import type { Caller } from '../caller.ts';
import { resolveSeatOverrides, type SeatOverrides } from '../config/apply.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { awaitReceipt, claimBindingIn, receiptHeld } from '../mcp/inbox.ts';
import { codexDaemonForSeat, type CodexDaemonValue } from '../policy/codex-daemon.ts';
import {
  deliveryEscalationDelay,
  deliveryTimeoutInForce,
  type DeliveryEscalationDelay,
  type DeliveryTimeoutInForce,
} from '../policy/delivery.ts';
import type { DeliveryTimeoutRoute } from '../policy/types.ts';
import { ofTeam as projectOfTeamInRegistry, type ProjectRecord } from '../registry/projects.ts';
import type { RecordedSeatSessionRead } from '../registry/resume.ts';
import { teamIdOf } from '../registry/teams.ts';
import { deliveryChainOf, type DeliveryChain } from '../send/delivery.ts';
import type { FallbackNote } from '../send/fallback-events.ts';
import { beginFallbackWalk, type FallbackWalk, type WalkAttempt } from '../send/fallback-walk.ts';
import { frameFor, frameReplyFor } from '../send/frame.ts';
import {
  declaredInboundOf,
  heldSocketPath,
  preciseSocketSkipReason,
  readHeldSocket,
  socketEligible,
  socketHeldReason,
  type CrossSessionInbound,
  type InboundDeclaration,
} from '../send/inbound.ts';
import type { PushSender, RuntimePushAdapter } from '../send/push.ts';
import type { CodexSpawn } from '../send/push-adapters/codex.ts';
import type { CodexThreadReadProbe } from '../send/push-adapters/codex-relay.ts';
import type { HeadlessResumeSpawn } from '../send/push-adapters/headless-resume.ts';
import {
  deliverRuntimeRelayRoute,
  probeRuntimeRelayRoute,
  RUNTIME_RELAY_ROUTES,
  runtimeRelayCapabilities,
  walkRuntimeRelayRoutes,
  type RuntimeRelayAttempt,
  type RuntimeRelayCapabilities,
  type RuntimeRelayDeliverOptions,
  type RuntimeRelayMessage,
  type RuntimeRelayProbeOptions,
  type RuntimeRelayProbeOutcome,
  type RuntimeRelayRoute,
  type RuntimeRelaySocketTarget,
  type RuntimeRelayTarget,
  type RuntimeRelayWalkResult,
} from '../send/push-adapters/relay-runtime.ts';
import {
  RECORD_KIND,
  signedRecordOf,
  verifyRecord,
  type SignedRecord,
} from '../send/record.ts';
import type { DeliveryLeg, SettingLevel } from '../settings/inherit.ts';
import { deliveryOrder } from '../settings/resolve.ts';
import { messageKeyState } from '../store/keys.ts';
import type { Dial, RelayReceipt as PackageRelayReceipt, RelayStage } from '../../packages/relay/index.js';
import { canonicalRoot, type HostedRoute } from './routes.ts';

export {
  deliverRuntimeRelayRoute,
  probeRuntimeRelayRoute,
  RUNTIME_RELAY_ROUTES,
  runtimeRelayCapabilities,
  walkRuntimeRelayRoutes,
  type RuntimeRelayAttempt,
  type RuntimeRelayCapabilities,
  type RuntimeRelayDeliverOptions,
  type RuntimeRelayMessage,
  type RuntimeRelayProbeOptions,
  type RuntimeRelayProbeOutcome,
  type RuntimeRelayRoute,
  type RuntimeRelayTarget,
  type RuntimeRelayWalkResult,
};

/** Direct non-typing wake legs allowed when a hosted watch dispatches with `directOnly: true`. */
export const DAEMON_DIRECT_WAKE_LEGS: readonly DeliveryLeg[] = ['socket', 'headless-resume'];

/** Refusal codes returned by the daemon route-selection and relay-send handlers before transport. */
export type DaemonRelayRefusalCode =
  | 'daemon.route-file'
  | 'daemon.route-seat'
  | 'daemon.route-stopped'
  | 'daemon.route-settings'
  | 'daemon.route-record'
  | 'daemon.route-empty';

export type DaemonRelaySkippedLeg = {
  leg: DeliveryLeg;
  reason: string;
};

export type DaemonRelayRoutePlan = {
  route: HostedRoute;
  seat: string;
  cli: string;
  version?: string;
  launch?: string;
  human: boolean;
  directOnly: boolean;
  home: string;
  stateDir: string;
  teamFile?: string;
  dropDir: string;
  /** Pure synchronous capability descriptor from `runtimeRelayCapabilities(cli, version)`. */
  capabilities: RuntimeRelayCapabilities;
  /** Resolved `DeliveryLeg[]` order from the seat's chain before relay-route mapping. */
  deliveryOrder: readonly DeliveryLeg[];
  /** Ordered candidate `RuntimeRelayRoute[]` selected for the relay walk. */
  selectedRoutes: readonly RuntimeRelayRoute[];
  /** Delivery legs kept out by the human rule, `directOnly`, or non-relay handling. */
  skippedLegs: readonly DaemonRelaySkippedLeg[];
  /** Receiver's team-file `inbound` word (`accept | hold | refuse | undefined`). */
  teamInbound?: CrossSessionInbound;
  /** Receiver's resolved launch-effective `crossSessionInbound` declaration (`accept | hold | refuse | null`). */
  inbound: InboundDeclaration;
  /** Whether the receiver's launch word (narrowed by an explicit team-file `hold`/`refuse`, and
   *  defaulted only for a launch this build attested) lets the socket leg dial, without an
   *  un-reconfirmed held mark. */
  socketEligible: boolean;
  /** Precise reason why `socket` is ineligible or skipped, or `null` when eligible. */
  socketIneligibleReason: string | null;
  /** Whether the send is an own-seat self-send (`from === seat` in the same team/session). */
  selfSend: boolean;
  /** Effective `codex-daemon` policy (`on | off`) when the receiver is a Codex seat (`off` otherwise). */
  codexDaemon: CodexDaemonValue;
  /** Effective `delivery-timeout` per-route attempt budgets from the signed policy chain. */
  deliveryTimeout: DeliveryTimeoutInForce;
  /** Effective `delivery-escalation` main fallback delay from the signed policy chain. */
  escalationDelay: DeliveryEscalationDelay;
  /** Broker feature state; always `'absent'` in this slice. */
  broker: 'absent';
};

export type DaemonRelayRouteSelectInput = {
  /** The hosted route resolved by `resolveScope` in `src/daemon/routes.ts`. */
  route: HostedRoute;
  /** The validated team file loaded for `route`. */
  team: TeamFile;
  /** Target seat name within `route`. */
  seat: string;
  /** Optional sender seat name for own-seat / self-send detection (`from === seat`). */
  from?: string;
  /** Optional sender team ID for own-seat / self-send detection. */
  fromTeam?: string;
  /** Machine home directory (`<home>/.config/team/...`). */
  home: string;
  /** Optional state folder (defaults to `dirname(teamFile)` or `<route.root>/.agents`). */
  stateDir?: string;
  /** Optional explicit path to the loaded `team.yaml`. */
  teamFile?: string;
  /** Clock instant for policy expiry evaluation. */
  now?: Date;
  /**
   * When `true` (hosted watch direct-wake dispatch), keeps only direct non-typing wake legs
   * (`socket`, `headless-resume`) and never appends `durable-copy`.
   */
  directOnly?: boolean;
  /**
   * Whether to ensure `'durable-copy'` stands at the end of `selectedRoutes` when not `directOnly`
   * so a send whose live routes all fail is held on disk. Defaults to `true`.
   */
  includeDurableCopyFallback?: boolean;
  /** Optional delivery-order chain override for synthetic route tests. */
  chain?: DeliveryChain;
  /** Optional pre-resolved seat settings overrides. */
  overrides?: SeatOverrides;
};

export type DaemonRelayRouteSelectDeps = {
  projectOfTeam?: (teamId: string) => ProjectRecord | null;
};

export type DaemonRelayRouteSelection =
  | { ok: true; plan: DaemonRelayRoutePlan }
  | {
      ok: false;
      code: DaemonRelayRefusalCode;
      outcome: 'refused';
      message: string;
      broker: 'absent';
    };

function refuseSelection(
  code: DaemonRelayRefusalCode,
  message: string,
): Extract<DaemonRelayRouteSelection, { ok: false }> {
  return {
    ok: false,
    code,
    outcome: 'refused',
    message,
    broker: 'absent',
  };
}

function humanSkipReasonFor(leg: DeliveryLeg): string {
  switch (leg) {
    case 'typed':
      return "the pane is a human's, and nothing is typed into it";
    case 'native':
      return "the pane is a human's, and no frame is sent";
    case 'socket':
      return "the pane is a human's, and no frame is sent";
    case 'headless-resume':
      return "the pane is a human's, and no session is resumed";
    case 'mcp-inbox':
      return "the pane is a human's, and the drop leg is the only one walked";
    case 'channel':
      return "the pane is a human's, and the drop leg is the only one walked";
    case 'drop':
      return '';
  }
}

function relayRouteOfLeg(leg: DeliveryLeg): RuntimeRelayRoute | null {
  switch (leg) {
    case 'socket':
      return 'socket';
    case 'native':
      return 'native';
    case 'headless-resume':
      return 'headless-resume';
    case 'drop':
      return 'durable-copy';
    case 'mcp-inbox':
    case 'channel':
    case 'typed':
      return null;
  }
}

/**
 * Resolves a hosted route's target seat, runtime capabilities (`runtimeRelayCapabilities`),
 * effective `delivery-order` (including the Claude `socket` and Codex `native` implied defaults,
 * the `human` drop-only rule, and `directOnly` filtering), and signed `delivery-timeout` /
 * `delivery-escalation` policies.
 */
export function selectDaemonRelayRoutes(
  input: DaemonRelayRouteSelectInput,
  deps: DaemonRelayRouteSelectDeps = {},
): DaemonRelayRouteSelection {
  const { route, team, seat, home } = input;
  const now = input.now ?? new Date();

  if (team.project !== route.team || team.session !== route.session) {
    return refuseSelection(
      'daemon.route-file',
      'the hosted route and its team file disagree; nothing was routed',
    );
  }

  const declaredSeat: Seat | undefined = team.seats.find((candidate) => candidate.name === seat);
  if (!route.seats.includes(seat) || declaredSeat === undefined) {
    return refuseSelection(
      'daemon.route-seat',
      `${seat}: it is not a declared seat of ${route.root}`,
    );
  }

  if (declaredSeat.stopped === true) {
    return refuseSelection('daemon.route-stopped', `${seat} is stopped`);
  }

  let overrides: SeatOverrides = input.overrides ?? {};
  if (input.overrides === undefined && input.chain === undefined) {
    const read = resolveSeatOverrides({ home, root: route.root, seat });
    if (!read.ok) {
      return refuseSelection(
        'daemon.route-settings',
        `the receiving seat's settings record cannot be read: ${read.why}`,
      );
    }
    overrides = read.overrides;
  }

  const stateDir =
    input.stateDir
    ?? (input.teamFile !== undefined ? dirname(input.teamFile) : join(route.root, '.agents'));
  const dropDir = join(stateDir, 'send-drops', route.session, seat);

  const capabilities = runtimeRelayCapabilities(declaredSeat.cli, declaredSeat.version);

  const rawChain: DeliveryChain =
    input.chain
    ?? deliveryChainOf({
      root: route.root,
      seat,
      home,
      file: team,
      projectOfTeam:
        deps.projectOfTeam ?? ((id: string) => projectOfTeamInRegistry(home, id)),
      overrides,
      now,
    });

  const baseOrder = deliveryOrder(
    rawChain as Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>,
    { now },
  );

  const inbound = declaredInboundOf({
    dir: stateDir,
    root: route.root,
    session: route.session,
    seat,
    ...(declaredSeat.launch === undefined ? {} : { launch: declaredSeat.launch }),
  });

  const codexDaemon: CodexDaemonValue =
    declaredSeat.cli === 'codex'
      ? codexDaemonForSeat({
          home,
          root: route.root,
          team,
          ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
          seat,
          session: route.session,
          now,
        })
      : 'off';

  const declaredOrder = Object.values(rawChain).some(
    (word) => word !== undefined && word.length > 0,
  );
  const teamInbound = declaredSeat.inbound;
  const heldStanding = socketHeldReason(
    readHeldSocket(heldSocketPath(stateDir, route.session, seat)),
    inbound,
  );
  const selfSend =
    input.from !== undefined
    && input.from === seat
    && (input.fromTeam === undefined
      || input.fromTeam === route.team
      || input.fromTeam === teamIdOf(route.root));
  const socketNow = socketEligible(teamInbound, inbound) && heldStanding === null;
  const socketIneligibleReason =
    declaredSeat.cli !== 'claude-code'
      ? `${declaredSeat.cli} sessions have no cross-session socket`
      : !socketEligible(teamInbound, inbound)
        ? preciseSocketSkipReason(teamInbound, inbound)
        : heldStanding;
  const socketFirst =
    !declaredOrder && declaredSeat.cli === 'claude-code' && socketNow;
  const nativeFirst = !declaredOrder && declaredSeat.cli === 'codex' && codexDaemon === 'on';

  const orderedLegs: readonly DeliveryLeg[] = socketFirst
    ? ['socket', ...baseOrder]
    : nativeFirst
      ? ['native', ...baseOrder]
      : baseOrder;

  const human = overrides.human ?? (declaredSeat.human === true);
  const directOnly = input.directOnly === true;
  const skippedLegs: DaemonRelaySkippedLeg[] = [];

  if (
    !human
    && declaredSeat.cli === 'claude-code'
    && !declaredOrder
    && !baseOrder.includes('socket')
    && !socketFirst
    && socketIneligibleReason !== null
  ) {
    skippedLegs.push({ leg: 'socket', reason: socketIneligibleReason });
  }

  let chosenLegs: readonly DeliveryLeg[];
  if (human) {
    for (const leg of baseOrder) {
      if (leg !== 'drop') {
        skippedLegs.push({ leg, reason: humanSkipReasonFor(leg) });
      }
    }
    chosenLegs = ['drop'];
  } else {
    chosenLegs = orderedLegs;
  }

  let effectiveLegs: readonly DeliveryLeg[];
  if (directOnly) {
    const kept: DeliveryLeg[] = [];
    for (const leg of chosenLegs) {
      if (DAEMON_DIRECT_WAKE_LEGS.includes(leg)) {
        kept.push(leg);
      } else {
        skippedLegs.push({
          leg,
          reason:
            selfSend && leg === 'typed'
              ? `own-seat self-send (${seat} -> ${seat}): nothing is typed into the sender's own active pane`
              : 'direct-only dispatch walks only non-typing live wake routes',
        });
      }
    }
    effectiveLegs = kept;
  } else {
    effectiveLegs = chosenLegs;
  }

  const selectedRoutes: RuntimeRelayRoute[] = [];
  for (const leg of effectiveLegs) {
    const mapped = relayRouteOfLeg(leg);
    if (mapped === null) {
      skippedLegs.push({
        leg,
        reason:
          selfSend && leg === 'typed'
            ? `own-seat self-send (${seat} -> ${seat}): nothing is typed into the sender's own active pane`
            : 'handled outside the relay runtime-adapter walk',
      });
      continue;
    }
    if (!selectedRoutes.includes(mapped)) {
      selectedRoutes.push(mapped);
    }
  }

  const includeDurableFallback = !directOnly && (input.includeDurableCopyFallback ?? true);
  if (includeDurableFallback && !selectedRoutes.includes('durable-copy')) {
    selectedRoutes.push('durable-copy');
  }

  const policyInput = {
    home,
    entity: team.entity ?? '',
    projectId: projectIdOfTeam(home, team, route.root) ?? '',
    root: route.root,
    team,
    seat,
    now,
  };
  const deliveryTimeout = deliveryTimeoutInForce(policyInput);
  const escalationDelay = deliveryEscalationDelay(policyInput);

  return {
    ok: true,
    plan: {
      route,
      seat,
      cli: declaredSeat.cli,
      ...(declaredSeat.version === undefined ? {} : { version: declaredSeat.version }),
      ...(declaredSeat.launch === undefined ? {} : { launch: declaredSeat.launch }),
      human,
      directOnly,
      home,
      stateDir,
      ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
      dropDir,
      capabilities,
      deliveryOrder: effectiveLegs,
      selectedRoutes,
      skippedLegs,
      ...(teamInbound === undefined ? {} : { teamInbound }),
      inbound,
      socketEligible: socketNow,
      socketIneligibleReason,
      selfSend,
      codexDaemon,
      deliveryTimeout,
      escalationDelay,
      broker: 'absent',
    },
  };
}

export type DaemonRelayTargetBuildInput = {
  plan: DaemonRelayRoutePlan;
  messageId: string;
  sender: PushSender;
  /** Optional explicit cross-session socket path for `'socket'`. */
  socketPath?: string | null;
  /** Optional runtime override for `'socket'` in synthetic multi-route tests (defaults to `plan.cli`). */
  socketRuntime?: string;
  /** Optional explicit agent session / thread ID for `'native'` or `'headless-resume'`. */
  agentSession?: string | null;
  /** Optional remote app-server endpoint for Codex `'native'`. */
  remote?: string;
  /** Optional routes override (defaults to `plan.selectedRoutes`). */
  routes?: readonly RuntimeRelayRoute[];
};

export type DaemonRelayTargetBuildDeps = {
  resolveSocketPath?: (route: HostedRoute, seat: string) => string | null;
};

/**
 * Builds one `RuntimeRelayTarget` for a candidate `RuntimeRelayRoute` on a hosted route.
 */
export function buildDaemonRelayTarget(
  routeName: RuntimeRelayRoute,
  input: DaemonRelayTargetBuildInput,
  deps: DaemonRelayTargetBuildDeps = {},
): RuntimeRelayTarget {
  const { plan, messageId, sender } = input;
  const copy = { dir: plan.dropDir, name: messageId };

  switch (routeName) {
    case 'socket': {
      const socket =
        input.socketPath !== undefined
          ? (input.socketPath ?? '')
          : (deps.resolveSocketPath?.(plan.route, plan.seat) ?? '');
      return {
        route: 'socket',
        runtime: input.socketRuntime ?? plan.cli,
        socket,
        copy,
        root: plan.route.root,
        dir: plan.stateDir,
        session: plan.route.session,
        seat: plan.seat,
        ...(plan.launch === undefined ? {} : { launch: plan.launch }),
        ...(plan.teamInbound === undefined ? {} : { teamInbound: plan.teamInbound }),
        requireTeamInbound: true,
      };
    }
    case 'native':
      return {
        route: 'native',
        runtime: plan.cli,
        copy,
        root: plan.route.root,
        home: plan.home,
        session: plan.route.session,
        seat: plan.seat,
        sender,
        ...(input.agentSession === undefined ? {} : { agentSession: input.agentSession }),
        ...(input.remote === undefined ? {} : { remote: input.remote }),
      };
    case 'headless-resume':
      return {
        route: 'headless-resume',
        runtime: plan.cli,
        copy,
        root: plan.route.root,
        home: plan.home,
        session: plan.route.session,
        seat: plan.seat,
        sender,
        cwd: plan.route.root,
        ...(input.agentSession === undefined ? {} : { agentSession: input.agentSession }),
      };
    case 'durable-copy':
      return {
        route: 'durable-copy',
        copy,
        runtime: plan.cli,
      };
  }
}

/**
 * Builds the ordered list of `RuntimeRelayTarget`s for `plan.selectedRoutes` (or `input.routes`).
 */
export function buildDaemonRelayTargets(
  input: DaemonRelayTargetBuildInput,
  deps: DaemonRelayTargetBuildDeps = {},
): readonly RuntimeRelayTarget[] {
  const routes = input.routes ?? input.plan.selectedRoutes;
  return routes.map((routeName) => buildDaemonRelayTarget(routeName, input, deps));
}

export type DaemonRelayRouteProbeEntry = {
  route: RuntimeRelayRoute;
  target: RuntimeRelayTarget;
  probe: RuntimeRelayProbeOutcome;
};

export type DaemonRelayPlanProbeResult = {
  probes: readonly DaemonRelayRouteProbeEntry[];
  /** First route whose probe reported `status: 'ready'`, or `null` when none is ready. */
  firstReadyRoute: RuntimeRelayRoute | null;
  /** Live routes skipped because they reported `status: 'would-hold'`. */
  wouldHoldRoutes: readonly RuntimeRelayRoute[];
};

/**
 * Probes a single `RuntimeRelayTarget` using `probeRuntimeRelayRoute`, failing closed as
 * `'unavailable'` when a `'socket'` target has no resolved socket path before touching the
 * filesystem.
 */
export async function probeDaemonRelayTarget(
  target: RuntimeRelayTarget,
  options: RuntimeRelayProbeOptions = {},
): Promise<RuntimeRelayProbeOutcome> {
  if (target.route === 'socket' && target.socket.trim() === '') {
    // Still check runtime support and inbound declaration first so `unsupported`, `refused`, and
    // `would-hold` (`hold`) are classified accurately before checking the socket path.
    const inboundProbe = await probeRuntimeRelayRoute(target, {
      ...options,
      requireSocketFile: false,
    });
    if (inboundProbe.status !== 'ready') {
      return inboundProbe;
    }
    return {
      status: 'unavailable',
      route: 'socket',
      reason: 'no cross-session socket was found for the receiving seat',
    };
  }
  return probeRuntimeRelayRoute(target, options);
}

/**
 * Probes every candidate route in a `DaemonRelayRoutePlan` (or `input.routes`) in order using
 * `probeRuntimeRelayRoute`.
 */
export async function probeDaemonRelayRoutes(
  input: DaemonRelayTargetBuildInput & {
    probeOptions?: RuntimeRelayProbeOptions;
    perRouteProbeOptions?: Partial<Record<RuntimeRelayRoute, RuntimeRelayProbeOptions>>;
  },
  deps: DaemonRelayTargetBuildDeps = {},
): Promise<DaemonRelayPlanProbeResult> {
  const targets = buildDaemonRelayTargets(input, deps);
  const probes: DaemonRelayRouteProbeEntry[] = [];
  let firstReadyRoute: RuntimeRelayRoute | null = null;
  const wouldHoldRoutes: RuntimeRelayRoute[] = [];

  for (const target of targets) {
    const mergedOptions: RuntimeRelayProbeOptions = {
      ...(target.route === 'socket' ? { crossSessionInbound: input.plan.inbound } : {}),
      ...input.probeOptions,
      ...input.perRouteProbeOptions?.[target.route],
      id: input.messageId,
    };
    const probe = await probeDaemonRelayTarget(target, mergedOptions);
    probes.push({ route: target.route, target, probe });
    if (firstReadyRoute === null && probe.status === 'ready') {
      firstReadyRoute = target.route;
    }
    if (probe.status === 'would-hold') {
      wouldHoldRoutes.push(target.route);
    }
  }

  return {
    probes,
    firstReadyRoute,
    wouldHoldRoutes,
  };
}

export type DaemonRelaySendInput = {
  /** Hosted route resolved by `resolveScope` in `src/daemon/routes.ts`. */
  route: HostedRoute;
  /** Validated `TeamFile` loaded by the daemon host for `route`. */
  team: TeamFile;
  /** Machine home directory (`<home>/.config/team/...`). */
  home: string;
  /**
   * The signed message record (`SignedRecord` or its serialized JSON string). In synthetic unit
   * tests that set `verifySignedRecord: false`, a raw record string may also be supplied alongside
   * explicit `id`, `to`, and `from`.
   */
  record: SignedRecord | string;
  /** Message ID (defaults to `record.payload.id` when `record` is a `SignedRecord`). */
  id?: string;
  /** Target seat name (defaults to `record.payload.to` when `record` is a `SignedRecord`). */
  to?: string;
  /** Sender seat name or `'owner'` (defaults to `record.payload.from` when `record` is a `SignedRecord`). */
  from?: string;
  /** Sending team identifier (defaults to `teamIdOf(route.root)`). */
  fromTeam?: string;
  /** Message body (defaults to `record.payload.body` when `record` is a `SignedRecord`). */
  body?: string;
  /** Optional pre-built newline-terminated socket frame for `route: 'socket'`. */
  frame?: string;
  /** Optional pre-built single-line pointer for `native` or `headless-resume`. */
  pointer?: string;
  /** Optional explicit cross-session socket path for `route: 'socket'`. */
  socketPath?: string | null;
  /** Optional runtime override for `route: 'socket'` in synthetic multi-route tests. */
  socketRuntime?: string;
  /** Optional explicit bound session / thread ID for `native` or `headless-resume`. */
  agentSession?: string | null;
  /** Optional remote app-server endpoint for Codex `native`. */
  remote?: string;
  /** Optional state folder (defaults to `dirname(teamFile)` or `<route.root>/.agents`). */
  stateDir?: string;
  /** Optional explicit path to `team.yaml`. */
  teamFile?: string;
  /** When `true`, walks only direct non-typing wake routes (`socket`, `headless-resume`). */
  directOnly?: boolean;
  /** Whether to include `'durable-copy'` as the terminal fallback when not `directOnly` (default `true`). */
  includeDurableCopyFallback?: boolean;
  /** Optional delivery-order chain override for synthetic route tests. */
  chain?: DeliveryChain;
  /** Optional explicit route order override for synthetic route tests. */
  routes?: readonly RuntimeRelayRoute[];
  /** Optional verified caller for starting a `FallbackWalk` episode (`beginFallbackWalk`). */
  caller?: Caller;
  /** Optional recipient registry agent ID for `FallbackWalk`. */
  toId?: string | null;
  /** Optional pre-created `FallbackWalk` episode. */
  fallbackWalk?: FallbackWalk;
  /**
   * Whether to verify `record` against the checkout's message key (`messageKeyState(home)` +
   * `verifyRecord`) and check its payload's `kind`, `root`, `session`, `to`, and `id` before
   * staging or probing. Defaults to `true` whenever `record` is a `SignedRecord` object or parses
   * as one and `verifySignedRecord` is not explicitly `false`.
   */
  verifySignedRecord?: boolean;
  /**
   * Optional grace window in ms to wait for a verified signed `<id>.read.json` receipt after a
   * live route delivers (`0` by default, which performs one immediate `receiptHeld` check).
   */
  receiptGraceMs?: number;
  /** Host clock. */
  now?: () => Date;
};

export type DaemonRelaySendDeps = {
  dial?: Dial;
  codexSpawn?: CodexSpawn;
  codexLiveProbe?: boolean | CodexThreadReadProbe;
  codexControlSocketPath?: string | null;
  headlessSpawn?: HeadlessResumeSpawn;
  sessionBinding?: RecordedSeatSessionRead;
  adapter?: RuntimePushAdapter;
  binary?: string;
  deliveryTimeout?:
    | DeliveryTimeoutInForce
    | Readonly<Partial<Record<DeliveryTimeoutRoute, number>>>
    | number;
  timeoutMs?: number;
  perRouteOptions?: Partial<Record<RuntimeRelayRoute, Partial<RuntimeRelayDeliverOptions>>>;
  resolveSocketPath?: (route: HostedRoute, seat: string) => string | null;
  projectOfTeam?: (teamId: string) => ProjectRecord | null;
  verifyReadReceipt?: (messageId: string) => boolean | Promise<boolean>;
};

export type DaemonRelaySendAnswer =
  | {
      ok: true;
      id: string;
      seat: string;
      cli: string;
      outcome: 'delivered' | 'read' | 'held';
      deliveredRoute: Exclude<RuntimeRelayRoute, 'durable-copy'> | null;
      readReceiptVerified: boolean;
      liveReceiptProven: false;
      broker: 'absent';
      plan: DaemonRelayRoutePlan;
      staged: RelayStage;
      receipt?: PackageRelayReceipt;
      reason?: string;
      attempts: readonly RuntimeRelayAttempt[];
      fallbackNotes: readonly FallbackNote[];
    }
  | {
      ok: false;
      code: DaemonRelayRefusalCode | 'daemon.route-stage';
      id: string | null;
      seat: string | null;
      outcome: 'refused';
      readReceiptVerified: false;
      liveReceiptProven: false;
      broker: 'absent';
      message: string;
      plan?: DaemonRelayRoutePlan;
      staged?: RelayStage;
      attempts: readonly RuntimeRelayAttempt[];
      fallbackNotes: readonly FallbackNote[];
    };

function parseSignedRecordInput(raw: SignedRecord | string): SignedRecord | null {
  if (typeof raw !== 'string') {
    return signedRecordOf(raw);
  }
  try {
    return signedRecordOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

function refuseSend(
  code: DaemonRelayRefusalCode | 'daemon.route-stage',
  message: string,
  fields: {
    id?: string | null;
    seat?: string | null;
    plan?: DaemonRelayRoutePlan;
    staged?: RelayStage;
    attempts?: readonly RuntimeRelayAttempt[];
    fallbackNotes?: readonly FallbackNote[];
  } = {},
): Extract<DaemonRelaySendAnswer, { ok: false }> {
  return {
    ok: false,
    code,
    id: fields.id ?? null,
    seat: fields.seat ?? null,
    outcome: 'refused',
    readReceiptVerified: false,
    liveReceiptProven: false,
    broker: 'absent',
    message,
    ...(fields.plan === undefined ? {} : { plan: fields.plan }),
    ...(fields.staged === undefined ? {} : { staged: fields.staged }),
    attempts: fields.attempts ?? [],
    fallbackNotes: fields.fallbackNotes ?? [],
  };
}

function defaultVerifyReadReceiptFor(
  plan: DaemonRelayRoutePlan,
  receiptGraceMs: number,
): (messageId: string) => boolean | Promise<boolean> {
  return (messageId: string) => {
    const context = {
      to: plan.seat,
      root: plan.route.root,
      session: plan.route.session,
    };
    const brief = claimBindingIn(plan.route.root, plan.route.session, plan.seat, messageId);
    if (receiptGraceMs > 0) {
      return awaitReceipt(plan.dropDir, messageId, context, plan.home, receiptGraceMs, brief);
    }
    return receiptHeld(plan.dropDir, messageId, context, plan.home, brief);
  };
}

function resolveSocketFrameFor(
  input: DaemonRelaySendInput,
  plan: DaemonRelayRoutePlan,
  id: string,
  from: string,
  fromTeam: string,
  body: string | undefined,
): string | undefined {
  if (input.frame !== undefined) return input.frame;
  if (body === undefined) return undefined;
  const reply = frameReplyFor(plan.home, plan.route.root, from, fromTeam);
  const replyLine = 'line' in reply ? reply.line : `team send ${from}@${fromTeam} "<reply>"`;
  return frameFor(body, id, replyLine);
}

/**
 * Executes a single route attempt for a `DaemonRelayRoutePlan`, handling an empty socket path on
 * `'socket'` as an `'unreachable'` attempt after staging the durable copy so the walk cleanly
 * falls through to the next route.
 */
export async function deliverDaemonRelayRoute(
  target: RuntimeRelayTarget,
  message: RuntimeRelayMessage,
  plan: DaemonRelayRoutePlan,
  options: RuntimeRelayDeliverOptions = {},
): Promise<RuntimeRelayAttempt> {
  const mergedOptions: RuntimeRelayDeliverOptions = {
    deliveryTimeout: plan.deliveryTimeout,
    ...(target.route === 'socket' ? { crossSessionInbound: plan.inbound } : {}),
    verifyReadReceipt: defaultVerifyReadReceiptFor(plan, 0),
    ...options,
  };

  if (target.route === 'socket' && target.socket.trim() === '') {
    const nowFn = mergedOptions.now ?? (() => new Date());
    const startedAt = mergedOptions.startedAt ?? nowFn().getTime();
    const liveRoutesRemain = mergedOptions.liveRoutesRemain ?? true;
    const probe = await probeDaemonRelayTarget(target, {
      crossSessionInbound: mergedOptions.crossSessionInbound ?? plan.inbound,
      id: message.id,
    });
    const at = nowFn();
    const reason =
      probe.status === 'ready'
        ? 'no cross-session socket was found for the receiving seat'
        : probe.reason;
    const wouldHold = probe.status === 'would-hold';
    const walkAttempt: WalkAttempt = {
      route: 'socket',
      outcome: 'unreachable',
      liveRoutesRemain,
      at,
      ms: Math.max(0, at.getTime() - startedAt),
      reason,
      receipt: { kind: 'stored', id: message.id },
    };
    return {
      route: 'socket',
      outcome: 'refused',
      adapterOutcome: probe.status === 'unsupported' ? 'unsupported' : 'unreachable',
      readReceiptVerified: false,
      reason,
      ...(wouldHold ? { wouldHold: true } : {}),
      receipt: {
        copy: join(target.copy.dir, target.copy.name),
        at: at.toISOString(),
      },
      walkAttempt,
    };
  }

  return deliverRuntimeRelayRoute(target, message, mergedOptions);
}

/**
 * Serves one route-bound relay send against a hosted checkout (`HostedRoute` + `TeamFile`).
 *
 * Call boundary for the machine daemon (`src/daemon/host.ts`):
 *   1. Host resolves the request scope via `resolveScope(routes, scope)` and loads `TeamFile`.
 *   2. Host verifies its caller / principal (or passes a signed `SignedRecord` with
 *      `verifySignedRecord: true`) and invokes `handleDaemonRelaySend(input, deps)`.
 *   3. `handleDaemonRelaySend` validates route/team/record agreement, selects candidate relay
 *      routes (`selectDaemonRelayRoutes`), stages the durable copy once under `id`, walks the
 *      routes via `walkRuntimeRelayRoutes` (`deliverRuntimeRelayRoute` + `probeRuntimeRelayRoute`),
 *      records each attempt in `FallbackWalk`, and returns a typed `DaemonRelaySendAnswer` with
 *      `broker: 'absent'` and `liveReceiptProven: false`.
 */
export async function handleDaemonRelaySend(
  input: DaemonRelaySendInput,
  deps: DaemonRelaySendDeps = {},
): Promise<DaemonRelaySendAnswer> {
  const nowFn = input.now ?? (() => new Date());
  const now = nowFn();

  if (input.team.project !== input.route.team || input.team.session !== input.route.session) {
    return refuseSend(
      'daemon.route-file',
      'the hosted route and its team file disagree; nothing was routed',
      { id: input.id ?? null, seat: input.to ?? null },
    );
  }

  const parsedRecord = parseSignedRecordInput(input.record);
  const mustVerify =
    input.verifySignedRecord === true
    || (input.verifySignedRecord !== false && typeof input.record !== 'string');

  if (mustVerify) {
    if (parsedRecord === null) {
      return refuseSend(
        'daemon.route-record',
        'the message record is not a well-formed signed record; nothing was routed',
        { id: input.id ?? null, seat: input.to ?? null },
      );
    }
    const keyState = messageKeyState(input.home);
    if (keyState.kind !== 'key' || !verifyRecord(parsedRecord, keyState.key)) {
      return refuseSend(
        'daemon.route-record',
        'the message record signature did not verify against this machine key; nothing was routed',
        { id: parsedRecord.payload.id, seat: parsedRecord.payload.to },
      );
    }
  }

  if (parsedRecord !== null && input.verifySignedRecord !== false) {
    if (parsedRecord.payload.kind !== RECORD_KIND) {
      return refuseSend(
        'daemon.route-record',
        'the signed record is not a message record; nothing was routed',
        { id: parsedRecord.payload.id, seat: parsedRecord.payload.to },
      );
    }
    const recordCanonicalRoot =
      canonicalRoot(parsedRecord.payload.root) ?? parsedRecord.payload.root;
    if (recordCanonicalRoot !== input.route.root) {
      return refuseSend(
        'daemon.route-record',
        `the signed record root "${parsedRecord.payload.root}" does not match the hosted route "${input.route.root}"`,
        { id: parsedRecord.payload.id, seat: parsedRecord.payload.to },
      );
    }
    if (parsedRecord.payload.session !== input.route.session) {
      return refuseSend(
        'daemon.route-record',
        `the signed record session "${parsedRecord.payload.session}" does not match the hosted route session "${input.route.session}"`,
        { id: parsedRecord.payload.id, seat: parsedRecord.payload.to },
      );
    }
    if (input.to !== undefined && input.to !== parsedRecord.payload.to) {
      return refuseSend(
        'daemon.route-record',
        `the target seat "${input.to}" does not match the signed record recipient "${parsedRecord.payload.to}"`,
        { id: parsedRecord.payload.id, seat: input.to },
      );
    }
    if (input.id !== undefined && input.id !== parsedRecord.payload.id) {
      return refuseSend(
        'daemon.route-record',
        `the message id "${input.id}" does not match the signed record id "${parsedRecord.payload.id}"`,
        { id: input.id, seat: parsedRecord.payload.to },
      );
    }
  }

  const id = input.id ?? parsedRecord?.payload.id ?? '';
  const seat = input.to ?? parsedRecord?.payload.to ?? '';
  const from = input.from ?? parsedRecord?.payload.from ?? '';
  const body = input.body ?? parsedRecord?.payload.body;
  const fromTeam = input.fromTeam ?? teamIdOf(input.route.root);

  if (id.trim() === '' || seat.trim() === '' || from.trim() === '') {
    return refuseSend(
      'daemon.route-record',
      'the send request requires a non-empty message id, sender, and recipient seat',
      { id: id || null, seat: seat || null },
    );
  }

  const recordText =
    typeof input.record === 'string'
      ? input.record
      : `${JSON.stringify(input.record, null, 2)}\n`;

  const selection = selectDaemonRelayRoutes(
    {
      route: input.route,
      team: input.team,
      seat,
      from,
      fromTeam,
      home: input.home,
      ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
      ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
      now,
      ...(input.directOnly === undefined ? {} : { directOnly: input.directOnly }),
      ...(input.includeDurableCopyFallback === undefined
        ? {}
        : { includeDurableCopyFallback: input.includeDurableCopyFallback }),
      ...(input.chain === undefined ? {} : { chain: input.chain }),
    },
    {
      ...(deps.projectOfTeam === undefined ? {} : { projectOfTeam: deps.projectOfTeam }),
    },
  );

  if (!selection.ok) {
    return refuseSend(selection.code, selection.message, { id, seat });
  }

  const { plan } = selection;
  const routesToWalk = input.routes ?? plan.selectedRoutes;
  if (routesToWalk.length === 0) {
    const skipSummary =
      plan.skippedLegs.length > 0
        ? ` (${plan.skippedLegs.map((entry) => `${entry.leg}: ${entry.reason}`).join('; ')})`
        : '';
    return refuseSend(
      'daemon.route-empty',
      `${seat}: no relay delivery routes remain for this recipient${skipSummary}`,
      { id, seat, plan },
    );
  }

  const sender: PushSender = { seat: from, team: fromTeam };
  const targets = buildDaemonRelayTargets(
    {
      plan,
      messageId: id,
      sender,
      routes: routesToWalk,
      ...(input.socketPath === undefined ? {} : { socketPath: input.socketPath }),
      ...(input.socketRuntime === undefined ? {} : { socketRuntime: input.socketRuntime }),
      ...(input.agentSession === undefined ? {} : { agentSession: input.agentSession }),
      ...(input.remote === undefined ? {} : { remote: input.remote }),
    },
    {
      ...(deps.resolveSocketPath === undefined
        ? {}
        : { resolveSocketPath: deps.resolveSocketPath }),
    },
  );

  const frame = resolveSocketFrameFor(input, plan, id, from, fromTeam, body);
  const message: RuntimeRelayMessage = {
    id,
    record: recordText,
    ...(frame === undefined ? {} : { frame }),
    ...(input.pointer === undefined ? {} : { pointer: input.pointer }),
  };

  const fallbackWalk: FallbackWalk | undefined =
    input.fallbackWalk
    ?? (input.caller !== undefined
      ? beginFallbackWalk({
          caller: input.caller,
          team: input.team,
          root: plan.route.root,
          home: plan.home,
          now: nowFn,
          recipient: {
            team: plan.route.team,
            seat: plan.seat,
            toId: input.toId ?? parsedRecord?.payload.to_id ?? null,
            session: plan.route.session,
            root: plan.route.root,
          },
          messageId: id,
          record: recordText,
        })
      : undefined);

  const verifyReadReceipt =
    deps.verifyReadReceipt ?? defaultVerifyReadReceiptFor(plan, input.receiptGraceMs ?? 0);

  const perRouteOptions: Partial<Record<RuntimeRelayRoute, Partial<RuntimeRelayDeliverOptions>>> = {
    ...deps.perRouteOptions,
  };
  if (deps.codexSpawn !== undefined) {
    perRouteOptions.native = {
      spawn: deps.codexSpawn as unknown as HeadlessResumeSpawn,
      ...perRouteOptions.native,
    };
  }
  if (deps.headlessSpawn !== undefined) {
    perRouteOptions['headless-resume'] = {
      spawn: deps.headlessSpawn,
      ...perRouteOptions['headless-resume'],
    };
  }

  const walkResult = await walkRuntimeRelayRoutes({
    routes: targets,
    message,
    ...(fallbackWalk === undefined ? {} : { fallbackWalk }),
    options: {
      now: nowFn,
      deliveryTimeout: deps.deliveryTimeout ?? plan.deliveryTimeout,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      crossSessionInbound: plan.inbound,
      ...(deps.dial === undefined ? {} : { dial: deps.dial }),
      ...(deps.codexLiveProbe === undefined ? {} : { liveProbe: deps.codexLiveProbe }),
      ...(deps.codexControlSocketPath === undefined
        ? {}
        : { socketPath: deps.codexControlSocketPath }),
      ...(deps.sessionBinding === undefined ? {} : { sessionBinding: deps.sessionBinding }),
      ...(deps.adapter === undefined ? {} : { adapter: deps.adapter }),
      ...(deps.binary === undefined ? {} : { binary: deps.binary }),
      verifyReadReceipt,
      perRouteOptions,
    },
  });

  if (walkResult.outcome === 'refused') {
    return refuseSend(
      'daemon.route-stage',
      walkResult.reason ?? 'the message record could not be staged',
      {
        id,
        seat,
        plan,
        staged: walkResult.staged,
        attempts: walkResult.attempts,
        fallbackNotes: walkResult.fallbackNotes,
      },
    );
  }

  return {
    ok: true,
    id,
    seat,
    cli: plan.cli,
    outcome: walkResult.outcome,
    deliveredRoute: walkResult.deliveredRoute,
    readReceiptVerified: walkResult.readReceiptVerified,
    liveReceiptProven: false,
    broker: 'absent',
    plan,
    staged: walkResult.staged,
    ...(walkResult.receipt === undefined ? {} : { receipt: walkResult.receipt }),
    ...(walkResult.reason === undefined ? {} : { reason: walkResult.reason }),
    attempts: walkResult.attempts,
    fallbackNotes: walkResult.fallbackNotes,
  };
}
