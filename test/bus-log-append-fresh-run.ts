// Appends one event from its own process, for the cold append-index coverage test: the index a
// fresh process builds answers only the key it was asked about.
// Usage: bun test/bus-log-append-fresh-run.ts <root> <home> <kind> <recordId>
import { appendEvent } from '../src/bus/log.ts';
import type { EventKind } from '../src/bus/kinds.ts';

const [root = '', home = '', kind = '', id = ''] = process.argv.slice(2);
const result = appendEvent('acme', root, home, {
  ts: new Date().toISOString(),
  kind: kind as EventKind,
  session: 'acme',
  record_id: id,
});
console.log(
  JSON.stringify(
    result.ok
      ? { ok: true, duplicate: result.duplicate === true, seq: result.record.payload.seq }
      : { ok: false, reason: result.reason },
  ),
);
process.exit(result.ok ? 0 : 1);
