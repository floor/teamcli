// Control characters stay in the drop file. The pane receives the trigger line only, so a
// raw ESC, NUL, or newline from the body never becomes keystrokes. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';

const BODY = 'PAYLOAD\n\x1b[31m\x00\x07\rEND';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});
