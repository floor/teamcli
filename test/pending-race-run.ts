// Writes one pending handoff record from its own process for the pending-folder race coverage
// test. Usage: bun test/pending-race-run.ts <project> <root> <home> <id> <startAtEpochMs>
import { writePending, nativeNonceOf, type PendingNative } from '../src/send/pending.ts';

const [project = '', root = '', home = '', id = '', startAtRaw = '0'] = process.argv.slice(2);
const startAt = Number(startAtRaw);
while (Date.now() < startAt) await Bun.sleep(1);
const record: PendingNative = {
  v: 1,
  id,
  nonce: nativeNonceOf(id),
  ts: new Date().toISOString(),
  from: 'owner',
  from_id: null,
  to: 'acme',
  to_id: null,
  team: project,
  session: 'session',
  cli: 'claude-code',
  pane: 'pane',
  address: 'uds:/nonexistent',
  rule: 'test',
  project,
  root,
  body: 'the body',
};
const written = writePending(project, root, home, record);
console.log(JSON.stringify(written.ok ? { ok: true, path: written.path } : { ok: false, reason: written.reason }));
process.exit(written.ok ? 0 : 1);
