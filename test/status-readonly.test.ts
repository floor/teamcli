// `status` is a read: it never types into a pane, presses a key, or sends anything. The run in
// test/status-readonly-run.ts stands in a herdr whose writing functions fail the run if they are
// called, records every reader call, and prints the report and the record.
import { expect, test } from 'bun:test';
import { PANE_WINDOW } from '../src/herdr.ts';

test('status reads panes and calls no writing function', async () => {
  const proc = Bun.spawn(['bun', 'test/status-readonly-run.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const parsed = JSON.parse(out) as { code: number; err: string; out: string; calls: string[] };
  // The run's team file still spells the lead `coordinator:`, on line 4: under the 0.5.0 output
  // contract, deprecation warnings are printed only by `team check`, so `status`'s stderr is empty.
  expect(parsed.err).toBe('');
  expect(parsed.code).toBe(1);
  expect(parsed.out).toContain('team acme, session "acme-web"');
  expect(parsed.out).toMatch(/lead\s+idle\s+Claude Opus 5\.5\s+%1/);
  // Exactly the readers, in order, each pane read on the one window `status` and the watch share
  // — every writing function would have thrown, so the record holding none is the whole claim.
  expect(parsed.calls).toEqual([
    'sessionRunning acme-web',
    'agentList acme-web',
    'workspaceList acme-web',
    `paneRead %1 ${PANE_WINDOW} acme-web`,
    `paneRead %2 ${PANE_WINDOW} acme-web`,
  ]);
});
