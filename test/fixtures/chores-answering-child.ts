// A child that answers an end request with a heartbeat: a scene uses it to watch the child handle
// stand down from a forced end when the process it was ending turns out to be alive and talking.
// It writes a marker file named by CHORES_SCENE_READY once its signal handler is installed, so a
// scene never races the start, then holds its loop open.
import { writeFileSync } from 'node:fs';

const ready = process.env.CHORES_SCENE_READY;
if (ready !== undefined) writeFileSync(ready, 'ready');
process.on('SIGTERM', () => {
  process.stdout.write(
    `${JSON.stringify({
      type: 'heartbeat',
      at: new Date().toISOString(),
      rssBytes: 40 * 1024 * 1024,
      busy: null,
      markerCache: null,
    })}\n`,
  );
});
setInterval(() => {}, 60_000);
