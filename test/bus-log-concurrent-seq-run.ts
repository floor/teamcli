// Appends one event from its own process for the concurrent-sequence coverage test.
// Usage: bun test/bus-log-concurrent-seq-run.ts <root> <home> <recordId> <startAtEpochMs>
import { appendEvent } from '../src/bus/log.ts';

const [root = '', home = '', id = '', startAtRaw = '0'] = process.argv.slice(2);
const startAt = Number(startAtRaw);
while (Date.now() < startAt) await Bun.sleep(1);
const result = appendEvent('acme', root, home, {
  ts: new Date().toISOString(),
  kind: 'message.arrived',
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
