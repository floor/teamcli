// Builds dist/ from a clean slate: removes dist/ first, so a file left by an
// older build can never end up in a packed or globally installed tarball (a
// clone that had built another branch once packed 183 entries instead of 169).
// Then tsc, then the profile YAMLs, so nothing POSIX-only stays in the build.
// The bin named by package.json's bin.team is then mode 0o755. A compiled file
// whose source was executable, or that starts with a shebang, keeps the execute
// bit, so a seat never has to chmod a binary the build just wrote.
//
//   bun run build
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function walkFiles(dir: string, visit: (path: string) => void): void {
  let names: Dirent[];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walkFiles(path, visit);
    else if (name.isFile()) visit(path);
  }
}

function startsWithShebang(file: string): boolean {
  let handle: number | null = null;
  try {
    handle = openSync(file, 'r');
    const buf = Buffer.alloc(2);
    const read = readSync(handle, buf, 0, 2, 0);
    return read === 2 && buf.toString() === '#!';
  } catch {
    return false;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

/** The compiler writes a new file at mode 644, which drops an execute bit the source had.
 *  That bit is put back on the compiled file. A shebang is a program, so it is executable
 *  even when its source was not marked. A seat never chmods the result. */
export function preserveExecutableOutputs(srcDir: string, outDir: string): void {
  walkFiles(srcDir, (source) => {
    const mode = statSync(source).mode;
    if ((mode & 0o111) === 0) return;
    const rel = relative(srcDir, source).replace(/\.[cm]?tsx?$/, '.js');
    const dest = join(outDir, rel);
    if (!existsSync(dest)) return;
    chmodSync(dest, statSync(dest).mode | (mode & 0o111));
  });
  walkFiles(outDir, (file) => {
    if (!startsWithShebang(file)) return;
    chmodSync(file, statSync(file).mode | 0o755);
  });
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
    preserveExecutableOutputs(join(process.cwd(), 'src'), join(process.cwd(), 'dist'));
    markBinExecutable(process.cwd());
  } catch (error) {
    exit(error instanceof Error ? error.message : 'build: cannot mark the bin executable', 2);
  }
}

if (import.meta.main) build();
