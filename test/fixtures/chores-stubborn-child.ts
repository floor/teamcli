// A child that refuses the polite end signal and does nothing else: a scene uses it to watch the
// child handle decide whether a stopped-answering process is forced. It writes a marker file
// named by CHORES_SCENE_READY once its signal handler is installed, so a scene never races the
// start, then holds its loop open.
import { writeFileSync } from 'node:fs';

const ready = process.env.CHORES_SCENE_READY;
if (ready !== undefined) writeFileSync(ready, 'ready');
process.on('SIGTERM', () => {});
setInterval(() => {}, 60_000);
