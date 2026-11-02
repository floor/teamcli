// Fixture folders are removed through the platform's own trash command when it is on PATH, the
// way every suite here has always removed them. A machine without one — the hosted CI runners
// carry no `trash` — falls back to a direct removal, strictly bounded to the temporary folder
// (and, where a suite names it, that suite's own scratch root): a fallback that could remove an
// arbitrary path is worse than the leak it prevents.
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/** Whether `path` really stands inside `base`, read through any symlink on either side: a link
 *  that leads out of the base is refused rather than followed. */
function inside(base: string, path: string): boolean {
  const target = settled(path);
  const from = relative(settled(base), target);
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
}

/** The path as it really stands, or as written when it is already gone. */
function settled(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` stands inside the temporary folder or inside one of the suite's own declared
 *  scratch roots. Nothing else is ever removed by the fallback: a root names the only other
 *  folder a suite is allowed to delete in, and the root itself is not a fixture. */
function allowed(path: string, roots: readonly string[]): boolean {
  return inside(tmpdir(), path) || roots.some((root) => inside(root, path));
}

/** Whether the path is there to remove; a folder already gone is nothing to remove. */
function stands(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw failure;
  }
}

/** Remove fixture folders after a test: one trash call for the whole list when the command is
 *  on PATH, otherwise one guarded removal per folder. `quiet` keeps a trash that ran but refused
 *  a folder from failing a cleanup that never failed the test before. `roots` names the suite's
 *  own scratch folders for fixtures that deliberately live outside the temporary folder (the
 *  fixture worlds hold client keys, which the product refuses inside os.tmpdir()). A folder that
 *  is already gone is nothing to remove. */
export function discardFixtures(
  paths: readonly string[],
  options: { quiet?: boolean; roots?: readonly string[] } = {},
): void {
  const list = paths.filter((path) => path !== '' && stands(path));
  if (list.length === 0) return;
  try {
    execFileSync('trash', list, { timeout: 20_000 });
    return;
  } catch (failure) {
    // The command itself missing is the case this fallback exists for; any other failure is
    // trash's own answer and is left to the caller, as it was before.
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (options.quiet === true) return;
      throw failure;
    }
  }
  for (const path of list) {
    if (!allowed(path, options.roots ?? [])) {
      throw new Error(`refusing to remove ${path}: it is not inside the temporary folder ${tmpdir()} or a declared fixture root`);
    }
    rmSync(path, { recursive: true, force: true });
  }
}
