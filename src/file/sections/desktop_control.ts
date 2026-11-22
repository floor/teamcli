import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { Section } from './section.ts';

/**
 * Reads one `desktop_control` key — the file's own, or a seat's — as true or false, or
 * `undefined` when the key is absent, so a seat that writes `false` under a team that writes
 * `true` is read as the word it is and wins.
 */
export function readDesktopControl(entry: YamlEntry | undefined, at: string, check: Check): boolean | undefined {
  return entry === undefined ? undefined : check.flag(entry, at);
}

/**
 * The file's own word on whether its seats may control the computer: computer use, the user's
 * browser and desktop apps. Off when the file writes none. A seat's own word, read by the seats
 * section, wins over it; the launch reads both (`src/settings/desktop-control.ts`). Non-owner
 * and additive — absent in every file written before it, so it appears in no approval digest
 * and existing approvals still match.
 */
export const desktopControl: Section = {
  name: 'desktop_control',
  owner: false,
  after: [],
  validate(entry, ctx) {
    return readDesktopControl(entry, 'desktop_control', ctx.check) ?? null;
  },
  schema: {
    type: 'boolean',
    $comment: 'whether the team\'s seats may control the computer (computer use, the user\'s browser, desktop apps): off when omitted; a seat\'s own desktop_control wins, so a team turns it on only for the seat that needs it',
  },
};
