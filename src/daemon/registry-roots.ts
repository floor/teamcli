// Which checkouts the machine daemon hosts when its unit names none. The registry is the list:
// a team whose lifecycle is `running`, and no other. `team start` writes that record and then
// sends `root.added`; the heartbeat reads this same set, so a notice that never arrives still
// lands on the next beat. A defined, stopped or archived team is not hosted from here.

export type RegistryRoot = { root: string; source: 'registry' };

type RegistryTeam = { root: string; lifecycle: string };

/** Every checkout a running registry team names, once each, in path order. */
export function runningRegistryRoots(teams: Readonly<Record<string, RegistryTeam>>): RegistryRoot[] {
  const roots = new Set<string>();
  for (const team of Object.values(teams)) {
    if (team.lifecycle === 'running' && team.root !== '') roots.add(team.root);
  }
  return [...roots].sort().map((root) => ({ root, source: 'registry' as const }));
}

/**
 * The set a `root.added` notice asks the daemon to host. Null when the line is not that notice.
 * A checkout the registry does not mark `running` is left out: the notice does not host a team
 * the record does not, and the next heartbeat reads the record again.
 */
export function rootsFromAddedNotice(
  teams: Readonly<Record<string, RegistryTeam>>,
  notice: { op?: string; root?: string },
): RegistryRoot[] | null {
  if (notice.op !== 'root.added') return null;
  if (typeof notice.root !== 'string' || notice.root === '') return null;
  return runningRegistryRoots(teams);
}
