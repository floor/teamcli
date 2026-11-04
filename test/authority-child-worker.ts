// A real process under a state record that names another process: the reminder sender's proof
// reads the process table, so the parent-child boundary is what this fixture crosses. The parent
// passes the machine folder, the instant to judge against and whether to start a child of its
// own; the fixture prints its own verdict, and with `spawn` also its child's verdict. Nothing
// else is read and no machine folder is guessed.
import { spawnSync } from 'node:child_process';
import { verifyDaemonAuthority } from '../src/reminder/authority.ts';

const [home, now, mode] = process.argv.slice(2);
if (home === undefined || now === undefined) throw new Error('the fixture names no machine folder or instant');
const verdict = verifyDaemonAuthority({ home, now: new Date(now) });
const mine = { pid: process.pid, ppid: process.ppid, ok: verdict.ok, why: verdict.ok ? null : verdict.why };
if (mode === 'spawn') {
  const inner = spawnSync(process.execPath, [process.argv[1] as string, home, now, 'verify'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (inner.error !== undefined) throw inner.error;
  if (inner.status !== 0) throw new Error(`the child exited with ${String(inner.status)}: ${inner.stderr}`);
  console.log(JSON.stringify({ mine, child: JSON.parse(inner.stdout) }));
} else {
  console.log(JSON.stringify({ mine }));
}
