// The one delivery a client grant admits: a normal signed drop to the entity's orchestrator seat.
// Nothing here reads caller placement, so a terminal can never make the run the owner. The grant
// is re-read under the grant lock immediately before the request id is claimed and the record is
// written, so a revocation appended at that moment is seen, not raced past.
//
// The drop is signed with the checkout's message key like every other record and carries the
// client principal as `from_client`; `from` names the client (`client:<id>`) and `from_id` is
// null because the registry holds no agent for it.
//
// Writing the drop is this module's whole effect. The send command then hands the same signed
// payload to its own walk, through `ClientSendDelivery`, which resolves the coordinator seat's
// order and tries the channel, socket and typed legs under their usual pane-safety checks. That
// walk is injected so this module still reads no pane, holds no seat lock and types nothing: a
// client invocation with no delivery callback (the tests that exercise the record alone) writes
// the drop and stops.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logLine } from '../log.ts';
import type { Args } from '../args.ts';
import type { Io } from '../io.ts';
import type { SendHost } from '../commands/send.ts';
import { ensureRecord, signRecord, type RecordPayload } from '../send/record.ts';
import { claimClientRequest } from './replay.ts';
import { sendWithBundle } from './bundles.ts';
import { clientPaneGuard } from './pane-guard.ts';
import {
  claimsBundleGrantFile,
  clientAddressOf,
  clientAdmission,
  KEY_ISOLATION_LINE,
  activeClientGrant,
  readClientGrantFile,
  resolveEntityCoordinator,
  withClientGrantLock,
  type ClientGrantRecord,
} from './records.ts';
import { verifyClientRequest, type ClientRequest } from './verify.ts';

/** The seat a client grant addresses when the team file's `clients:` names none: the grant's
 *  signed seat is the one it addresses, checked against that list at every use. */
export const CLIENT_DESTINATION_SEAT = 'orchestrator';

/** The rule line every client drop carries: one sentence, the same on every record. */
export const CLIENT_RULE = 'a client grant, to the entity orchestrator';

/** The values the client slice takes, and the only ones: its grant, its key, its request id, its file. */
const CLIENT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['client', 'key', 'request-id', 'file']);

/** The one switch the client slice takes. */
const CLIENT_FLAG_OPTIONS: ReadonlySet<string> = new Set(['json']);

export type ResolvedClientTarget = {
  /** The entity name, as the grant and the address spell it. */
  entity: string;
  recipientId: string;
  recipientSeat: string;
  teamId: string;
  teamRoot: string;
  session: string;
  dropDir: string;
};

/**
 * The walk the send command injects after a drop is written: the same signed payload, carried
 * through the coordinator seat's own order. It is asynchronous because every leg is; its
 * outcome is the receiving team's record, never a client refusal — the drop is already durable,
 * so a leg that cannot take the send leaves the message where the seat reads it.
 */
export type ClientSendDelivery = (sent: {
  record: RecordPayload;
  target: ResolvedClientTarget;
}) => Promise<void>;

/**
 * Resolves `orchestrator@floor` to the entity coordinator the grant signs. The address is
 * compared to the one admitted form, never parsed into a broader destination; the registry read
 * must still return the same coordinator team and registered agent id that the signed grant
 * names. Anything else is refused here.
 */
export function resolveClientTarget(
  home: string,
  address: string,
  grant: ClientGrantRecord,
): { ok: true; target: ResolvedClientTarget } | { ok: false; why: string } {
  const admitted = clientAddressOf(grant);
  if (address.trim().toLowerCase() !== admitted) {
    return { ok: false, why: `a client grant addresses only ${admitted}, not "${address}"` };
  }
  const admission = clientAdmission(home, grant.clientId, grant.entity);
  if (!admission.ok) return { ok: false, why: `the grant ${grant.grantId} is not admitted: ${admission.why}` };
  const resolved = resolveEntityCoordinator(home, grant.entity, { seat: grant.recipientSeat, clientId: grant.clientId, ...(grant.team !== undefined ? { team: grant.team } : {}) });
  if (!resolved.ok) return resolved;
  const coordinator = resolved.coordinator;
  if (
    coordinator.teamId !== grant.teamId ||
    coordinator.recipientId !== grant.recipientId ||
    coordinator.recipientSeat !== grant.recipientSeat
  ) {
    return {
      ok: false,
      why: `the registry no longer names the coordinator and recipient the grant ${grant.grantId} signs`,
    };
  }
  return {
    ok: true,
    target: {
      entity: coordinator.entity,
      recipientId: coordinator.recipientId,
      recipientSeat: coordinator.recipientSeat,
      teamId: coordinator.teamId,
      teamRoot: coordinator.teamRoot,
      session: coordinator.session,
      dropDir: join(coordinator.teamRoot, '.agents', 'send-drops', coordinator.session, coordinator.recipientSeat),
    },
  };
}

/**
 * Writes the client's drop: one signed message record in the orchestrator's drop folder, never
 * over a record already at the id. The caller holds the grant lock and has claimed the request id.
 */
export function writeClientDrop(input: {
  home: string;
  grant: { clientId: string; grantId: string };
  request?: ClientRequest;
  target: ResolvedClientTarget;
  body: string;
  now: Date;
  id?: string;
  /** The rule line the record carries; the one-seat client send's own when absent. */
  rule?: string;
}): { ok: true; path: string; id: string; recipientId: string; record: RecordPayload } | { ok: false; why: string } {
  const id = input.id ?? randomUUID();
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: input.target.recipientSeat,
    to_id: input.target.recipientId,
    root: input.target.teamRoot,
    session: input.target.session,
    at: input.now.toISOString(),
    body: input.body,
    from: `client:${input.grant.clientId}`,
    from_id: null,
    rule: input.rule ?? CLIENT_RULE,
    thread: id,
    from_client: { client_id: input.grant.clientId, grant_id: input.grant.grantId },
  };
  let signed;
  try {
    signed = signRecord(payload, input.home);
  } catch {
    return { ok: false, why: 'the drop could not be signed with the checkout message key' };
  }
  const written = ensureRecord(input.target.dropDir, signed);
  if (!written.ok) return { ok: false, why: written.reason };
  return { ok: true, path: written.path, id, recipientId: input.target.recipientId, record: payload };
}

/**
 * `team send --client <grant-file> --key <key-file> orchestrator@<entity> [--request-id <id>] <text>`.
 * Always prints the key-isolation line once, first, on stderr. The signed drop is written here,
 * and the injected `deliver` then carries that same payload through the coordinator seat's
 * channel, socket and typed legs. Exit 0 on a written drop (whatever the walk's outcome), 1 on a
 * refusal, 2 on an invocation that cannot be read.
 */
export async function runClientSend(
  args: Args,
  io: Io,
  host: SendHost,
  json: boolean,
  deliver?: ClientSendDelivery,
): Promise<number> {
  // The declared limitation goes out exactly once per client invocation, before any outcome; the
  // JSON documents carry the same line in `key_isolation`, so no reader sees one form without it.
  io.stderr(`${KEY_ISOLATION_LINE}\n`);
  const document = (body: Record<string, unknown>): string =>
    JSON.stringify({ ...body, key_isolation: KEY_ISOLATION_LINE });
  const usage = (why: string): number => {
    if (json) io.stdout(`${document({ error: { code: 'send.client-usage', message: why } })}\n`);
    else io.stderr(`team send: ${why}\n`);
    // exit: send.client-usage
    return 2;
  };
  const refuse = (why: string): number => {
    if (json) io.stdout(`${document({ error: { code: 'send.client-refused', message: why } })}\n`);
    else io.stderr(`team send: refused: ${why}\n`);
    // exit: send.client-refused
    return 1;
  };

  // A closed slice, judged before any grant, key or registry read: an unsupported normal mode is
  // an invocation error, never a silently ignored option, so it can neither write a drop nor
  // claim a request id.
  if (args.error !== undefined) return usage(args.error);
  for (const flag of args.flags) {
    if (!CLIENT_FLAG_OPTIONS.has(flag)) return usage(`--${flag} is not supported with --client`);
  }
  for (const name of Object.keys(args.values)) {
    if (!CLIENT_VALUE_OPTIONS.has(name)) return usage(`--${name} is not supported with --client`);
  }

  const grantFile = args.values.client;
  const keyFile = args.values.key;
  if (grantFile === undefined) return usage('--client needs the grant file it signs with');
  if (keyFile === undefined) return usage('--client needs --key <key file>');
  const address = args.rest[0];
  if (address === undefined) return usage('a destination and a message are required');
  const words = args.rest.slice(1);
  const file = args.values.file;
  if (file !== undefined && words.length > 0) return usage('a message and --file cannot both be given');
  if (file === undefined && words.length === 0) return usage('a message or --file is required');
  let body = words.join(' ');
  if (file !== undefined) {
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      return refuse(`the message file "${file}" cannot be read`);
    }
  }
  if (body.trim() === '') return usage('a message is required');

  // The pane guard, judged before the grant or the key is opened: a caller inside a team pane
  // never signs as the client. Dev mode, the owner's switch, lifts it with a warning.
  const pane = clientPaneGuard(io, 'send', host.home);
  if (!pane.ok) {
    if (json) io.stdout(`${document({ error: { code: 'send.client-pane', message: pane.why } })}\n`);
    else io.stderr(`team send: refused: ${pane.why}\n`);
    // exit: send.client-pane
    return 1;
  }
  if (pane.warning !== undefined) io.stderr(`${pane.warning}\n`);

  let outcome:
    | {
      ok: true;
      path: string;
      id: string;
      recipientId: string;
      /** Absent for a bundle-grant send: that route keeps its own delivery and is not walked. */
      record?: RecordPayload;
      target?: ResolvedClientTarget;
      to: string;
      request: ClientRequest;
    }
    | { ok: false; why: string };
  // A bundle grant (vocabulary 5) that carries `send` is its own route: the address is
  // `<seat>@<team>` for a seat the owner's signed list names, and the whole check is the bundle's.
  if (claimsBundleGrantFile(grantFile)) {
    const sent = sendWithBundle(host, {
      grantFile,
      keyFile,
      cwd: io.cwd,
      address: address.trim(),
      body,
      ...(args.values['request-id'] !== undefined ? { requestId: args.values['request-id'] } : {}),
    });
    outcome = sent.ok
      ? { ok: true, path: '', id: sent.id, recipientId: '', to: sent.to, request: { request_id: sent.requestId } as ClientRequest }
      : sent;
  } else try {
    outcome = withClientGrantLock(
      host.home,
      () => {
        // The clock that judges expiry and stamps the claim and the drop is read here, inside the
        // lock and after any wait — never a date captured before it. The grant, the key, the
        // registry binding and the signed request's target are all re-read under this lock, so a
        // revocation or a rebinding that landed while the run waited is seen before the effect.
        const now = host.now();
        const presented = readClientGrantFile(host.home, grantFile);
        if (!presented.ok) return { ok: false as const, why: presented.why };
        const resolved = resolveClientTarget(host.home, address, presented.grant);
        if (!resolved.ok) return { ok: false as const, why: resolved.why };
        const verified = verifyClientRequest({
          home: host.home,
          grantFile,
          keyFile,
          body,
          target: resolved.target,
          now,
          requestId: args.values['request-id'],
        });
        if (!verified.ok) return { ok: false as const, why: verified.why };
        const active = activeClientGrant(host.home, presented, now);
        if (!active.ok) return { ok: false as const, why: active.why };
        const rebound = resolveClientTarget(host.home, clientAddressOf(active.grant), active.grant);
        if (!rebound.ok) return { ok: false as const, why: rebound.why };
        const request = verified.request;
        // The signed request names the grant and the coordinator it was signed for; the target
        // the drop would use must still be that same grant, team, seat and drop folder.
        if (
          request.grant_id !== active.grant.grantId ||
          request.entity !== rebound.target.entity ||
          request.recipient_id !== rebound.target.recipientId ||
          request.recipient_seat !== rebound.target.recipientSeat ||
          rebound.target.teamId !== resolved.target.teamId ||
          rebound.target.dropDir !== resolved.target.dropDir
        ) {
          return { ok: false as const, why: 'the coordinator binding changed before the drop; nothing was written' };
        }
        const claim = claimClientRequest(rebound.target.teamRoot, active.grant.clientId, request.request_id, now);
        if (!claim.ok) return { ok: false as const, why: claim.why };
        const written = writeClientDrop({
          home: host.home,
          grant: active.grant,
          request,
          target: rebound.target,
          body,
          now,
          id: host.sendId?.(),
        });
        if (!written.ok) return written;
        return {
          ...written,
          target: rebound.target,
          to: clientAddressOf(active.grant),
          request,
        };
      },
      host.clientLockWaitMs,
    );
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'the client grant lock could not be taken');
  }
  if (!outcome.ok) return refuse(outcome.why);

  // The drop is the message, and its confirmation is printed before the walk: a leg that is
  // slow, refused or held never changes what this invocation has already written.
  if (json) {
    io.stdout(
      `${document({ sent: { to: outcome.to, record: outcome.id, request_id: outcome.request.request_id } })}\n`,
    );
  } else {
    io.stdout(`sent: ${outcome.to} (drop ${outcome.id})\n`);
  }
  if (deliver !== undefined && outcome.record !== undefined && outcome.target !== undefined) {
    // A walk that throws has still left the signed drop, which is the message, so it is never a
    // client refusal. But it is never silent either: the reason goes to the receiving team's log
    // and one warning line goes to stderr, so a drop left unread can be traced to its walk.
    const logDir = join(outcome.target.teamRoot, '.agents');
    const seatName = outcome.target.recipientSeat;
    const from = outcome.record.from;
    try {
      await deliver({ record: outcome.record, target: outcome.target });
      logLine(logDir, 'send', from, `${seatName}: client delivery walk ended for drop ${outcome.id}`, host.now());
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      logLine(logDir, 'send', from, `${seatName}: client delivery walk failed for drop ${outcome.id} (${why}); the drop is written and waits to be read`, host.now());
      io.stderr(`team send: warning: the drop was written but its delivery walk failed (${why}); see the receiving team's team.log\n`);
    }
  }
  return 0; // exit: send.client-sent
}
