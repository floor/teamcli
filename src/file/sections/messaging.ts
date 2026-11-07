import { MESSAGING_STORES } from '../../settings/inherit.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { MessagingWords } from '../types.ts';
import type { Section } from './section.ts';

/**
 * Reads one `messaging` map — the file's own, or a seat's — into the words it holds, or an empty
 * map when the key is absent. Only each word's shape is checked here: `store` is one of `first`,
 * `parallel` and `none`. Whether the word loosens or tightens the value in force is the
 * resolver's question (`resolveWordSetting` in `src/settings/resolve.ts`), so a word this reader
 * accepts can still be set aside by the send's chain.
 */
export function readMessaging(entry: YamlEntry | undefined, at: string, check: Check): MessagingWords {
  const fields = check.fields(entry?.value, at, ['store']);
  const store = check.oneOf(fields.get('store'), `${at}.store`, [...MESSAGING_STORES]);
  return store === undefined ? {} : { store };
}

/**
 * The file's own word on the store a send leaves for its seats, when nothing nearer declares
 * one. Non-owner and additive — absent in every file written before it, so it appears in no
 * approval digest and existing approvals still match. A seat's own word is read by the seats
 * section; the entity's and the project's are their policy records, read on the same chain.
 */
export const messaging: Section = {
  name: 'messaging',
  owner: false,
  after: [],
  validate(entry, ctx) {
    return readMessaging(entry, 'messaging', ctx.check);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      store: {
        enum: [...MESSAGING_STORES],
        $comment: 'the store a send leaves for this team\'s seats: first writes the signed record into the recipient\'s folder before the walk wakes it, parallel starts both at once and ends the send only when both settle, none never stores the record (the frame still carries the signed bytes); durability is the safe side, so a level may always tighten toward first and only an entity or project may loosen toward none',
      },
    },
    $comment: 'the team\'s word on message storage; a seat\'s own `messaging` map closes the door for itself',
  },
};
