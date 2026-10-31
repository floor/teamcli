// A launch may publish a newer brief claim between prune's first claim read and its marker
// listing, and the marker it walks right after is already in that listing. The run in
// test/commands/brief-prune-race-run.ts stands that launch in at the readPending seam; the
// prune must retire nothing and say why, keeping the newer delivery's one unread marker.
import { expect, test } from 'bun:test';

test('a claim published while prune lists its markers retires nothing', async () => {
  const proc = Bun.spawn(['bun', 'test/commands/brief-prune-race-run.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const parsed = JSON.parse(out) as {
    code: number;
    out: string;
    err: string;
    oldMarkerRemains: boolean;
    newerMarkerRemains: boolean;
  };
  expect(parsed).toEqual({
    code: 1,
    out: '',
    err: "team brief prune: the seat's current brief claim changed while the run read its markers, so nothing was retired; run it again\n",
    oldMarkerRemains: true,
    newerMarkerRemains: true,
  });
});
