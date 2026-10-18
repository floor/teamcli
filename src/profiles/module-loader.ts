// A profile module, loaded by the one rule both module keys share: `screen_module` and
// `compose_module` name a file inside the profiles directory, never one anywhere else. The
// refusals throw the profile's own YamlError, at the line that named the module.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YamlError } from '../yaml.ts';

const require = createRequire(import.meta.url);

/**
 * The module a profile key names, required into this process. The path rules are closed:
 * relative, inside the profiles directory, a script extension, and no symlink that leads out.
 * The module is trusted package code; the caller reads only the exports it expects.
 */
export function loadProfileModule(
  specifier: string,
  baseDir: string | undefined,
  line: number,
  profileFile: string | null | undefined,
  key: string,
): any {
  const label = profileFile ? `profile "${profileFile}"` : 'profile';

  // 1. Refuse empty string
  if (!specifier || specifier.trim() === '') {
    fail(line, `${label}: "${key}" cannot be an empty string`);
  }

  // 2. Refuse current directory "."
  if (specifier === '.' || specifier === './' || specifier === '.\\') {
    fail(line, `${label}: "${key}" cannot be current directory "."`);
  }

  // 3. Refuse absolute path
  if (isAbsolute(specifier) || specifier.startsWith('/') || specifier.startsWith('\\')) {
    fail(line, `${label}: "${key}" cannot be an absolute path: "${specifier}"`);
  }

  // 4. Refuse home directory path
  if (specifier.startsWith('~')) {
    fail(line, `${label}: "${key}" cannot be a home directory path: "${specifier}"`);
  }

  // 5. Refuse URL or other scheme
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    fail(line, `${label}: "${key}" cannot be a URL or scheme: "${specifier}"`);
  }

  // 6. Refuse ".." segment
  if (specifier.split(/[/\\]/).includes('..') || /%2[eE]%2[eE]/.test(specifier)) {
    fail(line, `${label}: "${key}" cannot contain ".." segments: "${specifier}"`);
  }

  const defaultDir = fileURLToPath(new URL('.', import.meta.url));
  const dir = baseDir ? resolve(baseDir) : defaultDir;
  const resolvedDir = resolve(dir);

  // 7. Refuse paths in the project outside profiles
  const projectSegments = ['test', 'src', 'dist', 'scripts', 'examples', 'node_modules', 'worktrees', '.github'];
  const stripped = specifier.replace(/^(?:\.[/\\])+/, '');
  const firstSegment = stripped.split(/[/\\]/)[0] ?? '';
  if (
    projectSegments.includes(firstSegment) ||
    (existsSync(resolve(process.cwd(), specifier)) && !resolve(process.cwd(), specifier).startsWith(resolvedDir + sep))
  ) {
    fail(line, `${label}: "${key}" cannot be a path in the project: "${specifier}"`);
  }

  // 8. Must resolve inside profiles directory
  let target = resolve(resolvedDir, specifier);
  if (!target.startsWith(resolvedDir + sep) && target !== resolvedDir) {
    fail(line, `${label}: "${key}" must resolve inside profiles directory: "${specifier}"`);
  }

  // Check if target exists and if it is a directory or symlink loop
  let st;
  try {
    st = statSync(target);
  } catch (err: any) {
    if (err && err.code === 'ELOOP') {
      fail(line, `${label}: "${key}" contains a symlink loop: "${specifier}"`);
    }
  }

  if (st && st.isDirectory()) {
    fail(line, `${label}: "${key}" cannot be a directory: "${specifier}"`);
  }

  // 9. Refuse bare names or paths without a script extension (.ts, .js, .cjs, .mjs)
  if (!/\.(ts|js|cjs|mjs)$/.test(specifier)) {
    if (!specifier.includes('/') && !specifier.includes('\\') && !/\.[^/\\]+$/.test(specifier)) {
      fail(line, `${label}: "${key}" cannot be a bare name: "${specifier}"`);
    }
    fail(line, `${label}: "${key}" must have a script extension (.ts, .js, .cjs, .mjs): "${specifier}"`);
  }

  let fileTarget = target;
  if (!existsSync(fileTarget)) {
    if (fileTarget.endsWith('.ts') && existsSync(fileTarget.slice(0, -3) + '.js')) {
      fileTarget = fileTarget.slice(0, -3) + '.js';
    } else if (fileTarget.endsWith('.js') && existsSync(fileTarget.slice(0, -3) + '.ts')) {
      fileTarget = fileTarget.slice(0, -3) + '.ts';
    }
  }

  let fileStat;
  try {
    fileStat = statSync(fileTarget);
  } catch (err: any) {
    if (err && err.code === 'ELOOP') {
      fail(line, `${label}: "${key}" contains a symlink loop: "${specifier}"`);
    }
    fail(line, `${label}: cannot load "${key}": Cannot find module "${specifier}"`);
  }

  if (!fileStat.isFile()) {
    if (fileStat.isDirectory()) {
      fail(line, `${label}: "${key}" cannot be a directory: "${specifier}"`);
    }
    fail(line, `${label}: cannot load "${key}": Cannot find module "${specifier}"`);
  }

  // Symlink check: realpath must be inside profiles directory
  let realTarget: string;
  let realDir: string;
  try {
    realTarget = realpathSync(fileTarget);
    realDir = realpathSync(resolvedDir);
  } catch (err: any) {
    if (err && err.code === 'ELOOP') {
      fail(line, `${label}: "${key}" contains a symlink loop: "${specifier}"`);
    }
    fail(line, `${label}: cannot load "${key}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!realTarget.startsWith(realDir + sep) && realTarget !== realDir) {
    fail(line, `${label}: "${key}" symlink leads outside profiles directory: "${specifier}"`);
  }

  try {
    return require(realTarget);
  } catch (error) {
    fail(line, `${label}: cannot load "${key}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}
