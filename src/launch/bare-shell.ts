// Readable proof that a pane is a bare shell at an empty prompt, for a close that has no CLI
// profile to read the screen with (the restore's labelled leftovers). The process reading says
// only the shell is in front; this says the shell holds no pending input. Anything this cannot
// read as an empty prompt — no text, a prompt with words after it, an unfamiliar shape — is not
// proof, and the caller leaves the pane alone.
import { plainText } from './plain.ts';

/** The prompt glyphs a shell's last line ends with when nothing has been typed. */
const PROMPT_END = /[❯›>$%#]$/u;

export function bareShellEmptyPrompt(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const lines = plainText(text).split('\n').map((line) => line.replace(/\s+$/u, ''));
  const last = [...lines].reverse().find((line) => line.trim() !== '');
  if (last === undefined) return false;
  const trimmed = last.trim();
  // The glyph closes the line: pending input would stand after it.
  if (!PROMPT_END.test(trimmed)) return false;
  // A lone glyph, or a prompt word list ending in one after a space (`dir %`, `user@host $`).
  return trimmed.length === 1 || /\s[❯›>$%#]$/u.test(trimmed);
}
