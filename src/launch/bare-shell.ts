// Readable proof that a pane is a bare shell at an empty prompt, for a close that has no CLI
// profile to read the screen with (the restore's labelled leftovers). The process reading says
// only the shell is in front; this says the shell holds no pending input.
//
// Only one shape is proof: the shell's primary prompt alone on the last line — the glyph and
// nothing after it but spaces — with the folder line the shell prints above it (a path from `~`
// or `/`, as the panes on this machine show: `~/Code/floor/md3.io main *1 ?1` then `❯`). A
// continuation prompt (`>`), a glyph closing typed text (`❯ echo #`, `❯ cat >`), no text, or any
// other shape is not proof, and the caller leaves the pane alone.
import { plainText } from './plain.ts';

/** The primary prompt glyphs. `>` is the shell's continuation prompt and is never one. */
const PRIMARY = new Set(['❯', '$', '%', '#']);

export function bareShellEmptyPrompt(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const lines = plainText(text).split('\n').map((line) => line.replace(/\s+$/u, '')).filter((line) => line.trim() !== '');
  if (lines.length < 2) return false;
  const prompt = lines[lines.length - 1]!;
  const folder = lines[lines.length - 2]!;
  // The prompt line is the glyph alone, at the line's start, as the shell draws it.
  if (!PRIMARY.has(prompt)) return false;
  // The line above names the folder the shell stands in.
  return /^(~|\/)/u.test(folder);
}
