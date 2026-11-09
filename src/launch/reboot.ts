// A host restore can hand a seat back on a pane the record has never seen. The pane id is not
// the proof, and neither is the title: the running CLI and the conversation id are, read
// against the agent record. The same-pane reading stays in the placement module; this file
// only adds the new-id case and the two restores that follow it.
import { recordedCliAtPane } from '../placement/recorded-cli.ts';
import type { PaneProcesses } from '../herdr.ts';
import { reportedLiveAgent } from './agent.ts';
import { launchedIdentity, seatProcessVerdict, type LaunchedIdentity } from './identity.ts';
import { channelLaunchEnabled } from '../mcp/channel.ts';
import { profileFor } from '../profiles/index.ts';
import { isNotStartedScreen } from '../profiles/profile.ts';
import { readAgents } from '../registry/agents.ts';
import { readScreen } from '../watch/screen.ts';

/** The dialog Codex shows when a front end does not share the pinned feature set. The sentence
 *  alone is not the dialog: the profile's startup screen is, option rows included. A working
 *  pane that quotes the sentence is not it. A relaunch never answers it. */
export const FEATURE_DIALOG = 'background server has incompatible feature settings';

export function featureDialog(screen: string | null): boolean {
  if (screen === null || screen === '') return false;
  if (!isNotStartedScreen(profileFor('codex'), screen)) return false;
  return readScreen('codex', screen).kind !== 'working';
}

/** Whether the pane may be closed for that dialog. The screen is the dialog, the process in
 *  front is this seat's own CLI, the pane holds the recorded conversation, and the seat is
 *  not working. Any miss leaves the pane as it is. */
export function featureDialogClose(input: {
  screen: string | null;
  cli: string;
  launched: LaunchedIdentity | undefined;
  processes: PaneProcesses | null;
  foreground: readonly string[] | null;
  liveSession: string | undefined;
  recordedSession: string | undefined;
  status?: string | null;
}): boolean {
  if (!featureDialog(input.screen)) return false;
  if (input.status === 'working') return false;
  if (input.recordedSession === undefined || input.recordedSession === '') return false;
  if (input.liveSession !== input.recordedSession) return false;
  const names = profileFor(input.cli)?.processNames ?? [];
  const verdict = seatProcessVerdict(input.launched, input.processes);
  if (verdict !== 'same' && verdict !== 'replaced') return false;
  if (launchedIdentity(input.processes) === null) return false;
  return reportedLiveAgent(input.foreground, names);
}

/** A channel seat adopted in place, when the launch cannot bring the inbox back. The one
 *  step is named; nothing is typed into the pane. */
export function channelRestoreStep(launch: string | undefined): string | null {
  if (!channelLaunchEnabled(launch)) return null;
  return 'its channel did not reconnect; the one step is to open /mcp in its pane';
}

export type RestoredPane = { pane: string; workspace: string };

/**
 * The one pane whose id is not the recorded one, whose running CLI is the seat's, and whose
 * conversation id is the one on the agent record. A title is never read. A pane the placement
 * module already ties to a record is not a new id. Zero matches and two matches are no match.
 */
export function restoredPaneByConversation(input: {
  home: string;
  session: string;
  seat: string;
  cli: string;
  recordedPane: string;
  recordedSession: string;
  agents: readonly { pane: string; session?: string; workspace: string }[];
  foreground: (pane: string) => readonly string[] | null;
  processes: (pane: string) => PaneProcesses | null;
}): RestoredPane | null {
  let records: ReturnType<typeof readAgents>;
  try {
    records = readAgents(input.home);
  } catch {
    return null;
  }
  const mine = records.filter((agent) =>
    agent.lifecycle !== 'retired'
    && agent.reach.seat === input.seat
    && agent.reach.session === input.session
    && agent.reach.agent_session === input.recordedSession,
  );
  if (mine.length !== 1) return null;
  const record = mine[0]!;
  if (record.cli !== input.cli) return null;
  const names = profileFor(record.cli)?.processNames ?? [];
  if (names.length === 0) return null;
  const hits: RestoredPane[] = [];
  for (const agent of input.agents) {
    if (agent.pane === input.recordedPane) continue;
    if (!agent.workspace) continue;
    if (agent.session !== input.recordedSession) continue;
    const foreground = input.foreground(agent.pane);
    if (foreground === null || !reportedLiveAgent(foreground, names)) continue;
    const processes = input.processes(agent.pane);
    if (processes === null) continue;
    const placed = recordedCliAtPane({
      home: input.home,
      session: input.session,
      pane: agent.pane,
      agentSession: agent.session,
      processes,
      foreground,
    });
    if (placed.kind !== 'absent') continue;
    hits.push({ pane: agent.pane, workspace: agent.workspace });
  }
  if (hits.length !== 1) return null;
  return hits[0]!;
}
