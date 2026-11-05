import { reported, type SeatCheck } from '../check.ts';

// Text read as held in the composer: a seat herdr calls idle whose own screen reads as holding
// text in its input box. The reading is the screen's, not proof of who put the text there — a
// rotating hint drawn in an undeclared colour reads the same way — so the check says only what
// the screen shows and never tells anyone to clear the box. It is reported once the reading has
// stood for `unsent_after`, and its clock clears the moment the seat is anything else —
// running, at a prompt, or holding nothing.
export const unsent: SeatCheck = {
  name: 'unsent',
  run(seat, ctx) {
    const since = ctx.memory<Record<string, number>>('unsent', () => ({}));
    if (!seat.running || !seat.quiet || seat.working || seat.prompt || seat.screen.kind !== 'unsent') {
      delete since[seat.name];
      return [];
    }
    since[seat.name] ??= ctx.now;
    if (ctx.now - (since[seat.name] as number) < ctx.watch.unsentAfter * 1000) return [];
    return reported(ctx.once(`unsent:${seat.name}`, `${seat.name}: its input box reads as holding text; nothing is typed there`));
  },
};
