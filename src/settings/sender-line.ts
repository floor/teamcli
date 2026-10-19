// The `sender-line` policy's words: a typed wake opens with a line naming the message's sender,
// `From <seat>@<team>:` ahead of the instruction it carries. `on` is the shipped format; a level
// may set its own one-line format instead, as long as both `{seat}` and `{team}` are in it. The
// line is an enforced floor — a wake that cannot name its sender is not typed nameless — so
// `off` is not a value: the format decides the words, never whether the name is there.
//
// This module holds only the vocabulary: the catalogue reads its parser without importing the
// resolver back into itself, the same split `seat-numbering` keeps between `settings/inherit.ts`
// and the chain reader beside it.

/** The floor's own word: the shipped format below. */
export const SENDER_LINE_ON = 'on';

/** The shipped format: `From <seat>@<team>:` ahead of the wake's instruction. */
export const SENDER_LINE_DEFAULT = 'From {seat}@{team}:';

/** The only slots a format may carry; everything else is literal text. */
const SLOT = /\{(?:seat|team)\}/g;

/**
 * Parses a `sender-line` value into its canonical form: `on` (or `true`) for the shipped format,
 * or a trimmed one-line format that names both `{seat}` and `{team}` and uses no other braces.
 * `off` and `false` are refused: the line is a floor, not a switch.
 */
export function parseSenderLineValue(raw: unknown): string | null {
  if (raw === true) return SENDER_LINE_ON;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === SENDER_LINE_ON) return SENDER_LINE_ON;
  if (text === '' || text === 'off' || text === 'false') return null;
  if (/[\r\n]/.test(text)) return null;
  if (!text.includes('{seat}') || !text.includes('{team}')) return null;
  // Any brace left once the two known slots are taken out is a slot this policy does not have.
  if (/[{}]/.test(text.replace(SLOT, ''))) return null;
  return text;
}

/** Why a raw value is not a `sender-line` value, in the words `team policy set` refuses it with. */
export function senderLineValueProblem(raw: unknown): string | null {
  if (parseSenderLineValue(raw) !== null) return null;
  if (raw === false) return 'the sender line is a floor: a wake always names its sender';
  if (typeof raw !== 'string') {
    return 'the sender line value must be "on" or a one-line format naming {seat} and {team}';
  }
  const text = raw.trim();
  if (text === 'off' || text === 'false') {
    return 'the sender line is a floor: a wake always names its sender, so it cannot be turned off';
  }
  if (text === '' || /[\r\n]/.test(text)) return 'the sender line format must be one non-empty line';
  if (!text.includes('{seat}') || !text.includes('{team}')) {
    return 'the sender line format must name both {seat} and {team}';
  }
  return 'the sender line format may use only the {seat} and {team} slots';
}

/** The format a resolved value asks for; `on`, an unreadable value or no value is the shipped one. */
export function senderLineFormatOf(value: unknown): string {
  const parsed = parseSenderLineValue(value);
  return parsed === null || parsed === SENDER_LINE_ON ? SENDER_LINE_DEFAULT : parsed;
}

/** The wake's opening line: the format with the signed sender's own identity in its slots. */
export function renderSenderLine(format: string, sender: { seat: string; team: string }): string {
  return format.replaceAll('{seat}', sender.seat).replaceAll('{team}', sender.team);
}
