// Records a launch writes under a CLI's own home before its pane starts: the folder trust the
// CLI would otherwise ask for, and Grok's sandbox profile. Both are the owner's private files,
// and both refuse to write through a symbolic link — a config file or folder that is a link is
// left untouched, and the caller says what it can instead.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Writes a record under a CLI's home as its owner's private file. */
export function writePrivate(file: string, text: string, home: string): void {
  assertNoLink(file, home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
}

/** The file and each folder under the home are opened as themselves. A link, including
 *  one whose target is absent, is not a path this run reads or writes. */
export function assertNoLink(path: string, home: string): void {
  let current = path;
  while (current.startsWith(`${home}/`)) {
    let linked = false;
    try {
      linked = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (linked) throw new Error('a symbolic link');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** A TOML basic string: the quotes and backslashes a path carries are escaped. */
export function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}
