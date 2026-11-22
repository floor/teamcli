// Keep the channel pair out of the checkout's untracked files without touching anything that is
// committed. `team mcp setup` writes `.mcp.json` and its setup record into a project checkout;
// neither is tracked, and neither was ignored, so a tool that cleans untracked files (a
// `git clean`, a `git stash -u`) removed them and the lead lost its channel (material, vlist and
// jedi, found 2026-11-16). The repository's own `info/exclude` is local to this clone and never
// committed: a line there makes git treat the files as ignored, and a plain `git clean -f`
// leaves ignored files alone.
//
// No git process is started. The checkout's `.git` is read: a folder is the repository itself; a
// file (`gitdir: <path>`) is a linked worktree, whose `commondir` names the shared repository,
// and `info/exclude` is read from the shared one, as git does.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { appendFileSync, mkdirSync } from '../host/guarded-fs.ts';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The repository folder whose `info/exclude` applies to `cwd`, and `cwd`'s path inside the
 *  checkout's top, or null when `cwd` is not inside a git checkout. */
export function excludeTarget(cwd: string): { gitDir: string; top: string } | null {
  let here = resolve(cwd);
  for (;;) {
    const dot = join(here, '.git');
    let stat;
    try { stat = lstatSync(dot); } catch { stat = null; }
    if (stat !== null) {
      if (stat.isSymbolicLink()) return null;
      if (stat.isDirectory()) return { gitDir: dot, top: here };
      if (stat.isFile()) {
        const line = readFileSync(dot, 'utf8').trim();
        const match = /^gitdir:\s*(.+)$/.exec(line);
        if (!match) return null;
        const worktreeDir = isAbsolute(match[1]!) ? match[1]! : resolve(here, match[1]!);
        const common = join(worktreeDir, 'commondir');
        const gitDir = existsSync(common)
          ? resolve(worktreeDir, readFileSync(common, 'utf8').trim())
          : worktreeDir;
        return { gitDir, top: here };
      }
      return null;
    }
    const up = dirname(here);
    if (up === here) return null;
    here = up;
  }
}

/** The exclude lines for `names` in `cwd`, anchored at the checkout's top. */
export function excludeLines(top: string, cwd: string, names: readonly string[]): string[] {
  const inside = relative(top, resolve(cwd)).split(sep).filter((part) => part !== '').join('/');
  return names.map((name) => `/${inside === '' ? '' : `${inside}/`}${name}`);
}

/**
 * Adds each missing line to the repository's `info/exclude`. Lines already there are left as
 * they are; nothing is removed or reordered. Returns the lines it added, or a reason it could
 * not add them. A folder outside any checkout needs nothing.
 */
export function excludeLocally(cwd: string, names: readonly string[]): { added: string[] } | { skipped: string } {
  const target = excludeTarget(cwd);
  if (target === null) return { skipped: 'the folder is not inside a git checkout' };
  const file = join(target.gitDir, 'info', 'exclude');
  try {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const have = new Set(before.split('\n').map((line) => line.trim()));
    const wanted = excludeLines(target.top, cwd, names).filter((line) => !have.has(line));
    if (wanted.length === 0) return { added: [] };
    mkdirSync(dirname(file), { recursive: true });
    const lead = before === '' || before.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${lead}# team mcp setup: the channel pair stays local and untracked\n${wanted.join('\n')}\n`);
    return { added: wanted };
  } catch (error) {
    return { skipped: `the repository's info/exclude could not be written (${error instanceof Error ? error.message : String(error)})` };
  }
}
