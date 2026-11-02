import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, EVENT_LOG_KEPT, eventLogPath, readEvents } from '../src/bus/log.ts';
import { messageKeyOf, messageKeyPath } from '../src/store/keys.ts';

// The persisted verification checkpoint (docs/internal/events.md §1, "Incremental verification"):
// a read that verified every retained record writes its key print, highest sequence and prefix
// digest beside the log, and the next process verifies only the records appended since. Every
// reading side here runs in a fresh process (bus-verify-checkpoint-run.ts), because the in-memory
// checkpoint would otherwise answer for it. These scenes pin what the file is allowed to decide:
// a changed byte before the checkpoint is still caught, and a file that does not match the
// retained bytes, the key, or the retained-file count is never trusted.

const dirs: string[] = [];

function makeScratch(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-verify-checkpoint-')));
  dirs.push(base);
  return { base, root: join(base, 'repo'), home: join(base, 'home') };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TS = '2026-10-18T12:00:00.000Z';
const CHECKPOINT = 'verify-checkpoint.json';

function appendOne(root: string, home: string, id: string): void {
  const appended = appendEvent('acme', root, home, {
    ts: TS,
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
  });
  expect(appended.ok).toBe(true);
}

type Reading = {
  ok: boolean;
  full?: boolean;
  checked?: number;
  unverified?: number;
  seqs?: number[];
  ids?: string[];
  reason?: string;
};

async function readInFreshProcess(root: string, home: string): Promise<Reading> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'bus-verify-checkpoint-run.ts'), root, home],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ err, code }).toEqual({ err: '', code: 0 });
  return JSON.parse(out.trim().split('\n').at(-1) ?? 'null') as Reading;
}

function checkpointPath(root: string, home: string): string {
  return join(dirname(eventLogPath('acme', root, home)), CHECKPOINT);
}

type StoredCheckpoint = { format: number; keyPrint: string; kept: number; seq: number; digest: string };

function storedCheckpoint(root: string, home: string): StoredCheckpoint {
  return JSON.parse(readFileSync(checkpointPath(root, home), 'utf8')) as StoredCheckpoint;
}

describe('persisted verification checkpoint: a fresh process verifies only the tail', () => {
  test('a full read writes the checkpoint beside the log and the next process checks only what was appended', async () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2', 'm-3']) appendOne(root, home, id);

    const first = await readInFreshProcess(root, home);
    expect(first).toMatchObject({ ok: true, full: true, checked: 3, unverified: 0, seqs: [1, 2, 3] });

    expect(existsSync(checkpointPath(root, home))).toBe(true);
    const stored = storedCheckpoint(root, home);
    expect(stored.format).toBe(1);
    expect(stored.seq).toBe(3);
    expect(stored.kept).toBe(EVENT_LOG_KEPT);
    expect(stored.keyPrint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.digest).toMatch(/^[0-9a-f]{64}$/);

    appendOne(root, home, 'm-4');
    const second = await readInFreshProcess(root, home);
    expect(second).toMatchObject({ ok: true, full: false, checked: 1, unverified: 0, seqs: [1, 2, 3, 4] });
    const grown = storedCheckpoint(root, home);
    expect(grown.seq).toBe(4);
    expect(grown.digest).not.toBe(stored.digest);

    // A quiet read finds the file already covering everything: nothing to verify, nothing rewritten.
    const quiet = await readInFreshProcess(root, home);
    expect(quiet).toMatchObject({ ok: true, full: false, checked: 0, seqs: [1, 2, 3, 4] });
    expect(storedCheckpoint(root, home)).toEqual(grown);
  }, 20_000);
});

describe('persisted verification checkpoint: a changed byte before the checkpoint is still caught', () => {
  test('a record altered in place changes the digest and the full verify that follows refuses it', async () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2', 'm-3']) appendOne(root, home, id);
    expect((await readInFreshProcess(root, home)).full).toBe(true);
    const stored = storedCheckpoint(root, home);

    // The first record's payload is edited without re-signing: its bytes no longer hash to the
    // checkpoint's digest, and its signature no longer covers the payload it now carries.
    const path = eventLogPath('acme', root, home);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[0] = lines[0]!.replace('"m-1"', '"m-9"');
    writeFileSync(path, lines.join('\n'));

    const tampered = await readInFreshProcess(root, home);
    expect(tampered).toMatchObject({ ok: true, full: true, checked: 3, unverified: 1, seqs: [2, 3], ids: ['m-2', 'm-3'] });

    // That read verified nothing about the altered prefix beyond doubt, so it must not have
    // promoted it: the file still holds the old checkpoint, and the next process hashes the
    // changed bytes against it, verifies in full again, and still refuses the record.
    expect(storedCheckpoint(root, home)).toEqual(stored);
    const again = await readInFreshProcess(root, home);
    expect(again).toMatchObject({ ok: true, full: true, unverified: 1, seqs: [2, 3] });
  }, 20_000);

  test('a record appended below the checkpoint sequence is not covered by it', async () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2']) appendOne(root, home, id);
    expect((await readInFreshProcess(root, home)).full).toBe(true);

    const path = eventLogPath('acme', root, home);
    const existing = readFileSync(path, 'utf8');
    const forged = JSON.parse(existing.split('\n')[0]!) as {
      payload: Record<string, unknown>;
      signature: string;
    };
    forged.payload.seq = 1;
    forged.payload.record_id = 'forged-below-checkpoint';
    writeFileSync(path, `${existing}${JSON.stringify(forged)}\n`);

    // The extra line sits at or below the checkpoint's sequence, so the prefix digest covers its
    // bytes: a fresh process that trusted the file without hashing the prefix would return it.
    const caught = await readInFreshProcess(root, home);
    expect(caught).toMatchObject({ ok: true, full: true, checked: 3, unverified: 1, ids: ['m-1', 'm-2'] });
  }, 20_000);
});

describe('persisted verification checkpoint: mismatches are misses, never trust', () => {
  test('a forged digest is not trusted and a clean full verify writes the genuine checkpoint', async () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2']) appendOne(root, home, id);
    expect((await readInFreshProcess(root, home)).full).toBe(true);
    const genuine = storedCheckpoint(root, home);

    writeFileSync(checkpointPath(root, home), `${JSON.stringify({ ...genuine, digest: '0'.repeat(64) })}\n`);
    const forged = await readInFreshProcess(root, home);
    expect(forged).toMatchObject({ ok: true, full: true, checked: 2, unverified: 0, seqs: [1, 2] });

    // The read verified the whole log, so the genuine checkpoint replaces the forged one and the
    // next process leans on it.
    expect(storedCheckpoint(root, home)).toEqual(genuine);
    const next = await readInFreshProcess(root, home);
    expect(next).toMatchObject({ ok: true, full: false, checked: 0, seqs: [1, 2] });
  }, 20_000);

  test('a recomputed digest over an altered record with the other fields copied is a miss', async () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2', 'm-3']) appendOne(root, home, id);
    expect((await readInFreshProcess(root, home)).full).toBe(true);
    const genuine = storedCheckpoint(root, home);

    // The same-user forgery the reviewer probed: edit a record without signing it, recompute the
    // digest exactly as the checkpoint does (each parsed line's raw bytes plus a newline, in
    // retained order), and copy every other field the read checks — key print, retained count,
    // sequence, and the genuine signature — from the clean file.
    const path = eventLogPath('acme', root, home);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const changed = JSON.parse(lines[0]!) as { payload: Record<string, unknown> };
    changed.payload.record_id = 'forged-without-signing';
    lines[0] = JSON.stringify(changed);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const hash = createHash('sha256');
    for (const line of lines) hash.update(line, 'utf8').update('\n', 'utf8');
    const forged = { ...genuine, digest: hash.digest('hex') };
    expect(forged.digest).not.toBe(genuine.digest);
    writeFileSync(checkpointPath(root, home), `${JSON.stringify(forged)}\n`);

    // Every value the digest, key print, and retained count checks would accept now matches, so
    // only the signature can tell: it covers the recomputed digest and the store, does not
    // verify, and the read that follows verifies in full and refuses the altered record.
    const caught = await readInFreshProcess(root, home);
    expect(caught).toMatchObject({ ok: true, full: true, checked: 3, unverified: 1, seqs: [2, 3], ids: ['m-2', 'm-3'] });

    // That read verified nothing clean, so it did not promote the forgery: the file stays exactly
    // as the forger wrote it, and the next read is a full verify too.
    expect(storedCheckpoint(root, home)).toEqual(forged);
    const again = await readInFreshProcess(root, home);
    expect(again).toMatchObject({ ok: true, full: true, unverified: 1, seqs: [2, 3] });
  }, 20_000);

  test('an unreadable checkpoint file is ignored and replaced by the one the read earned', async () => {
    const { root, home } = makeScratch();
    appendOne(root, home, 'm-1');
    writeFileSync(checkpointPath(root, home), '{ not json\n');

    const read = await readInFreshProcess(root, home);
    expect(read).toMatchObject({ ok: true, full: true, checked: 1, unverified: 0, seqs: [1] });
    expect(storedCheckpoint(root, home).seq).toBe(1);
  }, 20_000);

  test('a checkpoint written under another key is a miss and is left alone', async () => {
    const { base, root, home } = makeScratch();
    for (const id of ['m-1', 'm-2']) appendOne(root, home, id);
    expect((await readInFreshProcess(root, home)).full).toBe(true);
    const stored = storedCheckpoint(root, home);

    // A second message key replaces this checkout's: every retained record was signed with the
    // first one, so the checkpoint describes a key the log no longer verifies under.
    const spare = join(base, 'spare-home');
    messageKeyOf(spare);
    renameSync(messageKeyPath(spare), messageKeyPath(home));

    const other = await readInFreshProcess(root, home);
    expect(other).toMatchObject({ ok: true, full: true, checked: 2, unverified: 2, seqs: [] });
    // Nothing was verified, so the file is untouched rather than rewritten with a claim it cannot make.
    expect(storedCheckpoint(root, home)).toEqual(stored);
  }, 20_000);

  test('a checkpoint reached through a symbolic link is not read', async () => {
    const { base, root, home } = makeScratch();
    for (const id of ['m-1', 'm-2']) appendOne(root, home, id);
    expect((await readInFreshProcess(root, home)).full).toBe(true);
    const stored = storedCheckpoint(root, home);

    // Move the genuine checkpoint out of the way and point the name at it through a link: if the
    // read followed the link it would match and skip verification, which it must never do.
    const target = join(base, 'linked-checkpoint.json');
    renameSync(checkpointPath(root, home), target);
    symlinkSync(target, checkpointPath(root, home));

    const linked = await readInFreshProcess(root, home);
    expect(linked).toMatchObject({ ok: true, full: true, checked: 2, seqs: [1, 2] });
    // The write replaces the link itself with a regular file, and the linked target is untouched.
    expect(lstatSync(checkpointPath(root, home)).isSymbolicLink()).toBe(false);
    expect(storedCheckpoint(root, home)).toEqual(stored);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(stored);
  }, 20_000);
});

describe('persisted verification checkpoint: the write never follows a planted temporary', () => {
  test('a link planted at the old pid-named temporary is left in place and never written through', async () => {
    const { base, root, home } = makeScratch();
    appendOne(root, home, 'm-1');
    const target = join(base, 'unrelated-sentinel');
    writeFileSync(target, 'keep-this-exact\n');
    // The name the old pid-based writer would have used. A writer that opened it would follow
    // the link into the sentinel before renaming the temporary over the checkpoint.
    const planted = `${checkpointPath(root, home)}.${String(process.pid)}.tmp`;
    symlinkSync(target, planted);

    expect((await readInFreshProcess(root, home)).full).toBe(true);
    appendOne(root, home, 'm-2');

    // This process verifies only the record appended past the checkpoint and publishes the grown
    // one, so the write path runs; the planted link is not this write's own file.
    const written = readEvents('acme', root, home);
    expect(written).toMatchObject({ ok: true, full: false, checked: 1 });
    expect(readFileSync(target, 'utf8')).toBe('keep-this-exact\n');
    expect(lstatSync(checkpointPath(root, home)).isSymbolicLink()).toBe(false);
    expect(storedCheckpoint(root, home).seq).toBe(2);
    expect(lstatSync(planted).isSymbolicLink()).toBe(true);
  }, 20_000);
});
