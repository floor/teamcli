// The build writes next to the sources (`tsc -p tsconfig.build.json`), so it cannot
// target a temp folder. This checks the mode step on a temp package instead.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markBinExecutable } from '../scripts/build.ts';

test('markBinExecutable sets the owner execute bit on the file bin.team names', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-build-bin-'));
  try {
    const rel = 'out/tool.js';
    mkdirSync(join(root, 'out'));
    const file = join(root, rel);
    writeFileSync(file, '#!/usr/bin/env node\n', { mode: 0o644 });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ bin: { team: rel } }));
    expect(statSync(file).mode & 0o100).toBe(0);
    markBinExecutable(root);
    const mode = statSync(file).mode;
    expect(mode & 0o100).toBe(0o100);
    expect(mode & 0o777).toBe(0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
