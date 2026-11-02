// The chores child's own loop: one process per group of roots, started by the machine daemon
// through a one-use token.
//
// The child owns its heartbeat and its pass cadence. It sends one heartbeat per daemon beat
// whether or not a pass is running, so a pass that is honestly slow stays alive while a pass
// that holds the process still is ended by the supervisor, never waited for.
//
// Every root has its own FIFO, holding at most one requested pass, and the child serves the
// roots round-robin: one slice per root in turn, yielding to the event loop between slices. A
// slice runs a pass, which may wait on the outside world; the next root's slice starts without
// waiting for it, so one root's slow read delays another root's chores by a slice and never the
// heartbeat. A pass that respects its slice budget is what keeps that promise; a pass that holds
// the event loop still is what the supervisor's missed-beat kill is for. Nothing here touches a
// socket: the child speaks one newline-framed JSON line per message on its standard streams and
// nothing else.
//
// The child leaves when its host asks it to and when its input ends — a daemon that died closes
// the pipe, so a child never outlives the daemon that started it.
import {
  CHORES_FRAME_LIMIT,
  parseChoresFrame,
  readHostMessage,
  type ChoresChildConfig,
  type ChoresChildMessage,
  type ChoresChildRoute,
} from './protocol.ts';

/** The bounded seam one root's pass runs under: the slice budget it may spend at a stretch, and
 *  the yield that lets the heartbeat out. */
export type ChoresSlices = {
  sliceMs: number;
  /** True once a stop is known: a pass must leave at its next slice boundary. */
  stopping(): boolean;
  /** Yields to the event loop; resolves false when the child is stopping. */
  yield(): Promise<boolean>;
};

/** One root's pass. Resolves with the notes the daemon's log should carry; a throw is reported
 *  as that root's failure and never stops the sibling roots in the same pass. */
export type ChoresPass = (input: {
  route: ChoresChildRoute;
  at: Date;
  slices: ChoresSlices;
}) => Promise<string[]>;

export type ServeChoresChildInput = {
  config: ChoresChildConfig;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  now?: () => Date;
  /** The real chores. The default runs none: the child and its contract land first, and each
   *  step moves one chore in here. A test injects its own to observe the budget and the notes. */
  pass?: ChoresPass;
};

const NO_CHORES: ChoresPass = async () => [];

/** A positive whole number of milliseconds, or null. */
function readMillis(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Whether a token's config is one this child can serve. A refusal names the field. */
export function choresConfigProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the token carries no configuration';
  const config = raw as Record<string, unknown>;
  if (config.version !== 1) return 'the token names an unknown format';
  if (typeof config.home !== 'string' || config.home === '') return 'the token names no home';
  if (readMillis(config.beatMs) === null) return 'the token names no heartbeat interval';
  if (readMillis(config.sliceMs) === null) return 'the token names no slice budget';
  if (typeof config.since !== 'string' || config.since === '') return 'the token names no start instant';
  if (!Array.isArray(config.routes) || config.routes.length === 0) return 'the token names no roots';
  for (const item of config.routes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'the token names a malformed root';
    const route = item as Record<string, unknown>;
    if (typeof route.root !== 'string' || route.root === '') return 'the token names a root without a folder';
    if (typeof route.team !== 'string') return 'the token names a root without a team';
    if (typeof route.session !== 'string') return 'the token names a root without a session';
  }
  return null;
}

/**
 * Serves one token's configuration until a stop or the end of the input. Resolves with the exit
 * code the command reports; never throws for a peer that left or a frame it could not read.
 */
export async function serveChoresChild(input: ServeChoresChildInput): Promise<number> {
  const { config } = input;
  const now = input.now ?? (() => new Date());
  const pass = input.pass ?? NO_CHORES;
  const stdout = input.stdout;
  const stdin = input.stdin;

  let stopping = false;
  let draining = false;
  /** One requested pass per root, at the instant its beat asked for it: a root that falls behind
   *  misses beats rather than growing a backlog. */
  const pending = new Map<string, string>();
  /** The pass in flight per root: one at a time. A stop lets each reach its next slice boundary
   *  and leave; the supervisor's kill bound owns a pass that never reaches one. */
  const running = new Map<string, Promise<void>>();
  /** Where the next round-robin turn starts. */
  let cursor = 0;
  let afterStop: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    afterStop = resolve;
  });

  const write = (message: ChoresChildMessage): void => {
    try {
      stdout.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The host is gone; the input's own end settles this child.
    }
  };

  const slices: ChoresSlices = {
    sliceMs: config.sliceMs,
    stopping: () => stopping,
    yield: () => new Promise<boolean>((resolve) => {
      if (stopping) {
        resolve(false);
        return;
      }
      setImmediate(() => resolve(!stopping));
    }),
  };

  /** The next root whose pass may start: its own turn in round-robin order, with a pass
   *  requested and none in flight. */
  const eligible = (): ChoresChildRoute | undefined => {
    for (let step = 0; step < config.routes.length; step += 1) {
      const index = (cursor + step) % config.routes.length;
      const route = config.routes[index];
      if (route === undefined) continue;
      if (pending.has(route.root) && !running.has(route.root)) return route;
    }
    return undefined;
  };

  /** One root's slice: runs its pass, then reports it under that root alone, so a slow sibling
   *  never delays the report another root has already finished. */
  const runOne = (route: ChoresChildRoute, at: string): Promise<void> => (async (): Promise<void> => {
    let notes: string[];
    try {
      notes = await pass({ route, at: new Date(at), slices });
    } catch (error) {
      // One root's failure is that root's own: the sibling roots still run, and the daemon log
      // names this one through the note list.
      const why = error instanceof Error ? error.message : String(error);
      notes = [`the pass failed: ${why}`];
    }
    if (!stopping) write({ type: 'pass', passes: [{ root: route.root, at, notes }] });
  })();

  /** Serves the requested passes, one slice per root in turn. It starts the next slice without
   *  awaiting the one in flight, so a pass waiting on the outside world does not hold the turn
   *  of the roots after it. */
  const drain = (): void => {
    if (draining || stopping) return;
    draining = true;
    void (async (): Promise<void> => {
      try {
        while (!stopping) {
          const route = eligible();
          if (route === undefined) {
            if (running.size === 0) break;
            await Promise.race([...running.values()]);
            continue;
          }
          const at = pending.get(route.root) ?? now().toISOString();
          pending.delete(route.root);
          cursor = (config.routes.indexOf(route) + 1) % config.routes.length;
          const work = runOne(route, at);
          running.set(route.root, work);
          void work.then(() => {
            running.delete(route.root);
            drain();
          });
          await slices.yield();
        }
      } finally {
        draining = false;
      }
    })();
  };

  /** Asks for one pass per root that has none waiting, at this beat's instant. */
  const enqueue = (): void => {
    if (stopping) return;
    const at = now().toISOString();
    for (const route of config.routes) {
      if (running.has(route.root) || pending.has(route.root)) continue;
      pending.set(route.root, at);
    }
    drain();
  };

  const heartbeat = (): void => {
    const memory = process.memoryUsage();
    write({
      type: 'heartbeat',
      at: now().toISOString(),
      rssBytes: memory.rss,
      busy: running.size > 0 ? 'chores' : null,
    });
  };

  write({ type: 'ready', pid: process.pid, at: now().toISOString() });
  heartbeat();
  const beatTimer = setInterval(heartbeat, config.beatMs);
  beatTimer.unref();
  const passTimer = setInterval(enqueue, config.beatMs);
  passTimer.unref();

  let buffer = '';
  let overflow = false;
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (overflow) {
        overflow = false;
        continue;
      }
      if (line.trim() === '') continue;
      if (line.length > CHORES_FRAME_LIMIT) {
        write({ type: 'note', text: 'a host frame exceeded the frame limit and was dropped' });
        continue;
      }
      const parsed = parseChoresFrame(line);
      const message = parsed === null ? null : readHostMessage(parsed);
      if (message === null) {
        write({ type: 'note', text: 'a host frame was not a message this child understands' });
        continue;
      }
      if (message.type === 'tick') {
        enqueue();
      } else {
        stopping = true;
        break;
      }
    }
    if (buffer.length > CHORES_FRAME_LIMIT) {
      buffer = '';
      overflow = true;
    }
    if (stopping) afterStop?.();
  });
  const finish = (): void => {
    stopping = true;
    afterStop?.();
  };
  stdin.on('end', finish);
  stdin.on('close', finish);

  await stopped;

  clearInterval(beatTimer);
  clearInterval(passTimer);
  const destroyable = stdin as unknown as { destroy?: () => void };
  if (typeof destroyable.destroy === 'function') destroyable.destroy();
  // A pass that is still running saw the same stop at its next slice boundary; the supervisor's
  // kill bound owns a pass that never reaches one.
  if (running.size > 0) await Promise.allSettled([...running.values()]);
  write({ type: 'stopped', why: 'the daemon asked this child to stop' });
  // exit: daemon.chores-ended
  return 0;
}
