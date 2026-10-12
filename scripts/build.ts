// Builds dist/ from a clean slate: removes dist/ first, so a file left by an
// older build can never end up in a packed or globally installed tarball (a
// clone that had built another branch once packed 183 entries instead of 169).
// Then tsc, then the profile YAMLs, so nothing POSIX-only stays in the build.
//
//   bun run build
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

rmSync('dist', { recursive: true, force: true });

const tsc = spawnSync('bun', ['run', 'tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (tsc.error !== undefined) {
  exit(`build: cannot run tsc: ${tsc.error.message}`, 2);
}
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

mkdirSync(join('dist', 'profiles'), { recursive: true });
for (const name of readdirSync(join('src', 'profiles'))) {
  if (name.endsWith('.yaml')) {
    copyFileSync(join('src', 'profiles', name), join('dist', 'profiles', name));
  }
}
