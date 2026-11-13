// Two sends that overlap on one native seat. send.test.ts checks that only one trigger is
// typed. This checks the drop files: the body that was written stays whole, and the other
// body is not spliced in. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { recordBody } from './helpers.ts';
import { dropDir, fake, filed, owner, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});
