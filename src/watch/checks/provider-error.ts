import { reported, type SeatCheck, type SeatObservation } from '../check.ts';
import type { Screen } from '../screen.ts';

// A seat stopped on its CLI's provider error or usage limit. herdr calls that seat done, and the
// pane is back at its prompt, so without this reading it looks idle. Reported once, to the
// operator and to the owner, and cleared when the seat leaves the state: a pass that stops
// calling `once` drops the key. A seat that is working is not this report, even while the
// sentence is still in the window: the key clears, and a later stop is reported again. Nothing
// is typed. The report names a retry only when a capture has shown one. None has. A rate limit
// names the account the seat spends — its pool — and the reset time the screen gives, when it
// gives one.

type Held = { kind: 'provider error' } | { kind: 'rate limit'; reset: string | null };

function held(screen: Screen): Held | null {
  if (screen.kind === 'provider error') return screen;
  if (screen.kind === 'rate limit') return screen;
  return null;
}

/** The account the seat spends (RFC 0003 § 3b), as the counting rules resolve it. Null when the
 *  observation names neither its own `account:` nor a vendor, and the report then omits the pool. */
function accountOf(seat: SeatObservation): string | null {
  return seat.account === undefined || seat.account === '' ? null : seat.account;
}

function textOf(name: string, account: string | null, state: Held): string {
  if (state.kind === 'provider error') return `${name} shows a provider error: connection lost, and no capture names a retry`;
  const on = account === null ? '' : ` on ${account}`;
  if (state.reset) return `${name} is at a rate limit${on}: usage limit, resets at ${state.reset}`;
  return `${name} is at a rate limit${on}: usage limit, and the screen names no reset time`;
}

export const providerError: SeatCheck = {
  name: 'provider-error',
  run(seat, ctx) {
    const state = seat.running && !seat.working ? held(seat.screen) : null;
    if (!state) return [];
    const text = textOf(seat.name, accountOf(seat), state);
    // The two states are different events — a prompt (the owner waits on a reset) and a blocked
    // seat — so each has its own key. The bus mapping reads the key, never the prose.
    const key = state.kind === 'rate limit' ? `rate-limit:${seat.name}` : `provider-error:${seat.name}`;
    // `to` names one recipient. The operator and the owner each get the line.
    return [
      ...reported(ctx.once(key, text)),
      ...reported(ctx.once(`${key}:owner`, text, 'owner')),
    ];
  },
};
