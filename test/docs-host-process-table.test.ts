// The command reference must not read the machine's own process table. `check` and `status` read a
// recorded watch's and a proc record's pid; when the docs world does not state whether that pid is
// alive, they fall back to the host's answer, so the same page prints different lines on different
// runners. This test hands both pages a table where the pids they name answer alive — the state a
// runner whose pid numbers collide presents — and requires the page's own lines unchanged.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPage } from './docs/run.ts';

const DIR = join(import.meta.dir, '..', 'docs', 'commands');

// check.md records a watch as pid 4242; proc.md's release-build process is pid 4243. Every other
// number is answered by the host, as it is on a run without this table.
const NAMED_PIDS = new Set([4242, 4243]);

const realKill = process.kill.bind(process);

async function withProcessTable(pids: ReadonlySet<number>, fn: () => Promise<void>): Promise<void> {
  (process as unknown as { kill: (pid: number, signal?: number | string) => boolean }).kill = (
    pid: number,
    signal?: number | string,
  ) => (signal === 0 && pids.has(pid) ? true : realKill(pid, signal as never));
  try {
    await fn();
  } finally {
    (process as unknown as { kill: typeof realKill }).kill = realKill;
  }
}

describe('the command reference does not read the host process table', () => {
  for (const page of ['check.md', 'proc.md']) {
    test(`${page}: the pids it names answer alive`, async () => {
      const markdown = readFileSync(join(DIR, page), 'utf8');
      let failures: string[] = [];
      await withProcessTable(NAMED_PIDS, async () => {
        failures = (await runPage(page, markdown)).map(
          (failure) => `${failure.page}:${failure.line}: ${failure.message}`,
        );
      });
      expect(failures.join('\n\n')).toBe('');
    });
  }
});
