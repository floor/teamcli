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
