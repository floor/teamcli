// A later file in the same bun test process must read the machine's home, not a fixture's.
// test/default-home.test.ts and test/dev-mode-authority-home.test.ts mock node:os at module load;
// Bun keeps a module mock for the life of the process, so a file that does not put the real lookup
// back leaves later files reading a synthetic home: '' from the first, a removed temp folder from
// the second. The home is read through the product's own module, the way a later test file does;
// a direct node:os read did not show the leak on this runner (measured with bun 1.4.2).
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { developmentModePath } from '../src/development_mode.ts';

test('a later file reads the machine home, not a removed fixture home', () => {
  const path = developmentModePath();
  expect(isAbsolute(path)).toBe(true);
  expect(existsSync(resolve(path, '..', '..', '..'))).toBe(true);
});
