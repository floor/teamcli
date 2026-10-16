// ANSI styling as herdr's `pane read --format ansi` reads it off a pane: the escape sequences
// a CLI wrapped around its text. Matching always runs on the plain form; the styling answers
// one question, the composer's — is the input line's text all dim, a greyed suggestion rather
// than something typed. Nothing here moves the cursor or writes to a pane.
//
// Observed on Claude Code 2.1.289 (test/fixtures/claude-code/2.1.289/README.md): a greyed
// suggestion is `ESC[0m ESC[2m` … `ESC[0m` — faint — while typed text carries no styling at
// all. Faint is the only placeholder style: a colour, however grey it renders, is a colour,
// and reading one as a placeholder was a guess this module no longer makes.

// A CSI sequence (an SGR ends in `m`), or an OSC title string. Visible output holds little
// else, and what it does hold is not text.
const ESCAPES = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// The pen one SGR sequence leaves: faint (`2`; `0` and `22` lift it) and inverse video (`7`; `0` and
// `27` lift it). The extended colours — foreground, background (48), underline (58) — carry their
// payload in sub-parameters (5;n or 2;r;g;b) whose numbers are never the faint or inverse switch.
type Pen = { faint: boolean; inverse: boolean };

function sgrPen(sequence: string, pen: Pen): Pen {
  const params = sequence.slice(2, -1).split(';').map((part) => (part === '' ? '0' : part));
  let { faint, inverse } = pen;
  for (let i = 0; i < params.length; i++) {
    const n = Number(params[i]);
    if (!Number.isInteger(n)) continue;
    if (n === 0) { faint = false; inverse = false; }
    if (n === 22) faint = false;
    if (n === 2) faint = true;
    if (n === 27) inverse = false;
    if (n === 7) inverse = true;
    if (n === 38 || n === 48 || n === 58) {
      const mode = Number(params[i + 1]);
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
    }
  }
  return { faint, inverse };
}

// The faint state one SGR sequence leaves the pen in.
export function sgrDim(sequence: string, faint: boolean): boolean {
  return sgrPen(sequence, { faint, inverse: false }).faint;
}

/** The text of a styled pane read, without its escape sequences. */
export function stripSgr(text: string): string {
  return text.replace(ESCAPES, '');
}

/** Whether the text carries any SGR styling at all — a colour, faint, bold, anything. */
export function hasSgr(text: string): boolean {
  return /\x1b\[[0-9;:]*m/.test(text);
}

/**
 * Whether every visible character after the first `skip` ones is faint, so the line holds a
 * greyed suggestion rather than text. Whitespace is not read, mirroring the typed text the
 * caller trims; an empty remainder is dim, as an empty box is. A character without any
 * styling is plain text, so a plain source answers false and the placeholder list alone
 * decides — the fallback for an herdr without `--format ansi`.
 *
 * One exception: the CLI's cursor. A box that draws its cursor as an inverse-video cell on the
 * first character of its suggestion (cursor-agent does: `P` inverse, then `lan, search…` faint —
 * test/fixtures/exit-typing/cursor-idle-ansi.txt) is still showing a suggestion. Only the first
 * visible character after `skip`, only when it is inverse, and only when all the rest is faint.
 */
export function allDimAfter(styled: string, skip: number): boolean {
  let passed = 0;
  let pen: Pen = { faint: false, inverse: false };
  let cursor = 0;
  // The characters before an escape, then the escape; then the rest after the last one.
  const read = (chunk: string): boolean => {
    for (const ch of chunk) {
      if (/\s/.test(ch)) continue;
      passed++;
      if (passed <= skip || pen.faint) continue;
      if (pen.inverse && passed === skip + 1) continue;
      return false;
    }
    return true;
  };
  for (const match of styled.matchAll(ESCAPES)) {
    if (!read(styled.slice(cursor, match.index))) return false;
    if (match[0].endsWith('m')) pen = sgrPen(match[0], pen);
    cursor = match.index + match[0].length;
  }
  return read(styled.slice(cursor));
}
