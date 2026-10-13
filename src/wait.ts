// The wait between passes of a looping command: `true` when the seconds elapse, `false` when a
// stop signal arrives first. SIGINT and SIGTERM are the stop keys. SIGHUP is the same stop: a
// pane closing hangs its child up, and the default action kills the process before `watch`'s
// `finally` can clear the record, or before `next --wait` can print that it stopped. Both
// callers treat false as their own end. Lifted from `watch.ts` so another looping command can
// wait and stop the same way.
export function waitOrStop(seconds: number): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      done(elapsed);
    };
    const stop = () => finish(false);
    const timer = setTimeout(() => finish(true), seconds * 1000);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
  });
}
