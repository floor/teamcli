// The durable, recovery-owned read claim (rfc-event-comms E5, review round 4).
//
// A relayed deferred read names its owning outbox request in its claim and makes that durable
// before any output. A run cut off between the saved output and its receipt seal leaves a claim
// only its recovery may settle: a new reader gets "being recovered" and no body; recovery seals
// the saved bodies' receipts and publishes them once. With nothing saved, the claim is voided: no
// body is published and the message is read once afterwards. Every reader that serves a body goes
// through the one claim function, and the inventory below fails on one that does not.
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { generalBriefRecord, GENERAL_BRIEF_SHA256 } from '../src/launch/general-brief.ts';
import { dirname, join } from 'node:path';
import { recordDir, runMessages } from '../src/commands/messages.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { currentClaimIn, readMessage, sealRecoveredRead } from '../src/mcp/inbox.ts';
import { outboxFolder, relayOutboxes, type RelaySources } from '../src/send/confined-outbox.ts';
import { claimRead, claimsOwnedBy, READ_CLAIMS, relayClaimOwner } from '../src/send/read-claim.ts';
import { RECORD_KIND, receiptFile, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
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
    kind: RECORD_KIND,
    id,
    to: SEAT,
    to_id: null,
    root: made.root,
    session: SESSION,
    at: '2026-11-17T22:00:00.000Z',
    body: `from the owner\n\n${id}\n`,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  };
  const written = writeRecord(recordDir(made.root, SESSION, SEAT), signRecord(payload, made.home));
  if (!written.ok) throw new Error(written.reason);
}

function target(made: World) {
  return { dropDir: recordDir(made.root, SESSION, SEAT), root: made.root, seat: SEAT, session: SESSION, lead: SEAT };
}

/** The outbox of the seat with one request taken by a pass that never came back. */
function cutOffTake(made: World, request: string): string {
  const folder = outboxFolder(made.dir, SESSION, SEAT)!;
  mkdirSync(folder, { recursive: true });
  const taking = join(folder, `${request}.taking`);
  writeFileSync(taking, '{}');
  const long = new Date(Date.now() - 10 * 60_000);
  utimesSync(taking, long, long);
  return folder;
}

function recovery(made: World): RelaySources {
  return {
    recordedPane: () => undefined,
    agents: () => [],
    run: async () => ({ code: 0, out: '', err: '' }),
    now: () => new Date(),
    log: () => {},
    // The watch's seal: the seat's own reader, adopting the claim its cut-off request left, so a
    // recovered read seals the receipt a live read would (src/commands/watch.ts).
    seal: (seat, ids, owner) => ids.every((id) =>
      sealRecoveredRead(target(made), id, made.home, { claim: () => currentClaimIn(made.root, SESSION, seat) }, owner)),
  };
}

/** One whole saved chunk, as the relay writes it: a header line ({ids, sha256, length}), then the
 *  text. `cut` drops bytes from the text after the header was written, as a torn write would. */
function saveChunk(folder: string, request: string, seq: number, text: string, ids: string[], cut = 0): void {
  const header = JSON.stringify({ v: 1, ids, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), length: Buffer.byteLength(text, 'utf8') });
  writeFileSync(join(folder, `${request}.partial.${String(seq).padStart(6, '0')}`), `${header}\n${text.slice(0, text.length - cut)}`);
}

/** The read's process dies: its claim file now names a pid that is gone (taken over as stale). */
function holderDies(made: World, ids: string[]): void {
  for (const id of ids) writeFileSync(join(target(made).dropDir, READ_CLAIMS, id), '999999 dead 1\n');
}

function bodiesIn(text: string, id: string): number {
  return text.split(`\n${id}\n`).length - 1;
}

test('a crash between the saved output and the seal: a new reader gets no body, recovery exposes it exactly once', async () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-000000000001';
  const request = 'c1a1aaaa-0000-4000-8000-000000000001';
  plant(made, id);
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);
  let exposed = 0;

  // The relayed read takes its durable claim and hands the body over into its saved output ...
  const first = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after', owner });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  saveChunk(folder, request, 0, `${first.body}\n`, [id]);
  // ... and is cut off before its seal: neither seal nor release runs. Its owner file stands.
  holderDies(made, [id]);
  expect(existsSync(join(target(made).dropDir, READ_CLAIMS, `${id}.owner`))).toBe(true);

  // A new reader finds the claim its recovery owns: no body, whether the holder lives or not.
  const rival = readMessage(target(made), id, made.home);
  expect(rival.ok).toBe(false);
  if (!rival.ok) expect(rival.reason).toContain('being recovered');
  const rivalDeferred = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after' });
  expect(rivalDeferred.ok).toBe(false);

  // Recovery seals the saved bodies' receipts and publishes the saved output once.
  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const result = JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string };
  exposed += bodiesIn(result.out, id);
  expect(claimsOwnedBy(target(made).dropDir, owner)).toEqual([]);

  // The reader that comes next finds the id served: no second body.
  const after = readMessage(target(made), id, made.home);
  expect(after.ok).toBe(false);
  if (!after.ok) expect(after.served).toBe('already-served');
  expect(exposed).toBe(1);
});

test('a voided claim: nothing was saved, recovery publishes no body, and the message is read once afterwards', async () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-000000000002';
  const request = 'c1a1aaaa-0000-4000-8000-000000000002';
  plant(made, id);
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);

  const first = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after', owner });
  expect(first.ok).toBe(true);
  // Cut off before anything was saved: no partial.
  holderDies(made, [id]);

  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const result = JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string };
  expect(result.out).toBe('');
  expect(claimsOwnedBy(target(made).dropDir, owner)).toEqual([]);

  const next = readMessage(target(made), id, made.home);
  expect(next.ok).toBe(true);
  if (next.ok) expect(bodiesIn(next.body, id)).toBe(1);
  const again = readMessage(target(made), id, made.home);
  expect(again.ok).toBe(false);
});

test('a claim whose owner file stands is never taken over by a reader, even with its lock gone', () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-000000000003';
  plant(made, id);
  const dropDir = target(made).dropDir;
  const taken = claimRead(dropDir, id, 'relay:/elsewhere/req');
  expect(taken.ok).toBe(true);
  // The holder's lock file vanished (its process died and something cleared it); the owner stays.
  unlinkSync(join(dropDir, READ_CLAIMS, id));
  expect(claimRead(dropDir, id)).toEqual({ ok: false, why: 'recovering' });
  if (taken.ok) taken.release();
  expect(claimRead(dropDir, id).ok).toBe(true);
});

// Hermes and Hestia, round 5: a recovered read of the launch brief seals the same bound receipt
// the live read would (digest, incarnation, epoch), so the brief reader finds it served.
test('a recovered launch-brief read seals the bound brief receipt', async () => {
  const made = open();
  const incarnation = 'inc_000000000077';
  const record = generalBriefRecord({ to: SEAT, root: made.root, session: SESSION, at: new Date().toISOString(), incarnation });
  const wrote = writeRecord(recordDir(made.root, SESSION, SEAT), signRecord(record, made.home));
  if (!wrote.ok) throw new Error(wrote.reason);
  updateState(made.dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.briefs = {
      [SEAT]: { id: record.id, at: record.at, incarnation, epoch: 'run_000000000077', sha256: GENERAL_BRIEF_SHA256, attempt: 0, stage: 'ready', superseded: [] },
    } as never;
  });
  const request = 'c1a1aaaa-0000-4000-8000-000000000005';
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);
  const brief = { claim: () => currentClaimIn(made.root, SESSION, SEAT) };
  const first = readMessage(target(made), record.id, made.home, brief, undefined, { receipt: 'after', owner });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  saveChunk(folder, request, 0, `${first.body}\n`, [record.id]);
  holderDies(made, [record.id]);
  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const receipt = readFileSync(receiptFile(target(made).dropDir, record.id, 'read'), 'utf8');
  expect(receipt).toContain(GENERAL_BRIEF_SHA256);
  expect(receipt).toContain(incarnation);
  expect(receipt).toContain('run_000000000077');
  const again = readMessage(target(made), record.id, made.home, brief);
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.served).toBe('already-served');
});

// Hestia, round 5: a torn batch settles only the ids whose bodies were saved whole. The whole one
// is sealed and published; the torn one is voided, none of its text is published, and it is read
// once by the next reader.
test('a truncated saved body is not counted: only whole bodies are sealed and published', async () => {
  const made = open();
  const whole = 'c1a10000-0000-4000-8000-000000000006';
  const torn = 'c1a10000-0000-4000-8000-000000000007';
  plant(made, whole);
  plant(made, torn);
  const request = 'c1a1aaaa-0000-4000-8000-000000000006';
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);
  const a = readMessage(target(made), whole, made.home, undefined, undefined, { receipt: 'after', owner });
  const b = readMessage(target(made), torn, made.home, undefined, undefined, { receipt: 'after', owner });
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  saveChunk(folder, request, 0, `${a.body}\n`, [whole]);
  saveChunk(folder, request, 1, `${b.body}\n`, [torn], 9);
  holderDies(made, [whole, torn]);
  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const out = (JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string }).out;
  expect(bodiesIn(out, whole)).toBe(1);
  expect(out).not.toContain(torn);
  expect(claimsOwnedBy(target(made).dropDir, owner)).toEqual([]);
  const servedWhole = readMessage(target(made), whole, made.home);
  expect(servedWhole.ok).toBe(false);
  const next = readMessage(target(made), torn, made.home);
  expect(next.ok).toBe(true);
  if (next.ok) expect(bodiesIn(next.body, torn)).toBe(1);
});

// Hermes and Hestia, round 5: claims that cannot be read are never taken as none. The take, its
// saved output and its claims all stay until the claims read again.
test('an unreadable claim folder keeps the cut-off take: nothing is published or retired', async () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-000000000008';
  plant(made, id);
  const request = 'c1a1aaaa-0000-4000-8000-000000000008';
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);
  const first = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after', owner });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  saveChunk(folder, request, 0, `${first.body}\n`, [id]);
  holderDies(made, [id]);
  const claims = join(target(made).dropDir, READ_CLAIMS);
  chmodSync(claims, 0o000);
  try {
    await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
    expect(existsSync(join(folder, `${request}.taking`))).toBe(true);
    expect(existsSync(join(folder, `${request}.result.json`))).toBe(false);
  } finally {
    chmodSync(claims, 0o700);
  }
  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const out = (JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string }).out;
  expect(bodiesIn(out, id)).toBe(1);
  expect(readMessage(target(made), id, made.home).ok).toBe(false);
});

// Hermes and Hestia, round 6: a recovery seal that cannot be made keeps the claim its recovery's.
// The owner file stays, a later reader gets "being recovered", and the next pass seals and
// publishes: the body goes out once.
test('a recovery seal that fails keeps the owner: a later reader gets no body, the retry exposes it once', async () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-000000000009';
  plant(made, id);
  const request = 'c1a1aaaa-0000-4000-8000-000000000009';
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);
  const first = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after', owner });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  saveChunk(folder, request, 0, `${first.body}\n`, [id]);
  holderDies(made, [id]);
  // The receipt cannot be written: the seal fails inside the seat's reader.
  const dropDir = target(made).dropDir;
  chmodSync(dropDir, 0o500);
  try {
    await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  } finally {
    chmodSync(dropDir, 0o700);
  }
  expect(existsSync(join(folder, `${request}.result.json`))).toBe(false);
  expect(claimsOwnedBy(dropDir, owner)).toEqual([id]);
  const rival = readMessage(target(made), id, made.home);
  expect(rival.ok).toBe(false);
  if (!rival.ok) expect(rival.reason).toContain('being recovered');
  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const out = (JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { out: string }).out;
  expect(bodiesIn(out, id)).toBe(1);
  const after = readMessage(target(made), id, made.home);
  expect(after.ok).toBe(false);
  if (!after.ok) expect(after.served).toBe('already-served');
});

// Hestia, round 6: unframed output withheld beside a voided claim stays withheld across a failed
// publish: the claim that justifies withholding it is removed only after the output is discarded.
test('withheld unframed output stays withheld across a failed publish', async () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-00000000000a';
  plant(made, id);
  const request = 'c1a1aaaa-0000-4000-8000-00000000000a';
  const folder = cutOffTake(made, request);
  const owner = relayClaimOwner(folder, request);
  const first = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after', owner });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  writeFileSync(join(folder, `${request}.partial`), `${first.body}\n`);
  holderDies(made, [id]);
  const result = join(folder, `${request}.result.json`);
  // The first publish attempt fails after its temp file was written.
  const failing: RelaySources = { ...recovery(made), trace: (point) => { if (point === 'result-fsync') throw new Error('injected publish failure'); } };
  await relayOutboxes(made.dir, SESSION, [SEAT], failing);
  expect(existsSync(result)).toBe(false);
  expect(existsSync(join(folder, `${request}.taking`))).toBe(true);
  // The claim is removed last: it still stands, so the retry withholds the unframed output too.
  expect(claimsOwnedBy(target(made).dropDir, owner)).toEqual([id]);
  await relayOutboxes(made.dir, SESSION, [SEAT], recovery(made));
  const out = (JSON.parse(readFileSync(result, 'utf8')) as { out: string }).out;
  expect(out).not.toContain(id);
  // The voided message is read once by the next reader.
  const next = readMessage(target(made), id, made.home);
  expect(next.ok).toBe(true);
});

// Hestia, round 4: `team messages` serves the seat's own mail through its own receipt act. It
// takes the same claim: while a deferred read holds the id, it shows no body; after the seal the
// id is served, and across both readers the body went out once.
test('team messages shows no body while a deferred read holds the id', async () => {
  const made = open();
  const id = 'c1a10000-0000-4000-8000-000000000004';
  plant(made, id);
  updateState(made.dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: 'pane-lead' };
  });
  let exposed = 0;
  const held = readMessage(target(made), id, made.home, undefined, undefined, { receipt: 'after' });
  expect(held.ok).toBe(true);
  const caller = { kind: 'seat' as const, name: SEAT, pane: 'pane-lead', session: SESSION };
  const during = testIo(made.root, caller);
  await runMessages([], during, { home: made.home, now: () => new Date() });
  exposed += bodiesIn(during.out, id);
  expect(exposed).toBe(0);
  if (held.ok) {
    exposed += bodiesIn(`${held.body}\n`, id);
    expect(held.seal?.()).toBe(true);
  }
  const later = testIo(made.root, caller);
  await runMessages([], later, { home: made.home, now: () => new Date() });
  exposed += bodiesIn(later.out, id);
  expect(exposed).toBe(1);
});

// The reader inventory: every source file that renders a message body for a reader (the body
// producers `attributedBody(` and `bodyWithReaderLine(`) is listed here with the gate it serves
// that body under. `readMessage` takes the claim itself, so its callers are gated by it; a file
// that writes the read receipt directly (`publishRecordRead(`) and renders a body must take the
// one claim; a new file that renders a body fails until it is classified.
const BODY_SITES: Record<string, string> = {
  'src/mcp/inbox.ts': 'readMessage takes claimRead; peekMessage writes no receipt and serves no read',
  'src/commands/messages.ts': 'openRecord takes claimRead before the receipt; the waiting row is a peek with no receipt',
  'src/commands/show.ts': 'takes claimRead before the receipt',
  'src/mcp/serve.ts': 'channel push: a delivery leg (E6 exposure claims), not a reader',
  'src/commands/send.ts': 'send-side delivery frame (E6 exposure claims), not a reader',
  'src/send/daemon.ts': 'send-side delivery frame (E6 exposure claims), not a reader',
  'src/daemon/relay-routes.ts': 'send-side delivery frame (E6 exposure claims), not a reader',
  'src/send/readable-wake.ts': 'typed wake text (E6 exposure claims); its read goes through readMessage',
};
const CLAIMED_READERS = ['src/mcp/inbox.ts', 'src/commands/messages.ts', 'src/commands/show.ts'];
const PRODUCERS = ['src/send/sender-claim.ts', 'src/send/frame.ts'];

function sourceFiles(folder: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, name.name);
    if (name.isDirectory()) out.push(...sourceFiles(path));
    else if (name.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('every reader that renders a message body goes through the one read claim', () => {
  const root = join(import.meta.dir, '..');
  const rendering = sourceFiles(join(root, 'src'))
    .map((path) => path.slice(root.length + 1))
    .filter((path) => !PRODUCERS.includes(path))
    .filter((path) => /\b(attributedBody|bodyWithReaderLine)\(/.test(readFileSync(join(root, path), 'utf8')));
  for (const path of rendering) expect(BODY_SITES[path] === undefined ? `unclassified body site: ${path}` : path).toBe(path);
  for (const path of rendering) {
    const text = readFileSync(join(root, path), 'utf8');
    // serve.ts writes receipts only for the ack tool, which serves no body.
    if (/\bpublishRecordRead\(/.test(text) && !path.endsWith('mcp/serve.ts')) {
      expect(CLAIMED_READERS.includes(path) ? path : `a body-serving reader without the claim: ${path}`).toBe(path);
      expect(/\bclaimRead\(/.test(text)).toBe(true);
    }
  }
});
