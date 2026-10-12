// The published drop name is the file a reader is allowed to open. A direct write of the
// same size is visible short; the rename must not be. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { runSend } from '../src/commands/send.ts';
import { dropMessage, triggerLine } from '../src/send/native.ts';
import { dropDir, nativeHost, owner, world, type World } from './send-native-fixtures.ts';

// Shared ints: 0 stop, 1 reads of the final name, 2 of those that were short, 3 reader is in its loop.
const READER = `
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
const counts = new Int32Array(workerData.shared);
parentPort.postMessage('ready');
Atomics.store(counts, 3, 1);
while (Atomics.load(counts, 0) === 0) {
  try {
    const text = readFileSync(workerData.finalPath, 'utf8');
    Atomics.add(counts, 1, 1);
    if (text !== workerData.body) Atomics.add(counts, 2, 1);
  } catch {
    // The final name is absent until the rename.
  }
}
parentPort.postMessage('done');
`;

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function use(made: World): World {
  cleanup = made.cleanup;
  return made;
}

function once(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('a reader of the final drop name never sees a short file', async () => {
  const made = use(world());
  const directory = join(made.dir, 'drops');
  mkdirSync(directory);
  const id = 'one';
  const finalPath = join(directory, id);
  const body = `S${'y'.repeat(4_000_000)}E`;
  const shared = new SharedArrayBuffer(16);
  const counts = new Int32Array(shared);
  const worker = new Worker(READER, { eval: true, workerData: { shared, finalPath, body } });
  try {
    expect(await once(worker)).toBe('ready');
    while (Atomics.load(counts, 3) === 0) {}
    expect(dropMessage(directory, id, body)).toBe(finalPath);
    const deadline = Date.now() + 2000;
    while (Atomics.load(counts, 1) === 0 && Date.now() < deadline) {}
    Atomics.store(counts, 0, 1);
    expect(await once(worker)).toBe('done');
    expect(Atomics.load(counts, 1)).toBeGreaterThan(0);
    expect(Atomics.load(counts, 2)).toBe(0);
    expect(readFileSync(finalPath, 'utf8')).toBe(body);
    expect(readdirSync(directory)).toEqual([id]);
    expect(statSync(finalPath).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  } finally {
    Atomics.store(counts, 0, 1);
    await worker.terminate();
  }
}, 20_000);

test('the pane is given the drop path only once that file holds the whole body', async () => {
  const made = use(world());
  const body = `S${'n'.repeat(300)}E`;
  const { host, pane } = nativeHost(made, ['idle', 'working']);
  let seen = false;
  const typeText = pane.typeText.bind(pane);
  pane.typeText = (session, paneId, text) => {
    const drops = dropDir(made.dir);
    const names = readdirSync(drops);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(names.length).toBe(1);
    const path = join(drops, names[0] as string);
    const line = triggerLine(path);
    if (line === null) throw new Error(`no trigger for ${path}`);
    expect(text).toBe(line);
    expect(readFileSync(path, 'utf8')).toBe(body);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    seen = true;
    return typeText(session, paneId, text);
  };

  const code = await runSend(['native', body], owner(made.root), host);

  expect(code).toBe(0);
  expect(seen).toBe(true);
  expect(host.frames).toEqual([]);
});
