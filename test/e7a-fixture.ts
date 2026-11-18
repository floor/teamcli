// The level-2 (E7a) source tree as a test fixture (E7b revision 3): extracted from this
// repository's history into a temporary folder, its imports resolved against this checkout's
// node_modules. Null when the history is not at hand (a packed copy, a shallow clone).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');

/** The level-2 build: E7a, the reader switch, installed before E7b. */
export const LEVEL2_COMMIT = 'd8cd0ae3d';

/** The E7a source tree as a fixture, or null when the history is not at hand. */
export function level2Tree(): string | null {
  try {
    execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${LEVEL2_COMMIT}^{commit}`], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'e7a-fixture-')));
  const archive = execFileSync('git', ['-C', REPO, 'archive', LEVEL2_COMMIT, 'src', 'packages', 'package.json'], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  return join(dir, 'src');
}
