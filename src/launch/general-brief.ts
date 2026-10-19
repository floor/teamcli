// The general seat brief: what every seat of a team receives first, whatever its role or trade.
// The text is TeamCLI's built-in default, embedded in general-brief-text.ts the way the registered
// captures are — that module is generated from the accepted source by `scripts/brief.ts --write` —
// because the package ships dist/ only and must never read a documentation checkout at runtime.
// `team up` (and `add`, `restart`, `reload`) writes it into each seat's drop folder as a signed
// message record before the rules land, so it arrives through the drop leg and is never typed
// into a pane.
//
// Since the claims cut, a delivery is a claim plus a drop. The claim — the seat's delivery
// lifetime (`incarnation`), the runtime epoch a running reader is started with, the delivered
// brief's sha256 and the expected drop id — is written to the session's state (`briefs`) before
// any file, so the turn-start hook can always resolve the brief that is current and the read path
// can refuse an earlier one. The drop is then written at exactly the claim's expected id and read
// back; only a verified record finalizes the claim. Nothing here increments the attempt: a name
// held by a foreign file or a link is reported, and only `team brief rollout --apply` recovers it
// at the next attempt, leaving the foreign file byte for byte as it was.
import { join } from 'node:path';
import type { Io } from '../io.ts';
import { briefTransportOf } from '../policy/brief-transport.ts';
import { findAgent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { recordFile, recordHolds, readRecord, signRecord, writeRecord, type RecordPayload } from '../send/record.ts';
import { emptySession, readState, updateState, type BriefRecord, type SessionState } from '../state.ts';
import type { SendHost } from '../commands/send.ts';
import {
  briefIdOf,
  isBriefEpoch,
  isBriefId,
  isBriefIncarnation,
  mintBriefEpoch,
  mintBriefIncarnation,
  type BriefBinding,
} from './brief-id.ts';
import { heldAt } from './rules-file.ts';
import { GENERAL_BRIEF, GENERAL_BRIEF_SHA256 } from './general-brief-text.ts';

export { GENERAL_BRIEF, GENERAL_BRIEF_SHA256 };

/** The rule a launch record carries: the launch admits the record to every seat of its team. */
export const GENERAL_BRIEF_RULE = 'the launch delivers it to every seat of its team';

/** The sender a brief record names. It is not a seat and not the owner: a reply to the brief has
 *  no one to reach, and `team reply` says so rather than writing to a seat that does not exist. */
export const GENERAL_BRIEF_FROM = 'the launch';

const BRIEF_SHA256 = /^[0-9a-f]{64}$/;

/**
 * The brief's record id: a lowercase UUID derived from the incarnation and the delivered body, so
 * a repeated delivery of one lifetime keeps one id and a reworded brief is a new message under
 * the same lifetime. `attempt` is zero except for a recovery, whose id must not land on the name
 * the foreign file holds.
 */
export function generalBriefId(incarnation: string, deliveredBody: string, attempt = 0): string {
  return briefIdOf(incarnation, deliveredBody, attempt);
}

/** The body a seat reads: the sender header every drop carries, then the brief, then — for a seat
 *  this run replaced — the handover sentence the swap path wrote. */
export function generalBriefBody(handover?: string): string {
  const text = `from ${GENERAL_BRIEF_FROM} — admitted by: ${GENERAL_BRIEF_RULE}\n\n${GENERAL_BRIEF}`;
  if (handover === undefined || handover === '') return text;
  return `${text}\n${handover.trimEnd()}\n`;
}

/** The record the launch writes for one seat. `to_id` is the registry's `agt_` id when the seat
 *  has one — never the state's `seat_` handle — and `from_id` is null: the launch is not a
 *  registry seat. The delivered body's id is derived from the same body the record carries, and
 *  `brief_sha256` is the canonical brief's, so a handover variant is still this build's brief. */
export function generalBriefRecord(input: {
  to: string;
  root: string;
  session: string;
  at: string;
  incarnation: string;
  toId?: string | null;
  attempt?: number;
  handover?: string;
}): RecordPayload {
  const body = generalBriefBody(input.handover);
  const id = generalBriefId(input.incarnation, body, input.attempt ?? 0);
  return {
    kind: 'message',
    id,
    to: input.to,
    to_id: input.toId ?? null,
    root: input.root,
    session: input.session,
    at: input.at,
    body,
    from: GENERAL_BRIEF_FROM,
    from_id: null,
    rule: GENERAL_BRIEF_RULE,
    thread: id,
    brief_sha256: GENERAL_BRIEF_SHA256,
    incarnation: input.incarnation,
  };
}

/**
 * A claim this build can serve: every identity present and well-formed. A claim an older build
 * wrote has an id and a time and none of these; it is readable, and deliberately not current, so
 * no read serves it and the check names the seat until a delivery writes a current claim.
 */
export type CurrentBriefClaim = {
  id: string;
  at: string;
  incarnation: string;
  epoch: string;
  sha256: string;
  attempt: number;
  stage: 'claimed' | 'ready';
  seat_handle?: string;
  pane?: string;
  pane_root_pid?: number;
  superseded: readonly string[];
};

export function currentBriefClaim(claim: BriefRecord | undefined): CurrentBriefClaim | null {
  if (claim === undefined) return null;
  if (!isBriefId(claim.id)) return null;
  if (!isBriefIncarnation(claim.incarnation) || !isBriefEpoch(claim.epoch)) return null;
  if (typeof claim.sha256 !== 'string' || !BRIEF_SHA256.test(claim.sha256)) return null;
  return {
    id: claim.id,
    at: claim.at,
    incarnation: claim.incarnation,
    epoch: claim.epoch,
    sha256: claim.sha256,
    attempt: claim.attempt ?? 0,
    stage: claim.stage ?? 'claimed',
    ...(claim.seat_handle === undefined ? {} : { seat_handle: claim.seat_handle }),
    ...(claim.pane === undefined ? {} : { pane: claim.pane }),
    ...(claim.pane_root_pid === undefined ? {} : { pane_root_pid: claim.pane_root_pid }),
    superseded: claim.superseded ?? [],
  };
}

/** The three fields a record, a claim and a read receipt are compared on. */
export function briefBindingOf(claim: CurrentBriefClaim): BriefBinding {
  return { incarnation: claim.incarnation, sha256: claim.sha256, epoch: claim.epoch };
}

/**
 * The runtime epoch each seat's current claim names, by seat, for the launch lines a plan builds:
 * an inbox route that starts on the launch line names it, so the server serves only the delivery
 * this run wrote. A state file that cannot be read yields no epochs, and every reader binds the
 * claim it serves.
 */
export function currentBriefEpochs(dir: string, session: string): Record<string, string> {
  let claims: SessionState['briefs'];
  try {
    claims = readState(dir).sessions[session]?.briefs;
  } catch {
    return {};
  }
  const epochs: Record<string, string> = {};
  for (const [seat, claim] of Object.entries(claims ?? {})) {
    const current = currentBriefClaim(claim);
    if (current !== null) epochs[seat] = current.epoch;
  }
  return epochs;
}

export type BriefDelivery =
  | {
      seat: string;
      ok: true;
      id: string;
      at: string;
      incarnation: string;
      epoch: string;
      existing?: true;
      recoveredFrom?: string;
      /** Present when `brief-transport` is `message`: how the seat's own delivery walk ended. */
      message?: { via: string | null; walked: boolean; exit: number; text: string };
    }
  | { seat: string; ok: false; reason: string; blocked?: 'file' | 'nonfile' };

/** One planned `message` walk: the seat, its declared CLI, and the exact record the launch wrote.
 *  The walk reuses the send command's legs and never re-mints the record's identity. */
export type BriefWalkPlan = {
  seat: string;
  cli: string;
  project?: string;
  payload: RecordPayload;
};

export type BriefDeliveryReport = {
  deliveries: BriefDelivery[];
  /** Why the state could not be written for the whole run, when a write failed outside a seat. */
  recording?: string;
  /** Seats whose `brief-transport` is `message`, in delivery order. A launch runs them, once its
   *  claim and record stand, with `walkBriefDeliveries`. */
  walks?: BriefWalkPlan[];
};

/** The declared-seat fields this module needs; a validated team file is assignable. */
export type BriefSeat = { name: string; human?: boolean; cli?: string };

/** Why a `brief-transport: memory` delivery writes nothing: no runtime in this build can prove
 *  the whole path is memory-only. The refusal is the transport's whole behaviour — the brief is
 *  not delivered by a fallback, and no claim, record, drop, inbox entry or history line is made
 *  on either side. `<id>` and the other three fields of an outcome are all a memory run may ever
 *  keep; this build keeps none of them because no run is attempted. */
export const MEMORY_TRANSPORT_UNSUPPORTED =
  'brief-transport is memory, which no runtime in this build proves to be zero-persistence; nothing was written and there is no fallback';

/** Why a name cannot be used, or null when the kind is a regular file or missing. */
function heldReason(kind: ReturnType<typeof heldAt>['kind']): string | null {
  if (kind === 'missing' || kind === 'file') return null;
  if (kind === 'link') return 'a symbolic link was found and not followed';
  if (kind === 'fifo') return 'a FIFO was found and not followed';
  if (kind === 'folder') return 'the record path is a folder';
  return 'the record path is not a regular file';
}

/**
 * The low-level writer, called only by the boundary below and by the rollout's recovery: posts
 * the claim's expected record (the payload's id must be the claim's id), verifies what is on disk
 * and finalizes the claim at the record's own time. A name held by a foreign regular file or by a
 * link is reported and left untouched — this writer never replaces and never increments. All
 * writes are idempotent: a verified record already at the id is left as the delivery it is.
 */
export function deliverGeneralBrief(input: {
  dir: string;
  root: string;
  session: string;
  seat: string;
  home: string;
  claim: CurrentBriefClaim;
  toId?: string | null;
  handover?: string;
}): BriefDelivery {
  const { seat, claim } = input;
  const payload = generalBriefRecord({
    to: seat,
    root: input.root,
    session: input.session,
    at: claim.at,
    incarnation: claim.incarnation,
    toId: input.toId,
    attempt: claim.attempt,
    handover: input.handover,
  });
  if (payload.id !== claim.id) {
    return { seat, ok: false, reason: 'the claim and the record disagree on the expected id' };
  }
  const dropDir = join(input.root, '.agents', 'send-drops', input.session, seat);
  const path = recordFile(dropDir, payload.id);
  const held = heldAt(path);
  const refusal = heldReason(held.kind);
  if (refusal !== null) {
    return { seat, ok: false, reason: refusal, blocked: held.kind === 'file' ? 'file' : 'nonfile' };
  }
  let existing = false;
  if (held.kind === 'file') {
    if (!recordHolds(path, payload, input.home, { to_id: false })) {
      return { seat, ok: false, reason: `the name at ${payload.id} is not this brief's`, blocked: 'file' };
    }
    existing = true;
  } else {
    let signed;
    try {
      signed = signRecord(payload, input.home);
    } catch {
      return { seat, ok: false, reason: 'no message key; the general brief was not delivered' };
    }
    const written = writeRecord(dropDir, signed);
    if (!written.ok) return { seat, ok: false, reason: written.reason };
  }
  // Read back: the state records what the seat will read, never what this process meant to write.
  if (!recordHolds(path, payload, input.home, { to_id: false })) {
    return { seat, ok: false, reason: 'the record written for the brief does not verify' };
  }
  const read = readRecord(path, payload.id);
  if (!read.ok || read.record === null) {
    return { seat, ok: false, reason: read.ok ? 'the brief record disappeared' : read.reason };
  }
  const recordAt = read.record.payload.at;
  let won: boolean;
  try {
    won = updateState(input.dir, (state) => {
      const session = (state.sessions[input.session] ??= emptySession());
      const current = session.briefs?.[seat];
      // Another delivery replaced this claim while the drop was being written: its claim and its
      // drop are the ones that stand, and this run must not finalize over them.
      if (current === undefined || current.id !== payload.id) return false;
      current.at = recordAt;
      current.stage = 'ready';
      return true;
    });
  } catch {
    return { seat, ok: false, reason: 'the brief was written but the state could not record it' };
  }
  if (!won) return { seat, ok: false, reason: 'another delivery replaced this claim' };
  return {
    seat,
    ok: true,
    id: payload.id,
    at: recordAt,
    incarnation: claim.incarnation,
    epoch: claim.epoch,
    ...(existing ? { existing: true } : {}),
  };
}

/** One seat's claim write, under the state lock: fresh identities for an attributed seat, the
 *  existing ones for a broadcast target, and the id of the claim it replaces recorded the way a
 *  recovery records one. Returns what the drop writer posts. */
function writeClaim(input: {
  dir: string;
  session: string;
  seat: string;
  fresh: boolean;
  body: string;
  at: string;
  diagnostics: { seat_handle?: string; pane?: string; pane_root_pid?: number };
}): CurrentBriefClaim {
  return updateState(input.dir, (state) => {
    const session = (state.sessions[input.session] ??= emptySession());
    const previous = session.briefs?.[input.seat];
    const kept = input.fresh ? null : currentBriefClaim(previous);
    const incarnation = kept === null ? mintBriefIncarnation() : kept.incarnation;
    const epoch = kept === null ? mintBriefEpoch() : kept.epoch;
    const attempt = kept === null ? 0 : kept.attempt;
    const id = generalBriefId(incarnation, input.body, attempt);
    const earlier = new Set(kept === null ? [] : kept.superseded);
    if (previous !== undefined && previous.id !== id) earlier.add(previous.id);
    earlier.delete(id);
    const superseded = [...earlier].slice(-50);
    // A claim that still names this same record keeps the delivery's first time; a new record —
    // a fresh lifetime or a reworded body — is delivered now.
    const at = previous !== undefined && previous.id === id && kept !== null ? previous.at : input.at;
    session.briefs = {
      ...session.briefs,
      [input.seat]: {
        id,
        at,
        incarnation,
        epoch,
        sha256: GENERAL_BRIEF_SHA256,
        attempt,
        stage: 'claimed',
        ...(input.diagnostics.seat_handle === undefined ? {} : { seat_handle: input.diagnostics.seat_handle }),
        ...(input.diagnostics.pane === undefined ? {} : { pane: input.diagnostics.pane }),
        ...(input.diagnostics.pane_root_pid === undefined ? {} : { pane_root_pid: input.diagnostics.pane_root_pid }),
        ...(superseded.length === 0 ? {} : { superseded }),
      },
    };
    return currentBriefClaim(session.briefs[input.seat])!;
  });
}

/**
 * The one delivery entry every attribution path calls. It works out which seats this run must
 * deliver to — the seats it launched or adopted, plus the live and human declared seats when an
 * activation broadcasts or when this build is ahead of any seat's claim — writes each seat's
 * claim before its drop, posts the signed record at the claim's expected id, and reports per
 * seat. One seat's failure never stops another, and nothing here calls herdr or types into a
 * pane: a human seat is delivered to exactly like a CLI seat.
 */
export function deliverBriefForAttribution(input: {
  dir: string;
  root: string;
  session: string;
  home: string;
  now: Date;
  team: { seats: readonly BriefSeat[]; entity?: string | null; project?: string };
  state: SessionState;
  attributed: readonly string[];
  broadcast?: boolean;
  handover?: string;
}): BriefDeliveryReport {
  const attributed = new Set(input.attributed);
  const liveOrHuman = input.team.seats.filter(
    (seat) => input.state.seats[seat.name] !== undefined || seat.human === true,
  );
  const behind = liveOrHuman.some(
    (seat) => currentBriefClaim(input.state.briefs?.[seat.name])?.sha256 !== GENERAL_BRIEF_SHA256,
  );
  const names: string[] = [...attributed];
  if (input.broadcast === true || behind) {
    for (const seat of liveOrHuman) if (!attributed.has(seat.name)) names.push(seat.name);
  }
  const at = input.now.toISOString();
  const team = teamIdOf(input.root);
  const deliveries: BriefDelivery[] = [];
  const walks: BriefWalkPlan[] = [];
  // The transport the owner's chain resolves for this team, read once before any seat is
  // touched. A chain that cannot be read or verified resolves to `file` with its reason — the
  // launch goes on delivering — while `memory`, which no runtime in this build proves, refuses
  // every seat before a claim, a record or a drop is written.
  const reading = briefTransportOf({
    home: input.home,
    root: input.root,
    ...(input.team.entity === undefined || input.team.entity === null ? {} : { entity: input.team.entity }),
    now: input.now,
  });
  // Under `memory` no seat receives a brief, whatever this run's delivery set was: the callers
  // named in the team file are refused too, so a launch or a rollout never reports a seat as
  // served when nothing was written.
  const refused = reading.transport === 'memory'
    ? input.team.seats.map((seat) => seat.name).filter((name) => !names.includes(name))
    : [];
  for (const seat of [...names, ...refused]) {
    if (reading.transport === 'memory') {
      deliveries.push({ seat, ok: false, reason: MEMORY_TRANSPORT_UNSUPPORTED });
      continue;
    }
    const live = input.state.seats[seat];
    const handover = attributed.has(seat) ? input.handover : undefined;
    let claim: CurrentBriefClaim;
    try {
      claim = writeClaim({
        dir: input.dir,
        session: input.session,
        seat,
        fresh: attributed.has(seat),
        body: generalBriefBody(handover),
        at,
        diagnostics: {
          ...(live?.id === undefined ? {} : { seat_handle: live.id }),
          ...(live?.pane === undefined ? {} : { pane: live.pane }),
          ...(live?.launched?.shell === undefined ? {} : { pane_root_pid: live.launched.shell }),
        },
      });
    } catch (error) {
      deliveries.push({
        seat,
        ok: false,
        reason: `the delivery could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const toId = findAgent(input.home, { team, seat })?.id ?? null;
    const delivery = deliverGeneralBrief({
      dir: input.dir,
      root: input.root,
      session: input.session,
      seat,
      home: input.home,
      claim,
      toId,
      ...(handover === undefined ? {} : { handover }),
    });
    // The message transport is the same record and claim, walked: the seat's own delivery order
    // is attempted with the send command's legs once this launch's writes stand. The record is
    // rebuilt here only to hand the walk its exact payload, and only when its id is the one the
    // claim and the delivery agree on.
    if (delivery.ok && reading.transport === 'message') {
      const payload = generalBriefRecord({
        to: seat,
        root: input.root,
        session: input.session,
        at: claim.at,
        incarnation: claim.incarnation,
        toId,
        attempt: claim.attempt,
        ...(handover === undefined ? {} : { handover }),
      });
      if (payload.id !== delivery.id) {
        delivery.message = { via: null, walked: false, exit: 0, text: 'the record rebuilt for the walk does not match the delivered one; no leg was walked\n' };
      } else {
        const cli = input.team.seats.find((one) => one.name === seat)?.cli ?? '';
        walks.push({
          seat,
          cli,
          ...(input.team.project === undefined ? {} : { project: input.team.project }),
          payload,
        });
      }
    }
    deliveries.push(delivery);
  }
  return { deliveries, ...(walks.length === 0 ? {} : { walks }) };
}

/**
 * Runs the `message` walks a sync delivery planned, once the launch's claim and record stand.
 * Each walked seat's outcome rides on its delivery as `message`; a seat whose walk could not run
 * keeps its record — the drop leg's delivery — and reports why. One seat's failure never stops
 * another. The send command is imported lazily inside `walkMessageDelivery`: this launch module
 * is imported by the hook and MCP modules the send command itself imports, and a static import
 * would close that cycle.
 */
export async function walkBriefDeliveries(
  report: BriefDeliveryReport,
  input: { dir: string; home: string; io?: Io; sendHost?: SendHost },
): Promise<BriefDeliveryReport> {
  for (const plan of report.walks ?? []) {
    const delivery = report.deliveries.find((one) => one.ok && one.seat === plan.seat);
    if (delivery === undefined || !delivery.ok) continue;
    delivery.message = await walkMessageDelivery({
      dir: input.dir,
      root: plan.payload.root,
      session: plan.payload.session,
      seat: plan.seat,
      cli: plan.cli,
      home: input.home,
      payload: plan.payload,
      ...(plan.project === undefined ? {} : { project: plan.project }),
      ...(input.io === undefined ? {} : { io: input.io }),
      ...(input.sendHost === undefined ? {} : { sendHost: input.sendHost }),
    });
  }
  return report;
}

/**
 * Walks one delivered brief through the send command's legs. The walk's own lines are captured —
 * a launch's output is its own — and the release of the walk is the seat's delivery, not a
 * terminal. The host defaults to the real one with this run's home and its own advancing clock:
 * the walk probes herdr and waits on legs exactly as `team send` does.
 */
async function walkMessageDelivery(input: {
  dir: string;
  root: string;
  session: string;
  project?: string;
  seat: string;
  cli: string;
  home: string;
  payload: RecordPayload;
  io?: Io;
  sendHost?: SendHost;
}): Promise<{ via: string | null; walked: boolean; exit: number; text: string }> {
  const captured: string[] = [];
  const base: Io = input.io ?? { stdout: () => {}, stderr: () => {}, cwd: input.root, env: {}, stdinIsTTY: false };
  const sink: Io = {
    ...base,
    stdout: (text) => {
      captured.push(text);
    },
    stderr: (text) => {
      captured.push(text);
    },
  };
  const { realHost, walkBriefDelivery } = await import('../commands/send.ts');
  const host = input.sendHost ?? { ...realHost, home: input.home };
  const result = await walkBriefDelivery({
    io: sink,
    host,
    dir: input.dir,
    root: input.root,
    ...(input.project === undefined ? {} : { project: input.project }),
    session: input.session,
    seat: input.seat,
    cli: input.cli,
    payload: input.payload,
  });
  return { via: result.via, walked: result.walked, exit: result.exit, text: captured.join('') };
}

/**
 * The one recovery, called only by `team brief rollout --apply`: keep the lifetime and its epoch,
 * increment the attempt so the id cannot land on the held name, record the claim under the state
 * lock, and post the drop at the new id. The file at the old id is never read, written or
 * removed — it stays exactly as it was found.
 */
export function recoverBrief(input: {
  dir: string;
  root: string;
  session: string;
  seat: string;
  home: string;
  /** The team file's entity, when the caller holds it: the entity level of `brief-transport`. */
  entity?: string | null;
  claim: CurrentBriefClaim;
  toId?: string | null;
  handover?: string;
}): BriefDelivery {
  // A `memory` team recovers nothing on disk either: the recovery is still a claim, a record and
  // a drop, and the transport that forbids them for the delivery forbids them here too. The
  // refusal comes before the state lock and before any file, so no attempt is consumed.
  const reading = briefTransportOf({
    home: input.home,
    root: input.root,
    ...(input.entity === undefined || input.entity === null ? {} : { entity: input.entity }),
  });
  if (reading.transport === 'memory') {
    return { seat: input.seat, ok: false, reason: MEMORY_TRANSPORT_UNSUPPORTED };
  }
  const body = generalBriefBody(input.handover);
  let next: CurrentBriefClaim;
  try {
    next = updateState(input.dir, (state) => {
      const session = (state.sessions[input.session] ??= emptySession());
      const current = session.briefs?.[input.seat];
      if (current === undefined || current.id !== input.claim.id) {
        throw new Error('another delivery replaced this claim');
      }
      const attempt = (current.attempt ?? 0) + 1;
      const id = generalBriefId(input.claim.incarnation, body, attempt);
      const earlier = new Set(input.claim.superseded);
      earlier.add(input.claim.id);
      earlier.delete(id);
      session.briefs![input.seat] = {
        ...current,
        id,
        attempt,
        stage: 'claimed',
        superseded: [...earlier].slice(-50),
      };
      return currentBriefClaim(session.briefs![input.seat])!;
    });
  } catch (error) {
    return {
      seat: input.seat,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const delivery = deliverGeneralBrief({
    dir: input.dir,
    root: input.root,
    session: input.session,
    seat: input.seat,
    home: input.home,
    claim: next,
    toId: input.toId,
    ...(input.handover === undefined ? {} : { handover: input.handover }),
  });
  return delivery.ok ? { ...delivery, recoveredFrom: input.claim.id } : delivery;
}
