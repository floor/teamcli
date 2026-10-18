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
//   appends one history line (`outcome: 'delivered'`, `via: 'drop'`, `failed`);
// - for `mcp-inbox`: records `mcp-inbox: unavailable; this build carries no mcp-inbox leg` and
//   continues to the next leg;
// - for `typed`: writes the 0600 drop file, delivers the trigger when the seat is free (or marks
//   the drop pending for `retryHeldDrops`), and appends the history line.
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { deliverTrigger, TAKEN_REASON, type DeliverHost } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { dropMessage, triggerLine } from '../send/native.ts';
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
import type { RetryScene } from './retry.ts';
import { readScreen } from './screen.ts';

const MCP_INBOX_UNAVAILABLE = 'unavailable; this build carries no mcp-inbox leg';
const NATIVE_UNCONFIRMED_10M = 'native: unconfirmed after 10m';

function hostOf(scene: RetryScene): DeliverHost {
  return {
    typeText: (id, text) => scene.sources.typeText(id, text, scene.session),
    pressEnter: (id) => scene.sources.pressEnter(id, scene.session),
    status: (id) => scene.sources.status(id, scene.session),
    wait: (ms) => scene.sources.sleep(ms),
    readAnsi: (id) => scene.sources.screen(id, scene.session),
  };
}

function writeDropFile(toDir: string, session: string, seat: string, id: string, body: string): string {
  const dropsRoot = join(toDir, 'send-drops');
  const sessionDir = join(dropsRoot, session);
  const dropDir = join(sessionDir, seat);
  mkdirSync(dropDir, { recursive: true });
  chmodSync(dropsRoot, 0o700);
  chmodSync(sessionDir, 0o700);
  chmodSync(dropDir, 0o700);
  return dropMessage(dropDir, id, body);
}

async function expireOne(
  scene: RetryScene,
  home: string,
  record: PendingNative,
  noNudge: boolean,
): Promise<void> {
  const taken = takePending(scene.team.project, scene.root, home, record.id);
  if (!taken.ok) return;

  const legs: readonly PendingNativeFallbackLeg[] = record.fallback ?? ['mcp-inbox', 'typed'];
  const failures: string[] = [NATIVE_UNCONFIRMED_10M];
  const sentAs =
    record.spec !== undefined && record.resolved !== undefined
      ? { spec: record.spec, resolved: record.resolved }
      : {};
  const toDir = join(record.root, '.agents');
  const dropDir = join(toDir, 'send-drops', record.session, record.to);
  const elapsedMs = Math.max(0, scene.now.getTime() - Date.parse(record.ts));

  for (const leg of legs) {
    if (leg === 'mcp-inbox') {
      failures.push(`mcp-inbox: ${MCP_INBOX_UNAVAILABLE}`);
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
          writeDropFile(toDir, record.session, record.to, record.id, record.body);
        } catch {
          restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
          return;
        }
        appendHistory(record.project, record.root, home, {
          ts: scene.now.toISOString(),
          from: record.from,
          to: record.to,
          ...sentAs,
          body: record.body,
          id: record.id,
          outcome: 'delivered',
          ms: elapsedMs,
          via: 'drop',
          failed: [...failures],
        });
        dropTaken(taken.taken);
        scene.say(
          `${record.to}: a native handoff from ${record.from} was unconfirmed after 10m; delivered (dropped ${String(record.body.length)} characters)`,
          false,
        );
        return;
      } finally {
        lock.release();
      }
    }

    if (leg === 'typed') {
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
        let dropPath: string;
        try {
          dropPath = writeDropFile(toDir, record.session, record.to, record.id, record.body);
        } catch {
          restoreTaken(taken.taken, scene.team.project, scene.root, home, record.id);
          return;
        }
        const line = triggerLine(dropPath);
        const agents =
          record.session === scene.session
            ? scene.live.agents.filter((agent) => agent.name === record.to)
            : [{ name: record.to, pane: record.pane }];
        const pane = agents.length === 1 ? agents[0]?.pane : undefined;
        if (pane !== undefined && pane !== scene.ownPane && line !== null) {
          const status = scene.sources.status(pane, record.session);
          const screen = scene.sources.screen(pane, record.session);
          const free =
            screen !== null &&
            (status === 'idle' || status === 'done') &&
            readScreen(record.cli, screen).kind === 'idle';
          if (free) {
            const result = await deliverTrigger(hostOf(scene), pane, line, record.cli);
            if (result.outcome === 'delivered') {
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
                outcome: 'delivered',
                ms: elapsedMs,
                ...(isTaken ? { note: TAKEN_REASON } : {}),
                via: 'typed',
                failed: [...failures],
              });
              dropTaken(taken.taken);
              scene.say(
                `${record.to}: a native handoff from ${record.from} was unconfirmed after 10m; delivered on fallback`,
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
