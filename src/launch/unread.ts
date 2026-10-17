// A screen a profile cannot read says nothing about the turn behind it. Herdr's own status is
// the last word then: a seat it reports idle or done is closable without typing into its pane,
// and one it reports working keeps the refusal. `restart`, `reload` and the launch repair read
// the rule from here, so the advice one of them prints is the sentence the others print.

import { plainLine } from './plain.ts';

/** Whether herdr's own status lets a seat whose screen the profile cannot read be closed. */
export function unreadIdle(status: string | null | undefined): status is 'idle' | 'done' {
  return status === 'idle' || status === 'done';
}

/** The one sentence a run prints when it closes a seat whose screen it could not read. */
export function unreadAdvice(seat: string, status: string): string {
  return `${plainLine(seat)}: screen: not recognised; herdr reports it ${plainLine(status)}; the workspace is closed without typing into it`;
}
