import { DELIVERY_LEGS, type DeliveryLeg } from '../../settings/inherit.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { Section } from './section.ts';

/**
 * Reads one `delivery_order` key — the file's own, or a seat's — into the legs it names, or
 * `undefined` when the key is absent. Only the word's shape is checked here: one or more leg
 * words, no duplicates. Whether the word drops or reorders the order in force, or would add a
 * leg to it, is the resolver's question (`resolveOrderSetting` in src/settings/inherit.ts), so
 * a word this reader accepts can still be set aside by the walk, and a walk never reads a word
 * the level above it could not hold.
 */
export function readDeliveryOrder(entry: YamlEntry | undefined, at: string, check: Check): DeliveryLeg[] | undefined {
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
  const legs: DeliveryLeg[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!(DELIVERY_LEGS as readonly string[]).includes(item.value)) {
      check.fail(item.line, `${at} "${item.value}" must be one of: ${DELIVERY_LEGS.join(', ')}`);
      continue;
    }
    if (seen.has(item.value)) {
      check.fail(item.line, `${at} names "${item.value}" twice`);
      continue;
    }
    seen.add(item.value);
    legs.push(item.value as DeliveryLeg);
  }
  return legs.length > 0 ? legs : undefined;
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
    $comment: 'the legs a send may walk, outermost first: native, mcp-inbox, typed, drop; a level may drop or reorder the legs in force and may never add one',
  },
};
