// Reconciliation pass for the event bus (RFC 002 Amendment 01 §4.2).
//
// Runs at bus startup and every `reconcile-interval` seconds. Scans the project's durable
// records — `.agents/send-drops/<session>/<seat>`, `.agents/messages/<seat>`, `messages.jsonl`,
// and `.agents/team.state.json` — for message records, receipts, and seat states that have no
// corresponding event in `events.jsonl`, and appends the missing events idempotently. A tool
// that crashed between writing its record and publishing to the bus loses time, never the event.
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readHistory } from '../send/history.ts';
import { readPending } from '../send/pending.ts';
import { readState } from '../state.ts';
import {
  MESSAGE_DOMAIN,
  messageKeyState,
  RECEIPT_DOMAIN,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import { compareSeatNames } from '../seat-names.ts';
import { DEFAULT_HELD_THRESHOLD_SECONDS } from './kinds.ts';
import {
  appendEvent,
  readEvents,
  type EventAppendInput,
  type SignedEventRecord,
} from './log.ts';

export type ReconcileOptions = {
  project: string;
  root: string;
  session: string;
  home: string;
  now?: Date;
  maxBytes?: number;
  kept?: number;
  heldThresholdSeconds?: number;
  onEvent?: (record: SignedEventRecord) => void;
};

export type ReconcileResult =
  | { ok: true; raised: SignedEventRecord[] }
  | { ok: false; reason: string };

const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseDropSender(raw: string): { from?: string; ts?: string; thread?: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const payload =
        parsed.payload !== null && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
          ? (parsed.payload as Record<string, unknown>)
          : parsed;
      const from = typeof payload.from === 'string' && payload.from !== '' ? payload.from : undefined;
      const ts =
        typeof payload.ts === 'string' && payload.ts !== ''
          ? payload.ts
          : typeof payload.at === 'string' && payload.at !== ''
            ? payload.at
            : undefined;
      const thread = typeof payload.thread === 'string' && payload.thread !== '' ? payload.thread : undefined;
      return {
        ...(from !== undefined ? { from } : {}),
        ...(ts !== undefined ? { ts } : {}),
        ...(thread !== undefined ? { thread } : {}),
      };
    } catch {
      // fall through to header parsing
    }
  }
  const firstLine = raw.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('from the owner')) {
    return { from: 'owner' };
  }
  const match = /^from (?:the file's seat |seat )?([A-Za-z0-9._-]+)/.exec(firstLine);
  if (match?.[1] !== undefined) {
    return { from: match[1] };
  }
  return {};
}

export function reconcilePass(options: ReconcileOptions): ReconcileResult {
  const { project, root, session, home } = options;
  const nowDate = options.now ?? new Date();
  const nowIso = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const heldThresholdMs = (options.heldThresholdSeconds ?? DEFAULT_HELD_THRESHOLD_SECONDS) * 1000;

  const existing = readEvents(project, root, home, { kept: options.kept });
  if (!existing.ok) return existing;

  const seen = new Set<string>();
  const lastSeatEventTs = new Map<string, string>();
  for (const entry of existing.events) {
    if (entry.payload.session !== session) continue;
    seen.add(`${entry.payload.kind}\0${entry.payload.record_id}`);
    if (entry.payload.seat !== undefined) {
      const prev = lastSeatEventTs.get(entry.payload.seat);
      if (prev === undefined || Date.parse(entry.payload.ts) >= Date.parse(prev)) {
        lastSeatEventTs.set(entry.payload.seat, entry.payload.ts);
      }
    }
  }

  const raised: SignedEventRecord[] = [];

  const raise = (input: EventAppendInput): void => {
    const key = `${input.kind}\0${input.record_id}`;
    if (seen.has(key)) return;
    const res = appendEvent(project, root, home, input, {
      maxBytes: options.maxBytes,
      kept: options.kept,
      deduplicate: true,
    });
    if (res.ok) {
      seen.add(key);
      if (!res.duplicate) {
        raised.push(res.record);
        options.onEvent?.(res.record);
      }
    }
  };

  // 1. Scan `.agents/send-drops/<session>/<seat>` for drop files, `.pending` markers, and receipts.
  const sessionDropsDir = join(root, '.agents', 'send-drops', session);
  if (isRealDir(sessionDropsDir)) {
    let seats: string[] = [];
    try {
      seats = readdirSync(sessionDropsDir).sort(compareSeatNames);
    } catch {
      seats = [];
    }
    for (const seat of seats) {
      if (!RECORD_NAME.test(seat)) continue;
      const seatDir = join(sessionDropsDir, seat);
      if (!isRealDir(seatDir)) continue;

      let files: string[] = [];
      try {
        files = readdirSync(seatDir).sort();
      } catch {
        files = [];
      }

      const sendersById = new Map<string, string>();

      for (const file of files) {
        if (file.startsWith('.')) continue;
        if (
          file.endsWith('.tmp') ||
          file.endsWith('.pending') ||
          file.endsWith('.taken') ||
          file.endsWith('.read') ||
          file.endsWith('.read.json') ||
          file.endsWith('.delivered') ||
          file.endsWith('.delivered.json') ||
          file.endsWith('.replied') ||
          file.endsWith('.replied.json')
        ) {
          continue;
        }
        const fullPath = join(seatDir, file);
        if (!isRegularFile(fullPath)) continue;
        const id = file.endsWith('.json') ? file.slice(0, -'.json'.length) : file;
        if (!RECORD_NAME.test(id)) continue;

        let raw = '';
        let mtimeIso = nowIso;
        try {
          raw = readFileSync(fullPath, 'utf8');
          mtimeIso = new Date(statSync(fullPath).mtimeMs).toISOString();
        } catch {
          continue;
        }
        const meta = parseDropSender(raw);
        if (meta.from !== undefined) sendersById.set(id, meta.from);

        raise({
          ts: meta.ts ?? mtimeIso,
          kind: 'message.arrived',
          session,
          record_id: id,
          to: seat,
          ...(meta.from !== undefined ? { from: meta.from } : {}),
          ...(meta.thread !== undefined ? { thread: meta.thread } : {}),
        });
      }

      // Check `.pending` held drops in the seat's drop folder.
      for (const pending of readPending(seatDir)) {
        sendersById.set(pending.id, pending.from);
        raise({
          ts: pending.ts,
          kind: 'message.arrived',
          session,
          record_id: pending.id,
          from: pending.from,
          to: pending.to,
        });
        if (pending.leg !== 'mcp-inbox') {
          const heldAgeMs = nowMs - Date.parse(pending.ts);
          if (!Number.isFinite(heldAgeMs) || heldAgeMs >= heldThresholdMs) {
            raise({
              ts: pending.ts,
              kind: 'message.held',
              session,
              record_id: `${pending.id}:held`,
              from: pending.from,
              to: pending.to,
            });
          }
        }
      }

      // Check receipts (`.delivered`, `.read`, `.replied`) beside drops.
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = join(seatDir, file);
        if (!isRegularFile(fullPath)) continue;
        let mtimeIso = nowIso;
        try {
          mtimeIso = new Date(statSync(fullPath).mtimeMs).toISOString();
        } catch {
          continue;
        }
        const matchReceipt = (suffix: string): string | null =>
          file.endsWith(suffix) ? file.slice(0, -suffix.length) : null;

        const deliveredId = matchReceipt('.delivered.json') ?? matchReceipt('.delivered');
        if (deliveredId !== null && RECORD_NAME.test(deliveredId)) {
          const from = sendersById.get(deliveredId);
          raise({
            ts: mtimeIso,
            kind: 'message.delivered',
            session,
            record_id: `${deliveredId}:delivered`,
            to: seat,
            ...(from !== undefined ? { from } : {}),
          });
          continue;
        }

        const readId = matchReceipt('.read.json') ?? matchReceipt('.read');
        if (readId !== null && RECORD_NAME.test(readId)) {
          const from = sendersById.get(readId);
          raise({
            ts: mtimeIso,
            kind: 'message.read',
            session,
            record_id: `${readId}:read`,
            to: seat,
            ...(from !== undefined ? { from } : {}),
          });
          continue;
        }

        const repliedId = matchReceipt('.replied.json') ?? matchReceipt('.replied');
        if (repliedId !== null && RECORD_NAME.test(repliedId)) {
          const from = sendersById.get(repliedId);
          raise({
            ts: mtimeIso,
            kind: 'message.replied',
            session,
            record_id: `${repliedId}:replied`,
            to: seat,
            ...(from !== undefined ? { from } : {}),
          });
        }
      }
    }
  }

  // 2. Scan signed `.agents/messages/<seat>` records and `.read.json` receipts.
  const messagesDir = join(root, '.agents', 'messages');
  const keyState = messageKeyState(home);
  if (isRealDir(messagesDir) && keyState.kind === 'key') {
    let seats: string[] = [];
    try {
      seats = readdirSync(messagesDir).sort(compareSeatNames);
    } catch {
      seats = [];
    }
    for (const seat of seats) {
      if (!RECORD_NAME.test(seat)) continue;
      const seatDir = join(messagesDir, seat);
      if (!isRealDir(seatDir)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(seatDir).sort();
      } catch {
        files = [];
      }
      const messageSenders = new Map<string, string>();
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.read.json')) continue;
        const id = file.slice(0, -'.json'.length);
        if (!RECORD_NAME.test(id)) continue;
        const fullPath = join(seatDir, file);
        if (!isRegularFile(fullPath)) continue;
        try {
          const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
          const payload = parsed.payload as Record<string, unknown> | undefined;
          const sig = parsed.signature;
          if (!payload || typeof sig !== 'string') continue;
          if (payload.kind !== 'message' || payload.id !== id || payload.to !== seat || payload.session !== session) continue;
          if (!verifyDomain(MESSAGE_DOMAIN, payload as unknown as Json, sig, keyState.key)) continue;
          const from = typeof payload.from === 'string' ? payload.from : undefined;
          const at = typeof payload.at === 'string' ? payload.at : nowIso;
          if (from !== undefined) messageSenders.set(id, from);
          raise({
            ts: at,
            kind: 'message.arrived',
            session,
            record_id: id,
            to: seat,
            ...(from !== undefined ? { from } : {}),
          });
        } catch {
          continue;
        }
      }
      for (const file of files) {
        if (!file.endsWith('.read.json')) continue;
        const id = file.slice(0, -'.read.json'.length);
        if (!RECORD_NAME.test(id)) continue;
        const fullPath = join(seatDir, file);
        if (!isRegularFile(fullPath)) continue;
        try {
          const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
          const payload = parsed.payload as Record<string, unknown> | undefined;
          const sig = parsed.signature;
          if (!payload || typeof sig !== 'string') continue;
          if (payload.kind !== 'receipt' || payload.id !== id || payload.to !== seat || payload.session !== session) continue;
          if (!verifyDomain(RECEIPT_DOMAIN, payload as unknown as Json, sig, keyState.key)) continue;
          const at = typeof payload.at === 'string' ? payload.at : nowIso;
          const from = messageSenders.get(id);
          raise({
            ts: at,
            kind: 'message.read',
            session,
            record_id: `${id}:read`,
            to: seat,
            ...(from !== undefined ? { from } : {}),
          });
        } catch {
          continue;
        }
      }
    }
  }

  // 3. Scan `messages.jsonl` history entries for outcomes not yet reflected in `events.jsonl`.
  const history = readHistory(project, root, home);
  if (history.ok) {
    for (const entry of history.entries) {
      raise({
        ts: entry.ts,
        kind: 'message.arrived',
        session,
        record_id: entry.id,
        from: entry.from,
        to: entry.to,
        ...(entry.via !== undefined ? { via: entry.via } : {}),
      });
      if (entry.outcome === 'delivered') {
        raise({
          ts: entry.ts,
          kind: 'message.delivered',
          session,
          record_id: `${entry.id}:delivered`,
          from: entry.from,
          to: entry.to,
          ...(entry.via !== undefined ? { via: entry.via } : {}),
        });
      } else if (entry.outcome === 'delivered (read)') {
        raise({
          ts: entry.ts,
          kind: 'message.delivered',
          session,
          record_id: `${entry.id}:delivered`,
          from: entry.from,
          to: entry.to,
          ...(entry.via !== undefined ? { via: entry.via } : {}),
        });
        raise({
          ts: entry.ts,
          kind: 'message.read',
          session,
          record_id: `${entry.id}:read`,
          from: entry.from,
          to: entry.to,
          ...(entry.via !== undefined ? { via: entry.via } : {}),
        });
      } else if (entry.outcome === 'answered') {
        raise({
          ts: entry.ts,
          kind: 'message.replied',
          session,
          record_id: `${entry.id}:replied`,
          from: entry.from,
          to: entry.to,
        });
      } else if (entry.outcome === 'held') {
        const heldAgeMs = nowMs - Date.parse(entry.ts);
        if (!Number.isFinite(heldAgeMs) || heldAgeMs >= heldThresholdMs) {
          raise({
            ts: entry.ts,
            kind: 'message.held',
            session,
            record_id: `${entry.id}:held`,
            from: entry.from,
            to: entry.to,
          });
        }
      } else if (entry.outcome === 'unreachable') {
        raise({
          ts: entry.ts,
          kind: 'seat.unreachable',
          session,
          record_id: `${entry.id}:unreachable`,
          seat: entry.to,
          subject: entry.to,
        });
      }
    }
  }

  // 4. Scan `.agents/team.state.json` for seat state transitions newer than their last event.
  const state = readState(join(root, '.agents'));
  const sessionState = state.sessions[session];
  if (sessionState !== undefined) {
    const seatNames = Object.keys(sessionState.seats).sort(compareSeatNames);
    for (const seatName of seatNames) {
      const seatRecord = sessionState.seats[seatName];
      if (!seatRecord) continue;
      const activeTs = seatRecord.last_active;
      if (typeof activeTs !== 'string' || !Number.isFinite(Date.parse(activeTs))) continue;
      const prevTs = lastSeatEventTs.get(seatName);
      if (prevTs !== undefined && Date.parse(activeTs) <= Date.parse(prevTs)) continue;
      const kind = seatRecord.stage === 'ready' ? 'seat.working' : 'seat.idle';
      raise({
        ts: activeTs,
        kind,
        session,
        record_id: `seat:${seatName}:${seatRecord.stage}:${activeTs}`,
        seat: seatName,
        subject: seatName,
      });
      lastSeatEventTs.set(seatName, activeTs);
    }
  }

  return { ok: true, raised };
}
