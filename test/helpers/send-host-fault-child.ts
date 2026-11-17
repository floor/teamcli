// A child for test/host/send-host-fault.test.ts: a real warm send host whose dispatcher writes the
// line's durable record and then the whole host process dies (SIGKILL) before any answer. The
// test's client must see an ambiguous outcome and never run the line a second time.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PeerReader } from '../../src/host/peer.ts';
import { startSendHost } from '../../src/host/server.ts';
import type { Io } from '../../src/io.ts';

const base = process.argv[2]!;
const cliEntry = process.argv[3]!;
const parent = Number(process.argv[4]);
const reader: PeerReader = {
  credentials: () => ({ uid: process.getuid!(), pid: parent }),
  process: () => ({ ppid: process.ppid, uid: process.getuid!(), startSec: 1n, startUsec: 2n }),
  cwd: () => base,
  confined: () => false,
};
const seatSources: Io['callerSources'] = () => ({
  ancestors: () => [{ pid: 101, name: 'claude' }, { pid: 100, name: 'herdr' }],
  agents: () => [{ name: 'builder', pane: 'w1:p1', agent: 'claude', workspace: 'w1', status: 'idle' as const, cwd: null }],
  paneRootPid: () => 101,
  env: { HERDR_PANE_ID: 'w1:p1' },
  stdinIsTTY: false,
});
await startSendHost({
  home: base,
  cliEntry,
  main: async () => {
    // The durable record, then the host is gone before it can answer.
    appendFileSync(join(base, 'records.log'), 'one record\n');
    process.kill(process.pid, 'SIGKILL');
    return 0;
  },
  ownEnv: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  reader,
  socketPath: join(base, 'h.sock'),
  callerSources: seatSources,
});
process.stdout.write('listening\n');
