import { DELIVERY_LEGS, LEGACY_ORDER_WORDS, type OrderWord } from '../../settings/inherit.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { Section } from './section.ts';

/**
 * Reads one `delivery_order` key — the file's own, or a seat's — into the words it names, or
 * `undefined` when the key is absent. Only the word's shape is checked here: one or more leg
 * words, no duplicates, and the retired `mcp-inbox` alias, which is kept in what this returns
 * (never an error — `team check` names it for removal) and dropped before any walk. Whether the
 * word drops or reorders the order in force, or would add a leg to it, is the resolver's
 * question (`resolveOrderSetting` in src/settings/inherit.ts), so a word this reader accepts can
 * still be set aside by the walk, and a walk never reads a word the level above it could not
 * hold.
 */
export function readDeliveryOrder(entry: YamlEntry | undefined, at: string, check: Check): OrderWord[] | undefined {
  if (!entry) return undefined;
  const items = check.list(entry, at);
  if (items.length === 0) {
    const node = entry.value;
    // A written key with nothing under it is a word with no legs, and a walk that honoured it
    // would deliver nothing to anyone. It is refused rather than read as "declare nothing": the
    // default order is the absence of the key, and that is what a file leaves out.
    if (node.kind === 'seq' || (node.kind === 'scalar' && node.value === null)) {
      check.fail(node.line, `${at} needs at least one leg: ${DELIVERY_LEGS.join(', ')}`);
    }
    return undefined;
  }
  const words: OrderWord[] = [];
  const seen = new Set<string>();
  const known = [...DELIVERY_LEGS, ...LEGACY_ORDER_WORDS] as readonly string[];
  for (const item of items) {
    if (!known.includes(item.value)) {
      check.fail(item.line, `${at} "${item.value}" must be one of: ${DELIVERY_LEGS.join(', ')}`);
      continue;
    }
    if (seen.has(item.value)) {
      check.fail(item.line, `${at} names "${item.value}" twice`);
      continue;
    }
    seen.add(item.value);
    words.push(item.value as OrderWord);
  }
  return words.length > 0 ? words : undefined;
}

/**
 * The file's own word on the delivery order: the order every send to one of its seats walks
 * when nothing closer declares one. Non-owner and additive — absent in every file written
 * before it, so it appears in no approval digest and existing approvals still match. A seat's
 * own word is read by the seats section; the project's and the entity's are the registry's
 * (`src/send/delivery.ts` reads the three).
 */
export const deliveryOrder: Section = {
  name: 'delivery_order',
  owner: false,
  after: [],
  validate(entry, ctx) {
    return readDeliveryOrder(entry, 'delivery_order', ctx.check) ?? null;
  },
  schema: {
    type: 'array',
    minItems: 1,
    uniqueItems: true,
    items: { enum: DELIVERY_LEGS },
    $comment: 'the legs a send may walk: socket, native, typed, drop, headless-resume, session; the order in force when nothing declares one is typed, drop, and a level may drop or reorder those legs and may add socket, native, headless-resume or session; mcp-inbox is a retired name this schema no longer accepts for new words — a file that still names it is read and the word is dropped from the order, never an error, and team check asks for its removal',
  },
};
