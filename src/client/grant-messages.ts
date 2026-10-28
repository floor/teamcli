// The owner-facing grant strings: the Touch ID prompt, the grant card and the owner page. One
// catalog keyed by id with `{placeholder}`s, looked up through `msg`, so a later locale is one
// more table. Only `en` exists today.

export type Locale = 'en';

const EN = {
  'prompt.allow': 'Allow {client}{clientId} on team {team}{kind}{actions}.{signer} Expires {expiry}.',
  'prompt.client_id': ' (client {id})',
  'prompt.kind.master': ', MASTER grant',
  'prompt.kind.bundle': ', {bundle} bundle',
  'prompt.actions': ': {list}',
  'prompt.signer': ' Signer: {name}.',
  'prompt.deny': 'Deny: {prompt}',
  'prompt.list.and': '{head} and {last}',
  'op.up_down': 'start/stop (up/down{abandon})',
  'op.up': 'start (up)',
  'op.down': 'stop (down{abandon})',
  'op.abandon_suffix': ', abandon',
  'op.seats': 'manage seats',
  'op.send': 'send to {seats}',
  'op.send_none': 'send to no seat',
  'op.send_count': 'send to {count} seat{plural}',
  'op.read': '{count} read right{plural}',
  'expiry.never': 'no end date (until revoked)',
  'expiry.at': '{day} {month} {year} {hour}:{minute} ({zone})',
  'page.title.master': 'Master grant',
  'page.title.team': 'Team grant',
  'page.title.grant': 'Grant',
  'page.once_only': '{prompt} This grant needs a one-time approval.',
  'page.already_registered': 'This Mac is already registered; nothing to do.',
  'page.no_pending': 'No pending requests',
  'page.details': 'Permission details',
  'page.approve_once': 'Approve once',
  'page.always_allow': 'Always allow',
  'page.deny': 'Deny',
} as const;

export type MessageId = keyof typeof EN;

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageId, string>>>> = { en: EN };

export const MONTHS: Readonly<Record<Locale, readonly string[]>> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/** The message `id` in `locale`, its `{name}` placeholders filled from `vars`. */
export function msg(id: MessageId, vars: Readonly<Record<string, string | number>> = {}, locale: Locale = 'en'): string {
  return CATALOGS[locale][id].replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}
