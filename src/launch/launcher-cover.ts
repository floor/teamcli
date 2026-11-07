// Launcher files sit beside the team state, where any same-user process can write them.
// The approval digest is the owner's cover: a flag-on launch runs them only when the
// stored digest is the bytes on disk now. Flag off never reads this.
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../approve/fingerprint.ts';

export const LAUNCHER_UNAPPROVED =
  'the launcher files are not in the approval; re-sign the team file before --resolve-launch';
export const LAUNCHER_CHANGED =
  'a launcher file changed since approval; re-sign the team file before --resolve-launch';
export const LAUNCHER_NOT_REGULAR =
  'a launcher file is not a regular file the approval can cover';

export type LauncherCover =
  | { ok: true; present: boolean; digest: string }
  | { ok: false; message: string };

/** The cover of `.agents/launchers/*.yaml`. A missing directory is not present. A name that
 *  is not a regular file is a refusal: the digest never follows a link. */
export function readLauncherCover(root: string): LauncherCover {
  const dir = join(root, '.agents', 'launchers');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, present: false, digest: digestOf([]) };
    }
    return { ok: false, message: LAUNCHER_NOT_REGULAR };
  }
  const files: { name: string; text: string }[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith('.yaml')) continue;
    const text = readRegular(join(dir, name));
    if (text === null) return { ok: false, message: LAUNCHER_NOT_REGULAR };
    files.push({ name, text });
  }
  return { ok: true, present: true, digest: digestOf(files) };
}

/** The line a flag-on launch refuses on, or null when the stored digest is the live bytes. */
export function launcherCoverRefusal(
  root: string,
  sections: Record<string, string> | undefined,
): string | null {
  const cover = readLauncherCover(root);
  if (!cover.ok) return cover.message;
  const approved = sections?.launchers;
  if (approved === undefined) return LAUNCHER_UNAPPROVED;
  if (!cover.present || approved !== cover.digest) return LAUNCHER_CHANGED;
  return null;
}

/** The approval the owner is signing, with the launcher digest added when the directory
 *  is there. A missing directory leaves the approval as it was, so a team with no launchers
 *  keeps the digest it has today. */
export function withLauncherCover<T extends { fingerprints: { sections: Record<string, string> } }>(
  approval: T,
  root: string,
): T {
  const cover = readLauncherCover(root);
  if (!cover.ok || !cover.present) return approval;
  return {
    ...approval,
    fingerprints: {
      ...approval.fingerprints,
      sections: { ...approval.fingerprints.sections, launchers: cover.digest },
    },
  };
}

function digestOf(files: readonly { name: string; text: string }[]): string {
  return createHash('sha256').update(canonical(files)).digest('hex');
}

function readRegular(path: string): string | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
