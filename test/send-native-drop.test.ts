// The final drop name appears only by rename. The write and the rename are the calls
// `dropMessage` makes on `node:fs`, observed from this test. No live pane.
import * as fs from 'node:fs';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { dropMessage, readTriggerLine } from '../src/send/native.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
let restoreSpies: () => void = () => {};

afterEach(() => {
  restoreSpies();
  restoreSpies = () => {};
  cleanup();
  cleanup = () => {};
});

function use(made: World): World {
  cleanup = made.cleanup;
  return made;
}

test('the final drop name appears only by rename of a whole temporary file', () => {
  const made = use(world());
  const directory = join(made.dir, 'drops');
  mkdirSync(directory);
  const id = 'one';
  const finalPath = join(directory, id);
  const body = `S${'y'.repeat(80)}E`;
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
    if (typeof path !== 'string') throw new Error('the drop write was not a path');
    expect(dirname(path)).toBe(directory);
    expect(path.endsWith('.tmp')).toBe(true);
    expect(path).not.toBe(finalPath);
    expect(existsSync(finalPath)).toBe(false);
    expect(data).toBe(body);
    return realWrite(path, data, options);
  });
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error('the drop rename was not two paths');
    expect(dirname(from)).toBe(directory);
    expect(from.endsWith('.tmp')).toBe(true);
    expect(to).toBe(finalPath);
    expect(existsSync(finalPath)).toBe(false);
    expect(readFileSync(from, 'utf8')).toBe(body);
    return realRename(from, to);
  });
  restoreSpies = () => {
    write.mockRestore();
    rename.mockRestore();
  };

  expect(dropMessage(directory, id, body)).toBe(finalPath);
  expect(write.mock.calls.length).toBe(1);
  expect(rename.mock.calls.length).toBe(1);
  expect(readdirSync(directory)).toEqual([id]);
  expect(readFileSync(finalPath, 'utf8')).toBe(body);
  expect(statSync(finalPath).mode & 0o777).toBe(0o600);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});

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
    // The typed trigger is the seat's own drop read: the line's receipt is the read the send
    // watches for, so the record's path no longer has to fit inside the typed line.
    expect(text).toBe(readTriggerLine('native', 'acme', { seat: 'owner', team: 'acme', body }) as string);
    expect(recordBody(path)).toBe(filed(body));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    seen = true;
    return typeText(session, paneId, text);
  };

  const code = await runSend(['native', body], owner(made.root), host);

  expect(code).toBe(0);
  expect(seen).toBe(true);
  expect(host.frames).toEqual([]);
});
