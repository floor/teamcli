// An unnamed pane is still the seat whose record holds it, when the process in the pane is
// that seat's own CLI and its reported conversation is the one the record holds. The name is not the proof: the host drops it on a restore and during
// the window before it has named the pane. A bare shell, or a process that is another CLI,
// is not the seat. The same reading `team register` uses — a CLI pid in front of the shell,
// and a foreground argv0 the seat's profile names — decides it. TeamCLI then re-applies the
// host name, and the audit says so.
import { join } from 'node:path';
import { agentRename, type PaneProcesses } from '../herdr.ts';
import { launchedIdentity } from '../launch/identity.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/profile.ts';
import { readAgents } from '../registry/agents.ts';
import { readTeams } from '../registry/teams.ts';

export type RecordedCli =
  | { kind: 'seat'; name: string; root: string | null }
  | { kind: 'refused' }
  | { kind: 'absent' };

/** The one non-retired agent whose reach holds `pane` in `session`, when the pane's process
 *  is that seat's CLI. Absent when no record holds the pane, or the process cannot be read.
 *  Refused when a record holds it and the process is a bare shell or another CLI: the shell
 *  anchor must not place that pane either. Two records on one pane prove nothing. */
export function recordedCliAtPane(input: {
  home: string;
  session: string;
  pane: string;
  /** The conversation the terminal host reports on this pane, absent when unread. */
  agentSession: string | undefined;
  processes: PaneProcesses | null;
  foreground: readonly string[] | null;
}): RecordedCli {
  const holding = readAgents(input.home).filter((agent) =>
    agent.lifecycle !== 'retired'
    && agent.reach.session === input.session
    && agent.reach.pane === input.pane,
  );
  if (holding.length !== 1) return { kind: holding.length === 0 ? 'absent' : 'refused' };
  const agent = holding[0]!;
  // A reused pane id is not this seat's conversation. Refuse before the shell anchor can
  // place it or the caller can re-apply the old seat's name; an unread conversation is no match.
  if (input.agentSession === undefined || input.agentSession !== agent.reach.agent_session) return { kind: 'refused' };
  if (input.processes === null) return { kind: 'absent' };
  if (launchedIdentity(input.processes) === null) return { kind: 'refused' };
  if (input.foreground === null) return { kind: 'absent' };
  const names = profileFor(agent.cli)?.processNames ?? [];
  if (!reportedLiveAgent(input.foreground, names)) return { kind: 'refused' };
  let root: string | null = null;
  try {
    root = readTeams(input.home)[agent.reach.team]?.root ?? null;
  } catch {
    root = null;
  }
  return { kind: 'seat', name: agent.reach.seat, root };
}

/** Puts the seat's name back on the pane and records that the name was re-applied. A host
 *  that refuses the rename is recorded too; the placement already stands. No team root means
 *  there is nowhere to audit, and the rename is still asked. */
export function reapplyHerdrName(input: {
  session: string;
  pane: string;
  name: string;
  root: string | null;
}): void {
  const renamed = agentRename(input.pane, input.name, input.session);
  if (input.root === null) return;
  logLine(
    join(input.root, '.agents'),
    'placement',
    input.name,
    renamed
      ? `re-applied the herdr name on pane ${input.pane}`
      : `could not re-apply the herdr name on pane ${input.pane}`,
  );
}
