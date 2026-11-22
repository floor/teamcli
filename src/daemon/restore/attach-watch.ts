// The daemon's restore watch for sessions that were not running when it looked.
//
// After a machine restart the terminal host brings back only the sessions the owner attaches;
// every other team's session stays stopped until he does, which can be an hour later. The
// daemon-start restore pass used to fold those sessions into its load-guard retry: it spawned a
// restore child per stopped session only to hear "stopped", waited its whole 315 s retry budget
// on them, and then gave up, so a session attached after that got no pass at all (labels and
// model lines missing, restored seats left untied; 16 Nov reboot).
//
// This watch holds those routes instead. It reads the terminal host's session list once per poll
// (one async call for every watched route, never a restore child), and a route is attempted
// only when its own session reads running. A stopped session is watched for the daemon's life:
// the poll is one cheap read. A route whose attempt is then held by the load guard is retried on
// the same poll, inside its own bounded budget; past that bound it is dropped with a pending
// line that names `team up --all`.
import type { HostedRoute } from '../routes.ts';

/** What one attempt at a watched route came to. */
export type RestoreAttachAttempt =
  /** The pass ran, or a refusal/lifecycle rule settled it: nothing more to do here. */
  | 'done'
  /** The restore child found the session not running after all: keep watching. */
  | 'not-running'
  /** The load guard held the pass: retry on a later poll, inside the load budget. */
  | 'load'
  /** The pass ran and asked for one more (a seat timed out): run it at the next poll. The caller
   *  owns the once-only limit. */
  | 'retry';

/** The pending reading a route carries in the daemon state record while it waits. */
export type RestorePending =
  | { reason: 'stopped'; since: string }
  | { reason: 'load'; since: string; detail?: string }
  | { reason: 'load-bound'; since: string; detail?: string };

export type RestoreAttachWatchInput = {
  /** Wait between session-list reads. */
  pollMs: number;
  /** How long a route the load guard keeps holding is retried, from its first load hold. */
  loadBudgetMs: number;
  /** One read of the terminal host's sessions: name to running. Null when the host did not answer. */
  sessionsRunning: () => Promise<ReadonlyMap<string, boolean> | null>;
  attempt: (route: HostedRoute) => Promise<RestoreAttachAttempt>;
  /** Waits `ms`; false when the daemon is closing. */
  wait: (ms: number) => Promise<boolean>;
  closing: () => boolean;
  now: () => number;
  log: (line: string) => void;
  onPending: (route: HostedRoute, pending: RestorePending | null) => void;
};

type Watched = { route: HostedRoute; loadSince: number | null };

export type RestoreAttachWatch = {
  /** Starts watching a route whose session was not running. A route already watched stays once. */
  add(route: HostedRoute): void;
  /** No more routes will be added: `run` ends once nothing is left to watch. */
  seal(): void;
  /** The watch loop; resolves when sealed and empty, or when the daemon closes. */
  run(): Promise<void>;
  /** The roots being watched, for tests and the state record. */
  roots(): string[];
};

export function createRestoreAttachWatch(input: RestoreAttachWatchInput): RestoreAttachWatch {
  const watched = new Map<string, Watched>();
  let sealed = false;
  let wake: (() => void) | null = null;
  const iso = (ms: number): string => new Date(ms).toISOString();

  const add = (route: HostedRoute): void => {
    if (watched.has(route.root)) return;
    watched.set(route.root, { route, loadSince: null });
    input.onPending(route, { reason: 'stopped', since: iso(input.now()) });
    input.log(`restore ${route.root}: the session "${route.session}" is not running; the restore runs when it is attached`);
    wake?.();
  };

  const seal = (): void => {
    sealed = true;
    wake?.();
  };

  // While nothing is watched and more may come, the loop parks here instead of polling.
  const idle = (): Promise<void> => new Promise((resolve) => {
    wake = () => { wake = null; resolve(); };
  });

  const run = async (): Promise<void> => {
    while (!input.closing()) {
      if (watched.size === 0) {
        if (sealed) return;
        await idle();
        continue;
      }
      if (!(await input.wait(input.pollMs)) || input.closing()) return;
      const running = await input.sessionsRunning();
      // An unanswered read says nothing: every route stays watched for the next poll.
      if (running === null) continue;
      for (const entry of [...watched.values()]) {
        if (input.closing()) return;
        const { route } = entry;
        if (running.get(route.session) !== true) continue;
        let outcome: RestoreAttachAttempt;
        try {
          outcome = await input.attempt(route);
        } catch (error) {
          input.log(`restore ${route.root}: ${error instanceof Error ? error.message : String(error)}`);
          outcome = 'done';
        }
        if (outcome === 'done') {
          watched.delete(route.root);
          input.onPending(route, null);
        } else if (outcome === 'retry') {
          entry.loadSince = null;
          input.onPending(route, null);
        } else if (outcome === 'not-running') {
          entry.loadSince = null;
          input.onPending(route, { reason: 'stopped', since: iso(input.now()) });
        } else {
          const at = input.now();
          if (entry.loadSince === null) entry.loadSince = at;
          if (at - entry.loadSince >= input.loadBudgetMs) {
            watched.delete(route.root);
            input.onPending(route, { reason: 'load-bound', since: iso(entry.loadSince) });
            input.log(`restore ${route.root}: pending (still load-held after the session was attached; retry wait bound reached; run "team up --all" once the load guard clears)`);
          } else {
            input.onPending(route, { reason: 'load', since: iso(entry.loadSince) });
          }
        }
      }
    }
  };

  return { add, seal, run, roots: () => [...watched.keys()] };
}

/** The production session read: one terminal-host session list, as name to running. */
export async function sessionsRunningMap(
  list: () => Promise<readonly { name: string; running: boolean }[] | null>,
): Promise<ReadonlyMap<string, boolean> | null> {
  const sessions = await list();
  if (sessions === null) return null;
  return new Map(sessions.map((session) => [session.name, session.running]));
}
