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
  // The approval card (src/client/approval-card.ts): one title and one question per request kind,
  // keyed by the kind's stable id, plus one label per record field the details print. The card
  // never carries a record field; these labels are for the details only.
  'card.title': 'TeamCLI: {action}',
  'card.title.several': 'TeamCLI: {actions}',
  'card.title.approval': 'TeamCLI: approval',
  'card.question.approval': 'Approve this request?',
  'card.question.several': 'Allow {asker} to {actions} for team "{team}"?',
  'card.scope.asked': 'One-time change. {asker} asked.',
  'card.scope.once': 'One-time change.',
  'card.scope.always': 'Always, until revoked.',
  'card.scope.always.asked': 'Always, until revoked. {asker} asked.',
  'card.scope.deny': 'Deny.',
  'card.scope.deny.asked': 'Deny. {asker} asked.',
  'card.grant.question': 'Approve this grant?',
  'card.grant.title.grant': 'TeamCLI: grant',
  'card.grant.title.master': 'TeamCLI: master grant',
  'card.grant.title.team': 'TeamCLI: team grant',
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
  'card.title.development-mode': 'TeamCLI: development mode',
  'card.question.development-mode': 'Set development mode to {mode} on this machine?',
  'card.question.team-create': 'Create team "{team}"?',
  'card.question.team-import': 'Import the team file for team "{team}"?',
  'card.question.team-migrate': 'Migrate team "{team}"?',
  'card.question.team-add': 'Add a seat to team "{team}"?',
  'card.question.team-up': 'Start team "{team}"?',
  'card.question.team-send': 'Send a message for team "{team}"?',
  'card.question.team-down': 'Stop team "{team}"?',
  'card.question.team-bus': 'Start the bus for team "{team}"?',
  'card.question.team-revoke-approval': 'Revoke an approval rule on team "{team}"?',
  'card.question.team-forget': 'Forget the record of team "{team}"?',
  'card.question.team-config': 'Change the record of team "{team}"?',
  'card.question.team-general-grant': 'Issue a general grant for team "{team}"?',
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
