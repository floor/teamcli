import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { callerOf, type Caller } from '../caller.ts';
import type { Io } from '../io.ts';
import { readState } from '../state.ts';
import { storesFolder } from '../store/store.ts';

// The team file a session was launched from, found from a pane the process walk already
// placed. The pointer is only a way out of the lobby: the session state beside the file is
// what accepts the path. A caller never supplies one.

type Placed = Pick<Io, 'caller' | 'env' | 'stdinIsTTY' | 'callerSources'>;

function paneDir(home: string): string {
  return join(storesFolder(home), 'panes');
}

function paneKey(pane: string): string {
  return encodeURIComponent(pane);
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Remember that `pane` was launched from `file`. The file is the team file `up` loaded. */
export function noteLaunchedPane(home: string, file: string, pane: string): void {
  const dir = paneDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, paneKey(pane)), `${file}\n`, { mode: 0o600 });
}

/** Drop the pointer for a pane that is no longer a seat of the session. */
export function forgetLaunchedPane(home: string, pane: string): void {
  try {
    rmSync(join(paneDir(home), paneKey(pane)));
  } catch {
    // Already gone: a second drop, or a pane recorded before pointers existed.
  }
}

function pointedFile(home: string, pane: string): string | undefined {
  try {
    const text = readFileSync(join(paneDir(home), paneKey(pane)), 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

function paneOf(caller: Caller): string | undefined {
  return caller.kind === 'seat' || caller.kind === 'pane' ? caller.pane : undefined;
}

/** The team file this caller's pane was launched from, or undefined when the record does not
 *  vouch for it. Reads the session state, not the team file. */
export function launchedTeamFile(io: Placed, home: string | undefined): string | undefined {
  const caller = io.caller ?? callerOf(io);
  const pane = paneOf(caller);
  if (!pane) return undefined;
  const file = pointedFile(home ?? homedir(), pane);
  if (!file) return undefined;
  const recorded = real(file);
  const dir = dirname(file);
  if (!recorded) return undefined;
  let state;
  try {
    state = readState(dir);
  } catch {
    return undefined;
  }
  for (const session of Object.values(state.sessions)) {
    if (!session.launched_file) continue;
    const launched = real(session.launched_file);
    if (launched !== recorded) continue;
    for (const seat of Object.values(session.seats)) {
      if (seat.pane === pane) return file;
    }
  }
  return undefined;
}
