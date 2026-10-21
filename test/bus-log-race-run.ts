// One writer for the concurrent append scene in bus-log.test.ts: it waits for a shared start
// instant, appends one event with the public entry point, and prints the result as one JSON line
// on stdout. Each writer runs in its own process, so the append's cross-process serialization is
// what the scene measures.
import { appendEvent } from '../src/bus/log.ts';

const [root, home, id, startAt] = process.argv.slice(2);
if (root === undefined || home === undefined || id === undefined || startAt === undefined) {
  throw new Error('usage: bus-log-race-run.ts <root> <home> <record_id> <start_at_ms>');
}

while (Date.now() < Number(startAt)) {
  // Busy-wait so every writer leaves the loop at the same instant.
}

const result = appendEvent(
  'acme',
  root,
  home,
  { ts: new Date().toISOString(), kind: 'message.arrived', session: 'acme', record_id: id },
  { deduplicate: false, retain: false },
);
console.log(
  JSON.stringify(
    result.ok
      ? { id, ok: true, seq: result.record.payload.seq }
      : { id, ok: false, reason: result.reason },
  ),
);
