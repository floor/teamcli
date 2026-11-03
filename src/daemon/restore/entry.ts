// The restore child's program entry. The machine daemon starts it as a second process with a
// one-use token's nonce; it reads that token, runs the one route's guarded restore pass, writes
// one result line, and leaves. The token is the whole authority: without a fresh one under this
// home's machine folder the child refuses and runs nothing (`src/daemon/restore/token.ts`).
//
// This file exists so the sync terminal-host reads of a restore pass block this process alone.
// The daemon's own loop only awaits the result line, so its heartbeat is never held by a pass.
import { runRestoreSweepForRoute, type RestoreSweepResult } from '../../launch/restore-sweep.ts';
import { readRestoreInherit } from './token.ts';

/** One result line, or a refusal. The parent reads exactly this shape from stdout. */
type Report = { ok: true; result: RestoreSweepResult } | { ok: false; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes the one line the parent reads and flushes it before the pass ends. */
async function report(line: Report): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify(line)}\n`, () => resolve());
  });
}

const home = process.env.HOME ?? '';
const at = process.argv.indexOf('--inherited');
const nonce = at === -1 ? '' : process.argv[at + 1] ?? '';
const read = home === ''
  ? { kind: 'refused' as const, why: 'the restore child was started without a home' }
  : readRestoreInherit(home, nonce);

if (read.kind === 'refused') {
  process.stderr.write(`team daemon: ${read.why}\n`);
  // exit: team.restore-entry-refused
  process.exitCode = 2;
} else {
  // A daemon that closes while a pass runs terminates this child: the flag stops the pass
  // between seat steps, the same way the daemon's own closing flag stopped an inline pass.
  let closing = false;
  const onSignal = (): void => {
    closing = true;
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    const result = await runRestoreSweepForRoute({
      home: read.request.home,
      root: read.request.root,
      ...(read.request.teamFile === undefined ? {} : { teamFile: read.request.teamFile }),
      isClosing: () => closing,
    });
    // The pass is done and the token spent: a signal after this point is the parent ending a
    // process that has nothing left to stop, so the default termination applies again.
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await report({ ok: true, result });
  } catch (error) {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await report({ ok: false, reason: reasonOf(error) });
  }
}
