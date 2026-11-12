// A launch that carries a seat's rules as a file instead of their whole text. The file is named
// by a hash of the text, so the same rules always name the same file, a dry run names the file a
// launch would, and changed rules name a new file: the recorded line still shows a rules change
// as drift, exactly as the inline text did. The files live in TeamCLI's machine folder, the
// owner's alone, never in a checkout. Nothing secret is in them: they are the seat's rules.
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Where the rules files live: `TEAM_RULES_HOME`, or `~/.config/team/rules-text`. */
export function rulesTextHome(): string {
  const set = process.env.TEAM_RULES_HOME;
  return set !== undefined && set !== '' ? set : join(homedir(), '.config', 'team', 'rules-text');
}

/** The file for this text. */
export function rulesTextPath(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 24);
  return join(rulesTextHome(), `${hash}.md`);
}

function ownerFolder(path: string): boolean {
  try {
    const held = lstatSync(path);
    return held.isDirectory() && !held.isSymbolicLink() && (held.mode & 0o077) === 0;
  } catch {
    try {
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }
}

function holds(path: string, text: string): boolean {
  try {
    const held = lstatSync(path);
    return held.isFile() && !held.isSymbolicLink() && held.size === Buffer.byteLength(text);
  } catch {
    return false;
  }
}

/**
 * The path a launch names for these rules, or null when the text goes inline: `TEAM_RULES_INLINE=1`
 * (the test suite's older scenes compare inline lines), or a launch whose file could not be
 * written. A run that launches writes the file first (0600 in a 0700 folder, by a rename, never
 * through a link); a run that only reads a line names the path without writing anything.
 */
export function rulesTextFile(text: string, launching: boolean): string | null {
  if (process.env.TEAM_RULES_INLINE === '1') return null;
  const path = rulesTextPath(text);
  if (!launching || holds(path, text)) return path;
  const home = rulesTextHome();
  if (!ownerFolder(home)) return null;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    writeSync(fd, text);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    return path;
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    return null;
  }
}
