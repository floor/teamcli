// When the system Trash cannot be reached, a retired path is moved here and left for the owner.
// The folder is dated, the same shape as a runtime/legacy/<date> hold: nothing is unlinked.
// Emptying it is the owner's act, named in the report.
//
// The dated folder is opened and checked, and the rename is into that handle, the way a channel
// config is read from the descriptor it just checked. A link swapped in between the check and the
// rename cannot receive the file: the handle still names the directory that was opened.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { machineConfigDir, runtimeDir } from '../daemon/paths.ts';
import { getRelativeDirOps } from '../send/drop-retention.ts';

const DIRECTORY = constants.O_DIRECTORY ?? 0;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// `renameat` ignores this when the source path is absolute. Linux and Darwin number it differently.
const AT_FDCWD = process.platform === 'linux' ? -100 : -2;

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

function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function missing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT';
}

function denied(error: unknown): boolean {
  const code = codeOf(error);
  return code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP';
}

function refuse(dated: string): never {
  throw new Error(runtimeTrashRefusedLine(dated));
}

function errnoDenies(errno: number): boolean {
  const names = osConstants.errno;
  return errno === names.EACCES || errno === names.EPERM || errno === names.ENOTDIR || errno === names.ELOOP;
}

/** `.config`, `.config/team`, `runtime/`, `trash/`, and the dated folder. A link at any of them
 *  would let the rename land outside the runtime tree. A level that is not there yet is created
 *  below, as a real directory. */
function trashLevels(home: string, dated: string): string[] {
  const team = machineConfigDir(home);
  const runtime = runtimeDir(home);
  return [dirname(team), team, runtime, join(runtime, 'trash'), dated];
}

function refuseLinkedLevel(level: string, dated: string): void {
  let held: Stats;
  try {
    held = lstatSync(level);
  } catch (error) {
    if (missing(error)) return;
    if (denied(error)) refuse(dated);
    throw error;
  }
  if (held.isSymbolicLink() || !held.isDirectory()) refuse(dated);
}

/** Opens the dated folder and keeps the descriptor only when it is still the directory just
 *  read. The caller renames into this descriptor and closes it. */
function openDated(dated: string): number {
  let seen: Stats;
  try {
    seen = lstatSync(dated);
  } catch (error) {
    if (denied(error)) refuse(dated);
    throw error;
  }
  if (seen.isSymbolicLink() || !seen.isDirectory()) refuse(dated);
  let fd: number;
  try {
    fd = openSync(dated, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    if (denied(error)) refuse(dated);
    throw error;
  }
  try {
    const now = fstatSync(fd);
    if (now.dev !== seen.dev || now.ino !== seen.ino || !now.isDirectory()) {
      closeSync(fd);
      refuse(dated);
    }
    return fd;
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The refusal below is the open's own.
    }
    if (error instanceof Error && error.message === runtimeTrashRefusedLine(dated)) throw error;
    if (denied(error)) refuse(dated);
    throw error;
  }
}

/** Moves `path` into the dated runtime trash. The source is renamed, never unlinked. */
export function parkInRuntimeTrash(path: string, home: string, now: Date): { to: string; dated: string } {
  const dated = runtimeTrashFolder(home, now);
  for (const level of trashLevels(home, dated)) refuseLinkedLevel(level, dated);
  try {
    mkdirSync(dated, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (denied(error)) refuse(dated);
    throw error;
  }
  const ops = getRelativeDirOps();
  if (ops === null) refuse(dated);
  const fd = openDated(dated);
  try {
    const from = resolve(path);
    const base = basename(path);
    let name = base;
    for (let n = 2; ; n += 1) {
      const moved = ops.renameatExcl(AT_FDCWD, from, fd, name);
      if (moved.ok) return { to: join(dated, name), dated };
      if (moved.errno === osConstants.errno.EEXIST) {
        name = `${base}-${n}`;
        continue;
      }
      if (errnoDenies(moved.errno)) refuse(dated);
      throw new Error(`refusing to park in ${dated}: the move failed`);
    }
  } finally {
    closeSync(fd);
  }
}
