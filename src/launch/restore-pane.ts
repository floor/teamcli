import type { HerdrAgent, PaneProcesses } from '../herdr.ts';

export type RecordedPane = { pane?: string; workspace?: string };
export type RestorePaneRead = 'gone' | 'present' | 'unread';

/** Absence is a successful host inventory, never an omitted agent name or a null process read.
 * A contradictory positive reading always keeps the recorded pane. No store is consulted. */
export function recordedPaneRead(record: RecordedPane | undefined, reads: {
  workspaces(): readonly { id: string }[] | null;
  panes(workspace: string): readonly string[] | null;
  agents(): readonly Pick<HerdrAgent, 'pane'>[] | null;
  process(pane: string): PaneProcesses | null;
}): RestorePaneRead {
  if (!record?.pane || !record.workspace) return 'unread';
  try {
    const spaces = reads.workspaces();
    const panes = reads.panes(record.workspace);
    const agents = reads.agents();
    const process = reads.process(record.pane);
    const inPanes = panes?.includes(record.pane) === true;
    const live = agents?.some((agent) => agent.pane === record.pane) === true || process !== null;
    const spaceMissing = spaces !== null && !spaces.some((space) => space.id === record.workspace);
    const paneMissing = panes !== null && !inPanes;
    if ((spaceMissing && (inPanes || live)) || (paneMissing && live)) return 'unread';
    if (inPanes || live) return 'present';
    if (spaces === null || agents === null) return 'unread';
    if (!spaces.some((space) => space.id === record.workspace)) return 'gone';
    return panes === null ? 'unread' : 'gone';
  } catch {
    return 'unread';
  }
}
