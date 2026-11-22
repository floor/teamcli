// What a seat's `desktop_control` setting puts on its launch (src/settings/desktop-control.ts
// resolves the setting). On, the default: the feature pins the profile names under
// `desktop_control.features` are lifted, no config pair is placed and no deny is written; the
// seat runs with the user's own configuration, as seats always have. Set false:
//
// - Codex: the profile's feature pins (computer use, browser use, the in-app browser, full CDP
//   access, the ChatGPT apps and connectors) and its `desktop_control.config` pairs (the computer
//   and browser MCP servers a desktop app registers in the user's Codex config, the connectors'
//   `codex_apps` server and the bundled computer-use plugins, off) ride the seat's line, its
//   recorded recipe and its managed app-server's start words.
// - Claude Code: the seat's settings file denies the computer-use, browser-control and claude.ai
//   connector MCP tools, and turns the claude.ai connectors off.
import { resolveSeatOverrides } from '../config/apply.ts';
import type { TeamFile } from '../file/types.ts';
import { resolveDesktopControl } from '../settings/desktop-control.ts';

export { seatPins, seatPinWords, type SeatPins } from './features.ts';

/**
 * The seat's effective `desktop_control`, from the team file and the signed settings chain. A
 * seat the file does not declare reads the team's word. `home` is the registry holding the
 * records; without one, or when the chain does not verify, only the file's words are read.
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
 * file: every tool of the MCP servers that drive the computer or a browser, and every claude.ai
 * connector, which acts under the owner's claude.ai account. A server rule (`mcp__<server>`)
 * denies all of that server's tools; `mcp__claude_ai_*` is a tool-name glob, which Claude Code's
 * permission docs say must match the full tool name (`mcp__*` matches every MCP tool), so it
 * covers `mcp__claude_ai_<connector>__<tool>`. Deny rules block in every permission mode,
 * bypass included. The names are the servers Claude Code's own computer use and browser
 * integrations register: the desktop computer-use server, Claude in Chrome, and the desktop
 * app's built-in browser.
 */
export const CLAUDE_DESKTOP_DENY: readonly string[] = ['mcp__computer-use', 'mcp__claude-in-chrome', 'mcp__Claude_Browser', 'mcp__claude_ai_*'];

/** The deny rules for a Claude Code seat: only when desktop control is set false; none when it
 *  is on, the default, or not known. */
export function claudeDesktopDeny(desktopControl: boolean | undefined): string[] {
  return desktopControl === false ? [...CLAUDE_DESKTOP_DENY] : [];
}

/** The settings beside the deny for a seat with desktop control off: Claude Code's documented
 *  switch that stops it fetching the claude.ai connectors at all (`disableClaudeAiConnectors`,
 *  the settings form of `ENABLE_CLAUDEAI_MCP_SERVERS=false`). The deny stays for a connector
 *  delivered another way. Empty unless desktop control is set false. */
export function claudeDesktopSettings(desktopControl: boolean | undefined): Record<string, unknown> {
  return desktopControl === false ? { disableClaudeAiConnectors: true } : {};
}
