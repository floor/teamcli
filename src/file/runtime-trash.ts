// When the system Trash cannot be reached, a retired path is moved here and left for the owner.
// The folder is dated, the same shape as a runtime/legacy/<date> hold: nothing is unlinked.
// Emptying it is the owner's act, named in the report.

import { existsSync, mkdirSync, renameSync } from 'node:fs';
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

/** Moves `path` into the dated runtime trash. The source is renamed, never unlinked. */
export function parkInRuntimeTrash(path: string, home: string, now: Date): { to: string; dated: string } {
  const dated = runtimeTrashFolder(home, now);
  mkdirSync(dated, { recursive: true, mode: 0o700 });
  const name = basename(path);
  let to = join(dated, name);
  for (let n = 2; existsSync(to); n += 1) to = join(dated, `${name}-${n}`);
  renameSync(path, to);
  return { to, dated };
}
