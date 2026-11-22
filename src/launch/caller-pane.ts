// The pane a command stands in, and the session that pane belongs to. Pane ids are per session
// in the terminal host, so a pane id alone never proves a target pane is the caller's own: the
// identity carries the session, and a repair compares both.
import type { Caller } from '../caller.ts';

export type CallerPane = { pane: string; session: string | null };

/** The placement's pane and session when the caller was placed; else the terminal host's pane
 *  hint with the session its socket path (or session hint) names. `session: null` when only the
 *  pane is known: a repair on a pane of that id is then held as possibly the caller's, never
 *  assumed to be another session's. Null when no pane is known at all. */
export function callerPaneIdentity(caller: Caller, hints: Readonly<Record<string, string | undefined>>): CallerPane | null {
  if ((caller.kind === 'seat' || caller.kind === 'pane') && caller.pane !== '') {
    const placed = caller.session !== undefined && caller.session !== '' ? caller.session : null;
    return { pane: caller.pane, session: placed ?? hostSessionOf(hints) };
  }
  const pane = hints.HERDR_PANE_ID;
  if (pane === undefined || pane === '') return null;
  return { pane, session: hostSessionOf(hints) };
}

/** Whether a repair on `pane` in `session` would act on the caller's own pane. */
export function isCallerPane(identity: CallerPane | null, pane: string, session: string): boolean {
  if (identity === null || identity.pane !== pane) return false;
  return identity.session === null || identity.session === session;
}

/** The session the terminal host's hints name: its per-session socket path
 *  (`…/.config/herdr/sessions/<name>/herdr.sock`, or the default socket), else its session hint.
 *  Null when neither names one. */
export function hostSessionOf(hints: Readonly<Record<string, string | undefined>>): string | null {
  const path = hints.HERDR_SOCKET_PATH;
  if (path !== undefined && path !== '') {
    const match = /\/\.config\/herdr\/sessions\/([A-Za-z0-9._-]+)\/herdr\.sock$/.exec(path);
    const name = match?.[1];
    if (name !== undefined && name !== '.' && name !== '..') return name;
    if (/\/\.config\/herdr\/herdr\.sock$/.test(path)) return 'default';
  }
  const named = hints.HERDR_SESSION;
  return named !== undefined && named !== '' ? named : null;
}
