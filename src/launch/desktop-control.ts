// What a seat's `desktop_control` setting puts on its launch (src/settings/desktop-control.ts
// resolves the setting). Off, the default:
//
// - Codex: the profile's feature pins (computer use, browser use, the in-app browser, full CDP
//   access) and its `desktop_control.config` pairs (the computer and browser MCP servers a
//   desktop app registers in the user's Codex config, and the bundled computer-use plugins,
//   off) ride the seat's line, its recorded recipe and its managed app-server's start words.
// - Claude Code: the seat's settings file denies the computer-use and browser-control MCP tools.
//
// On: the feature pins the profile names under `desktop_control.features` are lifted, no config
// pair is placed, and no deny is written; the seat runs with the user's own configuration.
import { resolveSeatOverrides } from '../config/apply.ts';
import type { TeamFile } from '../file/types.ts';
import { resolveDesktopControl } from '../settings/desktop-control.ts';

export { seatPins, seatPinWords, type SeatPins } from './features.ts';

/**
 * The seat's effective `desktop_control`, from the team file and the signed settings chain. A
 * seat the file does not declare reads the team's word. `home` is the registry holding the
 * records; without one, or when the chain does not verify, only the file's words are read — a
 * record that cannot be shown to stand never turns the setting on.
 */
export function seatDesktopControl(input: {
  team: Pick<TeamFile, 'seats' | 'desktopControl'> | null | undefined;
  seat: string;
  home?: string | null;
  root?: string;
}): boolean {
  const declared = input.team?.seats.find((seat) => seat.name === input.seat);
  let record: { value: boolean; level: 'entity' | 'project' | 'team' | 'seat' } | undefined;
  if (input.home !== undefined && input.home !== null && input.root !== undefined) {
    const read = resolveSeatOverrides({ home: input.home, root: input.root, seat: input.seat });
    if (read.ok) record = read.overrides.desktopControl;
  }
  return resolveDesktopControl({
    ...(declared?.desktopControl === undefined ? {} : { seat: declared.desktopControl }),
    team: input.team?.desktopControl ?? null,
    ...(record === undefined ? {} : { record }),
  });
}

/**
 * The Claude Code permission rules a seat with desktop control off carries in its settings
 * file: every tool of the MCP servers that drive the computer or a browser. A server rule
 * (`mcp__<server>`) denies all of that server's tools, and a deny holds under the bypass a
 * builder seat runs with. The names are the servers Claude Code's own computer use and browser
 * integrations register: the desktop computer-use server, Claude in Chrome, and the desktop
 * app's built-in browser.
 */
export const CLAUDE_DESKTOP_DENY: readonly string[] = ['mcp__computer-use', 'mcp__claude-in-chrome', 'mcp__Claude_Browser'];

/** The deny rules for a Claude Code seat: none when desktop control is on. */
export function claudeDesktopDeny(desktopControl: boolean | undefined): string[] {
  return desktopControl === true ? [] : [...CLAUDE_DESKTOP_DENY];
}
