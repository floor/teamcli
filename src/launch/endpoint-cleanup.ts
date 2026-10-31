import type { Host } from './execute.ts';

type CleanupHost = Omit<Host, 'drop'> & { drop(seat: string): boolean };

/** Keep a launch's endpoint identity until its owned server has been stopped. Wrapping the
 *  host also covers a dialog's drop outside the plan executor. Reused endpoints stay visible. */
export function endpointCleanupHost(source: Host, refused?: (seat: string, why: string) => void): CleanupHost {
  type StopInput = Parameters<NonNullable<Host['stopManagedCodexEndpoint']>>[0];
  const endpoints = new Map<string, StopInput & { started: boolean }>();
  const stop: NonNullable<Host['stopManagedCodexEndpoint']> = (input) => {
    const endpoint = endpoints.get(input.seat);
    const target = { ...input, expectedUrl: input.expectedUrl ?? endpoint?.expectedUrl };
    const answer = source.stopManagedCodexEndpoint?.(target)
      ?? { stopped: false, why: 'the launch has no endpoint stop operation' };
    if (answer.stopped) endpoints.delete(input.seat);
    return answer;
  };
  return {
    ...source,
    ...(source.managedCodexEndpoint === undefined ? {} : {
      managedCodexEndpoint: async (input) => {
        const answer = await source.managedCodexEndpoint!(input);
        if (answer.kind === 'up') endpoints.set(input.seat, {
          dir: input.dir, session: input.session, seat: input.seat,
          expectedUrl: answer.url, started: answer.started,
        });
        return answer;
      },
    }),
    stopManagedCodexEndpoint: stop,
    drop(seat) {
      const endpoint = endpoints.get(seat);
      if (endpoint !== undefined) {
        const answer = endpoint.started ? stop(endpoint)
          : { stopped: false, why: 'the endpoint was reused; this run does not own its stop' };
        if (!answer.stopped) {
          const why = `${answer.why ?? 'the endpoint stop could not be proven'}; its launch record was kept`;
          if (refused) refused(seat, why);
          else {
            source.say(`${seat}: ${why}\n`);
            source.log(seat, why);
          }
          return false;
        }
      }
      const dropped: unknown = source.drop(seat);
      return dropped !== false;
    },
  };
}
