// The presence steps a chores child runs for one root: the history (activity) step, the per-seat
// reconcile and the publisher.
//
// The daemon keeps what must stay live in its own loop: the ingester's step, the runtime sources
// and their samples, the channel health answer, and the final re-check of every mirrored proof
// against a fresh reading and the current binding. The child runs only the durable work those
// steps do — applying the transition history, proving each staged identity reached the canonical
// projection and its applied fence, and copying applied transitions to the bus log — and sends
// back the proof rows with the notes a reader should see.
//
// A root whose token carries no state folder, or whose validated team file names no project,
// answers every reading with a miss instead of guessing a store. The work is built once per root
// and kept resident: the publisher's cursor and the activity step's own state must survive the
// passes, exactly as they do in the daemon today.
import { createPresenceActivity, type PresenceActivityResult } from '../presence/activity.ts';
import { createPresencePublisher, type PresencePublishResult } from '../presence/publish.ts';
import { reconcileSeatProof } from '../presence/reconcile.ts';
import type {
  ChoresChildConfig,
  ChoresChildRoute,
  ChoresPresenceProof,
  ChoresPresenceReading,
} from './protocol.ts';
import type { ChoresSlices } from './child.ts';

export type ChoresPresenceOutcome = {
  proofs: ChoresPresenceProof[];
  /** Plain lines the daemon's log should carry once, exactly as the inline steps reported them. */
  notes: string[];
};

export type ChoresPresencePass = {
  run(
    route: ChoresChildRoute,
    input: { at: Date; readings: ChoresPresenceReading[]; slices: ChoresSlices },
  ): Promise<ChoresPresenceOutcome>;
};

type RootWork = {
  stateDir: string;
  activity: (at: Date) => Promise<PresenceActivityResult>;
  publisher: (at: Date) => Promise<PresencePublishResult>;
};

/** One presence pass per root, with the same steps and order the daemon ran inline. */
export function createPresencePass(config: ChoresChildConfig): ChoresPresencePass {
  const work = new Map<string, RootWork>();

  const workFor = (route: ChoresChildRoute): RootWork | null => {
    const found = work.get(route.root);
    if (found !== undefined) return found;
    if (route.stateDir === undefined || route.stateDir === '') return null;
    const project = route.teamFile?.project;
    if (typeof project !== 'string' || project === '') return null;
    const built: RootWork = {
      stateDir: route.stateDir,
      activity: createPresenceActivity({ stateDir: route.stateDir, session: route.session }),
      publisher: createPresencePublisher({
        stateDir: route.stateDir,
        session: route.session,
        project,
        root: route.root,
        home: config.home,
      }),
    };
    work.set(route.root, built);
    return built;
  };

  const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  return {
    async run(route, input): Promise<ChoresPresenceOutcome> {
      const notes: string[] = [];
      const built = workFor(route);
      if (built === null) {
        return {
          proofs: input.readings.map((reading) => ({
            seat: reading.seat,
            miss: 'the chores child has no state folder for this root',
          })),
          notes: ['the presence pass has no state folder for this root'],
        };
      }
      const stateDir = built.stateDir;

      try {
        const applied = await built.activity(input.at);
        if (applied.failed !== null) notes.push(`the activity step failed: ${applied.failed}`);
        const bad = applied.seats.find((seat) => seat.bad !== null)?.bad;
        if (typeof bad === 'string') notes.push(bad);
      } catch (error) {
        notes.push(`the activity step failed: ${messageOf(error)}`);
      }
      // The pass runs under the child's slice budget like the fallback sweep: the steps are
      // separated by the child's own yield, and a stop ends the pass before the next step begins.
      // Presence work is a chore too; it must not hold the heartbeat past a slice boundary.
      if (input.slices.stopping()) {
        return { proofs: [], notes: [...notes, 'the presence pass stopped at a slice boundary'] };
      }
      await input.slices.yield();

      const proofs: ChoresPresenceProof[] = input.readings.map((reading) => {
        // A reading the daemon could not take is its own reason; the inline pass reported it
        // quietly, so no note is added for it here.
        if ('failed' in reading) return { seat: reading.seat, miss: reading.failed };
        const verdict = reconcileSeatProof({
          stateDir,
          session: route.session,
          seat: reading.seat,
          reading: reading.status,
          at: input.at,
        });
        if (verdict.ok) return { seat: reading.seat, id: verdict.proof.id, binding: verdict.proof.binding };
        // A reconciliation verdict is the one the inline pass logged once per route; the daemon
        // still owns that dedupe, so the note is a plain line and it decides.
        notes.push(`${reading.seat}: ${verdict.why}`);
        return { seat: reading.seat, miss: verdict.why };
      });

      if (input.slices.stopping()) {
        return { proofs, notes: [...notes, 'the presence pass stopped at a slice boundary before the publish step'] };
      }
      await input.slices.yield();
      try {
        const published = await built.publisher(input.at);
        if (published.failed !== null) notes.push(`the publish step failed: ${published.failed}`);
        const failed = published.seats.find((seat) => seat.failure !== null)
          ?? published.seats.find((seat) => seat.bad !== null);
        if (failed !== undefined) {
          notes.push(`the publish step failed: ${failed.failure ?? failed.bad ?? ''}`);
        }
      } catch (error) {
        notes.push(`the publish step failed: ${messageOf(error)}`);
      }

      return { proofs, notes };
    },
  };
}
