// The race suite's product driver: one command per process against the committed run store, so a
// scene can put two store users on one root behind a file barrier and read both answers. The
// barrier and answer protocol are the fixtures' (`waitAtBarrier`, `reply`); this file only
// dispatches commands. Nothing here is product code: each command calls the same public surface
// the daemon will call.
//
// Run as: bun reservation-race-driver.ts <go> <ready> <command> <json-args>

import { reply, waitAtBarrier } from './reservation-race-fixtures.ts';
import { openRunStore, type RunStore } from '../../src/workflow/live/index.ts';
import {
  acknowledge,
  claimNext,
  expire,
  releaseReservation,
  reserve,
  type ItemIdentity,
} from '../../src/workflow/reservation/index.ts';

const [go, ready, command, rawArgs] = process.argv.slice(2);
if (go === undefined || ready === undefined || command === undefined) {
  reply({ ok: false, error: 'usage: <go> <ready> <command> <json-args>' });
  process.exit(2);
}

let args: Record<string, unknown> = {};
try {
  const parsed: unknown = JSON.parse(rawArgs ?? '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
} catch {
  reply({ ok: false, error: 'the arguments are not JSON' });
  process.exit(2);
}

waitAtBarrier(go, ready);

function text(name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Error(`the ${name} argument must be a string`);
  return value;
}

function instant(name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`the ${name} argument must be a number`);
  return value;
}

function itemArg(): ItemIdentity {
  const value = args.item;
  if (!value || typeof value !== 'object') throw new Error('the item argument must be an object');
  const item = value as Record<string, unknown>;
  for (const part of ['source', 'project', 'team', 'id']) {
    if (typeof item[part] !== 'string') throw new Error(`the item.${part} argument must be a string`);
  }
  return { source: item.source as string, project: item.project as string, team: item.team as string, id: item.id as string };
}

function store(): RunStore {
  return openRunStore({ root: text('root'), now: () => instant('now') });
}

function run(): unknown {
  switch (command) {
    case 'key': {
      const item = itemArg();
      return { key: store().keyText(item) };
    }
    case 'reserve': {
      const receiver = args.receiver;
      if (!receiver || typeof receiver !== 'object') throw new Error('the receiver argument must be an object');
      const seat = (receiver as Record<string, unknown>).seat;
      if (typeof seat !== 'string') throw new Error('the receiver.seat argument must be a string');
      const pane = (receiver as Record<string, unknown>).pane;
      return reserve(store(), {
        item: itemArg(),
        runId: text('runId'),
        attempt: instant('attempt'),
        thread: text('thread'),
        receiver: { seat, ...(typeof pane === 'string' ? { pane } : {}) },
        expiresAt: instant('expiresAt'),
        at: instant('at'),
      });
    }
    case 'ack':
      return acknowledge(store(), {
        item: itemArg(),
        runId: text('runId'),
        attempt: instant('attempt'),
        thread: text('thread'),
        seat: text('seat'),
        pane: text('pane'),
        messageId: text('messageId'),
        at: instant('at'),
      });
    case 'claim':
      return claimNext(store(), {
        item: itemArg(),
        seat: text('seat'),
        pane: text('pane'),
        now: instant('now'),
        expiresAt: instant('expiresAt'),
      });
    case 'expire':
      return expire(store(), instant('now'));
    case 'hold': {
      const opened = store();
      const item = itemArg();
      const key = opened.keyText(item);
      return { key, hold: key === null ? null : (opened.entry(key)?.hold ?? null) };
    }
    case 'recover':
      return store().recover();
    case 'seats':
      return store().transact((tx) => tx.busySeats());
    case 'counts':
      return store().transact((tx) => ({ items: tx.items().length, holds: tx.holds().length }));
    case 'release':
      return {
        released: releaseReservation(store(), {
          item: itemArg(),
          runId: text('runId'),
          attempt: instant('attempt'),
          at: instant('at'),
        }),
      };
    default:
      throw new Error(`unknown command ${command}`);
  }
}

try {
  reply({ ok: true, result: run() });
} catch (error) {
  reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
