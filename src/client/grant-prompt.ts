// The short line the owner reads at signing: the macOS Touch ID prompt (which truncates long
// reasons) and the owner page's grant card. The full permission list stays in the terminal and
// inbox text (`pendingSummary(...).text`); this line only names the team, the commands that matter
// (up/down explicitly), the bundle, the signer and the expiry in the owner's local time. Every
// word comes from the message catalog (`grant-messages.ts`).

import { clientDisplayName } from './bundles.ts';
import { MONTHS, msg, type Locale } from './grant-messages.ts';

/** The prompt budget: macOS shows about this much of a reason before it cuts it. */
export const GRANT_PROMPT_MAX = 210;

const SEAT_OPS = new Set(['add', 'remove', 'rename', 'swap', 'restart', 'reload']);

/** `26 Jan 2027 08:22 (Europe/Paris)`, in the machine's own zone (or `timeZone`). */
export function grantExpiry(iso: string | null, timeZone?: string, locale: Locale = 'en'): string {
  if (iso === null) return msg('expiry.never', {}, locale);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return msg('expiry.at', { day: Number(parts.day), month: MONTHS[locale][Number(parts.month) - 1]!, year: parts.year!, hour: parts.hour!, minute: parts.minute!, zone: zone === 'Etc/UTC' ? 'UTC' : zone }, locale);
}

function list(words: readonly string[], locale: Locale): string {
  return words.length <= 1 ? (words[0] ?? '') : msg('prompt.list.and', { head: words.slice(0, -1).join(', '), last: words[words.length - 1]! }, locale);
}

/** `developer` is the `default` bundle's recorded name. */
export function bundleLabel(bundle: string): string {
  return bundle === 'developer' ? 'default' : bundle;
}

export type GrantPromptInput = {
  client: string;
  team: string;
  ops: readonly string[];
  /** Seats `send` reaches; omitted or empty when the grant carries no send. */
  sendSeats?: readonly string[];
  bundle?: string | null;
  master?: boolean;
  expires: string | null;
  signer?: string | null;
};

/** The one-liner, kept under GRANT_PROMPT_MAX by eliding the client id, then the send seats, then the actions. */
export function grantPromptText(input: GrantPromptInput, timeZone?: string, locale: Locale = 'en'): string {
  const ops = new Set(input.ops);
  const label = input.bundle ? bundleLabel(input.bundle) : null;
  const abandon = label === 'default' && ops.has('down') ? msg('op.abandon_suffix', {}, locale) : '';
  const doing: string[] = [];
  if (ops.has('up') && ops.has('down')) doing.push(msg('op.up_down', { abandon }, locale));
  else if (ops.has('up')) doing.push(msg('op.up', {}, locale));
  else if (ops.has('down')) doing.push(msg('op.down', { abandon }, locale));
  if ([...ops].some((op) => SEAT_OPS.has(op))) doing.push(msg('op.seats', {}, locale));
  const seats = input.sendSeats ?? [];
  const sendAt = ops.has('send') ? doing.length : -1;
  if (ops.has('send')) doing.push(seats.length > 0 ? msg('op.send', { seats: list(seats, locale) }, locale) : msg('op.send_none', {}, locale));
  const covered = ['up', 'down', 'send', ...SEAT_OPS];
  const rest = [...ops].filter((op) => !covered.includes(op)).length;
  if (rest > 0 && doing.length === 0) doing.push(msg('op.read', { count: rest, plural: rest > 1 ? 's' : '' }, locale));
  const kind = input.master === true ? msg('prompt.kind.master', {}, locale) : label !== null ? msg('prompt.kind.bundle', { bundle: label }, locale) : '';
  const signer = input.signer ? msg('prompt.signer', { name: input.signer }, locale) : '';
  const expiry = grantExpiry(input.expires, timeZone, locale);
  const name = clientDisplayName(input.client);
  const build = (withId: boolean, parts: string[]) => msg('prompt.allow', {
    client: name,
    clientId: withId ? msg('prompt.client_id', { id: input.client }, locale) : '',
    team: input.team,
    kind,
    actions: parts.length > 0 ? msg('prompt.actions', { list: parts.join(', ') }, locale) : '',
    signer,
    expiry,
  }, locale);
  const counted = [...doing];
  if (sendAt >= 0) counted[sendAt] = msg('op.send_count', { count: seats.length, plural: seats.length > 1 ? 's' : '' }, locale);
  const tries = [build(true, doing), build(false, doing), build(false, counted), build(false, [])];
  return tries.find((t) => t.length <= GRANT_PROMPT_MAX) ?? tries[tries.length - 1]!;
}
