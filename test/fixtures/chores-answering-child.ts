// A child that answers an end request with a heartbeat: a scene uses it to watch the child handle
// stand down from a forced end when the process it was ending turns out to be alive and talking.
// It writes a marker file named by CHORES_SCENE_READY once its signal handler is installed, so a
// scene never races the start, then holds its loop open.
import { writeFileSync } from 'node:fs';

// The handler is installed before the marker is written: the scene reads the marker as the
// promise that a terminate signal sent now will find the handler, so the marker must never
// precede it.
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
const ready = process.env.CHORES_SCENE_READY;
if (ready !== undefined) writeFileSync(ready, 'ready');
setInterval(() => {}, 60_000);
