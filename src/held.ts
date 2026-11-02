import { lstatSync } from 'node:fs';

/** What one path holds, read with `lstat` so a link is a link and never followed: `missing` when
 *  nothing is there, else the kind with its mode and owner. One reading shared by the writer, the
 *  checks and the before-Enter look — there is no second way to look at these files. */
export type Held =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'fifo' }
  | { kind: 'folder'; mode: number; uid: number }
  | { kind: 'file'; mode: number; uid: number }
  | { kind: 'other' };

/** What `path` holds right now, without following anything. */
export function heldAt(path: string): Held {
  let held;
  try {
    held = lstatSync(path);
  } catch {
    return { kind: 'missing' };
  }
  if (held.isSymbolicLink()) return { kind: 'link' };
  if (held.isFIFO()) return { kind: 'fifo' };
  if (held.isDirectory()) return { kind: 'folder', mode: held.mode & 0o777, uid: held.uid };
  if (held.isFile()) return { kind: 'file', mode: held.mode & 0o777, uid: held.uid };
  return { kind: 'other' };
}

/**
 * Why one reading of a path cannot serve as a folder the state ladder or a lock may write in,
 * or null when nothing is there yet (the caller creates it) or it is this user's real folder.
 * A link is never followed, a FIFO is never opened, and a folder another user owns is never
 * written into: the same rule everywhere a folder below a trusted root is checked.
 */
export function folderProblem(held: Held, label = 'state'): string | null {
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind !== 'folder') return `the ${label} folder path is not a directory`;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's folder";
  return null;
}

/** {@link folderProblem} for a path, read with `lstat` first. */
export function folderProblemAt(path: string, label = 'state'): string | null {
  return folderProblem(heldAt(path), label);
}
