// A writer that dies: it appends one record through the receiver's queue and exits the process at
// the step the test names, holding the queue lock, with no `finally` run (rfc-event-comms E4 gates).
import { appendDeliverySync, type AppendStep } from '../../src/queue/append.ts';
import { signRecord, writeRecord } from '../../src/send/record.ts';

const [dropDir, home, root, session, seat, id, crashAt] = process.argv.slice(2) as [string, string, string, string, string, string, string];
const record = signRecord({
  kind: 'message', id, to: seat, to_id: null, root, session, at: '2026-11-17T22:00:00.000Z',
  body: `body of ${id}`, from: 'tester', from_id: null, rule: 'test', thread: id,
}, home);
appendDeliverySync({ dropDir, record }, () => {
  const result = writeRecord(dropDir, record);
  return { ok: result.ok, value: result };
}, {
  home,
  after: (step: AppendStep) => {
    if (step === crashAt) process.exit(9);
  },
});
process.exit(0);
