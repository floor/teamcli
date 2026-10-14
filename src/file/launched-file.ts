import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { callerOf, type Caller } from '../caller.ts';
import type { Io } from '../io.ts';
import { readState } from '../state.ts';
import { storesFolder } from '../store/store.ts';

// The team file a session was launched from, found from a pane the process walk already
// placed. The pointer names the session and the pane, so two teams that share a pane id each
// keep the file they were launched from. A pointer written when the key was the pane id alone
// is still read, and it is accepted only for a session the caller is placed in on that pane.
// A caller never supplies the path.

type Placed = Pick<Io, 'caller' | 'env' | 'stdinIsTTY' | 'callerSources'>;

function paneDir(home: string): string {
  return join(storesFolder(home), 'panes');
}

// The session and the pane, in one path component. A key with no null byte is the older
// pane-id key.
function paneKey(session: string, pane: string): string {
  return encodeURIComponent(`${session}\0${pane}`);
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Remember that `pane` in `session` was launched from `file`. The file is the team file `up` loaded. */
export function noteLaunchedPane(home: string, file: string, pane: string, session: string): void {
  const dir = paneDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, paneKey(session, pane)), `${file}\n`, { mode: 0o600 });
}

/** Drop the pointer for a pane that is no longer a seat of the session. */
export function forgetLaunchedPane(home: string, pane: string, session: string): void {
  try {
    rmSync(join(paneDir(home), paneKey(session, pane)));
  } catch {
    // Already gone: a second drop, or a pane recorded before pointers existed.
  }
}

function readPointer(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

// Every pointer this home holds for `pane`: the session keys, and the older pane-id key.
function pointedFiles(home: string, pane: string): string[] {
  const dir = paneDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      continue;
    }
    const split = decoded.split('\0');
    const keyPane = split.length === 2 ? split[1] : decoded;
    if (keyPane !== pane) continue;
    const file = readPointer(join(dir, name));
    if (file) files.push(file);
  }
  return files;
}

function paneOf(caller: Caller): string | undefined {
  return caller.kind === 'seat' || caller.kind === 'pane' ? caller.pane : undefined;
}

/** The team file this caller's pane was launched from, or undefined when the record does not
 *  vouch for it. Reads the session state, not the team file. The file is returned only for a
 *  session in which the caller is placed on that pane. */
export function launchedTeamFile(io: Placed, home: string | undefined): string | undefined {
  const pane = paneOf(callerOf(io));
  if (!pane) return undefined;
  for (const file of pointedFiles(home ?? homedir(), pane)) {
    const recorded = real(file);
    const dir = dirname(file);
    if (!recorded) continue;
    let state;
    try {
      state = readState(dir);
    } catch {
      continue;
    }
    for (const [sessionName, session] of Object.entries(state.sessions)) {
      if (!session.launched_file) continue;
      const launched = real(session.launched_file);
      if (launched !== recorded) continue;
      if (paneOf(callerOf(io, sessionName)) !== pane) continue;
      for (const seat of Object.values(session.seats)) {
        if (seat.pane === pane) return file;
      }
    }
  }
  return undefined;
}
