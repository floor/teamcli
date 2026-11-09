// Per-run in-memory memoisation for CLI runs.
//
// Each run enters a fresh memo scope on entry and discards it in `finally`, so nothing crosses a
// process or command boundary and key state stays in memory only for the duration of that run.

import type { Agent } from './registry/agents.ts';
import type { ProjectRecord } from './registry/projects.ts';
import type { TeamRecord } from './registry/teams.ts';
import type { KeyState } from './store/keys.ts';
import type { YamlValue } from './yaml.ts';

export type RunMemo = {
  agents: Map<string, Agent[]>;
  teamsStrict: Map<string, Record<string, TeamRecord>>;
  teamsTolerant: Map<string, Record<string, TeamRecord>>;
  projects: Map<string, Record<string, ProjectRecord>>;
  projectsRaw: Map<string, YamlValue | null>;
  /** The declared entity rules, keyed by home then entity name. A write under the home drops it. */
  entityRules: Map<string, Map<string, string[]>>;
  /** The declared project rules, keyed by home then project name. A write under the home drops it. */
  projectRules: Map<string, Map<string, string[]>>;
  messageKeys: Map<string, KeyState>;
  gitRoots: Map<string, string>;
};

let activeMemo: RunMemo | null = null;
let activeDepth = 0;

function createRunMemo(): RunMemo {
  return {
    agents: new Map(),
    teamsStrict: new Map(),
    teamsTolerant: new Map(),
    projects: new Map(),
    projectsRaw: new Map(),
    entityRules: new Map(),
    projectRules: new Map(),
    messageKeys: new Map(),
    gitRoots: new Map(),
  };
}

/** Enters a per-run memo scope. Nested calls share the outer run's scope until the outermost exits. */
export function enterRunMemo(): void {
  if (activeDepth === 0) {
    activeMemo = createRunMemo();
  }
  activeDepth += 1;
}

/** Leaves the current per-run memo scope, discarding all memoised state when the outermost run ends. */
export function leaveRunMemo(): void {
  if (activeDepth <= 0) return;
  activeDepth -= 1;
  if (activeDepth === 0) {
    activeMemo = null;
  }
}

/** Returns the active run's memo table, or null when called outside a memoised CLI run. */
export function currentRunMemo(): RunMemo | null {
  return activeMemo;
}

/** A copy of one rules map a caller can keep or mutate without reaching the memo's own lists:
 *  the entry cloned on the way in and again on the way out. */
export function cloneRulesMap(map: Map<string, string[]>): Map<string, string[]> {
  return new Map([...map].map(([name, rules]) => [name, [...rules]]));
}
