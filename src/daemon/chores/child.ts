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
import { markerCacheStats } from '../../send/fallback-events.ts';
import type { ReminderProvider } from '../../reminder/provider.ts';
import type { ReminderSend, ReminderSpec } from '../../reminder/run.ts';
import { createFallbackPass } from './fallback.ts';
import { createPresencePass, type ChoresPresencePass } from './presence.ts';
import type { ChoresWatch, ChoresWatchInput } from './watch.ts';
import type { WatchSources } from '../../commands/watch.ts';
import { runWatchdogSlice, watchdogState, type WatchdogSeat, type WatchdogState } from '../../seat-health/pass.ts';
import type { RestartReady } from '../../seat-health/restart.ts';
import {
  CHORES_FRAME_LIMIT,
  parseChoresFrame,
  readHostMessage,
  type ChoresChildConfig,
  type ChoresChildMessage,
  type ChoresChildRoute,
  type ChoresMarkerCache,
  type ChoresPresenceProof,
  type ChoresPresenceReading,
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
  /** The real chores. The default is the fallback sweep this step moved here; the presence
   *  steps are the second set. A test injects its own to observe the budget and the notes. */
  pass?: ChoresPass;
  /** The presence steps (activity, reconcile, publisher). A test injects its own. */
  presence?: ChoresPresencePass;
  /** The machine reminder's own seams: the list reader and the transport. A test injects its
   *  own so a scene drives the beat without a machine folder or a socket; production builds the
   *  reader from the token's hosted checkouts and the transport from the verified daemon
   *  sender, which proves the daemon this child runs under before every leg. */
  reminder?: { provider?: ReminderProvider; send?: ReminderSend };
  /** Builds the hosted watches a token's routes name. The default loads the production module
   *  only when a route carries a watch; a test injects its own to observe the frames. */
  watchFactory?: (input: ChoresWatchInput) => ChoresWatch;
  /** Test seam: the read sources the injected or real watches run over. */
  watchBase?: WatchSources;
  /** The seat-health watchdog. A test injects one. When the token asks for it and nothing is
   *  injected, the child builds the real one after its first heartbeat. */
  watchdog?: SeatHealthPorts;
  /** The marker cache whose counts ride the heartbeat. The default is this process's own, which
   *  is the cache the fallback sweep fills; a test injects a quiet reading so its scene never
   *  depends on another test's files. */
  markerCacheStats?: () => ChoresMarkerCache;
  /** Ends the child on a terminate signal through the same stop path as a host frame, so the
   *  watches release their authority before the process leaves. The supervisor still forces a
   *  child that does not leave within its kill grace. The program entry sets this; a test does
   *  not, because a test process must not install handlers it cannot take back. */
  signals?: boolean;
};

/** One root's watchdog: the seats it sees, the restart it starts, and the lead message it sends.
 *  The restart's promise is not awaited by the slice. */
export type SeatHealthPorts = {
  seats(route: ChoresChildRoute): Promise<readonly WatchdogSeat[]>;
  restart(route: ChoresChildRoute, seat: string, args: readonly string[]): Promise<RestartReady | { kind: 'failed' }>;
  lead(route: ChoresChildRoute, text: string): void;
};

/** The chore the child's pass runs. The one implementation is the fallback sweep (`fallback.ts`);
 *  a test that injects a pass stands in for it, and the row still names what the child ran. */
const PASS_CHORE = 'fallback';

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
  const machine = config.machine;
  if (machine !== undefined) {
    if (!machine || typeof machine !== 'object' || Array.isArray(machine)) return 'the token names a malformed machine chore';
    const reminders = (machine as Record<string, unknown>).reminders;
    if (!reminders || typeof reminders !== 'object' || Array.isArray(reminders)) return 'the token names a machine chore without its reminders';
    const hosted = (reminders as Record<string, unknown>).hosted;
    if (!Array.isArray(hosted) || hosted.some((root) => typeof root !== 'string' || root === '')) {
      return 'the token names reminders without their hosted checkouts';
    }
  }
  // A child may serve no routes when it carries the machine chores: the reminder's recipients
  // span roots, so its worker is the machine's, not one root's.
  if (!Array.isArray(config.routes)) return 'the token names no roots';
  if (config.routes.length === 0 && machine === undefined) return 'the token names no roots';
  for (const item of config.routes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'the token names a malformed root';
    const route = item as Record<string, unknown>;
    if (typeof route.root !== 'string' || route.root === '') return 'the token names a root without a folder';
    if (typeof route.team !== 'string') return 'the token names a root without a team';
    if (typeof route.session !== 'string') return 'the token names a root without a session';
    if (route.stateDir !== undefined && (typeof route.stateDir !== 'string' || route.stateDir === '')) {
      return 'the token names a root with a malformed state folder';
    }
    if (route.teamFile !== undefined && (route.teamFile === null || typeof route.teamFile !== 'object' || Array.isArray(route.teamFile))) {
      return 'the token names a malformed team file';
    }
    if (route.watch !== undefined) {
      if (route.watch === null || typeof route.watch !== 'object' || Array.isArray(route.watch)) {
        return 'the token names a malformed watch';
      }
      const watch = route.watch as Record<string, unknown>;
      if (typeof watch.teamFile !== 'string' || watch.teamFile === '') {
        return 'the token names a watch without a team file';
      }
      if (typeof watch.presence !== 'boolean') {
        return 'the token names a watch without a presence flag';
      }
    }
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
  const pass = input.pass ?? createFallbackPass(config);
  const presence = input.presence ?? createPresencePass(config);
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
  /** One presence pass in flight per root; a nudge that lands while one runs is dropped, exactly
   *  as the daemon skips a route whose previous pass is still running. */
  const presenceRuns = new Map<string, Promise<void>>();
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

  /** The machine reminder beat this token carries, or null. Its list read — the entity record,
   *  the registry and every addressed team file — and each send walk run on this child's loop,
   *  never the daemon's; the beat is driven by the host's ticks, exactly as the daemon's own
   *  beat drove it. One tick at a time is not enforced here: the tick module skips a reminder
   *  whose earlier walk is still running, so a tick that lands mid-walk leaves it and the next
   *  tick notices whatever is still due. */
  let reminderBeat: (() => void) | null = null;
  if (config.machine !== undefined) {
    // The reminder modules load only for a token that carries machine work: a per-root child's
    // cold start is unchanged, and the send command's own module is not paid for by children
    // that never send.
    const [{ realHost }, { sendDaemonDirect }, { createReminderProvider }, { reminderTick }] = await Promise.all([
      import('../../commands/send.ts'),
      import('../../reminder/direct-send.ts'),
      import('../../reminder/provider.ts'),
      import('../../reminder/run.ts'),
    ]);
    const hosted = config.machine.reminders.hosted;
    const provider = input.reminder?.provider ?? createReminderProvider({ home: config.home, hosted });
    // Every line the beat writes crosses as its own frame: stdout carries frames only, so the
    // run's words take the protocol, and the daemon logs each as the line it is.
    const note = (line: string): void => {
      for (const one of line.split('\n')) {
        const text = one.trimEnd();
        if (text !== '') write({ type: 'reminder-note', text });
      }
    };
    const send: ReminderSend = input.reminder?.send ?? ((context, request) =>
      sendDaemonDirect(context, request, { ...realHost, home: config.home }, { stdout: note, stderr: note }));
    reminderBeat = (): void => {
      let specs: readonly ReminderSpec[];
      try {
        specs = provider(note);
      } catch (error) {
        note(`reminders: the configured list could not be read — ${error instanceof Error ? error.message : String(error)}; nothing fires this beat`);
        return;
      }
      if (specs.length === 0) return;
      void reminderTick({ home: config.home, now: now(), specs, send, log: note }).catch((error: unknown) => {
        note(`reminders: the beat failed — ${error instanceof Error ? error.message : String(error)}`);
      });
    };
  }

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
    const startedAt = now().getTime();
    let notes: string[];
    try {
      notes = await pass({ route, at: new Date(at), slices });
    } catch (error) {
      // One root's failure is that root's own: the sibling roots still run, and the daemon log
      // names this one through the note list.
      const why = error instanceof Error ? error.message : String(error);
      notes = [`the pass failed: ${why}`];
    }
    // The row's own reading of this pass: what ran and how long it took on this child's clock.
    const ms = Math.max(0, now().getTime() - startedAt);
    if (!stopping) {
      write({ type: 'pass', passes: [{ root: route.root, at, notes, chore: PASS_CHORE, ms }] });
    }
  })();

  /** One presence nudge: runs that root's presence pass and reports it under the nudge's id. A
   *  root with a presence pass already in flight drops the new one, exactly as the daemon skips a
   *  route whose previous presence pass is still running. */
  const runPresence = (message: { id: string; root: string; at: string; readings: ChoresPresenceReading[] }): void => {
    if (stopping || presenceRuns.has(message.root)) return;
    const at = new Date(message.at);
    if (Number.isNaN(at.getTime())) {
      write({
        type: 'presence-result',
        id: message.id,
        root: message.root,
        at: message.at,
        proofs: message.readings.map((reading) => ({ seat: reading.seat, miss: 'the presence nudge names no valid instant' })),
        notes: ['a presence nudge named no valid instant'],
        ms: null,
      });
      return;
    }
    const route = config.routes.find((item) => item.root === message.root);
    if (route === undefined) {
      write({
        type: 'presence-result',
        id: message.id,
        root: message.root,
        at: message.at,
        proofs: message.readings.map((reading) => ({ seat: reading.seat, miss: 'the chores child does not serve this root' })),
        notes: ['a presence nudge named a root this child does not serve'],
        ms: null,
      });
      return;
    }
    const work = (async (): Promise<void> => {
      const startedAt = now().getTime();
      let proofs: ChoresPresenceProof[];
      let notes: string[];
      try {
        const outcome = await presence.run(route, { at, readings: message.readings, slices });
        proofs = outcome.proofs;
        notes = outcome.notes;
      } catch (error) {
        // One root's presence failure is that root's own: the daemon still gets a proof row per
        // reading, and the log names the failure through the notes.
        const why = error instanceof Error ? error.message : String(error);
        proofs = message.readings.map((reading) => ({ seat: reading.seat, miss: `the presence pass failed: ${why}` }));
        notes = [`the presence pass failed: ${why}`];
      }
      const ms = Math.max(0, now().getTime() - startedAt);
      if (!stopping) {
        write({ type: 'presence-result', id: message.id, root: message.root, at: message.at, proofs, notes, ms });
      }
    })();
    presenceRuns.set(message.root, work);
    void work.then(() => {
      presenceRuns.delete(message.root);
    });
  };

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
    // The child answers for itself: its own cumulative CPU time, in milliseconds, read from its
    // own process. The daemon needs no process query to know that a child which keeps beating is
    // making progress; it asks the process table only for one that has gone silent.
    const usage = process.cpuUsage();
    write({
      type: 'heartbeat',
      at: now().toISOString(),
      rssBytes: memory.rss,
      busy: running.size > 0 ? 'chores' : null,
      markerCache: (input.markerCacheStats ?? markerCacheStats)(),
      cpuMs: Math.round((usage.user + usage.system) / 1000),
    });
  };

  write({ type: 'ready', pid: process.pid, at: now().toISOString() });
  heartbeat();
  // The beat is armed before the watches load and build. Loading a watch module on a cold
  // process and building a watcher for every route take real time, and the daemon hears the
  // child only through this beat: armed after that work, the pipe would be silent through it and
  // the child would be judged on silence it did not choose. The timers are unref'd, so they never
  // hold the process open past its stop.
  const beatTimer = setInterval(heartbeat, config.beatMs);
  beatTimer.unref();
  const passTimer = setInterval(enqueue, config.beatMs);
  passTimer.unref();
  // The hosted watches this token asked for. The production module loads only when a route
  // carries one, so a child started before the watch isolation carries the chores alone. Every
  // state, pulse and fault answer crosses the same newline-framed pipe as the chores messages.
  let watch: ChoresWatch | null = null;
  if (config.routes.some((route) => route.watch !== undefined)) {
    const make = input.watchFactory ?? (await import('./watch.ts')).createChoresWatch;
    watch = make({
      routes: config.routes,
      log: (text) => write({ type: 'note', text }),
      report: (root, state) => write({ type: 'watch-state', root, state }),
      pulse: (root, at) => write({ type: 'watch-pulse', root, at: at.toISOString() }),
      cycle: (root, at) => write({ type: 'watch-cycle', root, at: at.toISOString() }),
      faultResult: (root, outcome, why) => write({ type: 'watch-fault-result', root, outcome, why }),
      now,
      ...(input.watchBase === undefined ? {} : { base: input.watchBase }),
    });
  }

  const healthStates = new Map<string, WatchdogState>();
  const healthRuns = new Set<string>();
  let health = input.watchdog ?? null;
  if (health === null && config.seatHealth === true) {
    try {
      const live = await import('../../seat-health/live.ts');
      health = live.liveSeatHealth(config);
    } catch (error) {
      write({ type: 'note', text: `seat health could not start: ${error instanceof Error ? error.message : 'the reader failed'}` });
    }
  }
  const runHealth = (route: ChoresChildRoute): void => {
    if (health === null || stopping || healthRuns.has(route.root)) return;
    const ports = health;
    healthRuns.add(route.root);
    void (async (): Promise<void> => {
      try {
        const seats = await ports.seats(route);
        let state = healthStates.get(route.root);
        if (state === undefined) {
          state = watchdogState();
          healthStates.set(route.root, state);
        }
        await runWatchdogSlice(state, {
          seats,
          now: now().getTime(),
          restart: (seat, args) => ports.restart(route, seat, args),
          lead: (text) => ports.lead(route, text),
        });
      } catch (error) {
        write({ type: 'note', text: `seat health: ${error instanceof Error ? error.message : 'the slice failed'}` });
      } finally {
        healthRuns.delete(route.root);
      }
    })();
  };

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
        // The machine chores ride the same nudge: through a whole daemon stall the child was
        // never asked, and the tick after it is where the reminder notices what is still due.
        // The seat-health slice starts here and returns while a restart is still running.
        if (!stopping) {
          reminderBeat?.();
          for (const route of config.routes) runHealth(route);
        }
      } else if (message.type === 'presence') {
        runPresence(message);
      } else if (message.type === 'watch-beat') {
        watch?.beat(message.root, new Date(message.at), message.presence);
      } else if (message.type === 'watch-fault') {
        watch?.fault(message.root, message.why);
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
  // A terminate signal takes the same path as a host stop: every watch ends at its seam and
  // releases the epoch it holds before this process leaves. The supervisor's kill grace owns a
  // stop that does not finish; it signals exactly once and forces after the grace.
  if (input.signals === true) {
    process.once('SIGTERM', finish);
    process.once('SIGINT', finish);
  }

  await stopped;

  clearInterval(beatTimer);
  clearInterval(passTimer);
  const destroyable = stdin as unknown as { destroy?: () => void };
  if (typeof destroyable.destroy === 'function') destroyable.destroy();
  // A pass that is still running saw the same stop at its next slice boundary; the supervisor's
  // kill bound owns a pass that never reaches one. The watches stop beside them: each one ends
  // its run at the loop's own seam and releases the epoch it holds, so a stopping child leaves
  // no authority standing behind it.
  const stoppingWatch = watch === null
    ? Promise.resolve()
    : watch.stop('the daemon asked this child to stop');
  const inFlight = [...running.values(), ...presenceRuns.values()];
  if (inFlight.length > 0) await Promise.allSettled(inFlight);
  await stoppingWatch;
  write({ type: 'stopped', why: 'the daemon asked this child to stop' });
  // exit: daemon.chores-ended
  return 0;
}
