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
  'page.title.grant': 'Grant',
  'page.already_registered': 'This Mac is already registered; nothing to do.',
  'page.no_pending': 'No pending requests',
  'page.details': 'Permission details',
  'page.approve_once': 'Approve once',
  'page.always_allow': 'Always allow',
  'page.deny': 'Deny',
  // The approval card (src/client/approval-card.ts): the owner must know instantly what she
  // accepts or rejects, with no extra context. The title is an action verb and its object in plain
  // words; the question is who wants it and why, ending `OK?`; the scope names the team and says
  // whether any permission changes. The card never carries a record field — no raw key, no path,
  // no flag — and these labels for the details stay off it.
  'card.title': '{action}',
  'card.title.several': '{actions}',
  'card.title.approval': 'Approve a request',
  'card.question.approval': 'Approve this request. OK?',
  'card.question.base': '{asker} wants to {what}',
  'card.question.base.they': '{askers} want to {what}',
  'card.question.ok': '{base}. OK?',
  'card.question.ok.for': '{base} for {reason}. OK?',
  'card.question.ok.for.cut': '{base} for {reason} OK?',
  'card.question.anon': '{what}. OK?',
  'card.scope.team': 'Team {team} · no permission change',
  'card.scope.changes': 'Team {team} · {change}',
  'card.scope.changes.many': 'Team {team} · {changes}',
  'card.scope.development-mode': 'This Mac · all teams',
  'card.scope.always': 'always allows this, until revoked',
  'card.scope.always.base': '{base} · always allows this, until revoked',
  'card.scope.deny': 'refused, nothing changes',
  'card.scope.deny.base': '{base} · refused, nothing changes',
  'card.change.team-create': 'creates the team file',
  'card.change.team-import': 'changes the team file',
  'card.change.team-migrate': 'changes the team file',
  'card.change.team-config': 'changes the team file',
  'card.change.team-revoke-approval': 'removes an approval rule',
  'card.change.team-general-grant': 'grants operations to another tool',
  'card.grant.question': 'Approve this request',
  'card.grant.title.grant': 'Issue a grant',
  'card.grant.title.master': 'Issue a master grant',
  'card.grant.title.team': 'Issue a team grant',
  'card.what.team-create': 'create a team',
  'card.what.team-import': 'import the team file',
  'card.what.team-migrate': 'migrate the team',
  'card.what.team-add': 'add a seat',
  'card.what.team-up': 'start the team',
  'card.what.team-send': 'send a message',
  'card.what.team-down': 'stop the team',
  'card.what.team-bus': 'start the bus',
  'card.what.team-revoke-approval': 'revoke an approval rule',
  'card.what.team-forget': 'forget a team record',
  'card.what.team-config': "change the team's record",
  'card.what.team-general-grant': 'issue a general grant',
  'card.what.development-mode': "set the machine's development mode",
  'card.title.development-mode': 'Set the development mode',
  'card.title.development-mode.local-fast': 'Turn on fast local development',
  'card.title.development-mode.pr-per-change': 'Use a pull request for every change',
  'card.title.development-mode.off': 'Turn off fast local development',
  'card.question.development-mode.local-fast': 'Stop asking Touch ID for routine team changes on this Mac. OK?',
  'card.question.development-mode.pr-per-change': 'Ask for a pull request for every team change on this Mac. OK?',
  'card.question.development-mode.off': 'Ask Touch ID again for routine team changes on this Mac. OK?',
  'card.details.request': 'request {id}',
  'card.details.asked_by': 'requested by {asker}',
  'card.details.team': 'team {team}',
  'card.details.root': 'root {root}',
  'card.details.head': 'head {head}',
  'card.details.no_head': 'no head',
  'card.details.created': 'created {at}',
  'card.details.expires': 'expires {at}',
  'card.details.never': 'never',
  'card.details.action': '{action}: {words}',
  'card.details.action_none': '{action}: no arguments',
  'card.details.hash': 'sha256 {hash}',
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
