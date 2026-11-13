// The one dialog a launch answers itself: Claude Code's development-channels warning.
//
// A Claude seat's launch line carries the development-channels flag naming the team's own inbox
// server (`--dangerously-load-development-channels server:team-inbox`, src/mcp/channel.ts), and
// Claude Code asks at every start whether that channel is for local development. It offers no
// supported way to approve a named development channel ahead of the start or to skip the
// question: its skip-permissions modes do not skip it, and only channel plugins Anthropic lists
// start without it. On a machine with no one at the pane, a seat would wait at that question
// forever. The owner delegated the answer: option 1, on the team's inbox channel alone.
//
// So the launch answers it, and nothing else. The step runs on the seat's own pane, during the
// wait right after this run launched it, only on a line that carries the flag for the team's
// inbox, and only when the screen is exactly that dialog for exactly that channel with its first
// option marked: Enter then confirms the marked row. Every answer is logged with the seat, the
// channel and the time. A second showing of the dialog in the same wait is never answered: the
// wait then stops at it as at any other dialog.
import { CHANNEL_SERVER } from '../mcp/channel.ts';
import { plainText } from './plain.ts';

/** The dialog's title row, as Claude Code draws it. */
export const CHANNEL_DIALOG_TITLE = 'WARNING: Loading development channels';

/** The channel a seat's own launch names: the team's inbox server. */
export function teamInboxChannel(server: string = CHANNEL_SERVER): string {
  return `server:${server}`;
}

/** The rows a frame draws them in: styling gone, a box border on either side dropped. */
function rowsOf(screen: string): string[] {
  return plainText(screen)
    .split('\n')
    .map((line) => line.replace(/^\s*[│┃|]\s?/, '').replace(/\s?[│┃|]\s*$/, '').trimEnd());
}

const TITLE = /^\s*WARNING: Loading development channels\s*$/;
const CHANNELS = /^\s*Channels:\s*(\S.*?)\s*$/;
const FIRST = /^\s*❯\s*1\.\s+I am using this for local development\s*$/;
const SECOND = /^\s*2\.\s+Exit\s*$/;
const OPTION = /^\s*[❯›>]?\s*[0-9]+\.\s/;
const FOOTER = /^\s*Enter to confirm · Esc to cancel\s*$/;

/**
 * Whether `screen` is the development-channels dialog for `channel` alone, with option 1 marked,
 * at the bottom of the pane. Read from the last title row the pane draws: below it, the channel
 * list names exactly `channel`; then, past any prose that is no option row, the marked option 1,
 * option 2 (`Exit`) as the next row drawn, and below that nothing but blanks and the dialog's
 * footer. A dialog naming any other channel, more than one, a third option, the mark on another
 * row, or anything drawn under it, is not this dialog.
 */
export function channelDialogFor(screen: string | null, channel: string = teamInboxChannel()): boolean {
  if (screen === null || screen === '') return false;
  const rows = rowsOf(screen);
  let title = -1;
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    if (TITLE.test(rows[at]!)) {
      title = at;
      break;
    }
  }
  if (title < 0) return false;
  let at = title + 1;
  let listed: string[] | null = null;
  for (; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (OPTION.test(row)) return false;
    const match = CHANNELS.exec(row);
    if (match !== null) {
      listed = match[1]!.split(/[\s,]+/).filter((one) => one !== '');
      at += 1;
      break;
    }
  }
  if (listed === null || listed.length !== 1 || listed[0] !== channel) return false;
  for (; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (FIRST.test(row)) break;
    if (OPTION.test(row)) return false;
  }
  if (at >= rows.length) return false;
  at += 1;
  while (at < rows.length && rows[at]!.trim() === '') at += 1;
  if (at >= rows.length || !SECOND.test(rows[at]!)) return false;
  let footers = 0;
  for (at += 1; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (row.trim() === '') continue;
    if (FOOTER.test(row) && footers === 0) {
      footers += 1;
      continue;
    }
    return false;
  }
  return true;
}

/** The log line for one answer: the channel and the option. The seat and the time are the log
 *  line's own. */
export function channelDialogAnswerLine(channel: string = teamInboxChannel()): string {
  return `answered its development-channels dialog for ${channel} with option 1 (I am using this for local development)`;
}
