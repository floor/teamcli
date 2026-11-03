// The build writes next to the sources (`tsc -p tsconfig.build.json`), so it cannot
// target a temp folder. This checks the mode step on a temp package instead.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markBinExecutable, preserveExecutableOutputs } from '../scripts/build.ts';

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

test('preserveExecutableOutputs keeps an execute bit the compiler dropped, and a shebang', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-build-exec-'));
  try {
    const src = join(root, 'src');
    const out = join(root, 'dist');
    mkdirSync(src);
    mkdirSync(out);
    writeFileSync(join(src, 'tool.ts'), 'export {}\n', { mode: 0o755 });
    writeFileSync(join(out, 'tool.js'), 'export {}\n', { mode: 0o644 });
    writeFileSync(join(out, 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o644 });
    writeFileSync(join(src, 'cli.ts'), '#!/usr/bin/env node\n', { mode: 0o644 });
    writeFileSync(join(out, 'plain.js'), 'export {}\n', { mode: 0o644 });
    const sourceExec = statSync(join(src, 'tool.ts')).mode & 0o111;
    preserveExecutableOutputs(src, out);
    expect(statSync(join(out, 'tool.js')).mode & 0o111).toBe(sourceExec);
    expect(statSync(join(out, 'cli.js')).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, 'plain.js')).mode & 0o777).toBe(0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
