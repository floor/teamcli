// Standalone durable host queue for relay delivery: enqueue, claim, ack/release and recovery.
// Plain data and Node builtins only; no TeamCLI import, no service, no auth, no transport. The
// caller supplies a recipient taken from verified admission; that value is trusted data, never
// an authorization token and never read from requester JSON. The typed surface is queue.d.ts.
//
// Dedup key is the canonical recipient plus the message id. The immutable signed record's digest
// is computed here and compared as a value under that key, never folded into the key, so a
// same-key/different-bytes enqueue is refused as a conflict instead of bypassing dedup.
//
// Claim reserves one message atomically: a per-epoch marker is created with link(2), so
// simultaneous consumers (threads or processes) never receive the same runnable ticket. The
// reservation carries a fencing epoch; ack and release must present the key and the exact token,
// so an ack from a superseded reservation is refused.
//
// This queue does not claim global exactly-once. A reservation whose runtime died before ack is
// ambiguous: recover() only turns it back into claimable work when the caller attests the old
// runtime is fenced, and the receiver's atomic per-message-id gate reports a definitive result.
// A missing receiver record is NOT definitive; late callbacks must be rejected by that receiver
// gate keyed by message id, not only by the queue's late-ack check. Consumed tombstones are kept
// for the lifetime of the store in this first slice; no tombstones are collected.
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

function keyHash(key) {
  return createHash('sha256').update(`${key.recipient}\u0000${key.messageId}`).digest('hex');
}

function messageDir(dir, key) {
  return join(dir, 'messages', keyHash(key));
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // The mode is best effort on a filesystem that does not carry it.
  }
}

function fsyncDir(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Not every filesystem allows syncing a directory; the file itself is synced already.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

function writeTempFile(dir, data) {
  const temp = join(dir, `.tmp-${String(process.pid)}-${randomUUID()}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

/** Writes a file atomically: temp + fsync + rename, then the folder is synced. */
function writeJsonAtomic(dir, name, value) {
  const temp = writeTempFile(dir, `${JSON.stringify(value)}\n`);
  renameSync(temp, join(dir, name));
  fsyncDir(dir);
}

/** Creates a file atomically, or reports that the name already exists. */
function createJsonExclusive(dir, name, value) {
  const temp = writeTempFile(dir, `${JSON.stringify(value)}\n`);
  try {
    linkSync(temp, join(dir, name));
    fsyncDir(dir);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Renamed or already gone.
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isRelayKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value;
  return typeof key.recipient === 'string' && key.recipient !== '' && typeof key.messageId === 'string' && key.messageId !== '';
}

function isStoredMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stored = value;
  if (!isRelayKey(stored.key)) return false;
  if (typeof stored.digest !== 'string' || typeof stored.at !== 'string') return false;
  const message = stored.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const shape = message;
  if (typeof shape.id !== 'string' || typeof shape.record !== 'string') return false;
  if (shape.frame !== undefined && typeof shape.frame !== 'string') return false;
  return shape.id === stored.key.messageId;
}

function isStoredState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value;
  if (!isRelayKey(state.key)) return false;
  if (!['pending', 'claimed', 'consumed'].includes(state.status)) return false;
  if (typeof state.epoch !== 'number' || !Number.isInteger(state.epoch) || state.epoch < 0) return false;
  if (!(state.token === null || typeof state.token === 'string')) return false;
  if (typeof state.since !== 'string') return false;
  if (!(state.claimedAt === null || typeof state.claimedAt === 'string')) return false;
  return true;
}

/**
 * Reads a message's state. A missing record means enqueue stored the bytes but not the state
 * yet, so the message starts pending at epoch 0; an unreadable record is never guessed at.
 */
function readState(dir, message) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) {
    return { key: message.key, status: 'pending', epoch: 0, token: null, since: message.at, claimedAt: null };
  }
  const parsed = readJson(path);
  return isStoredState(parsed) ? parsed : null;
}

function isToken(token) {
  return (
    typeof token === 'object' &&
    token !== null &&
    typeof token.epoch === 'number' &&
    Number.isInteger(token.epoch) &&
    token.epoch > 0 &&
    typeof token.opaque === 'string' &&
    token.opaque !== ''
  );
}

export function createHostQueue(options) {
  const root = options.dir;
  const now = options.now ?? (() => new Date());
  const messagesRoot = join(root, 'messages');

  const enqueue = async ({ scope, message }) => {
    if (typeof scope.recipient !== 'string' || scope.recipient === '') {
      throw new Error('the verified scope needs a non-empty recipient');
    }
    if (typeof message.id !== 'string' || message.id === '') {
      throw new Error('the message needs a non-empty id');
    }
    if (typeof message.record !== 'string') throw new Error('the message record must be a string');
    if (message.frame !== undefined && typeof message.frame !== 'string') {
      throw new Error('the message frame must be a string when present');
    }
    const key = { recipient: scope.recipient, messageId: message.id };
    const at = now().toISOString();
    const digest = createHash('sha256').update(message.record).digest('hex');
    ensureDir(join(root, 'messages'));
    const dir = messageDir(root, key);
    ensureDir(dir);
    const stored = { key, message, digest, at };
    const created = createJsonExclusive(dir, 'message.json', stored);
    if (!created) {
      const existing = readJson(join(dir, 'message.json'));
      if (!isStoredMessage(existing)) return { verdict: 'conflict', at };
      if (existing.digest === digest) return { verdict: 'duplicate', digest, at };
      return { verdict: 'conflict', at };
    }
    writeJsonAtomic(dir, 'state.json', {
      key,
      status: 'pending',
      epoch: 0,
      token: null,
      since: at,
      claimedAt: null,
    });
    return { verdict: 'new', digest, at };
  };

  const claim = async (scope) => {
    if (typeof scope.recipient !== 'string' || scope.recipient === '') {
      throw new Error('the verified scope needs a non-empty recipient');
    }
    if (!existsSync(messagesRoot)) return { verdict: 'empty' };
    let ambiguousSince = null;
    let at = now().toISOString();
    const candidates = [];
    let entries = [];
    try {
      entries = readdirSync(messagesRoot);
    } catch {
      return { verdict: 'unreadable', at };
    }
    for (const name of entries) {
      const dir = join(messagesRoot, name);
      const message = readJson(join(dir, 'message.json'));
      if (!isStoredMessage(message) || message.key.recipient !== scope.recipient) continue;
      const state = readState(dir, message);
      if (state === null) {
        ambiguousSince = ambiguousSince ?? message.at;
        continue;
      }
      if (state.status === 'pending') candidates.push(message);
    }
    candidates.sort(
      (left, right) =>
        left.at.localeCompare(right.at) || left.key.messageId.localeCompare(right.key.messageId),
    );
    for (const message of candidates) {
      const dir = messageDir(root, message.key);
      const state = readState(dir, message);
      if (state === null || state.status !== 'pending') continue;
      const epoch = state.epoch + 1;
      const opaque = randomUUID();
      // link(2) is the atomic claim: exactly one consumer creates this epoch's marker.
      const reserved = createJsonExclusive(dir, `reserve-${String(epoch)}`, { epoch, opaque });
      if (!reserved) {
        ambiguousSince = ambiguousSince ?? state.since;
        continue;
      }
      at = now().toISOString();
      const token = { epoch, opaque };
      writeJsonAtomic(dir, 'state.json', {
        key: message.key,
        status: 'claimed',
        epoch,
        token: opaque,
        since: at,
        claimedAt: at,
      });
      return { verdict: 'claimed', key: message.key, token, message: message.message };
    }
    return ambiguousSince === null ? { verdict: 'empty' } : { verdict: 'ambiguous', since: ambiguousSince };
  };

  const finish = async (key, token, next) => {
    if (!isRelayKey(key) || !isToken(token)) return { verdict: 'unknown-message', at: now().toISOString() };
    const dir = messageDir(root, key);
    const message = readJson(join(dir, 'message.json'));
    if (!isStoredMessage(message)) return { verdict: 'unknown-message', at: now().toISOString() };
    if (message.key.recipient !== key.recipient || message.key.messageId !== key.messageId) {
      return { verdict: 'unknown-message', at: now().toISOString() };
    }
    const state = readState(dir, message);
    if (state === null) return { verdict: 'unreadable', at: now().toISOString() };
    const at = now().toISOString();
    if (state.status !== 'claimed' || state.epoch !== token.epoch || state.token !== token.opaque) {
      return { verdict: 'stale-token', at };
    }
    writeJsonAtomic(dir, 'state.json', {
      key: state.key,
      status: next === 'acked' ? 'consumed' : 'pending',
      epoch: state.epoch,
      token: null,
      since: at,
      claimedAt: next === 'acked' ? state.claimedAt : null,
    });
    return next === 'acked' ? { verdict: 'acked', at } : { verdict: 'released', at };
  };

  const ack = (key, token) => finish(key, token, 'acked');
  const release = (key, token) => finish(key, token, 'released');

  const recover = async (input) => {
    const { key, token, evidence } = input;
    if (!isRelayKey(key) || !isToken(token)) return { verdict: 'unknown-message', at: now().toISOString() };
    const dir = messageDir(root, key);
    const message = readJson(join(dir, 'message.json'));
    if (!isStoredMessage(message)) return { verdict: 'unknown-message', at: now().toISOString() };
    if (message.key.recipient !== key.recipient || message.key.messageId !== key.messageId) {
      return { verdict: 'unknown-message', at: now().toISOString() };
    }
    const state = readState(dir, message);
    if (state === null) return { verdict: 'unreadable', at: now().toISOString() };
    if (state.status !== 'claimed') return { verdict: 'not-reserved', at: now().toISOString() };
    if (state.epoch !== token.epoch || state.token !== token.opaque) {
      return { verdict: 'stale-token', at: now().toISOString() };
    }
    if (evidence.kind === 'receiver-gate-processed') {
      const at = now().toISOString();
      writeJsonAtomic(dir, 'state.json', {
        key: state.key,
        status: 'consumed',
        epoch: state.epoch,
        token: null,
        since: at,
        claimedAt: state.claimedAt,
      });
      return { verdict: 'consumed', at };
    }
    // Unprocessed evidence is only usable once the caller fences the old runtime; a receiver
    // gate saying "no record" while a callback may still land is not enough.
    if (input.fenced !== true) return { verdict: 'ambiguous', since: state.since };
    const at = now().toISOString();
    writeJsonAtomic(dir, 'state.json', {
      key: state.key,
      status: 'pending',
      epoch: state.epoch,
      token: null,
      since: at,
      claimedAt: null,
    });
    return { verdict: 'redeliverable', epoch: state.epoch + 1 };
  };

  return { enqueue, claim, ack, release, recover };
}
