import { reported, type SeatCheck } from '../check.ts';
import type { Screen } from '../screen.ts';

// A seat stopped on its CLI's provider error or usage limit. herdr calls that seat done, and the
// pane is back at its prompt, so without this reading it looks idle. Reported once, to the
// operator and to the owner, and cleared when the seat leaves the state: a pass that stops
// calling `once` drops the key. Nothing is typed. The report names a retry only when a capture
// has shown one. None has.

type Held = { kind: 'provider error' } | { kind: 'rate limit'; reset: string | null };

function held(screen: Screen): Held | null {
  if (screen.kind === 'provider error') return screen;
  if (screen.kind === 'rate limit') return screen;
  return null;
}

function textOf(name: string, state: Held): string {
  if (state.kind === 'provider error') return `${name} shows a provider error: connection lost, and no capture names a retry`;
  if (state.reset) return `${name} is at a rate limit: usage limit, resets at ${state.reset}`;
  return `${name} is at a rate limit: usage limit, and the screen names no reset time`;
}

export const providerError: SeatCheck = {
  name: 'provider-error',
  run(seat, ctx) {
    const state = seat.running ? held(seat.screen) : null;
    if (!state) return [];
    const text = textOf(seat.name, state);
    // `to` names one recipient. The operator and the owner each get the line.
    return [
      ...reported(ctx.once(`provider-error:${seat.name}`, text)),
      ...reported(ctx.once(`provider-error:${seat.name}:owner`, text, 'owner')),
    ];
  },
};
