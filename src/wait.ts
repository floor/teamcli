// The wait between passes of a looping command: `true` when the seconds elapse, `false` when a
// stop signal arrives first. SIGINT and SIGTERM are the stop keys. SIGHUP is the same stop: a
// pane closing hangs its child up, and the default action kills the process before `watch`'s
// `finally` can clear the record, or before `next --wait` can print that it stopped. Both
// callers treat false as their own end. Lifted from `watch.ts` so another looping command can
// wait and stop the same way.
//
// `onTick`, when given and the wait runs longer than one tick, runs about every TICK_MS inside
// the wait: the watch's label sweep, so a running seat's status line reaches line 2 without
// waiting out a whole interval. A tick that throws is swallowed — only a whole pass may end a
// watch, never a sweep between passes.
const TICK_MS = 5000;

export function waitOrStop(seconds: number, onTick?: () => void): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ticker !== null) clearInterval(ticker);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      done(elapsed);
    };
    const stop = () => finish(false);
    const ticker = onTick !== undefined && seconds * 1000 > TICK_MS
      ? setInterval(() => {
        try {
          onTick();
        } catch {
          // The pass is the authority: a failed sweep changes nothing and waits for it.
        }
      }, TICK_MS)
      : null;
    const timer = setTimeout(() => finish(true), seconds * 1000);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
  });
}
