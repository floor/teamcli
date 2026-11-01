import { createHash } from 'node:crypto';
import { plainLine } from '../../launch/plain.ts';
import { reported, type CheckContext, type SeatCheck } from '../check.ts';

// One occurrence of a dialog is the question it shows: the digest of that text names it, so the
// same dialog reported once stays quiet, and a seat asked something new is reported again. A
// dialog whose profile places no text has no name beyond its kind, and is reported once per
// spell, as it always was.
const occurrence = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

function held(kind: 'plan approval' | 'confirmation', name: string, dialogText: string | null, ctx: CheckContext) {
  // Every line here is a report, never a keystroke: the seat is the operator's to act on, and
  // nothing in the watch types an answer.
  if (dialogText === null || dialogText === '') {
    return reported(ctx.once(`${kind}:${name}`, `${name} waits at a ${kind} prompt: the operator's to act on`));
  }
  const text = plainLine(dialogText);
  return reported(ctx.once(
    `${kind}:${name}:${occurrence(text)}`,
    `${name} waits at a ${kind} prompt — "${text}": the operator's to act on`,
  ));
}

// The one exclusive reading the core made of the seat's screen and status: a seat waits at a
// permission prompt its owner has to answer, asks a question the operator has to act on, waits
// for a plan to be approved or a dialog to be confirmed, shows a vendor notice its owner has to
// act on, is blocked on a screen the watch doesn't recognise, or reports a status the watch
// doesn't know. A permission prompt and a trust question are the same seat state to the watch.
export const attention: SeatCheck = {
  name: 'attention',
  run(seat, ctx) {
    if (seat.attention === 'permission') {
      return reported(ctx.once(`blocked:${seat.name}`, `${seat.name} waits at a permission prompt: its owner's to answer`, 'owner'));
    }
    if (seat.attention === 'question') {
      if (seat.dialogText === null || seat.dialogText === '') {
        return reported(ctx.once(`question:${seat.name}`, `${seat.name} asked a question: the operator's to act on`));
      }
      const text = plainLine(seat.dialogText);
      return reported(ctx.once(
        `question:${seat.name}:${occurrence(text)}`,
        `${seat.name} asked a question — "${text}": the operator's to act on`,
      ));
    }
    if (seat.attention === 'plan approval') return held('plan approval', seat.name, seat.dialogText, ctx);
    if (seat.attention === 'confirmation') return held('confirmation', seat.name, seat.dialogText, ctx);
    if (seat.attention === 'vendor notice') {
      return reported(ctx.once(`vendor notice:${seat.name}`, `${seat.name} shows a vendor notice: its owner's to act on`, 'owner'));
    }
    if (seat.attention === 'blocked') {
      return reported(ctx.once(`blocked:${seat.name}`, `${seat.name} is blocked, and its screen is not one the watch recognises`, 'owner'));
    }
    if (seat.attention === 'unknown' && seat.agent) {
      return reported(ctx.once(`unknown:${seat.name}`, `${seat.name}: herdr reports the status "${seat.agent.status}"`));
    }
    return [];
  },
};
