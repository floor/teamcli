// The reading side of the persisted verification checkpoint scenes in
// bus-verify-checkpoint.test.ts: a process that holds no in-memory checkpoint yet, so the answer
// comes from the checkpoint file alone (or from a full verify). Prints one JSON line on stdout.
import { readEvents } from '../src/bus/log.ts';

const [root, home] = process.argv.slice(2);
if (root === undefined || home === undefined) {
  throw new Error('usage: bus-verify-checkpoint-run.ts <root> <home>');
}

const read = readEvents('acme', root, home);
console.log(
  JSON.stringify(
    read.ok
      ? {
          ok: true,
          full: read.full,
          checked: read.checked,
          unverified: read.unverified,
          seqs: read.events.map((event) => event.payload.seq),
          ids: read.events.map((event) => event.payload.record_id),
        }
      : { ok: false, reason: read.reason },
  ),
);
