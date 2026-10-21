import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHostQueue,
  type ClaimToken,
  type HostMessage,
  type RelayKey,
} from '../packages/relay/host/queue.js';

type ChildJob =
  | { op: 'enqueue'; dir: string; recipient: string; message: HostMessage }
  | { op: 'claim-process-ack'; dir: string; recipient: string; startAt?: number }
  | { op: 'claim-process-no-ack'; dir: string; recipient: string }
  | { op: 'claim-no-process'; dir: string; recipient: string };

/**
 * The receiver's atomic per-message-id gate. First processing of an id wins and records the
 * processing; every later callback (including a late one from a superseded epoch) is rejected.
 * This is the receiver-side dedup the queue relies on; the queue cannot enforce it.
 */
function receiverGate(dir: string, messageId: string, epoch: number): boolean {
  const gateDir = join(dir, 'receiver');
  mkdirSync(gateDir, { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(messageId).digest('hex');
  try {
    writeFileSync(join(gateDir, name), `${JSON.stringify({ messageId, epoch })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  appendFileSync(join(dir, 'processed.log'), `${messageId}\n`);
  return true;
}

function processedCount(dir: string): number {
  try {
    return readFileSync(join(dir, 'processed.log'), 'utf8').trim().split('\n').filter((line) => line !== '').length;
  } catch {
    return 0;
  }
}

async function runChild(job: ChildJob): Promise<Record<string, unknown>> {
  const queue = createHostQueue({ dir: job.dir });
  if (job.op === 'enqueue') {
    return (await queue.enqueue({ scope: { recipient: job.recipient }, message: job.message })) as unknown as Record<string, unknown>;
  }
  if ('startAt' in job && job.startAt !== undefined) {
    while (Date.now() < job.startAt) {
      // Spin so two processes reach claim() together; the claim marker decides the winner.
    }
  }
  const claimed = await queue.claim({ recipient: job.recipient });
  if (claimed.verdict !== 'claimed') return claimed as unknown as Record<string, unknown>;
  if (job.op === 'claim-no-process') {
    return { verdict: 'claimed-not-processed', key: claimed.key, token: claimed.token };
  }
  const processed = receiverGate(job.dir, claimed.message.id, claimed.token.epoch);
  if (job.op === 'claim-process-ack' && processed) {
    const ack = await queue.ack(claimed.key, claimed.token);
    return { verdict: 'claimed-processed', key: claimed.key, token: claimed.token, processed, ack };
  }
  return { verdict: 'claimed-processed-no-ack', key: claimed.key, token: claimed.token, processed };
}

// The child entry point: run one job in a fresh process, print its JSON result, and stop before
// any test registers. Durability and multi-process claims are exercised through this.
if (process.env.RELAY_QUEUE_CHILD !== undefined) {
  const job = JSON.parse(process.env.RELAY_QUEUE_CHILD) as ChildJob;
  const result = await runChild(job);
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => resolve());
  });
  process.exit(0);
}

function spawnChild(job: ChildJob): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, RELAY_QUEUE_CHILD: JSON.stringify(job) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${String(code)}: ${err}`));
        return;
      }
      const line = out.trim().split('\n').filter((item) => item !== '').pop();
      if (line === undefined) {
        reject(new Error(`child printed nothing: ${err}`));
        return;
      }
      resolve(JSON.parse(line) as Record<string, unknown>);
    });
  });
}

const dirs: string[] = [];

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-host-queue-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const R1 = { recipient: 'r1' } as const;
const R2 = { recipient: 'r2' } as const;

function keyOf(recipient: string, messageId: string): RelayKey {
  return { recipient, messageId };
}

describe('durable enqueue with a digest value, not a key dimension', () => {
  test('a fresh process stores the message and the parent sees it after restart', async () => {
    const dir = scratch();
    const first = await spawnChild({ op: 'enqueue', dir, recipient: 'r1', message: { id: 'm1', record: 'signed-1' } });
    expect(first).toMatchObject({ verdict: 'new' });

    const queue = createHostQueue({ dir });
    const again = await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    expect(again).toMatchObject({ verdict: 'duplicate' });

    const claimed = await queue.claim(R1);
    expect(claimed).toMatchObject({ verdict: 'claimed', message: { id: 'm1', record: 'signed-1' } });
  });

  test('same key with different bytes is a conflict; the stored bytes win', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } })).toMatchObject({ verdict: 'new' });
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'tampered' } })).toMatchObject({ verdict: 'conflict' });
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } })).toMatchObject({ verdict: 'duplicate' });

    const claimed = await queue.claim(R1);
    expect(claimed).toMatchObject({ verdict: 'claimed', message: { record: 'signed-1' } });
  });

  test('same message id under different recipients are distinct keys', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'for-r1' } })).toMatchObject({ verdict: 'new' });
    expect(await queue.enqueue({ scope: R2, message: { id: 'm1', record: 'for-r2' } })).toMatchObject({ verdict: 'new' });
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'for-r1-other' } })).toMatchObject({ verdict: 'conflict' });
  });
});

describe('claim is atomic and fenced', () => {
  test('two processes claiming together get exactly one runnable ticket and one callback', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    const startAt = Date.now() + 400;
    const [left, right] = await Promise.all([
      spawnChild({ op: 'claim-process-ack', dir, recipient: 'r1', startAt }),
      spawnChild({ op: 'claim-process-ack', dir, recipient: 'r1', startAt }),
    ]);
    const verdicts = [String(left.verdict), String(right.verdict)];
    expect(verdicts.filter((verdict) => verdict === 'claimed-processed')).toHaveLength(1);
    expect(verdicts.filter((verdict) => verdict === 'claimed-processed' || verdict === 'claimed-processed-no-ack')).toHaveLength(1);
    expect(processedCount(dir)).toBe(1);
  });

  test('recipient scope only returns that recipient messages', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'for-r1' } });
    expect(await queue.claim(R2)).toEqual({ verdict: 'empty' });
    expect(await queue.claim(R1)).toMatchObject({ verdict: 'claimed', message: { id: 'm1' } });
  });

  test('release returns the same message at the next epoch and refuses the old token', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    const first = await queue.claim(R1);
    if (first.verdict !== 'claimed') throw new Error('expected a claim');
    expect(await queue.release(first.key, first.token)).toMatchObject({ verdict: 'released' });

    const second = await queue.claim(R1);
    if (second.verdict !== 'claimed') throw new Error('expected a second claim');
    expect(second.token.epoch).toBe(first.token.epoch + 1);
    expect(await queue.ack(first.key, first.token)).toMatchObject({ verdict: 'stale-token' });
    expect(await queue.ack(second.key, second.token)).toMatchObject({ verdict: 'acked' });
  });
});

describe('receipt ambiguity and recovery', () => {
  test('an unknown socket receipt followed by the durable copy is deduped by message id', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    // The socket attempt is recorded by TeamCLI as unknown; the durable copy uses the same id.
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } })).toMatchObject({ verdict: 'new' });
    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } })).toMatchObject({ verdict: 'duplicate' });

    const claimed = await queue.claim(R1);
    if (claimed.verdict !== 'claimed') throw new Error('expected a claim');
    expect(receiverGate(dir, claimed.message.id, claimed.token.epoch)).toBe(true);
    expect(receiverGate(dir, claimed.message.id, claimed.token.epoch)).toBe(false);
    expect(await queue.ack(claimed.key, claimed.token)).toMatchObject({ verdict: 'acked' });
    expect(await queue.claim(R1)).toEqual({ verdict: 'empty' });
    expect(processedCount(dir)).toBe(1);
  });

  test('a crash before processing stays ambiguous until fenced with a definitive unprocessed gate', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    const crashed = await spawnChild({ op: 'claim-no-process', dir, recipient: 'r1' });
    expect(crashed.verdict).toBe('claimed-not-processed');
    const key = crashed.key as RelayKey;
    const token = crashed.token as ClaimToken;

    // A live reservation is not offered to another consumer.
    expect(await queue.claim(R1)).toEqual({ verdict: 'empty' });

    const unfenced = await queue.recover({
      key,
      token,
      fenced: false,
      evidence: { kind: 'receiver-gate-unprocessed', at: new Date().toISOString() },
    });
    expect(unfenced.verdict).toBe('ambiguous');
    expect(await queue.claim(R1)).toEqual({ verdict: 'empty' });

    const fenced = await queue.recover({
      key,
      token,
      fenced: true,
      evidence: { kind: 'receiver-gate-unprocessed', at: new Date().toISOString() },
    });
    expect(fenced).toMatchObject({ verdict: 'redeliverable', epoch: 2 });

    const reclaimed = await queue.claim(R1);
    if (reclaimed.verdict !== 'claimed') throw new Error('expected a recovered claim');
    expect(reclaimed.token.epoch).toBe(2);
    expect(await queue.ack(key, token)).toMatchObject({ verdict: 'stale-token' });

    // The receiver gate rejects a late callback after the recovered processing; only one
    // callback ever processes the message id.
    expect(receiverGate(dir, reclaimed.message.id, reclaimed.token.epoch)).toBe(true);
    expect(receiverGate(dir, reclaimed.message.id, token.epoch)).toBe(false);
    expect(await queue.ack(reclaimed.key, reclaimed.token)).toMatchObject({ verdict: 'acked' });
    expect(processedCount(dir)).toBe(1);
  });

  test('a crash after processing before ack recovers as consumed, with no redelivery', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    const processed = await spawnChild({ op: 'claim-process-no-ack', dir, recipient: 'r1' });
    expect(processed).toMatchObject({ verdict: 'claimed-processed-no-ack', processed: true });
    expect(processedCount(dir)).toBe(1);

    const recovered = await queue.recover({
      key: processed.key as RelayKey,
      token: processed.token as ClaimToken,
      fenced: true,
      evidence: { kind: 'receiver-gate-processed', at: new Date().toISOString() },
    });
    expect(recovered).toMatchObject({ verdict: 'consumed' });
    expect(await queue.claim(R1)).toEqual({ verdict: 'empty' });
    expect(processedCount(dir)).toBe(1);
  });

  test('consumed tombstones are retained: a replay is a duplicate, never a new message', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    const claimed = await queue.claim(R1);
    if (claimed.verdict !== 'claimed') throw new Error('expected a claim');
    await queue.ack(claimed.key, claimed.token);

    expect(await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } })).toMatchObject({ verdict: 'duplicate' });
    expect(await queue.claim(R1)).toEqual({ verdict: 'empty' });
  });
});

describe('the store is private', () => {
  test('the store folder is 0700 and its records and reservations are 0600', async () => {
    const dir = scratch();
    const queue = createHostQueue({ dir });
    await queue.enqueue({ scope: R1, message: { id: 'm1', record: 'signed-1' } });
    const claimed = await queue.claim(R1);
    if (claimed.verdict !== 'claimed') throw new Error('expected a claim');

    const mode = (path: string): number => statSync(path).mode & 0o777;
    const key = keyOf('r1', 'm1');
    const messageFolder = join(dir, 'messages', createHash('sha256').update(`${key.recipient}\u0000${key.messageId}`).digest('hex'));
    expect(mode(join(dir, 'messages'))).toBe(0o700);
    expect(mode(messageFolder)).toBe(0o700);
    expect(mode(join(messageFolder, 'message.json'))).toBe(0o600);
    expect(mode(join(messageFolder, 'state.json'))).toBe(0o600);
    expect(mode(join(messageFolder, `reserve-${String(claimed.token.epoch)}`))).toBe(0o600);
  });
});
