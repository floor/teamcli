// The relayed read lifecycle under faults (rfc-event-comms E5, review round 8).
//
// One ordered sequence: 1 claim, 2 save, 3 seal, 3b publish, 4 discard, 5 remove (last), then the
// take is retired. This harness stops the sequence at every step after the hand-over, three ways:
// a crash as the step begins, a folder fsync that fails, and an unlink that fails. Between passes a
// rival reader tries both messages. Recovery then resumes until the take is retired. Across every
// result and every rival read, a body saved whole goes out exactly once; a body not saved whole is
// never published (neither from its torn chunk nor from an earlier build's unframed output) and is
// read exactly once afterwards by the next reader.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, utimesSync, writeFileSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordDir } from '../src/commands/messages.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { currentClaimIn, readMessage, sealRecoveredRead } from '../src/mcp/inbox.ts';
import { outboxFolder, relayOutboxes, type FinishStep, type RelaySources } from '../src/send/confined-outbox.ts';
import { READ_CLAIMS, relayClaimOwner } from '../src/send/read-claim.ts';
import { RECORD_KIND, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { world, type World } from './send-native-fixtures.ts';

const SEAT = 'lead';
const SESSION = 'acme';
const owned: string[] = [];
afterEach(() => {
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

function open(): World {
  const made = world(null);
  owned.push(dirname(made.root));
  chmodSync(lobbyDir(made.home), 0o700);
  return made;
}

function plant(made: World, id: string): void {
  const payload: RecordPayload = {
    kind: RECORD_KIND, id, to: SEAT, to_id: null, root: made.root, session: SESSION,
    at: '2026-11-17T22:00:00.000Z', body: `from the owner\n\n${id}\n`, from: 'owner', from_id: null,
    rule: 'the owner', thread: id,
  };
  const written = writeRecord(recordDir(made.root, SESSION, SEAT), signRecord(payload, made.home));
  if (!written.ok) throw new Error(written.reason);
}

const target = (made: World) => ({ dropDir: recordDir(made.root, SESSION, SEAT), root: made.root, seat: SEAT, session: SESSION, lead: SEAT });
const bodiesIn = (text: string, id: string): number => text.split(`\n${id}\n`).length - 1;

function saveChunk(folder: string, request: string, seq: number, text: string, ids: string[], cut = 0): void {
  const header = JSON.stringify({ v: 1, ids, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), length: Buffer.byteLength(text, 'utf8') });
  writeFileSync(join(folder, `${request}.partial.${String(seq).padStart(6, '0')}`), `${header}\n${text.slice(0, text.length - cut)}`);
}

function realFsync(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

type Fault = 'crash' | 'fsync' | 'unlink';

/** Recovery's sources, with a fault at `step` on this pass only. */
function sources(made: World, step: FinishStep | null, fault: Fault | null): RelaySources {
  let current: FinishStep | null = null;
  const failing = (kind: Fault) => fault === kind && current === step && step !== null;
  const eio = () => Object.assign(new Error('injected EIO'), { code: 'EIO' });
  return {
    recordedPane: () => undefined,
    agents: () => [],
    run: async () => ({ code: 0, out: '', err: '' }),
    now: () => new Date(),
    log: () => {},
    seal: (seat, ids, owner) => ids.every((id) => {
      const sealed = sealRecoveredRead(target(made), id, made.home, { claim: () => currentClaimIn(made.root, SESSION, seat) }, owner);
      // A failed flush after the receipt was linked: it is visible, and reported not durable.
      return failing('fsync') ? false : sealed;
    }),
    fault: (at) => {
      current = at;
      if (failing('crash')) throw new Error(`crash at ${at}`);
    },
    fs: {
      unlink: (path) => { if (failing('unlink')) throw eio(); unlinkSync(path); },
      fsyncFolder: (folder) => { if (failing('fsync')) throw eio(); realFsync(folder); },
    },
  };
}

const STEPS: FinishStep[] = ['seal', 'publish', 'discard', 'remove', 'retire'];
const FAULTS: Fault[] = ['crash', 'fsync', 'unlink'];

describe('the relayed read lifecycle, stopped at every step', () => {
  for (const step of STEPS) {
    for (const fault of FAULTS) {
      test(`${fault} at ${step}: a whole body goes out once, a torn one is never published and is read once`, async () => {
        const made = open();
        const whole = 'f1a10000-0000-4000-8000-000000000001';
        const torn = 'f1a10000-0000-4000-8000-000000000002';
        plant(made, whole);
        plant(made, torn);
        const request = 'f1a1aaaa-0000-4000-8000-000000000001';
        const folder = outboxFolder(made.dir, SESSION, SEAT)!;
        mkdirSync(folder, { recursive: true });
        const taking = join(folder, `${request}.taking`);
        writeFileSync(taking, '{}');
        const long = new Date(Date.now() - 10 * 60_000);
        utimesSync(taking, long, long);
        const owner = relayClaimOwner(folder, request);
        // 1 claim, 2 save: the whole body saved whole; the torn one cut short, and also present
        // in an earlier build's unframed output, which must never be revived.
        const a = readMessage(target(made), whole, made.home, undefined, undefined, { receipt: 'after', owner });
        const b = readMessage(target(made), torn, made.home, undefined, undefined, { receipt: 'after', owner });
        if (!a.ok || !b.ok) throw new Error('the deferred reads were refused');
        saveChunk(folder, request, 0, `${a.body}\n`, [whole]);
        saveChunk(folder, request, 1, `${b.body}\n`, [torn], 9);
        writeFileSync(join(folder, `${request}.partial`), `${b.body}\n`);
        // The holder dies: its claim files name a pid that is gone.
        for (const id of [whole, torn]) writeFileSync(join(target(made).dropDir, READ_CLAIMS, id), '999999 dead 1\n');

        let wholeOut = 0;
        let tornOut = 0;
        const rival = () => {
          for (const [id, tally] of [[whole, 'w'], [torn, 't']] as const) {
            const got = readMessage(target(made), id, made.home);
            if (got.ok) {
              if (tally === 'w') wholeOut += bodiesIn(got.body, id);
              else tornOut += bodiesIn(got.body, id);
            }
          }
        };

        await relayOutboxes(made.dir, SESSION, [SEAT], sources(made, step, fault)).catch(() => 0);
        rival();
        for (let pass = 0; pass < 4 && existsSync(taking); pass += 1) {
          await relayOutboxes(made.dir, SESSION, [SEAT], sources(made, null, null));
          rival();
        }
        expect(existsSync(taking)).toBe(false);
        const out = (JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string }).out;
        wholeOut += bodiesIn(out, whole);
        expect(out).not.toContain(torn);
        expect(wholeOut).toBe(1);
        expect(tornOut).toBe(1);
        // Nothing is left: no claim, no saved output, no unframed output.
        expect(existsSync(join(target(made).dropDir, READ_CLAIMS, `${whole}.owner`))).toBe(false);
        expect(existsSync(join(target(made).dropDir, READ_CLAIMS, `${torn}.owner`))).toBe(false);
        expect(existsSync(join(folder, `${request}.partial`))).toBe(false);
        expect(existsSync(join(folder, `${request}.partial.000000`))).toBe(false);
      });
    }
  }

  test('a crash after the claim and before anything was saved: nothing is published, the message is read once', async () => {
    const made = open();
    const id = 'f1a10000-0000-4000-8000-000000000003';
    plant(made, id);
    const request = 'f1a1aaaa-0000-4000-8000-000000000003';
    const folder = outboxFolder(made.dir, SESSION, SEAT)!;
    mkdirSync(folder, { recursive: true });
    const taking = join(folder, `${request}.taking`);
    writeFileSync(taking, '{}');
    const long = new Date(Date.now() - 10 * 60_000);
    utimesSync(taking, long, long);
    const owner = relayClaimOwner(folder, request);
    const first = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after', owner });
    expect(first.ok).toBe(true);
    writeFileSync(join(target(made).dropDir, READ_CLAIMS, id), '999999 dead 1\n');
    const blocked = readMessage(target(made), id, made.home);
    expect(blocked.ok).toBe(false);
    await relayOutboxes(made.dir, SESSION, [SEAT], sources(made, null, null));
    const out = (JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string }).out;
    expect(out).toBe('');
    const next = readMessage(target(made), id, made.home);
    expect(next.ok).toBe(true);
    if (next.ok) expect(bodiesIn(next.body, id)).toBe(1);
  });
});
