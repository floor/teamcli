import { NO_PANE_MESSAGING } from '../send/no-pane-messaging.ts';
// Expiring unconfirmed native handoffs past the 10-minute confirmation window, and walking the
// remaining legs in the recipient seat's `delivery_order`.
//
// `team send` to a Claude Code seat from a Claude Code sender writes a pending native record and
// prints the exact target, body and `team send --confirm <id>` line. When the sender never
// confirms within `PENDING_NATIVE_CONFIRM_WINDOW_MS` (10 minutes), `team watch` claims the
// pending record atomically (`takePending`) — so a late `--confirm` is refused with `no pending
// native record holds that id` and never causes a second delivery — records `native: unconfirmed
// after 10m` in `failed`, and walks the remaining legs in the recipient's `delivery_order`:
// - for a `drop` leg (such as a human-pane seat with `delivery_order: [native, drop]`): writes the
//   0600 drop file in `.agents/send-drops/<session>/<seat>/<id>` with zero pane writes, and
//   appends one history line (`outcome: 'delivered'`, `via: 'drop'`, `failed`); a seat the file
//   marks `human` walks this leg alone, whatever its fallback holds: every kept-out leg (`mcp-inbox`,
//   `typed`) is recorded in `failed` with the same human reason the send gives;
// - for `mcp-inbox`: the retired name, replayed only from a record an older build wrote (the
//   MCP inbox is the store's reader and a push from an MCP server is not a wake): the pass
//   records `mcp-inbox: no longer a leg` and continues to the next leg;
// - for `typed`: writes the 0600 drop file, delivers the trigger when the seat is free (or marks
//   the drop pending for `retryHeldDrops`), and appends the history line.
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import { claimBindingIn, receiptHeld } from '../mcp/inbox.ts';
import type { PaneProcesses } from '../herdr.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { isBareShellPane } from '../send/daemon.ts';
import { deliverTrigger, TRIGGER_TAKEN_NOTE, type DeliverHost } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { readTriggerLine } from '../send/native.ts';
import { ensureRecord, signRecord, type RecordPayload } from '../send/record.ts';
import { wakeTrigger } from '../send/wake.ts';
import {
  dropTaken,
  listPendingNative,
  markPending,
  PENDING_NATIVE_CONFIRM_WINDOW_MS,
  restoreTaken,
  takePending,
  type PendingNative,
  type PendingNativeFallbackLeg,
} from '../send/pending.ts';
import { markTaken } from '../send/taken.ts';
import { readState } from '../state.ts';
import type { RetryScene } from './retry.ts';
import { readScreen } from './screen.ts';

const NATIVE_UNCONFIRMED_10M = 'native: unconfirmed after 10m';

/** The reason the watch gives for a pending record an older build wrote that still names the
 *  retired `mcp-inbox` word: the record replays its real legs (`typed`, `drop`), and this line
 *  says why the name was not one of them. No record this build writes carries the word. */
const RETIRED_INBOX_LEG = "no longer a leg; the inbox is the store's reader";

function hostOf(scene: RetryScene, session: string): DeliverHost {
  return {
    typeText: (id, text) => scene.sources.typeText(id, text, session),
    pressEnter: (id) => scene.sources.pressEnter(id, session),
    status: (id) => scene.sources.status(id, session),
    wait: (ms) => scene.sources.sleep(ms),
    readAnsi: (id) => scene.sources.screen(id, session),
    ...(scene.sources.sendKey
      ? { sendKey: (id: string, key: string) => scene.sources.sendKey!(id, key, session) }
      : {}),
  };
}

function isHumanSeat(scene: RetryScene, home: string, record: PendingNative): boolean {
  if (record.root === scene.root) {
    return scene.team.seats.some((s) => s.name === record.to && s.human === true);
  }
  const loaded = readTeamConfig(record.root, { home });
  return loaded.ok && loaded.team.seats.some((s) => s.name === record.to && s.human === true);
}

function paneIdentityProblem(
  toDir: string,
  session: string,
  seatName: string,
  pane: string,
  procs: PaneProcesses | null,
): string | null {
  if (isBareShellPane(toDir, session, seatName, procs)) {
    return 'the seat is back at its shell; nothing was typed';
  }
  try {
    const state = readState(toDir);
    const seatState = state.sessions[session]?.seats[seatName];
    if (seatState?.pane !== undefined && seatState.pane !== pane) {
      return `the seat's recorded pane is ${seatState.pane}, not ${pane}; nothing was typed`;
    }
    if (seatState?.launched !== undefined && procs !== null && seatProcessVerdict(seatState.launched, procs) === 'replaced') {
      return 'the pane no longer holds the process team launched for this seat; nothing was typed';
    }
  } catch {}
  return null;
}

/**
 * The signed record a fallback leg transports, rebuilt from the handoff. The send wrote it under
 * this id before it handed off; one missing from the folder — a pending native record an older
 * build left — is written here, and an existing record is left untouched: it is the message, and
 * the handoff's own copy is the same message.
 */
function writeRecordFile(record: PendingNative, home: string): string {
  const dropsRoot = join(record.root, '.agents', 'send-drops');
  const sessionDir = join(dropsRoot, record.session);
  const dropDir = join(sessionDir, record.to);
  mkdirSync(dropDir, { recursive: true });
  chmodSync(dropsRoot, 0o700);
  chmodSync(sessionDir, 0o700);
  chmodSync(dropDir, 0o700);
  const payload: RecordPayload = {
    kind: 'message',
    id: record.id,
    to: record.to,
    to_id: record.to_id,
    root: record.root,
    session: record.session,
    at: record.ts,
    body: record.body,
    from: record.from,
    from_id: record.from_id,
    rule: record.rule,
    thread: record.thread ?? record.id,
  };
  const written = ensureRecord(dropDir, signRecord(payload, home));
  if (!written.ok) throw new Error(written.reason);
  return written.path;
}

async function expireOne(
  scene: RetryScene,
  home: string,
  record: PendingNative,
  noNudge: boolean,
): Promise<void> {
  // A held seat gets no fallback this pass: native presence proves a turn, a person wait or a
  // session end, or the projection cannot be trusted. Nothing is taken, so the record stays
  // pending for a later pass with the hold lifted.
  if (scene.nativeHeld?.has(record.to) === true) return;
  const taken = takePending(scene.team.project, scene.root, home, record.id);
  if (!taken.ok) return;

  // A new record names the cascade's legs; an `mcp-inbox` word only comes from a record an
  // older build wrote, and is named as retired below.
  const declaredLegs: readonly PendingNativeFallbackLeg[] = record.fallback ?? ['typed', 'drop'];
  // The bus inbox closes every expiry walk (src/send/no-pane-messaging.ts).
  const rawLegs: readonly PendingNativeFallbackLeg[] = declaredLegs.includes('drop') ? declaredLegs : [...declaredLegs, 'drop'];
  const human = isHumanSeat(scene, home, record);
  // A seat the file marks `human` is never typed into and is never handed an inbox message: the
  // expiry walks the drop leg alone, and `failed` records each kept-out leg with the human reason.
  const legs: readonly PendingNativeFallbackLeg[] = human ? ['drop'] : rawLegs;
  const failures: string[] = [NATIVE_UNCONFIRMED_10M];
  if (human) {
    for (const leg of rawLegs) {
      if (leg === 'mcp-inbox') {
        // No seat ever walked this name (ADR D1): the store's reader, never a spared pane leg.
        // Only a record an older build wrote names it.
        failures.push(`mcp-inbox: ${RETIRED_INBOX_LEG}`);
      } else if (leg === 'typed') {
        failures.push("typed: the pane is a human's, and nothing is typed into it");
      }
    }
  }
  const sentAs =
    record.spec !== undefined && record.resolved !== undefined
      ? { spec: record.spec, resolved: record.resolved }
      : {};
  const toDir = join(record.root, '.agents');
  const dropDir = join(toDir, 'send-drops', record.session, record.to);
  const elapsedMs = Math.max(0, scene.now.getTime() - Date.parse(record.ts));

  for (const leg of legs) {
    if (leg === 'mcp-inbox') {
      // The retired name, replayed only from a record an older build wrote: the MCP inbox is the
      // store's reader, and a push from an MCP server is not a wake. The pass records the word
      // and moves to the leg behind it.
      failures.push(`mcp-inbox: ${RETIRED_INBOX_LEG}`);
      continue;
    }

    if (leg === 'drop') {
      const lock = acquireSeatLock(toDir, record.session, record.to);
      if (!('release' in lock)) {
        restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
        return;
      }
      try {
        try {
          writeRecordFile(record, home);
        } catch {
          restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
          return;
        }
        // The marker names the drop leg, as the send's own drop leg writes it: the seat's
        // watcher promotes it on its receipt, and no retry pass ever types it. A human's drop
        // is read by a person, who writes no receipt, so no marker waits for one there.
        if (!human) {
          markPending(dropDir, {
            id: record.id,
            from: record.from,
            to: record.to,
            body: record.body,
            ts: scene.now.toISOString(),
            leg: 'drop',
          });
        }
        appendHistory(record.project, record.root, home, {
          ts: scene.now.toISOString(),
          from: record.from,
          to: record.to,
          ...sentAs,
          body: record.body,
          id: record.id,
          thread: record.thread ?? record.id,
          outcome: 'sent (unconfirmed)',
          ms: elapsedMs,
          via: 'drop',
          failed: [...failures],
        });
        dropTaken(taken.taken);
        scene.say(
          `${record.to}: a native handoff from ${record.from} was unconfirmed after 10m; sent (unconfirmed) (dropped ${String(record.body.length)} characters)`,
          false,
        );
        return;
      } finally {
        lock.release();
      }
    }

    if (leg === 'typed') {
      if (human) {
        failures.push("typed: the pane is a human's, and nothing is typed into it");
        continue;
      }
      // No pane messaging (src/send/no-pane-messaging.ts): the expiry types nothing; the walk goes
      // on to the bus inbox.
      if (NO_PANE_MESSAGING.length > 0) {
        failures.push(`typed: ${NO_PANE_MESSAGING}`);
        continue;
      }
      if (noNudge) {
        restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
        return;
      }
      const lock = acquireSeatLock(toDir, record.session, record.to);
      if (!('release' in lock)) {
        restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
        return;
      }
      try {
        const agents =
          record.session === scene.session
            ? scene.live.agents.filter((agent) => agent.name === record.to)
            : [{ name: record.to, pane: record.pane }];
        const rawPane = agents.length === 1 ? agents[0]?.pane : undefined;
        const pane = record.session === scene.session && rawPane === scene.ownPane ? undefined : rawPane;
        if (pane !== undefined) {
          const procs = scene.sources.processes?.(pane, record.session) ?? null;
          const identityProblem = paneIdentityProblem(toDir, record.session, record.to, pane, procs);
          if (identityProblem !== null) {
            appendHistory(record.project, record.root, home, {
              ts: scene.now.toISOString(),
              from: record.from,
              to: record.to,
              ...sentAs,
              body: record.body,
              id: record.id,
              thread: record.thread ?? record.id,
              outcome: 'unreachable',
              ms: elapsedMs,
              failed: [...failures],
            });
            dropTaken(taken.taken);
            scene.say(`${record.to}: ${identityProblem}`, true);
            return;
          }
        }
        let recordPath: string;
        try {
          recordPath = writeRecordFile(record, home);
        } catch {
          restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
          return;
        }
        // The wake names its sender and opens with the message's `message-display` header, from
        // the record just written and this home's registries. A sender that cannot be pinned is
        // not typed nameless: the record stays on disk and the message waits for the unread
        // report's words.
        const sender = wakeTrigger({ ...record, at: record.ts }, home, { root: scene.root, session: record.session, team: scene.team }, scene.now);
        const line = sender === null ? null : readTriggerLine(record.to, record.session, sender, record.cli);
        if (pane !== undefined && line !== null) {
          const status = scene.sources.status(pane, record.session);
          const screen = scene.sources.screen(pane, record.session);
          const kind = screen === null ? null : readScreen(record.cli, screen).kind;
          // Unsent text goes to the delivery below, which copies it beside the drop, clears the
          // box, delivers and pastes it back — or holds where this CLI has no measured way into
          // its box. A dialog is never typed into.
          const free =
            screen !== null &&
            (status === 'idle' || status === 'done') &&
            (kind === 'idle' || kind === 'unsent');
          if (free) {
            const receipt = (): boolean => receiptHeld(dropDir, record.id, { to: record.to, root: record.root, session: record.session }, home, claimBindingIn(record.root, record.session, record.to, record.id));
            const result = await deliverTrigger(hostOf(scene, record.session), pane, line, record.cli, { receipt, dropPath: recordPath });
            if (result.outcome === 'delivered') {
              // The fallback's trigger is the seat's own receipt-writing read. A receipt that
              // landed inside the window — or just after its last poll — is the read itself.
              if (result.evidence === 'receipt' || receipt()) {
                appendHistory(record.project, record.root, home, {
                  ts: scene.now.toISOString(),
                  from: record.from,
                  to: record.to,
                  ...sentAs,
                  body: record.body,
                  id: record.id,
                  thread: record.thread ?? record.id,
                  outcome: 'delivered (read)',
                  ms: elapsedMs,
                  via: 'typed',
                  failed: [...failures],
                });
                dropTaken(taken.taken);
                scene.say(
                  `${record.to}: a native handoff from ${record.from} was unconfirmed after 10m; read on fallback (receipt)`,
                  false,
                );
                return;
              }
              const isTaken = result.evidence === 'taken';
              if (isTaken) {
                markTaken(dropDir, {
                  id: record.id,
                  from: record.from,
                  to: record.to,
                  body: record.body,
                  ts: scene.now.toISOString(),
                  before: result.prior ?? 'unknown',
                });
              }
              appendHistory(record.project, record.root, home, {
                ts: scene.now.toISOString(),
                from: record.from,
                to: record.to,
                ...sentAs,
                body: record.body,
                id: record.id,
                thread: record.thread ?? record.id,
                outcome: 'sent (unconfirmed)',
                note: TRIGGER_TAKEN_NOTE,
                ms: elapsedMs,
                via: 'typed',
                failed: [...failures],
              });
              dropTaken(taken.taken);
              scene.say(
                `${record.to}: a native handoff from ${record.from} was unconfirmed after 10m; sent on fallback (${TRIGGER_TAKEN_NOTE})`,
                false,
              );
              return;
            }
            markPending(dropDir, {
              id: record.id,
              from: record.from,
              to: record.to,
              body: record.body,
              ts: scene.now.toISOString(),
            });
            appendHistory(record.project, record.root, home, {
              ts: scene.now.toISOString(),
              from: record.from,
              to: record.to,
              ...sentAs,
              body: record.body,
              id: record.id,
              thread: record.thread ?? record.id,
              outcome: result.outcome,
              ms: elapsedMs,
              failed: [...failures],
            });
            dropTaken(taken.taken);
            return;
          }
          markPending(dropDir, {
            id: record.id,
            from: record.from,
            to: record.to,
            body: record.body,
            ts: scene.now.toISOString(),
          });
          appendHistory(record.project, record.root, home, {
            ts: scene.now.toISOString(),
            from: record.from,
            to: record.to,
            ...sentAs,
            body: record.body,
            id: record.id,
            thread: record.thread ?? record.id,
            outcome: 'held',
            ms: elapsedMs,
            failed: [...failures],
          });
          dropTaken(taken.taken);
          return;
        }
        markPending(dropDir, {
          id: record.id,
          from: record.from,
          to: record.to,
          body: record.body,
          ts: scene.now.toISOString(),
        });
        appendHistory(record.project, record.root, home, {
          ts: scene.now.toISOString(),
          from: record.from,
          to: record.to,
          ...sentAs,
          body: record.body,
          id: record.id,
          thread: record.thread ?? record.id,
          outcome: 'unreachable',
          ms: elapsedMs,
          failed: [...failures],
        });
        dropTaken(taken.taken);
        return;
      } finally {
        lock.release();
      }
    }
  }

  appendHistory(record.project, record.root, home, {
    ts: scene.now.toISOString(),
    from: record.from,
    to: record.to,
    ...sentAs,
    body: record.body,
    id: record.id,
    thread: record.thread ?? record.id,
    outcome: 'unreachable',
    ms: elapsedMs,
    failed: [...failures],
  });
  dropTaken(taken.taken);
}

/**
 * Expires any pending native handoff in this project's store whose timestamp is strictly older
 * than `PENDING_NATIVE_CONFIRM_WINDOW_MS` (10 minutes), walking the remaining legs in the
 * recipient seat's `delivery_order`. Handoffs still inside the 10-minute window are left alone.
 */
export async function expirePendingNative(
  scene: RetryScene,
  options: { noNudge?: boolean } = {},
): Promise<void> {
  if (scene.home === undefined) return;
  const records = listPendingNative(scene.team.project, scene.root, scene.home);
  if (records.length === 0) return;
  const nowMs = scene.now.getTime();
  for (const record of records) {
    const recordedAt = Date.parse(record.ts);
    if (!Number.isFinite(recordedAt) || nowMs - recordedAt <= PENDING_NATIVE_CONFIRM_WINDOW_MS) {
      continue;
    }
    await expireOne(scene, scene.home, record, options.noNudge === true);
  }
}
