import { writeAtomic } from '../state.ts';
import type { Problem } from './types.ts';
import { validateTeamFile } from './validate.ts';

/**
 * The one write of a team file. The text is validated first. An invalid edit is refused and
 * the file is left untouched. A valid one is written by a temporary file and a rename.
 */
export function writeTeamFile(
  path: string,
  text: string,
  options: { home?: string; root?: string } = {},
): { ok: true } | { ok: false; errors: Problem[] } {
  const parsed = validateTeamFile(text, { home: options.home, root: options.root });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  writeAtomic(path, text);
  return { ok: true };
}
