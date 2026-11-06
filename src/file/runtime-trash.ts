// When the system Trash cannot be reached, a retired path is moved here and left for the owner.
// The folder is dated, the same shape as a runtime/legacy/<date> hold: nothing is unlinked.
// Emptying it is the owner's act, named in the report.

import { existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runtimeDir } from '../daemon/paths.ts';

/** The dated folder under the team's runtime trash: `<runtime>/trash/<YYYY-MM-DD>`. */
export function runtimeTrashFolder(home: string, now: Date): string {
  return join(runtimeDir(home), 'trash', now.toISOString().slice(0, 10));
}

/** What the owner is told to do with a dated folder once they mean to empty it. */
export function runtimeTrashEmptyLine(dated: string): string {
  return `empty it by removing the dated folder ${dated}`;
}

/** Why a park stopped: the dated folder is named, and so is the repair. A raw code is not. */
export function runtimeTrashRefusedLine(dated: string): string {
  return `refusing to park in ${dated}: the path is not a real directory. ${runtimeTrashEmptyLine(dated)}`;
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

function notADirectory(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOTDIR';
}

/** `runtime/`, `trash/`, and the dated folder are read with `lstat`. A link at any of them would
 *  let the rename land outside the runtime tree, so the park stops before it creates or moves. */
function refuseLinkedLevel(level: string, dated: string): void {
  let held;
  try {
    held = lstatSync(level);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (held.isSymbolicLink() || !held.isDirectory()) throw new Error(runtimeTrashRefusedLine(dated));
}

/** Moves `path` into the dated runtime trash. The source is renamed, never unlinked. */
export function parkInRuntimeTrash(path: string, home: string, now: Date): { to: string; dated: string } {
  const dated = runtimeTrashFolder(home, now);
  const runtime = runtimeDir(home);
  refuseLinkedLevel(runtime, dated);
  refuseLinkedLevel(join(runtime, 'trash'), dated);
  refuseLinkedLevel(dated, dated);
  try {
    mkdirSync(dated, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (notADirectory(error)) throw new Error(runtimeTrashRefusedLine(dated));
    throw error;
  }
  const name = basename(path);
  let to = join(dated, name);
  for (let n = 2; existsSync(to); n += 1) to = join(dated, `${name}-${n}`);
  try {
    renameSync(path, to);
  } catch (error) {
    if (notADirectory(error)) throw new Error(runtimeTrashRefusedLine(dated));
    throw error;
  }
  return { to, dated };
}
