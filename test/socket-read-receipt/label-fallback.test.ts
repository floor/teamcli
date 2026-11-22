// The accepted frame's name fallback: nickname, then the written label's name, then the seat.
//
// Contract pinned by builder-5 for #682: the display line is `Message from <name> (<seat>@<team>)`,
// third in the frame, after the unverified-claim banner and its blank line.
// <name> is the seat's signed nickname setting, else the roster nickname, else the written
// `label:` of the sender's seat stanza in the sending run's own team file — the text before the
// first middle dot, trimmed, the whole label when it holds none — and the seat name only when
// none of those stands. A seat with no written label, or a label whose name is empty after
// trimming, falls through. The line is display only: the signed record keeps its own
// `from … — admitted by: …` line, the typed wake is untouched, and owner frames read `owner`.
// The scenes are synthetic: a temporary world, a fake socket and a string pane.
import { afterEach, expect, test } from 'bun:test';
import { runSend } from '../../src/commands/send.ts';
import { testIo } from '../helpers.ts';
import {
  acceptSocket,
  book,
  declareEntity,
  dropsOf,
  frameOf,
  helperIo,
  hostOf,
  recordOf,
  registerHelper,
  world,
  type World,
} from './fixtures.ts';
import { labelSeat } from './label-fixtures.ts';

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}
