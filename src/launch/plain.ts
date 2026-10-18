// Text with the terminal taken out of it.
//
// Everything `team` prints that came from a screen — or from any string a caller could build —
// has to survive a terminal that would act on it: an escape sequence in a pane's line, a seat's
// name or a record's reason would move the cursor, clear the screen, or restyle everything after
// it, and an invisible format character would display other words than the string holds, or hide
// them. `plainText` is the one cleaning: escape sequences removed whole, control characters and
// the invisible format characters gone, the line breaks kept. `plainLine` is it with the line
// breaks folded — one line in, one line out — for the fields and the detail lines a record
// writer says. `plainPaneText` is `plainText` plus the per-line cut the pane excerpts use.

/** Strips string sequences (OSC, DCS, APC, PM, SOS) and their payloads in one linear pass.
 *  OSC sequences terminate at BEL (\x07) or ST (7-bit ESC \ or 8-bit C1 \x9c).
 *  DCS, APC, PM and SOS sequences terminate only at ST (7-bit ESC \ or 8-bit C1 \x9c).
 *  An unterminated sequence drops everything to the end of the text. */
export function stripControlStrings(text: string): string {
  const slices: string[] = [];
  let plainStart = 0;
  // States: 0: PLAIN, 1: PLAIN_ESC, 2: IN_OSC, 3: IN_OSC_ESC, 4: IN_OTHER, 5: IN_OTHER_ESC
  let state = 0;
  let escCount = 0;

  // Invariant, both halves:
  // - No output character comes from inside a string sequence.
  // - No plain input character outside every sequence is missing from the scanner's output.
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    switch (state) {
      case 0: // PLAIN
        if (c === '\x1b') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 1;
          escCount = 1;
        } else if (c === '\x9d') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 2;
        } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 4;
        }
        break;
      case 1: // PLAIN_ESC
        if (c === ']') {
          state = 2;
          escCount = 0;
        } else if (c === 'P' || c === 'X' || c === '^' || c === '_') {
          state = 4;
          escCount = 0;
        } else if (c === '\x1b') {
          escCount++;
        } else if (c === '\x9d') {
          // Drop pending ESC: it was followed by a string opener and must not reach across the removed string.
          state = 2;
          escCount = 0;
        } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
          // Drop pending ESC: it was followed by a string opener and must not reach across the removed string.
          state = 4;
          escCount = 0;
        } else {
          slices.push('\x1b'.repeat(escCount));
          escCount = 0;
          plainStart = i;
          state = 0;
        }
        break;
      case 2: // IN_OSC
        if (c === '\x07' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          state = 3;
        }
        break;
      case 3: // IN_OSC_ESC
        if (c === '\\' || c === '\x07' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          // stay in 3 (IN_OSC_ESC)
        } else {
          state = 2;
        }
        break;
      case 4: // IN_OTHER
        if (c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          state = 5;
        }
        break;
      case 5: // IN_OTHER_ESC
        if (c === '\\' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          // stay in 5 (IN_OTHER_ESC)
        } else {
          state = 4;
        }
        break;
    }
  }

  if (state === 0) {
    if (plainStart === 0 && slices.length === 0) return text;
    if (plainStart < text.length) slices.push(text.slice(plainStart));
  } else if (state === 1) {
    slices.push('\x1b'.repeat(escCount));
  }
  return slices.join('');
}

/** A string as it is safe to print: every escape sequence is removed whole — a CSI's private
 *  parameters among them, and the payload of a string sequence (OSC, DCS, APC, PM, SOS),
 *  whichever introducer and terminator are mixed, 7-bit `ESC x` or its one-byte C1 form, `ESC \`
 *  or C1 ST, or BEL to close an OSC; one left unterminated goes to the end of the text — and the
 *  characters the rule below names. The line breaks are kept: a multi-line detail stays
 *  multi-line.
 *
 *  The rule, so that no list of characters is the definition and no code point has to be
 *  re-audited into it: every C0 and C1 control character, every character of Unicode category
 *  Cf, Zl and Zp, and the whole tag block U+E0000–U+E007F is removed or folded. LF is the fold
 *  target, not a removal: the line and paragraph separators U+2028 (Zl) and U+2029 (Zp) become
 *  LF on the spot, so `plainLine` folds any of the three exactly as it folds a line feed, and a
 *  field's bytes are the same wherever they are shown or written.
 *  - The variation selectors stay, on purpose: U+FE00–U+FE0F and U+E0100–U+E01EF only choose how
 *    the character before them is drawn — they never show other words than the string holds — so
 *    they are carried through whatever a category table says (both runtimes here report U+FE0E,
 *    U+FE0F and U+E0100 `Cf` false and `Mn` true).
 *  - The tag block is removed whole because a category test alone would leave its edges:
 *    U+E0000 and U+E001F are unassigned, not `Cf`.
 *  - U+200D is not an exception: removing it splits an emoji joined with it into the characters
 *    the string actually holds — the joiner is invisible, the parts are what the string says.
 *    Accepted.
 *
 *  The C0/C1 line is the rule read directly: every C0 (U+0000–U+001F) and C1 (U+007F–U+009F)
 *  control goes, LF alone left for the fold. */
function unescapeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(lt|gt|amp);/g, (entity) => {
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    return '&';
  });
}

export function plainText(text: string): string {
  return unescapeHtmlEntities(
    stripControlStrings(
      text
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        // A one-byte C1 CSI may be written as its introducer plus the 7-bit tail, `\x9b[2J`: the
        // `[` belongs to the mangled sequence, and the whole of it goes, not the introducer alone.
        .replace(/\x9b\[?[0-?]*[ -/]*[@-~]/g, ''),
    )
      .replace(/\x1b./g, '')
      // The line separators folded to the line feed, before anything else looks at a line break.
      .replace(/[\p{Zl}\p{Zp}]/gu, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
      // The Cf characters and the tag block whole; the exception is named as a constant below so it
      // holds whatever a Unicode table calls the selectors.
      .replace(/[\p{Cf}\u{e0000}-\u{e007f}]/gu, (character) => (VARIATION_SELECTOR.test(character) ? character : '')),
  );
}

/** The cleaning's one named exception: the variation selectors choose how the character before
 *  them is drawn and nothing else. Both runtimes' tables put them in category `Mn`, so the `Cf`
 *  rule reaches none of them; the exception keeps that true even if a table were to change. */
const VARIATION_SELECTOR = /[\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u;

/** `plainText` with the line breaks folded: one line in, one line out, whatever the caller
 *  built. A run of line feeds becomes one space — every word stays, the field is never cut —
 *  so a record's field or a detail line can never open a second physical line. */
export function plainLine(text: string): string {
  return plainText(text).replace(/\n+/g, ' ');
}

/** Pane text as it is safe to show (`plainText`), each line cut to `limit` characters. Pane text
 *  is the one text `team` says that it did not write itself: a carriage return in it would
 *  overwrite the report that carries it. */
export function plainPaneText(text: string, limit = 200): string {
  return plainText(text)
    .split('\n')
    .map((line) => (line.length > limit ? `${line.slice(0, limit)}…` : line))
    .join('\n');
}
