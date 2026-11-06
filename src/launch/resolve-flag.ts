// The opt-in launch path: a seat's pane command comes from resolveLaunch. The flag that
// selects it stays off unless the caller names it, and this module is not consulted otherwise.
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discover, resolveLaunch, type Discovery, type ResolveContext } from '../launchers/resolve.ts';
import type { Diagnostic, ResolvedLaunch } from '../launchers/types.ts';
import { shellQuote } from '../profiles/profile.ts';
import { STATE_FILE } from '../state.ts';
import { parseYaml, toValue } from '../yaml.ts';

/** Launcher files beside the team state, as the team home. A missing directory is an empty
 *  discovery. A name that is not a regular file, or a file that cannot be parsed, is an error
 *  on the discovery, so a later resolution refuses rather than skipping it. */
export function loadTeamLaunchers(root: string): Discovery {
  const dir = join(root, '.agents', 'launchers');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return discover([]);
  }
  const files: Record<string, unknown> = {};
  const diagnostics: Diagnostic[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.yaml')) continue;
    const text = readRegular(join(dir, name));
    if (text === null) {
      diagnostics.push({
        code: 'E_LAUNCHER_FILE',
        severity: 'error',
        file: name,
        message: `launcher file ${name} is not a regular file that can be read`,
      });
      continue;
    }
    try {
      files[name] = toValue(parseYaml(text));
    } catch {
      diagnostics.push({
        code: 'E_LAUNCHER_FILE',
        severity: 'error',
        file: name,
        message: `launcher file ${name} could not be read`,
      });
    }
  }
  const found = discover([{ level: 'team', files }]);
  return { launchers: found.launchers, diagnostics: [...diagnostics, ...found.diagnostics] };
}

/** The session word written for a seat, before the state reader drops a blank one. A blank
 *  string is returned as written so the resolver can refuse it. Absent when the seat has no
 *  word. */
export function rawAgentSession(dir: string, session: string, seat: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, STATE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (sessions === null || typeof sessions !== 'object') return undefined;
  const one = (sessions as Record<string, unknown>)[session];
  if (one === null || typeof one !== 'object') return undefined;
  const seats = (one as { seats?: unknown }).seats;
  if (seats === null || typeof seats !== 'object') return undefined;
  const held = (seats as Record<string, unknown>)[seat];
  if (held === null || typeof held !== 'object') return undefined;
  const value = (held as { agent_session?: unknown }).agent_session;
  return typeof value === 'string' ? value : undefined;
}

/** The pane command for one seat, or the refusal the resolution returned. A seat that names
 *  no launcher is refused here: the flag asked for a resolved argv and there is none. */
export function resolvedCommand(input: {
  launcher: string | undefined;
  discovery: Discovery;
  ctx: ResolveContext;
}): { command: string } | { refusal: string } {
  if (input.launcher === undefined || input.launcher === '') {
    return { refusal: 'resolve-launch is on and this seat names no launcher' };
  }
  return commandOf(resolveLaunch({ launcher: input.launcher }, input.discovery, input.ctx));
}

function commandOf(resolved: ResolvedLaunch): { command: string } | { refusal: string } {
  if (!resolved.ok) {
    const error = resolved.diagnostics.find((item) => item.severity === 'error');
    return { refusal: error?.message ?? 'the launch resolution was refused' };
  }
  if (resolved.argv.length === 0) return { refusal: 'the launch resolution produced no command' };
  return { command: resolved.argv.map((word) => shellQuote(word)).join(' ') };
}

function readRegular(path: string): string | null {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
