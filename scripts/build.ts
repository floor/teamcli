// Builds dist/ from a clean slate: removes dist/ first, so a file left by an
// older build can never end up in a packed or globally installed tarball (a
// clone that had built another branch once packed 183 entries instead of 169).
// Then tsc, then the profile YAMLs, so nothing POSIX-only stays in the build.
// The bin named by package.json's bin.team is then mode 0o755.
//
//   bun run build
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

/** Makes the file named by package.json `bin.team` mode 0o755. The path is that field. */
export function markBinExecutable(root: string): void {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin?: { team?: unknown } };
  const bin = pkg.bin?.team;
  if (typeof bin !== 'string' || bin === '') {
    throw new Error('build: package.json has no bin.team');
  }
  chmodSync(join(root, bin), 0o755);
}

function build(): void {
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
    if (name.endsWith('.yaml') || name.endsWith('.json')) {
      copyFileSync(join('src', 'profiles', name), join('dist', 'profiles', name));
    }
  }

  try {
    markBinExecutable(process.cwd());
  } catch (error) {
    exit(error instanceof Error ? error.message : 'build: cannot mark the bin executable', 2);
  }
}

if (import.meta.main) build();
