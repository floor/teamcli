// C1 round 2, independent: prune against a launch publishing a newer claim mid-run.
//
// `team brief prune --apply` classifies markers from a claim it read before the folder. A launch
// that publishes claim B (claim, signed record, marker, in that order) before prune enumerates
// leaves B current and unread while the prune's snapshot still names A. The prune must not
// retire B's marker nor call it superseded; since a marker list classified against a claim that
// is no longer the state's cannot be trusted, the run retires nothing and says why. The child
// run in test/c1-prune-race-independent-run.ts publishes B at the pending snapshot seam (or
// withdraws the claim entirely) and prints what the real command did; the stable scene there is
// the control that the same prune still retires an earlier lifetime's marker.
import { expect, test } from 'bun:test';
import { join } from 'node:path';

type Facts = {
  stable: boolean;
  published: boolean;
  code: number;
  out: string;
  err: string;
  markerAExists: boolean;
  markerAPath: string;
  markerB: string;
  markerBExists: boolean;
  recordBUnchanged: boolean;
  staleMarker: string;
  staleExists: boolean;
  claimAfter: string | null;
  claimB: string;
};

const root = new URL('..', import.meta.url).pathname;

async function run(extra: readonly string[] = []): Promise<Facts> {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'c1-prune-race-independent-run.ts'), ...extra], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  return JSON.parse(out) as Facts;
}

test('a claim published mid-prune keeps its unread marker', async () => {
  const facts = await run();
  // The race happened and the launch's claim is the state's current one.
  expect(facts.published).toBe(true);
  expect(facts.claimAfter).toBe(facts.claimB);
  // Nothing is retired: the prune noticed that the claim it classified against was not the
  // state's claim any more, said so, and left every marker — B's current unread one included.
  expect(facts.code).toBe(1);
  expect(facts.out).toBe('');
  expect(facts.err).toBe(
    "team brief prune: the seat's current brief claim changed while the run read its markers, so nothing was retired; run it again\n",
  );
  expect(facts.markerBExists).toBe(true);
  expect(facts.markerAExists).toBe(true);
  expect(facts.recordBUnchanged).toBe(true);
});

test('a claim that vanished mid-prune retires nothing either', async () => {
  const facts = await run(['--vanish']);
  expect(facts.published).toBe(true);
  expect(facts.claimAfter).toBeNull();
  expect(facts.code).toBe(1);
  expect(facts.out).toBe('');
  expect(facts.err).toBe("team brief prune: the seat's current brief claim can't be read, so nothing was retired\n");
  expect(facts.markerAExists).toBe(true);
  expect(facts.staleExists).toBe(true);
});

test('the stable control: an earlier lifetime\'s marker is still retired, the current one kept', async () => {
  const facts = await run(['--stable']);
  expect(facts.err).toBe('');
  expect(facts.stable).toBe(true);
  expect(facts.published).toBe(false);
  expect(facts.code).toBe(0);
  // The current, unread marker stands; the earlier lifetime's marker is gone and the run says
  // why, naming that file.
  expect(facts.markerAExists).toBe(true);
  expect(facts.staleExists).toBe(false);
  expect(facts.out).toContain(facts.staleMarker);
  expect(facts.out).toContain("the seat's current claim names a newer delivery");
  expect(facts.claimAfter).toBe(facts.claimB);
});
