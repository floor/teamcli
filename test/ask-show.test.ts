// `team ask-show`: the marker HMAC is checked in process. The key is made here. No key file
// outside this test is read.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { markerMac, questionDigest, runAskShow, USAGE, type MarkerBody } from '../src/commands/ask-show.ts';
import { testIo } from './helpers.ts';

/** Fixed vector. The key is 32 bytes of 0x42. The guard copies this mac. */
const VECTOR = {
  key: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI',
  question: 'Status?',
  requestId: 'req-ask-show-v1',
  expiresAt: '2026-10-12T18:00:00.000Z',
  digest: '7fa2d11897a567998b667f4b453ac20b68a6813fde68222e583f90a5bf453b96',
  mac: '8d53d07c074d438d6676e20b45b11ea021b54e30d36d840b48e4f7a41223cbce',
};

const ASK = `TeamCLI signed ask v1\n${JSON.stringify({ question: VECTOR.question, request_id: VECTOR.requestId })}\n`;
const MARKER = `{"v":1,"request_id":"${VECTOR.requestId}","question_sha256":"${VECTOR.digest}","expires_at":"${VECTOR.expiresAt}","mac":"${VECTOR.mac}"}`;

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function root(): string {
  base = mkdtempSync(join(tmpdir(), 'team-ask-show-'));
  return base;
}

function place(dir: string, ask = ASK, marker = `${MARKER}\n`, key = `${VECTOR.key}\n`): void {
  writeFileSync(join(dir, 'ask.txt'), ask);
  writeFileSync(join(dir, 'marker.json'), marker);
  writeFileSync(join(dir, 'key.txt'), key);
}

test('the fixed vector matches the mac the command recomputes', () => {
  const key = Buffer.from(VECTOR.key, 'base64url');
  expect(key.equals(Buffer.alloc(32, 0x42))).toBe(true);
  expect(questionDigest(VECTOR.question)).toBe(VECTOR.digest);
  const body: MarkerBody = {
    v: 1,
    request_id: VECTOR.requestId,
    question_sha256: VECTOR.digest,
    expires_at: VECTOR.expiresAt,
  };
  expect(markerMac(key, body)).toBe(VECTOR.mac);
});

test('a matching marker prints the question and nothing of the key', async () => {
  const dir = root();
  place(dir);
  const io = testIo(dir);
  const code = await runAskShow(
    [VECTOR.requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'],
    io,
  );
  expect(code).toBe(0);
  expect(io.out).toBe('Status?\n');
  expect(io.err).toBe('');
  expect(`${io.out}${io.err}`).not.toContain(VECTOR.key);
  expect(`${io.out}${io.err}`).not.toContain(VECTOR.mac);
});

test('a flipped mac exits 1 and the question is absent', async () => {
  const dir = root();
  place(dir, ASK, `${MARKER.replace(/e"}$/, 'f"}')}\n`);
  const io = testIo(dir);
  const code = await runAskShow(
    [VECTOR.requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'],
    io,
  );
  expect(code).toBe(1);
  expect(io.out).toBe('');
  expect(io.err).toBe('team ask-show: the marker does not verify\n');
  expect(io.err).not.toContain('Status?');
  expect(io.err).not.toContain(VECTOR.key);
  expect(io.err).not.toContain(VECTOR.mac);
});

test('a key generated in the test verifies, and its bytes stay off the streams', async () => {
  const dir = root();
  const key = randomBytes(32);
  const question = 'Generated?';
  const requestId = 'req-generated';
  const body: MarkerBody = {
    v: 1,
    request_id: requestId,
    question_sha256: questionDigest(question),
    expires_at: VECTOR.expiresAt,
  };
  const mac = markerMac(key, body);
  const encoded = key.toString('base64url');
  writeFileSync(join(dir, 'ask.txt'), `TeamCLI signed ask v1\n${JSON.stringify({ question, request_id: requestId })}\n`);
  writeFileSync(join(dir, 'marker.json'), `${JSON.stringify({ ...body, mac })}\n`);
  writeFileSync(join(dir, 'key.txt'), encoded);
  const io = testIo(dir);
  expect(await runAskShow([requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'], io)).toBe(0);
  expect(io.out).toBe('Generated?\n');
  expect(`${io.out}${io.err}`).not.toContain(encoded);
});

test('an ask may carry extra fields', async () => {
  const dir = root();
  const ask = `TeamCLI signed ask v1\n${JSON.stringify({ question: VECTOR.question, request_id: VECTOR.requestId, seat: 'desk' })}\n`;
  place(dir, ask);
  const io = testIo(dir);
  expect(
    await runAskShow([VECTOR.requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'], io),
  ).toBe(0);
  expect(io.out).toBe('Status?\n');
});

test('a missing ask file is one line and not the question', async () => {
  const dir = root();
  place(dir);
  const io = testIo(dir);
  expect(
    await runAskShow([VECTOR.requestId, '--ask', 'missing.txt', '--marker', 'marker.json', '--key', 'key.txt'], io),
  ).toBe(1);
  expect(io.out).toBe('');
  expect(io.err).toBe('team ask-show: the ask file cannot be read\n');
  expect(io.err).not.toContain(VECTOR.key);
});

test('a symlink key cannot be read', async () => {
  const dir = root();
  place(dir);
  symlinkSync(join(dir, 'key.txt'), join(dir, 'key.link'));
  const io = testIo(dir);
  expect(
    await runAskShow([VECTOR.requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.link'], io),
  ).toBe(1);
  expect(io.err).toBe('team ask-show: the key file cannot be read\n');
  expect(io.err).not.toContain(VECTOR.key);
});

test('a key that is not 32 bytes is refused without echoing it', async () => {
  const dir = root();
  place(dir, ASK, `${MARKER}\n`, 'not-a-key\n');
  const io = testIo(dir);
  expect(
    await runAskShow([VECTOR.requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'], io),
  ).toBe(1);
  expect(io.err).toBe('team ask-show: the key is not 32 bytes\n');
  expect(io.err).not.toContain('not-a-key');
});

test('whitespace in the marker does not verify', async () => {
  const dir = root();
  place(dir, ASK, `${MARKER.replace('{"v":1', '{ "v": 1')}\n`);
  const io = testIo(dir);
  expect(
    await runAskShow([VECTOR.requestId, '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'], io),
  ).toBe(1);
  expect(io.err).toBe('team ask-show: the marker does not verify\n');
  expect(io.out).not.toContain('Status?');
});

test('a request id that does not match the marker does not verify', async () => {
  const dir = root();
  place(dir);
  const io = testIo(dir);
  expect(await runAskShow(['req-other', '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'], io)).toBe(1);
  expect(io.out).toBe('');
  expect(io.err).toBe('team ask-show: the marker does not verify\n');
  expect(io.err).not.toContain('Status?');
});

test('a bad invocation exits 2 and prints the usage', async () => {
  const io = testIo(root());
  expect(await runAskShow([], io)).toBe(2);
  expect(io.out).toBe('');
  expect(io.err).toBe(`team ask-show: a request id, --ask, --marker and --key are required\n${USAGE}`);
});
