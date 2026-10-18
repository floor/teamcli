import { SENDER_NAME_MODES, type SenderNameMode } from '../../settings/inherit.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { Section } from './section.ts';

/**
 * Reads one `sender_name` key — the file's own, or a seat's — into the word it names, or
 * `undefined` when the key is absent. Only the word's shape is checked here: one of `auto`,
 * `nickname`, `seat` and `seat@team`. What the word means for a headline is the reading's
 * question (`src/send/names.ts`), so a word this reader accepts still reads as `auto` where
 * nothing below it declares one.
 */
export function readSenderName(entry: YamlEntry | undefined, at: string, check: Check): SenderNameMode | undefined {
  return check.oneOf(entry, at, [...SENDER_NAME_MODES]);
}

/**
 * The file's own word on how a sender reads in TeamCLI's headlines: the name the team's
 * commands print for a sender when nothing closer declares one. Non-owner and additive — absent
 * in every file written before it, so it appears in no approval digest and existing approvals
 * still match. A seat's own word is read by the seats section; the project's is the registry
 * record's (`src/send/names.ts` reads the chain).
 *
 * The word is presentation, not permission: the registry id stays in every record, and only the
 * human headline changes.
 */
export const senderName: Section = {
  name: 'sender_name',
  owner: false,
  after: [],
  validate(entry, ctx) {
    return readSenderName(entry, 'sender_name', ctx.check) ?? null;
  },
  schema: {
    enum: [...SENDER_NAME_MODES],
    $comment: 'how a sender reads in TeamCLI headlines: auto (the nickname inside its own team, seat@team from another), nickname, seat, or seat@team; the registry id stays in every record, and the default is auto',
  },
};
